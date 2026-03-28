"""FastAPI server for Brain Surface Viewer.

Parses a zip archive of HCP/Connectome Workbench files on startup
and serves surfaces and overlays as binary data.

Usage:
    python server.py path/to/data.zip [--host HOST] [--port PORT]
"""

from __future__ import annotations

import argparse
import csv
import html as html_mod
import io
import os
import re
import struct
import tempfile
import threading
import time
import webbrowser
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from typing import Any

import nibabel as nib
import nibabel.cifti2
import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles

# ---------- In-memory data store ----------

surfaces: dict[str, dict[str, Any]] = {}       # hemisphere -> {vertices, faces}
overlays: dict[str, dict[str, Any]] = {}        # name -> {data, min, max}
label_tables: dict[str, list[dict]] = {}        # name -> [{key, name, rgba}]
label_indices: dict[str, np.ndarray] = {}       # name -> int32 array
volume_overlays: dict[str, dict[str, Any]] = {} # name -> {volume, dims, affine, min, max}
underlay_volume: dict[str, Any] = {}            # single anatomical underlay volume
manifest_data: dict[str, Any] = {}
scene_settings: dict[str, Any] = {}             # parsed scene palette/threshold info

# CAB-NP parcellation data
cabnp_parcels: dict[str, np.ndarray] = {}          # hemi -> int32 parcel IDs (dense, nV)
cabnp_boundaries: dict[str, np.ndarray] = {}       # hemi -> uint8 boundary mask (dense, nV)
cabnp_full_boundaries: dict[str, np.ndarray] = {}  # hemi -> uint8 both-sides boundary mask
cabnp_network_colors: dict[str, list[float]] = {}  # network_name -> [R, G, B] (0-1 floats)
cabnp_parcel_network: dict[int, str] = {}          # parcel KEYVALUE -> network_name
cabnp_selected: dict[str, list[int]] = {}          # contrast -> list of selected parcel IDs

# ---------- Hemisphere detection ----------

_HEMI_PATTERNS = [
    (re.compile(r'\.L\.', re.IGNORECASE), 'left'),
    (re.compile(r'\.R\.', re.IGNORECASE), 'right'),
    (re.compile(r'\blh\.', re.IGNORECASE), 'left'),
    (re.compile(r'\brh\.', re.IGNORECASE), 'right'),
    (re.compile(r'\bleft\b', re.IGNORECASE), 'left'),
    (re.compile(r'\bright\b', re.IGNORECASE), 'right'),
]


def detect_hemisphere(filename: str) -> str | None:
    for pattern, hemi in _HEMI_PATTERNS:
        if pattern.search(filename):
            return hemi
    return None


# ---------- Parsing ----------

def parse_gifti_surface(data: bytes, hemisphere: str) -> None:
    fh = nib.FileHolder(fileobj=io.BytesIO(data))
    gii = nib.GiftiImage.from_file_map({'image': fh})
    vertices = gii.darrays[0].data.astype('float32')
    faces = gii.darrays[1].data.astype('int32')
    surfaces[hemisphere] = {'vertices': vertices, 'faces': faces}


def parse_gifti_overlay(data: bytes, filename: str, hemisphere: str) -> None:
    fh = nib.FileHolder(fileobj=io.BytesIO(data))
    gii = nib.GiftiImage.from_file_map({'image': fh})
    base = Path(filename).stem.split('.')[0]
    for i, da in enumerate(gii.darrays):
        scalars = da.data.astype('float32')
        name = f"{base}_map{i}" if len(gii.darrays) > 1 else base
        key = f"{name}_{hemisphere}"
        finite = scalars[np.isfinite(scalars)]
        overlays[key] = {
            'data': scalars,
            'min': float(finite.min()) if len(finite) > 0 else 0.0,
            'max': float(finite.max()) if len(finite) > 0 else 1.0,
            'name': name,
            'hemisphere': hemisphere,
            'type': 'func' if filename.endswith('.func.gii') else 'shape',
        }


