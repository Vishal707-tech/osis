"""REAL orchestration regressions: dependency seams are mocked, never implicit demo fallback."""
import json
import copy
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import real_incident_pipeline as p
from strict_real_adapters import Unavailable


class RealPipelineTests(unittest.TestCase):
    def setUp(self):
        self.payload = {"sceneId": "s1a-20240619-karnataka", "hindcastHours": 6, "forecastHours": 24}
        self.scene, self.paths = p.load_scene(self.payload["sceneId"])
        self.sar = {"scene": self.scene, "mask": [], "detector": {"name": "test_double"},
                    "detections": [{"metrics": {"centroid": {"lat": 13.24, "lon": 74.74}}}]}

    def test_registry_validation(self):
        with self.assertRaises(ValueError):
            p.load_scene("../../private")
        self.assertNotIn("vv", self.scene)
        with self.assertRaises(ValueError):
            p.analyze(dict(self.payload, hindcastHours=float("nan")))

    def test_sar_failure_partial_without_synthetic(self):
        with patch.object(p, "run_sar", side_effect=Unavailable("Missing checkpoint")), patch.object(p, "StrictEnvironmentProvider") as env:
            r = p.analyze(self.payload)
        env.assert_not_called()
        self.assertEqual(r["mode"], "REAL")
        self.assertEqual(r["status"], "partial")
        self.assertEqual(r["stageStatus"]["detection"]["status"], "unavailable")
        self.assertIsNone(r["age"])
        self.assertIsNone(r["origin"])
        self.assertEqual(r["candidates"], [])
        self.assertEqual(r["backward"], [])
        self.assertNotIn("synthetic_demo", json.dumps(r))

    def test_empty_detection_is_not_adapter_failure(self):
        sar = dict(self.sar, detections=[])
        with patch.object(p, "run_sar", return_value=sar):
            r = p.analyze(self.payload)
        self.assertEqual(r["status"], "no_candidates")
        self.assertEqual(r["stageStatus"]["detection"]["status"], "completed")

    def test_environment_failure_preserves_sar(self):
        with patch.object(p, "run_sar", return_value=self.sar), patch.object(p, "StrictEnvironmentProvider", side_effect=Unavailable("No NetCDF")):
            r = p.analyze(self.payload)
        self.assertEqual(len(r["detections"]), 1)
        self.assertEqual(r["stageStatus"]["characterization"]["status"], "completed")
        self.assertEqual(r["forward"], [])
        self.assertIsNone(r["age"])
        json.dumps(r, allow_nan=False)

    def test_separate_trajectory_failures_and_no_ais_without_origin(self):
        class Environment:
            meta = {"source": "test_double"}
            def get_environment(self, *args):
                return {}
            def close(self):
                pass
        point = {"lat": 13.24, "lon": 74.74, "timestamp": self.scene["acquiredAt"], "hours": 0, "uncertaintyKm": .35}
        with patch.object(p, "run_sar", return_value=self.sar), patch.object(p, "StrictEnvironmentProvider", return_value=Environment()), patch.object(p, "drift", side_effect=[Unavailable("Outside coverage"), [point]]), patch.object(p, "historical_ais") as ais:
            r = p.analyze(self.payload)
        ais.assert_not_called()
        self.assertEqual(r["stageStatus"]["forecast"]["status"], "partial")
        self.assertEqual(r["stageStatus"]["hindcast"]["status"], "unavailable")
        self.assertEqual(r["forward"], [point])
        self.assertEqual(r["backward"], [])
        self.assertIsNone(r["origin"])
        self.assertIsNone(r["age"])
        self.assertEqual(r["candidates"], [])
        self.assertEqual(r["status"], "partial")
        json.dumps(r, allow_nan=False)

    def test_missing_interpreter_timeout_and_bad_output(self):
        for error in (OSError(), subprocess.TimeoutExpired("sar", 35)):
            with patch.object(p.subprocess, "run", side_effect=error):
                with self.assertRaises(Unavailable):
                    p.run_sar(self.scene, self.paths, "hybrid")
        with patch.object(p.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)):
            with self.assertRaises(Unavailable):
                p.run_sar(self.scene, self.paths, "classical")

    def test_subprocess_output_schema_nonfinite_and_size_limit(self):
        for output in (b'null', b'[]', b'{}', b'{"value": NaN}', b' ' * (4 * 1024 * 1024 + 1),
                       json.dumps(dict(self.sar, detections=[None])).encode()):
            def child(*args, **kwargs):
                kwargs["stdout"].write(output)
                self.assertEqual(kwargs["timeout"], 35)
                return subprocess.CompletedProcess([], 0)
            with self.subTest(output=output[:40]), patch.object(p.subprocess, "run", side_effect=child):
                with self.assertRaises(Unavailable):
                    p.run_sar(self.scene, self.paths, "classical")

    def test_nested_centroids_and_overflow_are_rejected_as_partial_reports(self):
        for centroid in ({}, {"lat": None, "lon": 74.74}, {"lat": True, "lon": 74.74},
                         {"lat": "13.24", "lon": 74.74}, {"lat": 91, "lon": 74.74},
                         {"lat": 13.24, "lon": 74.9}):
            sar = copy.deepcopy(self.sar)
            sar["detections"][0]["metrics"]["centroid"] = centroid
            def child(*args, **kwargs):
                kwargs["stdout"].write(json.dumps(sar).encode())
                return subprocess.CompletedProcess([], 0)
            with self.subTest(centroid=centroid), patch.object(p.subprocess, "run", side_effect=child):
                report = p.analyze(self.payload)
                self.assertEqual(report["stageStatus"]["detection"]["status"], "unavailable")
                self.assertIsNone(report["spill"])
                json.dumps(report, allow_nan=False)
        output = json.dumps(self.sar)[:-1] + ', "overflow": 1e999}'
        def overflowing_child(*args, **kwargs):
            kwargs["stdout"].write(output.encode())
            return subprocess.CompletedProcess([], 0)
        with patch.object(p.subprocess, "run", side_effect=overflowing_child):
            with self.assertRaises(Unavailable):
                p.run_sar(self.scene, self.paths, "classical")

    def test_detector_cannot_override_orchestration_fields(self):
        def child(*args, **kwargs):
            kwargs["stdout"].write(json.dumps(dict(self.sar, age={"estimatedHours": 6},
                mode="DEMO", status="completed", candidates=["not observed"])).encode())
            return subprocess.CompletedProcess([], 0)
        with patch.object(p.subprocess, "run", side_effect=child):
            self.assertEqual(p.run_sar(self.scene, self.paths, "classical"), self.sar)

    def test_forecast_failure_preserves_hindcast_and_checks_ais(self):
        class Environment:
            meta = {"source": "test_double"}
            closed = False
            def get_environment(self, *args):
                return {}
            def close(self):
                self.closed = True
        environment = Environment()
        point = {"lat": 13.24, "lon": 74.74, "timestamp": "2024-06-18T18:48:37Z",
                 "hours": -6, "uncertaintyKm": .35}
        with patch.object(p, "run_sar", return_value=self.sar), patch.object(p, "StrictEnvironmentProvider", return_value=environment), patch.object(p, "drift", side_effect=[[point], Unavailable("Outside forecast coverage")]), patch.object(p, "historical_ais", side_effect=Unavailable("No observed AIS")) as ais:
            report = p.analyze(self.payload)
        ais.assert_called_once()
        self.assertTrue(environment.closed)
        self.assertEqual(report["origin"]["timestamp"], point["timestamp"])
        self.assertEqual(report["backward"], [point])
        self.assertEqual(report["forward"], [])
        self.assertEqual(report["stageStatus"]["forecast"]["status"], "unavailable")
        self.assertEqual(report["stageStatus"]["hindcast"]["status"], "completed")
        self.assertEqual(report["status"], "partial")
        self.assertIsNone(report["age"])
        json.dumps(report, allow_nan=False)

    @patch("real_incident_pipeline.correlate")
    @patch("real_incident_pipeline.drift")
    @patch("real_incident_pipeline.StrictEnvironmentProvider")
    @patch("real_incident_pipeline.run_sar")
    def test_live_ais_records_are_normalized(self, mock_sar, mock_env, mock_drift, mock_correlate):
        mock_sar.return_value = self.sar
        env_instance = mock_env.return_value
        env_instance.meta = {"kind": "MOCK"}
        mock_drift.return_value = [{"lat": 12.0, "lon": 74.0, "timestamp": "2024-06-18T18:48:37Z", "hours": -6}]
        mock_correlate.return_value = ([], [])

        payload = copy.deepcopy(self.payload)
        payload["ais_mode"] = "LIVE"
        payload["live_ais_records"] = [
            {"mmsi": "123456789", "timestamp": "2024-06-18T18:00:00Z", "latitude": 12.1, "longitude": 74.1, "speed": 10.0, "course": 90.0},
            {"mmsi": "123456789", "timestamp": "2024-06-18T17:00:00Z", "latitude": 12.2, "longitude": 74.2, "speed": 10.0, "course": 90.0},
            {"mmsi": "123456789", "timestamp": "2024-06-18T19:00:00Z", "latitude": 12.0, "longitude": 74.0, "speed": 10.0, "course": 90.0}
        ]

        p.analyze(payload)
        
        mock_correlate.assert_called_once()
        records_passed = mock_correlate.call_args[0][0]
        self.assertEqual(len(records_passed), 3)
        self.assertEqual(records_passed[0]["timestamp"], "2024-06-18T17:00:00Z")
        self.assertEqual(records_passed[1]["timestamp"], "2024-06-18T18:00:00Z")
        self.assertEqual(records_passed[2]["timestamp"], "2024-06-18T19:00:00Z")

    def test_environment_current_and_wind_available(self):
        class Environment:
            has_wind = True
            meta = {"source": "test_double"}
            def get_environment(self, *args):
                return {}
            def close(self):
                pass
        with patch.object(p, "run_sar", return_value=self.sar), patch.object(p, "StrictEnvironmentProvider", return_value=Environment()), patch.object(p, "drift", return_value=[]):
            r = p.analyze(self.payload)
        self.assertEqual(r["stageStatus"]["environment"]["status"], "completed")
        self.assertIn("current/wind", r["provenance"]["environment"])
        self.assertEqual(r["evidenceProvenance"]["environment"]["kind"], "MODELED")

    def test_environment_wind_intentionally_disabled(self):
        class Environment:
            has_wind = False
            meta = {"source": "test_double", "wind_status": "intentionally unavailable"}
            def get_environment(self, *args):
                return {}
            def close(self):
                pass
        with patch.object(p, "run_sar", return_value=self.sar), patch.object(p, "StrictEnvironmentProvider", return_value=Environment()), patch.object(p, "drift", return_value=[]):
            r = p.analyze(self.payload)
        self.assertEqual(r["stageStatus"]["environment"]["status"], "completed")
        self.assertIn("wind intentionally disabled", r["provenance"]["environment"])
        self.assertIn("wind advection disabled/neutral", r["stageStatus"]["environment"]["reason"])
        self.assertEqual(r["evidenceProvenance"]["environment"]["kind"], "MODELED")

    def test_environment_genuinely_unavailable(self):
        with patch.object(p, "run_sar", return_value=self.sar), patch.object(p, "StrictEnvironmentProvider", side_effect=Unavailable("No NetCDF")):
            r = p.analyze(self.payload)
        self.assertEqual(r["stageStatus"]["environment"]["status"], "unavailable")
        self.assertEqual(r["environment"]["status"], "UNAVAILABLE")
        self.assertEqual(r["evidenceProvenance"]["environment"]["kind"], "UNAVAILABLE")


if __name__ == "__main__":
    unittest.main()