import GUI from 'lil-gui';
import type { SceneSettings, OverlayData, VolumeData } from './types';

export interface GuiState {
  overlay: string;
  overlayType: 'statistic' | 'cluster';
  posThresh: number;
  negThresh: number;
  thresholdOn: boolean;
  posMin: number;
  posMax: number;
  negMin: number;
  negMax: number;
  showParcelBoundaries: boolean;
  showSelectedParcels: boolean;
  parcelOpacity: number;
  parcelBlend: 'outline' | 'fill';
}

export interface GuiCallbacks {
  onOverlayChange: () => void;
  onColorsChange: () => void;
}

export interface DataInfo {
  dataMin: string;
  dataMax: string;
  posMinVal: string;
  negMaxVal: string;
  threshPosMin: string;
  threshNegMax: string;
}

interface HistogramData {
  bins: number[];
  edges: number[];
  label: string;
}

const HIST_WIDTH = 220;
const HIST_HEIGHT = 60;
const HIST_BINS = 80;

/**
 * Compute histogram, optionally filtering by a visibility mask.
 * When mask is provided, only include data[i] where mask[i] indicates
 * the vertex passes the file-based threshold.
 */
function computeHistogram(
  data: Float32Array,
  nBins: number,
  mask: Float32Array | null,
  fileThreshMin: number,
  fileThreshMax: number,
  isShowOutside: boolean,
): HistogramData & { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  let count = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (isNaN(v) || v === 0) continue;
    if (mask) {
      const tv = mask[i];
      if (isNaN(tv)) continue;
      const outside = tv < fileThreshMin || tv > fileThreshMax;
      const visible = isShowOutside ? outside : !outside;
      if (!visible) continue;
    }
    if (v < min) min = v;
    if (v > max) max = v;
    count++;
  }
  if (count === 0) {
    return { bins: new Array(nBins).fill(0), edges: [], label: '', min: 0, max: 0 };
  }

  const range = max - min;
  const binWidth = range / nBins;
  const bins = new Array(nBins).fill(0);
  const edges: number[] = [];
  for (let i = 0; i <= nBins; i++) {
    edges.push(min + i * binWidth);
  }

  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (isNaN(v) || v === 0) continue;
    if (mask) {
      const tv = mask[i];
      if (isNaN(tv)) continue;
      const outside = tv < fileThreshMin || tv > fileThreshMax;
      const visible = isShowOutside ? outside : !outside;
      if (!visible) continue;
    }
    let idx = Math.floor((v - min) / binWidth);
    if (idx >= nBins) idx = nBins - 1;
    if (idx < 0) idx = 0;
    bins[idx]++;
  }

  return { bins, edges, label: '', min, max };
}