def parse_cifti_scalar(zip_data: bytes, filename: str, fallback_name: str | None = None) -> None:
    with tempfile.NamedTemporaryFile(suffix='.nii', delete=False) as tmp:
        tmp.write(zip_data)
        tmp_path = tmp.name
    try:
        img = nib.load(tmp_path)
        data = np.asarray(img.dataobj, dtype='float32')

        bm_axis = None
        bm_axis_idx = -1
        for axis_idx in [0, 1]:
            ax = img.header.get_axis(axis_idx)
            if isinstance(ax, nib.cifti2.BrainModelAxis):
                bm_axis = ax
                bm_axis_idx = axis_idx
                break

        if bm_axis is None:
            return

        other_axis = img.header.get_axis(1 - bm_axis_idx)
        if hasattr(other_axis, 'name') and len(list(other_axis.name)) > 0:
            map_names = list(other_axis.name)
        elif fallback_name:
            map_names = [f"{fallback_name}_t{i}" if data.shape[0] > 1 else fallback_name
                         for i in range(data.shape[0])]
        else:
            map_names = [f'map_{i}' for i in range(data.shape[0])]

        subcort_ijk: dict[int, list[np.ndarray]] = {}
        subcort_vals: dict[int, list[np.ndarray]] = {}
        vol_shape = None
        vol_affine = None

        for struct_name, indices, model in bm_axis.iter_structures():
            sname = str(struct_name)
            if 'CORTEX' in sname:
                hemi = 'left' if 'LEFT' in sname else 'right'
                vtx_idx = model.vertex
                n_surf = model.nvertices[struct_name]

                for mi, mname in enumerate(map_names):
                    full = np.full(n_surf, np.nan, dtype='float32')
                    full[vtx_idx] = data[mi, indices]
                    full[np.abs(full) > 1e30] = np.nan
                    key = f"{mname}_{hemi}"
                    finite = full[np.isfinite(full)]
                    overlays[key] = {
                        'data': full,
                        'min': float(finite.min()) if len(finite) > 0 else 0.0,
                        'max': float(finite.max()) if len(finite) > 0 else 1.0,
                        'name': mname,
                        'hemisphere': hemi,
                        'type': 'scalar',
                    }
            else:
                if vol_shape is None:
                    vol_shape = bm_axis.volume_shape
                    vol_affine = bm_axis.affine
                vox_ijk = model.voxel
                for mi in range(len(map_names)):
                    if mi not in subcort_ijk:
                        subcort_ijk[mi] = []
                        subcort_vals[mi] = []
                    subcort_ijk[mi].append(vox_ijk)
                    subcort_vals[mi].append(data[mi, indices].astype('float32'))

        if vol_shape is not None and vol_affine is not None:
            for mi, mname in enumerate(map_names):
                if mi not in subcort_ijk:
                    continue
                all_ijk = np.concatenate(subcort_ijk[mi], axis=0)
                all_vals = np.concatenate(subcort_vals[mi], axis=0)
                all_vals[np.abs(all_vals) > 1e30] = np.nan
                vol = np.full(vol_shape, np.nan, dtype='float32')
                vol[all_ijk[:, 0], all_ijk[:, 1], all_ijk[:, 2]] = all_vals
                finite = all_vals[np.isfinite(all_vals)]
                key = f"{mname}_subcortical"
                volume_overlays[key] = {
                    'volume': vol,
                    'dims': list(vol_shape),
                    'affine': vol_affine.astype('float64'),
                    'min': float(finite.min()) if len(finite) > 0 else 0.0,
                    'max': float(finite.max()) if len(finite) > 0 else 1.0,
                    'name': mname,
                }
    finally:
        os.unlink(tmp_path)


def parse_cifti_label(zip_data: bytes, filename: str) -> None:
    with tempfile.NamedTemporaryFile(suffix='.nii', delete=False) as tmp:
        tmp.write(zip_data)
        tmp_path = tmp.name
    try:
        img = nib.load(tmp_path)
        data = np.asarray(img.dataobj, dtype='float32')

        bm_axis = None
        bm_axis_idx = -1
        for axis_idx in [0, 1]:
            ax = img.header.get_axis(axis_idx)
            if isinstance(ax, nib.cifti2.BrainModelAxis):
                bm_axis = ax
                bm_axis_idx = axis_idx
                break

        if bm_axis is None:
            return

        label_axis = img.header.get_axis(1 - bm_axis_idx)

        for struct_name, indices, model in bm_axis.iter_structures():
            sname = str(struct_name)
            if 'CORTEX' not in sname:
                continue
            hemi = 'left' if 'LEFT' in sname else 'right'
            vtx_idx = model.vertex
            n_surf = model.nvertices[struct_name]

            for mi, (mname, ldict) in enumerate(zip(label_axis.name, label_axis.label)):
                table = [
                    {'key': int(k), 'name': v[0], 'rgba': list(v[1])}
                    for k, v in ldict.items()
                ]
                lbl_key = f"{mname}_{hemi}"
                label_tables[lbl_key] = table

                full = np.full(n_surf, 0, dtype='int32')
                full[vtx_idx] = data[mi, indices].astype('int32')
                label_indices[lbl_key] = full
    finally:
        os.unlink(tmp_path)


