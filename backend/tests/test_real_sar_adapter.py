"""Raster validation and detector seams; ML tests skip explicitly outside .venv-ml."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import real_sar_adapter as a

HAS_ML = all(importlib.util.find_spec(m) for m in ("numpy", "torch", "tifffile", "cv2", "segmentation_models_pytorch"))


class ValidationWithoutML(unittest.TestCase):
    def test_units_and_bounds_required_before_import(self):
        for scene in ({"rasterUnits": None}, {"rasterUnits": "db", "bbox": [0, 0, float("nan"), 1]}):
            with self.assertRaises(ValueError):
                a.ExperimentalSpillDetector().detect({"scene": scene})

    def test_missing_dependency_is_not_synthetic_result(self):
        with patch.object(a, "experiment", side_effect=ImportError("test missing ML")):
            with self.assertRaises(ImportError):
                a.ExperimentalSpillDetector().detect({"scene": {"rasterUnits": "db", "bbox": [0, 0, 1, 1]}})


@unittest.skipUnless(HAS_ML, "Requires existing .venv-ml dependencies")
class RasterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.m = a.experiment()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.file = Path(self.temp.name) / "test.tif"
        self.scene = {"bbox": [74.7, 13.2, 74.78, 13.28], "rasterUnits": "db"}
        self.arr = self.m.np.full((512, 512), -15, dtype=self.m.np.float32)

    def write(self, array=None, epsg=4326, area=1):
        keys = (1, 1, 0, 2, 2048, 0, 1, epsg, 1025, 0, 1, area)
        self.m.tifffile.imwrite(self.file, self.arr if array is None else array, extratags=[
            (34735, "H", len(keys), keys, False), (33550, "d", 3, (.08/512, .08/512, 0), False),
            (33922, "d", 6, (0, 0, 0, 74.7, 13.28, 0), False)])

    def detect(self, method="classical"):
        return a.ExperimentalSpillDetector().detect({"scene": self.scene, "vv": str(self.file), "vh": str(self.file), "detector": method})

    def test_georeferencing_shape_crs_and_bounds(self):
        self.write()
        self.assertEqual(len(a.validate_raster(self.m, self.file, self.scene)), 64)
        for kwargs in ({"array": self.arr[:20]}, {"epsg": 3857}, {"area": 2}):
            self.write(**kwargs)
            with self.assertRaises(ValueError):
                a.validate_raster(self.m, self.file, self.scene)
        self.write()
        with self.assertRaises(ValueError):
            a.validate_raster(self.m, self.file, {"bbox": [0, 0, 1, 1]})
        with self.assertRaises(ValueError):
            a.validate_raster(self.m, self.file.with_name("missing.tif"), self.scene)

    def test_linear_db_finite_and_invalid_coverage(self):
        arr = self.arr.copy()
        arr[:] = .01
        arr[0, :4] = [0, -1, float("nan"), float("inf")]
        self.write(arr)
        db, valid = self.m.read_calibrate_raster(self.file, "linear")
        self.assertAlmostEqual(float(db[1, 1]), -20, places=4)
        self.assertTrue(valid[0, 0])
        self.assertAlmostEqual(float(db[0, 0]), -50, places=4)
        self.assertFalse(valid[0, 1:4].any())
        with self.assertRaises(ValueError):
            self.m.read_calibrate_raster(self.file, "unknown")
        arr[:] = -9999
        arr[:200] = -15
        self.write(arr)
        with patch.object(a, "experiment", return_value=self.m):
            with self.assertRaisesRegex(ValueError, "50%"):
                self.detect()

    def test_empty_result_and_missing_checkpoint(self):
        self.write()
        with patch.object(a, "experiment", return_value=self.m):
            result = self.detect()
            self.assertEqual(result["detections"], [])
            self.assertEqual(sum(map(sum, result["mask"])), 0)
            json.dumps(result, allow_nan=False)
            with patch.dict(os.environ, {"REAL_MODEL_PATH": str(self.file.with_name("absent.pth"))}):
                with self.assertRaisesRegex(ValueError, "checkpoint"):
                    self.detect("hybrid")

    def test_geometry_metrics_and_degenerate_rejection(self):
        self.write()
        mask = self.m.np.zeros((512, 512), dtype=bool)
        mask[100:110, 100:140] = True
        candidate = {"cmask": mask, "heuristicScore": .7, "vvDampingDb": 5}
        classical = {"retainedCandidates": [candidate], "totalClusters": 1}
        with patch.object(a, "experiment", return_value=self.m), patch.object(self.m, "run_classical_candidates", return_value=classical):
            result = self.detect()
            detection = result["detections"][0]
            ring = detection["geometry"]["coordinates"][0]
            self.assertEqual(ring[0], ring[-1])
            self.assertGreater(detection["metrics"]["areaKm2"], 0)
            self.assertEqual(detection["pixelCount"], 400)
            self.assertIn("not probability", detection["confidenceMeaning"])
            json.dumps(result, allow_nan=False)
            mask[:] = False
            mask[100, 100] = True
            result = self.detect()
            self.assertEqual(result["detections"], [])
            self.assertEqual(result["detector"]["geometryRejected"], 1)

    def test_quality_gate_rgb_rejection_and_classical_abstention(self):
        self.write(self.m.np.zeros((512, 512, 3), dtype=self.m.np.uint8))
        with self.assertRaises(ValueError):
            a.validate_raster(self.m, self.file, self.scene)
        rng = self.m.np.random.default_rng(26143)
        self.write(rng.normal(-25, 1, (512, 512)).astype(self.m.np.float32))
        with patch.object(a, "experiment", return_value=self.m), patch.object(self.m, "run_classical_candidates", return_value={"retainedCandidates": [], "totalClusters": 0}):
            result = self.detect()
        self.assertEqual(result["detector"]["outcome"], "NO_SPILL_DETECTED")
        self.assertGreater(result["detector"]["quality"]["oceanFraction"], .9)
        self.write()  # Uniform/non-ocean fixture is insufficient quality, not a clean-water finding.
        with patch.object(a, "experiment", return_value=self.m):
            result = self.detect()
        self.assertEqual(result["detector"]["outcome"], "ANALYSIS_INCONCLUSIVE")

    def test_missing_geographic_land_mask_is_reported_and_inconclusive(self):
        self.write()
        mask = self.m.np.zeros((512, 512), dtype=bool)
        mask[100:110, 100:140] = True
        candidate = {
            "cmask": mask, "area": int(mask.sum()), "heuristicScore": .8,
            "vvDampingDb": 5.0, "vvVhDifferenceDb": 2.0
        }
        pose = {
            "probs": self.m.np.zeros((5, 512, 512), dtype=self.m.np.float32),
            "predMask": self.m.np.zeros((512, 512), dtype=self.m.np.uint8)
        }

        class Model:
            def load_state_dict(self, state, strict):
                pass

            def to(self, device):
                return self

            def eval(self):
                return self

        model = Model()
        with patch.dict(os.environ, {"REAL_MODEL_PATH": str(self.file)}), \
             patch.dict("sys.modules", {"global_land_mask": None}), \
             patch.object(a, "experiment", return_value=self.m), \
             patch.object(self.m, "run_classical_candidates", return_value={
                 "retainedCandidates": [candidate], "totalClusters": 1
             }), \
             patch.object(self.m, "run_poseatsea_inference", return_value=pose), \
             patch.object(self.m.smp, "Unet", return_value=model), \
             patch.object(self.m.torch, "load", return_value={}):
            result = self.detect("hybrid")

        self.assertEqual(result["detector"]["geographic_land_validation"], "UNAVAILABLE")
        self.assertEqual(result["detector"]["outcome"], "ANALYSIS_INCONCLUSIVE")
        self.assertEqual(result["detections"], [])

    def test_coverage_thresholds(self):
        rng = self.m.np.random.default_rng(12345)
        base = rng.normal(-25, 2, (512, 512)).astype(self.m.np.float32)
        arr = base.copy()
        
        # 0.49 fails the hard validity gate immediately
        arr[:] = -9999
        arr[:251] = base[:251]  # 251 / 512 = 0.4902
        self.write(arr)
        with patch.object(a, "experiment", return_value=self.m):
            with self.assertRaisesRegex(ValueError, "50%"):
                self.detect()
                
        # 0.50 passes the hard validity gate and meets the scene quality coverage floor
        arr[:] = -9999
        arr[:256] = base[:256]  # 256 / 512 = 0.500
        self.write(arr)
        with patch.object(a, "experiment", return_value=self.m), patch.object(self.m, "run_classical_candidates", return_value={"retainedCandidates": [], "totalClusters": 0}):
            result = self.detect()
            self.assertIn("coverage>=0.5", result["detector"]["quality"]["gate"])
            self.assertEqual(result["detector"]["outcome"], "NO_SPILL_DETECTED")
            self.assertAlmostEqual(result["detector"]["quality"]["jointValidFraction"], 0.5)

        # 0.708 (real Sentinel-1 scene case) passes perfectly
        arr[:] = -9999
        arr[:363] = base[:363]  # 363 / 512 = 0.7089
        self.write(arr)
        with patch.object(a, "experiment", return_value=self.m), patch.object(self.m, "run_classical_candidates", return_value={"retainedCandidates": [], "totalClusters": 0}):
            result = self.detect()
            self.assertEqual(result["detector"]["outcome"], "NO_SPILL_DETECTED")
            self.assertAlmostEqual(result["detector"]["quality"]["jointValidFraction"], 0.708984375)

if __name__ == "__main__":
    unittest.main()