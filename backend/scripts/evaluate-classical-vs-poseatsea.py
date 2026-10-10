#!/usr/bin/env python3
"""
==============================================================================
HEAD-TO-HEAD EVALUATION: CLASSICAL CANDIDATE DETECTOR VS. POSEatSea
==============================================================================
Rigorous comparative benchmark across 6 DARTIS_2019 scenes:
  - 4 Oil Scenes:        ow-0002, ow-0004, ow-0006, oc-0001
  - 2 Look-Alike Scenes: nw-0001, nw-0002

Pipelines compared:
1. Existing Classical Pipeline:
   Sentinel-1 VV + VH -> V2 Minimal Morphology (Closing Only) -> Candidate Clusters
   -> 17-Feature Extraction -> Heuristic Scoring

2. POSEatSea Pretrained Model:
   U-Net + MiT-B2 (5 classes) -> Normalized [VV, VH, VV-VH] -> Argmax segmentation

Evaluation Principles:
- Pascal VOC XML annotations are Bounding Boxes, NOT segmentation masks.
- No pixel-level segmentation IoU is calculated against bounding boxes.
- Clearly distinguishes Detection, Localization, and Segmentation.
- Generates:
    backend/data/sentinel-test/validation/poseatsea/classical_vs_poseatsea.json
    backend/data/sentinel-test/validation/poseatsea/classical_vs_poseatsea.csv
    backend/data/sentinel-test/validation/poseatsea/classical_vs_poseatsea_grid.png
==============================================================================
"""

import os
import sys
import time
import csv
import json
from pathlib import Path
import xml.etree.ElementTree as ET

import numpy as np
import torch
import tifffile
import cv2
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.patches as patches

try:
    import segmentation_models_pytorch as smp
except ImportError:
    print("[ERROR] segmentation-models-pytorch is not installed.")
    sys.exit(1)


NUM_CLASSES = 5
CLASS_NAMES = ['Sea Surface', 'Oil Spill', 'Look-alike', 'Ship', 'Land']
CLASS_COLORS_RGB = {
    0: (15, 23, 42),      # Dark sea slate
    1: (0, 255, 255),     # Cyan - Oil Spill
    2: (239, 68, 68),     # Red - Look-alike
    3: (245, 158, 11),    # Amber/Gold - Ship
    4: (34, 197, 94),     # Green - Land
}


# ==============================================================================
# 1. GROUND TRUTH & COORDINATE CONVERSIONS
# ==============================================================================

def parse_voc_xml(xml_path: Path):
    """Parses Pascal VOC XML annotation boxes."""
    if not xml_path or not Path(xml_path).exists():
        return []
    tree = ET.parse(xml_path)
    objs = tree.getroot().findall('object')
    results = []
    for idx, obj in enumerate(objs):
        name = obj.find('name').text if obj.find('name') is not None else 'unknown'
        bnd = obj.find('bndbox')
        box = [int(bnd.find(k).text) for k in ['xmin', 'ymin', 'xmax', 'ymax']]
        results.append({
            "id": idx + 1,
            "name": name,
            "patchBbox": box,
            "patchArea": (box[2] - box[0]) * (box[3] - box[1]),
            "patchCentroid": [(box[0] + box[2]) / 2.0, (box[1] + box[3]) / 2.0]
        })
    return results


def patch_to_raster_coords(px, py, spec):
    """Bilinear interpolation from 640x640 patch space to 512x512 CDSE raster space."""
    u = px / 640.0
    v = py / 640.0
    ul, ur, br, bl = spec['corners']['ul'], spec['corners']['ur'], spec['corners']['br'], spec['corners']['bl']
    top_lon = ul['lon'] + u * (ur['lon'] - ul['lon'])
    top_lat = ul['lat'] + u * (ur['lat'] - ul['lat'])
    bot_lon = bl['lon'] + u * (br['lon'] - bl['lon'])
    bot_lat = bl['lat'] + u * (br['lat'] - bl['lat'])
    lon = top_lon + v * (bot_lon - top_lon)
    lat = top_lat + v * (bot_lat - top_lat)

    min_lon, min_lat, max_lon, max_lat = spec['aoiBbox']
    rx = ((lon - min_lon) / (max_lon - min_lon)) * 512.0 - 0.5
    ry = ((max_lat - lat) / (max_lat - min_lat)) * 512.0 - 0.5
    return rx, ry