def parse_nifti_volume(zip_data: bytes, filename: str) -> None:
    suffix = '.nii.gz' if filename.endswith('.nii.gz') else '.nii'
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(zip_data)
        tmp_path = tmp.name
    try:
        img = nib.load(tmp_path)
        vol = np.asarray(img.dataobj, dtype='float32')
        if vol.ndim != 3:
            return
        affine = img.affine.astype('float64')
        finite = vol[np.isfinite(vol) & (vol != 0)]
        underlay_volume['volume'] = vol
        underlay_volume['dims'] = list(vol.shape)
        underlay_volume['affine'] = affine
        underlay_volume['min'] = float(finite.min()) if len(finite) > 0 else 0.0
        underlay_volume['max'] = float(finite.max()) if len(finite) > 0 else 1.0
    finally:
        os.unlink(tmp_path)


def parse_scene_file(data: bytes) -> None:
    """Parse a .scene XML file to extract palette/threshold settings.

    Workbench scene files contain PaletteColorMapping blocks as HTML-escaped
    XML inside Object elements. We extract the first scene's settings.
    """
    text = data.decode('utf-8', errors='replace')
    decoded = html_mod.unescape(text)

    scenes: list[dict[str, Any]] = []

    # Parse the XML to get scene names
    try:
        root = ET.fromstring(text)
    except ET.ParseError:
        return

    scene_names = []
    for scene_el in root.findall('.//Scene'):
        name_el = scene_el.find('Name')
        scene_names.append(name_el.text if name_el is not None else f"Scene {len(scene_names)}")

    # Extract PaletteColorMapping blocks from decoded text
    pcm_pattern = re.compile(
        r'<PaletteColorMapping\s+Version="[^"]*">(.*?)</PaletteColorMapping>',
        re.DOTALL
    )
    pcm_match = pcm_pattern.search(decoded)
    if not pcm_match:
        return

    inner = pcm_match.group(1)

    def _extract_tag(tag: str, default: str = '') -> str:
        m = re.search(rf'<{tag}>(.*?)</{tag}>', inner)
        return m.group(1) if m else default

    scale_mode = _extract_tag('ScaleMode', 'MODE_AUTO_SCALE')
    user_scale = _extract_tag('UserScaleValues', '0 0 0 0')
    palette_name = _extract_tag('PaletteName', 'ROY-BIG-BL')
    interpolate = _extract_tag('InterpolatePalette', 'true')
    display_positive = _extract_tag('DisplayPositiveData', 'true')
    display_zero = _extract_tag('DisplayZeroData', 'false')
    display_negative = _extract_tag('DisplayNegativeData', 'true')
    threshold_test = _extract_tag('ThresholdTest', 'THRESHOLD_TEST_SHOW_OUTSIDE')
    threshold_type = _extract_tag('ThresholdType', 'THRESHOLD_TYPE_OFF')
    threshold_normal = _extract_tag('ThresholdNormalValues', '0 0')
    threshold_range_mode = _extract_tag('ThresholdRangeMode', 'PALETTE_THRESHOLD_RANGE_MODE_MAP')

    # Parse UserScaleValues: "negMax negMin posMin posMax"
    scale_parts = [float(x) for x in user_scale.split()]
    neg_max, neg_min, pos_min, pos_max = scale_parts[0], scale_parts[1], scale_parts[2], scale_parts[3]

    # Parse ThresholdNormalValues: "low high"
    thresh_parts = [float(x) for x in threshold_normal.split()]
    thresh_min, thresh_max = thresh_parts[0], thresh_parts[1]

    # Find threshold file if THRESHOLD_TYPE_FILE
    thresh_file = None
    if threshold_type == 'THRESHOLD_TYPE_FILE':
        # Look for the threshold file selection model
        thresh_file_match = re.search(
            r'm_mapThresholdFileSelectionModels.*?selectedFileNameNoPath[^>]*>([^<]+)',
            decoded, re.DOTALL
        )
        if thresh_file_match:
            thresh_file = thresh_file_match.group(1)

    scene_settings['scenes'] = scene_names
    scene_settings['palette'] = {
        'name': palette_name,
        'scaleMode': scale_mode,
        'posMin': pos_min,
        'posMax': pos_max,
        'negMin': neg_min,
        'negMax': neg_max,
        'interpolate': interpolate == 'true',
        'displayPositive': display_positive == 'true',
        'displayZero': display_zero == 'true',
        'displayNegative': display_negative == 'true',
    }
    scene_settings['threshold'] = {
        'test': threshold_test,
        'type': threshold_type,
        'min': thresh_min,
        'max': thresh_max,
        'rangeMode': threshold_range_mode,
        'thresholdFile': thresh_file,
    }