function drawHistogram(
  canvas: HTMLCanvasElement,
  hist: HistogramData & { min: number; max: number },
  posThresh: number,
  negThresh: number,
  thresholdOn: boolean,
): void {
  const ctx = canvas.getContext('2d')!;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const { bins, min, max } = hist;
  if (bins.length === 0) return;

  const maxCount = Math.max(...bins);
  if (maxCount === 0) return;

  const barW = w / bins.length;
  const range = max - min;

  for (let i = 0; i < bins.length; i++) {
    const binCenter = min + (i + 0.5) * (range / bins.length);
    const barH = (bins[i] / maxCount) * (h - 2);

    // Color: blue for negative, red for positive, dim if thresholded out
    let threshedOut = false;
    if (thresholdOn) {
      if (binCenter > 0 && binCenter < posThresh) threshedOut = true;
      if (binCenter < 0 && binCenter > -negThresh) threshedOut = true;
    }

    if (threshedOut) {
      ctx.fillStyle = '#333';
    } else if (binCenter > 0) {
      ctx.fillStyle = '#d44';
    } else {
      ctx.fillStyle = '#48f';
    }

    ctx.fillRect(
      Math.floor(i * barW),
      h - barH,
      Math.max(1, Math.ceil(barW) - 1),
      barH,
    );
  }

  // Draw threshold lines
  if (thresholdOn && range > 0) {
    ctx.strokeStyle = '#ff0';
    ctx.lineWidth = 1;

    if (posThresh > 0) {
      const posX = ((posThresh - min) / range) * w;
      if (posX >= 0 && posX <= w) {
        ctx.beginPath();
        ctx.moveTo(posX, 0);
        ctx.lineTo(posX, h);
        ctx.stroke();
      }
    }
    if (negThresh > 0) {
      const negX = ((-negThresh - min) / range) * w;
      if (negX >= 0 && negX <= w) {
        ctx.beginPath();
        ctx.moveTo(negX, 0);
        ctx.lineTo(negX, h);
        ctx.stroke();
      }
    }
  }

  // Zero line
  if (min < 0 && max > 0) {
    const zeroX = (-min / range) * w;
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(zeroX, 0);
    ctx.lineTo(zeroX, h);
    ctx.stroke();
  }

  // Labels
  ctx.fillStyle = '#888';
  ctx.font = '9px monospace';
  ctx.fillText(min.toFixed(1), 2, 10);
  ctx.textAlign = 'right';
  ctx.fillText(max.toFixed(1), w - 2, 10);
  ctx.textAlign = 'left';
}

function createHistogramCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = HIST_WIDTH;
  canvas.height = HIST_HEIGHT;
  canvas.style.width = '100%';
  canvas.style.height = `${HIST_HEIGHT}px`;
  canvas.style.display = 'block';
  canvas.style.background = '#1a1a1a';
  canvas.style.borderRadius = '3px';
  return canvas;
}

