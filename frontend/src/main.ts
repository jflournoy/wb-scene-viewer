import * as THREE from 'three';
import { initScene, resizeToContainer, applyViewPreset, yokeControls } from './scene';
import { createBrainMesh, updateVertexColors } from './brain-mesh';
import { loadManifest, loadSurface, loadOverlay, loadVolume, loadUnderlay, loadSceneSettings, loadCabnpBoundaries, loadCabnpFullBoundaries, loadCabnpParcels, loadCabnpSelected } from './data-loader';
import { mapScalarToRGBA, mapClusterToRGB, buildClusterLookup, buildClusterBoundaryMask, ROY_BIG_BL, PALETTES } from './colormap';
import { createSliceViewer } from './slice-viewer';
import { createGui } from './gui';
import type { GuiState, DataInfo } from './gui';
import type { PaletteControlPoint, PaletteMapping, OverlayData, VolumeData, SceneSettings, CabnpSelectedParcels } from './types';

const BASE_GRAY: [number, number, number] = [0.65, 0.65, 0.65];

// --- Three.js panes ---
const canvasLeft = document.getElementById('viewer-left') as HTMLCanvasElement;
const canvasRight = document.getElementById('viewer-right') as HTMLCanvasElement;
const canvasSubcort = document.getElementById('viewer-subcort') as HTMLCanvasElement;

const ctxLeft = initScene(canvasLeft);
const ctxRight = initScene(canvasRight);
const sliceViewer = createSliceViewer(canvasSubcort);

// --- State ---
let meshLeft: THREE.Mesh | null = null;
let meshRight: THREE.Mesh | null = null;
const overlayData: Record<string, OverlayData> = {};
const thresholdData: Record<string, OverlayData> = {};
let volumeData: VolumeData | null = null;
let volumeThreshData: VolumeData | null = null;
let guiState: GuiState;
let dataInfo: DataInfo = { dataMin: '--', dataMax: '--', posMinVal: '--', negMaxVal: '--', threshPosMin: '--', threshNegMax: '--' };
let guiRefresh: () => void = () => {};
let guiUpdateThresholdRange: (max: number) => void = () => {};
let guiUpdateHistograms: (
  l: OverlayData | undefined, r: OverlayData | undefined, s: VolumeData | null,
  lt: OverlayData | undefined, rt: OverlayData | undefined, st: VolumeData | null,
  ftMin: number, ftMax: number, isShowOutside: boolean,
) => void = () => {};
let guiUpdateNetworkLegend: (networkColors: Record<string, [number, number, number]> | null) => void = () => {};
let activePalette: PaletteControlPoint[] = ROY_BIG_BL;
let sceneConfig: SceneSettings = {};
let clustLookup: Map<number, number> = new Map();
let clustBoundary: Record<string, Uint8Array> = {};

// CAB-NP parcellation state
let cabnpBoundaries: Record<string, Uint8Array> = {};
let cabnpFullBoundaries: Record<string, Uint8Array> = {};
let cabnpParcelsData: Record<string, Int32Array> = {};
let cabnpSelected: CabnpSelectedParcels | null = null;
let cabnpAvailable = false;
let cabnpContrasts: string[] = [];

function buildPaletteMapping(state: GuiState): PaletteMapping {
  return {
    posMin: state.posMin,
    posMax: state.posMax,
    negMin: state.negMin,
    negMax: state.negMax,
    posThresh: state.posThresh,
    negThresh: state.negThresh,
    thresholdOn: state.thresholdOn,
    displayPositive: true,
    displayNegative: true,
    displayZero: false,
    interpolate: true,
  };
}

function isClustOverlay(): boolean {
  return guiState.overlay.endsWith('_clust');
}