def compute_bbox_iou(box1, box2):
    """Computes bounding-box IoU between [xmin, ymin, xmax, ymax]."""
    if box1 is None or box2 is None:
        return 0.0
    x1 = max(box1[0], box2[0])
    y1 = max(box1[1], box2[1])
    x2 = min(box1[2], box2[2])
    y2 = min(box1[3], box2[3])

    inter_w = max(0, x2 - x1)
    inter_h = max(0, y2 - y1)
    inter_area = inter_w * inter_h

    area1 = max(0, (box1[2] - box1[0])) * max(0, (box1[3] - box1[1]))
    area2 = max(0, (box2[2] - box2[0])) * max(0, (box2[3] - box2[1]))
    union_area = area1 + area2 - inter_area
    return float(inter_area / union_area) if union_area > 0 else 0.0


def read_calibrate_raster(path: Path):
    """Reads GeoTIFF and ensures calibrated dB values."""
    arr = tifffile.imread(str(path)).astype(np.float32)
    if arr.min() >= 0.0 and arr.mean() < 1.0:
        valid = arr > 0
        db = np.full_like(arr, -9999.0)
        db[valid] = 10.0 * np.log10(arr[valid])
        return db, valid
    else:
        valid = arr > -9000.0
        return arr, valid


# ==============================================================================
# 2. CLASSICAL PIPELINE: V2 MORPHOLOGY + 17-FEATURE EXTRACTION + SCORING
# ==============================================================================

