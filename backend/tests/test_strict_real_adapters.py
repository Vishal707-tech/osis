"""Synthetic TEST fixtures only. Never installed as runtime REAL assets."""
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from incident_pipeline import normalize_ais, timestamp, drift, correlate
from strict_real_adapters import StrictEnvironmentProvider, Unavailable, historical_ais, asset
import real_incident_pipeline as pipeline

HAS_NETCDF = all(importlib.util.find_spec(m) for m in ("numpy", "xarray", "netCDF4"))


class AssetTests(unittest.TestCase):
    def test_size_and_read_errors_are_unavailable(self):
        with tempfile.TemporaryDirectory() as folder:
            file = Path(folder) / "test-only"
            file.write_bytes(b"1234")
            with self.assertRaisesRegex(Unavailable, "size"):
                asset(file, 3)
            with patch.object(Path, "open", side_effect=PermissionError("private path")):
                with self.assertRaisesRegex(Unavailable, "cannot be read"):
                    asset(file, 4)


@unittest.skipUnless(HAS_NETCDF, "Requires existing numpy/xarray/netCDF4 environment")
class EnvironmentTests(unittest.TestCase):
    def setUp(self):
        import numpy as np
        import xarray as xr
        self.np, self.xr = np, xr
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.current = Path(self.temp.name) / "current.nc"
        self.wind = Path(self.temp.name) / "wind.nc"
        self.when = timestamp("2024-06-19T00:00:00Z")
        self.times = np.arange(np.datetime64("2024-06-18"), np.datetime64("2024-06-21"), np.timedelta64(1, "h"))
        self.write(self.current, ("uo", "vo"))
        self.write(self.wind, ("u10", "v10"))

    def write(self, path, names, value=.1, times=None, units="m/s", lats=None):
        times = self.times if times is None else times
        lats = [13.1, 13.2, 13.3, 13.4] if lats is None else lats
        shape = (len(times), len(lats), 4)
        ds = self.xr.Dataset({name: (("time", "latitude", "longitude"), self.np.full(shape, value), {"units": units}) for name in names},
            coords={"time": times, "latitude": lats, "longitude": [74.6, 74.7, 74.8, 74.9]})
        ds.to_netcdf(path, engine="netcdf4")

    def provider(self):
        env = StrictEnvironmentProvider(self.current, self.wind)
        self.addCleanup(env.close)
        return env

    def test_supported_sampling_and_rk4(self):
        env = self.provider()
        sample = env.get_environment(13.24, 74.74, self.when)
        self.assertEqual(sample["wind_u_ms"], .1)
        self.assertEqual(len(env.meta["currentSha256"]), 64)
        backward = drift({"lat": 13.24, "lon": 74.74}, "2024-06-19T00:00:00Z", 6, env, True)
        forward = drift(backward[-1], backward[-1]["timestamp"], 6, env)
        self.assertAlmostEqual(forward[-1]["lon"], 74.74, places=6)

    def test_outside_coverage_and_naive_time(self):
        env = self.provider()
        for lat, lon, when in [(0, 74.74, self.when), (13.24, 0, self.when),
                               (13.24, 74.74, self.when-dt.timedelta(days=10)),
                               (13.24, 74.74, self.when.replace(tzinfo=None))]:
            with self.assertRaises(Unavailable):
                env.get_environment(lat, lon, when)

    def test_stale_gap_rejected_even_inside_range(self):
        self.write(self.wind, ("u10", "v10"), times=self.np.array(["2024-06-18", "2024-06-20"], dtype="datetime64[ns]"))
        with self.assertRaisesRegex(Unavailable, "stale"):
            self.provider().get_environment(13.24, 74.74, self.when)

    def test_lazy_read_failure_is_unavailable_and_does_not_leak_paths(self):
        env = self.provider()
        with patch.object(self.xr.DataArray, "isel", side_effect=OSError("private file path")):
            with self.assertRaisesRegex(Unavailable, "could not be read") as error:
                env.get_environment(13.24, 74.74, self.when)
        self.assertNotIn("private", str(error.exception))

    def test_aliases_descending_coordinates_and_surface_depth(self):
        with self.xr.open_dataset(self.current) as original:
            ds = original.load().rename({"latitude": "lat", "longitude": "lon", "time": "valid_time"})
        ds = ds.isel(lat=slice(None, None, -1)).expand_dims(depth=[.5, 10])
        ds.to_netcdf(self.current, engine="netcdf4")
        env = self.provider()
        self.assertEqual(env.get_environment(13.24, 74.74, self.when)["current_u_ms"], .1)
        env.close()
        ds.assign_coords(depth=[5, 10]).to_netcdf(self.current, engine="netcdf4")
        with self.assertRaisesRegex(Unavailable, "surface"):
            self.provider()

    def test_rk4_rejects_midstep_gap_and_spatial_gap(self):
        self.write(self.wind, ("u10", "v10"), times=self.np.array(["2024-06-19T00:00", "2024-06-19T03:00"], dtype="datetime64[ns]"))
        env = self.provider()
        with self.assertRaisesRegex(Unavailable, "stale"):
            drift({"lat": 13.24, "lon": 74.74}, "2024-06-19T00:00:00Z", 3, env)
        env.close()
        self.write(self.wind, ("u10", "v10"), lats=[12, 14])
        with self.assertRaisesRegex(Unavailable, "grid cell"):
            self.provider().get_environment(13.24, 74.74, self.when)

    def test_missing_nonfinite_units_and_coordinates(self):
        for value in (float("nan"), float("inf")):
            self.write(self.wind, ("u10", "v10"), value=value)
            env = self.provider()
            with self.assertRaisesRegex(Unavailable, "nonfinite"):
                env.get_environment(13.24, 74.74, self.when)
            env.close()
        for names, units, lats in [(('u10',), 'm/s', None), (('u10', 'v10'), 'knots', None),
                                    (('u10', 'v10'), 'm/s', [13.1, 13.1])]:
            self.write(self.wind, names, units=units, lats=lats)
            with self.assertRaises(Unavailable):
                self.provider()

    def test_lazy_failure_during_trajectory_retains_serializable_partial_report(self):
        env = self.provider()
        sample = env._sample
        calls = 0
        def fail_after_detection(*args):
            nonlocal calls
            calls += 1
            if calls > 1:
                raise OSError("private NetCDF path")
            return sample(*args)
        scene, _ = pipeline.load_scene("s1a-20240619-karnataka")
        sar = {"scene": scene, "mask": [], "detector": {"name": "test_double"},
               "detections": [{"metrics": {"centroid": {"lat": 13.24, "lon": 74.74}}}]}
        with patch.object(env, "_sample", side_effect=fail_after_detection), patch.object(pipeline, "StrictEnvironmentProvider", return_value=env), patch.object(pipeline, "run_sar", return_value=sar), patch.object(pipeline, "historical_ais") as ais:
            report = pipeline.analyze({"sceneId": scene["id"]})
        ais.assert_not_called()
        self.assertEqual(report["status"], "partial")
        self.assertEqual(report["spill"], sar["detections"][0])
        self.assertEqual(report["stageStatus"]["environment"]["status"], "completed")
        for name in ("hindcast", "forecast"):
            self.assertEqual(report["stageStatus"][name]["status"], "unavailable")
        self.assertEqual(report["backward"], [])
        self.assertEqual(report["forward"], [])
        self.assertIsNone(report["origin"])
        self.assertIsNone(report["age"])
        self.assertNotIn("private NetCDF path", json.dumps(report, allow_nan=False))
        self.assertEqual(env._opened, [])

    def test_partial_pipeline_models_origin_without_claiming_age_or_ais(self):
        scene, _ = pipeline.load_scene("s1a-20240619-karnataka")
        sar = {"scene": scene, "mask": [], "detector": {"name": "test_double"},
               "detections": [{"metrics": {"centroid": {"lat": 13.24, "lon": 74.74}}}]}
        with patch.dict(os.environ, {"REAL_CURRENT_NETCDF": str(self.current), "REAL_WIND_NETCDF": str(self.wind), "REAL_AIS_CSV": ""}), patch.object(pipeline, "run_sar", return_value=sar):
            report = pipeline.analyze({"sceneId": scene["id"], "hindcastHours": 6, "forecastHours": 24})
        self.assertEqual(len(report["forward"]), 25)
        self.assertEqual(len(report["backward"]), 7)
        self.assertIsNotNone(report["origin"])
        self.assertIsNone(report["age"])
        self.assertEqual(report["stageStatus"]["ais"]["status"], "unavailable")
        self.assertEqual(report["candidates"], [])
        json.dumps(report, allow_nan=False)


class AISTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.csv = Path(self.temp.name) / "test-only.csv"
        self.manifest = Path(self.temp.name) / "coverage.json"
        self.csv.write_text("mmsi,timestamp,latitude,longitude,speed,course,name\n"
            "123456789,2024-06-19T00:00:00Z,13.24,74.74,3,90,Test-only vessel\n"
            "123456789,2024-06-19T00:00:00Z,13.24,74.74,3,90,Duplicate\n"
            "123456789,2024-06-19T00:10:00Z,nan,74.74,3,90,Invalid\n"
            "987654321,2026-09-04T00:00:00Z,13.24,74.74,3,90,Wrong date\n")
        self.meta = {"source": "SYNTHETIC TEST FIXTURE, not operational data", "dataKind": "observed",
            "speedUnits": "knots", "courseUnits": "degrees", "bbox": [74, 13, 75, 14],
            "start": "2024-06-18T00:00:00Z", "end": "2024-06-20T00:00:00Z"}
        self.manifest.write_text(json.dumps(self.meta))
        env = patch.dict(os.environ, {"REAL_AIS_CSV": str(self.csv), "REAL_AIS_MANIFEST": str(self.manifest)})
        env.start()
        self.addCleanup(env.stop)
        self.origin = {"lat": 13.24, "lon": 74.74, "timestamp": "2024-06-19T00:00:00Z"}
        self.window = {"start": "2024-06-18T23:00:00Z", "end": "2024-06-19T01:00:00Z"}

    def load(self):
        return historical_ais(self.origin, self.window, normalize_ais, timestamp)

    def test_normalizes_deduplicates_filters_and_reuses_scoring(self):
        rows, vessels, meta = self.load()
        self.assertEqual(len(rows), 1)
        self.assertEqual(meta["rejected"], 1)
        self.assertEqual(len(meta["assetSha256"]), 64)
        candidates, _ = correlate(rows, vessels, self.origin, self.window, [self.origin])
        self.assertEqual(candidates[0]["name"], "Test-only vessel")
        self.assertEqual(candidates[0]["confidence"], "low")

    def test_requires_observed_manifest_units_and_coverage(self):
        for change in ({"dataKind": "synthetic"}, {"speedUnits": "m/s"},
                       {"start": "2026-01-01T00:00:00Z"}, {"bbox": [70, 10, 71, 11]}):
            self.manifest.write_text(json.dumps(dict(self.meta, **change)))
            with self.assertRaises(Unavailable):
                self.load()

    def test_empty_or_wrong_period_is_unavailable_not_clean_bill(self):
        self.window = {"start": "2024-06-19T10:00:00Z", "end": "2024-06-19T11:00:00Z"}
        with self.assertRaisesRegex(Unavailable, "No compatible"):
            self.load()
        self.csv.unlink()
        with self.assertRaises(Unavailable):
            self.load()

    def test_invalid_json_headers_and_record_limit(self):
        for text in ("not json", "null", "[]", "{}"):
            self.manifest.write_text(text)
            with self.assertRaisesRegex(Unavailable, "invalid"):
                self.load()
        self.manifest.write_text(json.dumps(self.meta))
        for text in ("mmsi,timestamp\n123456789,2024-06-19T00:00:00Z", ""):
            self.csv.write_text(text)
            with self.assertRaisesRegex(Unavailable, "invalid"):
                self.load()
        self.csv.write_text("mmsi,timestamp,latitude,longitude,speed,course\n" +
            "123456789,2024-06-19T00:00:00Z,13.24,74.74,3,90\n" * 20001)
        with self.assertRaisesRegex(Unavailable, "20,000"):
            self.load()


if __name__ == "__main__":
    unittest.main()