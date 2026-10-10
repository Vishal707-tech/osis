import sys
import os
import json
import subprocess
from pathlib import Path
import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import importlib
m = importlib.import_module("hybrid-spill-detector")

def test_fully_water_candidate():
    """1. fully water candidate -> accepted"""
    cmask = np.zeros((10, 10), dtype=bool)
    cmask[2:8, 2:8] = True
    candidate = {
        "cmask": cmask, "area": 36, "heuristicScore": 0.8,
        "vvDampingDb": 5.0, "vvVhDifferenceDb": 2.0
    }
    pose_res = {
        "probs": np.zeros((5, 10, 10)),
        "predMask": np.zeros((10, 10), dtype=int)
    }
    pose_res["probs"][1, cmask] = 0.9  # DL oil
    pose_res["predMask"][cmask] = 1

    dist_to_land = np.full((10, 10), 9999.0)
    geo_land_mask = np.zeros((10, 10), dtype=bool)

    res = m.fuse_evidence(candidate, pose_res, dist_to_land, False, geo_land_mask)
    assert res["fusedScore"] > 0.5
    assert res["rule"] == "open_water_dual_confirmed"

def test_clearly_land_candidate():
    """2. clearly land candidate -> rejected"""
    cmask = np.zeros((10, 10), dtype=bool)
    cmask[2:8, 2:8] = True
    candidate = {
        "cmask": cmask, "area": 36, "heuristicScore": 0.8,
        "vvDampingDb": 5.0, "vvVhDifferenceDb": 2.0
    }
    pose_res = {
        "probs": np.zeros((5, 10, 10)),
        "predMask": np.zeros((10, 10), dtype=int)
    }
    pose_res["probs"][1, cmask] = 0.9  # DL oil thinks it's oil
    pose_res["predMask"][cmask] = 1

    dist_to_land = np.full((10, 10), 0.0)
    geo_land_mask = np.ones((10, 10), dtype=bool) # 100% geographically land

    res = m.fuse_evidence(candidate, pose_res, dist_to_land, True, geo_land_mask)
    assert res["fusedScore"] == 0.0
    assert res["rule"] == "geographic_land_rejected"

def test_unavailable_geographic_land_validation_fails_closed():
    cmask = np.zeros((10, 10), dtype=bool)
    cmask[2:8, 2:8] = True
    candidate = {
        "cmask": cmask, "area": 36, "heuristicScore": 0.8,
        "vvDampingDb": 5.0, "vvVhDifferenceDb": 2.0
    }
    pose_res = {
        "probs": np.zeros((5, 10, 10)),
        "predMask": np.zeros((10, 10), dtype=int)
    }
    pose_res["probs"][1, cmask] = 0.9
    pose_res["predMask"][cmask] = 1

    res = m.fuse_evidence(candidate, pose_res, np.full((10, 10), 999.0), False)
    assert res["fusedScore"] == 0.0
    assert res["rule"] == "geographic_land_validation_unavailable"
    assert res["evidence"]["geoLandFraction"] is None
    assert res["evidence"]["geographic_land_validation"] == "UNAVAILABLE"

def test_mixed_land_water_candidate():
    """3. mixed land/water candidate -> evaluated using water fraction"""
    cmask = np.zeros((10, 10), dtype=bool)
    cmask[0:10, 0:10] = True
    candidate = {
        "cmask": cmask, "area": 100, "heuristicScore": 0.8,
        "vvDampingDb": 5.0, "vvVhDifferenceDb": 2.0
    }
    pose_res = {
        "probs": np.zeros((5, 10, 10)),
        "predMask": np.zeros((10, 10), dtype=int)
    }
    # 20% land geographically, which is < 30% threshold
    geo_land_mask = np.zeros((10, 10), dtype=bool)
    geo_land_mask[0:2, :] = True
    
    res = m.fuse_evidence(candidate, pose_res, np.full((10, 10), 50.0), True, geo_land_mask)
    assert res["fusedScore"] > 0.0
    assert res["evidence"]["geoLandFraction"] == 0.2

    # 60% land geographically, which is > 50% threshold
    geo_land_mask[0:6, :] = True
    res2 = m.fuse_evidence(candidate, pose_res, np.full((10, 10), 50.0), True, geo_land_mask)
    assert res2["fusedScore"] == 0.0
    assert res2["rule"] == "geographic_land_rejected"

def test_coastline_touching_candidate():
    """4. coastline-touching candidate -> does not crash and handles proximity correctly"""
    cmask = np.zeros((100, 100), dtype=bool)
    cmask[50:60, 50:60] = True
    candidate = {
        "cmask": cmask, "area": 100, "heuristicScore": 0.8,
        "vvDampingDb": 5.0, "vvVhDifferenceDb": 2.0
    }
    pose_res = {
        "probs": np.zeros((5, 100, 100)),
        "predMask": np.zeros((100, 100), dtype=int)
    }
    # POSEatSea misclassifies it as lookalike
    pose_res["probs"][2, cmask] = 0.9 
    pose_res["predMask"][cmask] = 2

    geo_land_mask = np.zeros((100, 100), dtype=bool)
    # Coastal proximity kicks in (distance is 10 pixels to land)
    dist_to_land = np.full((100, 100), 10.0)

    res = m.fuse_evidence(candidate, pose_res, dist_to_land, True, geo_land_mask)
    # The heuristic score should be preserved due to coastal proximity logic
    assert res["fusedScore"] > 0.0
    assert res["rule"] == "coastal_preserved"

