export interface SurfaceData {
  vertices: Float32Array;
  faces: Uint32Array;
  nV: number;
  nF: number;
}

export interface OverlayData {
  data: Float32Array;
  min: number;
  max: number;
}

export interface LabelEntry {
  key: number;
  name: string;
  rgba: [number, number, number, number];
}

export interface PaletteControlPoint {
  scalar: number;
  color: [number, number, number, number];
}

export interface PaletteMapping {
  posMin: number;
  posMax: number;
  negMin: number;
  negMax: number;
  posThresh: number;
  negThresh: number;
  thresholdOn: boolean;
  displayPositive: boolean;
  displayNegative: boolean;
  displayZero: boolean;
  interpolate: boolean;
}

export interface OverlayInfo {
  name: string;
  hemisphere: string;
  type: 'scalar' | 'label' | 'func' | 'shape';
}

export interface CabnpInfo {
  available: boolean;
  contrasts: string[];
}

export interface CabnpSelectedParcels {
  parcels: number[];
  networks: Record<string, string>;
  network_colors: Record<string, [number, number, number]>;
}

export interface Manifest {
  surfaces: { hemisphere: string }[];
  overlays: OverlayInfo[];
  labels: { name: string; hemisphere: string }[];
  volumes?: { name: string }[];
  cabnp?: CabnpInfo;
}

export interface ScenePalette {
  name: string;
  scaleMode: string;
  posMin: number;
  posMax: number;
  negMin: number;
  negMax: number;
  interpolate: boolean;
  displayPositive: boolean;
  displayZero: boolean;
  displayNegative: boolean;
}

export interface SceneThreshold {
  test: string;
  type: string;
  min: number;
  max: number;
  rangeMode: string;
  thresholdFile: string | null;
}

export interface SceneSettings {
  scenes?: string[];
  palette?: ScenePalette;
  threshold?: SceneThreshold;
}

export interface VolumeData {
  volume: Float32Array;     // dense I*J*K array, NaN = empty
  dims: [number, number, number];  // [I, J, K]
  affine3x4: Float64Array;  // 12 values, row-major 3x4 voxel-to-MNI transform
  min: number;
  max: number;
}
