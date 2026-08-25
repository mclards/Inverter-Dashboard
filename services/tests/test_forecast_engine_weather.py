import importlib.util
import logging
import os
import shutil
import unittest
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "services" / "forecast_engine.py"
WORK_TMP = ROOT / ".tmp" / "forecast-engine-weather-tests"
WORK_TMP.mkdir(parents=True, exist_ok=True)

def load_module(temp_root: Path, tag: str):
    (temp_root / "data").mkdir(parents=True, exist_ok=True)
    (temp_root / "portable").mkdir(parents=True, exist_ok=True)
    os.environ["ADSI_DATA_DIR"] = str(temp_root / "data")
    os.environ["ADSI_PORTABLE_DATA_DIR"] = str(temp_root / "portable")
    spec = importlib.util.spec_from_file_location(f"forecast_engine_weather_test_{tag}", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module

class ForecastEngineWeatherTests(unittest.TestCase):
    @staticmethod
    def build_hourly_frame(day: str) -> pd.DataFrame:
        return pd.DataFrame(
            {
                "time": pd.date_range(f"{day} 00:00:00", periods=24, freq="1h"),
                "rad": [0.0] * 6 + [120.0, 260.0, 420.0, 560.0, 700.0, 780.0, 760.0, 620.0, 480.0, 320.0, 180.0, 80.0] + [0.0] * 6,
                "rad_direct": [0.0] * 6 + [60.0, 140.0, 240.0, 340.0, 420.0, 460.0, 450.0, 360.0, 260.0, 170.0, 90.0, 35.0] + [0.0] * 6,
                "rad_diffuse": [0.0] * 6 + [60.0, 120.0, 180.0, 220.0, 280.0, 320.0, 310.0, 260.0, 220.0, 150.0, 90.0, 45.0] + [0.0] * 6,
                "cloud": [55.0] * 24,
                "cloud_low": [25.0] * 24,
                "cloud_mid": [18.0] * 24,
                "cloud_high": [12.0] * 24,
                "temp": [27.0] * 24,
                "rh": [72.0] * 24,
                "wind": [3.5] * 24,
                "precip": [0.0] * 24,
                "cape": [120.0] * 24,
            }
        )

    def test_interpolate_5min_preserves_time_column(self):
        tmp_root = WORK_TMP / "interpolate"
        shutil.rmtree(tmp_root, ignore_errors=True)
        tmp_root.mkdir(parents=True, exist_ok=True)
        try:
            mod = load_module(tmp_root, "interpolate")
            hourly = self.build_hourly_frame("2026-03-20")

            w5 = mod.interpolate_5min(hourly, "2026-03-20")

            self.assertIn("time", w5.columns)
            self.assertEqual(len(w5), mod.SLOTS_DAY)
            self.assertTrue(pd.api.types.is_datetime64_any_dtype(w5["time"]))
        finally:
            logging.shutdown()
            shutil.rmtree(tmp_root, ignore_errors=True)

    def test_fetch_weather_forecast_today_uses_cache_when_live_fetch_fails(self):
        tmp_root = WORK_TMP / "forecast-cache-fallback"
        shutil.rmtree(tmp_root, ignore_errors=True)
        tmp_root.mkdir(parents=True, exist_ok=True)
        try:
            mod = load_module(tmp_root, "forecast-cache-fallback")
            today = mod.datetime.now().strftime("%Y-%m-%d")
            hourly = self.build_hourly_frame(today)
            cache_path = mod._weather_cache_path(today, "forecast")
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            hourly.to_csv(cache_path, index=False)

            orig_get = mod.requests.get
            try:
                def fail_get(*args, **kwargs):
                    raise RuntimeError("simulated fetch outage")
                mod.requests.get = fail_get
                out = mod.fetch_weather(today, source="forecast")
            finally:
                mod.requests.get = orig_get

            self.assertIsNotNone(out)
            self.assertEqual(len(out), 24)
            self.assertIn("time", out.columns)
        finally:
            logging.shutdown()
            shutil.rmtree(tmp_root, ignore_errors=True)

    def test_fetch_weather_forecast_today_uses_cache_when_payload_invalid(self):
        tmp_root = WORK_TMP / "forecast-cache-invalid-payload"
        shutil.rmtree(tmp_root, ignore_errors=True)
        tmp_root.mkdir(parents=True, exist_ok=True)
        try:
            mod = load_module(tmp_root, "forecast-cache-invalid-payload")
            today = mod.datetime.now().strftime("%Y-%m-%d")
            hourly = self.build_hourly_frame(today)
            cache_path = mod._weather_cache_path(today, "forecast")
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            hourly.to_csv(cache_path, index=False)

            class FakeResponse:
                def raise_for_status(self):
                    return None

                def json(self):
                    return {"hourly": {"time": []}}

            orig_get = mod.requests.get
            try:
                mod.requests.get = lambda *args, **kwargs: FakeResponse()
                out = mod.fetch_weather(today, source="forecast")
            finally:
                mod.requests.get = orig_get

            self.assertIsNotNone(out)
            self.assertEqual(len(out), 24)
            self.assertIn("time", out.columns)
        finally:
            logging.shutdown()
            shutil.rmtree(tmp_root, ignore_errors=True)

    def test_run_dayahead_uses_saved_snapshot_when_live_forecast_weather_missing(self):
        tmp_root = WORK_TMP / "snapshot-fallback"
        shutil.rmtree(tmp_root, ignore_errors=True)
        tmp_root.mkdir(parents=True, exist_ok=True)
        try:
            mod = load_module(tmp_root, "snapshot-fallback")
            day = date(2026, 3, 20)
            day_s = day.isoformat()
            hourly = self.build_hourly_frame(day_s)
            solar_forecast = np.zeros(mod.SLOTS_DAY, dtype=float)
            solar_forecast[mod.SOLAR_START_SLOT:mod.SOLAR_END_SLOT] = 25.0

            orig_fetch_weather = mod.fetch_weather
            orig_load_snapshot = mod.load_forecast_weather_snapshot
            orig_load_weather_bias = mod.load_weather_bias_artifact
            orig_apply_bias = mod.apply_weather_bias_adjustment
            orig_validate_w5 = mod.validate_weather_5min
            orig_analyse = mod.analyse_weather_day
            orig_classify = mod.classify_day_regime
            orig_physics = mod.physics_baseline
            orig_solcast_snapshot = mod.load_solcast_snapshot
            orig_solcast_prior_from_snapshot = mod.solcast_prior_from_snapshot
            orig_solcast_rel = mod.load_solcast_reliability_artifact
            orig_blend_solcast = mod.blend_physics_with_solcast
            orig_load_artifacts = mod.load_forecast_artifacts
            orig_load_model = mod.load_model_bundle
            orig_error_memory = mod.compute_error_memory
            orig_activity = mod.apply_activity_hysteresis
            orig_staging = mod.apply_block_staging
            orig_ramp = mod.apply_ramp_limit
            orig_conf = mod.confidence_bands
            orig_write = mod.write_forecast
            try:
                mod.fetch_weather = lambda day, source="auto": None
                mod.load_forecast_weather_snapshot = lambda day: {
                    "raw_hourly": mod._weather_frame_to_records(hourly),
                    "applied_hourly": mod._weather_frame_to_records(hourly),
                }
                mod.load_weather_bias_artifact = lambda today, allow_build=True: {}
                mod.apply_weather_bias_adjustment = lambda raw_hourly, day, weather_bias: (raw_hourly, {})
                mod.validate_weather_5min = lambda day, w5: (True, "")
                mod.analyse_weather_day = lambda day, w5, actual=None: {
                    "sky_class": "mixed",
                    "cloud_mean": 55.0,
                    "rad_peak": 780.0,
                    "rh_mean": 72.0,
                    "convective": False,
                    "rainy": False,
                }
                mod.classify_day_regime = lambda stats: "mixed"
                mod.physics_baseline = lambda day, w5: solar_forecast.copy()
                # PHASE 4: Mock Solcast snapshot for day-ahead requirement
                mod.load_solcast_snapshot = lambda day: {
                    "coverage_slots": mod.SLOTS_DAY,
                    "forecast_kwh": solar_forecast.copy(),
                    "forecast_lo_kwh": solar_forecast.copy() * 0.85,
                    "forecast_hi_kwh": solar_forecast.copy() * 1.15,
                    "forecast_mw": solar_forecast.copy() / 200.0,
                    "spread_frac": np.ones(mod.SLOTS_DAY, dtype=float) * 0.15,
                    "present": np.ones(mod.SLOTS_DAY, dtype=bool),
                }
                # Return a full solcast_prior dict with all expected fields
                def mock_solcast_prior(day, w5, snapshot, rel):
                    present_arr = np.ones(mod.SLOTS_DAY, dtype=bool)
                    return {
                        "available": present_arr.astype(float),
                        "present": present_arr,
                        "prior_kwh": solar_forecast.copy(),
                        "prior_lo_kwh": solar_forecast.copy() * 0.85,
                        "prior_hi_kwh": solar_forecast.copy() * 1.15,
                        "prior_mw": solar_forecast.copy() / 200.0,
                        "spread_frac": np.ones(mod.SLOTS_DAY, dtype=float) * 0.15,
                        "blend": np.ones(mod.SLOTS_DAY, dtype=float) * 0.8,
                        "coverage_ratio": 1.0,
                        "bias_ratio": 1.0,
                        "reliability": 0.8,
                        "resolution_weight": np.ones(mod.SLOTS_DAY, dtype=float),
                        "resolution_support": np.ones(mod.SLOTS_DAY, dtype=float),
                        "primary_mode": True,
                        "regime": "mixed",
                        "season": "dry",
                        "trend_signal": "stable",
                        "trend_magnitude": 0.0,
                        "spread_confidence": 0.85,
                        "has_triband": True,
                        "source": "solcast",
                        "pulled_ts": 0,
                    }
                mod.solcast_prior_from_snapshot = mock_solcast_prior
                mod.load_solcast_reliability_artifact = lambda today, allow_build=True: None
                mod.blend_physics_with_solcast = lambda baseline, prior: (
                    baseline.copy(),
                    {"used_solcast": True, "coverage_ratio": 1.0, "mean_blend": 1.0, "reliability": 0.8, "bias_ratio": 1.0, "raw_prior_ratio": 1.0, "applied_prior_ratio": 1.0, "regime": "mixed", "source": "test"},
                )
                mod.load_forecast_artifacts = lambda today, allow_build=True: {}
                mod.load_model_bundle = lambda: None
                mod.compute_error_memory = lambda today, w5, **kw: np.zeros(mod.SLOTS_DAY, dtype=float)
                mod.apply_activity_hysteresis = lambda forecast, target_s, w5, artifacts, bias_meta=None: (
                    forecast.copy(),
                    {"first_slot": mod.SOLAR_START_SLOT, "last_slot": mod.SOLAR_END_SLOT - 1, "history_matches": 0, "bias_shift_slots": 0},
                )
                mod.apply_block_staging = lambda forecast, w5: (
                    forecast.copy(),
                    {"staged_slots": 0, "node_step_kwh": 0.0},
                )
                mod.apply_ramp_limit = lambda arr, max_step=320.0: arr.copy()
                mod.confidence_bands = lambda forecast, w5, target_s, regime_confidence=1.0, error_class_meta=None, solcast_prior=None: (
                    forecast.copy(),
                    forecast.copy(),
                )
                captured = {}
                mod.write_forecast = lambda key, day_text, series: captured.setdefault("series", series) is not None

                ok = mod.run_dayahead(day, day, persist=True)
            finally:
                mod.fetch_weather = orig_fetch_weather
                mod.load_forecast_weather_snapshot = orig_load_snapshot
                mod.load_weather_bias_artifact = orig_load_weather_bias
                mod.apply_weather_bias_adjustment = orig_apply_bias
                mod.validate_weather_5min = orig_validate_w5
                mod.analyse_weather_day = orig_analyse
                mod.classify_day_regime = orig_classify
                mod.physics_baseline = orig_physics
                mod.load_solcast_snapshot = orig_solcast_snapshot
                mod.solcast_prior_from_snapshot = orig_solcast_prior_from_snapshot
                mod.load_solcast_reliability_artifact = orig_solcast_rel
                mod.blend_physics_with_solcast = orig_blend_solcast
                mod.load_forecast_artifacts = orig_load_artifacts
                mod.load_model_bundle = orig_load_model
                mod.compute_error_memory = orig_error_memory
                mod.apply_activity_hysteresis = orig_activity
                mod.apply_block_staging = orig_staging
                mod.apply_ramp_limit = orig_ramp
                mod.confidence_bands = orig_conf
                mod.write_forecast = orig_write

            self.assertTrue(ok)
            self.assertTrue(captured.get("series"))
        finally:
            logging.shutdown()
            shutil.rmtree(tmp_root, ignore_errors=True)

if __name__ == "__main__":
    unittest.main()
