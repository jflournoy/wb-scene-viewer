import type { SurfaceData, OverlayData, VolumeData, LabelEntry, Manifest, SceneSettings, CabnpSelectedParcels } from './types';

export async function loadManifest(): Promise<Manifest> {
  const res = await fetch('/api/manifest');
  return res.json() as Promise<Manifest>;
}

export async function loadSceneSettings(): Promise<SceneSettings> {
  const res = await fetch('/api/scene-settings');
  return res.json() as Promise<SceneSettings>;
}

export async function loadSurface(hemisphere: string): Promise<SurfaceData> {
  const buf = await fetch(`/api/surface/${hemisphere}`).then(r => r.arrayBuffer());
  const dv = new DataView(buf);
  const nV = dv.getUint32(0, true);
  const nF = dv.getUint32(4, true);
  const vertices = new Float32Array(buf, 8, nV * 3);
  const faces = new Uint32Array(buf, 8 + nV * 12, nF * 3);
  return { vertices, faces, nV, nF };
}

export async function loadOverlay(name: string): Promise<OverlayData> {
  const encoded = name.split('/').map(encodeURIComponent).join('/');
  const res = await fetch(`/api/overlay/${encoded}`);
  const min = parseFloat(res.headers.get('X-Data-Min') ?? '0');
  const max = parseFloat(res.headers.get('X-Data-Max') ?? '1');
  const data = new Float32Array(await res.arrayBuffer());
  return { data, min, max };
}

export async function loadVolume(name: string): Promise<VolumeData> {
  const encoded = name.split('/').map(encodeURIComponent).join('/');
  const res = await fetch(`/api/volume/${encoded}`);
  if (!res.ok) throw new Error(`Volume '${name}' not found`);
  const min = parseFloat(res.headers.get('X-Data-Min') ?? '0');
  const max = parseFloat(res.headers.get('X-Data-Max') ?? '1');
  const buf = await res.arrayBuffer();
  const dv = new DataView(buf);
  const di = dv.getUint32(0, true);
  const dj = dv.getUint32(4, true);
  const dk = dv.getUint32(8, true);
  // Copy affine bytes to an aligned buffer (offset 12 is not 8-byte aligned)
  const affine3x4 = new Float64Array(12);
  for (let i = 0; i < 12; i++) {
    affine3x4[i] = dv.getFloat64(12 + i * 8, true);
  }
  const volume = new Float32Array(buf, 108, di * dj * dk);
  return { volume, dims: [di, dj, dk], affine3x4, min, max };
}

export async function loadUnderlay(): Promise<VolumeData> {
  const res = await fetch('/api/underlay');
  if (!res.ok) throw new Error('No underlay available');
  const min = parseFloat(res.headers.get('X-Data-Min') ?? '0');
  const max = parseFloat(res.headers.get('X-Data-Max') ?? '1');
  const buf = await res.arrayBuffer();
  const dv = new DataView(buf);
  const di = dv.getUint32(0, true);
  const dj = dv.getUint32(4, true);
  const dk = dv.getUint32(8, true);
  const affine3x4 = new Float64Array(12);
  for (let i = 0; i < 12; i++) {
    affine3x4[i] = dv.getFloat64(12 + i * 8, true);
  }
  const volume = new Float32Array(buf, 108, di * dj * dk);
  return { volume, dims: [di, dj, dk], affine3x4, min, max };
}

export async function loadCabnpBoundaries(hemisphere: string): Promise<Uint8Array> {
  const buf = await fetch(`/api/cabnp/boundaries/${hemisphere}`).then(r => r.arrayBuffer());
  return new Uint8Array(buf);
}

export async function loadCabnpFullBoundaries(hemisphere: string): Promise<Uint8Array> {
  const buf = await fetch(`/api/cabnp/full-boundaries/${hemisphere}`).then(r => r.arrayBuffer());
  return new Uint8Array(buf);
}

export async function loadCabnpParcels(hemisphere: string): Promise<Int32Array> {
  const buf = await fetch(`/api/cabnp/parcels/${hemisphere}`).then(r => r.arrayBuffer());
  return new Int32Array(buf);
}

export async function loadCabnpSelected(contrast: string): Promise<CabnpSelectedParcels> {
  const res = await fetch(`/api/cabnp/selected/${encodeURIComponent(contrast)}`);
  return res.json() as Promise<CabnpSelectedParcels>;
}

export async function loadLabelTable(name: string): Promise<LabelEntry[]> {
  const res = await fetch(`/api/labels/${encodeURIComponent(name)}/table`);
  return res.json() as Promise<LabelEntry[]>;
}

export async function loadLabelIndices(name: string): Promise<Int32Array> {
  const buf = await fetch(`/api/labels/${encodeURIComponent(name)}/indices`).then(r => r.arrayBuffer());
  return new Int32Array(buf);
}
