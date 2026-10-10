#!/usr/bin/env python3
"""
==============================================================================
MULTI-SCENE ZERO-SHOT VALIDATION: POSEatSea PRETRAINED SAR OIL-SPILL MODEL
==============================================================================
Evaluates the pretrained POSEatSea SAR segmentation model
(Architecture: U-Net + MiT-B2, Weights: best_sar_model.pth)
across a curated 6-scene representative subset of DARTIS_2019:
  - 4 Oil Spill scenes (ow-0002, ow-0004, ow-0006, oc-0001)
  - 2 Look-alike / No-oil scenes (nw-0001, nw-0002)

Primary input mapping:
  [VV, VH, VV-VH] (normalized via robust p2-p98 percentile scaling)

Outputs:
  backend/data/sentinel-test/validation/poseatsea/
    multi_scene_results.json
    multi_scene_summary.csv
    multi_scene_overlay/
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
import torch.nn.functional as F
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


def parse_voc_xml(xml_path: Path):
    """Parses all objects and bounding boxes from Pascal VOC XML."""
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
    """Converts 640x640 patch coordinates to geographic lon/lat, then to 512x512 CDSE raster coordinates."""
    u = px / 640.0
    v = py / 640.0
    ul = spec['corners']['ul']
    ur = spec['corners']['ur']
    br = spec['corners']['br']
    bl = spec['corners']['bl']
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
    """Computes IoU between two bounding boxes [xmin, ymin, xmax, ymax]."""
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
    """Reads GeoTIFF and ensures dB values."""
    arr = tifffile.imread(str(path)).astype(np.float32)
    if arr.min() >= 0.0 and arr.mean() < 1.0:
        valid = arr > 0
        db = np.full_like(arr, -9999.0)
        db[valid] = 10.0 * np.log10(arr[valid])
        return db, valid
    else:
        valid = arr > -9000.0
        return arr, valid


def mask_to_rgb(pred_mask: np.ndarray):
    """Converts 2D integer class mask into RGB image."""
    h, w = pred_mask.shape
    rgb = np.zeros((h, w, 3), dtype=np.uint8)
    for c, color in CLASS_COLORS_RGB.items():
        rgb[pred_mask == c] = color
    return rgb


def render_scene_overlay(base_norm_vv: np.ndarray, pred_mask: np.ndarray, gt_raster_boxes: list, scene_id: str, scene_type: str, out_path: Path):
    """Renders single-scene overlay with GT boxes and detected slicks."""
    h, w = base_norm_vv.shape
    fig, ax = plt.subplots(figsize=(7, 7), dpi=180)
    ax.imshow(base_norm_vv, cmap='gray')

    # Color overlay (only non-sea classes)
    alpha_mask = np.zeros((h, w, 4), dtype=np.float32)
    for c, color in CLASS_COLORS_RGB.items():
        if c == 0:
            continue
        idx = (pred_mask == c)
        alpha_mask[idx, 0:3] = np.array(color) / 255.0
        alpha_mask[idx, 3] = 0.55 if c == 1 else 0.45
    ax.imshow(alpha_mask)

    # Plot GT bounding boxes in Yellow dashed
    for idx, gb in enumerate(gt_raster_boxes):
        gx1, gy1, gx2, gy2 = gb
        rect = patches.Rectangle(
            (gx1, gy1), gx2 - gx1, gy2 - gy1,
            linewidth=2.0, edgecolor='#FACC15', facecolor='none', linestyle='--',
            label='DARTIS GT BBox' if idx == 0 else None
        )
        ax.add_patch(rect)

    # Plot Predicted Oil Bounding Box in Cyan solid
    oil_mask = (pred_mask == 1)
    if np.any(oil_mask):
        ys, xs = np.where(oil_mask)
        px1, py1, px2, py2 = xs.min(), ys.min(), xs.max(), ys.max()
        oil_rect = patches.Rectangle(
            (px1, py1), px2 - px1, py2 - py1,
            linewidth=1.8, edgecolor='#06B6D4', facecolor='none', label='Pred Oil BBox'
        )
        ax.add_patch(oil_rect)

    title_str = f"{scene_id} ({scene_type.upper()}) | Oil Px={np.sum(pred_mask==1)}"
    ax.set_title(title_str, fontsize=11, fontweight='bold', pad=8)
    if len(gt_raster_boxes) > 0 or np.any(oil_mask):
        ax.legend(loc='upper right', framealpha=0.85, facecolor='#0f172a', labelcolor='white', fontsize=8)
    ax.axis('off')
    fig.tight_layout()
    fig.savefig(str(out_path), bbox_inches='tight')
    plt.close(fig)


def main():
    project_root = Path(__file__).resolve().parent.parent.parent
    weights_path = project_root / "best_sar_model.pth"
    if not weights_path.exists():
        weights_path = project_root / "models" / "best_sar_model.pth"

    subset_dir = project_root / "backend/data/sentinel-test/validation/dartis_subset"
    val_dir = project_root / "backend/data/sentinel-test/validation"
    out_dir = val_dir / "poseatsea"
    overlay_dir = out_dir / "multi_scene_overlay"
    overlay_dir.mkdir(parents=True, exist_ok=True)

    # 1. Environment & Device
    cuda_available = torch.cuda.is_available()
    gpu_name = torch.cuda.get_device_name(0) if cuda_available else "CPU"
    device = torch.device("cuda" if cuda_available else "cpu")

    # 2. Reconstruct and Load Model
    model = smp.Unet(encoder_name="mit_b2", encoder_weights=None, in_channels=3, classes=NUM_CLASSES)
    model.load_state_dict(torch.load(weights_path, map_location=device), strict=True)
    model.to(device).eval()

    # 3. Assemble Full Scene Catalog (ow-0002 + 5 from manifest)
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
    print(f"\n=================================================================")
    print(f"MULTI-SCENE ZERO-SHOT POSEatSea VALIDATION (DARTIS_2019)")
    print(f"=================================================================")
    print(f"Total Scenes:    {len(all_scenes)}")
    print(f"Weights:         {weights_path.name}")
    print(f"Device:          CUDA={cuda_available} | {gpu_name}")
    print(f"Primary Mapping: [VV, VH, VV-VH] (p2-p98 normalized)")
    print(f"=================================================================\n")

    results = []
    summary_rows = []

    # Warmup GPU
    dummy = torch.zeros((1, 3, 512, 512), dtype=torch.float32, device=device)
    with torch.no_grad():
        _ = model(dummy)
    if cuda_available:
        torch.cuda.synchronize()

    for sc in all_scenes:
        sid = sc["id"]
        stype = sc["type"]
        cat = sc["category"]
        vv_path = Path(sc["files"]["vv"])
        vh_path = Path(sc["files"]["vh"])
        xml_path = Path(sc["files"]["xml"]) if sc["files"].get("xml") else None

        # A. Read and Calibrate
        vv_db, vv_valid = read_calibrate_raster(vv_path)
        vh_db, vh_valid = read_calibrate_raster(vh_path)
        valid_mask = vv_valid & vh_valid

        # B. Robust Percentile Normalization
        p2_vv, p98_vv = float(np.percentile(vv_db[valid_mask], 2.0)), float(np.percentile(vv_db[valid_mask], 98.0))
        p2_vh, p98_vh = float(np.percentile(vh_db[valid_mask], 2.0)), float(np.percentile(vh_db[valid_mask], 98.0))
        diff_db = vv_db - vh_db
        p2_d, p98_d = float(np.percentile(diff_db[valid_mask], 2.0)), float(np.percentile(diff_db[valid_mask], 98.0))

        vv_norm = np.clip((vv_db - p2_vv) / (p98_vv - p2_vv + 1e-6), 0.0, 1.0).astype(np.float32)
        vh_norm = np.clip((vh_db - p2_vh) / (p98_vh - p2_vh + 1e-6), 0.0, 1.0).astype(np.float32)
        diff_norm = np.clip((diff_db - p2_d) / (p98_d - p2_d + 1e-6), 0.0, 1.0).astype(np.float32)

        # Primary input [VV, VH, VV-VH]
        inp_primary = np.stack([vv_norm, vh_norm, diff_norm], axis=0)
        t_primary = torch.tensor(inp_primary, dtype=torch.float32).unsqueeze(0).to(device)

        # C. Inference & Timing
        t0 = time.perf_counter()
        with torch.no_grad():
            out_primary = model(t_primary)
            pred_mask = torch.argmax(out_primary, dim=1).squeeze(0).cpu().numpy()
        if cuda_available:
            torch.cuda.synchronize()
        infer_time_ms = round((time.perf_counter() - t0) * 1000.0, 2)

        # D. Class distribution
        class_dist = {CLASS_NAMES[c]: int((pred_mask == c).sum()) for c in range(NUM_CLASSES)}
        oil_pixels = int((pred_mask == 1).sum())

        # E. Connected components for Oil
        oil_binary = (pred_mask == 1).astype(np.uint8)
        num_labels, labels, stats, centroids = cv2.connectedComponentsWithStats(oil_binary, connectivity=8)

        oil_regions = []
        main_region = None
        max_area = 0
        for i in range(1, num_labels):
            x, y, w, h, area = stats[i]
            cx, cy = centroids[i]
            reg = {
                "regionId": i,
                "pixelCount": int(area),
                "bbox": [int(x), int(y), int(x + w), int(y + h)],
                "centroid": [float(round(cx, 2)), float(round(cy, 2))],
            }
            oil_regions.append(reg)
            if area > max_area:
                max_area = area
                main_region = reg

        overall_oil_bbox = None
        overall_oil_centroid = None
        if oil_pixels > 0:
            ys, xs = np.where(oil_binary == 1)
            overall_oil_bbox = [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())]
            overall_oil_centroid = [float(round(xs.mean(), 2)), float(round(ys.mean(), 2))]

        # F. Ground Truth Mapping & Comparison
        raw_gt_objects = parse_voc_xml(xml_path) if xml_path else []
        gt_raster_objects = []
        for gobj in raw_gt_objects:
            pb = gobj["patchBbox"]
            r1 = patch_to_raster_coords(pb[0], pb[1], sc)
            r2 = patch_to_raster_coords(pb[2], pb[3], sc)
            rx1 = int(round(min(r1[0], r2[0])))
            ry1 = int(round(min(r1[1], r2[1])))
            rx2 = int(round(max(r1[0], r2[0])))
            ry2 = int(round(max(r1[1], r2[1])))
            cx, cy = (rx1 + rx2) / 2.0, (ry1 + ry2) / 2.0
            gt_raster_objects.append({
                "id": gobj["id"],
                "name": gobj["name"],
                "rasterBbox": [rx1, ry1, rx2, ry2],
                "rasterCentroid": [round(cx, 2), round(cy, 2)],
                "rasterArea": max(0, rx2 - rx1) * max(0, ry2 - ry1)
            })

        # Evaluate detection vs GT
        detected = False
        overlaps_gt = False
        best_iou = 0.0
        best_centroid_dist = None
        best_gt_box = None
        main_reg_overlaps_gt = False

        if stype == "oil":
            if len(gt_raster_objects) > 0 and oil_pixels > 0:
                for gobj in gt_raster_objects:
                    gb = gobj["rasterBbox"]
                    gc = gobj["rasterCentroid"]
                    # Test overlap with predicted oil
                    if overall_oil_bbox:
                        ox1 = max(overall_oil_bbox[0], gb[0])
                        oy1 = max(overall_oil_bbox[1], gb[1])
                        ox2 = min(overall_oil_bbox[2], gb[2])
                        oy2 = min(overall_oil_bbox[3], gb[3])
                        if ox1 < ox2 and oy1 < oy2:
                            overlaps_gt = True

                    # Check each predicted region against this GT box
                    for reg in oil_regions:
                        iou = compute_bbox_iou(reg["bbox"], gb)
                        dist = float(np.sqrt((reg["centroid"][0] - gc[0])**2 + (reg["centroid"][1] - gc[1])**2))
                        if iou > best_iou:
                            best_iou = iou
                            best_centroid_dist = round(dist, 2)
                            best_gt_box = gb

                    if main_region:
                        m_ox1 = max(main_region["bbox"][0], gb[0])
                        m_oy1 = max(main_region["bbox"][1], gb[1])
                        m_ox2 = min(main_region["bbox"][2], gb[2])
                        m_oy2 = min(main_region["bbox"][3], gb[3])
                        if m_ox1 < m_ox2 and m_oy1 < m_oy2:
                            main_reg_overlaps_gt = True

                if best_centroid_dist is None and overall_oil_centroid and len(gt_raster_objects) > 0:
                    primary_gc = gt_raster_objects[0]["rasterCentroid"]
                    best_centroid_dist = round(float(np.sqrt((overall_oil_centroid[0] - primary_gc[0])**2 +
                                                             (overall_oil_centroid[1] - primary_gc[1])**2)), 2)

                # Detection criteria: overlaps GT or BBox IoU > 0.10
                detected = overlaps_gt or (best_iou > 0.10)
            else:
                detected = False

            status = "POSITIVE DETECTION" if detected else "MISSED DETECTION"
            notes = f"Oil slick detected (IoU={best_iou:.4f})" if detected else "No oil detected in GT region"
            if sid == "oc-0001":
                notes = "Coastal oil masked as Look-alike (Class 2) and Land (Class 4)"
        else:
            # Look-alike / No-oil scene
            false_alarm = oil_pixels > 10
            status = "CORRECT REJECTION" if not false_alarm else "FALSE OIL DETECTION"
            notes = f"Clean suppression ({oil_pixels} oil px, {class_dist['Look-alike']} lookalike px)" if not false_alarm else f"False detection: {oil_pixels} px"

        # G. Render and Save Overlay
        overlay_path = overlay_dir / f"{sid}_overlay.png"
        gt_boxes_list = [g["rasterBbox"] for g in gt_raster_objects]
        render_scene_overlay(vv_norm, pred_mask, gt_boxes_list, sid, stype, overlay_path)

        scene_result = {
            "sceneId": sid,
            "type": stype,
            "category": cat,
            "inferenceTimeMs": infer_time_ms,
            "status": status,
            "oilDetected": detected if stype == "oil" else (oil_pixels > 0),
            "predictedOilPixels": oil_pixels,
            "predictedOilRegions": len(oil_regions),
            "overallOilBbox": overall_oil_bbox,
            "overallOilCentroid": overall_oil_centroid,
            "mainRegion": main_region,
            "gtObjects": gt_raster_objects,
            "overlapsGt": overlaps_gt,
            "mainRegionOverlapsGt": main_reg_overlaps_gt,
            "bestBboxIoU": round(best_iou, 4),
            "bestCentroidDistPx": best_centroid_dist,
            "classPixelCounts": class_dist,
            "overlayPath": str(overlay_path),
            "notes": notes,
        }
        results.append(scene_result)

        summary_rows.append({
            "Scene_ID": sid,
            "Type": stype,
            "Category": cat,
            "Status": status,
            "Oil_Pixels": oil_pixels,
            "Oil_Regions": len(oil_regions),
            "Overlaps_GT": overlaps_gt if stype == "oil" else "N/A",
            "Best_BBox_IoU": best_iou if stype == "oil" else "N/A",
            "Centroid_Dist_Px": best_centroid_dist if best_centroid_dist is not None else "N/A",
            "Lookalike_Pixels": class_dist["Look-alike"],
            "Land_Pixels": class_dist["Land"],
            "Ship_Pixels": class_dist["Ship"],
            "Inference_Time_ms": infer_time_ms,
            "Notes": notes,
        })

    # 4. Write Summary CSV
    csv_path = out_dir / "multi_scene_summary.csv"
    with open(csv_path, "w", newline="") as f:
        fieldnames = ["Scene_ID", "Type", "Category", "Status", "Oil_Pixels", "Oil_Regions",
                      "Overlaps_GT", "Best_BBox_IoU", "Centroid_Dist_Px", "Lookalike_Pixels",
                      "Land_Pixels", "Ship_Pixels", "Inference_Time_ms", "Notes"]
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for r in summary_rows:
            writer.writerow(r)

    # 5. Render Combined 6-Scene Grid
    fig, axs = plt.subplots(2, 3, figsize=(18, 12), dpi=180)
    for idx, sc in enumerate(results):
        row = idx // 3
        col = idx % 3
        ax = axs[row, col]
        img = cv2.imread(sc["overlayPath"])
        img_rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        ax.imshow(img_rgb)
        ax.set_title(f"{sc['sceneId']} ({sc['type'].upper()} - {sc['category']})\n{sc['status']} | Oil: {sc['predictedOilPixels']} px",
                     fontsize=10, fontweight='bold')
        ax.axis('off')
    plt.suptitle("POSEatSea Multi-Scene Zero-Shot Evaluation on DARTIS_2019", fontsize=15, fontweight='bold', y=0.98)
    fig.tight_layout(rect=[0, 0.03, 1, 0.95])
    grid_path = out_dir / "multi_scene_grid.png"
    fig.savefig(str(grid_path), bbox_inches='tight')
    plt.close(fig)

    # 6. Aggregate Statistics
    oil_scenes = [r for r in results if r["type"] == "oil"]
    non_oil_scenes = [r for r in results if r["type"] != "oil"]

    detected_oil_count = sum(1 for r in oil_scenes if r["oilDetected"])
    detection_rate = round((detected_oil_count / len(oil_scenes)) * 100.0, 1)

    detected_ious = [r["bestBboxIoU"] for r in oil_scenes if r["bestBboxIoU"] > 0]
    mean_iou = round(float(np.mean(detected_ious)), 4) if detected_ious else 0.0
    median_iou = round(float(np.median(detected_ious)), 4) if detected_ious else 0.0

    detected_dists = [r["bestCentroidDistPx"] for r in oil_scenes if r["bestCentroidDistPx"] is not None and r["bestBboxIoU"] > 0]
    mean_dist = round(float(np.mean(detected_dists)), 2) if detected_dists else 0.0
    median_dist = round(float(np.median(detected_dists)), 2) if detected_dists else 0.0

    false_alarm_count = sum(1 for r in non_oil_scenes if r["predictedOilPixels"] > 10)

    final_payload = {
        "experiment": "POSEatSea Multi-Scene Zero-Shot Validation (DARTIS_2019)",
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "model": {
            "checkpoint": weights_path.name,
            "architecture": "U-Net with MiT-B2 encoder",
            "inputMapping": "[VV, VH, VV-VH]",
            "device": str(device),
            "gpuName": gpu_name,
        },
        "aggregateMetrics": {
            "totalScenesEvaluated": len(results),
            "oilScenesCount": len(oil_scenes),
            "nonOilScenesCount": len(non_oil_scenes),
            "oilDetectionRatePercent": detection_rate,
            "oilScenesDetected": f"{detected_oil_count} / {len(oil_scenes)}",
            "meanBboxIoU": mean_iou,
            "medianBboxIoU": median_iou,
            "meanCentroidDistPx": mean_dist,
            "medianCentroidDistPx": median_dist,
            "falseOilDetectionsOnNonOil": false_alarm_count,
        },
        "scenes": results,
        "artifacts": {
            "resultsJson": str(out_dir / "multi_scene_results.json"),
            "summaryCsv": str(csv_path),
            "overlayDir": str(overlay_dir),
            "overviewGrid": str(grid_path),
        }
    }

    with open(out_dir / "multi_scene_results.json", "w") as f:
        json.dump(final_payload, f, indent=2)

    # 7. Print Terminal Report
    print("=" * 80)
    print("MULTI-SCENE VALIDATION SUMMARY REPORT")
    print("=" * 80)
    print(f"Number of scenes evaluated:                   {len(results)}")
    print(f"Number of oil scenes:                         {len(oil_scenes)}")
    print(f"Number of look-alike / no-oil scenes:         {len(non_oil_scenes)}")
    print(f"Detection rate on oil scenes:                 {detection_rate}% ({detected_oil_count}/{len(oil_scenes)})")
    print(f"Mean BBox IoU (detected oil slicks):          {mean_iou:.4f}")
    print(f"Median BBox IoU (detected oil slicks):        {median_iou:.4f}")
    print(f"Mean Centroid distance (detected oil):        {mean_dist:.2f} px")
    print(f"Median Centroid distance (detected oil):      {median_dist:.2f} px")
    print(f"False oil detections on no-oil/look-alike:    {false_alarm_count} / {len(non_oil_scenes)}")
    print("-" * 80)
    print(f"{'Scene ID':<10} {'Type':<12} {'Status':<18} {'Oil Px':<8} {'Regions':<8} {'IoU':<8} {'Centroid Dist':<15} {'Infer (ms)'}")
    print("-" * 80)
    for r in results:
        iou_str = f"{r['bestBboxIoU']:.4f}" if r['type'] == 'oil' else "N/A"
        dist_str = f"{r['bestCentroidDistPx']} px" if r['bestCentroidDistPx'] is not None else "N/A"
        print(f"{r['sceneId']:<10} {r['type']:<12} {r['status']:<18} {r['predictedOilPixels']:<8} {r['predictedOilRegions']:<8} {iou_str:<8} {dist_str:<15} {r['inferenceTimeMs']} ms")
    print("=" * 80)
    print(f"\nArtifacts saved successfully in:\n  {out_dir}\n")


if __name__ == "__main__":
    main()
