import * as THREE from 'three';
import { initScene, resizeToContainer, applyViewPreset, yokeControls } from './scene';
import { createBrainMesh, updateVertexColors } from './brain-mesh';
import { loadManifest, loadSurface, loadOverlay, loadVolume, loadUnderlay, loadSceneSettings, loadCabnpBoundaries, loadCabnpFullBoundaries, loadCabnpParcels, loadCabnpSelected } from './data-loader';
import { mapScalarWithLUT, mapClusterToRGB, buildClusterLookup, buildClusterBoundaryMask, buildPaletteLUT, ROY_BIG_BL, PALETTES } from './colormap';
import type { PaletteLUT } from './colormap';
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

// --- Overlay cache ---
interface CachedOverlay {
  overlayData: Record<string, OverlayData>;
  thresholdData: Record<string, OverlayData>;
  volumeData: VolumeData | null;
  volumeThreshData: VolumeData | null;
  cabnpSelected: CabnpSelectedParcels | null;
  stats: { dataMin: number; dataMax: number; posMinVal: number; negMaxVal: number };
  clustLookup: Map<number, number>;
  clustBoundary: Record<string, Uint8Array>;
}

const overlayCache = new Map<string, CachedOverlay>();
const overlayFetchInFlight = new Map<string, Promise<CachedOverlay>>();

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
let allOverlayNames: string[] = [];

// CAB-NP parcellation state
let cabnpBoundaries: Record<string, Uint8Array> = {};
let cabnpFullBoundaries: Record<string, Uint8Array> = {};
let cabnpParcelsData: Record<string, Int32Array> = {};
let cabnpSelected: CabnpSelectedParcels | null = null;
let cabnpAvailable = false;
let cabnpContrasts: string[] = [];
let cabnpSelectedSet: Set<number> = new Set();

