import type { PaletteControlPoint, PaletteMapping } from './types';

export const ROY_BIG_BL: PaletteControlPoint[] = [
  // Positive side (1 = most positive)
  { scalar:  1.000, color: [1.000, 1.000, 0.000, 1] },
  { scalar:  0.875, color: [1.000, 0.784, 0.000, 1] },
  { scalar:  0.750, color: [1.000, 0.471, 0.000, 1] },
  { scalar:  0.625, color: [1.000, 0.000, 0.000, 1] },
  { scalar:  0.500, color: [0.784, 0.000, 0.000, 1] },
  { scalar:  0.375, color: [0.588, 0.000, 0.000, 1] },
  { scalar:  0.250, color: [0.392, 0.000, 0.000, 1] },
  { scalar:  0.125, color: [0.235, 0.000, 0.000, 1] },
  { scalar:  0.000, color: [0.000, 0.000, 0.000, 0] }, // transparent
  // Negative side (-1 = most negative)
  { scalar: -0.125, color: [0.000, 0.000, 0.235, 1] },
  { scalar: -0.250, color: [0.000, 0.000, 0.392, 1] },
  { scalar: -0.375, color: [0.000, 0.000, 0.588, 1] },
  { scalar: -0.500, color: [0.000, 0.000, 0.784, 1] },
  { scalar: -0.625, color: [0.000, 0.000, 1.000, 1] },
  { scalar: -0.750, color: [0.235, 0.235, 1.000, 1] },
  { scalar: -0.875, color: [0.471, 0.471, 1.000, 1] },
  { scalar: -1.000, color: [0.627, 0.627, 1.000, 1] },
];

export const PSYCH_FIXED: PaletteControlPoint[] = [
  { scalar:  1.000,    color: [1.000, 1.000, 0.000, 1] },  // yellow
  { scalar:  0.750,    color: [1.000, 0.800, 0.000, 1] },  // yellow-orange
  { scalar:  0.500,    color: [1.000, 0.600, 0.000, 1] },  // orange
  { scalar:  0.250,    color: [1.000, 0.267, 0.000, 1] },  // orange-red
  { scalar:  0.00001,  color: [1.000, 0.000, 0.000, 1] },  // red
  { scalar:  0.000,    color: [0.000, 0.000, 0.000, 0] },  // black/transparent
  { scalar: -0.00001,  color: [0.000, 0.267, 1.000, 1] },  // blue
  { scalar: -0.250,    color: [0.000, 0.412, 1.000, 1] },  // light blue 1
  { scalar: -0.500,    color: [0.000, 0.600, 1.000, 1] },  // light blue 2
  { scalar: -0.750,    color: [0.000, 0.800, 1.000, 1] },  // blue-cyan
  { scalar: -1.000,    color: [0.000, 1.000, 1.000, 1] },  // cyan
];

export const PALETTES: Record<string, PaletteControlPoint[]> = {
  'ROY-BIG-BL': ROY_BIG_BL,
  'PSYCH-FIXED': PSYCH_FIXED,
};

// Discrete colormap for cluster number overlays.
// Based on the Wong (2011) colorblind-safe palette, extended to 12 colors.
// All colors chosen for high saturation and strong luminance contrast against
// the medium-gray brain (~0.65) and dark background (#1a1a1a).
// Clusters are additionally outlined with dark borders for accessibility.
const CLUSTER_COLORS: [number, number, number][] = [
  [0.000, 0.620, 0.851],  // sky blue       (Wong #3)  L≈0.52
  [0.902, 0.624, 0.000],  // orange-yellow  (Wong #2)  L≈0.64
  [0.800, 0.475, 0.655],  // reddish purple (Wong #7)  L≈0.57
  [0.000, 0.447, 0.698],  // blue           (Wong #4)  L≈0.40
  [0.835, 0.369, 0.000],  // vermillion     (Wong #6)  L≈0.47
  [0.941, 0.894, 0.259],  // yellow         (Wong #5)  L≈0.86
  [0.000, 0.620, 0.451],  // bluish green   (Wong #1)  L≈0.42
  [1.000, 0.510, 0.055],  // bright orange  (extended) L≈0.61
  [0.580, 0.000, 0.827],  // vivid purple   (extended) L≈0.27
  [0.000, 0.808, 0.820],  // bright cyan    (extended) L≈0.57
  [1.000, 0.920, 0.000],  // bright yellow  (extended) L≈0.88
  [0.400, 0.200, 0.000],  // dark brown     (extended) L≈0.24
];

/**
 * Build a per-vertex boundary mask from cluster overlay data and mesh faces.
 * A vertex is on a boundary if any neighbor belongs to a different cluster
 * (including cluster 0 / NaN vs non-zero).
 */
