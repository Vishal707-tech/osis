import sys
import datetime as dt
from pathlib import Path
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import real_incident_pipeline as p
from strict_real_adapters import StrictEnvironmentProvider


class TestSceneEnvironmentSelection(unittest.TestCase):
    def setUp(self):
        self.payload = {"sceneId": "dummy", "hindcastHours": 6, "forecastHours": 24}

    @patch("real_incident_pipeline.StrictEnvironmentProvider")
    @patch("real_incident_pipeline.run_sar")
    @patch("real_incident_pipeline.load_scene")
    def test_scene_specific_environment(self, mock_load, mock_run_sar, MockProvider):
        # TEST 1: scene-specific current path + wind_path=None
        scene = {
            "id": "test_scene",
            "acquiredAt": "2026-10-05T01:10:17Z",
            "bbox": [64.0, 14.0, 66.0, 16.0],
            "environment": {
                "current": "environment/arabian_sea/cmems_arabian_sea_20261005.nc"
            }
        }
        mock_load.return_value = (scene, {})
        mock_run_sar.return_value = {
            "scene": scene, 
            "mask": [], 
            "detector": {"name": "test_double"},
            "detections": [{"passesOilEvidenceGate": True, "metrics": {"centroid": {"lat": 13.24, "lon": 74.74}}}]
        }

        mock_env_instance = MockProvider.return_value
        mock_env_instance.meta = {"source": "test_mock"}

        p.analyze(self.payload)

        expected_current = str((p.ROOT / "data" / "environment/arabian_sea/cmems_arabian_sea_20261005.nc").resolve())
        MockProvider.assert_called_once_with(current_path=expected_current, wind_path=None)

    @patch("real_incident_pipeline.StrictEnvironmentProvider")
    @patch("real_incident_pipeline.run_sar")
    @patch("real_incident_pipeline.load_scene")
    def test_oman_environment(self, mock_load, mock_run_sar, MockProvider):
        scene = {
            "id": "S1D_IW_GRDH_1SDV_20260702T142203_20260702T142232_003496_0062F7_DBD7_COG.SAFE",
            "acquiredAt": "2026-07-02T14:22:03Z",
            "bbox": [56.24, 17.40, 56.43, 17.59],
            "environment": {
                "current": "environment/oman/cmems_oman_20260702.nc",
                "wind": "environment/oman/era5_oman_20260702.nc"
            }
        }
        mock_load.return_value = (scene, {})
        mock_run_sar.return_value = {
            "scene": scene, 
            "mask": [], 
            "detector": {"name": "test_double"},
            "detections": [{"passesOilEvidenceGate": True, "metrics": {"centroid": {"lat": 17.50, "lon": 56.34}}}]
        }

        mock_env_instance = MockProvider.return_value
        mock_env_instance.meta = {"source": "test_mock"}

        p.analyze(self.payload)

        expected_current = str((p.ROOT / "data" / "environment/oman/cmems_oman_20260702.nc").resolve())
        expected_wind = str((p.ROOT / "data" / "environment/oman/era5_oman_20260702.nc").resolve())
        MockProvider.assert_called_once_with(current_path=expected_current, wind_path=expected_wind)

    @patch("real_incident_pipeline.StrictEnvironmentProvider")
    @patch("real_incident_pipeline.run_sar")
    @patch("real_incident_pipeline.load_scene")
    def test_legacy_fallback_environment(self, mock_load, mock_run_sar, MockProvider):
        # TEST 2: scene with no environment override
        scene = {
            "id": "test_scene",
            "acquiredAt": "2026-10-05T01:10:17Z",
            "bbox": [64.0, 14.0, 66.0, 16.0]
        }
        mock_load.return_value = (scene, {})
        mock_run_sar.return_value = {
            "scene": scene, 
            "mask": [], 
            "detector": {"name": "test_double"},
            "detections": [{"passesOilEvidenceGate": True, "metrics": {"centroid": {"lat": 13.24, "lon": 74.74}}}]
        }

        mock_env_instance = MockProvider.return_value
        mock_env_instance.meta = {"source": "test_mock"}

        p.analyze(self.payload)

        MockProvider.assert_called_once_with()

    def test_arabian_sea_success(self):
        # TEST 3: Arabian Sea CMEMS current file + no wind file
        current_nc = str((p.ROOT / "data" / "environment/arabian_sea/cmems_arabian_sea_20261005.nc").resolve())
        provider = StrictEnvironmentProvider(current_path=current_nc, wind_path=None)
        self.assertFalse(provider.has_wind)
        self.assertEqual(provider.meta["wind_status"], "intentionally unavailable; wind advection disabled")
        
        # Arabian sea coordinate
        when = dt.datetime(2026, 10, 5, 1, 10, 17, tzinfo=dt.timezone.utc)
        result = provider.get_environment(19.74, 69.47, when)
        
        self.assertIn("current_u_ms", result)
        self.assertIn("current_v_ms", result)
        self.assertEqual(result["wind_u_ms"], 0.0)
        self.assertEqual(result["wind_v_ms"], 0.0)
        provider.close()

    @patch.dict('os.environ', {
        "REAL_CURRENT_NETCDF": str((p.ROOT / "data" / "cmems_karnataka.nc").resolve()),
        "REAL_WIND_NETCDF": str((p.ROOT / "data" / "era5_karnataka.nc").resolve())
    })
    def test_karnataka_replay_fallback(self):
        # TEST 4: Karnataka replay still uses its configured current + wind datasets
        provider = StrictEnvironmentProvider()
        self.assertTrue(provider.has_wind)
        
        # Karnataka coordinate
        when = dt.datetime(2024, 6, 19, 0, 48, 37, tzinfo=dt.timezone.utc)
        result = provider.get_environment(13.24, 74.74, when)
        
        self.assertIn("current_u_ms", result)
        self.assertIn("current_v_ms", result)
        self.assertIn("wind_u_ms", result)
        self.assertIn("wind_v_ms", result)
        provider.close()

if __name__ == "__main__":
    unittest.main()