def compute_boundaries(faces: np.ndarray, parcels: np.ndarray) -> np.ndarray:
    """Mark vertices at parcel boundaries using face connectivity.

    For thinner boundaries, only the vertex with the *higher* parcel ID
    on each cross-boundary edge is marked. This produces single-vertex-wide
    outlines instead of marking both sides of every boundary edge.
    """
    boundary = np.zeros(len(parcels), dtype='uint8')
    p0 = parcels[faces[:, 0]]
    p1 = parcels[faces[:, 1]]
    p2 = parcels[faces[:, 2]]

    diff_01 = p0 != p1
    diff_12 = p1 != p2
    diff_02 = p0 != p2

    # For each boundary edge, mark only the higher-parcel-ID vertex
    v0_01 = faces[diff_01, 0]
    v1_01 = faces[diff_01, 1]
    pick_01 = np.where(p0[diff_01] > p1[diff_01], v0_01, v1_01)
    boundary[pick_01] = 1

    v1_12 = faces[diff_12, 1]
    v2_12 = faces[diff_12, 2]
    pick_12 = np.where(p1[diff_12] > p2[diff_12], v1_12, v2_12)
    boundary[pick_12] = 1

    v0_02 = faces[diff_02, 0]
    v2_02 = faces[diff_02, 2]
    pick_02 = np.where(p0[diff_02] > p2[diff_02], v0_02, v2_02)
    boundary[pick_02] = 1

    return boundary


def compute_full_boundaries(faces: np.ndarray, parcels: np.ndarray) -> np.ndarray:
    """Mark ALL vertices adjacent to a parcel boundary (both sides of each edge)."""
    boundary = np.zeros(len(parcels), dtype='uint8')
    p0 = parcels[faces[:, 0]]
    p1 = parcels[faces[:, 1]]
    p2 = parcels[faces[:, 2]]
    diff_01 = p0 != p1
    diff_12 = p1 != p2
    diff_02 = p0 != p2
    boundary[faces[diff_01, 0]] = 1
    boundary[faces[diff_01, 1]] = 1
    boundary[faces[diff_12, 1]] = 1
    boundary[faces[diff_12, 2]] = 1
    boundary[faces[diff_02, 0]] = 1
    boundary[faces[diff_02, 2]] = 1
    return boundary


