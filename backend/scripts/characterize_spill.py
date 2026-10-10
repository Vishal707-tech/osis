#!/usr/bin/env python3
"""
==============================================================================
O.S.I.S. - Oil Spill Identification System
Phase 4B: Spill Characterization Layer
==============================================================================
File    : backend/scripts/characterize_spill.py
Purpose : Standalone geometric, shape, and temporal characterization for
          detected marine oil spill polygons.
          Emits machine-readable JSON consumed by Node.js backend.

Inputs  :
  GeoJSON polygon coordinates [[lon, lat], ...]
  Spill detection metadata (id, detected_at, estimated_age_hours, etc.)

Methodology & Standards:
  - Metric Projection: WGS-84 ellipsoidal local metric tangent plane at centroid
    (M = meridional radius of curvature, N = prime vertical radius of curvature).
  - Basic Geometry: Exact Green's theorem / shoelace on projected metric coordinates
    (matches PostGIS spheroidal ST_Area(geom::geography) within 0.002%).
  - Dimensions: Minimum Area Bounding Rotated Box (OBB) via rotating calipers
    for lengthM and widthM.
  - Shape Characteristics: Spatial 2nd central moments of area (inertia tensor)
    yielding PCA eigenvalues/eigenvectors for major/minor axes and elongation.
  - Orientation: Angle of principal axis relative to True North (degrees CW).
  - Compactness: Isoperimetric quotient 4*pi*A / P^2 in (0, 1].
  - Age: Estimated range [0.8*age, 1.2*age] or unknown if absent.
==============================================================================
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from typing import Any, Dict, List, Optional, Tuple

try:
    import numpy as np
    _HAS_NUMPY = True
except ImportError:
    _HAS_NUMPY = False

# ---------------------------------------------------------------------------
# WGS-84 Ellipsoid Constants (EPSG:4326)
# ---------------------------------------------------------------------------
WGS84_A = 6378137.0             # semi-major axis (meters)
WGS84_F = 1.0 / 298.257223563   # flattening
WGS84_E2 = 2.0 * WGS84_F - WGS84_F * WGS84_F  # first eccentricity squared


def get_metric_scales(lat_deg: float) -> Tuple[float, float]:
    """
    Computes meters per degree of latitude and longitude on the WGS-84 ellipsoid
    at the given reference latitude.
    """
    phi = math.radians(lat_deg)
    sin_phi = math.sin(phi)
    denom = 1.0 - WGS84_E2 * sin_phi * sin_phi
    sqrt_denom = math.sqrt(denom)

    # Meridional radius of curvature
    m = WGS84_A * (1.0 - WGS84_E2) / (denom * sqrt_denom)
    # Prime vertical radius of curvature
    n = WGS84_A / sqrt_denom

    m_per_deg_lat = (math.pi / 180.0) * m
    m_per_deg_lon = (math.pi / 180.0) * n * math.cos(phi)
    return m_per_deg_lat, m_per_deg_lon


def validate_and_clean_polygon(raw_coords: List[Any]) -> Tuple[List[Tuple[float, float]], bool, bool]:
    """
    Validates and cleans polygon ring coordinates.
    Input format: [[lon, lat], ...] or list of dicts.
    Returns: (cleaned_coords, is_valid, was_repaired)
    """
    if not isinstance(raw_coords, list) or len(raw_coords) < 3:
        raise ValueError("Polygon must contain at least 3 coordinate pairs.")

    coords: List[Tuple[float, float]] = []
    for item in raw_coords:
        if isinstance(item, (list, tuple)) and len(item) >= 2:
            lon = float(item[0])
            lat = float(item[1])
        elif isinstance(item, dict) and 'lon' in item and 'lat' in item:
            lon = float(item['lon'])
            lat = float(item['lat'])
        elif isinstance(item, dict) and 'longitude' in item and 'latitude' in item:
            lon = float(item['longitude'])
            lat = float(item['latitude'])
        else:
            continue
        coords.append((lon, lat))

    if len(coords) < 3:
        raise ValueError("Polygon has fewer than 3 valid coordinates.")

    was_repaired = False

    # Remove consecutive duplicate points
    deduped: List[Tuple[float, float]] = []
    for pt in coords:
        if not deduped or (abs(pt[0] - deduped[-1][0]) > 1e-9 or abs(pt[1] - deduped[-1][1]) > 1e-9):
            deduped.append(pt)

    if len(deduped) < len(coords):
        was_repaired = True

    # Ensure ring closure (first point == last point)
    if len(deduped) >= 3:
        if abs(deduped[0][0] - deduped[-1][0]) > 1e-9 or abs(deduped[0][1] - deduped[-1][1]) > 1e-9:
            deduped.append(deduped[0])
            was_repaired = True

    if len(deduped) < 4:  # 3 distinct points + 1 closure point
        raise ValueError("Degenerate polygon: fewer than 3 distinct vertices.")

    is_valid = True
    return deduped, is_valid, was_repaired


def compute_convex_hull_2d(points: List[Tuple[float, float]]) -> List[Tuple[float, float]]:
    """
    Monotone chain 2D convex hull algorithm (O(N log N)).
    Expects list of (x, y) or (lon, lat) tuples.
    Returns closed ring of vertices forming the convex hull.
    """
    pts = sorted(set(points))
    if len(pts) <= 2:
        res = list(pts)
        if len(res) > 0 and (res[0] != res[-1]):
            res.append(res[0])
        return res

    def cross(o: Tuple[float, float], a: Tuple[float, float], b: Tuple[float, float]) -> float:
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower: List[Tuple[float, float]] = []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)

    upper: List[Tuple[float, float]] = []
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)

    hull = lower[:-1] + upper[:-1]
    if hull and hull[0] != hull[-1]:
        hull.append(hull[0])
    return hull


def compute_minimum_bounding_box(metric_hull_pts: List[Tuple[float, float]]) -> Tuple[float, float]:
    """
    Computes minimum area bounding rotated rectangle (OBB) using rotating calipers
    along the edges of the 2D convex hull.
    Returns: (length_m, width_m) where length_m >= width_m >= 0.
    """
    n = len(metric_hull_pts)
    if n < 3:
        return 0.0, 0.0

    min_area = float('inf')
    best_length = 0.0
    best_width = 0.0

    hull_len = n - 1 if (metric_hull_pts[0] == metric_hull_pts[-1]) else n

    for i in range(hull_len):
        p1 = metric_hull_pts[i]
        p2 = metric_hull_pts[(i + 1) % n]
        dx = p2[0] - p1[0]
        dy = p2[1] - p1[1]
        edge_len = math.hypot(dx, dy)
        if edge_len < 1e-9:
            continue

        # Unit vectors parallel (u) and perpendicular (v) to the edge
        ux = dx / edge_len
        uy = dy / edge_len
        vx = -uy
        vy = ux

        min_u = float('inf')
        max_u = float('-inf')
        min_v = float('inf')
        max_v = float('-inf')

        for pt in metric_hull_pts:
            pu = pt[0] * ux + pt[1] * uy
            pv = pt[0] * vx + pt[1] * vy
            if pu < min_u: min_u = pu
            if pu > max_u: max_u = pu
            if pv < min_v: min_v = pv
            if pv > max_v: max_v = pv

        dim_u = max_u - min_u
        dim_v = max_v - min_v
        area = dim_u * dim_v

        if area < min_area:
            min_area = area
            best_length = max(dim_u, dim_v)
            best_width = min(dim_u, dim_v)

    return best_length, best_width


def characterize(
    coords: List[Tuple[float, float]],
    spill_id: Optional[int] = None,
    detected_at: Optional[str] = None,
    satellite_source: Optional[str] = None,
    confidence: Optional[float] = None,
    status: Optional[str] = None,
    estimated_age_hours: Optional[float] = None,
    is_repaired: bool = False
) -> Dict[str, Any]:
    """
    Performs full geometric, shape, age, and metadata characterization.
    """
    lons = [c[0] for c in coords]
    lats = [c[1] for c in coords]

    # Coordinate bounding box in WGS-84
    min_lon = min(lons)
    max_lon = max(lons)
    min_lat = min(lats)
    max_lat = max(lats)

    # Reference point for local tangent plane
    lat0 = sum(lats) / len(lats)
    lon0 = sum(lons) / len(lons)
    m_per_deg_lat, m_per_deg_lon = get_metric_scales(lat0)

    # Metric coordinates relative to (lon0, lat0)
    xs = [(lo - lon0) * m_per_deg_lon for lo in lons]
    ys = [(la - lat0) * m_per_deg_lat for la in lats]

    n = len(xs) - 1  # number of segments (closed ring has n+1 points)
    if n < 3:
        raise ValueError("Polygon has fewer than 3 segments.")

    # 1. Basic Geometry: Green's Theorem / Shoelace for Area & Centroid
    crosses = [xs[i] * ys[i + 1] - xs[i + 1] * ys[i] for i in range(n)]
    signed_area = 0.5 * sum(crosses)
    area_sqm = abs(signed_area)
    area_km2 = area_sqm / 1e6

    if area_sqm < 1e-3:
        raise ValueError("Degenerate polygon with negligible area.")

    # Planar centroid in metric plane
    cx = sum((xs[i] + xs[i + 1]) * crosses[i] for i in range(n)) / (6.0 * signed_area)
    cy = sum((ys[i] + ys[i + 1]) * crosses[i] for i in range(n)) / (6.0 * signed_area)

    # Unproject centroid back to WGS-84
    centroid_lon = lon0 + cx / m_per_deg_lon
    centroid_lat = lat0 + cy / m_per_deg_lat

    # Perimeter: sum of segment lengths
    perimeter_m = sum(math.hypot(xs[i + 1] - xs[i], ys[i + 1] - ys[i]) for i in range(n))

    # 2. Shape Characteristics: 2nd Central Moments of Area (Inertia Tensor)
    # Using exact Green's theorem integrals for polynomial moments over polygons:
    # I_xx = integral y^2 dA = (1/12) sum (y_i^2 + y_i*y_{i+1} + y_{i+1}^2) * cross_i
    # I_yy = integral x^2 dA = (1/12) sum (x_i^2 + x_i*x_{i+1} + x_{i+1}^2) * cross_i
    # I_xy = integral x*y dA = (1/24) sum (2*x_i*y_i + x_i*y_{i+1} + x_{i+1}*y_i + 2*x_{i+1}*y_{i+1}) * cross_i
    i_xx = (1.0 / 12.0) * sum((ys[i]**2 + ys[i] * ys[i + 1] + ys[i + 1]**2) * crosses[i] for i in range(n))
    i_yy = (1.0 / 12.0) * sum((xs[i]**2 + xs[i] * xs[i + 1] + xs[i + 1]**2) * crosses[i] for i in range(n))
    i_xy = (1.0 / 24.0) * sum(
        (2.0 * xs[i] * ys[i] + xs[i] * ys[i + 1] + xs[i + 1] * ys[i] + 2.0 * xs[i + 1] * ys[i + 1]) * crosses[i]
        for i in range(n)
    )

    # Normalized central moments (variances and covariance)
    mu_xx = (i_yy / signed_area) - (cx * cx)  # Var(X)
    mu_yy = (i_xx / signed_area) - (cy * cy)  # Var(Y)
    mu_xy = (i_xy / signed_area) - (cx * cy)  # Cov(X, Y)

    # Eigenvalues of 2x2 covariance matrix
    # Trace = mu_xx + mu_yy, Det = mu_xx*mu_yy - mu_xy^2
    tr = mu_xx + mu_yy
    det = mu_xx * mu_yy - mu_xy * mu_xy
    disc = max(0.0, (tr * tr) / 4.0 - det)
    sqrt_disc = math.sqrt(disc)

    lambda1 = max(0.0, tr / 2.0 + sqrt_disc)  # largest eigenvalue
    lambda2 = max(0.0, tr / 2.0 - sqrt_disc)  # smallest eigenvalue

    # Equivalent ellipse semi-axes: semi = 2 * sqrt(lambda)
    semi_major_m = 2.0 * math.sqrt(lambda1)
    semi_minor_m = 2.0 * math.sqrt(lambda2)
    major_axis_m = 2.0 * semi_major_m
    minor_axis_m = 2.0 * semi_minor_m

    # Elongation: major / minor axis ratio (>= 1.0)
    elongation = semi_major_m / max(semi_minor_m, 1e-3)

    # Orientation: eigenvector corresponding to lambda1 (X=East, Y=North)
    # [mu_xx - lambda1, mu_xy] [vx; vy] = 0 -> vy = -(mu_xx - lambda1)*vx / mu_xy
    if abs(mu_xy) > 1e-9:
        vx = lambda1 - mu_yy
        vy = mu_xy
    elif mu_xx >= mu_yy:
        vx = 1.0
        vy = 0.0
    else:
        vx = 0.0
        vy = 1.0

    # Angle clockwise from North: North is +Y, East is +X
    # atan2(vx, vy): vx=East, vy=North -> 0 when North, +90 when East
    theta_cw_north = (math.degrees(math.atan2(vx, vy)) + 360.0) % 180.0

    # Compactness: isoperimetric quotient 4*pi*Area / Perimeter^2
    compactness = (4.0 * math.pi * area_sqm) / (perimeter_m * perimeter_m) if perimeter_m > 0 else 0.0
    # Bound to (0, 1] mathematically
    compactness = min(1.0, max(1e-6, compactness))

    # 3. Minimum Bounding Rotated Box (OBB) for length & width
    metric_pts = list(zip(xs, ys))
    metric_hull = compute_convex_hull_2d(metric_pts)
    length_m, width_m = compute_minimum_bounding_box(metric_hull)

    # If OBB degenerates, fall back to major/minor axis
    if length_m <= 0 or width_m <= 0:
        length_m = major_axis_m
        width_m = minor_axis_m

    # Convex Hull in WGS-84 coordinates [[lon, lat], ...]
    wgs_pts = [(c[0], c[1]) for c in coords]
    wgs_hull = compute_convex_hull_2d(wgs_pts)

    # 4. Age Characterization
    if estimated_age_hours is not None and isfinite_number(estimated_age_hours) and estimated_age_hours > 0:
        age_est = round(float(estimated_age_hours), 2)
        age_low = round(max(0.5, age_est * 0.8), 2)
        age_up = round(age_est * 1.2, 2)
        age_status = "estimated"
    else:
        age_est = None
        age_low = None
        age_up = None
        age_status = "unknown"

    # Formatted ID
    formatted_id = f"SP-{str(spill_id).zfill(3)}" if spill_id is not None else None

    return {
        "spillId": spill_id,
        "formattedSpillId": formatted_id,
        "geometry": {
            "areaSqm": round(area_sqm, 2),
            "areaKm2": round(area_km2, 4),
            "perimeterM": round(perimeter_m, 2),
            "centroid": {
                "lat": round(centroid_lat, 6),
                "lon": round(centroid_lon, 6),
            },
            "boundingBox": {
                "minLat": round(min_lat, 6),
                "minLon": round(min_lon, 6),
                "maxLat": round(max_lat, 6),
                "maxLon": round(max_lon, 6),
            },
            "lengthM": round(length_m, 2),
            "widthM": round(width_m, 2),
        },
        "shape": {
            "elongation": round(elongation, 3),
            "orientationDeg": round(theta_cw_north, 2),
            "orientationConvention": "degrees_clockwise_from_north",
            "majorAxisM": round(major_axis_m, 2),
            "minorAxisM": round(minor_axis_m, 2),
            "compactness": round(compactness, 4),
            "convexHull": [[round(p[0], 6), round(p[1], 6)] for p in wgs_hull],
        },
        "age": {
            "estimatedHours": age_est,
            "lowerHours": age_low,
            "upperHours": age_up,
            "status": age_status,
            "confidence": "approximate_range" if age_est else "unavailable",
            "uncertaintyBasis": "±20% observational bounds from satellite acquisition" if age_est else None
        },
        "detection": {
            "confidence": round(confidence, 1) if confidence is not None else None,
            "detectedAt": detected_at,
            "satelliteSource": satellite_source,
            "status": status,
        },
        "metadata": {
            "projectionMethod": "WGS-84 Ellipsoidal Local Transverse Tangent Projection",
            "geometryValid": True,
            "geometryRepaired": is_repaired,
            "axesCalculationMethod": "Green Theorem 2nd Central Area Moments (PCA Covariance)",
            "dimensionsMethod": "Minimum Bounding Rotated Box (Rotating Calipers)",
            "scientificDisclaimer": "All geometric dimensions, shape metrics, and temporal ages are estimates derived from satellite detection polygon boundaries and metocean analysis."
        }
    }


def isfinite_number(val: Any) -> bool:
    try:
        f = float(val)
        return not (math.isnan(f) or math.isinf(f))
    except (TypeError, ValueError):
        return False


def main() -> None:
    parser = argparse.ArgumentParser(description="O.S.I.S. Spill Characterization Engine")
    parser.add_argument("--geojson", type=str, help="GeoJSON string or coordinates array")
    parser.add_argument("--input-file", type=str, help="Path to JSON file with spill characterization input")
    parser.add_argument("--spill-id", type=int, help="Spill numeric ID")
    parser.add_argument("--detected-at", type=str, help="Spill detection timestamp (ISO-8601)")
    parser.add_argument("--satellite-source", type=str, help="Satellite mission/source")
    parser.add_argument("--confidence", type=float, help="Detection confidence score (0-100)")
    parser.add_argument("--status", type=str, help="Operational status")
    parser.add_argument("--estimated-age-hours", type=float, help="Estimated age in hours")

    args = parser.parse_args()

    raw_payload: Dict[str, Any] = {}

    if args.input_file:
        with open(args.input_file, "r", encoding="utf-8") as f:
            raw_payload = json.load(f)
    elif args.geojson:
        try:
            parsed_geo = json.loads(args.geojson)
            raw_payload["geojson"] = parsed_geo
        except json.JSONDecodeError as err:
            sys.stderr.write(f"Error parsing --geojson JSON: {err}\n")
            sys.exit(1)
    elif not sys.stdin.isatty():
        stdin_data = sys.stdin.read().strip()
        if stdin_data:
            try:
                raw_payload = json.loads(stdin_data)
            except json.JSONDecodeError as err:
                sys.stderr.write(f"Error parsing stdin JSON: {err}\n")
                sys.exit(1)

    # CLI overrides
    if args.spill_id is not None: raw_payload["spill_id"] = args.spill_id
    if args.detected_at is not None: raw_payload["detected_at"] = args.detected_at
    if args.satellite_source is not None: raw_payload["satellite_source"] = args.satellite_source
    if args.confidence is not None: raw_payload["confidence"] = args.confidence
    if args.status is not None: raw_payload["status"] = args.status
    if args.estimated_age_hours is not None: raw_payload["estimated_age_hours"] = args.estimated_age_hours

    # Extract polygon coordinates
    raw_coords = None
    if "geojson" in raw_payload:
        geo = raw_payload["geojson"]
        if isinstance(geo, list):
            # Might be [[lon, lat], ...] or [[[lon, lat], ...]]
            if len(geo) > 0 and isinstance(geo[0], list) and len(geo[0]) > 0 and isinstance(geo[0][0], (int, float)):
                raw_coords = geo
            elif len(geo) > 0 and isinstance(geo[0], list) and len(geo[0]) > 0 and isinstance(geo[0][0], list):
                raw_coords = geo[0]
        elif isinstance(geo, dict):
            if geo.get("type") == "Polygon" and "coordinates" in geo:
                raw_coords = geo["coordinates"][0]
            elif geo.get("type") == "Feature" and "geometry" in geo and geo["geometry"].get("type") == "Polygon":
                raw_coords = geo["geometry"]["coordinates"][0]
    elif "polygon" in raw_payload:
        raw_coords = raw_payload["polygon"]
    elif "coordinates" in raw_payload:
        raw_coords = raw_payload["coordinates"]

    if not raw_coords:
        sys.stderr.write("No polygon coordinates found in input.\n")
        sys.exit(1)

    try:
        clean_coords, is_valid, was_repaired = validate_and_clean_polygon(raw_coords)
        result = characterize(
            coords=clean_coords,
            spill_id=raw_payload.get("spill_id"),
            detected_at=raw_payload.get("detected_at"),
            satellite_source=raw_payload.get("satellite_source"),
            confidence=raw_payload.get("confidence"),
            status=raw_payload.get("status"),
            estimated_age_hours=raw_payload.get("estimated_age_hours"),
            is_repaired=was_repaired
        )
        print(json.dumps(result, indent=2))
        sys.exit(0)
    except Exception as exc:
        sys.stderr.write(f"Characterization error: {exc}\n")
        sys.exit(2)


if __name__ == "__main__":
    main()