// Reusable base gray buffer (allocated once per hemisphere size)
let baseGrayBuf: Float32Array | null = null;
function getBaseGray(nV: number): Float32Array {
  const needed = nV * 3;
  if (!baseGrayBuf || baseGrayBuf.length !== needed) {
    baseGrayBuf = new Float32Array(needed);
    for (let i = 0; i < nV; i++) {
      baseGrayBuf[i * 3] = BASE_GRAY[0];
      baseGrayBuf[i * 3 + 1] = BASE_GRAY[1];
      baseGrayBuf[i * 3 + 2] = BASE_GRAY[2];
    }
  }
  return baseGrayBuf;
}

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
  lut: PaletteLUT,
  mapping: PaletteMapping,
): void {
  if (!mesh || !overlay) return;

  const nV = overlay.data.length;
  const colors = new Float32Array(nV * 3);
  const hemiKey = (mesh === meshLeft) ? 'left' : 'right';
  const gray = getBaseGray(nV);

  if (guiState.hideOverlay) {
    colors.set(gray);
  } else {
    const useClustMap = isClustOverlay();
    const useFileThresh = !useClustMap && sceneConfig.threshold?.type === 'THRESHOLD_TYPE_FILE' && threshData;
    const fileThreshMin = sceneConfig.threshold?.min ?? 0;
    const fileThreshMax = sceneConfig.threshold?.max ?? 0;
    const isShowOutside = sceneConfig.threshold?.test === 'THRESHOLD_TEST_SHOW_OUTSIDE';
    const boundaryMask = useClustMap ? clustBoundary[hemiKey] : undefined;
    const ovArr = overlay.data;
    const thArr = useFileThresh ? threshData.data : null;
    const gr0 = BASE_GRAY[0];
    const gr1 = BASE_GRAY[1];
    const gr2 = BASE_GRAY[2];

    for (let i = 0; i < nV; i++) {
      const val = ovArr[i];
      const ci = i * 3;
      if (val !== val) { // fast NaN check
        colors[ci] = gr0;
        colors[ci + 1] = gr1;
        colors[ci + 2] = gr2;
        continue;
      }

      if (useClustMap) {
        const [r, g, b, a] = mapClusterToRGB(val, clustLookup);
        if (a === 0) {
          colors[ci] = gr0;
          colors[ci + 1] = gr1;
          colors[ci + 2] = gr2;
        } else if (boundaryMask && boundaryMask[i] === 1) {
          colors[ci] = r * 0.25 + 0.75;
          colors[ci + 1] = g * 0.25 + 0.75;
          colors[ci + 2] = b * 0.25 + 0.75;
        } else {
          colors[ci] = r;
          colors[ci + 1] = g;
          colors[ci + 2] = b;
        }
        continue;
      }

      if (thArr) {
        const threshVal = thArr[i];
        if (threshVal !== threshVal) { // fast NaN
          colors[ci] = gr0;
          colors[ci + 1] = gr1;
          colors[ci + 2] = gr2;
          continue;
        }
        const outside = threshVal < fileThreshMin || threshVal > fileThreshMax;
        const visible = isShowOutside ? outside : !outside;
        if (!visible) {
          colors[ci] = gr0;
          colors[ci + 1] = gr1;
          colors[ci + 2] = gr2;
          continue;
        }
      }

      const [r, g, b, a] = mapScalarWithLUT(val, mapping, lut);
      if (a === 0) {
        colors[ci] = gr0;
        colors[ci + 1] = gr1;
        colors[ci + 2] = gr2;
      } else {
        colors[ci] = r;
        colors[ci + 1] = g;
        colors[ci + 2] = b;
      }
    }
  }

  // --- CAB-NP parcel overlay ---
  if (cabnpAvailable && (guiState.showParcelBoundaries || guiState.showSelectedParcels)) {
    const thinBounds = cabnpBoundaries[hemiKey];
    const fullBounds = cabnpFullBoundaries[hemiKey];
    const parcIds = cabnpParcelsData[hemiKey];

    if (thinBounds && fullBounds && parcIds) {
      const strength = guiState.parcelOpacity;
      const invStrength = 1 - strength;
      const useOutline = guiState.parcelBlend === 'outline';
      const doSelected = guiState.showSelectedParcels && cabnpSelected != null;
      const doBoundaries = guiState.showParcelBoundaries;
      const networks = cabnpSelected?.networks;
      const networkColors = cabnpSelected?.network_colors;

      for (let i = 0; i < nV; i++) {
        const ci = i * 3;
        const parcId = parcIds[i];

        if (doSelected && cabnpSelectedSet.has(parcId)) {
          const network = networks![String(parcId)];
          const netColor = network ? networkColors![network] : null;
          if (netColor) {
            const isFullBoundary = fullBounds[i] === 1;
            if (useOutline) {
              if (isFullBoundary) {
                colors[ci]     = colors[ci]     * invStrength + netColor[0] * strength;
                colors[ci + 1] = colors[ci + 1] * invStrength + netColor[1] * strength;
                colors[ci + 2] = colors[ci + 2] * invStrength + netColor[2] * strength;
              }
            } else {
              colors[ci]     = colors[ci]     * invStrength + netColor[0] * strength;
              colors[ci + 1] = colors[ci + 1] * invStrength + netColor[1] * strength;
              colors[ci + 2] = colors[ci + 2] * invStrength + netColor[2] * strength;
              if (isFullBoundary) {
                colors[ci]     *= 0.15;
                colors[ci + 1] *= 0.15;
                colors[ci + 2] *= 0.15;
              }
            }
          }
        } else if (doBoundaries && thinBounds[i] === 1) {
          colors[ci]     *= 0.15;
          colors[ci + 1] *= 0.15;
          colors[ci + 2] *= 0.15;
        }
      }
    }
  }

  updateVertexColors(mesh, colors);
}

