# wb-scene-viewer

Interactive web-based viewer for HCP/Connectome Workbench brain surface data. Load a zip archive of group-level neuroimaging results and explore scalar maps, parcellations, cluster overlays, and subcortical volumes in the browser — no data leaves your machine.

## Features

- **Dual-hemisphere 3D rendering** — Left and right cortical surfaces displayed side by side with synchronized (yoked) rotation, zoom, and pan
- **Subcortical slice viewer** — Axial, sagittal, and coronal slices of subcortical volume data with anatomical underlay, rendered in a 2D canvas
- **Multiple overlay types** — CIFTI scalar maps (`.dscalar.nii`), dense time series (`.dtseries.nii`), parcellations (`.dlabel.nii`), and GIFTI surface metrics (`.func.gii`, `.shape.gii`)
- **Statistics and cluster toggle** — Switch between statistical maps and thresholded cluster maps for any contrast with one click
- **CAB-NP parcellation overlay** — Cole-Anticevic Brain-wide Network Parcellation boundaries and network-colored selected parcels, with configurable fill/outline mode and opacity
- **Workbench-faithful colormapping** — ROY-BIG-BL and PSYCH-FIXED palettes with independent positive/negative display ranges, threshold controls, and file-based thresholding
- **Scene file support** — Parses `.scene` files from Connectome Workbench to import palette, scale, and threshold settings automatically
- **Per-overlay histograms** — Live histograms for left hemisphere, right hemisphere, and subcortical data that update with threshold changes
- **Network legend** — Color-coded network labels when viewing selected CAB-NP parcels
- **Single-command deployment** — Serve locally or deploy to a remote server behind nginx

## Screenshots

*(Coming soon)*

## Requirements