def parse_cabnp(cabnp_dir: Path) -> None:
    """Load CAB-NP parcellation, network colors, and selected parcels."""
    parcels_file = cabnp_dir / 'CortexSubcortex_ColeAnticevic_NetPartition_wSubcorGSR_parcels_LR.dlabel.nii'
    network_file = cabnp_dir / 'network_labelfile.txt'
    labelkey_file = cabnp_dir / 'CortexSubcortex_ColeAnticevic_NetPartition_wSubcorGSR_parcels_LR_LabelKey.txt'
    selected_file = cabnp_dir.parent / 'included_parcels.csv'

    if not parcels_file.exists():
        return

    # Load parcels dlabel.nii
    with tempfile.NamedTemporaryFile(suffix='.dlabel.nii', delete=False) as tmp:
        tmp.write(parcels_file.read_bytes())
        tmp_path = tmp.name
    try:
        img = nib.load(tmp_path)
        data = np.asarray(img.dataobj, dtype='float32')

        bm_axis = None
        for axis_idx in [0, 1]:
            ax = img.header.get_axis(axis_idx)
            if isinstance(ax, nib.cifti2.BrainModelAxis):
                bm_axis = ax
                break
        if bm_axis is None:
            raise ValueError("CAB-NP dlabel.nii has no BrainModelAxis")

        for struct_name, indices, model in bm_axis.iter_structures():
            sname = str(struct_name)
            if 'CORTEX' not in sname:
                continue
            hemi = 'left' if 'LEFT' in sname else 'right'
            vtx_idx = model.vertex
            n_surf = model.nvertices[struct_name]
            full = np.zeros(n_surf, dtype='int32')
            full[vtx_idx] = data[0, indices].astype('int32')
            cabnp_parcels[hemi] = full
    finally:
        os.unlink(tmp_path)

    # Parse network colors
    if network_file.exists():
        lines = network_file.read_text().strip().split('\n')
        for i in range(0, len(lines) - 1, 2):
            name = lines[i].strip()
            parts = lines[i + 1].strip().split()
            if len(parts) >= 4:
                r, g, b = int(parts[1]), int(parts[2]), int(parts[3])
                cabnp_network_colors[name] = [r / 255.0, g / 255.0, b / 255.0]

    # Parse label key: parcel KEYVALUE -> network name
    if labelkey_file.exists():
        text = labelkey_file.read_text()
        for line in text.strip().split('\n'):
            parts = line.split('\t')
            if len(parts) >= 9:
                try:
                    keyval = int(parts[1])
                    network = parts[8]
                    cabnp_parcel_network[keyval] = network
                except (ValueError, IndexError):
                    continue

    # Parse selected parcels (prop > 0.5)
    if selected_file.exists():
        with open(selected_file) as f:
            reader = csv.DictReader(f)
            for row in reader:
                prop = float(row['prop'])
                if prop <= 0.5:
                    continue
                contrast = row['contrast']
                parcel_id = int(row['parcel'])
                if contrast not in cabnp_selected:
                    cabnp_selected[contrast] = []
                cabnp_selected[contrast].append(parcel_id)


def _derive_overlay_name(zip_entry: str) -> str:
    """Derive a human-readable overlay name from the zip entry path.

    For files like GUESSING/CUE_AVG/swe_dpx_zTstat_c01.dtseries.nii,
    combines parent dir + stem: 'CUE_AVG/swe_dpx_zTstat_c01'.
    """
    parts = Path(zip_entry).parts
    stem = Path(zip_entry).stem
    if stem.endswith('.dtseries'):
        stem = stem[:-len('.dtseries')]
    if len(parts) >= 3:
        return f"{parts[-2]}/{stem}"
    return stem


def parse_zip(zip_path: str) -> None:
    with zipfile.ZipFile(zip_path, 'r') as zf:
        for entry in zf.namelist():
            if entry.endswith('/'):
                continue
            basename = Path(entry).name
            raw = zf.read(entry)

            if basename.endswith('.surf.gii'):
                hemi = detect_hemisphere(basename)
                if hemi:
                    parse_gifti_surface(raw, hemi)

            elif basename.endswith('.func.gii') or basename.endswith('.shape.gii'):
                hemi = detect_hemisphere(basename)
                if hemi:
                    parse_gifti_overlay(raw, basename, hemi)

            elif basename.endswith('.dscalar.nii'):
                parse_cifti_scalar(raw, basename)

            elif basename.endswith('.dtseries.nii'):
                name = _derive_overlay_name(entry)
                parse_cifti_scalar(raw, basename, fallback_name=name)

            elif basename.endswith('.dlabel.nii'):
                parse_cifti_label(raw, basename)

            elif basename.endswith('.scene'):
                parse_scene_file(raw)

            elif basename.endswith('.nii.gz') or (
                basename.endswith('.nii') and not any(
                    basename.endswith(ext) for ext in
                    ('.dscalar.nii', '.dtseries.nii', '.dlabel.nii')
                )
            ):
                parse_nifti_volume(raw, basename)

    # Build manifest
    manifest_data['surfaces'] = [
        {'hemisphere': h} for h in sorted(surfaces.keys())
    ]
    manifest_data['overlays'] = [
        {'name': v['name'], 'hemisphere': v['hemisphere'], 'type': v['type']}
        for v in overlays.values()
    ]
    manifest_data['labels'] = [
        {'name': k.rsplit('_', 1)[0], 'hemisphere': k.rsplit('_', 1)[1]}
        for k in label_tables.keys()
    ]
    manifest_data['volumes'] = [
        {'name': v['name']}
        for v in volume_overlays.values()
    ]
    manifest_data['hasUnderlay'] = bool(underlay_volume)