export function createGui(
  overlayNames: string[],
  callbacks: GuiCallbacks,
  sceneConfig: SceneSettings,
): {
  gui: GUI;
  state: GuiState;
  dataInfo: DataInfo;
  refresh: () => void;
  updateThresholdRange: (maxAbsValue: number) => void;
  updateNetworkLegend: (networkColors: Record<string, [number, number, number]> | null) => void;
  updateHistograms: (
    left: OverlayData | undefined,
    right: OverlayData | undefined,
    subcort: VolumeData | null,
    leftThresh: OverlayData | undefined,
    rightThresh: OverlayData | undefined,
    subcortThresh: VolumeData | null,
    fileThreshMin: number,
    fileThreshMax: number,
    isShowOutside: boolean,
  ) => void;
} {
  // Parse overlay names: "CONTRAST/swe_dpx_zTstat_c01[_clust]"
  // Extract unique contrast names (the part before "/") and whether _clust variants exist.
  const contrastSet = new Set<string>();
  const clustSet = new Set<string>();
  for (const name of overlayNames) {
    const slash = name.indexOf('/');
    const contrast = slash >= 0 ? name.slice(0, slash) : name;
    contrastSet.add(contrast);
    if (name.endsWith('_clust')) clustSet.add(contrast);
  }
  const contrasts = [...contrastSet];

  // Human-readable contrast label: "CUE_AVG" → "Cue Avg", "FEEDBACK_HIGH_LOW_WIN" → "Feedback High Low Win"
  function formatContrast(c: string): string {
    return c.split('_').map(w => w.charAt(0) + w.slice(1).toLowerCase()).join(' ');
  }

  // Build the raw overlay name from contrast + type
  function overlayNameFor(contrast: string, type: 'statistic' | 'cluster'): string {
    const statName = overlayNames.find(n => n.startsWith(contrast + '/') && !n.endsWith('_clust'));
    const clustName = overlayNames.find(n => n.startsWith(contrast + '/') && n.endsWith('_clust'));
    if (type === 'cluster') return clustName ?? statName ?? overlayNames[0];
    return statName ?? overlayNames[0];
  }

  const initialContrast = contrasts[0] ?? '';
  const initialType: 'statistic' | 'cluster' = 'statistic';

  const state: GuiState = {
    overlay: overlayNameFor(initialContrast, initialType),
    overlayType: initialType,
    posThresh: 0,
    negThresh: 0,
    thresholdOn: false,
    posMin: 0,
    posMax: 1,
    negMin: -1,
    negMax: 0,
    showParcelBoundaries: false,
    showSelectedParcels: false,
    parcelOpacity: 0.85,
    parcelBlend: 'fill' as const,
  };

  const dataInfo: DataInfo = {
    dataMin: '--',
    dataMax: '--',
    posMinVal: '--',
    negMaxVal: '--',
    threshPosMin: '--',
    threshNegMax: '--',
  };

  const settingsPane = document.getElementById('pane-settings')!;
  const gui = new GUI({ title: 'Brain Viewer', container: settingsPane });

  // --- Overlay selector ---
  // Type toggle: Statistics / Clusters
  const typeRow = document.createElement('div');
  typeRow.style.cssText = 'display:flex; gap:4px; padding:4px 8px 6px;';

  let activeContrast = initialContrast;

  function setOverlay(contrast: string, type: 'statistic' | 'cluster'): void {
    activeContrast = contrast;
    state.overlayType = type;
    state.overlay = overlayNameFor(contrast, type);
    updateContrastButtons();
    updateTypeButtons();
    callbacks.onOverlayChange();
  }

  // Type toggle buttons
  const statBtn = document.createElement('button');
  const clustBtn = document.createElement('button');

  function styleTypeBtn(btn: HTMLButtonElement, active: boolean): void {
    btn.style.cssText = `flex:1; padding:5px 0; border:1px solid #555; border-radius:3px; cursor:pointer;
      font:12px monospace; background:${active ? '#4a7' : '#2a2a2a'}; color:${active ? '#fff' : '#aaa'};`;
  }

  function updateTypeButtons(): void {
    styleTypeBtn(statBtn, state.overlayType === 'statistic');
    styleTypeBtn(clustBtn, state.overlayType === 'cluster');
  }

  statBtn.textContent = 'Statistics';
  clustBtn.textContent = 'Clusters';
  statBtn.onclick = () => setOverlay(activeContrast, 'statistic');
  clustBtn.onclick = () => setOverlay(activeContrast, 'cluster');
  updateTypeButtons();
  typeRow.appendChild(statBtn);
  typeRow.appendChild(clustBtn);
  gui.$children.prepend(typeRow);

  // Contrast buttons
  const contrastGrid = document.createElement('div');
  contrastGrid.style.cssText = 'display:flex; flex-wrap:wrap; gap:4px; padding:4px 8px 8px;';

  const contrastButtons = new Map<string, HTMLButtonElement>();

  function styleContrastBtn(btn: HTMLButtonElement, active: boolean): void {
    btn.style.cssText = `padding:4px 8px; border:1px solid #555; border-radius:3px; cursor:pointer;
      font:11px monospace; background:${active ? '#4a7' : '#2a2a2a'}; color:${active ? '#fff' : '#aaa'};
      white-space:nowrap;`;
  }

  function updateContrastButtons(): void {
    for (const [c, btn] of contrastButtons) {
      styleContrastBtn(btn, c === activeContrast);
    }
  }

  for (const c of contrasts) {
    const btn = document.createElement('button');
    btn.textContent = formatContrast(c);
    styleContrastBtn(btn, c === activeContrast);
    btn.onclick = () => setOverlay(c, state.overlayType);
    contrastGrid.appendChild(btn);
    contrastButtons.set(c, btn);
  }

  gui.$children.prepend(contrastGrid);

  // --- Scene info (closed by default) ---
  const infoFolder = gui.addFolder('Scene Info');
  infoFolder.close();

  if (sceneConfig.palette) {
    const p = sceneConfig.palette;
    const infoObj = {
      palette: p.name,
      scaleMode: p.scaleMode.replace('MODE_', ''),
      scaleRange: `[${p.negMin}, ${p.negMax}] [${p.posMin}, ${p.posMax}]`,
    };
    infoFolder.add(infoObj, 'palette').name('Palette').disable();
    infoFolder.add(infoObj, 'scaleMode').name('Scale Mode').disable();
    infoFolder.add(infoObj, 'scaleRange').name('Scale Range').disable();
  }
  if (sceneConfig.threshold) {
    const t = sceneConfig.threshold;
    const threshInfo = {
      type: t.type.replace('THRESHOLD_TYPE_', ''),
      test: t.type !== 'THRESHOLD_TYPE_OFF'
        ? t.test.replace('THRESHOLD_TEST_', '') : 'N/A',
      range: t.type !== 'THRESHOLD_TYPE_OFF'
        ? `${t.min} to ${t.max}` : 'N/A',
    };
    infoFolder.add(threshInfo, 'type').name('Thresh Type').disable();
    infoFolder.add(threshInfo, 'test').name('Thresh Test').disable();
    infoFolder.add(threshInfo, 'range').name('Thresh Range').disable();
  }
  infoFolder.add(dataInfo, 'dataMin').name('Data Min').disable();
  infoFolder.add(dataInfo, 'dataMax').name('Data Max').disable();
  infoFolder.add(dataInfo, 'posMinVal').name('Min > 0').disable();
  infoFolder.add(dataInfo, 'negMaxVal').name('Max < 0').disable();
  infoFolder.add(dataInfo, 'threshPosMin').name('Thresh+ Min').disable();
  infoFolder.add(dataInfo, 'threshNegMax').name('Thresh- Max').disable();

  const threshFolder = gui.addFolder('Threshold');
  threshFolder.close();
  threshFolder.add(state, 'thresholdOn').name('Enabled').onChange(callbacks.onColorsChange);
  const posThreshCtrl = threshFolder.add(state, 'posThresh', 0, 30, 0.1).name('Pos Thresh').onChange(callbacks.onColorsChange);
  const negThreshCtrl = threshFolder.add(state, 'negThresh', 0, 30, 0.1).name('Neg Thresh').onChange(callbacks.onColorsChange);

  const rangeFolder = gui.addFolder('Display Range');
  rangeFolder.close();
  rangeFolder.add(state, 'posMin').name('Pos Min').onChange(callbacks.onColorsChange);
  rangeFolder.add(state, 'posMax').name('Pos Max').onChange(callbacks.onColorsChange);
  rangeFolder.add(state, 'negMin').name('Neg Min').onChange(callbacks.onColorsChange);
  rangeFolder.add(state, 'negMax').name('Neg Max').onChange(callbacks.onColorsChange);

  // Parcellation overlay (open by default)
  const parcelFolder = gui.addFolder('CAB-NP Parcels');
  parcelFolder.add(state, 'showParcelBoundaries').name('Boundaries').onChange(callbacks.onColorsChange);
  parcelFolder.add(state, 'showSelectedParcels').name('Selected Parcels').onChange(callbacks.onColorsChange);
  parcelFolder.add(state, 'parcelBlend', ['outline', 'fill']).name('Mode').onChange(callbacks.onColorsChange);
  parcelFolder.add(state, 'parcelOpacity', 0, 1, 0.05).name('Strength').onChange(callbacks.onColorsChange);

  // Network legend container (inside parcel folder)
  const legendContainer = document.createElement('div');
  legendContainer.style.cssText = 'padding:4px 8px 6px;';
  parcelFolder.$children.appendChild(legendContainer);

  function updateNetworkLegend(networkColors: Record<string, [number, number, number]> | null): void {
    legendContainer.innerHTML = '';
    if (!networkColors) return;

    const entries = Object.entries(networkColors);
    if (entries.length === 0) return;

    const title = document.createElement('div');
    title.textContent = 'Networks';
    title.style.cssText = 'color:#888; font:11px monospace; margin-bottom:4px;';
    legendContainer.appendChild(title);

    for (const [name, rgb] of entries) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; align-items:center; gap:6px; margin-bottom:2px;';

      const swatch = document.createElement('span');
      const r = Math.round(rgb[0] * 255);
      const g = Math.round(rgb[1] * 255);
      const b = Math.round(rgb[2] * 255);
      swatch.style.cssText = `display:inline-block; width:12px; height:12px; border-radius:2px; flex-shrink:0;
        background:rgb(${r},${g},${b}); border:1px solid #555;`;

      const label = document.createElement('span');
      label.textContent = name;
      label.style.cssText = 'color:#ccc; font:11px monospace;';

      row.appendChild(swatch);
      row.appendChild(label);
      legendContainer.appendChild(row);
    }
  }

  // Histograms
  const histFolder = gui.addFolder('Histograms');

  const leftCanvas = createHistogramCanvas();
  const rightCanvas = createHistogramCanvas();
  const subcortCanvas = createHistogramCanvas();

  // Add labeled canvases into the lil-gui folder
  const addHistCanvas = (label: string, canvas: HTMLCanvasElement): void => {
    const container = document.createElement('div');
    container.style.padding = '2px 8px 6px';

    const labelEl = document.createElement('div');
    labelEl.textContent = label;
    labelEl.style.color = '#888';
    labelEl.style.fontSize = '11px';
    labelEl.style.marginBottom = '2px';
    labelEl.style.fontFamily = 'monospace';
    container.appendChild(labelEl);
    container.appendChild(canvas);

    histFolder.$children.appendChild(container);
  };

  addHistCanvas('Left Hemisphere', leftCanvas);
  addHistCanvas('Right Hemisphere', rightCanvas);
  addHistCanvas('Subcortical', subcortCanvas);

  let leftHist: (HistogramData & { min: number; max: number }) | null = null;
  let rightHist: (HistogramData & { min: number; max: number }) | null = null;
  let subcortHist: (HistogramData & { min: number; max: number }) | null = null;

  function redrawHistograms(): void {
    if (leftHist) drawHistogram(leftCanvas, leftHist, state.posThresh, state.negThresh, state.thresholdOn);
    if (rightHist) drawHistogram(rightCanvas, rightHist, state.posThresh, state.negThresh, state.thresholdOn);
    if (subcortHist) drawHistogram(subcortCanvas, subcortHist, state.posThresh, state.negThresh, state.thresholdOn);
  }

  // Redraw histograms when threshold changes
  const origOnColorsChange = callbacks.onColorsChange;
  callbacks.onColorsChange = () => {
    origOnColorsChange();
    redrawHistograms();
  };

  return {
    gui,
    state,
    dataInfo,
    refresh: () => gui.controllersRecursive().forEach(c => c.updateDisplay()),
    updateNetworkLegend,
    updateThresholdRange: (maxAbsValue: number) => {
      posThreshCtrl.max(maxAbsValue);
      negThreshCtrl.max(maxAbsValue);
    },
    updateHistograms: (
      left: OverlayData | undefined,
      right: OverlayData | undefined,
      subcort: VolumeData | null,
      leftThresh: OverlayData | undefined,
      rightThresh: OverlayData | undefined,
      subcortThresh: VolumeData | null,
      fileThreshMin: number,
      fileThreshMax: number,
      isShowOutside: boolean,
    ) => {
      leftHist = left ? computeHistogram(left.data, HIST_BINS, leftThresh?.data ?? null, fileThreshMin, fileThreshMax, isShowOutside) : null;
      rightHist = right ? computeHistogram(right.data, HIST_BINS, rightThresh?.data ?? null, fileThreshMin, fileThreshMax, isShowOutside) : null;
      subcortHist = subcort ? computeHistogram(subcort.volume, HIST_BINS, subcortThresh?.volume ?? null, fileThreshMin, fileThreshMax, isShowOutside) : null;
      redrawHistograms();
    },
  };
}