- **Python 3.10+** with pip
- **Node.js 18+** with npm
- A zip archive containing HCP/Workbench output files (see [Input Data](#input-data) below)

## Quick Start

### Install dependencies

```bash
pip install -r requirements.txt
cd frontend && npm install && cd ..
```

### Run (production mode)

Build the frontend once, then run the Python server:

```bash
cd frontend && npm run build && cd ..
python server.py path/to/your/results.zip
```

The browser opens automatically at `http://127.0.0.1:8421`.

### Run (development mode with hot reload)

```bash
# Terminal 1 — Python API server
python server.py data.zip --dev

# Terminal 2 — Vite dev server (hot reload, proxies /api to :8421)
cd frontend && npm run dev
# Open http://localhost:3000
```

### Share on your local network

```bash
python server.py data.zip --host 0.0.0.0
# Colleagues open http://your-ip:8421
```

### CLI options

| Flag | Default | Description |
|------|---------|-------------|
| `zipfile` | *(required)* | Path to zip archive with brain data |
| `--host` | `127.0.0.1` | Host to bind to |
| `--port` | `8421` | Port to bind to |
| `--no-browser` | off | Don't auto-open browser on startup |
| `--dev` | off | Dev mode: skip mounting `dist/`, open Vite URL instead |

## Input Data

The zip archive can contain any combination of the following files. Hemisphere is auto-detected from filenames (`.L.`/`.R.`, `lh`/`rh`, `left`/`right`).

| File type | Extension | Description |
|-----------|-----------|-------------|
| Surface mesh | `.surf.gii` | GIFTI surface with vertices and triangular faces (e.g., `S900.L.midthickness.32k_fs_LR.surf.gii`) |
| Scalar map | `.dscalar.nii` | CIFTI dense scalar — t-statistics, beta weights, etc. |
| Dense time series | `.dtseries.nii` | CIFTI dense time series — overlay names derived from directory structure |
| Parcellation | `.dlabel.nii` | CIFTI label file with integer keys and embedded RGBA label table |
| Functional overlay | `.func.gii` | GIFTI functional/statistical surface map |
| Morphometric overlay | `.shape.gii` | GIFTI shape data (e.g., cortical thickness, curvature) |
| Anatomical volume | `.nii.gz` / `.nii` | NIfTI volume used as subcortical underlay |
| Scene settings | `.scene` | Connectome Workbench scene file — palette and threshold presets are imported |

Example zip structure:

```
results.zip
├── S900.L.midthickness.32k_fs_LR.surf.gii
├── S900.R.midthickness.32k_fs_LR.surf.gii
├── MNI152_T1_2mm.nii.gz                      # anatomical underlay
├── guessing.scene                             # scene file with display settings
├── GUESSING/
│   ├── CUE_AVG/
│   │   ├── swe_dpx_zTstat_c01.dtseries.nii   # statistical map
│   │   └── swe_dpx_zTstat_c01_clust.dtseries.nii  # thresholded clusters
│   └── FEEDBACK_HIGH_LOW_WIN/
│       ├── swe_dpx_zTstat_c01.dtseries.nii
│       └── swe_dpx_zTstat_c01_clust.dtseries.nii
```

## Interface Guide

### Layout

The viewer is divided into:

- **Left panel** — Control panel (lil-gui) with overlay selection, threshold/display range controls, parcellation options, and histograms
- **Top-left pane** — Left hemisphere 3D surface
- **Top-right pane** — Right hemisphere 3D surface
- **Bottom pane** — Subcortical slice viewer (axial, sagittal, coronal)

### Controls

| Control | Description |
|---------|-------------|
| **Contrast buttons** | Select which contrast to display (e.g., Cue Avg, Feedback High Low Win) |
| **Statistics / Clusters** | Toggle between the statistical map and its thresholded cluster map |
| **Threshold > Enabled** | Apply symmetric threshold (hides vertices inside threshold range) |
| **Threshold > Pos/Neg Thresh** | Set positive and negative threshold values independently |
| **Display Range** | Set positive and negative color scale ranges (Pos Min/Max, Neg Min/Max) |
| **CAB-NP Parcels > Boundaries** | Show thin parcel boundary lines on the cortical surface |
| **CAB-NP Parcels > Selected Parcels** | Highlight parcels that overlap with the current contrast's clusters |
| **CAB-NP Parcels > Mode** | Choose `outline` (boundaries only) or `fill` (solid parcel color) for selected parcels |
| **CAB-NP Parcels > Strength** | Opacity of the parcel color overlay (0–1) |
| **Yoke Hemispheres** | Mirror rotation/zoom/pan between left and right hemispheres |
| **Scene Info** | Read-only display of imported palette and threshold settings from the `.scene` file |
| **Histograms** | Distribution of overlay values for each region, with threshold lines |

**Mouse interaction:**
- Drag to rotate
- Scroll to zoom
- Right-click drag to pan

### Subcortical Slice Viewer

When subcortical volume data is present in the CIFTI files, the bottom pane shows three orthogonal slices. The overlay colormap and threshold settings apply to the volume data as well. Click on any slice to navigate to that voxel coordinate.

## Colormapping

Follows Connectome Workbench conventions:

- **ROY-BIG-BL** (default) — Positive values: black → dark red → red → orange → yellow. Negative values: black → dark blue → blue → lavender. Zero is transparent.
- **PSYCH-FIXED** — Alternative palette. Positive: red → orange → yellow. Negative: blue → cyan.
- **Independent positive/negative display ranges** — Pos Min/Max and Neg Min/Max are set separately, matching Workbench behavior.
- **Threshold is independent from display range** — Threshold hides vertices; display range controls color mapping. Both are settable independently.
- **File-based thresholding** — When the `.scene` file specifies `THRESHOLD_TYPE_FILE`, the cluster map is used as a visibility mask for the statistical map.
- **Cluster coloring** — Cluster overlays (`_clust` suffix) use discrete colors per cluster ID with white boundary outlines, rather than the continuous colormap.
- **Label overlays** use the RGBA colors embedded in the `.dlabel.nii` file directly.

## CAB-NP Parcellation

The viewer includes support for the [Cole-Anticevic Brain-wide Network Parcellation](https://github.com/ColeLab/ColeAnticevicNetPartition) (CAB-NP). Parcellation files are stored in the `cabnp/` directory:

| File | Description |
|------|-------------|
| `*_parcels_LR.dlabel.nii` | Dense label file mapping each vertex to a parcel ID |
| `*_parcels_LR_LabelKey.txt` | Maps parcel IDs to Glasser atlas ROI names and network assignments |
| `network_labelfile.txt` | Network names and their RGB colors |

### Selected Parcels

The file `included_parcels.csv` defines which CAB-NP parcels are associated with each contrast. Each row maps a contrast + parcel ID to a network and Glasser ROI label, with a `prop` column indicating the proportion of vertices in the parcel that fall within a significant cluster (parcels with `prop > 0.5` are selected).

When viewing a contrast, enabling "Selected Parcels" highlights the relevant parcels using their network colors (e.g., Visual1 = purple, Dorsal-Attention = green, etc.).

## Architecture

### Project Structure

```
wb-scene-viewer/
├── server.py                  # FastAPI backend — parses zip, serves binary data
├── requirements.txt           # Python dependencies
├── included_parcels.csv       # Selected parcels per contrast
├── cabnp/                     # CAB-NP parcellation reference files
├── frontend/
│   ├── index.html             # App shell — 3-pane layout
│   ├── package.json           # Node dependencies
│   ├── vite.config.ts         # Vite config with API proxy
│   ├── tsconfig.json          # TypeScript strict mode
│   └── src/
│       ├── main.ts            # Entry point: init, data loading, render loop
│       ├── scene.ts           # Three.js scene, camera, lights, OrbitControls
│       ├── brain-mesh.ts      # Mesh creation and vertex color updates
│       ├── data-loader.ts     # Fetch wrappers for binary surfaces + overlays
│       ├── colormap.ts        # ROY-BIG-BL / PSYCH-FIXED palettes + threshold logic
│       ├── gui.ts             # lil-gui control panel + histograms
│       ├── slice-viewer.ts    # 2D canvas subcortical slice renderer
│       └── types.ts           # Shared TypeScript interfaces
├── dist/                      # Built frontend (generated by `npm run build`)
└── deploy/                    # Server deployment scripts
    ├── deploy.sh              # Install/update script (run as root)
    ├── rsync-to-server.sh     # Sync from local and optionally deploy
    ├── preflight.sh           # Pre-deploy server checks
    ├── nginx-wb-scene-viewer.conf  # nginx location blocks
    └── wb-scene-viewer.service     # systemd unit file
```

### Backend (Python / FastAPI)

The server parses the entire zip archive on startup and holds all data in memory. No per-request file I/O after initialization.

**API endpoints:**

| Route | Response | Format |
|-------|----------|--------|
| `GET /api/manifest` | File listing and metadata | JSON |
| `GET /api/scene-settings` | Imported palette/threshold settings | JSON |
| `GET /api/surface/{hemisphere}` | Surface mesh | Binary (header + float32 vertices + int32 faces) |
| `GET /api/overlay/{name}` | Scalar overlay | Binary float32 array; min/max in `X-Data-Min`/`X-Data-Max` headers |
| `GET /api/volume/{name}` | Subcortical volume | Binary (header + float32 volume) |
| `GET /api/underlay` | Anatomical underlay volume | Binary (header + float32 volume) |
| `GET /api/labels/{name}/table` | Label color table | JSON |
| `GET /api/labels/{name}/indices` | Per-vertex label indices | Binary int32 array |
| `GET /api/cabnp/parcels/{hemisphere}` | CAB-NP parcel IDs per vertex | Binary int32 array |
| `GET /api/cabnp/boundaries/{hemisphere}` | Thin parcel boundary mask | Binary uint8 array |
| `GET /api/cabnp/full-boundaries/{hemisphere}` | Full (both-sides) boundary mask | Binary uint8 array |
| `GET /api/cabnp/selected/{contrast}` | Selected parcels + network info | JSON |

**Binary surface format:**

```
Bytes 0–3:           uint32 numVertices (little-endian)
Bytes 4–7:           uint32 numFaces (little-endian)
Bytes 8 … 8+N*12:   float32[] vertices (x,y,z interleaved)
Bytes 8+N*12 … end: int32[]  faces (v0,v1,v2 interleaved)
```

### Frontend (TypeScript / Three.js)

Vanilla TypeScript with Three.js — no React, Vue, or other frameworks. The UI control panel uses [lil-gui](https://lil-gui.georgealways.com/).

Key technical details:

- Surfaces are HCP 32k_fs_LR meshes (32,492 vertices per hemisphere)
- CIFTI data is reconstructed from sparse grayordinate representation to full vertex arrays; medial wall vertices render as base gray
- Binary data transfer (raw float32/int32 buffers) keeps overlay loads fast
- Vertex colors are updated in-place on the GPU buffer (`needsUpdate = true`) — no geometry recreation on overlay change
- Parcel boundaries are computed server-side using face adjacency, with single-vertex-wide outlines (higher parcel ID side only) for clean rendering

## Server Deployment (Linode / nginx)

The app can run behind nginx as a subpath (`/viewer`) on an existing server.

### Deployment files

| File | Purpose |
|------|---------|
| `deploy/wb-scene-viewer.service` | systemd unit — runs uvicorn, restarts on crash |
| `deploy/nginx-wb-scene-viewer.conf` | nginx location blocks for the existing server block |
| `deploy/deploy.sh` | Install/update script (run as root on the server) |
| `deploy/rsync-to-server.sh` | Sync from local machine and optionally deploy |
| `deploy/preflight.sh` | Check server state before deploying |

### First-time setup

1. **nginx config** — Add the location blocks from `deploy/nginx-wb-scene-viewer.conf` to the existing `443` server block. Key details:
   - Use `^~` on `/api/` and `/viewer/` to prevent regex cache blocks from intercepting `.js`/`.css` files
   - `/api/` is proxied separately because the frontend uses absolute `/api/` fetch paths
   - Trailing slash on `proxy_pass http://127.0.0.1:8421/` strips the `/viewer/` prefix

2. **Sync and deploy** from your local machine:
   ```bash
   bash deploy/preflight.sh <ssh-host>
   bash deploy/rsync-to-server.sh <ssh-host> --deploy
   ```

### Updating after code changes

```bash
bash deploy/rsync-to-server.sh <ssh-host> --deploy
```

This rebuilds the frontend, reinstalls Python deps, and restarts the service.

### Service management

```bash
sudo systemctl status wb-scene-viewer
sudo systemctl restart wb-scene-viewer
sudo journalctl -u wb-scene-viewer -f
```

## Dependencies

**Python:** `fastapi`, `uvicorn`, `nibabel`, `numpy`

**JavaScript:** `three`, `lil-gui`, `vite`, `typescript`

## License

*(To be determined)*