def test_coordinate_consistency():
    """9. coordinate/georeferencing consistency"""
    # 512x512 raster
    # Bbox: min_lon=10, min_lat=10, max_lon=15, max_lat=15
    aoi_bbox = [10.0, 10.0, 15.0, 15.0]
    
    # Raster center is rx=255.5, ry=255.5
    # Expect geo_lon = 10 + (256)*5/512 = 12.5
    # Expect geo_lat = 15 - (256)*5/512 = 12.5
    lon, lat = m.raster_to_geo_coords(255.5, 255.5, aoi_bbox, 512, 512)
    assert abs(lon - 12.5) < 0.01
    assert abs(lat - 12.5) < 0.01
    
    # Check top-left corner
    lon_ul, lat_ul = m.raster_to_geo_coords(-0.5, -0.5, aoi_bbox, 512, 512)
    assert abs(lon_ul - 10.0) < 0.01
    assert abs(lat_ul - 15.0) < 0.01

def test_empty_candidate():
    """5. empty/no candidate -> unchanged/handled safely"""
    cmask = np.zeros((10, 10), dtype=bool)
    candidate = {
        "cmask": cmask, "area": 0, "heuristicScore": 0.8,
        "vvDampingDb": 5.0, "vvVhDifferenceDb": 2.0
    }
    pose_res = {
        "probs": np.zeros((5, 10, 10)),
        "predMask": np.zeros((10, 10), dtype=int)
    }
    geo_land_mask = np.zeros((10, 10), dtype=bool)
    res = m.fuse_evidence(candidate, pose_res, np.full((10, 10), 999.0), False, geo_land_mask)
    assert res["fusedScore"] == 0.0

def test_malformed_geometry():
    """6. malformed geometry -> handled safely"""
    # Just an array of incorrect dimensions or missing fields, ensuring no unhandled crash
    cmask = np.zeros((0, 0), dtype=bool)
    candidate = {
        "cmask": cmask, "area": 0, "heuristicScore": 0.8,
        "vvDampingDb": 5.0, "vvVhDifferenceDb": 2.0
    }
    pose_res = {
        "probs": np.zeros((5, 0, 0)),
        "predMask": np.zeros((0, 0), dtype=int)
    }
    geo_land_mask = np.zeros((0, 0), dtype=bool)
    res = m.fuse_evidence(candidate, pose_res, np.zeros((0, 0)), False, geo_land_mask)
    assert res["fusedScore"] == 0.0

def test_karnataka_regression():
    """7. Karnataka false-positive regression"""
    from global_land_mask import globe
    min_lon, min_lat, max_lon, max_lat = 74.7, 13.2, 74.78, 13.28
    rxs = np.arange(512)
    rys = np.arange(512)
    lons = min_lon + (rxs + 0.5) * (max_lon - min_lon) / 512.0
    lats = max_lat - (rys + 0.5) * (max_lat - min_lat) / 512.0
    lon_grid, lat_grid = np.meshgrid(lons, lats)
    geo_land_mask = globe.is_land(lat_grid, lon_grid)

    cmask = np.zeros((512, 512), dtype=bool)
    # The Karnataka false positive covers a large part of the eastern landmass
    cmask[:, 300:] = True 

    candidate = {
        "cmask": cmask, "area": 1000, "heuristicScore": 0.8,
        "vvDampingDb": 5.0, "vvVhDifferenceDb": 2.0
    }
    pose_res = {
        "probs": np.zeros((5, 512, 512)),
        "predMask": np.zeros((512, 512), dtype=int)
    }
    pose_res["probs"][1, cmask] = 0.9
    pose_res["predMask"][cmask] = 1

    res = m.fuse_evidence(candidate, pose_res, np.full((512, 512), 999.0), False, geo_land_mask)
    assert res["fusedScore"] == 0.0
    assert res["rule"] == "geographic_land_rejected"

def test_oman_regression():
    """8. Oman positive regression"""
    from global_land_mask import globe
    min_lon, min_lat, max_lon, max_lat = 56.24, 17.40, 56.43, 17.59
    rxs = np.arange(512)
    rys = np.arange(512)
    lons = min_lon + (rxs + 0.5) * (max_lon - min_lon) / 512.0
    lats = max_lat - (rys + 0.5) * (max_lat - min_lat) / 512.0
    lon_grid, lat_grid = np.meshgrid(lons, lats)
    geo_land_mask = globe.is_land(lat_grid, lon_grid)

    cmask = np.zeros((512, 512), dtype=bool)
    # Oman slick is near the coast, but covers primarily water
    cmask[150:350, 150:350] = True 

    candidate = {
        "cmask": cmask, "area": 40000, "heuristicScore": 0.8,
        "vvDampingDb": 5.0, "vvVhDifferenceDb": 2.0
    }
    pose_res = {
        "probs": np.zeros((5, 512, 512)),
        "predMask": np.zeros((512, 512), dtype=int)
    }
    pose_res["probs"][1, cmask] = 0.9
    pose_res["predMask"][cmask] = 1

    res = m.fuse_evidence(candidate, pose_res, np.full((512, 512), 999.0), False, geo_land_mask)
    assert res["fusedScore"] > 0.5
    assert res["rule"] != "geographic_land_rejected"

