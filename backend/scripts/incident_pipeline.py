"""Credential-free incident pipeline. Synthetic adapters are explicit, never real observations.

Reuses characterize_spill's metric geometry and hindcast_runner's RK4 integrator.
No ML accuracy or legal responsibility is inferred from the heuristic scores.
"""
import csv
import datetime as dt
import json
import math
import random
import statistics
from report_contract import finalize
import sys
from pathlib import Path

from characterize_spill import characterize, compute_convex_hull_2d
from hindcast_runner import rk4_step_backward, haversine_km, bearing_deg

ROOT = Path(__file__).resolve().parents[1]
UTC = dt.timezone.utc
# Spatial/time evidence dominates. AIS gaps do NOT increase responsibility.
WEIGHTS = {"origin_proximity": .40, "temporal": .25, "trajectory": .20,
           "speed_consistency": .075, "heading_consistency": .075}


def timestamp(value):
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("Timestamps must include timezone")
    return parsed.astimezone(UTC)


def iso(value):
    return value.isoformat().replace("+00:00", "Z")


class DemoSatelliteProvider:
    def load(self, scenario):
        w, h = scenario["width"], scenario["height"]
        rng = random.Random(26143)
        pixels = []
        for y in range(h):
            row = []
            for x in range(w):
                # Two elongated low-backscatter regions; coast/invalid pixels excluded.
                slick = not scenario.get("clear") and ((x-48)/18)**2 + ((y-38)/5)**2 < 1
                secondary = not scenario.get("clear") and ((x-73)/7)**2 + ((y-59)/3)**2 < 1
                db = (-24 if slick or secondary else -12) + rng.gauss(0, 1.8)
                row.append(None if x < 3 or (x == 10 and y == 10) else db)
            pixels.append(row)
        return {k: scenario[k] for k in ("id", "source", "acquiredAt", "bbox",
                "width", "height", "polarization", "orbit")} | {
                    "pixels": pixels, "units": "synthetic sigma0 dB",
                    "resolution_m": [
                        (scenario["bbox"][2]-scenario["bbox"][0])*111320*math.cos(math.radians(15.24))/w,
                        (scenario["bbox"][3]-scenario["bbox"][1])*111320/h]}


def preprocess(scene):
    pixels = scene["pixels"]
    w, h = scene["width"], scene["height"]
    filtered = [[None]*w for _ in range(h)]
    for y in range(h):
        for x in range(w):
            if pixels[y][x] is None or not math.isfinite(pixels[y][x]):
                continue
            neighbours = [pixels[j][i] for j in range(max(0,y-1), min(h,y+2))
                          for i in range(max(0,x-1), min(w,x+2))
                          if pixels[j][i] is not None and math.isfinite(pixels[j][i])]
            filtered[y][x] = statistics.median(neighbours)
    return filtered


def detect(scene):
    image = preprocess(scene)
    w, h = scene["width"], scene["height"]
    values = [v for row in image for v in row if v is not None]
    if not values:
        return [], [[0]*w for _ in range(h)]
    threshold = statistics.median(values) - 6
    mask = [[int(v is not None and v < threshold) for v in row] for row in image]
    visited, candidates = set(), []
    west, south, east, north = scene["bbox"]

    def coord(x, y):
        return [west+x/w*(east-west), north-y/h*(north-south)]

    for y in range(h):
        for x in range(w):
            if not mask[y][x] or (x, y) in visited:
                continue
            component, queue = [], [(x, y)]
            visited.add((x, y))
            while queue:
                px, py = queue.pop()
                component.append((px, py))
                for nx, ny in ((px-1,py), (px+1,py), (px,py-1), (px,py+1)):
                    if 0 <= nx < w and 0 <= ny < h and mask[ny][nx] and (nx,ny) not in visited:
                        visited.add((nx,ny))
                        queue.append((nx,ny))
            if len(component) < 12:
                for px, py in component:
                    mask[py][px] = 0
                continue
            # Conservative convex envelope of pixel edges, not exact mask contour.
            corners = [tuple(coord(px+dx,py+dy)) for px,py in component
                       for dx,dy in ((0,0),(1,0),(1,1),(0,1))]
            hull = compute_convex_hull_2d(corners)
            ring = [list(p) for p in hull]
            if ring[0] != ring[-1]:
                ring.append(ring[0])
            metrics = characterize([tuple(p) for p in ring])
            contrast = statistics.median(values)-statistics.mean(image[py][px] for px,py in component)
            confidence = round(min(.8, .3 + max(0, contrast)/30), 3)
            candidates.append({
                "geometry": {"type":"Polygon", "coordinates":[ring]},
                "metrics": metrics["geometry"], "shape": metrics["shape"],
                "pixelCount": len(component), "contrast_db": round(contrast,2),
                "confidence": confidence,
                "confidenceMeaning": "Uncalibrated dark-slick-likeness index, not probability of oil",
                "geometryMethod": "Convex envelope of segmented pixel edges; may overestimate area",
                "source": scene["source"], "imageTimestamp": scene["acquiredAt"]})
    candidates.sort(key=lambda c:c["pixelCount"], reverse=True)
    return candidates, mask


