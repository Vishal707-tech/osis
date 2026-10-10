"""Explicit REAL orchestration. Missing evidence produces partial reports, never demo data."""
import contextlib
import datetime as dt
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile

from incident_pipeline import ROOT, WEIGHTS, correlate, drift, iso, normalize_ais, timestamp
from strict_real_adapters import StrictEnvironmentProvider, Unavailable, historical_ais
from report_contract import finalize


def load_scene(scene_id):
    registry = json.loads((ROOT / "data/real-scenes.json").read_text(encoding="utf-8"))
    entry = next((s for s in registry if s["id"] == scene_id), None)
    if entry is None:
        raise ValueError("Unknown archived scene")
    scene = {k: v for k, v in entry.items() if k not in ("vv", "vh")}
    scene.update(width=0, height=0, pixels=[], resolution_m=[])
    paths = {}
    for pol in ("vv", "vh"):
        path = (ROOT / "data" / entry[pol]).resolve()
        if not path.is_relative_to((ROOT / "data").resolve()):
            raise ValueError("Registry asset outside trusted data directory")
        paths[pol] = str(path)
    return scene, paths


def run_sar(scene, paths, detector):
    python = os.environ.get("REAL_SAR_PYTHON") or sys.executable
    try:
        # Bounded native raster inputs cap output; spool to disk rather than unlimited PIPE memory.
        with tempfile.TemporaryFile() as output:
            child = subprocess.run([python, str(ROOT / "scripts/real_sar_adapter.py")],
                input=json.dumps(dict(paths, scene=scene, detector=detector)).encode(),
                stdout=output, stderr=subprocess.DEVNULL, timeout=35, check=False)
            if child.returncode or output.tell() > 4 * 1024 * 1024:
                raise Unavailable("SAR adapter failed: verify dependencies, trusted checkpoint and GeoTIFF assets")
            output.seek(0)
            def reject_constant(value):
                raise ValueError("Nonfinite adapter output")
            def finite_float(value):
                number = float(value)
                if not math.isfinite(number):
                    raise ValueError("Nonfinite adapter output")
                return number
            result = json.load(output, parse_constant=reject_constant, parse_float=finite_float)
            if (not isinstance(result, dict)
                    or not isinstance(result.get("scene"), dict)
                    or not isinstance(result.get("detector"), dict)
                    or not isinstance(result.get("detections"), list)
                    or not isinstance(result.get("mask"), list)
                    or result["scene"].get("id") != scene["id"]
                    or any(not isinstance(d, dict) or not isinstance(d.get("metrics"), dict)
                           or not isinstance(d["metrics"].get("centroid"), dict)
                           for d in result["detections"])):
                raise ValueError()
            west, south, east, north = scene["bbox"]
            for detection in result["detections"]:
                centroid = detection["metrics"]["centroid"]
                lat, lon = centroid.get("lat"), centroid.get("lon")
                if (type(lat) not in (int, float) or type(lon) not in (int, float)
                        or not south <= lat <= north or not west <= lon <= east):
                    raise ValueError("Invalid SAR centroid")
            # The detector supplies evidence only, never orchestration status, age or vessels.
            return {key: result[key] for key in ("scene", "detector", "detections", "mask")}
    except subprocess.TimeoutExpired:
        raise Unavailable("SAR adapter exceeded its 35 second processing limit") from None
    except (OSError, ValueError) as exc:
        if isinstance(exc, Unavailable):
            raise
        raise Unavailable("SAR interpreter unavailable or adapter returned invalid output") from None


