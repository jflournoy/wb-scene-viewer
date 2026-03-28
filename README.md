# Brain Surface Viewer

Interactive web-based viewer for HCP/Connectome Workbench surface data. Drop in a zip of your group-level results and explore scalar maps, parcellations, and morphometric overlays in the browser.

## What it does

- Renders left/right hemisphere brain surfaces with per-vertex coloring
- Supports CIFTI scalar maps (`.dscalar.nii`), parcellations (`.dlabel.nii`), and GIFTI surface metrics (`.func.gii`, `.shape.gii`)
- ROY-BIG-BL colormap with faithful Workbench-style threshold and display range controls
- Serve to colleagues with a single command — no data leaves your machine

## What goes in the zip

Any combination of:

```
results.zip
├── S900.L.midthickness.32k_fs_LR.surf.gii   # left surface mesh
├── S900.R.midthickness.32k_fs_LR.surf.gii   # right surface mesh
├── group_contrast.dscalar.nii               # scalar overlay (t-stats, betas, etc.)
├── parcellation.dlabel.nii                  # parcellation with label colors
├── L.thickness.shape.gii                    # morphometric overlay
└── (optional) scene.scene                   # parsed for display settings if present
```

Hemisphere is auto-detected from filenames (`.L.` / `.R.`, `lh` / `rh`, `left` / `right`).

## Setup

**Python (one-time):**
```bash
pip install fastapi uvicorn nibabel numpy
```

**Frontend (one-time):**
```bash
cd frontend && npm install
```

## Usage

### Option A — production (single command)

Build the frontend once, then run only the Python server:

```bash
cd frontend && npm run build && cd ..
python server.py path/to/your/results.zip
# Browser opens automatically at http://127.0.0.1:8421
```

Share with colleagues on your local network:
```bash
python server.py data.zip --host 0.0.0.0
# They open http://your-ip:8421
```

### Option B — development (hot reload)

```bash
# Terminal 1: Python server
python server.py data.zip

# Terminal 2: Vite dev server (hot reload, proxies /api to :8421)
cd frontend && npm run dev
# Open http://localhost:3000
```

## Interface

| Control | Description |
|---------|-------------|
| Overlay | Select which scalar map or parcellation to display |
| Hemisphere | Switch between left / right |
| Threshold on/off | Hide vertices outside threshold range |
| Threshold min/max | Values below min and above max are hidden (show-outside mode) |
| Pos min / Pos max | Display range for positive values → color scale |
| Neg min / Neg max | Display range for negative values → color scale |
| View preset | Lateral, medial, dorsal, ventral, anterior, posterior |

Drag to rotate, scroll to zoom, right-click drag to pan.

## Colormapping

Follows Connectome Workbench conventions exactly:

- **ROY-BIG-BL**: positive values → yellow/orange/red, negative → blue/lavender, zero → transparent
- **Independent positive/negative display ranges**: you can set pos and neg scales separately
- **Threshold ≠ display range**: threshold hides vertices; display range controls color. Both are settable independently
- **Label overlays** use the RGBA colors embedded in the `.dlabel.nii` file directly — no colormap applied

## Technical notes

- Surfaces are standard HCP 32k_fs_LR meshes (32,492 vertices/hemisphere)
- CIFTI data is reconstructed from sparse grayordinate representation to full vertex arrays; medial wall vertices (excluded from CIFTI) render as base gray
- Binary data transfer (raw float32/int32 buffers) keeps overlay loads under 100ms even for large files
- Server holds all parsed data in memory after startup — no per-request file I/O

## Server deployment (Linode / nginx)

The app is designed to run behind nginx as a subpath (`/viewer`) on an existing server.

### Files in `deploy/`

| File | Purpose |
|------|---------|
| `wb-scene-viewer.service` | systemd unit — runs uvicorn, restarts on crash |
| `nginx-wb-scene-viewer.conf` | nginx location blocks to add to the existing `hcpd` server block |
| `deploy.sh` | Install/update script (run as root on the server) |
| `rsync-to-server.sh` | Sync from local machine and optionally deploy |
| `preflight.sh` | Check server state before deploying |

### First-time setup

1. **One-time nginx config** — copy the three `location` blocks from `deploy/nginx-wb-scene-viewer.conf` into the existing `443` server block in `/etc/nginx/sites-enabled/hcpd`. The key details:
   - Use `^~` on both `/api/` and `/viewer/` to prevent the regex cache block from intercepting `.js`/`.css` files
   - `/api/` must be proxied separately because the frontend uses absolute `/api/` fetch paths
   - The trailing slash on `proxy_pass http://127.0.0.1:8421/` strips the `/viewer/` prefix before uvicorn

2. **Sync and deploy** from your local machine:
   ```bash
   bash deploy/preflight.sh <ssh-host>
   bash deploy/rsync-to-server.sh <ssh-host> --deploy
   ```

### Updates

From your local machine after code changes:
```bash
bash deploy/rsync-to-server.sh <ssh-host> --deploy
```

The script rebuilds the frontend, reinstalls Python deps, and restarts the service.

### Service management

```bash
sudo systemctl status wb-scene-viewer
sudo systemctl restart wb-scene-viewer
sudo journalctl -u wb-scene-viewer -f
```

### Roadmap

- [ ] Support pointing the service at a different zip file or an unzipped directory without redeploying

## Dependencies

**Python**: `fastapi`, `uvicorn`, `nibabel`, `numpy`

**JavaScript**: `three`, `lil-gui`, `vite`, `typescript`