# ---------- FastAPI app ----------

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET"],
    allow_headers=["*"],
    expose_headers=["X-Data-Min", "X-Data-Max"],
)


@app.get("/api/manifest")
def get_manifest() -> JSONResponse:
    return JSONResponse(content=manifest_data)


@app.get("/api/scene-settings")
def get_scene_settings() -> JSONResponse:
    return JSONResponse(content=scene_settings)


@app.get("/api/surface/{hemisphere}")
def get_surface(hemisphere: str) -> Response:
    if hemisphere not in surfaces:
        raise HTTPException(status_code=404, detail=f"Surface '{hemisphere}' not found")
    surf = surfaces[hemisphere]
    vertices: np.ndarray = surf['vertices']
    faces: np.ndarray = surf['faces']
    n_v = vertices.shape[0]
    n_f = faces.shape[0]
    header = struct.pack('<II', n_v, n_f)
    body = header + vertices.tobytes() + faces.tobytes()
    return Response(content=body, media_type="application/octet-stream")


@app.get("/api/overlay/{name:path}")
def get_overlay(name: str) -> Response:
    if name not in overlays:
        raise HTTPException(status_code=404, detail=f"Overlay '{name}' not found")
    ov = overlays[name]
    return Response(
        content=ov['data'].tobytes(),
        media_type="application/octet-stream",
        headers={
            'X-Data-Min': str(ov['min']),
            'X-Data-Max': str(ov['max']),
        },
    )


@app.get("/api/underlay")
def get_underlay() -> Response:
    if not underlay_volume:
        raise HTTPException(status_code=404, detail="No anatomical underlay available")
    vol = underlay_volume
    di, dj, dk = vol['dims']
    affine_3x4 = vol['affine'][:3, :4].astype('float64')
    header = struct.pack('<III', di, dj, dk) + affine_3x4.tobytes()
    body = header + vol['volume'].tobytes()
    return Response(
        content=body,
        media_type="application/octet-stream",
        headers={
            'X-Data-Min': str(vol['min']),
            'X-Data-Max': str(vol['max']),
        },
    )


@app.get("/api/volume/{name:path}")
def get_volume(name: str) -> Response:
    if name not in volume_overlays:
        raise HTTPException(status_code=404, detail=f"Volume '{name}' not found")
    vol = volume_overlays[name]
    di, dj, dk = vol['dims']
    affine_3x4 = vol['affine'][:3, :4].astype('float64')
    header = struct.pack('<III', di, dj, dk) + affine_3x4.tobytes()
    body = header + vol['volume'].tobytes()
    return Response(
        content=body,
        media_type="application/octet-stream",
        headers={
            'X-Data-Min': str(vol['min']),
            'X-Data-Max': str(vol['max']),
        },
    )


@app.get("/api/labels/{name:path}/table")
def get_labels(name: str) -> JSONResponse:
    if name not in label_tables:
        raise HTTPException(status_code=404, detail=f"Label table '{name}' not found")
    return JSONResponse(content=label_tables[name])


@app.get("/api/labels/{name:path}/indices")
def get_label_indices(name: str) -> Response:
    if name not in label_indices:
        raise HTTPException(status_code=404, detail=f"Label indices '{name}' not found")
    return Response(
        content=label_indices[name].tobytes(),
        media_type="application/octet-stream",
    )


# ---------- CAB-NP endpoints ----------

@app.get("/api/cabnp/boundaries/{hemisphere}")
def get_cabnp_boundaries(hemisphere: str) -> Response:
    if hemisphere not in cabnp_boundaries:
        raise HTTPException(status_code=404, detail=f"CAB-NP boundaries for '{hemisphere}' not found")
    return Response(
        content=cabnp_boundaries[hemisphere].tobytes(),
        media_type="application/octet-stream",
    )