def _analyze(payload):
    scene, paths = (payload["_scene"], payload.get("_paths", {})) if "_scene" in payload else load_scene(payload["sceneId"])
    horizon = payload.get("forecastHours", 24)
    hours = payload.get("hindcastHours", 6)
    detector = payload.get("detector", "hybrid")
    if horizon not in (24, 48, 72) or type(hours) not in (int, float) or not 1 <= hours <= 48 or detector not in ("hybrid", "classical"):
        raise ValueError("Invalid REAL analysis scenario")
    statuses = {}

    def stage(name, status, kind, reason):
        statuses[name] = {"status": status, "kind": kind, "reason": reason}

    for name in ("detection", "characterization", "environment", "hindcast", "forecast", "ais", "attribution"):
        stage(name, "unavailable", "UNAVAILABLE", "Prerequisite evidence unavailable")
    stage("age", "unavailable", "UNAVAILABLE", "Single SAR observation cannot date release; hindcast duration is an analyst scenario, not spill age")
    report = {"mode": "REAL", "status": "partial", "scene": scene, "mask": [], "detections": [],
        "spill": None, "age": None, "origin": None, "backward": [], "forward": [],
        "candidates": [], "anomalies": [], "leadingCandidate": None,
        "forecastHours": horizon, "hindcastHours": hours,
        "scenario": {"hindcastHours": hours, "windowHalfWidthHours": 1,
                     "meaning": "Analyst-selected backtracking duration and +/-1h AIS search window; NOT measured spill age or release interval"},
        "environment": {}, "ais": {"source": "unavailable"}, "stages": [], "stageStatus": statuses,
        "scoring": {"weights": WEIGHTS, "searchRadiusKm": 15,
                    "note": "Heuristic compatibility with a modeled scenario, not calibrated probability or legal responsibility. AIS gaps are not proof of disabling."},
        "provenance": {"imagery": "REAL archived Sentinel-1 subset; processing availability shown per stage",
            "geometry": "unavailable", "age": "unavailable", "environment": "unavailable",
            "origin": "unavailable", "forecast": "unavailable", "ais": "unavailable",
            "algorithmVersion": "real-adapters-1"},
        "uncertainty": ["Experimental SAR candidates may be low wind, biogenic films, land artifacts or other lookalikes; no confirmed oil spill.",
            "Only the largest candidate passing the oil-evidence gate is backtracked and correlated with vessels.",
            "Simplified pixel-center outer contours omit holes and can differ from mask area.",
            "Reanalysis fields are model products, not direct local measurements. Nearest-neighbour sampling is not interpolation.",
            "Point RK4 advection omits diffusion, weathering, coastline interaction and waves.",
            "Leeway 0.03 and velocity sensitivity 0.15 m/s are assumed; radii are not calibrated confidence bounds.",
            "AIS coverage is incomplete; non-AIS vessels cannot be excluded. Rankings do not establish responsibility."],
        "disclaimer": "REAL archived inputs, experimental inferred detection and conditional modeled trajectories. Unavailable stages are not replaced by synthetic data. Hindcast duration is a scenario, NOT spill age."}
    try:
        if payload.get("_unavailable"):
            raise Unavailable(payload["_unavailable"])
        sar = run_sar(scene, paths, detector)
    except Unavailable as exc:
        stage("detection", "unavailable", "UNAVAILABLE", str(exc))
        return report
    report.update(sar)
    stage("detection", "completed", "INFERRED", f"Experimental {detector} on real archived VV/VH; scores are not probability of oil")
    report["stages"].append("detection")
    report["provenance"]["imagery"] = "REAL archived Sentinel-1 VV/VH; asset hashes in scene"
    if not sar["detections"]:
        report["status"] = "no_candidates"
        stage("characterization", "not_applicable", "UNAVAILABLE", "No retained dark-slick candidates; not proof of clean water")
        return report
    report["spill"] = next((d for d in sar["detections"] if d.get("passesOilEvidenceGate")), sar["detections"][0])
    report["provenance"]["geometry"] = "INFERRED from experimental segmentation; approximate metric characterization"
    stage("characterization", "completed", "INFERRED", "Native-resolution mask and simplified outer-contour geometry")
    report["stages"].append("characterization")
    if sar["detector"].get("outcome") == "ANALYSIS_INCONCLUSIVE":
        return report
    try:
        if "environment" in scene:
            current_path = str((ROOT / "data" / scene["environment"]["current"]).resolve()) if "current" in scene["environment"] else None
            wind_path = str((ROOT / "data" / scene["environment"]["wind"]).resolve()) if "wind" in scene["environment"] else None
            env_provider = StrictEnvironmentProvider(current_path=current_path, wind_path=wind_path)
        else:
            env_provider = StrictEnvironmentProvider()
        with contextlib.closing(env_provider) as environment:
            centroid = report["spill"]["metrics"]["centroid"]
            environment.get_environment(centroid["lat"], centroid["lon"], timestamp(scene["acquiredAt"]))
            report["environment"] = environment.meta
            if not getattr(environment, "has_wind", True):
                report["provenance"]["environment"] = "REAL_REANALYSIS local current; wind intentionally disabled"
                stage("environment", "completed", "REAL_REANALYSIS", "Current valid at detection; wind advection disabled/neutral. Trajectory coverage checked on every RK4 sample")
            else:
                report["provenance"]["environment"] = "REAL_REANALYSIS local current/wind; hashes and sampling limits in environment"
                stage("environment", "completed", "REAL_REANALYSIS", "Both fields valid at detection; trajectory coverage checked on every RK4 sample")
            report["stages"].append("environment")
            for name, duration, backward in (("hindcast", hours, True), ("forecast", horizon, False)):
                try:
                    points = drift(centroid, scene["acquiredAt"], duration, environment, backward)
                    for point in points:
                        environment.get_environment(point["lat"], point["lon"], timestamp(point["timestamp"]))
                    report["backward" if backward else "forward"] = points
                    if points and abs(points[-1]["hours"]) < duration:
                        stage(name, "partial", "MODELED", "Trajectory truncated: reached land or data boundary")
                    else:
                        stage(name, "completed", "MODELED", "Scenario RK4; all sample positions/times covered by both fields")
                    report["stages"].append(name)
                    report["provenance"]["origin" if backward else "forecast"] = "MODELED RK4, conditional on scenario and reanalysis"
                except Unavailable as exc:
                    stage(name, "unavailable", "UNAVAILABLE", str(exc))
    except Unavailable as exc:
        report["environment"] = {"status": "UNAVAILABLE"}
        stage("environment", "unavailable", "UNAVAILABLE", str(exc))
    if report["backward"]:
        origin = dict(report["backward"][-1])
        center = timestamp(origin["timestamp"])
        window = {"start": iso(center-dt.timedelta(hours=1)), "end": iso(center+dt.timedelta(hours=1))}
        origin.update(releaseWindow=window, windowMeaning="Analyst scenario search window, not inferred release interval",
                      geometry={"type": "Point", "coordinates": [origin["lon"], origin["lat"]]})
        report["origin"] = origin
        try:
            ais_mode = payload.get("ais_mode", "OFFLINE_REPLAY")
            if ais_mode == "LIVE":
                raw_records = payload.get("live_ais_records")
                if raw_records is not None:
                    records, rejected = normalize_ais(raw_records)
                    vessels = [
                        {"mmsi": mmsi, "name": "Unknown", "type": "Unknown"}
                        for mmsi in {row["mmsi"] for row in records}
                    ]
                    meta = {"source": "AISStream", "kind": "LIVE", "records": len(records), "rejected": rejected, "coverage": "real-time"}
                    report["ais"] = meta
                    stage("ais", "completed", "LIVE", "Live AIS fixes queried from local PostGIS bounding box")
                    report["provenance"]["ais"] = "LIVE real-time AISStream fixes"
                else:
                    records, vessels, meta = [], [], {"source": "AIS_UNAVAILABLE", "kind": "NONE"}
                    report["ais"] = meta
                    stage("ais", "unavailable", "LIVE", "Live AIS is unavailable or returned error")
                    report["provenance"]["ais"] = "LIVE real-time AISStream unavailable"
            else:
                records, vessels, meta = historical_ais(origin, window, normalize_ais, timestamp)
                report["ais"] = meta
                stage("ais", "completed", "REAL", "Observed local AIS fixes normalized and restricted to scenario region/window")
                report["provenance"]["ais"] = "REAL operator-attested historical AIS; asset/manifest hashes in ais"
                
            candidates, anomalies = correlate(records, vessels, origin, window, report["backward"])
            for c in candidates:
                c["evidence"] = c["evidence"].replace("central release estimate", "analyst-selected scenario time")
            report.update(candidates=candidates, anomalies=anomalies,
                          leadingCandidate=candidates[0]["mmsi"] if candidates else None)
            stage("attribution", "completed", "INFERRED", "Compatibility with modeled origin only; not identification of polluter")
            report["stages"].extend(["ais", "attribution"])
        except Unavailable as exc:
            stage("ais", "unavailable", "UNAVAILABLE", str(exc))
    return report


def analyze(payload):
    report = _analyze(payload)
    mode = payload.get("mode", "REAL")
    if mode == "UPLOAD":
        report["disclaimer"] = "User-provided SAR with operator-declared acquisition and units; authenticity is not independently verified. Modeled trajectories and vessel compatibility are not legal proof."
        report["provenance"]["imagery"] = "OBSERVED user-provided SAR; source attestation and asset hashes retained, authenticity unverified"
        if report["stageStatus"]["detection"]["status"] == "completed":
            report["stageStatus"]["detection"]["reason"] = "Experimental hybrid on operator-declared uploaded VV/VH SAR; source and acquisition time not independently authenticated"
    elif report["scene"].get("source") == "cdse_sentinel1":
        report["provenance"]["imagery"] = "OBSERVED CDSE on-demand subset when available; catalog/window selection and asset hashes in scene"
    return finalize(report, mode)


if __name__ == "__main__":
    try:
        print(json.dumps(analyze(json.load(sys.stdin)), allow_nan=False))
    except Exception:
        print(json.dumps({"error": "REAL pipeline failed validation or processing"}), file=sys.stderr)
        sys.exit(1)