function rerenderColorsForHemi(
  mesh: THREE.Mesh | null,
  overlay: OverlayData | undefined,
  threshData: OverlayData | undefined,
): void {
  if (!mesh || !overlay) return;

  const nV = overlay.data.length;
  const colors = new Float32Array(nV * 3);
  const useClustMap = isClustOverlay();
  const mapping = buildPaletteMapping(guiState);
  const useFileThresh = !useClustMap && sceneConfig.threshold?.type === 'THRESHOLD_TYPE_FILE' && threshData;
  const fileThreshMin = sceneConfig.threshold?.min ?? 0;
  const fileThreshMax = sceneConfig.threshold?.max ?? 0;
  const hemiKey = (mesh === meshLeft) ? 'left' : 'right';
  const boundaryMask = useClustMap ? clustBoundary[hemiKey] : undefined;

  for (let i = 0; i < nV; i++) {
    const val = overlay.data[i];
    if (isNaN(val)) {
      colors[i * 3] = BASE_GRAY[0];
      colors[i * 3 + 1] = BASE_GRAY[1];
      colors[i * 3 + 2] = BASE_GRAY[2];
      continue;
    }

    if (useClustMap) {
      const [r, g, b, a] = mapClusterToRGB(val, clustLookup);
      if (a === 0) {
        colors[i * 3] = BASE_GRAY[0];
        colors[i * 3 + 1] = BASE_GRAY[1];
        colors[i * 3 + 2] = BASE_GRAY[2];
      } else if (boundaryMask && boundaryMask[i] === 1) {
        // White outlines for cluster boundaries (distinct from dark CAB-NP parcel borders)
        colors[i * 3] = r * 0.25 + 0.75;
        colors[i * 3 + 1] = g * 0.25 + 0.75;
        colors[i * 3 + 2] = b * 0.25 + 0.75;
      } else {
        colors[i * 3] = r;
        colors[i * 3 + 1] = g;
        colors[i * 3 + 2] = b;
      }
      continue;
    }

    if (useFileThresh) {
      const threshVal = threshData.data[i];
      if (isNaN(threshVal)) {
        colors[i * 3] = BASE_GRAY[0];
        colors[i * 3 + 1] = BASE_GRAY[1];
        colors[i * 3 + 2] = BASE_GRAY[2];
        continue;
      }
      const outside = threshVal < fileThreshMin || threshVal > fileThreshMax;
      const isShowOutside = sceneConfig.threshold?.test === 'THRESHOLD_TEST_SHOW_OUTSIDE';
      const visible = isShowOutside ? outside : !outside;
      if (!visible) {
        colors[i * 3] = BASE_GRAY[0];
        colors[i * 3 + 1] = BASE_GRAY[1];
        colors[i * 3 + 2] = BASE_GRAY[2];
        continue;
      }
    }

    const [r, g, b, a] = mapScalarToRGBA(val, mapping, activePalette);
    if (a === 0) {
      colors[i * 3] = BASE_GRAY[0];
      colors[i * 3 + 1] = BASE_GRAY[1];
      colors[i * 3 + 2] = BASE_GRAY[2];
    } else {
      colors[i * 3] = r;
      colors[i * 3 + 1] = g;
      colors[i * 3 + 2] = b;
    }
  }

  // --- CAB-NP parcel overlay ---
  if (cabnpAvailable && (guiState.showParcelBoundaries || guiState.showSelectedParcels)) {
    const hemiKey = (mesh === meshLeft) ? 'left' : 'right';
    const thinBounds = cabnpBoundaries[hemiKey];
    const fullBounds = cabnpFullBoundaries[hemiKey];
    const parcIds = cabnpParcelsData[hemiKey];

    if (thinBounds && fullBounds && parcIds) {
      const selectedSet = new Set(cabnpSelected?.parcels ?? []);
      const strength = guiState.parcelOpacity;
      const useOutline = guiState.parcelBlend === 'outline';

      for (let i = 0; i < nV; i++) {
        const isSelected = guiState.showSelectedParcels && cabnpSelected && selectedSet.has(parcIds[i]);
        const isThinBoundary = thinBounds[i] === 1;
        const isFullBoundary = fullBounds[i] === 1;

        if (isSelected) {
          const network = cabnpSelected!.networks[String(parcIds[i])];
          const netColor = network ? cabnpSelected!.network_colors[network] : null;
          if (netColor) {
            if (useOutline) {
              // Outline mode: color boundary vertices of selected parcels
              // with the network color; leave interior untouched
              if (isFullBoundary) {
                colors[i * 3]     = colors[i * 3]     * (1 - strength) + netColor[0] * strength;
                colors[i * 3 + 1] = colors[i * 3 + 1] * (1 - strength) + netColor[1] * strength;
                colors[i * 3 + 2] = colors[i * 3 + 2] * (1 - strength) + netColor[2] * strength;
              }
            } else {
              // Fill mode: alpha blend entire parcel with network color
              colors[i * 3]     = colors[i * 3]     * (1 - strength) + netColor[0] * strength;
              colors[i * 3 + 1] = colors[i * 3 + 1] * (1 - strength) + netColor[1] * strength;
              colors[i * 3 + 2] = colors[i * 3 + 2] * (1 - strength) + netColor[2] * strength;
              // Dark outline on boundary vertices of filled parcels
              if (isFullBoundary) {
                colors[i * 3]     *= 0.15;
                colors[i * 3 + 1] *= 0.15;
                colors[i * 3 + 2] *= 0.15;
              }
            }
          }
        } else if (guiState.showParcelBoundaries && isThinBoundary) {
          // Darken non-selected parcel boundaries (thin, subtle)
          colors[i * 3]     *= 0.15;
          colors[i * 3 + 1] *= 0.15;
          colors[i * 3 + 2] *= 0.15;
        }
      }
    }
  }

  updateVertexColors(mesh, colors);
}