def estimate_age(acquired, previous_clear, first_positive):
    now, clear, positive = map(timestamp, (acquired, previous_clear, first_positive))
    if not clear < positive <= now:
        raise ValueError("Invalid observation interval")
    low, high = (now-positive).total_seconds()/3600, (now-clear).total_seconds()/3600
    return {"estimatedHours": (low+high)/2, "minHours": low, "maxHours": high,
            "confidence": "low", "method": "interval_between_clear_and_first_positive_observations",
            "evidence": {"previousClearAt":previous_clear, "firstPositiveAt":first_positive},
            "caveat": "Assumes first detectability approximates release. Observations are synthetic; morphology alone cannot date oil."}


class FixtureEnvironmentProvider:
    def __init__(self, values):
        self.values = values

    def get_environment(self, lat, lon, when):
        return dict(self.values, data_source=self.values["source"])


def drift(centroid, acquired, hours, environment, backward=False):
    lat, lon = centroid["lat"], centroid["lon"]
    time = timestamp(acquired)
    e = environment.values
    points = []
    elapsed = 0
    while True:
        # Sensitivity envelope, NOT calibrated statistical confidence.
        uncertainty = .35 + elapsed*3600*e["velocity_uncertainty_ms"]/1000
        points.append({"lat":lat, "lon":lon, "timestamp":iso(time),
                       "hours": -elapsed if backward else elapsed,
                       "uncertaintyKm":round(uncertainty,3)})
        if elapsed >= hours:
            break
        step = min(1, hours-elapsed)
        signed_seconds = step*3600*(1 if backward else -1)
        try:
            next_lat, next_lon, _ = rk4_step_backward(lat, lon, time, signed_seconds, e["leeway"],
                                           provider=environment)
            next_time = time - dt.timedelta(seconds=signed_seconds)
            if hasattr(environment, "get_environment"):
                environment.get_environment(next_lat, next_lon, next_time)
        except ValueError as exc:
            msg = str(exc)
            if "missing or nonfinite" in msg or "outside spatial or temporal" in msg:
                break
            raise
        lat, lon = next_lat, next_lon
        time = next_time
        elapsed += step
    return points


def demo_ais(scenario):
    records = []
    acquired = timestamp(scenario["acquiredAt"])
    for vessel in scenario["vessels"]:
        for tick in range(25):
            hour = -12 + tick/2
            gap = vessel["gapHours"]
            if gap and gap[0] < hour < gap[1]:
                continue
            dx, dy = vessel["velocity_deg_h"]
            lon, lat = vessel["start"]
            speed = math.hypot(dx*111.32*math.cos(math.radians(lat)),dy*111.32)/1.852
            records.append({"mmsi":vessel["mmsi"], "timestamp":iso(acquired+dt.timedelta(hours=hour)),
                            "longitude":lon+(hour+12)*dx, "latitude":lat+(hour+12)*dy,
                            "speed":speed, "course":math.degrees(math.atan2(dx*math.cos(math.radians(lat)),dy))%360,
                            "heading":None, "navigation_status":None, "source":"synthetic_demo"})
    return normalize_ais(records)