function rerenderColors(): void {
  const mapping = buildPaletteMapping(guiState);
  const lut = buildPaletteLUT(mapping, activePalette);
  rerenderColorsForHemi(meshLeft, overlayData['left'], thresholdData['left'], lut, mapping);
  rerenderColorsForHemi(meshRight, overlayData['right'], thresholdData['right'], lut, mapping);

  // Update slice viewer
  sliceViewer.setShowOverlay(!guiState.hideOverlay);
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

async function fetchOverlayData(overlayName: string): Promise<CachedOverlay> {
  const cached = overlayCache.get(overlayName);
  if (cached) return cached;

  const inFlight = overlayFetchInFlight.get(overlayName);
  if (inFlight) return inFlight;

  const promise = _doFetchOverlayData(overlayName);
  overlayFetchInFlight.set(overlayName, promise);
  try {
    const result = await promise;
    overlayCache.set(overlayName, result);
    return result;
  } finally {
    overlayFetchInFlight.delete(overlayName);
  }
}

async function _doFetchOverlayData(overlayName: string): Promise<CachedOverlay> {
  const isClust = overlayName.endsWith('_clust');
  const volName = `${overlayName}_subcortical`;
  const volClustName = `${overlayName}_clust_subcortical`;
  const hasFileThresh = sceneConfig.threshold?.type === 'THRESHOLD_TYPE_FILE';
  const fileThreshMin = sceneConfig.threshold?.min ?? 0;
  const fileThreshMax = sceneConfig.threshold?.max ?? 0;
  const isShowOutside = sceneConfig.threshold?.test === 'THRESHOLD_TEST_SHOW_OUTSIDE';

  const ovData: Record<string, OverlayData> = {};
  const thData: Record<string, OverlayData> = {};

  const loadHemi = async (hemi: string): Promise<void> => {
    ovData[hemi] = await loadOverlay(`${overlayName}_${hemi}`);
  };

  const loadThreshHemi = async (hemi: string): Promise<void> => {
    if (!hasFileThresh) return;
    try {
      thData[hemi] = await loadOverlay(`${overlayName}_clust_${hemi}`);
    } catch {
      // no threshold data for this hemi
    }
  };

  const loadVol = async (): Promise<VolumeData | null> => {
    try { return await loadVolume(volName); } catch { return null; }
  };

  const loadVolThresh = async (): Promise<VolumeData | null> => {
    if (!hasFileThresh) return null;
    try { return await loadVolume(volClustName); } catch { return null; }
  };

  const loadCabnp = async (): Promise<CabnpSelectedParcels | null> => {
    if (!cabnpAvailable) return null;
    const matched = cabnpContrasts.find(c => overlayName.startsWith(c + '/') || overlayName === c);
    if (matched) return loadCabnpSelected(matched);
    return null;
  };

  const [,,,, volData, volThData, cabSelected] = await Promise.all([
    loadHemi('left'),
    loadHemi('right'),
    loadThreshHemi('left'),
    loadThreshHemi('right'),
    loadVol(),
    loadVolThresh(),
    loadCabnp(),
  ]);

  // Compute data stats
  const lOv = ovData['left'];
  const rOv = ovData['right'];
  const lTh = thData['left'];
  const rTh = thData['right'];

  function isFileThreshVisible(threshVal: number): boolean {
    if (isNaN(threshVal)) return false;
    const outside = threshVal < fileThreshMin || threshVal > fileThreshMax;
    return isShowOutside ? outside : !outside;
  }

  let dataMin = Infinity;
  let dataMax = -Infinity;
  let posMinVal = Infinity;
  let negMaxVal = -Infinity;
  for (const [ov, th] of [[lOv, lTh], [rOv, rTh]] as const) {
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

  // Build cluster lookup + boundary masks
  let cLookup = new Map<number, number>();
  const cBoundary: Record<string, Uint8Array> = {};
  if (isClust) {
    const surfLen = (lOv?.data.length ?? 0) + (rOv?.data.length ?? 0);
    const volLen = volData?.volume.length ?? 0;
    const combined = new Float32Array(surfLen + volLen);
    if (lOv) combined.set(lOv.data, 0);
    if (rOv) combined.set(rOv.data, lOv?.data.length ?? 0);
    if (volData) combined.set(volData.volume, surfLen);
    cLookup = buildClusterLookup(combined);

    if (meshLeft && lOv) {
      const idx = meshLeft.geometry.getIndex();
      if (idx) cBoundary['left'] = buildClusterBoundaryMask(lOv.data, idx.array as Uint32Array);
    }
    if (meshRight && rOv) {
      const idx = meshRight.geometry.getIndex();
      if (idx) cBoundary['right'] = buildClusterBoundaryMask(rOv.data, idx.array as Uint32Array);
    }
  }

  return {
    overlayData: ovData,
    thresholdData: thData,
    volumeData: volData,
    volumeThreshData: volThData,
    cabnpSelected: cabSelected,
    stats: { dataMin, dataMax, posMinVal, negMaxVal },
    clustLookup: cLookup,
    clustBoundary: cBoundary,
  };
}

function prefetchAllOverlays(): void {
  for (const name of allOverlayNames) {
    if (!overlayCache.has(name) && !overlayFetchInFlight.has(name)) {
      void fetchOverlayData(name);
    }
  }
}

async function loadAndShowOverlay(): Promise<void> {
  const entry = await fetchOverlayData(guiState.overlay);

  // Apply cached data to active state
  overlayData['left'] = entry.overlayData['left'];
  overlayData['right'] = entry.overlayData['right'];
  thresholdData['left'] = entry.thresholdData['left'];
  thresholdData['right'] = entry.thresholdData['right'];
  volumeData = entry.volumeData;
  volumeThreshData = entry.volumeThreshData;
  cabnpSelected = entry.cabnpSelected;
  clustLookup = entry.clustLookup;
  clustBoundary = entry.clustBoundary;

  const { dataMin, dataMax, posMinVal, negMaxVal } = entry.stats;
  const hasFileThresh = sceneConfig.threshold?.type === 'THRESHOLD_TYPE_FILE';
  const fileThreshMin = sceneConfig.threshold?.min ?? 0;
  const fileThreshMax = sceneConfig.threshold?.max ?? 0;
  const isShowOutside = sceneConfig.threshold?.test === 'THRESHOLD_TEST_SHOW_OUTSIDE';

  dataInfo.dataMin = dataMin.toFixed(3);
  dataInfo.dataMax = dataMax.toFixed(3);
  dataInfo.posMinVal = posMinVal === Infinity ? 'N/A' : posMinVal.toFixed(3);
  dataInfo.negMaxVal = negMaxVal === -Infinity ? 'N/A' : negMaxVal.toFixed(3);
  dataInfo.threshPosMin = dataInfo.posMinVal;
  dataInfo.threshNegMax = dataInfo.negMaxVal;

  const maxAbs = Math.max(Math.abs(dataMin), Math.abs(dataMax));
  guiUpdateThresholdRange(maxAbs > 0 ? maxAbs : 30);

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
      guiState.negMin = dataMin < 0 ? dataMin : 0;
      guiState.negMax = dataMax < 0 ? dataMax : 0;
    }
  }

  if (volumeData) {
    sliceViewer.setVolume(volumeData, volumeThreshData);
  }

  if (cabnpAvailable) {
    cabnpSelectedSet = new Set(cabnpSelected?.parcels ?? []);
    guiUpdateNetworkLegend(cabnpSelected?.network_colors ?? null);
  }

  const lOv = overlayData['left'];
  const rOv = overlayData['right'];
  const lThresh = thresholdData['left'];
  const rThresh = thresholdData['right'];

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
  allOverlayNames = overlayNames;

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

  // Load first overlay, then prefetch all others in background
  if (manifest.overlays.length > 0) {
    await loadAndShowOverlay();
    prefetchAllOverlays();
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