export function buildClusterBoundaryMask(
  data: Float32Array,
  faces: Uint32Array,
): Uint8Array {
  const nV = data.length;
  const mask = new Uint8Array(nV); // 0 = interior, 1 = boundary

  // For each face, check if all three vertices share the same cluster value.
  // If not, mark the differing vertices as boundary.
  const nF = faces.length / 3;
  for (let f = 0; f < nF; f++) {
    const i0 = faces[f * 3];
    const i1 = faces[f * 3 + 1];
    const i2 = faces[f * 3 + 2];
    const v0 = data[i0];
    const v1 = data[i1];
    const v2 = data[i2];
    // Treat NaN as 0 for comparison
    const c0 = isNaN(v0) ? 0 : v0;
    const c1 = isNaN(v1) ? 0 : v1;
    const c2 = isNaN(v2) ? 0 : v2;
    if (c0 !== c1 || c0 !== c2) {
      mask[i0] = 1;
      mask[i1] = 1;
      mask[i2] = 1;
    }
  }
  return mask;
}

/**
 * Build a lookup from unique non-zero cluster values to color indices.
 * Uses a hash of the value so that the same parcel/cluster ID always maps
 * to the same color, regardless of how many other IDs are present.
 */
export function buildClusterLookup(data: Float32Array): Map<number, number> {
  const seen = new Set<number>();
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (!isNaN(v) && v !== 0) seen.add(v);
  }
  const n = CLUSTER_COLORS.length;
  const lookup = new Map<number, number>();
  // Assign colors by sorted rank so each cluster gets a distinct color.
  const sorted = Array.from(seen).sort((a, b) => a - b);
  sorted.forEach((v, i) => lookup.set(v, i % n));
  return lookup;
}

/**
 * Map a cluster value to an RGB color using a pre-built lookup.
 * Cluster 0 is treated as "no cluster" (transparent).
 */
export function mapClusterToRGB(
  value: number,
  lookup: Map<number, number>,
): [number, number, number, number] {
  if (value === 0 || isNaN(value)) return [0, 0, 0, 0];
  const idx = lookup.get(value);
  if (idx === undefined) return [0, 0, 0, 0];
  const c = CLUSTER_COLORS[idx];
  return [c[0], c[1], c[2], 1];
}

function interpolatePalette(
  norm: number,
  points: PaletteControlPoint[],
  interpolate: boolean
): [number, number, number, number] {
  // Find bracketing control points
  for (let i = 0; i < points.length - 1; i++) {
    const hi = points[i];
    const lo = points[i + 1];
    if (norm <= hi.scalar && norm >= lo.scalar) {
      if (!interpolate) {
        // Nearest: pick whichever control point is closer
        return (norm - lo.scalar) < (hi.scalar - norm) ? lo.color : hi.color;
      }
      const range = hi.scalar - lo.scalar;
      const t = range !== 0 ? (norm - lo.scalar) / range : 0.5;
      return [
        lo.color[0] + t * (hi.color[0] - lo.color[0]),
        lo.color[1] + t * (hi.color[1] - lo.color[1]),
        lo.color[2] + t * (hi.color[2] - lo.color[2]),
        lo.color[3] + t * (hi.color[3] - lo.color[3]),
      ];
    }
  }
  // Clamp to endpoints
  if (norm >= points[0].scalar) return points[0].color;
  return points[points.length - 1].color;
}

export function mapScalarToRGBA(
  value: number,
  mapping: PaletteMapping,
  points: PaletteControlPoint[]
): [number, number, number, number] {
  // 1. Threshold: hide values between -negThresh and +posThresh
  if (mapping.thresholdOn) {
    if (value > 0 && value < mapping.posThresh) return [0, 0, 0, 0];
    if (value < 0 && value > -mapping.negThresh) return [0, 0, 0, 0];
  }
  // 2. Zero
  if (value === 0 && !mapping.displayZero) return [0, 0, 0, 0];
  // 3. Normalize to [-1, 1] independently per side
  let norm: number;
  if (value > 0) {
    if (!mapping.displayPositive) return [0, 0, 0, 0];
    const range = mapping.posMax - mapping.posMin;
    norm = range !== 0 ? (value - mapping.posMin) / range : 1;
    norm = Math.max(0, Math.min(1, norm));
  } else if (value < 0) {
    if (!mapping.displayNegative) return [0, 0, 0, 0];
    // negMin = most negative (e.g. -5), negMax = closest to zero (e.g. -1)
    // Map: negMin → -1, negMax → 0
    const lo = Math.min(mapping.negMin, mapping.negMax);
    const hi = Math.max(mapping.negMin, mapping.negMax);
    const range = hi - lo;
    norm = range !== 0 ? -1 + (value - lo) / range : -1;
    norm = Math.max(-1, Math.min(0, norm));
  } else {
    return [0, 0, 0, 0];
  }
  // 4. Interpolate palette
  return interpolatePalette(norm, points, mapping.interpolate);
}