def normalize_ais(records):
    valid, seen, rejected = [], set(), 0
    for row in records:
        try:
            mmsi = str(row.get("mmsi", row.get("MMSI", ""))).strip()
            when = timestamp(row["timestamp"])
            lat, lon = float(row["latitude"]), float(row["longitude"])
            speed = float(row["speed"]) if row.get("speed") not in (None, "") else None
            course = float(row["course"]) if row.get("course") not in (None, "") else None
            if not (len(mmsi)==9 and mmsi.isdigit() and -90 <= lat <=90
                    and -180 <= lon <=180 and (speed is None or 0 <= speed <= 80) and (course is None or 0 <= course <360)):
                raise ValueError("Invalid AIS position")
            key = (mmsi, iso(when))
            if key in seen:
                continue
            seen.add(key)
            valid.append(dict(row, mmsi=mmsi, timestamp=iso(when), latitude=lat,
                              longitude=lon, speed=speed, course=course))
        except (ValueError, KeyError, TypeError):
            rejected += 1
    return sorted(valid, key=lambda r:(r["mmsi"],r["timestamp"])), rejected


def load_ais_csv(path):
    """Local real-data seam. Canonical headers; never used silently in synthetic scenario."""
    with open(path, newline="", encoding="utf-8-sig") as stream:
        return normalize_ais(csv.DictReader(stream))


