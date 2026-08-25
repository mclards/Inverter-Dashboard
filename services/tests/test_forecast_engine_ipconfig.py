import importlib.util
import json
import logging
import os
import shutil
import sqlite3
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "services" / "forecast_engine.py"
WORK_TMP = ROOT / ".tmp" / "forecast-engine-ipconfig-tests"
WORK_TMP.mkdir(parents=True, exist_ok=True)

def load_module(temp_root: Path, tag: str):
    (temp_root / "data").mkdir(parents=True, exist_ok=True)
    (temp_root / "portable").mkdir(parents=True, exist_ok=True)
    os.environ["ADSI_DATA_DIR"] = str(temp_root / "data")
    os.environ["ADSI_PORTABLE_DATA_DIR"] = str(temp_root / "portable")
    spec = importlib.util.spec_from_file_location(f"forecast_engine_ipconfig_test_{tag}", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module

class ForecastEngineIpConfigTests(unittest.TestCase):
    def test_missing_ipconfig_defaults_to_3_0_percent_losses_for_forecast_only(self):
        # Blueprint B1 (v2.7.6): raised DEFAULT_INVERTER_LOSS_PCT from 2.5 to 3.0
        # — midpoint of observed 2.5%–3.6% range per operator validation.
        tmp_root = WORK_TMP / "default-losses"
        shutil.rmtree(tmp_root, ignore_errors=True)
        tmp_root.mkdir(parents=True, exist_ok=True)
        try:
            mod = load_module(tmp_root, "default-losses")
            mod.clear_forecast_data_cache()
            meta = mod.load_ipconfig_authoritative()
            losses = mod._load_inverter_loss_factors()
            profile = mod.plant_capacity_profile()

            self.assertEqual(meta["source"], "default")
            self.assertAlmostEqual(float(losses["1"]), 0.030, places=6)
            self.assertAlmostEqual(float(losses["27"]), 0.030, places=6)
            self.assertEqual(profile["configured_inverters"], 0)
            self.assertEqual(profile["source"], "fallback")
        finally:
            logging.shutdown()
            shutil.rmtree(tmp_root, ignore_errors=True)

    def test_db_ipconfig_overrides_stale_file_for_capacity_and_losses(self):
        tmp_root = WORK_TMP / "db-authority"
        shutil.rmtree(tmp_root, ignore_errors=True)
        tmp_root.mkdir(parents=True, exist_ok=True)
        try:
            mod = load_module(tmp_root, "db-authority")

            stale_file_cfg = {
                "inverters": {"1": "", "2": ""},
                "poll_interval": {"1": 0.05, "2": 0.05},
                "units": {"1": [], "2": []},
                "losses": {"1": 0, "2": 0},
            }
            mod.IPCONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
            mod.IPCONFIG_FILE.write_text(json.dumps(stale_file_cfg, indent=2), encoding="utf-8")

            db_cfg = {
                "inverters": {"1": "10.0.0.11", "2": "10.0.0.12"},
                "poll_interval": {"1": 0.05, "2": 0.05},
                "units": {"1": [1, 2, 3, 4], "2": [1, 2]},
                "losses": {"1": 2.5, "2": 1.0},
            }

            conn = sqlite3.connect(mod.APP_DB_FILE)
            try:
                conn.execute(
                    """
                    CREATE TABLE settings (
                        key TEXT PRIMARY KEY,
                        value TEXT
                    )
                    """
                )
                conn.execute(
                    "INSERT INTO settings (key, value) VALUES (?, ?)",
                    ("ipConfigJson", json.dumps(db_cfg)),
                )
                conn.commit()
            finally:
                conn.close()

            mod.clear_forecast_data_cache()
            profile = mod.plant_capacity_profile()
            losses = mod._load_inverter_loss_factors()

            self.assertEqual(profile["configured_inverters"], 2)
            self.assertEqual(profile["enabled_nodes"], 6)
            self.assertEqual(profile["source"], "ipconfig")
            self.assertEqual(profile["ipconfig_source"], "settings:ipConfigJson")
            self.assertTrue(str(profile["ipconfig_path"]).endswith("adsi.db"))
            self.assertAlmostEqual(float(losses["1"]), 0.025, places=6)
            self.assertAlmostEqual(float(losses["2"]), 0.01, places=6)
        finally:
            logging.shutdown()
            shutil.rmtree(tmp_root, ignore_errors=True)

if __name__ == "__main__":
    unittest.main()