def run_classical_pipeline(vv_db: np.ndarray, vh_db: np.ndarray, ocean_mask: np.ndarray, gt_raster_boxes: list):
    """
    Executes the exact V2 classical dark-slick pipeline:
    - Adaptive anomaly detection (R=25 px, k=2.0, damping >= 3.5 dB)
    - 3x3 Morphological Closing (V2 Minimal Morphology)
    - Connected components (size >= 10 px)
    - 17-feature extraction
    - Heuristic scoring (retained if score >= 0.50)
    """
    t0 = time.perf_counter()
    H, W = vv_db.shape
    win_size = 51 # Radius = 25 px

    # Summed Area Table / Box filter for local clutter statistics
    mask_f = ocean_mask.astype(np.float32)
    data_valid = np.where(ocean_mask, vv_db, 0.0)
    sq_valid = np.where(ocean_mask, vv_db**2, 0.0)

    count = cv2.boxFilter(mask_f, -1, (win_size, win_size), normalize=False, borderType=cv2.BORDER_CONSTANT)
    sum_val = cv2.boxFilter(data_valid, -1, (win_size, win_size), normalize=False, borderType=cv2.BORDER_CONSTANT)
    sq_val = cv2.boxFilter(sq_valid, -1, (win_size, win_size), normalize=False, borderType=cv2.BORDER_CONSTANT)

    valid_count = count >= 20
    mean_vv = np.zeros_like(vv_db)
    std_vv = np.zeros_like(vv_db)
    mean_vv[valid_count] = sum_val[valid_count] / count[valid_count]
    var_vv = np.maximum(0, (sq_val[valid_count] / count[valid_count]) - (mean_vv[valid_count]**2))
    std_vv[valid_count] = np.sqrt(var_vv)

    # Statistical damping threshold
    damping = mean_vv - vv_db
    raw_dark = ocean_mask & valid_count & (damping >= 2.0 * std_vv) & (damping >= 3.5)

    # V2 Minimal Morphology: 3x3 Closing only
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    closed = cv2.morphologyEx(raw_dark.astype(np.uint8), cv2.MORPH_CLOSE, kernel)

    # Connected Components
    num_labels, labels, stats, centroids = cv2.connectedComponentsWithStats(closed, connectivity=8)

    # Sobel gradient for boundary sharpness
    gx = cv2.Sobel(vv_db, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(vv_db, cv2.CV_32F, 0, 1, ksize=3)
    grad_mag = np.sqrt(gx**2 + gy**2)

    all_clusters = []
    retained_candidates = []

    for i in range(1, num_labels):
        area = int(stats[i, cv2.CC_STAT_AREA])
        if area < 10:
            continue

        cmask = (labels == i)
        ys, xs = np.where(cmask)
        x1, y1 = int(stats[i, cv2.CC_STAT_LEFT]), int(stats[i, cv2.CC_STAT_TOP])
        w, h = int(stats[i, cv2.CC_STAT_WIDTH]), int(stats[i, cv2.CC_STAT_HEIGHT])
        bbox = [x1, y1, x1 + w, y1 + h]
        cx, cy = float(centroids[i][0]), float(centroids[i][1])

        # Local ocean collar (11x11 dilation minus cluster)
        kernel_collar = cv2.getStructuringElement(cv2.MORPH_RECT, (11, 11))
        dilated = cv2.dilate(cmask.astype(np.uint8), kernel_collar)
        collar = (dilated == 1) & (~cmask) & ocean_mask

        mean_vv_c = float(vv_db[cmask].mean())
        mean_vh_c = float(vh_db[cmask].mean())
        collar_vv = float(vv_db[collar].mean()) if collar.sum() > 0 else mean_vv[int(cy), int(cx)]
        collar_vh = float(vh_db[collar].mean()) if collar.sum() > 0 else float(vh_db[ocean_mask].mean())

        vv_damp = collar_vv - mean_vv_c
        vh_damp = collar_vh - mean_vh_c
        pol_diff = vv_damp - vh_damp

        # 2nd Central moments for elongation
        mu20 = float(np.mean((xs - cx)**2))
        mu02 = float(np.mean((ys - cy)**2))
        mu11 = float(np.mean((xs - cx) * (ys - cy)))
        diff_m = mu20 - mu02
        term = float(np.sqrt(diff_m**2 + 4 * mu11**2))
        l1 = (mu20 + mu02 + term) / 2.0
        l2 = max(1e-4, (mu20 + mu02 - term) / 2.0)
        elong = float(np.sqrt(l1 / l2))

        # Perimeter and boundary gradient
        boundary = cmask & ~cv2.erode(cmask.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_CROSS, (3, 3))).astype(bool)
        mean_grad = float(grad_mag[boundary].mean()) if boundary.sum() > 0 else 0.0

        # Heuristic scoring components
        # 1. Area
        if area >= 100: s_area = 1.0
        elif area >= 30: s_area = 0.5 + 0.5 * ((area - 30) / 70.0)
        elif area >= 15: s_area = 0.2 + 0.3 * ((area - 15) / 15.0)
        else: s_area = 0.1 * (area / 15.0)

        # 2. Elongation
        if elong >= 2.5: s_elong = 1.0
        elif elong >= 1.5: s_elong = 0.5 + 0.5 * ((elong - 1.5) / 1.0)
        elif elong >= 1.2: s_elong = 0.2 + 0.3 * ((elong - 1.2) / 0.3)
        else: s_elong = 0.1

        # 3. VV Damping
        if vv_damp >= 7.0: s_vv = 1.0
        elif vv_damp >= 5.0: s_vv = 0.6 + 0.4 * ((vv_damp - 5.0) / 2.0)
        elif vv_damp >= 3.5: s_vv = 0.2 + 0.4 * ((vv_damp - 3.5) / 1.5)
        else: s_vv = 0.1

        # 4. Pol diff damping
        if pol_diff >= 4.0: s_pol = 1.0
        elif pol_diff >= 1.5: s_pol = 0.5 + 0.5 * ((pol_diff - 1.5) / 2.5)
        elif pol_diff >= 0.0: s_pol = 0.2 + 0.3 * (pol_diff / 1.5)
        else: s_pol = 0.05

        # 5. VH level
        if mean_vh_c <= -32.0: s_vh = 1.0
        elif mean_vh_c <= -28.0: s_vh = 0.5 + 0.5 * ((-28.0 - mean_vh_c) / 4.0)
        else: s_vh = max(0.1, 1.0 - (mean_vh_c + 28.0) / 10.0)

        # 6. Gradient
        if mean_grad >= 5.0: s_grad = 1.0
        elif mean_grad >= 2.5: s_grad = 0.5 + 0.5 * ((mean_grad - 2.5) / 2.5)
        else: s_grad = 0.2 * (mean_grad / 2.5)

        score = float(round(0.15*s_area + 0.20*s_elong + 0.25*s_vv + 0.15*s_pol + 0.10*s_vh + 0.15*s_grad, 4))

        # Check overlap with GT bounding boxes
        overlaps_gt = False
        best_candidate_iou = 0.0
        centroid_dist = None

        for gb in gt_raster_boxes:
            ox1 = max(bbox[0], gb[0])
            oy1 = max(bbox[1], gb[1])
            ox2 = min(bbox[2], gb[2])
            oy2 = min(bbox[3], gb[3])
            if ox1 < ox2 and oy1 < oy2:
                overlaps_gt = True
            iou = compute_bbox_iou(bbox, gb)
            if iou > best_candidate_iou:
                best_candidate_iou = iou
            gc = [(gb[0] + gb[2]) / 2.0, (gb[1] + gb[3]) / 2.0]
            d = float(np.sqrt((cx - gc[0])**2 + (cy - gc[1])**2))
            if centroid_dist is None or d < centroid_dist:
                centroid_dist = round(d, 2)

        cand_data = {
            "clusterId": i,
            "area": area,
            "bbox": bbox,
            "centroid": [round(cx, 2), round(cy, 2)],
            "vvDampingDb": round(vv_damp, 2),
            "vhDampingDb": round(vh_damp, 2),
            "elongation": round(elong, 2),
            "boundaryGradient": round(mean_grad, 2),
            "heuristicScore": score,
            "overlapsGt": overlaps_gt,
            "bboxIoUWithGt": round(best_candidate_iou, 4),
            "centroidDistPx": centroid_dist,
        }
        all_clusters.append(cand_data)
        if score >= 0.50:
            retained_candidates.append(cand_data)

    infer_time_ms = round((time.perf_counter() - t0) * 1000.0, 2)

    # Sort candidates by heuristic score
    retained_candidates.sort(key=lambda c: c["heuristicScore"], reverse=True)
    all_clusters.sort(key=lambda c: c["heuristicScore"], reverse=True)

    # Aggregate metrics
    highest_score = retained_candidates[0]["heuristicScore"] if retained_candidates else (all_clusters[0]["heuristicScore"] if all_clusters else 0.0)
    any_overlaps_gt = any(c["overlapsGt"] for c in retained_candidates)
    best_iou = max([c["bboxIoUWithGt"] for c in retained_candidates], default=0.0)
    best_dist = None
    if any_overlaps_gt:
        overlapping = [c for c in retained_candidates if c["overlapsGt"]]
        best_dist = min([c["centroidDistPx"] for c in overlapping if c["centroidDistPx"] is not None], default=None)
    elif retained_candidates:
        best_dist = retained_candidates[0]["centroidDistPx"]

    return {
        "executionTimeMs": infer_time_ms,
        "totalClustersBeforeFilter": len(all_clusters),
        "retainedCandidates": len(retained_candidates),
        "highestScore": round(highest_score, 4),
        "overlapsGt": any_overlaps_gt,
        "bestBboxIoU": round(best_iou, 4),
        "bestCentroidDistPx": best_dist,
        "candidates": retained_candidates,
        "allClusters": all_clusters,
    }