def correlate(records, vessels, origin, window, backward):
    center = timestamp(origin["timestamp"])
    start, end = timestamp(window["start"]), timestamp(window["end"])
    metadata = {v["mmsi"]: v for v in vessels}
    candidates, anomalies = [], []
    groups = {}
    for row in records:
        groups.setdefault(row["mmsi"], []).append(row)

    def distance(row):
        return haversine_km(row["latitude"],row["longitude"],origin["lat"],origin["lon"])

    for mmsi, track in groups.items():
        in_window = [r for r in track if start <= timestamp(r["timestamp"]) <= end]
        # Staged geographic and temporal filtering on observed fixes only.
        nearby = [r for r in in_window if distance(r) <= 15]
        if not nearby:
            continue
        gaps, segments, current_segment = [], [], [track[0]]
        for a,b in zip(track, track[1:]):
            ta, tb = timestamp(a["timestamp"]), timestamp(b["timestamp"])
            duration = (tb-ta).total_seconds()/3600
            if duration > 1:
                segments.append(current_segment)
                current_segment = [b]
                overlap = ta <= end and tb >= start
                relevance = max(0, 1-min(distance(a),distance(b))/15) if overlap else 0
                fraction = max(0,min(1,(center-ta).total_seconds()/(tb-ta).total_seconds()))
                event = {"mmsi":mmsi, "start":a, "end":b, "durationHours":duration,
                         "estimatedPosition":{"lat":a["latitude"]+fraction*(b["latitude"]-a["latitude"]),
                                              "lon":a["longitude"]+fraction*(b["longitude"]-a["longitude"])},
                         "method":"Linear gap corridor hypothesis, NOT observed position",
                         "overlapsOriginWindow":overlap, "anomalyScore":round(relevance,3),
                         "label":"AIS discontinuity / anomaly; does not prove intentional disabling"}
                gaps.append(event)
                anomalies.append(event)
            else:
                current_segment.append(b)
        segments.append(current_segment)
        closest = min(nearby, key=distance)
        dist = distance(closest)
        delta = abs((timestamp(closest["timestamp"])-center).total_seconds())/3600
        corridor = min(haversine_km(r["latitude"],r["longitude"],p["lat"],p["lon"])
                       for r in nearby for p in backward)
        speed_errors, heading_errors = [], []
        for a,b in zip(track,track[1:]):
            duration = (timestamp(b["timestamp"])-timestamp(a["timestamp"])).total_seconds()/3600
            if 0 < duration <= 1:
                inferred = haversine_km(a["latitude"],a["longitude"],b["latitude"],b["longitude"])/duration/1.852
                if a.get("speed") is not None:
                    speed_errors.append(abs(inferred-a.get("speed")))
                heading = bearing_deg(a["latitude"],a["longitude"],b["latitude"],b["longitude"])
                if a.get("course") is not None:
                    heading_errors.append(abs((heading-a.get("course")+180)%360-180))
        features = {
            "origin_proximity":math.exp(-dist/4),
            "temporal":math.exp(-delta/2),
            "trajectory":math.exp(-corridor/4),
            "speed_consistency":math.exp(-statistics.mean(speed_errors)/3) if speed_errors else 0,
            "heading_consistency":max(0,1-statistics.mean(heading_errors)/90) if heading_errors else 0}
        score = sum(features[k]*WEIGHTS[k] for k in WEIGHTS)
        span = (timestamp(track[-1]["timestamp"])-timestamp(track[0]["timestamp"])).total_seconds()/3600
        continuity = max(0,1-sum(g["durationHours"] for g in gaps)/span) if span else 0
        confidence = "low" if gaps or len(nearby)<3 else "moderate"
        meta = metadata.get(mmsi, {})
        candidates.append({
            "mmsi":mmsi, "name":meta.get("name","Unknown vessel"), "type":meta.get("type","Unknown"),
            "flag":None, "imo":None, "closestDistanceKm":round(dist,3),
            "timeDifferenceHours":round(delta,3), "trajectoryDistanceKm":round(corridor,3),
            "features":{k:round(v,4) for k,v in features.items()}, "score":round(score*100,2),
            "confidence":confidence, "aisContinuity":round(continuity,3),
            "continuityStatus":"Insufficient AIS continuity data" if len(track)<3 else "evaluated",
            "dataQuality": {"fixesInWindow": len(nearby), "speedComparisons": len(speed_errors), "courseComparisons": len(heading_errors)},
            "vesselTypeEvidence": "Identity context only; vessel type alone neither proves nor excludes compatibility",
            "track":track, "trackSegments":segments, "anomalies":gaps,
            "evidence":f"Observed fix {dist:.2f} km from modeled origin, {delta:.1f} h from central release estimate. "
                       f"{len(nearby)} observed fixes in search window. Scores measure compatibility, not guilt."})
    candidates.sort(key=lambda c:(-c["score"],c["mmsi"]))
    for rank, candidate in enumerate(candidates,1):
        candidate["rank"] = rank
    return candidates, anomalies


