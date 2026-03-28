import type { VolumeData, PaletteControlPoint, PaletteMapping } from './types';
import { mapScalarToRGBA, mapClusterToRGB } from './colormap';

const BG_COLOR = 26; // #1a1a1a

export interface SliceViewer {
  setUnderlay(ul: VolumeData): void;
  setVolume(vol: VolumeData, thresh: VolumeData | null): void;
  setColorMapping(
    mapping: PaletteMapping,
    palette: PaletteControlPoint[],
    fileThreshMin: number,
    fileThreshMax: number,
    fileThreshTest: string,
    clustMode?: boolean,
    clustLookup?: Map<number, number>,
  ): void;
  render(): void;
  dispose(): void;
}

export function createSliceViewer(canvas: HTMLCanvasElement): SliceViewer {
  const ctx2d = canvas.getContext('2d')!;

  let underlay: VolumeData | null = null;
  let underlayMax = 1;
  let vol: VolumeData | null = null;
  let thresh: VolumeData | null = null;
  let mapping: PaletteMapping | null = null;
  let palette: PaletteControlPoint[] = [];
  let fileThreshMin = 0;
  let fileThreshMax = 0;
  let fileThreshTest = 'THRESHOLD_TEST_SHOW_OUTSIDE';
  let isClustMode = false;
  let clusterLookup: Map<number, number> = new Map();

  let ci = 0;
  let cj = 0;
  let ck = 0;

  interface SliceLayout {
    // Axial: draws di cols × dj rows
    axX: number; axY: number; axW: number; axH: number;
    // Sagittal: draws dj cols × dk rows
    sagX: number; sagY: number; sagW: number; sagH: number;
    // Coronal: draws di cols × dk rows
    corX: number; corY: number; corW: number; corH: number;
    // Info panel
    infX: number; infY: number;
  }

  function getLayout(): SliceLayout | null {
    const refVol = vol ?? underlay;
    if (!refVol) return null;
    const [di, dj, dk] = refVol.dims;
    const W = canvas.width;
    const H = canvas.height;

    // All three slices in a single row, scaled to the same height.
    // Physical heights: axial=dj, sagittal=dk, coronal=dk
    // Unified row height = max of all three
    const rowH = Math.max(dj, dk);
    // Physical widths at that row height:
    //   axial: di * (rowH / dj)
    //   sagittal: dj * (rowH / dk)
    //   coronal: di * (rowH / dk)
    const axPhysW = di * rowH / dj;
    const sagPhysW = dj * rowH / dk;
    const corPhysW = di * rowH / dk;
    const totalPhysW = axPhysW + sagPhysW + corPhysW;

    // Scale to fit canvas width and height
    const scaleW = W / totalPhysW;
    const scaleH = H / rowH;
    const scale = Math.min(scaleW, scaleH);

    const h = Math.floor(rowH * scale);
    const axW = Math.floor(axPhysW * scale);
    const sagW = Math.floor(sagPhysW * scale);
    const corW = Math.floor(corPhysW * scale);

    const axX = 0;
    const sagX = axW;
    const corX = axW + sagW;
    const infX = axW + sagW + corW;

    return {
      axX, axY: 0, axW, axH: h,
      sagX, sagY: 0, sagW, sagH: h,
      corX, corY: 0, corW, corH: h,
      infX, infY: 0,
    };
  }

  function voxelValue(volume: Float32Array, dims: [number, number, number], i: number, j: number, k: number): number {
    return volume[i * dims[1] * dims[2] + j * dims[2] + k];
  }

  function drawSlice(
    sliceExtract: (a: number, b: number) => number,
    threshExtract: ((a: number, b: number) => number) | null,
    underlayExtract: ((a: number, b: number) => number) | null,
    dimA: number,
    dimB: number,
    ox: number,
    oy: number,
    qw: number,
    qh: number,
    crossA: number,
    crossB: number,
  ): void {
    if (!mapping) return;

    const imgData = ctx2d.createImageData(dimA, dimB);
    const pixels = imgData.data;

    for (let a = 0; a < dimA; a++) {
      for (let b = 0; b < dimB; b++) {
        const flippedB = dimB - 1 - b;
        const idx = (flippedB * dimA + a) * 4;

        // Start with underlay (grayscale anatomical)
        let bgR = BG_COLOR;
        let bgG = BG_COLOR;
        let bgB = BG_COLOR;
        if (underlayExtract) {
          const ulVal = underlayExtract(a, b);
          if (!isNaN(ulVal) && ulVal > 0) {
            const intensity = Math.round((ulVal / underlayMax) * 255);
            bgR = intensity;
            bgG = intensity;
            bgB = intensity;
          }
        }

        // Check overlay
        const val = sliceExtract(a, b);
        if (isNaN(val) || val === 0) {
          pixels[idx] = bgR;
          pixels[idx + 1] = bgG;
          pixels[idx + 2] = bgB;
          pixels[idx + 3] = 255;
          continue;
        }

        if (isClustMode) {
          const [r, g, b2, a2] = mapClusterToRGB(val, clusterLookup);
          if (a2 === 0) {
            pixels[idx] = bgR;
            pixels[idx + 1] = bgG;
            pixels[idx + 2] = bgB;
          } else {
            // Check if this voxel is on a cluster boundary (any 4-neighbor
            // has a different cluster value) and darken it for an outline
            let isBorder = false;
            const neighbors: [number, number][] = [[a - 1, b], [a + 1, b], [a, b - 1], [a, b + 1]];
            for (const [na, nb] of neighbors) {
              if (na >= 0 && na < dimA && nb >= 0 && nb < dimB) {
                const nv = sliceExtract(na, nb);
                const nc = isNaN(nv) ? 0 : nv;
                if (nc !== val) { isBorder = true; break; }
              }
            }
            if (isBorder) {
              pixels[idx] = Math.round(r * 255 * 0.25 + 255 * 0.75);
              pixels[idx + 1] = Math.round(g * 255 * 0.25 + 255 * 0.75);
              pixels[idx + 2] = Math.round(b2 * 255 * 0.25 + 255 * 0.75);
            } else {
              pixels[idx] = Math.round(r * 255);
              pixels[idx + 1] = Math.round(g * 255);
              pixels[idx + 2] = Math.round(b2 * 255);
            }
          }
          pixels[idx + 3] = 255;
          continue;
        }

        // GUI threshold (pos/neg)
        if (mapping.thresholdOn) {
          if (val > 0 && val < mapping.posThresh) {
            pixels[idx] = bgR;
            pixels[idx + 1] = bgG;
            pixels[idx + 2] = bgB;
            pixels[idx + 3] = 255;
            continue;
          }
          if (val < 0 && val > -mapping.negThresh) {
            pixels[idx] = bgR;
            pixels[idx + 1] = bgG;
            pixels[idx + 2] = bgB;
            pixels[idx + 3] = 255;
            continue;
          }
        }

        // File-based threshold
        if (threshExtract) {
          const tv = threshExtract(a, b);
          if (isNaN(tv)) {
            pixels[idx] = bgR;
            pixels[idx + 1] = bgG;
            pixels[idx + 2] = bgB;
            pixels[idx + 3] = 255;
            continue;
          }
          const outside = tv < fileThreshMin || tv > fileThreshMax;
          const visible = fileThreshTest === 'THRESHOLD_TEST_SHOW_OUTSIDE' ? outside : !outside;
          if (!visible) {
            pixels[idx] = bgR;
            pixels[idx + 1] = bgG;
            pixels[idx + 2] = bgB;
            pixels[idx + 3] = 255;
            continue;
          }
        }

        const [r, g, b2, a2] = mapScalarToRGBA(val, mapping, palette);
        if (a2 === 0) {
          pixels[idx] = bgR;
          pixels[idx + 1] = bgG;
          pixels[idx + 2] = bgB;
          pixels[idx + 3] = 255;
        } else {
          pixels[idx] = Math.round(r * 255);
          pixels[idx + 1] = Math.round(g * 255);
          pixels[idx + 2] = Math.round(b2 * 255);
          pixels[idx + 3] = 255;
        }
      }
    }

    const offscreen = new OffscreenCanvas(dimA, dimB);
    const offCtx = offscreen.getContext('2d')!;
    offCtx.putImageData(imgData, 0, 0);

    ctx2d.imageSmoothingEnabled = false;
    ctx2d.drawImage(offscreen, ox, oy, qw, qh);

    // Crosshairs
    ctx2d.strokeStyle = 'rgba(0, 255, 0, 0.5)';
    ctx2d.lineWidth = 1;
    const scaleA = qw / dimA;
    const scaleB = qh / dimB;

    const cx = ox + (crossA + 0.5) * scaleA;
    ctx2d.beginPath();
    ctx2d.moveTo(cx, oy);
    ctx2d.lineTo(cx, oy + qh);
    ctx2d.stroke();

    const cy = oy + (dimB - 1 - crossB + 0.5) * scaleB;
    ctx2d.beginPath();
    ctx2d.moveTo(ox, cy);
    ctx2d.lineTo(ox + qw, cy);
    ctx2d.stroke();
  }

  function render(): void {
    // Can render underlay even without overlay
    const refVol = vol ?? underlay;
    if (!refVol) {
      ctx2d.fillStyle = '#1a1a1a';
      ctx2d.fillRect(0, 0, canvas.width, canvas.height);
      return;
    }

    const [di, dj, dk] = refVol.dims;
    const layout = getLayout()!;

    ctx2d.fillStyle = '#1a1a1a';
    ctx2d.fillRect(0, 0, canvas.width, canvas.height);

    const volData = vol?.volume ?? null;
    const vDims = vol?.dims ?? refVol.dims;
    const threshData = thresh?.volume ?? null;
    const tDims = thresh?.dims ?? refVol.dims;
    const ulData = underlay?.volume ?? null;
    const ulDims = underlay?.dims ?? refVol.dims;

    const overlayAt = volData
      ? (i: number, j: number, k: number) => voxelValue(volData, vDims, i, j, k)
      : (_i: number, _j: number, _k: number) => NaN;

    const threshAt = threshData
      ? (i: number, j: number, k: number) => voxelValue(threshData, tDims, i, j, k)
      : null;

    const ulAt = ulData
      ? (i: number, j: number, k: number) => voxelValue(ulData, ulDims, i, j, k)
      : null;

    // Axial: I x J at k=ck
    drawSlice(
      (a, b) => overlayAt(a, b, ck),
      threshAt ? (a, b) => threshAt(a, b, ck) : null,
      ulAt ? (a, b) => ulAt(a, b, ck) : null,
      di, dj, layout.axX, layout.axY, layout.axW, layout.axH, ci, cj,
    );

    // Sagittal: J x K at i=ci
    drawSlice(
      (a, b) => overlayAt(ci, a, b),
      threshAt ? (a, b) => threshAt(ci, a, b) : null,
      ulAt ? (a, b) => ulAt(ci, a, b) : null,
      dj, dk, layout.sagX, layout.sagY, layout.sagW, layout.sagH, cj, ck,
    );

    // Coronal: I x K at j=cj
    drawSlice(
      (a, b) => overlayAt(a, cj, b),
      threshAt ? (a, b) => threshAt(a, cj, b) : null,
      ulAt ? (a, b) => ulAt(a, cj, b) : null,
      di, dk, layout.corX, layout.corY, layout.corW, layout.corH, ci, ck,
    );

    drawInfoPanel(layout);
  }

  function drawInfoPanel(layout: SliceLayout): void {
    const refVol = vol ?? underlay;
    if (!refVol) return;

    const ox = layout.infX;
    const oy = layout.infY;

    const aff = refVol.affine3x4;
    const mniX = aff[0] * ci + aff[1] * cj + aff[2] * ck + aff[3];
    const mniY = aff[4] * ci + aff[5] * cj + aff[6] * ck + aff[7];
    const mniZ = aff[8] * ci + aff[9] * cj + aff[10] * ck + aff[11];

    const val = vol ? voxelValue(vol.volume, vol.dims, ci, cj, ck) : NaN;

    ctx2d.fillStyle = '#aaa';
    ctx2d.font = '13px monospace';
    const lines = [
      'Axial | Sagittal | Coronal',
      '',
      '',
      `Voxel: [${ci}, ${cj}, ${ck}]`,
      `MNI: [${mniX.toFixed(1)}, ${mniY.toFixed(1)}, ${mniZ.toFixed(1)}]`,
      `Value: ${isNaN(val) ? 'NaN' : val.toFixed(3)}`,
      '',
      'Click: navigate',
      'Scroll: change slice',
    ];
    lines.forEach((line, i) => {
      ctx2d.fillText(line, ox + 10, oy + 20 + i * 18);
    });
  }

  function hitTest(px: number, py: number): { quadrant: string; a: number; b: number } | null {
    const refVol = vol ?? underlay;
    if (!refVol) return null;
    const layout = getLayout();
    if (!layout) return null;
    const [di, dj, dk] = refVol.dims;

    if (px >= layout.axX && px < layout.axX + layout.axW) {
      const bScreen = Math.floor(py / layout.axH * dj);
      return { quadrant: 'axial', a: Math.floor((px - layout.axX) / layout.axW * di), b: dj - 1 - bScreen };
    } else if (px >= layout.sagX && px < layout.sagX + layout.sagW) {
      const bScreen = Math.floor(py / layout.sagH * dk);
      return { quadrant: 'sagittal', a: Math.floor((px - layout.sagX) / layout.sagW * dj), b: dk - 1 - bScreen };
    } else if (px >= layout.corX && px < layout.corX + layout.corW) {
      const bScreen = Math.floor(py / layout.corH * dk);
      return { quadrant: 'coronal', a: Math.floor((px - layout.corX) / layout.corW * di), b: dk - 1 - bScreen };
    }
    return null;
  }

  function onClick(e: MouseEvent): void {
    const refVol = vol ?? underlay;
    if (!refVol) return;
    const rect = canvas.getBoundingClientRect();
    const px = (e.clientX - rect.left) * (canvas.width / rect.width);
    const py = (e.clientY - rect.top) * (canvas.height / rect.height);
    const hit = hitTest(px, py);
    if (!hit) return;

    const [di, dj, dk] = refVol.dims;
    if (hit.quadrant === 'axial') {
      ci = Math.max(0, Math.min(di - 1, hit.a));
      cj = Math.max(0, Math.min(dj - 1, hit.b));
    } else if (hit.quadrant === 'sagittal') {
      cj = Math.max(0, Math.min(dj - 1, hit.a));
      ck = Math.max(0, Math.min(dk - 1, hit.b));
    } else if (hit.quadrant === 'coronal') {
      ci = Math.max(0, Math.min(di - 1, hit.a));
      ck = Math.max(0, Math.min(dk - 1, hit.b));
    }
    render();
  }

  function onWheel(e: WheelEvent): void {
    const refVol = vol ?? underlay;
    if (!refVol) return;
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const px = (e.clientX - rect.left) * (canvas.width / rect.width);
    const py = (e.clientY - rect.top) * (canvas.height / rect.height);
    const hit = hitTest(px, py);
    if (!hit) return;

    const delta = e.deltaY > 0 ? -1 : 1;
    const [di, dj, dk] = refVol.dims;

    if (hit.quadrant === 'axial') {
      ck = Math.max(0, Math.min(dk - 1, ck + delta));
    } else if (hit.quadrant === 'sagittal') {
      ci = Math.max(0, Math.min(di - 1, ci + delta));
    } else if (hit.quadrant === 'coronal') {
      cj = Math.max(0, Math.min(dj - 1, cj + delta));
    }
    render();
  }

  canvas.addEventListener('click', onClick);
  canvas.addEventListener('wheel', onWheel, { passive: false });

  return {
    setUnderlay(ul: VolumeData): void {
      underlay = ul;
      underlayMax = ul.max;
      // Set initial crosshair to center of underlay if no overlay yet
      if (!vol) {
        ci = Math.floor(ul.dims[0] / 2);
        cj = Math.floor(ul.dims[1] / 2);
        ck = Math.floor(ul.dims[2] / 2);
      }
    },

    setVolume(newVol: VolumeData, newThresh: VolumeData | null): void {
      const dimsChanged = !vol
        || vol.dims[0] !== newVol.dims[0]
        || vol.dims[1] !== newVol.dims[1]
        || vol.dims[2] !== newVol.dims[2];
      vol = newVol;
      thresh = newThresh;
      if (dimsChanged) {
        ci = Math.floor(newVol.dims[0] / 2);
        cj = Math.floor(newVol.dims[1] / 2);
        ck = Math.floor(newVol.dims[2] / 2);
      }
    },

    setColorMapping(
      newMapping: PaletteMapping,
      newPalette: PaletteControlPoint[],
      newFileThreshMin: number,
      newFileThreshMax: number,
      newFileThreshTest: string,
      newClustMode?: boolean,
      newClustLookup?: Map<number, number>,
    ): void {
      mapping = newMapping;
      palette = newPalette;
      fileThreshMin = newFileThreshMin;
      fileThreshMax = newFileThreshMax;
      fileThreshTest = newFileThreshTest;
      isClustMode = newClustMode ?? false;
      clusterLookup = newClustLookup ?? new Map();
    },

    render,

    dispose(): void {
      canvas.removeEventListener('click', onClick);
      canvas.removeEventListener('wheel', onWheel);
    },
  };
}