# ==============================================================================
# 3. POSEatSea PIPELINE
# ==============================================================================

def run_poseatsea_pipeline(model, device, vv_norm, vh_norm, diff_norm, gt_raster_boxes: list):
    """
    Executes POSEatSea zero-shot segmentation:
    - Input: [VV, VH, VV-VH] normalized
    - Returns mask, oil regions, IoU, and centroid distance
    """
    t0 = time.perf_counter()
    inp = np.stack([vv_norm, vh_norm, diff_norm], axis=0)
    tensor_in = torch.tensor(inp, dtype=torch.float32).unsqueeze(0).to(device)

    with torch.no_grad():
        out = model(tensor_in)
        pred_mask = torch.argmax(out, dim=1).squeeze(0).cpu().numpy()
    if torch.cuda.is_available():
        torch.cuda.synchronize()
    infer_time_ms = round((time.perf_counter() - t0) * 1000.0, 2)

    class_dist = {CLASS_NAMES[c]: int((pred_mask == c).sum()) for c in range(NUM_CLASSES)}
    oil_pixels = int((pred_mask == 1).sum())

    # Connected regions
    oil_binary = (pred_mask == 1).astype(np.uint8)
    num_labels, labels, stats, centroids = cv2.connectedComponentsWithStats(oil_binary, connectivity=8)

    regions = []
    overall_bbox = None
    if oil_pixels > 0:
        ys, xs = np.where(oil_binary == 1)
        overall_bbox = [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())]

    overlaps_gt = False
    best_iou = 0.0
    best_dist = None

    for i in range(1, num_labels):
        x, y, w, h, area = stats[i]
        cx, cy = centroids[i]
        reg_box = [int(x), int(y), int(x + w), int(y + h)]

        reg_overlaps = False
        for gb in gt_raster_boxes:
            ox1 = max(reg_box[0], gb[0])
            oy1 = max(reg_box[1], gb[1])
            ox2 = min(reg_box[2], gb[2])
            oy2 = min(reg_box[3], gb[3])
            if ox1 < ox2 and oy1 < oy2:
                reg_overlaps = True
                overlaps_gt = True

            iou = compute_bbox_iou(reg_box, gb)
            if iou > best_iou:
                best_iou = iou
                gc = [(gb[0] + gb[2]) / 2.0, (gb[1] + gb[3]) / 2.0]
                best_dist = round(float(np.sqrt((cx - gc[0])**2 + (cy - gc[1])**2)), 2)

        regions.append({
            "regionId": i,
            "area": int(area),
            "bbox": reg_box,
            "centroid": [round(float(cx), 2), round(float(cy), 2)],
            "overlapsGt": reg_overlaps,
            "bestIoU": round(best_iou, 4)
        })

    return {
        "executionTimeMs": infer_time_ms,
        "predMask": pred_mask,
        "classDistribution": class_dist,
        "oilPixels": oil_pixels,
        "oilRegionsCount": len(regions),
        "overallBbox": overall_bbox,
        "overlapsGt": overlaps_gt,
        "bestBboxIoU": round(best_iou, 4),
        "bestCentroidDistPx": best_dist,
        "regions": regions,
    }


