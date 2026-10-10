"""Bounded incident adapter for the existing classical/hybrid experiments.

No benchmark main(), annotation boxes, model downloads or output archives are used.
Requires the existing ML environment. Only trusted operator-configured files are read.
"""
import contextlib
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import sys

from characterize_spill import characterize


def experiment():
    spec = importlib.util.spec_from_file_location("osis_hybrid", Path(__file__).with_name("hybrid-spill-detector.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def validate_raster(module, path, scene):
    """Reject unsupported georeferencing instead of trusting the filename/report."""
    path = Path(path)
    if not path.is_file() or path.stat().st_size > 8 * 1024 * 1024:
        raise ValueError("SAR file missing or exceeds the 8 MiB subset limit")
    with module.tifffile.TiffFile(path) as image:
        page = image.pages[0]
        if len(image.pages) != 1 or page.shape != (512, 512):
            raise ValueError("Real SAR adapter supports single-band 512x512 subsets only")
        if page.dtype.kind != "f" or page.dtype.itemsize > 8 or page.samplesperpixel != 1:
            raise ValueError("Calibrated floating-point single-band SAR required, not RGB or display photographs")
        tags = page.tags
        keys = tags[34735].value
        entries = [keys[i:i+4] for i in range(4, len(keys), 4)]
        if (2048, 0, 1, 4326) not in entries or (1025, 0, 1, 1) not in entries or 34264 in tags:
            raise ValueError("Expected north-up EPSG:4326 PixelIsArea GeoTIFF")
        sx, sy, _ = tags[33550].value
        px, py, _, x, y, _ = tags[33922].value
        if not all(math.isfinite(v) for v in (sx, sy, px, py, x, y)) or sx <= 0 or sy <= 0 or px != 0 or py != 0:
            raise ValueError("Unsupported GeoTIFF transform")
        bbox = [x, y - 512*sy, x + 512*sx, y]
        if any(abs(a-b) > 1e-6 for a, b in zip(bbox, scene["bbox"])):
            raise ValueError("SAR georeferencing does not match scene metadata")
    return hashlib.sha256(path.read_bytes()).hexdigest()


class ExperimentalSpillDetector:
    def detect(self, payload):
        scene = dict(payload["scene"])
        if scene.get("rasterUnits") not in ("linear", "db"):
            raise ValueError("Real SAR requires explicit linear or db raster units")
        bbox = scene.get("bbox", [])
        if len(bbox) != 4 or not all(math.isfinite(v) for v in bbox) or not (
                -180 <= bbox[0] < bbox[2] <= 180 and -90 < bbox[1] < bbox[3] < 90):
            raise ValueError("Invalid scene bounds")
        if payload.get("detector", "hybrid") not in ("hybrid", "classical"):
            raise ValueError("Unknown real detector")
        m = experiment()
        np = m.np
        m.torch.set_num_threads(2)
        hashes = {pol: validate_raster(m, payload[pol], scene) for pol in ("vv", "vh")}
        vv, vv_valid = m.read_calibrate_raster(Path(payload["vv"]), units=scene["rasterUnits"])
        vh, vh_valid = m.read_calibrate_raster(Path(payload["vh"]), units=scene["rasterUnits"])
        valid = vv_valid & vh_valid
        if valid.mean() < .5:
            raise ValueError("Less than 50% joint VV/VH coverage; choose another subset")
        # Exclude invalid values from both branches; no NaN/Inf reaches inference.
        vv = np.where(vv_valid, vv, -9999).astype(np.float32)
        vh = np.where(vh_valid, vh, -9999).astype(np.float32)
        ocean = valid & (vv < -10) & (vh < -20)
        classical = m.run_classical_candidates(vv, vh, ocean)
        method = payload.get("detector", "hybrid")
        checkpoint_hash = None
        geographic_land_validation = "NOT_APPLICABLE"
        if method == "hybrid":
            weights = Path(os.environ.get("REAL_MODEL_PATH", str(Path(__file__).resolve().parents[2] / "best_sar_model.pth")))
            if not weights.is_file():
                raise ValueError("Hybrid detector checkpoint unavailable; configure REAL_MODEL_PATH")
            if weights.stat().st_size > 200 * 1024 * 1024:
                raise ValueError("Model exceeds the 200 MiB safety limit")
            checkpoint_hash = hashlib.sha256(weights.read_bytes()).hexdigest()
            device = m.torch.device("cpu")
            model = m.smp.Unet(encoder_name="mit_b2", encoder_weights=None, in_channels=3, classes=5)
            model.load_state_dict(m.torch.load(weights, map_location=device, weights_only=True), strict=True)
            model.to(device).eval()
            # Invalid cells are masked out after inference; fill with valid medians, not huge sentinels.
            pose = m.run_poseatsea_inference(model, device,
                np.where(valid, vv, np.median(vv[valid])), np.where(valid, vh, np.median(vh[valid])), valid)
            pose["predMask"][~valid] = 0
            land = pose["predMask"] == 4
            has_land = land.sum() > 50
            distance = m.cv2.distanceTransform((~land).astype(np.uint8), m.cv2.DIST_L2, 5) if has_land else np.full(vv.shape, 9999, np.float32)
            
            try:
                from global_land_mask import globe
                min_lon, min_lat, max_lon, max_lat = scene["bbox"]
                rxs = np.arange(512)
                rys = np.arange(512)
                lons = min_lon + (rxs + 0.5) * (max_lon - min_lon) / 512.0
                lats = max_lat - (rys + 0.5) * (max_lat - min_lat) / 512.0
                lon_grid, lat_grid = np.meshgrid(lons, lats)
                geo_land_mask = globe.is_land(lat_grid, lon_grid)
                geographic_land_validation = "AVAILABLE"
            except ImportError:
                geo_land_mask = None
                geographic_land_validation = "UNAVAILABLE"

            retained = []
            for candidate in classical["retainedCandidates"]:
                fusion = m.fuse_evidence(candidate, pose, distance, has_land, geo_land_mask)
                if fusion["fusedScore"] >= m.FUSION_CONFIG["fusionWeights"]["decisionThreshold"]:
                    retained.append(dict(candidate, fusion=fusion))
            objects = m.merge_candidates_to_spill_objects(retained, pose, scene["bbox"], include_masks=True)
        elif method == "classical":
            objects = [{"mask": c["cmask"], "geometry": m.polygon_from_mask(c["cmask"], scene["bbox"], 512, 512),
                        "confidence": c["heuristicScore"], "evidence": {"vvDampingDb": c["vvDampingDb"]}}
                       for c in classical["retainedCandidates"]]
        else:
            raise ValueError("Unknown real detector")
        detections, mask, rejected = [], np.zeros((512, 512), dtype=bool), 0
        for obj in objects:
            # Closing can expand into invalid areas: re-mask and regenerate the same contour utility.
            cmask = obj["mask"] & valid
            geometry = m.polygon_from_mask(cmask, scene["bbox"], 512, 512)
            try:
                ring = geometry["coordinates"][0]
                if len(set(map(tuple, ring))) < 3:
                    raise ValueError("Degenerate contour")
                characterization = characterize(ring)
                metrics = characterization["geometry"]
            except (ValueError, IndexError):
                rejected += 1
                continue
            mask |= cmask
            detections.append({"geometry": geometry, "metrics": metrics,
                "shape": characterization["shape"],
                "confidence": obj["confidence"], "evidence": obj["evidence"],
                "pixelCount": int(cmask.sum()),
                "maskAreaKm2": round(int(cmask.sum()) * m.compute_pixel_area_km2(scene["bbox"]), 6),
                "confidenceMeaning": "Uncalibrated experimental compatibility, not probability of oil",
                "geometryMethod": "Existing simplified outer pixel-center contour; holes omitted",
                "geometryQuality": "MODELED; subpixel boundaries unresolved; simplified contours may change area/perimeter"})
        detections.sort(key=lambda d: -d["metrics"]["areaKm2"])
        # Full-resolution processing, bounded 128x128 display raster. No preview is used for detection.
        preview = vv[::4, ::4]
        scene.update(width=128, height=128, nativeWidth=512, nativeHeight=512,
            pixels=[[round(float(v), 2) if good else None for v, good in zip(row, flags)]
                    for row, flags in zip(preview, vv_valid[::4, ::4])],
            resolution_m=[(scene["bbox"][2]-scene["bbox"][0])*111320*math.cos(math.radians(sum(scene["bbox"][1::2])/2))/512,
                          (scene["bbox"][3]-scene["bbox"][1])*111320/512],
            previewUnits="db", previewScale=4,
            assetSha256=hashes, jointValidFraction=round(float(valid.mean()), 4))
        # This gate is a conservative prototype policy, not a calibrated probability.
        # Classical-only anomalies remain inconclusive; hybrid retained evidence must be strong.
        coverage = float(valid.mean())
        ocean_fraction = float(ocean.mean())
        texture = float(np.std(vv[valid]))
        quality_ok = coverage >= .5 and ocean_fraction >= .2 and .1 <= texture <= 20 and rejected == 0
        supported = [d for d in detections if d["confidence"] >= .7 and
                     d["evidence"].get("poseatseaOilProbability", 0) >= .15 and
                     d["evidence"].get("poseatseaOilProbability", 0) > d["evidence"].get("poseatseaLookalikeProbability", 1)]
        for detection in detections:
            detection["passesOilEvidenceGate"] = detection in supported and quality_ok and method == "hybrid"
        outcome = ("SPILL_DETECTED" if method == "hybrid" and quality_ok and supported
                   else "ANALYSIS_INCONCLUSIVE" if geographic_land_validation == "UNAVAILABLE"
                   else "NO_SPILL_DETECTED" if quality_ok and not detections
                   else "ANALYSIS_INCONCLUSIVE")
        reason = ("Hybrid oil-like evidence passed the conservative prototype quality gate; not confirmed oil." if outcome == "SPILL_DETECTED"
                  else "Geographic land validation unavailable; no candidates were accepted." if geographic_land_validation == "UNAVAILABLE"
                  else "No significant retained oil-like anomaly within the valid analyzed subset; not proof of clean water." if outcome == "NO_SPILL_DETECTED"
                  else "Detector uncertainty or insufficient coverage/ocean texture; classical candidates alone cannot reliably identify oil.")
        return {"scene": scene, "detections": detections,
            "mask": mask.reshape(128, 4, 128, 4).any(axis=(1, 3)).astype(int).tolist(),
            "detector": {"name": method, "status": "experimental", "version": m.FUSION_CONFIG["version"],
                "outcome": outcome, "reason": reason,
                "geographic_land_validation": geographic_land_validation,
                "quality": {"jointValidFraction": coverage, "oceanFraction": ocean_fraction, "vvStdDb": texture,
                            "gate": "coverage>=0.5, ocean>=0.2, 0.1<=VV std<=20, valid geometry; hybrid confidence>=0.7, oil support>=0.15 and greater than lookalike support"},
                "checkpointSha256": checkpoint_hash, "geometryRejected": rejected,
                "classicalClusters": classical["totalClusters"], "preview": "4x subsampled VV; 4x4 max-pooled mask"}}


if __name__ == "__main__":
    try:
        payload = json.load(sys.stdin)
        with contextlib.redirect_stdout(sys.stderr):
            result = ExperimentalSpillDetector().detect(payload)
        print(json.dumps(result, allow_nan=False))
    except (Exception, SystemExit):
        # Detailed third-party errors can contain local configuration; never serialize them.
        print(json.dumps({"error": "SAR adapter unavailable: verify ML dependencies, trusted checkpoint and georeferenced VV/VH subset"}))
        sys.exit(1)