def _analyze(scene_id="demo-arabian-sea", horizon=24):
    if scene_id not in ("demo-arabian-sea", "demo-no-spill", "demo-inconclusive"):
        raise ValueError("Unknown scene; only the explicitly synthetic exercise is enabled")
    if horizon not in (24,48,72):
        raise ValueError("forecastHours must be 24, 48 or 72")
    scenario = json.loads((ROOT/"data/demo/scenario.json").read_text())
    scenario.update(id=scene_id, clear=scene_id != "demo-arabian-sea")
    scene = DemoSatelliteProvider().load(scenario)
    if scene_id == "demo-inconclusive":
        scene["pixels"] = [[None]*scene["width"] for _ in range(scene["height"])]
        return {"status": "partial", "outcome": "ANALYSIS_INCONCLUSIVE", "scene": scene,
                "forecastHours": horizon, "outcomeReason": "DEMO quality failure: SAR coverage is absent (synthetic exercise).",
                "detector": {"name": "demo-adaptive-dark-region", "version": "1.0", "status": "insufficient_coverage"},
                "stageStatus": {"detection": {"status": "unavailable", "kind": "DEMO/SYNTHETIC", "reason": "Zero valid SAR coverage"}}}
    detections, mask = detect(scene)
    if not detections:
        return {"status":"no_candidates", "scene":scene, "detections":[], "mask": mask,
                "forecastHours": horizon, "stages": ["scene_loaded", "preprocessed", "segmented", "report_generated"],
                "detector": {"name": "demo-adaptive-dark-region", "version": "1.0", "status": "synthetic",
                             "validFraction": sum(v is not None for row in scene["pixels"] for v in row)/(scene["width"]*scene["height"])}}
    spill = detections[0]
    age = estimate_age(scene["acquiredAt"],scenario["previousClearAt"],scenario["firstPositiveAt"])
    env = FixtureEnvironmentProvider(scenario["environment"])
    backward = drift(spill["metrics"]["centroid"],scene["acquiredAt"],age["estimatedHours"],env,True)
    forward = drift(spill["metrics"]["centroid"],scene["acquiredAt"],horizon,env)
    origin = backward[-1]
    window = {"start":iso(timestamp(scene["acquiredAt"])-dt.timedelta(hours=age["maxHours"])),
              "end":iso(timestamp(scene["acquiredAt"])-dt.timedelta(hours=age["minHours"]))}
    # Envelope includes age-window advection displacement as well as velocity sensitivity.
    speed = math.hypot(env.values["current_u_ms"]+env.values["leeway"]*env.values["wind_u_ms"],
                       env.values["current_v_ms"]+env.values["leeway"]*env.values["wind_v_ms"])
    origin = dict(origin, uncertaintyKm=round(origin["uncertaintyKm"]+
                  (age["maxHours"]-age["minHours"])/2*3.6*speed,3),
                  releaseWindow=window, geometry={"type":"Point","coordinates":[origin["lon"],origin["lat"]]})
    records, rejected = demo_ais(scenario)
    candidates, anomalies = correlate(records,scenario["vessels"],origin,window,backward)
    return {"status":"completed", "scene":scene, "mask":mask, "detections":detections,
            "spill":spill, "age":age, "origin":origin, "backward":backward,
            "forward":forward, "forecastHours":horizon, "environment":env.values,
            "candidates":candidates, "anomalies":anomalies,
            "leadingCandidate":candidates[0]["mmsi"] if candidates else None,
            "scoring":{"weights":WEIGHTS,"searchRadiusKm":15,"gapThresholdHours":1,
                       "note":"Heuristic compatibility index, uncalibrated. Gaps reduce confidence, not evidence of guilt. Speed/heading compare AIS with track motion, not oil drift."},
            "ais":{"records":len(records),"rejected":rejected,"vessels":len(scenario["vessels"]),
                   "retainedCandidates":len(candidates),"source":"synthetic_demo"},
            "stages":["scene_loaded","preprocessed","segmented","characterized","age_estimated",
                      "environment_loaded","hindcast","forecast","ais_normalized","candidates_filtered",
                      "trajectories_correlated","anomalies_evaluated","ranked","report_generated"],
            "provenance":{"imagery":"synthetic_demo","ais":"synthetic_demo","environment":"synthetic_demo",
                          "geometry":"derived_from_segmentation","age":"inferred_from_synthetic_observation_interval",
                          "origin":"modeled_RK4","forecast":"modeled_RK4","algorithmVersion":"prototype-1"},
            "uncertainty":["Dark SAR formations can be low wind, biogenic films or other lookalikes.",
                           "No trained oil classifier used. Two candidates detected; attribution is for largest only.",
                           "Constant-field point advection omits diffusion, weathering, coast interaction and waves.",
                           "Uncertainty radii are sensitivity bounds, not calibrated 95% confidence.",
                           "AIS gaps do not establish intentional disabling. Unidentified non-AIS vessels cannot be resolved.",
                           "Candidate ranking is not a finding of legal responsibility."],
            "disclaimer":scenario["disclaimer"]}


def analyze(scene_id="demo-arabian-sea", horizon=24):
    return finalize(_analyze(scene_id, horizon), "DEMO")


if __name__ == "__main__":
    try:
        payload = json.load(sys.stdin)
        print(json.dumps(analyze(payload.get("sceneId","demo-arabian-sea"),
                                 payload.get("forecastHours",24)), allow_nan=False))
    except Exception as exc:
        print(json.dumps({"error":str(exc)}), file=sys.stderr)
        sys.exit(1)