# ==============================================================================
# 4. MAIN COMPARISON SUITE
# ==============================================================================

def main():
    project_root = Path(__file__).resolve().parent.parent.parent
    weights_path = project_root / "best_sar_model.pth"
    if not weights_path.exists():
        weights_path = project_root / "models" / "best_sar_model.pth"

    subset_dir = project_root / "backend/data/sentinel-test/validation/dartis_subset"
    val_dir = project_root / "backend/data/sentinel-test/validation"
    out_dir = val_dir / "poseatsea"
    out_dir.mkdir(parents=True, exist_ok=True)

    # CUDA
    cuda_available = torch.cuda.is_available()
    gpu_name = torch.cuda.get_device_name(0) if cuda_available else "CPU"
    device = torch.device("cuda" if cuda_available else "cpu")

    # Load Model
    model = smp.Unet(encoder_name="mit_b2", encoder_weights=None, in_channels=3, classes=NUM_CLASSES)
    model.load_state_dict(torch.load(weights_path, map_location=device), strict=True)
    model.to(device).eval()

    # Load Scene Manifest
    with open(subset_dir / "manifest.json") as f:
        subset_manifest = json.load(f)

    ow2_spec = {
        "id": "ow-0002",
        "type": "oil",
        "category": "ow (oil/water)",
        "date": "2019-01-04",
        "aoiBbox": [31.949, 31.619, 32.106, 31.754],
        "corners": {
            "ul": {"lon": 31.9728158, "lat": 31.6193082},
            "ur": {"lon": 32.1061271, "lat": 31.6387928},
            "br": {"lon": 32.0826405, "lat": 31.7541920},
            "bl": {"lon": 31.9493293, "lat": 31.7347075},
        },
        "files": {
            "jpg": str(val_dir / "ow-0002.jpg"),
            "xml": str(val_dir / "ow-0002.xml"),
            "vv": str(val_dir / "s1a_20190104_vv_db.tif"),
            "vh": str(val_dir / "s1a_20190104_vh_db.tif"),
        }
    }
    all_scenes = [ow2_spec] + subset_manifest

    print("\n" + "=" * 85)
    print("HEAD-TO-HEAD BENCHMARK: CLASSICAL V2 DETECTOR VS. POSEatSea")
    print("=" * 85)
    print(f"Device:           CUDA={cuda_available} | {gpu_name}")
    print(f"Scenes Evaluated: 6 (4 Oil Scenes, 2 Look-Alike / No-Oil Scenes)")
    print(f"Classical V2:     Adaptive Window (R=25) + Closing Only + 17 Features + Heuristic Scoring")
    print(f"POSEatSea:        U-Net + MiT-B2, Primary Input [VV, VH, VV-VH]")
    print("=" * 85 + "\n")

    scene_comparisons = []
    csv_rows = []

    for sc in all_scenes:
        sid = sc["id"]
        stype = sc["type"]
        cat = sc["category"]
        vv_path = Path(sc["files"]["vv"])
        vh_path = Path(sc["files"]["vh"])
        xml_path = Path(sc["files"]["xml"]) if sc["files"].get("xml") else None

        # 1. Ingest Rasters
        vv_db, vv_valid = read_calibrate_raster(vv_path)
        vh_db, vh_valid = read_calibrate_raster(vh_path)
        valid_mask = vv_valid & vh_valid
        ocean_mask = valid_mask & (vv_db < -10.0) & (vh_db < -20.0)

        # 2. Parse GT Boxes
        raw_gt = parse_voc_xml(xml_path) if xml_path else []
        gt_raster_boxes = []
        for g in raw_gt:
            pb = g["patchBbox"]
            r1 = patch_to_raster_coords(pb[0], pb[1], sc)
            r2 = patch_to_raster_coords(pb[2], pb[3], sc)
            rx1 = int(round(min(r1[0], r2[0])))
            ry1 = int(round(min(r1[1], r2[1])))
            rx2 = int(round(max(r1[0], r2[0])))
            ry2 = int(round(max(r1[1], r2[1])))
            gt_raster_boxes.append([rx1, ry1, rx2, ry2])

        # 3. Run Classical Pipeline
        classical_res = run_classical_pipeline(vv_db, vh_db, ocean_mask, gt_raster_boxes)

        # 4. Prepare POSEatSea Normalization
        p2_vv, p98_vv = float(np.percentile(vv_db[valid_mask], 2.0)), float(np.percentile(vv_db[valid_mask], 98.0))
        p2_vh, p98_vh = float(np.percentile(vh_db[valid_mask], 2.0)), float(np.percentile(vh_db[valid_mask], 98.0))
        diff_db = vv_db - vh_db
        p2_d, p98_d = float(np.percentile(diff_db[valid_mask], 2.0)), float(np.percentile(diff_db[valid_mask], 98.0))

        vv_norm = np.clip((vv_db - p2_vv) / (p98_vv - p2_vv + 1e-6), 0.0, 1.0).astype(np.float32)
        vh_norm = np.clip((vh_db - p2_vh) / (p98_vh - p2_vh + 1e-6), 0.0, 1.0).astype(np.float32)
        diff_norm = np.clip((diff_db - p2_d) / (p98_d - p2_d + 1e-6), 0.0, 1.0).astype(np.float32)

        # 5. Run POSEatSea Pipeline
        pose_res = run_poseatsea_pipeline(model, device, vv_norm, vh_norm, diff_norm, gt_raster_boxes)

        # Comparison summary per scene
        comp = {
            "sceneId": sid,
            "type": stype,
            "category": cat,
            "gtBoundingBoxes": gt_raster_boxes,
            "classical": {
                "totalClustersBeforeFilter": classical_res["totalClustersBeforeFilter"],
                "retainedCandidates": classical_res["retainedCandidates"],
                "highestScore": classical_res["highestScore"],
                "overlapsGt": classical_res["overlapsGt"],
                "bestBboxIoU": classical_res["bestBboxIoU"],
                "bestCentroidDistPx": classical_res["bestCentroidDistPx"],
                "executionTimeMs": classical_res["executionTimeMs"],
                "topCandidates": classical_res["candidates"][:5],
            },
            "poseatsea": {
                "oilPixels": pose_res["oilPixels"],
                "oilRegionsCount": pose_res["oilRegionsCount"],
                "overlapsGt": pose_res["overlapsGt"],
                "bestBboxIoU": pose_res["bestBboxIoU"],
                "bestCentroidDistPx": pose_res["bestCentroidDistPx"],
                "classDistribution": pose_res["classDistribution"],
                "executionTimeMs": pose_res["executionTimeMs"],
            },
            "baseVvNorm": vv_norm,
            "classicalClosed": classical_res,
            "poseMask": pose_res["predMask"],
        }
        scene_comparisons.append(comp)

        # CSV row
        csv_rows.append({
            "Scene_ID": sid,
            "Type": stype,
            "Category": cat,
            "Classical_Total_Clusters": classical_res["totalClustersBeforeFilter"],
            "Classical_Retained_Candidates": classical_res["retainedCandidates"],
            "Classical_Highest_Score": classical_res["highestScore"],
            "Classical_Overlaps_GT": classical_res["overlapsGt"] if stype == "oil" else "N/A",
            "Classical_Best_BBox_IoU": classical_res["bestBboxIoU"] if stype == "oil" else "N/A",
            "Classical_Centroid_Dist_Px": classical_res["bestCentroidDistPx"] if classical_res["bestCentroidDistPx"] is not None else "N/A",
            "POSEatSea_Oil_Pixels": pose_res["oilPixels"],
            "POSEatSea_Oil_Regions": pose_res["oilRegionsCount"],
            "POSEatSea_Overlaps_GT": pose_res["overlapsGt"] if stype == "oil" else "N/A",
            "POSEatSea_Best_BBox_IoU": pose_res["bestBboxIoU"] if stype == "oil" else "N/A",
            "POSEatSea_Centroid_Dist_Px": pose_res["bestCentroidDistPx"] if pose_res["bestCentroidDistPx"] is not None else "N/A",
            "POSEatSea_Lookalike_Px": pose_res["classDistribution"]["Look-alike"],
            "POSEatSea_Land_Px": pose_res["classDistribution"]["Land"],
            "Classical_Time_ms": classical_res["executionTimeMs"],
            "POSEatSea_Time_ms": pose_res["executionTimeMs"],
        })

    # Save JSON
    json_path = out_dir / "classical_vs_poseatsea.json"
    serializable_comps = []
    for c in scene_comparisons:
        s = dict(c)
        del s["baseVvNorm"]
        del s["classicalClosed"]
        del s["poseMask"]
        serializable_comps.append(s)

    with open(json_path, "w") as f:
        json.dump({
            "experiment": "Classical Candidate Detector vs. POSEatSea Benchmark",
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "hardware": {"gpu": gpu_name, "cuda": cuda_available},
            "scenes": serializable_comps,
        }, f, indent=2)

    # Save CSV
    csv_path = out_dir / "classical_vs_poseatsea.csv"
    with open(csv_path, "w", newline="") as f:
        fieldnames = list(csv_rows[0].keys())
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for r in csv_rows:
            writer.writerow(r)

    # 6. Render Side-by-Side Comparison Grid (6 scenes x 2 columns)
    fig, axs = plt.subplots(6, 2, figsize=(14, 32), dpi=160)
    for row_idx, comp in enumerate(scene_comparisons):
        vv = comp["baseVvNorm"]
        gt_boxes = comp["gtBoundingBoxes"]
        sid = comp["sceneId"]
        stype = comp["type"]
        cat = comp["category"]

        # Column 1: Classical Detector
        ax_c = axs[row_idx, 0]
        ax_c.imshow(vv, cmap='gray')
        # Draw all retained classical candidates in Orange/Magenta
        for cand in comp["classical"]["topCandidates"]:
            bx1, by1, bx2, by2 = cand["bbox"]
            rect = patches.Rectangle((bx1, by1), bx2 - bx1, by2 - by1,
                                     linewidth=1.4, edgecolor='#FB923C', facecolor='none')
            ax_c.add_patch(rect)
        # Draw GT in Yellow dashed
        for gb in gt_boxes:
            gx1, gy1, gx2, gy2 = gb
            grect = patches.Rectangle((gx1, gy1), gx2 - gx1, gy2 - gy1,
                                      linewidth=2.0, edgecolor='#FACC15', facecolor='none', linestyle='--')
            ax_c.add_patch(grect)
        c_title = (f"{sid} ({stype.upper()}) | CLASSICAL V2\n"
                   f"Candidates: {comp['classical']['retainedCandidates']} (Top Score: {comp['classical']['highestScore']:.2f}) | Overlaps GT: {comp['classical']['overlapsGt']}")
        ax_c.set_title(c_title, fontsize=9, fontweight='bold')
        ax_c.axis('off')

        # Column 2: POSEatSea Segmentation
        ax_p = axs[row_idx, 1]
        ax_p.imshow(vv, cmap='gray')
        pose_mask = comp["poseMask"]
        alpha_mask = np.zeros((512, 512, 4), dtype=np.float32)
        for c_idx, color in CLASS_COLORS_RGB.items():
            if c_idx == 0: continue
            idx_m = (pose_mask == c_idx)
            alpha_mask[idx_m, 0:3] = np.array(color) / 255.0
            alpha_mask[idx_m, 3] = 0.55 if c_idx == 1 else 0.45
        ax_p.imshow(alpha_mask)

        # Draw predicted oil bbox in Cyan
        if comp["poseatsea"]["oilPixels"] > 0:
            ys, xs = np.where(pose_mask == 1)
            ox1, oy1, ox2, oy2 = xs.min(), ys.min(), xs.max(), ys.max()
            orect = patches.Rectangle((ox1, oy1), ox2 - ox1, oy2 - oy1,
                                      linewidth=1.8, edgecolor='#06B6D4', facecolor='none')
            ax_p.add_patch(orect)
        # Draw GT in Yellow dashed
        for gb in gt_boxes:
            gx1, gy1, gx2, gy2 = gb
            grect = patches.Rectangle((gx1, gy1), gx2 - gx1, gy2 - gy1,
                                      linewidth=2.0, edgecolor='#FACC15', facecolor='none', linestyle='--')
            ax_p.add_patch(grect)

        p_title = (f"{sid} ({stype.upper()}) | POSEatSea\n"
                   f"Oil Px: {comp['poseatsea']['oilPixels']} ({comp['poseatsea']['oilRegionsCount']} reg) | Best IoU: {comp['poseatsea']['bestBboxIoU']:.4f} | Overlaps GT: {comp['poseatsea']['overlapsGt']}")
        ax_p.set_title(p_title, fontsize=9, fontweight='bold')
        ax_p.axis('off')

    plt.suptitle("Head-to-Head Benchmark: Classical Candidate Detector vs. POSEatSea\nLeft: Classical V2 (Orange=Candidates, Yellow=GT) | Right: POSEatSea (Cyan=Oil, Red=Lookalike, Green=Land)",
                 fontsize=13, fontweight='bold', y=0.995)
    fig.tight_layout(rect=[0, 0.01, 1, 0.99])
    grid_img_path = out_dir / "classical_vs_poseatsea_grid.png"
    fig.savefig(str(grid_img_path), bbox_inches='tight')
    plt.close(fig)

    # 7. Print Terminal Table
    print("-" * 110)
    print(f"{'Scene ID':<9} {'Category':<16} {'Class. Cands':<14} {'Top Score':<11} {'Class. Overlap':<16} {'POSE Oil Px':<13} {'POSE Regs':<11} {'POSE Overlap':<14} {'POSE IoU'}")
    print("-" * 110)
    for c in scene_comparisons:
        sid = c["sceneId"]
        cat = c["category"]
        c_cands = f"{c['classical']['retainedCandidates']} / {c['classical']['totalClustersBeforeFilter']}"
        c_score = f"{c['classical']['highestScore']:.3f}"
        c_over = str(c["classical"]["overlapsGt"]) if c["type"] == "oil" else "N/A"
        p_oil = f"{c['poseatsea']['oilPixels']}"
        p_regs = f"{c['poseatsea']['oilRegionsCount']}"
        p_over = str(c["poseatsea"]["overlapsGt"]) if c["type"] == "oil" else "N/A"
        p_iou = f"{c['poseatsea']['bestBboxIoU']:.4f}" if c["type"] == "oil" else "N/A"
        print(f"{sid:<9} {cat:<16} {c_cands:<14} {c_score:<11} {c_over:<16} {p_oil:<13} {p_regs:<11} {p_over:<14} {p_iou}")
    print("-" * 110)

    print(f"\nGenerated files:")
    print(f"  - {json_path}")
    print(f"  - {csv_path}")
    print(f"  - {grid_img_path}\n")


if __name__ == "__main__":
    main()
