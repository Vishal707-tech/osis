#!/usr/bin/env python3
"""
==============================================================================
O.S.I.S. HYBRID SAR SPILL-DETECTION PIPELINE
==============================================================================
Evidence-Fusion Architecture combining:
1. Classical SAR Candidate Detector (V2 Minimal Morphology + Heuristic Scoring)
   - High sensitivity, preserves coastal oil slicks, extracts physical SAR features.
2. POSEatSea Pretrained Deep-Learning Model (U-Net + MiT-B2, 5 classes)
   - High open-water discrimination, suppresses look-alikes.

Pipeline:
Sentinel-1 VV + VH -> Preprocessing
  ├─> Classical V2 Candidate Detection -> Candidates (17 features + Heuristic Score)
  └─> POSEatSea Semantic Segmentation -> Probabilities (Sea, Oil, Look-alike, Ship, Land)
           │                                 │
           └───────────────┬─────────────────┘
                           ▼
                  EVIDENCE FUSION LAYER
                           ▼
                 Spatial Slick Merging
                           ▼
                Standardized Spill Object(s)

Validation Benchmark: 6 DARTIS-2019 scenes:
  - Oil scenes:        ow-0002, ow-0004, ow-0006, oc-0001
  - Look-alike scenes: nw-0001, nw-0002

Evaluation adheres strictly to:
- Pascal VOC XML annotations are Bounding Boxes (NOT pixel masks).
- BBox IoU is used for localization evaluation.
- Detection, Localization, and Segmentation are clearly distinguished.
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
    print("[ERROR] segmentation-models-pytorch is not installed in the active environment.")
    sys.exit(1)


# ==============================================================================
# CONFIGURATION: PROTOTYPE HEURISTIC FUSION WEIGHTS & CONSTANTS
# ==============================================================================

FUSION_CONFIG = {
    "version": "1.0.0-prototype",
    "description": "Multi-source evidence fusion parameters for O.S.I.S. Hybrid SAR Spill Detector",
    "classical": {
        "windowRadius": 25,
        "kSigma": 2.0,
        "minDampingDb": 3.5,
        "closingKernel": [3, 3],
        "minCandidatePixels": 10,
        "candidateThresholdScore": 0.50
    },
    "poseatsea": {
        "architecture": "U-Net + MiT-B2",
        "checkpoint": "best_sar_model.pth",
        "numClasses": 5,
        "classNames": ["Sea Surface", "Oil Spill", "Look-alike", "Ship", "Land"],
        "inputChannels": ["VV_norm", "VH_norm", "(VV-VH)_norm"],
        "percentileLow": 2.0,
        "percentileHigh": 98.0
    },
    "fusionWeights": {
        "openWaterDualConfirmed": {
            "wClassical": 0.45,
            "wPoseOil": 0.45,
            "wDampingBonus": 0.10,
            "wLookalikePenalty": 0.05,
            "minDampingNormMax": 6.0
        },
        "openWaterUnconfirmed": {
            "suppressionFactor": 0.20
        },
        "coastal": {
            "coastalProximityRadiusPx": 60.0,      # ~1 km at 17.3 m/px
            "coastalProximityThreshold": 0.10,     # Candidate within ~900m of land
            "lookalikeSuppressionDamping": 1.0,    # Fully dampens look-alike penalty at shore
            "wClassicalPersistence": 1.0,          # Preserves base classical score
            "wLookalikePenaltyBase": 0.15,
            "wPoseOilBonus": 0.15,
            "wCoastalPersistenceBonus": 0.05
        },
        "spatialMerging": {
            "maxClusterDistancePx": 30.0,          # Spatial proximity threshold (~500m)
            "includeIntersectingDlOil": True,      # Merge confirmed DL oil mask pixels
            "contourSimplifyEpsilon": 0.01         # Polygon approximation tolerance
        },
        "landArtifactFilter": {
            "maxLandOverlapAllowed": 0.40          # Reject candidate if >40% overlaps land
        },
        "geographicLandFilter": {
            "maxGeoLandFraction": 0.50             # Reject if >50% pixels are geographically on land
        },
        "decisionThreshold": 0.50                  # Fused score threshold for positive detection
    }
}

NUM_CLASSES = 5
CLASS_NAMES = ['Sea Surface', 'Oil Spill', 'Look-alike', 'Ship', 'Land']
CLASS_COLORS_RGB = {
    0: (15, 23, 42),      # Dark sea slate
    1: (6, 182, 212),     # Cyan - Oil Spill
    2: (239, 68, 68),     # Red - Look-alike
    3: (245, 158, 11),    # Amber - Ship
    4: (34, 197, 94),     # Green - Land
}


# ==============================================================================
# 1. GEOREFERENCING & RASTER UTILITIES
# ==============================================================================

def read_calibrate_raster(path: Path, units=None):
    """Reads GeoTIFF raster and ensures calibrated dB values."""
    arr = tifffile.imread(str(path)).astype(np.float32)
    if units not in (None, "linear", "db"):
        raise ValueError("Expected explicit linear or db units")
    if units == "linear" or (units is None and arr.min() >= 0.0 and arr.mean() < 1.0):
        valid = np.isfinite(arr) & (arr >= 0)
        db = np.full_like(arr, -9999.0)
        db[valid] = 10.0 * np.log10(np.maximum(arr[valid], 1e-5))
        return db, valid
    else:
        valid = np.isfinite(arr) & (arr > -9000.0)
        return arr, valid


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


def raster_to_geo_coords(rx, ry, aoi_bbox, w=512, h=512):
    """Converts raster pixel coordinate (rx, ry) to geodetic (lon, lat)."""
    min_lon, min_lat, max_lon, max_lat = aoi_bbox
    lon = min_lon + (rx + 0.5) * (max_lon - min_lon) / float(w)
    lat = max_lat - (ry + 0.5) * (max_lat - min_lat) / float(h)
    return float(lon), float(lat)


def compute_bbox_iou(box1, box2):
    """Computes bounding-box IoU between [xmin, ymin, xmax, ymax]."""
    if box1 is None or box2 is None:
        return 0.0
    x1, y1 = max(box1[0], box2[0]), max(box1[1], box2[1])
    x2, y2 = min(box1[2], box2[2]), min(box1[3], box2[3])

    inter_w = max(0, x2 - x1)
    inter_h = max(0, y2 - y1)
    inter_area = inter_w * inter_h

    area1 = max(0, (box1[2] - box1[0])) * max(0, (box1[3] - box1[1]))
    area2 = max(0, (box2[2] - box2[0])) * max(0, (box2[3] - box2[1]))
    union_area = area1 + area2 - inter_area
    return float(inter_area / union_area) if union_area > 0 else 0.0


def compute_pixel_area_km2(aoi_bbox, w=512, h=512):
    """Computes the geodetic area of a single pixel in square kilometers."""
    min_lon, min_lat, max_lon, max_lat = aoi_bbox
    mean_lat_rad = ((min_lat + max_lat) / 2.0) * (np.pi / 180.0)
    m_per_deg_lat = 111132.92 - 559.82 * np.cos(2 * mean_lat_rad) + 1.175 * np.cos(4 * mean_lat_rad)
    m_per_deg_lon = 111412.84 * np.cos(mean_lat_rad) - 93.5 * np.cos(3 * mean_lat_rad)
    px_w_km = ((max_lon - min_lon) / float(w) * m_per_deg_lon) / 1000.0
    px_h_km = ((max_lat - min_lat) / float(h) * m_per_deg_lat) / 1000.0
    return float(px_w_km * px_h_km)


# ==============================================================================
# 2. CLASSICAL PIPELINE EXECUTION
# ==============================================================================

def run_classical_candidates(vv_db: np.ndarray, vh_db: np.ndarray, ocean_mask: np.ndarray):
    """
    Runs Classical V2 candidate detector:
    - Adaptive local clutter threshold (R=25, k=2.0, damping >= 3.5 dB)
    - 3x3 Morphological Closing
    - Connected components (size >= 10 px)
    - 17-feature extraction & heuristic scoring
    """
    t0 = time.perf_counter()
    H, W = vv_db.shape
    win_size = 2 * FUSION_CONFIG["classical"]["windowRadius"] + 1

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

    damping = mean_vv - vv_db
    raw_dark = ocean_mask & valid_count & (damping >= 2.0 * std_vv) & (damping >= 3.5)

    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, tuple(FUSION_CONFIG["classical"]["closingKernel"]))
    closed = cv2.morphologyEx(raw_dark.astype(np.uint8), cv2.MORPH_CLOSE, kernel)

    num_labels, labels, stats, centroids = cv2.connectedComponentsWithStats(closed, connectivity=8)

    # Gradient magnitude for edge sharpness
    gx = cv2.Sobel(vv_db, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(vv_db, cv2.CV_32F, 0, 1, ksize=3)
    grad_mag = np.sqrt(gx**2 + gy**2)

    candidates = []

    for i in range(1, num_labels):
        area = int(stats[i, cv2.CC_STAT_AREA])
        if area < FUSION_CONFIG["classical"]["minCandidatePixels"]:
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

        # Compute candidate internal statistics strictly on valid ocean pixels
        cmask_valid = cmask & ocean_mask
        if cmask_valid.sum() == 0:
            cmask_valid = cmask & (vv_db > -50.0) & (vh_db > -50.0)

        mean_vv_c = float(vv_db[cmask_valid].mean()) if cmask_valid.sum() > 0 else float(mean_vv[int(cy), int(cx)])
        mean_vh_c = float(vh_db[cmask_valid].mean()) if cmask_valid.sum() > 0 else float(vh_db[ocean_mask].mean())
        collar_vv = float(vv_db[collar].mean()) if collar.sum() > 0 else mean_vv[int(cy), int(cx)]
        collar_vh = float(vh_db[collar].mean()) if collar.sum() > 0 else float(vh_db[ocean_mask].mean())

        vv_damp = float(collar_vv - mean_vv_c)
        vh_damp = float(collar_vh - mean_vh_c)
        pol_diff = float(vv_damp - vh_damp)
        vv_vh_diff = float(mean_vv_c - mean_vh_c)

        # 2nd Central moments for elongation
        mu20 = float(np.mean((xs - cx)**2))
        mu02 = float(np.mean((ys - cy)**2))
        mu11 = float(np.mean((xs - cx) * (ys - cy)))
        diff_m = mu20 - mu02
        term = float(np.sqrt(diff_m**2 + 4 * mu11**2))
        l1 = (mu20 + mu02 + term) / 2.0
        l2 = max(1e-4, (mu20 + mu02 - term) / 2.0)
        elong = float(np.sqrt(l1 / l2))

        # Boundary sharpness
        boundary = cmask & ~cv2.erode(cmask.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_CROSS, (3, 3))).astype(bool)
        mean_grad = float(grad_mag[boundary].mean()) if boundary.sum() > 0 else 0.0

        # Heuristic scoring
        if area >= 100: s_area = 1.0
        elif area >= 30: s_area = 0.5 + 0.5 * ((area - 30) / 70.0)
        elif area >= 15: s_area = 0.2 + 0.3 * ((area - 15) / 15.0)
        else: s_area = 0.1 * (area / 15.0)

        if elong >= 2.5: s_elong = 1.0
        elif elong >= 1.5: s_elong = 0.5 + 0.5 * ((elong - 1.5) / 1.0)
        elif elong >= 1.2: s_elong = 0.2 + 0.3 * ((elong - 1.2) / 0.3)
        else: s_elong = 0.1

        if vv_damp >= 7.0: s_vv = 1.0
        elif vv_damp >= 5.0: s_vv = 0.6 + 0.4 * ((vv_damp - 5.0) / 2.0)
        elif vv_damp >= 3.5: s_vv = 0.2 + 0.4 * ((vv_damp - 3.5) / 1.5)
        else: s_vv = 0.1

        if pol_diff >= 4.0: s_pol = 1.0
        elif pol_diff >= 1.5: s_pol = 0.5 + 0.5 * ((pol_diff - 1.5) / 2.5)
        elif pol_diff >= 0.0: s_pol = 0.2 + 0.3 * (pol_diff / 1.5)
        else: s_pol = 0.05

        if mean_vh_c <= -32.0: s_vh = 1.0
        elif mean_vh_c <= -28.0: s_vh = 0.5 + 0.5 * ((-28.0 - mean_vh_c) / 4.0)
        else: s_vh = max(0.1, 1.0 - (mean_vh_c + 28.0) / 10.0)

        if mean_grad >= 5.0: s_grad = 1.0
        elif mean_grad >= 2.5: s_grad = 0.5 + 0.5 * ((mean_grad - 2.5) / 2.5)
        else: s_grad = 0.2 * (mean_grad / 2.5)

        score = float(round(0.15*s_area + 0.20*s_elong + 0.25*s_vv + 0.15*s_pol + 0.10*s_vh + 0.15*s_grad, 4))

        candidates.append({
            "clusterId": i,
            "area": area,
            "bbox": bbox,
            "centroid": [round(cx, 2), round(cy, 2)],
            "cmask": cmask,
            "vvDampingDb": round(vv_damp, 2),
            "vhDampingDb": round(vh_damp, 2),
            "vvVhDifferenceDb": round(vv_vh_diff, 2),
            "dampingDiffDb": round(pol_diff, 2),
            "elongation": round(elong, 2),
            "boundaryGradient": round(mean_grad, 2),
            "heuristicScore": score,
        })

    elapsed_ms = round((time.perf_counter() - t0) * 1000.0, 2)
    # Retain candidates above threshold score
    retained = [c for c in candidates if c["heuristicScore"] >= FUSION_CONFIG["classical"]["candidateThresholdScore"]]
    retained.sort(key=lambda x: x["heuristicScore"], reverse=True)

    return {
        "executionTimeMs": elapsed_ms,
        "totalClusters": len(candidates),
        "retainedCandidates": retained,
        "allCandidates": candidates,
    }


# ==============================================================================
# 3. POSEATSEA INFERENCE PIPELINE
# ==============================================================================

def run_poseatsea_inference(model, device, vv_db, vh_db, valid_mask):
    """
    Executes POSEatSea zero-shot segmentation:
    - Input: [VV, VH, VV-VH] normalized by p2-p98
    - Returns softmax probability maps (5 classes) and argmax segmentation
    """
    t0 = time.perf_counter()
    p2_vv, p98_vv = float(np.percentile(vv_db[valid_mask], 2.0)), float(np.percentile(vv_db[valid_mask], 98.0))
    p2_vh, p98_vh = float(np.percentile(vh_db[valid_mask], 2.0)), float(np.percentile(vh_db[valid_mask], 98.0))
    diff_db = vv_db - vh_db
    p2_d, p98_d = float(np.percentile(diff_db[valid_mask], 2.0)), float(np.percentile(diff_db[valid_mask], 98.0))

    vv_norm = np.clip((vv_db - p2_vv) / (p98_vv - p2_vv + 1e-6), 0.0, 1.0).astype(np.float32)
    vh_norm = np.clip((vh_db - p2_vh) / (p98_vh - p2_vh + 1e-6), 0.0, 1.0).astype(np.float32)
    diff_norm = np.clip((diff_db - p2_d) / (p98_d - p2_d + 1e-6), 0.0, 1.0).astype(np.float32)

    inp = np.stack([vv_norm, vh_norm, diff_norm], axis=0)
    t_in = torch.tensor(inp, dtype=torch.float32).unsqueeze(0).to(device)

    with torch.no_grad():
        out = model(t_in)
        probs = torch.softmax(out, dim=1).squeeze(0).cpu().numpy()
        pred_mask = np.argmax(probs, axis=0)

    if torch.cuda.is_available():
        torch.cuda.synchronize()
    elapsed_ms = round((time.perf_counter() - t0) * 1000.0, 2)

    return {
        "executionTimeMs": elapsed_ms,
        "probs": probs,
        "predMask": pred_mask,
        "vvNorm": vv_norm,
        "oilPixels": int((pred_mask == 1).sum()),
        "lookalikePixels": int((pred_mask == 2).sum()),
        "landPixels": int((pred_mask == 4).sum()),
    }


# ==============================================================================
# 4. HYBRID FUSION LAYER
# ==============================================================================

def fuse_evidence(candidate, pose_res, dist_to_land, has_land, geo_land_mask=None):
    """
    Evaluates transparent multi-criteria evidence fusion for a single classical candidate.
    """
    cmask = candidate["cmask"]
    area = candidate["area"]
    c_score = candidate["heuristicScore"]
    vv_damp = candidate["vvDampingDb"]

    if cmask.size == 0 or area == 0:
        return {
            "fusedScore": 0.0,
            "rule": "degenerate_candidate",
            "evidence": {},
            "decisionPath": "Rejected: candidate has 0 area or malformed size."
        }

    if geo_land_mask is None:
        return {
            "fusedScore": 0.0,
            "rule": "geographic_land_validation_unavailable",
            "evidence": {
                "geoLandFraction": None,
                "geographic_land_validation": "UNAVAILABLE",
            },
            "decisionPath": "Rejected: geographic land validation is unavailable."
        }

    probs = pose_res["probs"]
    pred_mask = pose_res["predMask"]

    # Local context within 15px dilation
    kernel_local = cv2.getStructuringElement(cv2.MORPH_RECT, (31, 31))
    cmask_dil = cv2.dilate(cmask.astype(np.uint8), kernel_local)

    mean_p_oil = float(probs[1][cmask].mean())
    max_p_oil_local = float(probs[1][cmask_dil == 1].max()) if cmask_dil.sum() > 0 else 0.0
    oil_overlap = float((pred_mask[cmask] == 1).sum()) / float(area)
    nearby_oil_px = int((pred_mask[cmask_dil == 1] == 1).sum())

    mean_p_la = float(probs[2][cmask].mean())
    la_overlap = float((pred_mask[cmask] == 2).sum()) / float(area)
    land_overlap = float((pred_mask[cmask] == 4).sum()) / float(area)
    geo_land_overlap = float(geo_land_mask[cmask].sum()) / float(area)

    # Dynamic Coastal Proximity
    cand_dist_land = float(dist_to_land[cmask].min()) if has_land else 9999.0
    c_radius = FUSION_CONFIG["fusionWeights"]["coastal"]["coastalProximityRadiusPx"]
    coastal_prox = max(0.0, 1.0 - cand_dist_land / c_radius) if has_land else 0.0

    # DL signals
    e_oil = max(mean_p_oil, oil_overlap, max_p_oil_local if nearby_oil_px >= 10 else 0.0)
    e_la = max(mean_p_la, la_overlap)

    w_cfg = FUSION_CONFIG["fusionWeights"]

    # Rule evaluation
    if geo_land_overlap > w_cfg["geographicLandFilter"]["maxGeoLandFraction"]:
        fused_score = 0.0
        rule = "geographic_land_rejected"
        decision_path = f"Rejected: {geo_land_overlap*100:.1f}% candidate area is geographically on land (Globe mask)."

    elif land_overlap > w_cfg["landArtifactFilter"]["maxLandOverlapAllowed"]:
        fused_score = 0.0
        rule = "land_artifact_rejected"
        decision_path = f"Rejected: {land_overlap*100:.1f}% candidate area overlaps POSEatSea Land prediction."

    elif coastal_prox > w_cfg["coastal"]["coastalProximityThreshold"]:
        # Coastal slick handling: POSEatSea misclassifies genuine coastal oil as look-alike.
        # Dampen look-alike penalty and protect classical candidate sensitivity.
        eff_la = e_la * max(0.0, 1.0 - coastal_prox * w_cfg["coastal"]["lookalikeSuppressionDamping"])
        c_coast = w_cfg["coastal"]
        fused_score = (
            c_score * (1.0 - c_coast["wLookalikePenaltyBase"] * eff_la)
            + c_coast["wPoseOilBonus"] * e_oil
            + c_coast["wCoastalPersistenceBonus"] * coastal_prox
        )
        rule = "coastal_preserved"
        decision_path = f"Coastal persistence active (proximity={coastal_prox:.2f}, dist_land={cand_dist_land:.1f}px). Lookalike penalty suppressed."

    elif e_oil >= 0.15 or nearby_oil_px >= 10:
        # Open water dual confirmation: both Classical and POSEatSea detect oil
        w_ow = w_cfg["openWaterDualConfirmed"]
        damp_bonus = min(1.0, vv_damp / w_ow["minDampingNormMax"])
        fused_score = (
            w_ow["wClassical"] * c_score
            + w_ow["wPoseOil"] * e_oil
            + w_ow["wDampingBonus"] * damp_bonus
            - w_ow["wLookalikePenalty"] * e_la
        )
        rule = "open_water_dual_confirmed"
        decision_path = f"Dual confirmation: Classical ({c_score:.2f}) + POSEatSea oil ({e_oil:.2f}, {nearby_oil_px} nearby px)."

    else:
        # Open water unconfirmed by POSEatSea: strong look-alike / natural slick suppression
        suppression = w_cfg["openWaterUnconfirmed"]["suppressionFactor"]
        fused_score = c_score * suppression * (1.0 - e_la)
        rule = "open_water_suppressed"
        decision_path = f"Open water unconfirmed by DL (oil_prob={e_oil:.3f}, la_prob={e_la:.3f}). Classical score suppressed by factor {suppression}."

    fused_score = float(np.clip(fused_score, 0.0, 1.0))

    return {
        "fusedScore": round(fused_score, 4),
        "rule": rule,
        "decisionPath": decision_path,
        "evidence": {
            "classicalScore": round(c_score, 3),
            "poseatseaOilProbability": round(mean_p_oil, 4),
            "poseatseaMaxOilLocal": round(max_p_oil_local, 4),
            "poseatseaLookalikeProbability": round(mean_p_la, 4),
            "oilOverlapRatio": round(oil_overlap, 3),
            "lookalikeOverlapRatio": round(la_overlap, 3),
            "landOverlapRatio": round(land_overlap, 3),
            "geoLandFraction": round(geo_land_overlap, 3),
            "vvDampingDb": candidate["vvDampingDb"],
            "vvVhDifferenceDb": candidate["vvVhDifferenceDb"],
            "coastalProximity": round(coastal_prox, 3),
            "distanceToLandPx": round(cand_dist_land, 1) if has_land else None,
        }
    }


# ==============================================================================
# 5. SPATIAL MERGING & STANDARDIZED SPILL OBJECT GENERATION
# ==============================================================================

def polygon_from_mask(mask, aoi_bbox, w, h):
    """Existing simplified outer-contour geometry; holes are not represented."""
    cnts, _ = cv2.findContours(mask.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not cnts:
        return {"type": "Polygon", "coordinates": []}
    main_cnt = max(cnts, key=cv2.contourArea)
    factor = FUSION_CONFIG["fusionWeights"]["spatialMerging"]["contourSimplifyEpsilon"]
    approx = cv2.approxPolyDP(main_cnt, max(1.0, factor * cv2.arcLength(main_cnt, True)), True)
    ring = [[round(v, 6) for v in raster_to_geo_coords(float(p[0][0]), float(p[0][1]), aoi_bbox, w, h)] for p in approx]
    if ring and ring[0] != ring[-1]:
        ring.append(ring[0])
    return {"type": "Polygon", "coordinates": [ring]}


def merge_candidates_to_spill_objects(retained_candidates, pose_res, aoi_bbox, w=512, h=512, include_masks=False):
    """
    Groups proximate confirmed candidates and intersecting POSEatSea oil regions into
    standardized GeoJSON Spill Objects.
    """
    if not retained_candidates:
        return []

    # Map candidate pixels into an active binary mask
    cand_mask = np.zeros((h, w), dtype=np.uint8)
    for c in retained_candidates:
        cand_mask[c["cmask"]] = 1

    pred_mask = pose_res["predMask"]
    probs = pose_res["probs"]
    has_dl_oil = any(c["fusion"]["rule"] == "open_water_dual_confirmed" for c in retained_candidates)

    if has_dl_oil and FUSION_CONFIG["fusionWeights"]["spatialMerging"]["includeIntersectingDlOil"]:
        oil_dl = (pred_mask == 1).astype(np.uint8)
        num_dl, dl_labels, _, _ = cv2.connectedComponentsWithStats(oil_dl, connectivity=8)
        combined_mask = cand_mask.copy()
        for d_id in range(1, num_dl):
            d_region = (dl_labels == d_id)
            if (d_region & (cand_mask == 1)).sum() > 0:
                combined_mask[d_region] = 1
    else:
        # Morphological spatial closing to connect closely spaced slick filaments
        kernel_merge = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15))
        combined_mask = cv2.morphologyEx(cand_mask, cv2.MORPH_CLOSE, kernel_merge)

    num_spills, spill_labels, spill_stats, spill_centroids = cv2.connectedComponentsWithStats(combined_mask, connectivity=8)
    px_area_km2 = compute_pixel_area_km2(aoi_bbox, w, h)
    spill_objects = []

    for s_id in range(1, num_spills):
        area_px = int(spill_stats[s_id, cv2.CC_STAT_AREA])
        if area_px < FUSION_CONFIG["classical"]["minCandidatePixels"]:
            continue

        s_mask = (spill_labels == s_id)
        cx, cy = float(spill_centroids[s_id][0]), float(spill_centroids[s_id][1])
        sx = int(spill_stats[s_id, cv2.CC_STAT_LEFT])
        sy = int(spill_stats[s_id, cv2.CC_STAT_TOP])
        sw = int(spill_stats[s_id, cv2.CC_STAT_WIDTH])
        sh = int(spill_stats[s_id, cv2.CC_STAT_HEIGHT])
        raster_bbox = [sx, sy, sx + sw, sy + sh]

        # Centroid to geodetic coordinates
        lon, lat = raster_to_geo_coords(cx, cy, aoi_bbox, w, h)

        # Associated member candidates
        member_cands = [c for c in retained_candidates if (c["cmask"] & s_mask).sum() > 0]
        if not member_cands:
            member_cands = retained_candidates

        fused_confidence = max(c["fusion"]["fusedScore"] for c in member_cands)
        mean_c_score = float(np.mean([c["heuristicScore"] for c in member_cands]))
        mean_p_oil = float(probs[1][s_mask].mean())
        mean_p_la = float(probs[2][s_mask].mean())
        mean_vv_damp = float(np.mean([c["vvDampingDb"] for c in member_cands]))
        mean_pol_diff = float(np.mean([c["vvVhDifferenceDb"] for c in member_cands]))
        mean_coast_prox = float(np.mean([c["fusion"]["evidence"]["coastalProximity"] for c in member_cands]))

        geometry = polygon_from_mask(s_mask, aoi_bbox, w, h)

        spill_obj = {
            "spillDetected": True,
            "confidence": round(float(fused_confidence), 3),
            "geometry": geometry,
            "centroid": {
                "lat": round(float(lat), 6),
                "lon": round(float(lon), 6)
            },
            "areaKm2": round(float(area_px * px_area_km2), 5),
            "evidence": {
                "classicalScore": round(mean_c_score, 3),
                "poseatseaOilProbability": round(mean_p_oil, 3),
                "poseatseaLookalikeProbability": round(mean_p_la, 3),
                "vvDampingDb": round(mean_vv_damp, 2),
                "vvVhDifferenceDb": round(mean_pol_diff, 2),
                "coastalProximity": round(mean_coast_prox, 3)
            },
            "source": {
                "satellite": "Sentinel-1",
                "polarizations": ["VV", "VH"]
            },
            "rasterBbox": raster_bbox,
            "pixelCount": area_px,
            "associatedCandidateIds": [c["clusterId"] for c in member_cands]
        }
        if include_masks:
            spill_obj["mask"] = s_mask
        spill_objects.append(spill_obj)

    # Sort spills by confidence descending
    spill_objects.sort(key=lambda s: s["confidence"], reverse=True)
    return spill_objects


# ==============================================================================
# 6. MAIN BENCHMARK & EVALUATION ENGINE
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

    # CUDA initialization
    cuda_available = torch.cuda.is_available()
    gpu_name = torch.cuda.get_device_name(0) if cuda_available else "CPU"
    device = torch.device("cuda" if cuda_available else "cpu")

    # Load POSEatSea Model
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

    print("\n" + "=" * 90)
    print("O.S.I.S. HYBRID SPILL-DETECTION PIPELINE: 6-SCENE BENCHMARK")
    print("=" * 90)
    print(f"Device:           CUDA={cuda_available} | {gpu_name}")
    print(f"Classical V2:     Adaptive Window (R=25) + 3x3 Closing + 17 Features + Heuristic Scoring")
    print(f"POSEatSea:        U-Net + MiT-B2, Input [VV, VH, VV-VH] normalized")
    print(f"Fusion Logic:     Evidence-based multi-criteria aggregation with coastal preservation")
    print("=" * 90 + "\n")

    scene_results = []
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

        # 2. Parse GT Bounding Boxes
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
        classical_out = run_classical_candidates(vv_db, vh_db, ocean_mask)

        # 4. Run POSEatSea Pipeline
        pose_out = run_poseatsea_inference(model, device, vv_db, vh_db, valid_mask)

        # 5. Compute Land Distance Transform
        land_mask = (pose_out["predMask"] == 4)
        has_land = land_mask.sum() > 50
        if has_land:
            dist_to_land = cv2.distanceTransform((~land_mask).astype(np.uint8), cv2.DIST_L2, 5)
        else:
            dist_to_land = np.full_like(pose_out["predMask"], 9999.0, dtype=np.float32)

        geo_land_mask = None
        try:
            from global_land_mask import globe
            min_lon, min_lat, max_lon, max_lat = sc["aoiBbox"]
            height, width = vv_db.shape
            lons = min_lon + (np.arange(width) + 0.5) * (max_lon - min_lon) / width
            lats = max_lat - (np.arange(height) + 0.5) * (max_lat - min_lat) / height
            lon_grid, lat_grid = np.meshgrid(lons, lats)
            geo_land_mask = globe.is_land(lat_grid, lon_grid)
        except ImportError:
            pass

        # 6. Evaluate Hybrid Evidence Fusion on Classical Candidates
        t_fuse0 = time.perf_counter()
        fused_candidates = []
        retained_hybrid_candidates = []

        for cand in classical_out["retainedCandidates"]:
            f_eval = fuse_evidence(cand, pose_out, dist_to_land, has_land, geo_land_mask)
            cand_entry = dict(cand)
            cand_entry["fusion"] = f_eval
            fused_candidates.append(cand_entry)

            if f_eval["fusedScore"] >= FUSION_CONFIG["fusionWeights"]["decisionThreshold"]:
                retained_hybrid_candidates.append(cand_entry)

        retained_hybrid_candidates.sort(key=lambda c: c["fusion"]["fusedScore"], reverse=True)

        # 7. Spatial Merging & Standardized Spill Object Creation
        spill_objects = merge_candidates_to_spill_objects(
            retained_hybrid_candidates, pose_out, sc["aoiBbox"], w=512, h=512
        )
        fuse_elapsed_ms = round((time.perf_counter() - t_fuse0) * 1000.0, 2)
        total_runtime_ms = round(classical_out["executionTimeMs"] + pose_out["executionTimeMs"] + fuse_elapsed_ms, 2)

        spill_detected = len(spill_objects) > 0
        top_confidence = spill_objects[0]["confidence"] if spill_detected else 0.0

        # 8. Localization Evaluation against DARTIS Ground Truth
        best_bbox_iou = 0.0
        best_centroid_dist = None
        overlaps_gt = False

        if gt_raster_boxes and spill_detected:
            for sp in spill_objects:
                sbox = sp["rasterBbox"]
                for gb in gt_raster_boxes:
                    ox1 = max(sbox[0], gb[0])
                    oy1 = max(sbox[1], gb[1])
                    ox2 = min(sbox[2], gb[2])
                    oy2 = min(sbox[3], gb[3])
                    if ox1 < ox2 and oy1 < oy2:
                        overlaps_gt = True

                    iou = compute_bbox_iou(sbox, gb)
                    if iou > best_bbox_iou:
                        best_bbox_iou = iou

                    gc = [(gb[0] + gb[2]) / 2.0, (gb[1] + gb[3]) / 2.0]
                    sc_pt = [(sbox[0] + sbox[2]) / 2.0, (sbox[1] + sbox[3]) / 2.0]
                    d = float(np.sqrt((sc_pt[0] - gc[0])**2 + (sc_pt[1] - gc[1])**2))
                    if best_centroid_dist is None or d < best_centroid_dist:
                        best_centroid_dist = round(d, 2)

        # Also evaluate individual candidate-level localization against GT
        best_cand_bbox_iou = 0.0
        best_cand_centroid_dist = None
        cand_overlaps_gt = False
        if gt_raster_boxes and retained_hybrid_candidates:
            for c in retained_hybrid_candidates:
                cbox = c["bbox"]
                for gb in gt_raster_boxes:
                    ox1 = max(cbox[0], gb[0])
                    oy1 = max(cbox[1], gb[1])
                    ox2 = min(cbox[2], gb[2])
                    oy2 = min(cbox[3], gb[3])
                    if ox1 < ox2 and oy1 < oy2:
                        cand_overlaps_gt = True
                    iou = compute_bbox_iou(cbox, gb)
                    if iou > best_cand_bbox_iou:
                        best_cand_bbox_iou = iou
                    gc = [(gb[0] + gb[2]) / 2.0, (gb[1] + gb[3]) / 2.0]
                    cc_pt = c["centroid"]
                    d = float(np.sqrt((cc_pt[0] - gc[0])**2 + (cc_pt[1] - gc[1])**2))
                    if best_cand_centroid_dist is None or d < best_cand_centroid_dist:
                        best_cand_centroid_dist = round(d, 2)

        # Failure diagnosis
        failure_reason = None
        if stype == "oil" and not spill_detected:
            failure_reason = "False Negative: genuine oil slick suppressed or missed."
        elif stype == "look-alike" and spill_detected:
            failure_reason = "False Positive: look-alike scene triggered false detection."

        # Clean JSON-serializable candidate items
        clean_retained_candidates = []
        for c in retained_hybrid_candidates:
            clean_c = {
                "clusterId": c["clusterId"],
                "area": c["area"],
                "bbox": c["bbox"],
                "centroid": c["centroid"],
                "fusedScore": c["fusion"]["fusedScore"],
                "rule": c["fusion"]["rule"],
                "decisionPath": c["fusion"]["decisionPath"],
                "evidence": c["fusion"]["evidence"]
            }
            clean_retained_candidates.append(clean_c)

        scene_summary = {
            "sceneId": sid,
            "type": stype,
            "category": cat,
            "spillDetected": spill_detected,
            "finalSpillCount": len(spill_objects),
            "topConfidence": top_confidence,
            "overlapsGt": overlaps_gt if stype == "oil" else "N/A",
            "bestCandidateBboxIoU": round(best_cand_bbox_iou, 4) if stype == "oil" else "N/A",
            "bestCandidateCentroidDistPx": best_cand_centroid_dist if stype == "oil" else "N/A",
            "bestMergedSpillBboxIoU": round(best_bbox_iou, 4) if stype == "oil" else "N/A",
            "bestMergedSpillCentroidDistPx": best_centroid_dist if stype == "oil" else "N/A",
            "bestBboxIoU": round(max(best_bbox_iou, best_cand_bbox_iou), 4) if stype == "oil" else "N/A",
            "bestCentroidDistPx": min([d for d in [best_centroid_dist, best_cand_centroid_dist] if d is not None], default=None) if stype == "oil" else "N/A",
            "failureReason": failure_reason,
            "performance": {
                "classicalTimeMs": classical_out["executionTimeMs"],
                "poseatseaTimeMs": pose_out["executionTimeMs"],
                "fusionTimeMs": fuse_elapsed_ms,
                "totalTimeMs": total_runtime_ms
            },
            "comparison": {
                "classicalRetained": len(classical_out["retainedCandidates"]),
                "poseatseaOilPixels": pose_out["oilPixels"],
                "poseatseaLookalikePixels": pose_out["lookalikePixels"],
                "poseatseaLandPixels": pose_out["landPixels"],
                "hybridRetainedCandidates": len(retained_hybrid_candidates),
                "hybridSpillObjects": len(spill_objects)
            },
            "spillObjects": spill_objects,
            "retainedCandidates": clean_retained_candidates,
            "gtBoundingBoxes": gt_raster_boxes,
            "baseVvNorm": pose_out["vvNorm"],
            "poseMask": pose_out["predMask"],
        }
        scene_results.append(scene_summary)

        # CSV row
        csv_rows.append({
            "Scene_ID": sid,
            "Type": stype,
            "Category": cat,
            "Spill_Detected": spill_detected,
            "Final_Spills_Count": len(spill_objects),
            "Top_Confidence": top_confidence,
            "Overlaps_GT": overlaps_gt if stype == "oil" else "N/A",
            "Best_Candidate_BBox_IoU": round(best_cand_bbox_iou, 4) if stype == "oil" else "N/A",
            "Best_Candidate_Centroid_Dist_Px": best_cand_centroid_dist if best_cand_centroid_dist is not None else "N/A",
            "Best_Merged_Spill_BBox_IoU": round(best_bbox_iou, 4) if stype == "oil" else "N/A",
            "Best_Merged_Spill_Centroid_Dist_Px": best_centroid_dist if best_centroid_dist is not None else "N/A",
            "Classical_Cands": len(classical_out["retainedCandidates"]),
            "POSEatSea_Oil_Px": pose_out["oilPixels"],
            "Hybrid_Retained_Cands": len(retained_hybrid_candidates),
            "Classical_Time_ms": classical_out["executionTimeMs"],
            "POSEatSea_Time_ms": pose_out["executionTimeMs"],
            "Total_Hybrid_Time_ms": total_runtime_ms,
            "Failure_Reason": failure_reason if failure_reason else "None"
        })

    # ==========================================================================
    # 7. SAVE ARTIFACTS
    # ==========================================================================

    # A. Fusion Configuration JSON
    config_path = out_dir / "fusion_config.json"
    with open(config_path, "w") as f:
        json.dump(FUSION_CONFIG, f, indent=2)

    # B. Detailed Results JSON
    json_path = out_dir / "hybrid_validation_results.json"
    serializable_scenes = []
    for s in scene_results:
        s_clean = dict(s)
        del s_clean["baseVvNorm"]
        del s_clean["poseMask"]
        serializable_scenes.append(s_clean)

    with open(json_path, "w") as f:
        json.dump({
            "experiment": "O.S.I.S. Hybrid SAR Spill-Detection Pipeline Validation",
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "hardware": {"gpu": gpu_name, "cuda": cuda_available},
            "fusionConfig": FUSION_CONFIG,
            "scenes": serializable_scenes,
        }, f, indent=2)

    # C. Summary CSV
    csv_path = out_dir / "hybrid_validation_summary.csv"
    with open(csv_path, "w", newline="") as f:
        fieldnames = list(csv_rows[0].keys())
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for r in csv_rows:
            writer.writerow(r)

    # D. Render Visual Validation Grid (6 scenes x 3 columns)
    # Columns: 1. Classical Candidates | 2. POSEatSea Mask | 3. Final Hybrid Spill Detection
    fig, axs = plt.subplots(6, 3, figsize=(20, 34), dpi=160)
    for row_idx, sc in enumerate(scene_results):
        vv = sc["baseVvNorm"]
        gt_boxes = sc["gtBoundingBoxes"]
        sid = sc["sceneId"]
        stype = sc["type"]

        # Col 1: Classical Candidates
        ax_c = axs[row_idx, 0]
        ax_c.imshow(vv, cmap='gray')
        for cand in sc["retainedCandidates"]:
            bx1, by1, bx2, by2 = cand["bbox"]
            rect = patches.Rectangle((bx1, by1), bx2 - bx1, by2 - by1,
                                     linewidth=1.4, edgecolor='#FB923C', facecolor='none')
            ax_c.add_patch(rect)
        for gb in gt_boxes:
            gx1, gy1, gx2, gy2 = gb
            grect = patches.Rectangle((gx1, gy1), gx2 - gx1, gy2 - gy1,
                                      linewidth=2.0, edgecolor='#FACC15', facecolor='none', linestyle='--')
            ax_c.add_patch(grect)
        ax_c.set_title(f"{sid} ({stype.upper()}) | Classical V2\nCands: {sc['comparison']['classicalRetained']} | Time: {sc['performance']['classicalTimeMs']}ms",
                       fontsize=9, fontweight='bold')
        ax_c.axis('off')

        # Col 2: POSEatSea Segmentation
        ax_p = axs[row_idx, 1]
        ax_p.imshow(vv, cmap='gray')
        pose_mask = sc["poseMask"]
        alpha_mask = np.zeros((512, 512, 4), dtype=np.float32)
        for c_idx, color in CLASS_COLORS_RGB.items():
            if c_idx == 0: continue
            idx_m = (pose_mask == c_idx)
            alpha_mask[idx_m, 0:3] = np.array(color) / 255.0
            alpha_mask[idx_m, 3] = 0.55 if c_idx == 1 else 0.40
        ax_p.imshow(alpha_mask)
        for gb in gt_boxes:
            gx1, gy1, gx2, gy2 = gb
            grect = patches.Rectangle((gx1, gy1), gx2 - gx1, gy2 - gy1,
                                      linewidth=2.0, edgecolor='#FACC15', facecolor='none', linestyle='--')
            ax_p.add_patch(grect)
        ax_p.set_title(f"{sid} ({stype.upper()}) | POSEatSea\nOil: {sc['comparison']['poseatseaOilPixels']}px, LA: {sc['comparison']['poseatseaLookalikePixels']}px | Time: {sc['performance']['poseatseaTimeMs']}ms",
                       fontsize=9, fontweight='bold')
        ax_p.axis('off')

        # Col 3: Hybrid Final Detection
        ax_h = axs[row_idx, 2]
        ax_h.imshow(vv, cmap='gray')
        spills = sc["spillObjects"]
        for sp in spills:
            sx1, sy1, sx2, sy2 = sp["rasterBbox"]
            hrect = patches.Rectangle((sx1, sy1), sx2 - sx1, sy2 - sy1,
                                      linewidth=2.2, edgecolor='#06B6D4', facecolor='none')
            ax_h.add_patch(hrect)
            # Centroid
            lon, lat = sp["centroid"]["lon"], sp["centroid"]["lat"]
            min_lon, min_lat, max_lon, max_lat = all_scenes[row_idx]["aoiBbox"]
            rcx = ((lon - min_lon) / (max_lon - min_lon)) * 512.0 - 0.5
            rcy = ((max_lat - lat) / (max_lat - min_lat)) * 512.0 - 0.5
            ax_h.plot(rcx, rcy, marker='x', markersize=8, color='#06B6D4')

        for gb in gt_boxes:
            gx1, gy1, gx2, gy2 = gb
            grect = patches.Rectangle((gx1, gy1), gx2 - gx1, gy2 - gy1,
                                      linewidth=2.0, edgecolor='#FACC15', facecolor='none', linestyle='--')
            ax_h.add_patch(grect)

        status_str = "DETECTED" if sc["spillDetected"] else "CLEAN (NO SPILL)"
        status_color = "#06B6D4" if sc["spillDetected"] else "#10B981"
        iou_str = f"Best IoU: {sc['bestBboxIoU']:.4f}" if stype == "oil" else "Zero False Alarm"
        ax_h.set_title(f"{sid} ({stype.upper()}) | HYBRID RESULT: {status_str}\nSpills: {len(spills)} (Conf: {sc['topConfidence']:.2f}) | {iou_str} | Total: {sc['performance']['totalTimeMs']}ms",
                       fontsize=9, fontweight='bold')
        ax_h.axis('off')

    plt.suptitle(
        "O.S.I.S. Hybrid SAR Spill-Detection Architecture Validation\n"
        "Left: Classical V2 (Orange) | Center: POSEatSea (Cyan=Oil, Red=Lookalike, Green=Land) | Right: Final Hybrid Detections (Cyan=Spills, Yellow=GT)",
        fontsize=13, fontweight='bold', y=0.995
    )
    fig.tight_layout(rect=[0, 0.01, 1, 0.99])
    grid_img_path = out_dir / "hybrid_validation_grid.png"
    fig.savefig(str(grid_img_path), bbox_inches='tight')
    plt.close(fig)

    # Print Summary Terminal Table
    print("-" * 125)
    print(f"{'Scene ID':<9} {'Category':<16} {'Status':<12} {'Conf.':<8} {'BBox IoU':<10} {'Dist (px)':<10} {'Class. Cands':<14} {'POSE Oil Px':<13} {'Hybrid Spills':<14} {'Runtime'}")
    print("-" * 125)
    for s in scene_results:
        sid = s["sceneId"]
        cat = s["category"]
        stat = "DETECTED" if s["spillDetected"] else "NO_OIL"
        conf = f"{s['topConfidence']:.2f}"
        iou = f"{s['bestBboxIoU']:.4f}" if s["type"] == "oil" else "N/A"
        dist = f"{s['bestCentroidDistPx']}" if s["type"] == "oil" else "N/A"
        c_cands = str(s["comparison"]["classicalRetained"])
        p_oil = str(s["comparison"]["poseatseaOilPixels"])
        h_spills = str(s["finalSpillCount"])
        r_time = f"{s['performance']['totalTimeMs']} ms"
        print(f"{sid:<9} {cat:<16} {stat:<12} {conf:<8} {iou:<10} {dist:<10} {c_cands:<14} {p_oil:<13} {h_spills:<14} {r_time}")
    print("-" * 125)

    print(f"\nArtifacts generated successfully:")
    print(f"  - Config:  {config_path}")
    print(f"  - JSON:    {json_path}")
    print(f"  - CSV:     {csv_path}")
    print(f"  - Visual:  {grid_img_path}\n")


if __name__ == "__main__":
    main()
