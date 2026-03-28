# Brain Surface Viewer — Claude Code Brief

A local web app that parses HCP/Connectome Workbench outputs from a zip archive and renders interactive brain surfaces with scalar/label overlays in the browser.

## Project structure

```
brain-viewer/
├── server.py              # FastAPI server — parses zip, serves binary data
├── CLAUDE.md              # this file
├── README.md
├── requirements.txt
└── frontend/
    ├── src/
    │   ├── main.ts        # entry: init renderer, load manifest, start loop
    │   ├── scene.ts       # Three.js scene, camera, lights, renderer
    │   ├── brain-mesh.ts  # createBrainMesh(), updateVertexColors()
    │   ├── data-loader.ts # fetch() wrappers for binary surfaces + overlays
    │   ├── colormap.ts    # ROY-BIG-BL palette + threshold logic
    │   ├── gui.ts         # lil-gui control panel
    │   └── types.ts       # shared interfaces
    ├── index.html
    ├── package.json
    ├── tsconfig.json
    └── vite.config.ts
```

## Dev commands

```bash
# Install Python deps
pip install fastapi uvicorn nibabel numpy

# Start server (parses zip on startup, serves on :8421)
python server.py path/to/data.zip

# Frontend dev (separate terminal) — proxies /api to :8421
cd frontend && npm install && npm run dev   # serves on :3000

# Build frontend into dist/ (server mounts this at /)
cd frontend && npm run build
```

## Stack

- **Backend**: Python 3.10+, FastAPI, uvicorn, nibabel, numpy
- **Frontend**: TypeScript (strict), Three.js, lil-gui, Vite
- **No React/Vue** — vanilla TypeScript + Three.js only

---

## Input file formats

The zip may contain any combination of these:

| Extension | Content | Notes |
|-----------|---------|-------|
| `.surf.gii` | Surface mesh (vertices + faces) | NIFTI_INTENT_POINTSET + TRIANGLE |
| `.dscalar.nii` | CIFTI scalar maps | Sparse grayordinates → surface vertices |
| `.dlabel.nii` | CIFTI parcellation labels | Integer keys + embedded RGBA label table |
| `.func.gii` | Functional/statistical surface map | 1D float32 per vertex, one DataArray per map |
| `.shape.gii` | Morphometric surface map | Same as func.gii |
| `.scene` | Optional Workbench display settings | Parse for palette/threshold presets if present |

---

## Python server (`server.py`)

### Architecture

Parse everything on startup, hold in memory, serve as binary. Server is stateless after startup.

### GIFTI parsing

```python
import nibabel as nib
import io

# Surfaces — load from BytesIO
data = zf.read(entry)
fh = nib.FileHolder(fileobj=io.BytesIO(data))
gii = nib.GiftiImage.from_file_map({'image': fh})
vertices = gii.darrays[0].data.astype('float32')  # (N, 3)
faces    = gii.darrays[1].data.astype('int32')    # (M, 3), 0-based

# func.gii / shape.gii — one DataArray per map
scalars = [da.data.astype('float32') for da in gii.darrays]  # list of (N,)
```

Hemisphere detection: scan filename for `.L.`, `.R.`, `lh.`, `rh.`, `left`, `right`.

### CIFTI parsing

**CRITICAL**: nibabel's CIFTI loader requires a real file path, not BytesIO. Write to a temp file.

```python
import tempfile, os

with tempfile.NamedTemporaryFile(suffix='.nii', delete=False) as tmp:
    tmp.write(zf.read(entry))
    tmp_path = tmp.name
try:
    img = nib.load(tmp_path)
    data = np.asarray(img.dataobj, dtype='float32')  # (n_maps, n_grayords)

    # Axis 1 is BrainModelAxis — but verify with isinstance check
    for axis_idx in [0, 1]:
        ax = img.header.get_axis(axis_idx)
        if isinstance(ax, nib.cifti2.BrainModelAxis):
            bm_axis = ax
            break

    scalar_axis = img.header.get_axis(1 - axis_idx)  # the other axis
    map_names = list(getattr(scalar_axis, 'name', [f'map_{i}' for i in range(data.shape[0])]))

    for struct_name, indices, model in bm_axis.iter_structures():
        if model.surface_mask is None:
            continue  # skip subcortical volume structures
        hemi = 'left' if 'LEFT' in str(struct_name) else 'right'
        vtx_idx = model.vertex           # which vertex IDs are in CIFTI
        n_surf  = len(model.surface_mask) # total surface vertices (e.g. 32492)

        for mi, mname in enumerate(map_names):
            full = np.full(n_surf, np.nan, dtype='float32')
            full[vtx_idx] = data[mi, indices]  # reconstruct sparse → dense
            # store as overlays[f"{mname}_{hemi}"]
finally:
    os.unlink(tmp_path)
```

For `.dlabel.nii`, also extract the label table from the scalar axis:

```python
label_axis = img.header.get_axis(0)  # LabelAxis
for mname, ldict in zip(label_axis.name, label_axis.label):
    table = [{'key': k, 'name': v[0], 'rgba': list(v[1])} for k, v in ldict.items()]
```

### API endpoints

| Route | Response | Format |
|-------|----------|--------|
| `GET /api/manifest` | JSON | All surfaces, overlays, labels with metadata |
| `GET /api/surface/{hemisphere}` | Binary | Header + float32 vertices + int32 faces |
| `GET /api/overlay/{name}` | Binary | Raw float32 array, min/max in response headers |
| `GET /api/labels/{name}` | JSON | Label table: `[{key, name, rgba}]` |
| `GET /api/labels/{name}/indices` | Binary | Raw int32 per-vertex label indices |
| `GET /` | HTML | Static frontend (mount `dist/` via StaticFiles) |

### Binary surface format

```
Bytes 0-3:           uint32 numVertices (little-endian)
Bytes 4-7:           uint32 numFaces (little-endian)
Bytes 8 … 8+N*12:   float32[] vertices (x,y,z interleaved)
Bytes 8+N*12 … end: int32[]  faces (v0,v1,v2 interleaved)
```

Overlays are raw float32 bytes, no header. Put min/max in `X-Data-Min` / `X-Data-Max` response headers.

### FastAPI setup

```python
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"],
                   allow_methods=["GET"], allow_headers=["*"])

# Mount built frontend (if exists)
if Path("dist").exists():
    app.mount("/", StaticFiles(directory="dist", html=True), name="static")
```

Auto-open browser 1s after server starts:

```python
import threading, time, webbrowser
threading.Thread(
    target=lambda: (time.sleep(1.0), webbrowser.open("http://127.0.0.1:8421")),
    daemon=True
).start()
```

---

## Frontend

### `vite.config.ts`

```typescript
import { defineConfig } from 'vite';
export default defineConfig({
  server: {
    port: 3000,
    proxy: { '/api': { target: 'http://localhost:8421', changeOrigin: true } },
  },
  build: { target: 'es2022', outDir: '../dist', emptyOutDir: true },
});
```

### `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true
  }
}
```

### Three.js mesh creation (`brain-mesh.ts`)

```typescript
import * as THREE from 'three';

export function createBrainMesh(
  vertices: Float32Array,   // numVertices * 3
  faces: Uint32Array,        // numFaces * 3  ← MUST be Uint32, not Uint16
  colors: Float32Array       // numVertices * 3 (RGB, 0–1)
): THREE.Mesh {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
  geo.setIndex(new THREE.BufferAttribute(faces, 1));

  const colorAttr = new THREE.BufferAttribute(colors, 3);
  colorAttr.setUsage(THREE.DynamicDrawUsage);  // colors update on overlay change
  geo.setAttribute('color', colorAttr);

  geo.computeVertexNormals();  // MUST be called after position + index are set
  geo.computeBoundingSphere();

  const mat = new THREE.MeshPhongMaterial({
    vertexColors: true,
    shininess: 30,
    specular: new THREE.Color(0x222222),
    side: THREE.DoubleSide,
  });
  return new THREE.Mesh(geo, mat);
}

export function updateVertexColors(mesh: THREE.Mesh, newColors: Float32Array): void {
  const attr = mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
  (attr.array as Float32Array).set(newColors);
  attr.needsUpdate = true;  // triggers GPU re-upload — do NOT recreate the attribute
}
```

### Lighting (`scene.ts`)

```typescript
scene.add(new THREE.AmbientLight(0xffffff, 0.5));

const key = new THREE.DirectionalLight(0xffffff, 0.8);
key.position.set(100, 200, 150);
scene.add(key);

const fill = new THREE.DirectionalLight(0xffffff, 0.4);
fill.position.set(-100, -50, -100);
scene.add(fill);
```

### Camera + controls (`scene.ts`)

```typescript
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const camera = new THREE.PerspectiveCamera(45, aspect, 1, 1000);
camera.position.set(0, 0, 300);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 100;
controls.maxDistance = 600;

// MNI convention: X = L(-)/R(+), Y = post(-)/ant(+), Z = inf(-)/sup(+)
export const VIEW_PRESETS: Record<string, [number, number, number]> = {
  lateral_left:  [-300, 0, 0],
  lateral_right: [300, 0, 0],
  dorsal:        [0, 0, 300],
  ventral:       [0, 0, -300],
  anterior:      [0, 300, 0],
  posterior:     [0, -300, 0],
};
```

### Binary data loading (`data-loader.ts`)

```typescript
export async function loadSurface(hemisphere: string) {
  const buf = await fetch(`/api/surface/${hemisphere}`).then(r => r.arrayBuffer());
  const dv = new DataView(buf);
  const nV = dv.getUint32(0, true);
  const nF = dv.getUint32(4, true);
  const vertices = new Float32Array(buf, 8, nV * 3);
  const faces    = new Uint32Array(buf, 8 + nV * 12, nF * 3);
  return { vertices, faces, nV, nF };
}

