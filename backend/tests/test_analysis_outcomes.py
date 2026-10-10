import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import incident_pipeline as demo
import real_incident_pipeline as real
from report_contract import OUTCOMES


class OutcomeTests(unittest.TestCase):
    def test_three_deterministic_outcomes_and_serialization(self):
        for scene, outcome in zip(("demo-arabian-sea", "demo-no-spill", "demo-inconclusive"), OUTCOMES):
            r = demo.analyze(scene)
            self.assertEqual(r["outcome"], outcome)
            self.assertEqual(r, demo.analyze(scene))
            self.assertIsNotNone(r["scene"]["footprint"])
            self.assertIn("evidenceProvenance", r)
            json.dumps(r, allow_nan=False)
            if outcome != "SPILL_DETECTED":
                self.assertIsNone(r["origin"])
                self.assertEqual(r["candidates"], [])

    def test_unavailable_real_and_upload_have_complete_contracts(self):
        scene, _ = real.load_scene("s1a-20240619-karnataka")
        for mode in ("REAL", "UPLOAD"):
            r = real.analyze({"mode": mode, "_scene": scene, "_unavailable": "Required data missing"})
            self.assertEqual(r["outcome"], "ANALYSIS_INCONCLUSIVE")
            self.assertEqual(r["mode"], mode)
            self.assertIsNone(r["age"])
            self.assertNotIn("synthetic_demo", json.dumps(r))
            if mode == "REAL":
                self.assertEqual(r["availability"], "REAL_DATA_UNAVAILABLE")

    def test_detector_uncertainty_does_not_attribute(self):
        scene, _ = real.load_scene("s1a-20240619-karnataka")
        sar = {"scene": scene, "detections": [{"metrics": {"centroid": {"lat": 13.24, "lon": 74.74}}}],
               "mask": [], "detector": {"name": "classical", "outcome": "ANALYSIS_INCONCLUSIVE"}}
        with patch.object(real, "run_sar", return_value=sar), patch.object(real, "StrictEnvironmentProvider") as environment:
            r = real.analyze({"sceneId": scene["id"]})
        environment.assert_not_called()
        self.assertEqual(r["outcome"], "ANALYSIS_INCONCLUSIVE")
        self.assertEqual(r["candidates"], [])

    def test_optional_ais_motion_does_not_invent_measurements(self):
        records, rejected = demo.normalize_ais([{"mmsi": "123456789", "timestamp": "2024-06-19T00:00:00Z", "latitude": 13.24, "longitude": 74.74}])
        self.assertEqual(rejected, 0)
        self.assertIsNone(records[0]["speed"])
        self.assertIsNone(records[0]["course"])


if __name__ == "__main__":
    unittest.main()