function rerenderColors(): void {
  rerenderColorsForHemi(meshLeft, overlayData['left'], thresholdData['left']);
  rerenderColorsForHemi(meshRight, overlayData['right'], thresholdData['right']);

  // Update slice viewer
  const mapping = buildPaletteMapping(guiState);
  sliceViewer.setColorMapping(
    mapping,
    activePalette,
    sceneConfig.threshold?.min ?? 0,
    sceneConfig.threshold?.max ?? 0,
    sceneConfig.threshold?.test ?? 'THRESHOLD_TEST_SHOW_OUTSIDE',
    isClustOverlay(),
    clustLookup,
  );
  sliceViewer.render();
}

async function loadAndShowSurface(
  hemi: string,
  sceneCtx: { scene: THREE.Scene },
): Promise<THREE.Mesh> {
  const surfData = await loadSurface(hemi);

  const defaultColors = new Float32Array(surfData.nV * 3);
  for (let i = 0; i < surfData.nV; i++) {
    defaultColors[i * 3] = BASE_GRAY[0];
    defaultColors[i * 3 + 1] = BASE_GRAY[1];
    defaultColors[i * 3 + 2] = BASE_GRAY[2];
  }

  const mesh = createBrainMesh(surfData.vertices, surfData.faces, defaultColors);
  sceneCtx.scene.add(mesh);
  return mesh;
}

async function loadThresholdForOverlay(overlayName: string): Promise<void> {
  if (sceneConfig.threshold?.type !== 'THRESHOLD_TYPE_FILE') return;

  const clustName = `${overlayName}_clust`;

  const loadHemi = async (hemi: string): Promise<void> => {
    const name = `${clustName}_${hemi}`;
    try {
      thresholdData[hemi] = await loadOverlay(name);
    } catch {
      delete thresholdData[hemi];
    }
  };

  await Promise.all([loadHemi('left'), loadHemi('right')]);
}