export async function loadOverlay(name: string) {
  const res = await fetch(`/api/overlay/${encodeURIComponent(name)}`);
  const min = parseFloat(res.headers.get('X-Data-Min') ?? '0');
  const max = parseFloat(res.headers.get('X-Data-Max') ?? '1');
  const data = new Float32Array(await res.arrayBuffer());
  return { data, min, max };
}
```

### Colormap: ROY-BIG-BL (`colormap.ts`)

The standard HCP diverging palette. Positive: black→dark-red→red→orange→yellow. Negative: black→dark-blue→blue→lavender. Transparent at zero.

**Control points** (verify against [workbench source](https://github.com/Washington-University/workbench/blob/master/src/Palette/PaletteDefaults.cxx)):

```typescript
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
```

**Mapping logic** — Workbench uses independent positive/negative display ranges and separate threshold semantics:

```typescript
export interface PaletteMapping {
  posMin: number; posMax: number;    // display range, positive side
  negMin: number; negMax: number;    // display range, negative side (negMax < negMin)
  threshMin: number; threshMax: number;
  thresholdOn: boolean;
  thresholdTest: 'show_outside' | 'show_inside';  // show_outside is standard
  displayPositive: boolean;
  displayNegative: boolean;
  displayZero: boolean;
  interpolate: boolean;
}

export function mapScalarToRGBA(
  value: number,
  mapping: PaletteMapping,
  points: PaletteControlPoint[]
): [number, number, number, number] {
  // 1. Threshold
  if (mapping.thresholdOn) {
    const outside = value < mapping.threshMin || value > mapping.threshMax;
    const visible = mapping.thresholdTest === 'show_outside' ? outside : !outside;
    if (!visible) return [0, 0, 0, 0];
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
    const range = mapping.negMax - mapping.negMin;  // both negative
    norm = range !== 0 ? (value - mapping.negMin) / range : -1;
    norm = Math.max(-1, Math.min(0, norm));
  } else {
    return [0, 0, 0, 0];
  }
  // 4. Interpolate palette
  return interpolatePalette(norm, points, mapping.interpolate);
}
```

### UI / controls (`gui.ts`)

Use `lil-gui` for the control panel:

```typescript
import GUI from 'lil-gui';

const gui = new GUI({ title: 'Brain Viewer' });
const state = {
  overlay: overlayNames[0],
  hemisphere: 'left',
  thresholdMin: 0,
  thresholdMax: 0,
  thresholdOn: false,
  posMin: 0, posMax: 1,
  negMin: 0, negMax: -1,
  view: 'lateral_left',
};

gui.add(state, 'overlay', overlayNames).onChange(loadAndRender);
gui.add(state, 'hemisphere', ['left', 'right']).onChange(loadSurface);
gui.add(state, 'thresholdOn').onChange(rerenderColors);
gui.add(state, 'thresholdMin').onChange(rerenderColors);
gui.add(state, 'thresholdMax').onChange(rerenderColors);
gui.add(state, 'posMin').onChange(rerenderColors);
gui.add(state, 'posMax').onChange(rerenderColors);
gui.add(state, 'view', Object.keys(VIEW_PRESETS)).onChange(applyPreset);
```

---

## Critical gotchas

1. **CIFTI requires a temp file** — `nib.load(BytesIO(...))` fails for CIFTI. Write to disk first.
2. **Medial wall is NaN** — reconstruct full vertex array with `np.full(n_surf, np.nan)`, insert values at `model.vertex`. NaN → render as base gray or transparent.
3. **Use Uint32Array for faces** — 32k vertices exceeds Uint16 max (65,535). Wrong type = corrupt mesh.
4. **Call `computeVertexNormals()` after setting position + index** — before this call, lighting is broken.
5. **Don't recreate BufferAttribute on color update** — mutate the typed array and set `needsUpdate = true`.
6. **Positive/negative display ranges are independent** — do not use a single symmetric range.
7. **Threshold ≠ display range** — threshold hides vertices; display range controls color mapping. Both are needed.
8. **CIFTI axis order varies** — always check `isinstance(ax, nib.cifti2.BrainModelAxis)` rather than assuming axis index.
9. **Verify ROY-BIG-BL values** — check against [PaletteDefaults.cxx](https://github.com/Washington-University/workbench/blob/master/src/Palette/PaletteDefaults.cxx) for exact RGB values.

---

## `requirements.txt`

```
fastapi>=0.110.0
uvicorn[standard]>=0.29.0
nibabel>=5.2.0
numpy>=1.26.0
```

## npm dependencies

```json
{
  "dependencies": { "three": "^0.164.0", "lil-gui": "^0.19.0" },
  "devDependencies": { "@types/three": "^0.164.0", "vite": "^5.0.0", "typescript": "^5.4.0" }
}
```