@app.get("/api/cabnp/parcels/{hemisphere}")
def get_cabnp_parcels(hemisphere: str) -> Response:
    if hemisphere not in cabnp_parcels:
        raise HTTPException(status_code=404, detail=f"CAB-NP parcels for '{hemisphere}' not found")
    return Response(
        content=cabnp_parcels[hemisphere].tobytes(),
        media_type="application/octet-stream",
    )


@app.get("/api/cabnp/full-boundaries/{hemisphere}")
def get_cabnp_full_boundaries(hemisphere: str) -> Response:
    if hemisphere not in cabnp_full_boundaries:
        raise HTTPException(status_code=404, detail=f"CAB-NP full boundaries for '{hemisphere}' not found")
    return Response(
        content=cabnp_full_boundaries[hemisphere].tobytes(),
        media_type="application/octet-stream",
    )


@app.get("/api/cabnp/selected/{contrast}")
def get_cabnp_selected(contrast: str) -> JSONResponse:
    parcel_ids = cabnp_selected.get(contrast, [])
    networks: dict[str, str] = {}
    for pid in parcel_ids:
        if pid in cabnp_parcel_network:
            networks[str(pid)] = cabnp_parcel_network[pid]
    return JSONResponse(content={
        'parcels': parcel_ids,
        'networks': networks,
        'network_colors': cabnp_network_colors,
    })


# Mount static frontend if built (skipped in --dev mode)
_mount_static = True  # overridden in main() when --dev is passed
dist_dir = Path(__file__).parent / "dist"


def _maybe_mount_static() -> None:
    if _mount_static and dist_dir.exists():
        app.mount("/", StaticFiles(directory=str(dist_dir), html=True), name="static")


# ---------- CLI ----------

def main() -> None:
    parser = argparse.ArgumentParser(description="Brain Surface Viewer server")
    parser.add_argument("zipfile", help="Path to zip archive with brain data")
    parser.add_argument("--host", default="127.0.0.1", help="Host to bind to")
    parser.add_argument("--port", type=int, default=8421, help="Port to bind to")
    parser.add_argument("--no-browser", action="store_true", help="Don't auto-open browser")
    parser.add_argument("--dev", action="store_true", help="Dev mode: don't mount dist/, open localhost:3000")
    args = parser.parse_args()

    if not Path(args.zipfile).exists():
        parser.error(f"File not found: {args.zipfile}")

    if args.dev:
        global _mount_static
        _mount_static = False

    print(f"Parsing {args.zipfile}...")
    parse_zip(args.zipfile)
    print(f"  Surfaces: {list(surfaces.keys())}")
    print(f"  Overlays: {list(overlays.keys())}")
    print(f"  Labels:   {list(label_tables.keys())}")
    print(f"  Volumes:  {list(volume_overlays.keys())}")

    cabnp_dir = Path(__file__).parent / 'cabnp'
    if cabnp_dir.exists():
        print("Parsing CAB-NP parcellation...")
        parse_cabnp(cabnp_dir)
        for hemi in cabnp_parcels:
            if hemi in surfaces:
                faces = surfaces[hemi]['faces']
                cabnp_boundaries[hemi] = compute_boundaries(faces, cabnp_parcels[hemi])
                cabnp_full_boundaries[hemi] = compute_full_boundaries(faces, cabnp_parcels[hemi])
        print(f"  CAB-NP parcels: {list(cabnp_parcels.keys())}")
        print(f"  CAB-NP boundaries: {list(cabnp_boundaries.keys())}")
        print(f"  CAB-NP contrasts: {len(cabnp_selected)}")
        manifest_data['cabnp'] = {
            'available': bool(cabnp_parcels),
            'contrasts': sorted(cabnp_selected.keys()),
        }

    _maybe_mount_static()

    if not args.no_browser:
        url = "http://localhost:3000" if args.dev else f"http://{args.host}:{args.port}"
        threading.Thread(
            target=lambda: (time.sleep(1.0), webbrowser.open(url)),
            daemon=True,
        ).start()

    if args.dev:
        print("Dev mode: frontend served by Vite at http://localhost:3000")
        print("  Run in a separate terminal: cd frontend && npm run dev")

    import uvicorn
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