async function loadAndShowOverlay(): Promise<void> {
  const loadHemi = async (hemi: string): Promise<void> => {
    const overlayName = `${guiState.overlay}_${hemi}`;
    overlayData[hemi] = await loadOverlay(overlayName);
  };

  const volName = `${guiState.overlay}_subcortical`;
  const volClustName = `${guiState.overlay}_clust_subcortical`;

  const loadVol = async (): Promise<void> => {
    try {
      volumeData = await loadVolume(volName);
    } catch {
      volumeData = null;
    }
  };

  const loadVolThresh = async (): Promise<void> => {
    if (sceneConfig.threshold?.type !== 'THRESHOLD_TYPE_FILE') {
      volumeThreshData = null;
      return;
    }
    try {
      volumeThreshData = await loadVolume(volClustName);
    } catch {
      volumeThreshData = null;
    }
  };

  await Promise.all([
    loadHemi('left'),
    loadHemi('right'),
    loadThresholdForOverlay(guiState.overlay),
    loadVol(),
    loadVolThresh(),
  ]);

  // Compute and display data range, filtered by file-based threshold
  const lOv = overlayData['left'];
  const rOv = overlayData['right'];
  const lThresh = thresholdData['left'];
  const rThresh = thresholdData['right'];
  const hasFileThresh = sceneConfig.threshold?.type === 'THRESHOLD_TYPE_FILE';
  const fileThreshMin = sceneConfig.threshold?.min ?? 0;
  const fileThreshMax = sceneConfig.threshold?.max ?? 0;
  const isShowOutside = sceneConfig.threshold?.test === 'THRESHOLD_TEST_SHOW_OUTSIDE';

  function isFileThreshVisible(threshVal: number): boolean {
    if (isNaN(threshVal)) return false;
    const outside = threshVal < fileThreshMin || threshVal > fileThreshMax;
    return isShowOutside ? outside : !outside;
  }

  let dataMin = Infinity;
  let dataMax = -Infinity;
  let posMinVal = Infinity;
  let negMaxVal = -Infinity;
  for (const [ov, th] of [[lOv, lThresh], [rOv, rThresh]] as const) {
    if (!ov) continue;
    for (let i = 0; i < ov.data.length; i++) {
      const v = ov.data[i];
      if (isNaN(v)) continue;
      if (hasFileThresh && th) {
        if (!isFileThreshVisible(th.data[i])) continue;
      }
      if (v < dataMin) dataMin = v;
      if (v > dataMax) dataMax = v;
      if (v > 0 && v < posMinVal) posMinVal = v;
      if (v < 0 && v > negMaxVal) negMaxVal = v;
    }
  }
  if (dataMin === Infinity) dataMin = 0;
  if (dataMax === -Infinity) dataMax = 0;

  dataInfo.dataMin = dataMin.toFixed(3);
  dataInfo.dataMax = dataMax.toFixed(3);
  dataInfo.posMinVal = posMinVal === Infinity ? 'N/A' : posMinVal.toFixed(3);
  dataInfo.negMaxVal = negMaxVal === -Infinity ? 'N/A' : negMaxVal.toFixed(3);
  dataInfo.threshPosMin = dataInfo.posMinVal;
  dataInfo.threshNegMax = dataInfo.negMaxVal;

  // Update threshold slider range
  const maxAbs = Math.max(Math.abs(dataMin), Math.abs(dataMax));
  guiUpdateThresholdRange(maxAbs > 0 ? maxAbs : 30);

  // Build cluster lookup and boundary masks if this is a _clust overlay
  if (isClustOverlay()) {
    const surfLen = (lOv?.data.length ?? 0) + (rOv?.data.length ?? 0);
    const volLen = volumeData?.volume.length ?? 0;
    const combined = new Float32Array(surfLen + volLen);
    if (lOv) combined.set(lOv.data, 0);
    if (rOv) combined.set(rOv.data, lOv?.data.length ?? 0);
    if (volumeData) combined.set(volumeData.volume, surfLen);
    clustLookup = buildClusterLookup(combined);

    // Build boundary masks from mesh face topology
    clustBoundary = {};
    if (meshLeft && lOv) {
      const idx = meshLeft.geometry.getIndex();
      if (idx) clustBoundary['left'] = buildClusterBoundaryMask(lOv.data, idx.array as Uint32Array);
    }
    if (meshRight && rOv) {
      const idx = meshRight.geometry.getIndex();
      if (idx) clustBoundary['right'] = buildClusterBoundaryMask(rOv.data, idx.array as Uint32Array);
    }
  } else {
    clustBoundary = {};
  }

  // Apply scale settings (skip for _clust overlays which use discrete coloring)
  if (!isClustOverlay()) {
    if (sceneConfig.palette?.scaleMode === 'MODE_USER_SCALE') {
      guiState.posMax = sceneConfig.palette.posMax;
      guiState.posMin = sceneConfig.palette.posMin;
      guiState.negMax = sceneConfig.palette.negMax;
      guiState.negMin = sceneConfig.palette.negMin;
    } else {
      guiState.posMax = dataMax;
      guiState.posMin = dataMin > 0 ? dataMin : 0;
      // Workbench convention: negMin = most negative, negMax = closest to zero
      guiState.negMin = dataMin < 0 ? dataMin : 0;
      guiState.negMax = dataMax < 0 ? dataMax : 0;
    }
  }

  // Update slice viewer volume
  if (volumeData) {
    sliceViewer.setVolume(volumeData, volumeThreshData);
  }

  // Load CAB-NP selected parcels for this contrast
  if (cabnpAvailable) {
    const overlayName = guiState.overlay;
    const matchedContrast = cabnpContrasts.find(c => overlayName.startsWith(c + '/') || overlayName === c);
    if (matchedContrast) {
      cabnpSelected = await loadCabnpSelected(matchedContrast);
    } else {
      cabnpSelected = null;
    }
    guiUpdateNetworkLegend(cabnpSelected?.network_colors ?? null);
  }

  guiUpdateHistograms(
    lOv, rOv, volumeData,
    hasFileThresh ? lThresh : undefined,
    hasFileThresh ? rThresh : undefined,
    hasFileThresh ? volumeThreshData : null,
    fileThreshMin, fileThreshMax, isShowOutside,
  );
  guiRefresh();
  rerenderColors();
}

