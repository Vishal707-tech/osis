"""Offline regression suite; no network, database or trained model required."""
import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import incident_pipeline as p


class IncidentPipelineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.scenario = json.loads((p.ROOT / "data/demo/scenario.json").read_text())
        cls.report = p.analyze()

    def test_deterministic_complete_report(self):
        self.assertEqual(self.report, p.analyze())
        self.assertEqual(self.report["status"], "completed")
        self.assertEqual(len(self.report["stages"]), 14)
        json.dumps(self.report, allow_nan=False)

    def test_detection_geometry_and_mask(self):
        r = self.report
        self.assertEqual(len(r["detections"]), 2)
        self.assertEqual(sum(map(sum, r["mask"])), sum(d["pixelCount"] for d in r["detections"]))
        for d in r["detections"]:
            ring = d["geometry"]["coordinates"][0]
            self.assertEqual(ring[0], ring[-1])
            g = d["metrics"]
            self.assertGreater(g["areaKm2"], 0)
            self.assertGreater(g["perimeterM"], 0)
            self.assertGreaterEqual(g["lengthM"], g["widthM"])
            self.assertTrue(0 < d["confidence"] < 1)
            self.assertIn("not probability", d["confidenceMeaning"])

    def test_invalid_land_and_empty_raster(self):
        scene = p.DemoSatelliteProvider().load(self.scenario)
        smooth = p.preprocess(scene)
        self.assertIsNone(smooth[10][10])
        self.assertTrue(all(row[0] is None for row in smooth))
        scene["pixels"] = [[None] * scene["width"] for _ in range(scene["height"])]
        found, mask = p.detect(scene)
        self.assertEqual(found, [])
        self.assertEqual(sum(map(sum, mask)), 0)
        with patch.object(p.DemoSatelliteProvider, "load", return_value=scene):
            self.assertEqual(p.analyze()["status"], "no_candidates")

    def test_uniform_water_and_isolated_noise(self):
        scene = p.DemoSatelliteProvider().load(self.scenario)
        scene["pixels"] = [[-12.0] * scene["width"] for _ in range(scene["height"])]
        scene["pixels"][30][30] = -40
        self.assertEqual(p.detect(scene)[0], [])

    def test_age_interval_and_validation(self):
        age = self.report["age"]
        self.assertEqual((age["minHours"], age["estimatedHours"], age["maxHours"]), (6, 7.5, 9))
        with self.assertRaises(ValueError):
            p.estimate_age(self.scenario["acquiredAt"], self.scenario["acquiredAt"],
                           self.scenario["firstPositiveAt"])
        with self.assertRaises(ValueError):
            p.timestamp("2026-09-04T00:00:00")

    def test_hindcast_and_forecast(self):
        r = self.report
        for horizon in (24, 48, 72):
            forward = p.drift(r["spill"]["metrics"]["centroid"], r["scene"]["acquiredAt"], horizon,
                              p.FixtureEnvironmentProvider(self.scenario["environment"]))
            self.assertEqual(len(forward), horizon + 1)
            self.assertEqual(forward[-1]["hours"], horizon)
            self.assertGreater(forward[-1]["lon"], forward[0]["lon"])
            self.assertGreater(forward[-1]["uncertaintyKm"], forward[0]["uncertaintyKm"])
        self.assertEqual(r["backward"][-1]["hours"], -7.5)
        self.assertLess(r["origin"]["lon"], r["backward"][0]["lon"])
        self.assertLess(r["origin"]["timestamp"], r["scene"]["acquiredAt"])
        self.assertGreater(r["origin"]["uncertaintyKm"], r["backward"][-1]["uncertaintyKm"])
        recovered = p.drift(r["origin"], r["origin"]["timestamp"], 7.5,
                            p.FixtureEnvironmentProvider(self.scenario["environment"]))[-1]
        self.assertLess(p.haversine_km(recovered["lat"], recovered["lon"],
                                      r["backward"][0]["lat"], r["backward"][0]["lon"]), .001)

    def test_drift_terminates_safely_on_land_boundary(self):
        r = self.report
        centroid = r["spill"]["metrics"]["centroid"]
        env = p.FixtureEnvironmentProvider(self.scenario["environment"])
        
        with patch("incident_pipeline.rk4_step_backward", side_effect=ValueError("Environmental sample contains missing or nonfinite values")):
            forward = p.drift(centroid, r["scene"]["acquiredAt"], 24, env)
        self.assertEqual(len(forward), 1)
        self.assertEqual(forward[0]["hours"], 0)
        
        with patch("incident_pipeline.rk4_step_backward", side_effect=ValueError("Environmental sample is outside spatial or temporal coverage")):
            forward = p.drift(centroid, r["scene"]["acquiredAt"], 24, env)
        self.assertEqual(len(forward), 1)
        
        with patch("incident_pipeline.rk4_step_backward", side_effect=ValueError("Something completely different")):
            with self.assertRaises(ValueError):
                p.drift(centroid, r["scene"]["acquiredAt"], 24, env)
                
    def test_trajectory_terminal_coordinate_not_retained(self):
        # valid point -> valid RK4 step -> candidate reaches invalid boundary -> trajectory stops -> invalid candidate is NOT included
        r = self.report
        centroid = r["spill"]["metrics"]["centroid"]
        
        class FailingEnvironment(p.FixtureEnvironmentProvider):
            def __init__(self, values):
                super().__init__(values)
                self.calls = 0
            def get_environment(self, lat, lon, when):
                self.calls += 1
                if self.calls > 1:
                    raise ValueError("Environmental sample contains missing or nonfinite values")
                return super().get_environment(lat, lon, when)
                
        failing_env = FailingEnvironment(self.scenario["environment"])
        # Should return exactly 1 point (the origin) since the second point (first RK4 candidate) fails get_environment
        forward = p.drift(centroid, r["scene"]["acquiredAt"], 24, failing_env)
        self.assertEqual(len(forward), 1)
        self.assertEqual(forward[0]["hours"], 0)

    def test_ais_normalization_csv_and_rejections(self):
        rows, _ = p.demo_ais(self.scenario)
        bad = dict(rows[0], latitude=91)
        normalized, rejected = p.normalize_ais([rows[0], rows[0], bad, {}])
        self.assertEqual(len(normalized), 1)
        self.assertEqual(rejected, 2)
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "ais.csv"
            file.write_text("MMSI,timestamp,latitude,longitude,speed,course\n"
                            "000000001,2026-09-03T22:00:00Z,15.22,72.39,2,90\n")
            loaded, rejected = p.load_ais_csv(file)
            self.assertEqual(rejected, 0)
            self.assertEqual(loaded[0]["mmsi"], "000000001")

    def test_filtering_and_explainable_score(self):
        r = self.report
        self.assertEqual(len(r["candidates"]), 3)
        self.assertEqual(r["leadingCandidate"], "000000001")
        self.assertNotIn("000000004", [c["mmsi"] for c in r["candidates"]])
        self.assertAlmostEqual(sum(p.WEIGHTS.values()), 1)
        for c in r["candidates"]:
            self.assertLessEqual(c["closestDistanceKm"], 15)
            score = sum(c["features"][k] * p.WEIGHTS[k] for k in p.WEIGHTS) * 100
            self.assertAlmostEqual(c["score"], score, delta=.02)
        rows, _ = p.demo_ais(self.scenario)
        far = [dict(row, latitude=50) for row in rows]
        self.assertEqual(p.correlate(far, [], r["origin"], r["origin"]["releaseWindow"], r["backward"]), ([], []))

    def test_gap_not_interpolated_as_observation(self):
        r = self.report
        self.assertEqual(len(r["anomalies"]), 1)
        gap = r["anomalies"][0]
        self.assertEqual(gap["durationHours"], 2)
        self.assertTrue(gap["overlapsOriginWindow"])
        self.assertIn("does not prove", gap["label"])
        leader = r["candidates"][0]
        self.assertEqual(leader["confidence"], "low")
        self.assertEqual(len(leader["trackSegments"]), 2)
        self.assertNotIn("anomaly", p.WEIGHTS)
        for segment in leader["trackSegments"]:
            for a, b in zip(segment, segment[1:]):
                self.assertLessEqual((p.timestamp(b["timestamp"]) - p.timestamp(a["timestamp"])).total_seconds(), 3600)

    def test_invalid_requests(self):
        with self.assertRaises(ValueError):
            p.analyze("unknown")
        with self.assertRaises(ValueError):
            p.analyze(horizon=999)


if __name__ == "__main__":
    unittest.main()