function handleResize(): void {
  const paneLeft = document.getElementById('pane-left')!;
  const paneRight = document.getElementById('pane-right')!;
  const paneSubcort = document.getElementById('pane-subcort')!;

  resizeToContainer(ctxLeft, paneLeft);
  resizeToContainer(ctxRight, paneRight);

  canvasSubcort.width = paneSubcort.clientWidth;
  canvasSubcort.height = paneSubcort.clientHeight;
  sliceViewer.render();
}

async function init(): Promise<void> {
  const [manifest, settings] = await Promise.all([loadManifest(), loadSceneSettings()]);
  sceneConfig = settings;

  if (sceneConfig.palette?.name && PALETTES[sceneConfig.palette.name]) {
    activePalette = PALETTES[sceneConfig.palette.name];
  }

  const overlayNames = [...new Set(manifest.overlays.map(o => o.name))];
  if (overlayNames.length === 0) {
    overlayNames.push('(none)');
  }

  const guiResult = createGui(overlayNames, {
    onOverlayChange: () => { void loadAndShowOverlay(); },
    onColorsChange: rerenderColors,
  }, sceneConfig);
  guiState = guiResult.state;
  dataInfo = guiResult.dataInfo;
  guiRefresh = guiResult.refresh;
  guiUpdateThresholdRange = guiResult.updateThresholdRange;
  guiUpdateHistograms = guiResult.updateHistograms;
  guiUpdateNetworkLegend = guiResult.updateNetworkLegend;

  // Initial sizing
  handleResize();

  // Load underlay + surfaces in parallel
  const loadUnderlayVol = async (): Promise<void> => {
    try {
      const ul = await loadUnderlay();
      sliceViewer.setUnderlay(ul);
    } catch {
      // No underlay available
    }
  };

  const [left, right] = await Promise.all([
    loadAndShowSurface('left', ctxLeft),
    loadAndShowSurface('right', ctxRight),
    loadUnderlayVol(),
  ]) as [THREE.Mesh, THREE.Mesh, void];
  meshLeft = left;
  meshRight = right;

  // Load CAB-NP parcellation data if available
  if (manifest.cabnp?.available) {
    const [boundL, boundR, fullL, fullR, parcL, parcR] = await Promise.all([
      loadCabnpBoundaries('left'),
      loadCabnpBoundaries('right'),
      loadCabnpFullBoundaries('left'),
      loadCabnpFullBoundaries('right'),
      loadCabnpParcels('left'),
      loadCabnpParcels('right'),
    ]);
    cabnpBoundaries = { left: boundL, right: boundR };
    cabnpFullBoundaries = { left: fullL, right: fullR };
    cabnpParcelsData = { left: parcL, right: parcR };
    cabnpContrasts = manifest.cabnp.contrasts;
    cabnpAvailable = true;
  }

  // Set initial views
  applyViewPreset(ctxLeft, 'lateral_left');
  applyViewPreset(ctxRight, 'lateral_right');

  // Yoke hemisphere controls (mirrored rotation/zoom/pan)
  const yoke = yokeControls(ctxLeft, ctxRight);
  guiResult.gui.add(yoke, 'enabled').name('Yoke Hemispheres');

  // Load first overlay
  if (manifest.overlays.length > 0) {
    await loadAndShowOverlay();
  }

  // Resize handler
  window.addEventListener('resize', handleResize);

  // Render loop
  function animate(): void {
    requestAnimationFrame(animate);
    ctxLeft.controls.update();
    ctxRight.controls.update();
    ctxLeft.renderer.render(ctxLeft.scene, ctxLeft.camera);
    ctxRight.renderer.render(ctxRight.scene, ctxRight.camera);
  }
  animate();
}

void init();
