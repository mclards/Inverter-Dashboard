import importlib.util
import logging
import os
import shutil
import sqlite3
import unittest
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "services" / "forecast_engine.py"
WORK_TMP = ROOT / ".tmp" / "forecast-engine-error-classifier-tests"
WORK_TMP.mkdir(parents=True, exist_ok=True)

def load_module(temp_root: Path, tag: str):
    (temp_root / "data").mkdir(parents=True, exist_ok=True)
    (temp_root / "portable").mkdir(parents=True, exist_ok=True)
    os.environ["ADSI_DATA_DIR"] = str(temp_root / "data")
    os.environ["ADSI_PORTABLE_DATA_DIR"] = str(temp_root / "portable")
    spec = importlib.util.spec_from_file_location(f"forecast_engine_error_classifier_test_{tag}", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module

class IdentityScaler:
    def __init__(self, n_features: int):
        self.n_features_in_ = n_features

    def transform(self, X):
        return np.asarray(X, dtype=float)

class ZeroRegressor:
    def __init__(self):
        self.n_estimators = 1

    def predict(self, X):
        return np.zeros(len(X), dtype=float)

class FixedClassifier:
    def __init__(self, probs):
        self.classes_ = np.arange(len(probs), dtype=int)
        self.n_estimators = 1
        self._probs = np.asarray(probs, dtype=float)

    def predict_proba(self, X):
        return np.tile(self._probs, (len(X), 1))

class ForecastEngineErrorClassifierTests(unittest.TestCase):
    def test_fit_error_classifier_skips_when_only_one_class_present(self):
        tmp_root = WORK_TMP / "single-class-skip"
        shutil.rmtree(tmp_root, ignore_errors=True)
        tmp_root.mkdir(parents=True, exist_ok=True)
        try:
            mod = load_module(tmp_root, "single-class-skip")
            X = pd.DataFrame({
                col: np.zeros(24, dtype=float)
                for col in mod.FEATURE_COLS
            })
            residual = np.zeros(24, dtype=float)
            sample_weight = np.ones(24, dtype=float)

            model, scaler, meta = mod.fit_error_classifier(X, residual, sample_weight)

            self.assertIsNone(model)
            self.assertIsNone(scaler)
            self.assertIsNone(meta)
        finally:
            logging.shutdown()
            shutil.rmtree(tmp_root, ignore_errors=True)

    def test_weather_bucket_and_residual_classification(self):
        tmp_root = WORK_TMP / "bucket-classes"
        shutil.rmtree(tmp_root, ignore_errors=True)
        tmp_root.mkdir(parents=True, exist_ok=True)
        try:
            mod = load_module(tmp_root, "bucket-classes")
            w5 = pd.DataFrame({
                "rad": np.full(mod.SLOTS_DAY, 200.0),
                "cloud": np.full(mod.SLOTS_DAY, 90.0),
                "rh": np.full(mod.SLOTS_DAY, 60.0),
                "precip": np.zeros(mod.SLOTS_DAY),
                "cape": np.zeros(mod.SLOTS_DAY),
            })
            clear_slot = mod.SOLAR_START_SLOT + 10
            clear_edge_slot = mod.SOLAR_START_SLOT + 20
            mixed_slot = mod.SOLAR_START_SLOT + 30
            volatile_slot = mod.SOLAR_START_SLOT + 40
            rainy_slot = mod.SOLAR_START_SLOT + 50

            w5.loc[clear_slot - 1, "rad"] = 760.0
            w5.loc[clear_slot, ["rad", "cloud"]] = [800.0, 12.0]

            w5.loc[clear_edge_slot - 1, "rad"] = 500.0
            w5.loc[clear_edge_slot, ["rad", "cloud"]] = [700.0, 20.0]

            w5.loc[mixed_slot - 1, "rad"] = 520.0
            w5.loc[mixed_slot, ["rad", "cloud"]] = [500.0, 50.0]

            w5.loc[volatile_slot - 1, "rad"] = 300.0
            w5.loc[volatile_slot, ["rad", "cloud"]] = [700.0, 60.0]

            w5.loc[rainy_slot, ["rad", "cloud", "precip", "cape"]] = [400.0, 88.0, 0.2, 900.0]

            orig_clear_sky = mod.clear_sky_radiation
            try:
                mod.clear_sky_radiation = lambda day, rh: np.full(mod.SLOTS_DAY, 1000.0, dtype=float)
                buckets = mod.classify_slot_weather_buckets(w5, "2026-03-20")
            finally:
                mod.clear_sky_radiation = orig_clear_sky

            self.assertEqual(str(buckets[clear_slot]), "clear_stable")
            self.assertEqual(str(buckets[clear_edge_slot]), "clear_edge")
            self.assertEqual(str(buckets[mixed_slot]), "mixed_stable")
            self.assertEqual(str(buckets[volatile_slot]), "mixed_volatile")
            self.assertEqual(str(buckets[rainy_slot]), "rainy")

            labels = mod.classify_residual_error_classes(
                np.array([-180.0, -60.0, 0.0, 60.0, 180.0], dtype=float),
                cap_slot=1000.0,
            )
            self.assertEqual(labels.tolist(), [0, 1, 2, 3, 4])

            cap_labels = mod.classify_residual_error_classes(
                np.array([50.0, 50.0], dtype=float),
                cap_slot=1000.0,
            )
            opp_labels = mod.classify_residual_error_classes(
                np.array([50.0, 50.0], dtype=float),
                baseline_kwh=np.array([100.0, 800.0], dtype=float),
                cap_slot=1000.0,
            )
            self.assertEqual(cap_labels.tolist(), [3, 3])
            self.assertEqual(opp_labels.tolist(), [4, 3])
        finally:
            logging.shutdown()
            shutil.rmtree(tmp_root, ignore_errors=True)

    def test_vectorized_bucket_classification_matches_reference_rules(self):
        tmp_root = WORK_TMP / "bucket-class-reference"
        shutil.rmtree(tmp_root, ignore_errors=True)
        tmp_root.mkdir(parents=True, exist_ok=True)
        try:
            mod = load_module(tmp_root, "bucket-class-reference")
            rng = np.random.default_rng(42)
            w5 = pd.DataFrame({
                "rad": rng.uniform(0.0, 950.0, mod.SLOTS_DAY),
                "cloud": rng.uniform(0.0, 100.0, mod.SLOTS_DAY),
                "rh": rng.uniform(35.0, 95.0, mod.SLOTS_DAY),
                "precip": rng.uniform(0.0, 0.25, mod.SLOTS_DAY),
                "cape": rng.uniform(0.0, 1200.0, mod.SLOTS_DAY),
            })

            def reference_bucket_labels(day: str) -> np.ndarray:
                rad = np.clip(pd.to_numeric(w5["rad"], errors="coerce").fillna(0.0).values[:mod.SLOTS_DAY], 0.0, None)
                cloud = np.clip(pd.to_numeric(w5["cloud"], errors="coerce").fillna(0.0).values[:mod.SLOTS_DAY], 0.0, 100.0)
                precip = np.clip(pd.to_numeric(w5["precip"], errors="coerce").fillna(0.0).values[:mod.SLOTS_DAY], 0.0, None)
                cape = np.clip(pd.to_numeric(w5["cape"], errors="coerce").fillna(0.0).values[:mod.SLOTS_DAY], 0.0, None)
                rh = np.clip(pd.to_numeric(w5["rh"], errors="coerce").fillna(0.0).values[:mod.SLOTS_DAY], 0.0, 100.0)
                csi = mod.clear_sky_radiation(day, rh)
                kt = np.where(csi > 10.0, rad / np.maximum(csi, 1.0), 0.0)
                kt = np.clip(kt, 0.0, 1.2)
                drad = np.abs(np.diff(rad, prepend=rad[0]))

                out = np.full(mod.SLOTS_DAY, "offsolar", dtype=object)
                for idx in range(mod.SOLAR_START_SLOT, mod.SOLAR_END_SLOT):
                    if precip[idx] > mod.WEATHER_BUCKET_RAIN_MM or (
                        cape[idx] >= mod.WEATHER_BUCKET_RAIN_CAPE and cloud[idx] >= mod.WEATHER_BUCKET_RAIN_CLOUD
                    ):
                        out[idx] = "rainy"
                    elif (
                        cloud[idx] < mod.WEATHER_BUCKET_CLEAR_CLOUD
                        and kt[idx] >= mod.WEATHER_BUCKET_CLEAR_KT
                        and drad[idx] < mod.WEATHER_BUCKET_CLEAR_DRAD
                    ):
                        out[idx] = "clear_stable"
                    elif (
                        cloud[idx] < mod.WEATHER_BUCKET_CLEAR_EDGE_CLOUD
                        and kt[idx] >= mod.WEATHER_BUCKET_CLEAR_EDGE_KT
                        and drad[idx] >= mod.WEATHER_BUCKET_CLEAR_DRAD
                    ):
                        out[idx] = "clear_edge"
                    elif (
                        cloud[idx] >= mod.WEATHER_BUCKET_CLEAR_CLOUD
                        and cloud[idx] < mod.WEATHER_BUCKET_MIXED_CLOUD
                        and kt[idx] >= mod.WEATHER_BUCKET_MIXED_KT
                        and drad[idx] < mod.WEATHER_BUCKET_MIXED_VOL_DRAD
                        and precip[idx] <= mod.WEATHER_BUCKET_RAIN_MM
                    ):
                        out[idx] = "mixed_stable"
                    elif (
                        cloud[idx] >= mod.WEATHER_BUCKET_CLEAR_CLOUD
                        and cloud[idx] < mod.WEATHER_BUCKET_MIXED_VOL_CLOUD
                        and drad[idx] >= mod.WEATHER_BUCKET_MIXED_VOL_DRAD
                        and precip[idx] <= mod.WEATHER_BUCKET_RAIN_MM
                    ):
                        out[idx] = "mixed_volatile"
                    else:
                        out[idx] = "overcast"
                return out

            orig_clear_sky = mod.clear_sky_radiation
            try:
                mod.clear_sky_radiation = lambda day, rh: np.full(mod.SLOTS_DAY, 900.0, dtype=float)
                actual = mod.classify_slot_weather_buckets(w5, "2026-03-20")
                expected = reference_bucket_labels("2026-03-20")
            finally:
                mod.clear_sky_radiation = orig_clear_sky

            self.assertEqual(actual.tolist(), expected.tolist())
        finally:
            logging.shutdown()
            shutil.rmtree(tmp_root, ignore_errors=True)

    def test_probability_temperature_and_blocked_holdout_helpers(self):
        tmp_root = WORK_TMP / "temperature-holdout"
        shutil.rmtree(tmp_root, ignore_errors=True)
        tmp_root.mkdir(parents=True, exist_ok=True)
        try:
            mod = load_module(tmp_root, "temperature-holdout")
            raw_probs = np.array([
                [0.92, 0.05, 0.01, 0.01, 0.01],
                [0.88, 0.07, 0.02, 0.02, 0.01],
                [0.90, 0.04, 0.03, 0.02, 0.01],
            ], dtype=float)
            labels = np.array([1, 1, 2], dtype=int)
            base_nll = mod._weighted_neg_log_loss(raw_probs, labels)
            scaled = mod._apply_probability_temperature(raw_probs, 2.0)
            scaled_nll = mod._weighted_neg_log_loss(scaled, labels)

            self.assertLess(scaled_nll, base_nll)
            self.assertGreater(float(scaled[0, 1]), float(raw_probs[0, 1]))
            self.assertLess(float(scaled[0, 0]), float(raw_probs[0, 0]))

            day_keys = []
            for day in ("2026-03-19", "2026-03-18", "2026-03-17", "2026-03-16", "2026-03-15", "2026-03-14", "2026-03-13", "2026-03-12"):
                day_keys.extend([day] * 3)
            holdout = mod._blocked_classifier_holdout_mask(np.asarray(day_keys, dtype=object))
            self.assertEqual(int(np.count_nonzero(holdout)), 6)
            self.assertTrue(bool(np.all(holdout[:6])))
            self.assertFalse(bool(np.any(holdout[6:])))
        finally:
            logging.shutdown()
            shutil.rmtree(tmp_root, ignore_errors=True)

    def test_support_and_weather_profile_reliability_helpers(self):
        tmp_root = WORK_TMP / "support-profile-helpers"
        shutil.rmtree(tmp_root, ignore_errors=True)
        tmp_root.mkdir(parents=True, exist_ok=True)
        try:
            mod = load_module(tmp_root, "support-profile-helpers")
            weights = mod._error_class_support_weights({
                "class_counts": {
                    "strong_over": 2,
                    "mild_over": 9,
                    "neutral": 80,
                    "mild_under": 12,
                    "strong_under": 1,
                },
                "sample_count": 104,
            })
            self.assertLess(float(weights[0]), float(weights[1]))
            self.assertEqual(float(weights[mod.ERROR_CLASS_NEUTRAL_IDX]), 1.0)
            self.assertLess(float(weights[4]), float(weights[3]))

            profile_rel = mod._weather_profile_reliability_vector(
                {
                    "cap_slot_kwh": 1000.0,
                    "pairs": {
                        "clear:clear_stable": {"count": 64, "mean": 20.0, "std": 12.0, "mae": 24.0},
                        "clear:mixed_volatile": {"count": 4, "mean": 35.0, "std": 180.0, "mae": 160.0},
                    },
                    "buckets": {
                        "clear_stable": {"count": 80, "mean": 18.0, "std": 15.0, "mae": 20.0},
                        "mixed_volatile": {"count": 8, "mean": 30.0, "std": 200.0, "mae": 170.0},
                    },
                    "regimes": {
                        "clear": {"count": 90, "mean": 22.0, "std": 18.0, "mae": 24.0},
                    },
                },
                "clear",
                np.array(["clear_stable", "mixed_volatile", "offsolar"], dtype=object),
            )
            self.assertGreater(float(profile_rel[0]), float(profile_rel[1]))
            self.assertEqual(float(profile_rel[2]), 0.0)
        finally:
            logging.shutdown()
            shutil.rmtree(tmp_root, ignore_errors=True)

    def test_numpy_rolling_helpers_match_pandas(self):
        tmp_root = WORK_TMP / "numpy-rolling-helpers"
        shutil.rmtree(tmp_root, ignore_errors=True)
        tmp_root.mkdir(parents=True, exist_ok=True)
        try:
            mod = load_module(tmp_root, "numpy-rolling-helpers")
            arr = np.array([0.0, 2.0, np.nan, 6.0, 10.0, -4.0, 8.0], dtype=float)

            mean_expected = pd.Series(arr).rolling(3, min_periods=1, center=True).mean().values
            sum_expected = pd.Series(arr).rolling(4, min_periods=1).sum().values
            std_expected = pd.Series(arr).rolling(4, min_periods=1).std().values

            np.testing.assert_allclose(mod._rolling_mean(arr, 3, center=True), mean_expected, equal_nan=True)
            np.testing.assert_allclose(mod._rolling_sum(arr, 4), sum_expected, equal_nan=True)
            np.testing.assert_allclose(mod._rolling_std(arr, 4), std_expected, equal_nan=True)
        finally:
            logging.shutdown()
            shutil.rmtree(tmp_root, ignore_errors=True)

    def test_training_models_record_blocked_stage_validation(self):
        tmp_root = WORK_TMP / "stage-validation-meta"
        shutil.rmtree(tmp_root, ignore_errors=True)
        tmp_root.mkdir(parents=True, exist_ok=True)
        try:
            mod = load_module(tmp_root, "stage-validation-meta")
            samples_per_day = 60
            day_keys = []
            for day_idx in range(14):
                day_keys.extend([f"2026-03-{day_idx + 1:02d}"] * samples_per_day)
            n = len(day_keys)
            x_axis = np.tile(np.linspace(-1.0, 1.0, samples_per_day), 14)
            X = pd.DataFrame({
                col: (x_axis * (idx + 1)) if idx < 3 else np.zeros(n, dtype=float)
                for idx, col in enumerate(mod.FEATURE_COLS)
            })
            residual = np.where(x_axis > 0.45, 180.0, np.where(x_axis < -0.45, -160.0, x_axis * 60.0)).astype(float)
            sample_weight = np.ones(n, dtype=float)
            opportunity = np.full(n, 1000.0, dtype=float)

            reg_model, reg_scaler, reg_meta = mod.fit_residual_model(X, residual, sample_weight, day_keys=np.asarray(day_keys, dtype=object))
            cls_model, cls_scaler, cls_meta = mod.fit_error_classifier(
                X,
                residual,
                sample_weight,
                opportunity_kwh=opportunity,
                day_keys=np.asarray(day_keys, dtype=object),
            )

            self.assertIsNotNone(reg_model)
            self.assertIsNone(reg_scaler)
            self.assertIsNotNone(cls_model)
            self.assertIsNone(cls_scaler)
            # LightGBM skips staged holdout selection (no staged_predict); sklearn GBR uses it.
            _lgbm_active = getattr(mod, "FORECAST_USE_LIGHTGBM", False) and getattr(mod, "_LIGHTGBM_AVAILABLE", False)
            if not _lgbm_active:
                self.assertTrue(bool(reg_meta["stage_validation"]["used_blocked_validation"]))
                self.assertGreaterEqual(int(reg_meta["stage_validation"]["holdout_samples"]), mod.MODEL_STAGE_HOLDOUT_MIN_SAMPLES)
                self.assertTrue(bool(cls_meta["stage_validation"]["used_blocked_validation"]))
                self.assertGreaterEqual(int(cls_meta["stage_validation"]["holdout_samples"]), mod.MODEL_STAGE_HOLDOUT_MIN_SAMPLES)

            bundle = {
                "feature_cols": list(mod.FEATURE_COLS),
                "global": {"model": reg_model, "scaler": reg_scaler, "meta": reg_meta},
                "regimes": {},
                "error_classifier": {
                    "class_names": list(mod.ERROR_CLASS_NAMES),
                    "global": {"model": cls_model, "scaler": cls_scaler, "meta": cls_meta},
                    "regimes": {},
                    "weather_profiles": {},
                },
            }
            reg_pred, reg_pred_meta = mod.predict_residual_with_bundle(bundle, X.iloc[:8].copy(), "clear")
            cls_pred, cls_pred_meta = mod.predict_error_classifier_with_bundle(bundle, X.iloc[:8].copy(), "clear")
            self.assertEqual(len(reg_pred), 8)
            self.assertEqual(len(cls_pred), 8)
            self.assertFalse(bool(reg_pred_meta["used_regime_model"]))
            self.assertTrue(bool(cls_pred_meta["available"]))
        finally:
            logging.shutdown()
            shutil.rmtree(tmp_root, ignore_errors=True)

    def test_predict_error_classifier_damps_sparse_extremes(self):
        tmp_root = WORK_TMP / "predict-sparse-extremes"
        shutil.rmtree(tmp_root, ignore_errors=True)
        tmp_root.mkdir(parents=True, exist_ok=True)
        try:
            mod = load_module(tmp_root, "predict-sparse-extremes")
            X_pred = pd.DataFrame({
                col: np.zeros(2, dtype=float)
                for col in mod.FEATURE_COLS
            })
            bundle = {
                "feature_cols": list(mod.FEATURE_COLS),
                "error_classifier": {
                    "class_names": list(mod.ERROR_CLASS_NAMES),
                    "global": {
                        "model": FixedClassifier([0.01, 0.02, 0.05, 0.12, 0.80]),
                        "scaler": IdentityScaler(len(mod.FEATURE_COLS)),
                        "meta": {
                            "feature_names": list(mod.FEATURE_COLS),
                            "sample_count": 214,
                            "class_counts": {
                                "strong_over": 1,
                                "mild_over": 3,
                                "neutral": 198,
                                "mild_under": 11,
                                "strong_under": 1,
                            },
                            "centroids_kwh": {"0": -160.0, "1": -70.0, "2": 0.0, "3": 90.0, "4": 220.0},
                        },
                    },
                    "regimes": {},
                    "weather_profiles": {
                        "cap_slot_kwh": 1000.0,
                        "pairs": {
                            "clear:clear_stable": {"count": 48, "mean": 15.0, "std": 10.0, "mae": 20.0},
                            "clear:mixed_volatile": {"count": 5, "mean": 40.0, "std": 220.0, "mae": 180.0},
                        },
                        "buckets": {
                            "clear_stable": {"count": 60, "mean": 15.0, "std": 12.0, "mae": 18.0},
                            "mixed_volatile": {"count": 8, "mean": 45.0, "std": 200.0, "mae": 170.0},
                        },
                        "regimes": {
                            "clear": {"count": 72, "mean": 18.0, "std": 14.0, "mae": 20.0},
                        },
                    },
                },
            }

            bias, meta = mod.predict_error_classifier_with_bundle(
                bundle,
                X_pred,
                "clear",
                slot_weather_buckets=np.array(["clear_stable", "mixed_volatile"], dtype=object),
            )

            self.assertEqual(meta["predicted_labels"].tolist(), [mod.ERROR_CLASS_NEUTRAL_IDX, mod.ERROR_CLASS_NEUTRAL_IDX])
            self.assertGreater(float(meta["profile_reliability"][0]), float(meta["profile_reliability"][1]))
            self.assertGreater(float(meta["cap_frac"][0]), float(meta["cap_frac"][1]))
            self.assertLess(float(meta["confidence"][0]), 0.90)
            self.assertTrue(np.all(np.asarray(bias, dtype=float) >= 0.0))
        finally:
            logging.shutdown()
            shutil.rmtree(tmp_root, ignore_errors=True)

    def test_confidence_bands_widen_with_low_classifier_confidence(self):
        tmp_root = WORK_TMP / "confidence-bands"
        shutil.rmtree(tmp_root, ignore_errors=True)
        tmp_root.mkdir(parents=True, exist_ok=True)
        try:
            mod = load_module(tmp_root, "confidence-bands")
            values = np.zeros(mod.SLOTS_DAY, dtype=float)
            values[mod.SOLAR_START_SLOT:mod.SOLAR_END_SLOT] = 100.0
            w5 = pd.DataFrame({
                "rad": np.full(mod.SLOTS_DAY, 650.0),
                "cloud": np.full(mod.SLOTS_DAY, 18.0),
                "rh": np.full(mod.SLOTS_DAY, 60.0),
                "temp": np.full(mod.SLOTS_DAY, 28.0),
            })
            mid_slot = mod.SOLAR_START_SLOT + (mod.SOLAR_SLOTS // 2)
            low_conf_meta = {
                "confidence": np.full(mod.SLOTS_DAY, 0.10, dtype=float),
                "severe_probability": np.full(mod.SLOTS_DAY, 0.85, dtype=float),
            }

            lo_base, hi_base = mod.confidence_bands(values, w5, "2026-03-20")
            lo_cls, hi_cls = mod.confidence_bands(values, w5, "2026-03-20", error_class_meta=low_conf_meta)

            base_width = float(hi_base[mid_slot] - lo_base[mid_slot])
            cls_width = float(hi_cls[mid_slot] - lo_cls[mid_slot])
            self.assertGreater(cls_width, base_width)
        finally:
            logging.shutdown()
            shutil.rmtree(tmp_root, ignore_errors=True)

    def test_solcast_prior_prefers_clear_weather_when_reliable(self):
        tmp_root = WORK_TMP / "solcast-clear"
        shutil.rmtree(tmp_root, ignore_errors=True)
        tmp_root.mkdir(parents=True, exist_ok=True)
        try:
            mod = load_module(tmp_root, "solcast-clear")
            day = "2026-03-20"
            w5 = pd.DataFrame({
                "rad": np.full(mod.SLOTS_DAY, 750.0),
                "cloud": np.full(mod.SLOTS_DAY, 15.0),
                "rh": np.full(mod.SLOTS_DAY, 60.0),
                "precip": np.zeros(mod.SLOTS_DAY),
                "cape": np.zeros(mod.SLOTS_DAY),
                "cloud_low": np.full(mod.SLOTS_DAY, 10.0),
                "cloud_mid": np.full(mod.SLOTS_DAY, 8.0),
                "cloud_high": np.full(mod.SLOTS_DAY, 6.0),
                "temp": np.full(mod.SLOTS_DAY, 28.0),
                "wind": np.full(mod.SLOTS_DAY, 3.0),
            })
            snapshot = {
                "forecast_kwh": np.full(mod.SLOTS_DAY, 120.0, dtype=float),
                "forecast_lo_kwh": np.full(mod.SLOTS_DAY, 100.0, dtype=float),
                "forecast_hi_kwh": np.full(mod.SLOTS_DAY, 140.0, dtype=float),
                "forecast_mw": np.full(mod.SLOTS_DAY, 1.44, dtype=float),
                "spread_frac": np.full(mod.SLOTS_DAY, 0.08, dtype=float),
                "present": np.ones(mod.SLOTS_DAY, dtype=bool),
                "coverage_slots": int(mod.SOLAR_SLOTS),
                "coverage_ratio": 0.78,
                "source": "solcast",
            }
            reliability = {
                "regimes": {
                    "clear": {"bias_ratio": 1.0, "reliability": 0.92, "coverage_ratio": 0.85},
                    "mixed": {"bias_ratio": 1.0, "reliability": 0.92, "coverage_ratio": 0.85},
                }
            }

            orig_analyse = mod.analyse_weather_day
            orig_classify = mod.classify_day_regime
            try:
                mod.analyse_weather_day = lambda day, w5, actual=None: {
                    "cloud_mean": 12.0,
                    "rad_peak": 800.0,
                    "rh_mean": 60.0,
                    "vol_index": 0.05,
                    "rainy": False,
                    "convective": False,
                    "sky_class": "clear",
                }
                mod.classify_day_regime = lambda stats: "clear"
                clear_prior = mod.solcast_prior_from_snapshot(day, w5, snapshot, reliability)
                mod.classify_day_regime = lambda stats: "mixed"
                mixed_prior = mod.solcast_prior_from_snapshot(day, w5, snapshot, reliability)
            finally:
                mod.analyse_weather_day = orig_analyse
                mod.classify_day_regime = orig_classify

            self.assertIsNotNone(clear_prior)
            self.assertIsNotNone(mixed_prior)
            clear_blend = float(np.mean(np.asarray(clear_prior["blend"], dtype=float)[mod.SOLAR_START_SLOT:mod.SOLAR_END_SLOT]))
            mixed_blend = float(np.mean(np.asarray(mixed_prior["blend"], dtype=float)[mod.SOLAR_START_SLOT:mod.SOLAR_END_SLOT]))
            self.assertGreater(clear_blend, mixed_blend)
        finally:
            logging.shutdown()
            shutil.rmtree(tmp_root, ignore_errors=True)

    def test_solcast_reliability_uses_loss_adjusted_actuals(self):
        tmp_root = WORK_TMP / "solcast-loss-adjusted-reliability"
        shutil.rmtree(tmp_root, ignore_errors=True)
        tmp_root.mkdir(parents=True, exist_ok=True)
        try:
            mod = load_module(tmp_root, "solcast-loss-adjusted-reliability")
            day_values = {
                "2026-03-19": 8.0,
                "2026-03-18": 10.0,
            }
            expected_days = sorted(day_values.keys())
            solar_mask = np.zeros(mod.SLOTS_DAY, dtype=bool)
            solar_mask[mod.SOLAR_START_SLOT:mod.SOLAR_END_SLOT] = True

            def make_actual(slot_value: float) -> np.ndarray:
                arr = np.zeros(mod.SLOTS_DAY, dtype=float)
                arr[solar_mask] = slot_value
                return arr

            snapshot = {
                "forecast_kwh": np.where(solar_mask, 10.0, 0.0).astype(float),
                "spread_frac": np.where(solar_mask, 0.10, 0.0).astype(float),
                "present": solar_mask.copy(),
                "coverage_slots": int(np.count_nonzero(solar_mask)),
                "coverage_ratio": 1.0,
            }
            w5 = pd.DataFrame({
                "rad": np.full(mod.SLOTS_DAY, 700.0),
                "cloud": np.full(mod.SLOTS_DAY, 20.0),
                "rh": np.full(mod.SLOTS_DAY, 60.0),
                "precip": np.zeros(mod.SLOTS_DAY),
                "cape": np.zeros(mod.SLOTS_DAY),
            })
            loss_adjusted_calls: list[str] = []
            dayahead = np.zeros(mod.SLOTS_DAY, dtype=float)
            dayahead[solar_mask] = 9.0

            def fail_raw_actual(day: str):
                raise AssertionError(f"raw actual loader should not be used for {day}")

            def fake_loss_adjusted(day: str):
                loss_adjusted_calls.append(day)
                slot_value = day_values.get(day)
                if slot_value is None:
                    return None, None
                return make_actual(slot_value), solar_mask.copy()

            orig_load_actual = mod.load_actual
            orig_load_actual_loss_adjusted = mod.load_actual_loss_adjusted_with_presence
            orig_load_solcast_snapshot = mod.load_solcast_snapshot
            orig_load_dayahead = mod.load_dayahead_with_presence
            orig_fetch_weather = mod.fetch_weather
            orig_interpolate_5min = mod.interpolate_5min
            orig_analyse = mod.analyse_weather_day
            orig_classify = mod.classify_day_regime
            orig_constraints = mod.build_operational_constraint_mask
            orig_lookback = mod.SOLCAST_RELIABILITY_LOOKBACK_DAYS
            orig_train_days = mod.N_TRAIN_DAYS
            orig_min_days = mod.SOLCAST_RELIABILITY_MIN_DAYS
            try:
                mod.load_actual = fail_raw_actual
                mod.load_actual_loss_adjusted_with_presence = fake_loss_adjusted
                mod.load_solcast_snapshot = lambda day: snapshot.copy() if day in day_values else None
                mod.load_dayahead_with_presence = lambda day: (dayahead.copy(), solar_mask.copy()) if day in day_values else (None, None)
                mod.fetch_weather = lambda day, source="archive": pd.DataFrame({"time": pd.date_range(f"{day} 00:00:00", periods=24, freq="1h")})
                mod.interpolate_5min = lambda df, day: w5.copy()
                mod.analyse_weather_day = lambda day, w5, actual=None: {
                    "cloud_mean": 20.0,
                    "rad_peak": 700.0,
                    "rh_mean": 60.0,
                    "vol_index": 0.05,
                    "rainy": False,
                    "convective": False,
                    "sky_class": "clear",
                }
                mod.classify_day_regime = lambda stats: "clear"
                mod.build_operational_constraint_mask = lambda day: (
                    np.zeros(mod.SLOTS_DAY, dtype=bool),
                    {"operational_mask": np.zeros(mod.SLOTS_DAY, dtype=bool)},
                )
                mod.SOLCAST_RELIABILITY_LOOKBACK_DAYS = 2
                mod.N_TRAIN_DAYS = 2
                mod.SOLCAST_RELIABILITY_MIN_DAYS = 2

                artifact = mod.build_solcast_reliability_artifact(date(2026, 3, 20))
            finally:
                mod.load_actual = orig_load_actual
                mod.load_actual_loss_adjusted_with_presence = orig_load_actual_loss_adjusted
                mod.load_solcast_snapshot = orig_load_solcast_snapshot
                mod.load_dayahead_with_presence = orig_load_dayahead
                mod.fetch_weather = orig_fetch_weather
                mod.interpolate_5min = orig_interpolate_5min
                mod.analyse_weather_day = orig_analyse
                mod.classify_day_regime = orig_classify
                mod.build_operational_constraint_mask = orig_constraints
                mod.SOLCAST_RELIABILITY_LOOKBACK_DAYS = orig_lookback
                mod.N_TRAIN_DAYS = orig_train_days
                mod.SOLCAST_RELIABILITY_MIN_DAYS = orig_min_days

            self.assertIsNotNone(artifact)
            self.assertEqual(sorted(loss_adjusted_calls), expected_days)
            self.assertAlmostEqual(float(artifact["regimes"]["clear"]["bias_ratio"]), 0.91, places=6)
            self.assertEqual(int(artifact["resolution_profiles"]["resolution_minutes"]), mod.SLOT_MIN)
            self.assertEqual(str(artifact["resolution_profiles"]["source_power_unit"]), "mw")
            self.assertEqual(str(artifact["resolution_profiles"]["energy_unit"]), "kwh_per_slot")
            self.assertEqual(str(artifact["resolution_profiles"]["actual_basis"]), "loss_adjusted_actual")
            self.assertEqual(int(artifact["resolution_profiles"]["day_count"]), 2)
            self.assertIn("clear_stable", artifact["resolution_profiles"]["buckets"])
        finally:
            logging.shutdown()
            shutil.rmtree(tmp_root, ignore_errors=True)

    def test_load_solcast_snapshot_derives_kwh_from_raw_mw(self):
        tmp_root = WORK_TMP / "solcast-mw-normalization"
        shutil.rmtree(tmp_root, ignore_errors=True)
        tmp_root.mkdir(parents=True, exist_ok=True)
        try:
            mod = load_module(tmp_root, "solcast-mw-normalization")
            conn = sqlite3.connect(mod.APP_DB_FILE)
            try:
                conn.execute(
                    """
                    CREATE TABLE solcast_snapshots (
                        forecast_day    TEXT NOT NULL,
                        slot            INTEGER NOT NULL,
                        forecast_kwh    REAL,
                        forecast_lo_kwh REAL,
                        forecast_hi_kwh REAL,
                        est_actual_kwh  REAL,
                        forecast_mw     REAL,
                        forecast_lo_mw  REAL,
                        forecast_hi_mw  REAL,
                        est_actual_mw   REAL,
                        pulled_ts       INTEGER,
                        source          TEXT
                    )
                    """
                )
                conn.execute(
                    """
                    INSERT INTO solcast_snapshots (
                        forecast_day, slot,
                        forecast_kwh, forecast_lo_kwh, forecast_hi_kwh, est_actual_kwh,
                        forecast_mw, forecast_lo_mw, forecast_hi_mw, est_actual_mw,
                        pulled_ts, source
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        "2026-03-20",
                        mod.SOLAR_START_SLOT,
                        None, None, None, None,
                        1.2, 1.0, 1.4, 0.9,
                        1710800000000,
                        "solcast",
                    ),
                )
                conn.commit()
            finally:
                conn.close()

            snapshot = mod.load_solcast_snapshot("2026-03-20")
            self.assertIsNotNone(snapshot)
            slot = mod.SOLAR_START_SLOT
            self.assertAlmostEqual(float(snapshot["forecast_mw"][slot]), 1.2, places=6)
            self.assertAlmostEqual(float(snapshot["forecast_lo_mw"][slot]), 1.0, places=6)
            self.assertAlmostEqual(float(snapshot["forecast_hi_mw"][slot]), 1.4, places=6)
            self.assertAlmostEqual(float(snapshot["est_actual_mw"][slot]), 0.9, places=6)
            self.assertAlmostEqual(float(snapshot["forecast_kwh"][slot]), 1.2 * mod.SOLCAST_KWH_PER_MW_SLOT, places=6)
            self.assertAlmostEqual(float(snapshot["forecast_lo_kwh"][slot]), 1.0 * mod.SOLCAST_KWH_PER_MW_SLOT, places=6)
            self.assertAlmostEqual(float(snapshot["forecast_hi_kwh"][slot]), 1.4 * mod.SOLCAST_KWH_PER_MW_SLOT, places=6)
            self.assertAlmostEqual(float(snapshot["est_actual_kwh"][slot]), 0.9 * mod.SOLCAST_KWH_PER_MW_SLOT, places=6)
            self.assertEqual(str(snapshot["power_unit"]), "mw")
            self.assertEqual(str(snapshot["energy_unit"]), "kwh_per_slot")
        finally:
            logging.shutdown()
            shutil.rmtree(tmp_root, ignore_errors=True)

    def test_solcast_prior_scales_blend_by_resolution_profile(self):
        tmp_root = WORK_TMP / "solcast-resolution-profile"
        shutil.rmtree(tmp_root, ignore_errors=True)
        tmp_root.mkdir(parents=True, exist_ok=True)
        try:
            mod = load_module(tmp_root, "solcast-resolution-profile")
            day = "2026-03-20"
            w5 = pd.DataFrame({
                "rad": np.full(mod.SLOTS_DAY, 780.0),
                "cloud": np.full(mod.SLOTS_DAY, 14.0),
                "rh": np.full(mod.SLOTS_DAY, 60.0),
                "precip": np.zeros(mod.SLOTS_DAY),
                "cape": np.zeros(mod.SLOTS_DAY),
                "cloud_low": np.full(mod.SLOTS_DAY, 10.0),
                "cloud_mid": np.full(mod.SLOTS_DAY, 8.0),
                "cloud_high": np.full(mod.SLOTS_DAY, 6.0),
                "temp": np.full(mod.SLOTS_DAY, 28.0),
                "wind": np.full(mod.SLOTS_DAY, 3.0),
                "rad_direct": np.full(mod.SLOTS_DAY, 500.0),
                "rad_diffuse": np.full(mod.SLOTS_DAY, 140.0),
            })
            snapshot = {
                "forecast_kwh": np.where(
                    (np.arange(mod.SLOTS_DAY) >= mod.SOLAR_START_SLOT)
                    & (np.arange(mod.SLOTS_DAY) < mod.SOLAR_END_SLOT),
                    16.0,
                    0.0,
                ).astype(float),
                "forecast_lo_kwh": np.full(mod.SLOTS_DAY, 14.0, dtype=float),
                "forecast_hi_kwh": np.full(mod.SLOTS_DAY, 18.0, dtype=float),
                "forecast_mw": np.full(mod.SLOTS_DAY, 0.192, dtype=float),
                "spread_frac": np.full(mod.SLOTS_DAY, 0.08, dtype=float),
                "present": np.ones(mod.SLOTS_DAY, dtype=bool),
                "coverage_slots": int(mod.SOLAR_SLOTS),
                "coverage_ratio": 0.86,
                "source": "solcast",
            }
            base_artifact = {
                "regimes": {
                    "clear": {"bias_ratio": 1.0, "reliability": 0.90, "coverage_ratio": 0.85},
                },
                "resolution_profiles": {
                    "overall": {"solcast_weight": 0.5},
                    "pairs": {
                        "clear:clear_stable": {"solcast_weight": 1.0, "preferred_source": "solcast", "support_days": 8},
                    },
                },
            }
            weak_artifact = {
                "regimes": {
                    "clear": {"bias_ratio": 1.0, "reliability": 0.90, "coverage_ratio": 0.85},
                },
                "resolution_profiles": {
                    "overall": {"solcast_weight": 0.5},
                    "pairs": {
                        "clear:clear_stable": {"solcast_weight": 0.0, "preferred_source": "dayahead", "support_days": 8},
                    },
                },
            }

            orig_analyse = mod.analyse_weather_day
            orig_classify = mod.classify_day_regime
            orig_clear_sky = mod.clear_sky_radiation
            try:
                mod.analyse_weather_day = lambda day, w5, actual=None: {
                    "cloud_mean": 14.0,
                    "rad_peak": 780.0,
                    "rh_mean": 60.0,
                    "vol_index": 0.04,
                    "rainy": False,
                    "convective": False,
                    "sky_class": "clear",
                }
                mod.classify_day_regime = lambda stats: "clear"
                mod.clear_sky_radiation = lambda day, rh: np.full(mod.SLOTS_DAY, 900.0, dtype=float)
                strong_prior = mod.solcast_prior_from_snapshot(day, w5, snapshot, base_artifact)
                weak_prior = mod.solcast_prior_from_snapshot(day, w5, snapshot, weak_artifact)
            finally:
                mod.analyse_weather_day = orig_analyse
                mod.classify_day_regime = orig_classify
                mod.clear_sky_radiation = orig_clear_sky

            self.assertIsNotNone(strong_prior)
            self.assertIsNotNone(weak_prior)
            strong_blend = float(np.mean(np.asarray(strong_prior["blend"], dtype=float)[mod.SOLAR_START_SLOT:mod.SOLAR_END_SLOT]))
            weak_blend = float(np.mean(np.asarray(weak_prior["blend"], dtype=float)[mod.SOLAR_START_SLOT:mod.SOLAR_END_SLOT]))
            self.assertGreater(strong_blend, weak_blend)
            self.assertGreater(float(np.mean(np.asarray(strong_prior["resolution_weight"], dtype=float)[mod.SOLAR_START_SLOT:mod.SOLAR_END_SLOT])), 0.9)
            self.assertLess(float(np.mean(np.asarray(weak_prior["resolution_weight"], dtype=float)[mod.SOLAR_START_SLOT:mod.SOLAR_END_SLOT])), 0.1)
        finally:
            logging.shutdown()
            shutil.rmtree(tmp_root, ignore_errors=True)

    def test_run_dayahead_returns_error_class_meta_and_bias(self):
        tmp_root = WORK_TMP / "run-dayahead-error-class"
        shutil.rmtree(tmp_root, ignore_errors=True)
        tmp_root.mkdir(parents=True, exist_ok=True)
        try:
            mod = load_module(tmp_root, "run-dayahead-error-class")
            day = date(2026, 3, 20)
            day_s = day.isoformat()
            hourly = pd.DataFrame(
                {
                    "time": pd.date_range(f"{day_s} 00:00:00", periods=24, freq="1h"),
                    "rad": [0.0] * 6 + [100.0, 220.0, 420.0, 600.0, 760.0, 820.0, 780.0, 640.0, 500.0, 320.0, 180.0, 90.0] + [0.0] * 6,
                    "rad_direct": [0.0] * 24,
                    "rad_diffuse": [0.0] * 24,
                    "cloud": [18.0] * 24,
                    "cloud_low": [10.0] * 24,
                    "cloud_mid": [8.0] * 24,
                    "cloud_high": [6.0] * 24,
                    "temp": [28.0] * 24,
                    "rh": [60.0] * 24,
                    "wind": [3.0] * 24,
                    "precip": [0.0] * 24,
                    "cape": [50.0] * 24,
                }
            )
            solar_forecast = np.zeros(mod.SLOTS_DAY, dtype=float)
            solar_forecast[mod.SOLAR_START_SLOT:mod.SOLAR_END_SLOT] = 20.0

            bundle = {
                "feature_cols": list(mod.FEATURE_COLS),
                "global": {
                    "model": ZeroRegressor(),
                    "scaler": IdentityScaler(len(mod.FEATURE_COLS)),
                    "meta": {"feature_names": list(mod.FEATURE_COLS), "sample_count": 10, "estimators_used": 1},
                },
                "regimes": {},
                "error_classifier": {
                    "class_names": list(mod.ERROR_CLASS_NAMES),
                    "global": {
                        "model": FixedClassifier([0.04, 0.08, 0.16, 0.27, 0.45]),
                        "scaler": IdentityScaler(len(mod.FEATURE_COLS)),
                        "meta": {
                            "feature_names": list(mod.FEATURE_COLS),
                            "centroids_kwh": {"0": -160.0, "1": -70.0, "2": 0.0, "3": 90.0, "4": 220.0},
                        },
                    },
                    "regimes": {},
                    "weather_profiles": {"pairs": {"clear:clear_stable": {"count": 12, "mean": 40.0, "std": 10.0, "mae": 45.0}}},
                },
            }

            orig_fetch_weather = mod.fetch_weather
            orig_load_weather_bias = mod.load_weather_bias_artifact
            orig_apply_bias = mod.apply_weather_bias_adjustment
            orig_validate_w5 = mod.validate_weather_5min
            orig_analyse = mod.analyse_weather_day
            orig_classify = mod.classify_day_regime
            orig_physics = mod.physics_baseline
            orig_load_solcast_snapshot = mod.load_solcast_snapshot
            orig_solcast_prior_from_snapshot = mod.solcast_prior_from_snapshot
            orig_load_solcast_rel = mod.load_solcast_reliability_artifact
            orig_blend_solcast = mod.blend_physics_with_solcast
            orig_load_artifacts = mod.load_forecast_artifacts
            orig_load_model = mod.load_model_bundle
            orig_error_memory = mod.compute_error_memory
            orig_activity = mod.apply_activity_hysteresis
            orig_staging = mod.apply_block_staging
            orig_ramp = mod.apply_ramp_limit
            try:
                mod.fetch_weather = lambda day, source="auto": hourly.copy()
                mod.load_weather_bias_artifact = lambda today, allow_build=True: {}
                mod.apply_weather_bias_adjustment = lambda raw_hourly, day, weather_bias: (raw_hourly, {"regime_confidence": 0.9, "matches": 5, "day_regime": "clear", "mean_rad_factor": 1.0, "morning_shift_slots": 0.0})
                mod.validate_weather_5min = lambda day, w5: (True, "")
                mod.analyse_weather_day = lambda day, w5, actual=None: {
                    "sky_class": "clear",
                    "cloud_mean": 15.0,
                    "rad_peak": 820.0,
                    "rh_mean": 60.0,
                    "convective": False,
                    "rainy": False,
                    "vol_index": 0.05,
                }
                mod.classify_day_regime = lambda stats: "clear"
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
                        "regime": "clear",
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
                    {"used_solcast": True, "coverage_ratio": 1.0, "mean_blend": 1.0, "reliability": 0.8, "bias_ratio": 1.0, "raw_prior_ratio": 1.0, "applied_prior_ratio": 1.0, "regime": "clear", "source": "test"},
                )
                mod.load_forecast_artifacts = lambda today, allow_build=True: {}
                mod.load_model_bundle = lambda: bundle
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

                result = mod.run_dayahead(day, day, persist=False)
            finally:
                mod.fetch_weather = orig_fetch_weather
                mod.load_weather_bias_artifact = orig_load_weather_bias
                mod.apply_weather_bias_adjustment = orig_apply_bias
                mod.validate_weather_5min = orig_validate_w5
                mod.analyse_weather_day = orig_analyse
                mod.classify_day_regime = orig_classify
                mod.physics_baseline = orig_physics
                mod.load_solcast_snapshot = orig_load_solcast_snapshot
                mod.solcast_prior_from_snapshot = orig_solcast_prior_from_snapshot
                mod.load_solcast_reliability_artifact = orig_load_solcast_rel
                mod.blend_physics_with_solcast = orig_blend_solcast
                mod.load_forecast_artifacts = orig_load_artifacts
                mod.load_model_bundle = orig_load_model
                mod.compute_error_memory = orig_error_memory
                mod.apply_activity_hysteresis = orig_activity
                mod.apply_block_staging = orig_staging
                mod.apply_ramp_limit = orig_ramp

            self.assertIsInstance(result, dict)
            self.assertTrue(bool(result["error_class_meta"]["available"]))
            self.assertGreater(float(result["error_class_total_kwh"]), 0.0)
            self.assertEqual(len(result["error_class_meta"]["slot_weather_buckets"]), mod.SLOTS_DAY)
            self.assertTrue(result["error_class_meta"]["weather_bucket_forecast_summary"])
            self.assertIn("mean_profile_reliability", result["error_class_meta"])
            self.assertIn("class_support_weights", result["error_class_meta"])
            # PHASE 4: Updated assertion for new return format
            self.assertGreater(float(result["forecast_total_kwh"]), float(result["baseline_total_kwh"]))
        finally:
            logging.shutdown()
            shutil.rmtree(tmp_root, ignore_errors=True)

    def test_run_dayahead_physics_fallback_when_no_solcast(self):
        """Solcast-outage resilience: with NO Solcast snapshot, run_dayahead(persist=False)
        must NOT crash and must return a physics-fallback payload (baseline_is_solcast_mid
        False, used_solcast False, variant ml_without_solcast). This is the exact path that
        previously AttributeError'd on solcast_snapshot.get() in the non-persist return dict."""
        tmp_root = WORK_TMP / "run-dayahead-physics-fallback"
        shutil.rmtree(tmp_root, ignore_errors=True)
        tmp_root.mkdir(parents=True, exist_ok=True)
        try:
            mod = load_module(tmp_root, "run-dayahead-physics-fallback")
            day = date(2026, 3, 21)
            day_s = day.isoformat()
            hourly = pd.DataFrame(
                {
                    "time": pd.date_range(f"{day_s} 00:00:00", periods=24, freq="1h"),
                    "rad": [0.0] * 6 + [100.0, 220.0, 420.0, 600.0, 760.0, 820.0, 780.0, 640.0, 500.0, 320.0, 180.0, 90.0] + [0.0] * 6,
                    "rad_direct": [0.0] * 24,
                    "rad_diffuse": [0.0] * 24,
                    "cloud": [18.0] * 24,
                    "cloud_low": [10.0] * 24,
                    "cloud_mid": [8.0] * 24,
                    "cloud_high": [6.0] * 24,
                    "temp": [28.0] * 24,
                    "rh": [60.0] * 24,
                    "wind": [3.0] * 24,
                    "precip": [0.0] * 24,
                    "cape": [50.0] * 24,
                }
            )
            solar_forecast = np.zeros(mod.SLOTS_DAY, dtype=float)
            solar_forecast[mod.SOLAR_START_SLOT:mod.SOLAR_END_SLOT] = 20.0

            orig = {
                "fetch_weather": mod.fetch_weather,
                "load_weather_bias_artifact": mod.load_weather_bias_artifact,
                "apply_weather_bias_adjustment": mod.apply_weather_bias_adjustment,
                "validate_weather_5min": mod.validate_weather_5min,
                "analyse_weather_day": mod.analyse_weather_day,
                "classify_day_regime": mod.classify_day_regime,
                "physics_baseline": mod.physics_baseline,
                "load_solcast_snapshot": mod.load_solcast_snapshot,
                "load_solcast_reliability_artifact": mod.load_solcast_reliability_artifact,
                "load_forecast_artifacts": mod.load_forecast_artifacts,
                "load_model_bundle": mod.load_model_bundle,
                "compute_error_memory": mod.compute_error_memory,
                "apply_activity_hysteresis": mod.apply_activity_hysteresis,
                "apply_block_staging": mod.apply_block_staging,
                "apply_ramp_limit": mod.apply_ramp_limit,
                "_setting_bool_or_default": mod._setting_bool_or_default,
            }
            try:
                mod.fetch_weather = lambda day, source="auto": hourly.copy()
                mod.load_weather_bias_artifact = lambda today, allow_build=True: {}
                mod.apply_weather_bias_adjustment = lambda raw_hourly, day, weather_bias: (raw_hourly, {"regime_confidence": 0.9, "matches": 5, "day_regime": "clear", "mean_rad_factor": 1.0, "morning_shift_slots": 0.0})
                mod.validate_weather_5min = lambda day, w5: (True, "")
                mod.analyse_weather_day = lambda day, w5, actual=None: {
                    "sky_class": "clear", "cloud_mean": 15.0, "rad_peak": 820.0,
                    "rh_mean": 60.0, "convective": False, "rainy": False, "vol_index": 0.05,
                }
                mod.classify_day_regime = lambda stats: "clear"
                mod.physics_baseline = lambda day, w5: solar_forecast.copy()
                # THE KEY: no Solcast snapshot at all → fallback path.
                mod.load_solcast_snapshot = lambda day: None
                mod.load_solcast_reliability_artifact = lambda today, allow_build=True: None
                mod.load_forecast_artifacts = lambda today, allow_build=True: {}
                mod.load_model_bundle = lambda: None  # no model → pure physics + error memory
                mod.compute_error_memory = lambda today, w5, **kw: np.zeros(mod.SLOTS_DAY, dtype=float)
                mod.apply_activity_hysteresis = lambda forecast, target_s, w5, artifacts, bias_meta=None: (
                    forecast.copy(),
                    {"first_slot": mod.SOLAR_START_SLOT, "last_slot": mod.SOLAR_END_SLOT - 1, "history_matches": 0, "bias_shift_slots": 0},
                )
                mod.apply_block_staging = lambda forecast, w5: (forecast.copy(), {"staged_slots": 0, "node_step_kwh": 0.0})
                mod.apply_ramp_limit = lambda arr, max_step=320.0: arr.copy()
                # fallback enabled (default) — be explicit so the test is independent of any DB
                mod._setting_bool_or_default = lambda key, default: True if key == "forecastAllowPhysicsFallback" else default

                # Must NOT raise (previously AttributeError on solcast_snapshot.get()).
                result = mod.run_dayahead(day, day, persist=False)

                self.assertIsInstance(result, dict)
                # Provenance must reflect the physics fallback, not Solcast.
                self.assertFalse(bool(result["solcast_meta"].get("used_solcast")))
                self.assertFalse(bool(result["baseline_is_solcast_mid"]))
                self.assertIsNone(result["solcast_lo_total_kwh"])
                self.assertIsNone(result["solcast_hi_total_kwh"])
                self.assertEqual(
                    mod._classify_variant_from_solcast_meta(result["solcast_meta"]),
                    "ml_without_solcast",
                )
                # A real forecast was produced from physics.
                self.assertGreater(float(result["forecast_total_kwh"]), 0.0)
            finally:
                for name, fn in orig.items():
                    setattr(mod, name, fn)
        finally:
            logging.shutdown()
            shutil.rmtree(tmp_root, ignore_errors=True)

    def test_run_dayahead_hard_fail_when_fallback_disabled(self):
        """When forecastAllowPhysicsFallback is OFF and no Solcast snapshot exists,
        run_dayahead(persist=False) returns None (legacy hard-fail), not a crash."""
        tmp_root = WORK_TMP / "run-dayahead-fallback-off"
        shutil.rmtree(tmp_root, ignore_errors=True)
        tmp_root.mkdir(parents=True, exist_ok=True)
        try:
            mod = load_module(tmp_root, "run-dayahead-fallback-off")
            day = date(2026, 3, 21)
            day_s = day.isoformat()
            hourly = pd.DataFrame(
                {
                    "time": pd.date_range(f"{day_s} 00:00:00", periods=24, freq="1h"),
                    "rad": [0.0] * 6 + [100.0, 220.0, 420.0, 600.0, 760.0, 820.0, 780.0, 640.0, 500.0, 320.0, 180.0, 90.0] + [0.0] * 6,
                    "rad_direct": [0.0] * 24, "rad_diffuse": [0.0] * 24,
                    "cloud": [18.0] * 24, "cloud_low": [10.0] * 24, "cloud_mid": [8.0] * 24, "cloud_high": [6.0] * 24,
                    "temp": [28.0] * 24, "rh": [60.0] * 24, "wind": [3.0] * 24, "precip": [0.0] * 24, "cape": [50.0] * 24,
                }
            )
            orig = {
                "fetch_weather": mod.fetch_weather,
                "load_weather_bias_artifact": mod.load_weather_bias_artifact,
                "apply_weather_bias_adjustment": mod.apply_weather_bias_adjustment,
                "validate_weather_5min": mod.validate_weather_5min,
                "analyse_weather_day": mod.analyse_weather_day,
                "classify_day_regime": mod.classify_day_regime,
                "load_solcast_snapshot": mod.load_solcast_snapshot,
                "_setting_bool_or_default": mod._setting_bool_or_default,
            }
            try:
                mod.fetch_weather = lambda day, source="auto": hourly.copy()
                mod.load_weather_bias_artifact = lambda today, allow_build=True: {}
                mod.apply_weather_bias_adjustment = lambda raw_hourly, day, weather_bias: (raw_hourly, {"regime_confidence": 0.9, "matches": 5, "day_regime": "clear", "mean_rad_factor": 1.0, "morning_shift_slots": 0.0})
                mod.validate_weather_5min = lambda day, w5: (True, "")
                mod.analyse_weather_day = lambda day, w5, actual=None: {
                    "sky_class": "clear", "cloud_mean": 15.0, "rad_peak": 820.0,
                    "rh_mean": 60.0, "convective": False, "rainy": False, "vol_index": 0.05,
                }
                mod.classify_day_regime = lambda stats: "clear"
                mod.load_solcast_snapshot = lambda day: None
                mod._setting_bool_or_default = lambda key, default: False if key == "forecastAllowPhysicsFallback" else default

                result = mod.run_dayahead(day, day, persist=False)
                self.assertIsNone(result)  # hard-fail returns None on non-persist path
            finally:
                for name, fn in orig.items():
                    setattr(mod, name, fn)
        finally:
            logging.shutdown()
            shutil.rmtree(tmp_root, ignore_errors=True)

    def test_forecast_qa_logs_bucket_and_classifier_summaries(self):
        tmp_root = WORK_TMP / "qa-weather-summary"
        shutil.rmtree(tmp_root, ignore_errors=True)
        tmp_root.mkdir(parents=True, exist_ok=True)
        try:
            mod = load_module(tmp_root, "qa-weather-summary")
            actual = np.zeros(mod.SLOTS_DAY, dtype=float)
            actual[mod.SOLAR_START_SLOT:mod.SOLAR_END_SLOT] = 100.0
            forecast = actual.copy()
            forecast[mod.SOLAR_START_SLOT + 12:mod.SOLAR_START_SLOT + 24] += 20.0
            present = np.zeros(mod.SLOTS_DAY, dtype=bool)
            present[mod.SOLAR_START_SLOT:mod.SOLAR_END_SLOT] = True
            slot_buckets = np.array(["offsolar"] * mod.SLOTS_DAY, dtype=object)
            slot_buckets[mod.SOLAR_START_SLOT:mod.SOLAR_START_SLOT + 30] = "clear_stable"
            slot_buckets[mod.SOLAR_START_SLOT + 30:mod.SOLAR_END_SLOT] = "mixed_volatile"
            predicted_labels = np.full(mod.SLOTS_DAY, mod.ERROR_CLASS_NEUTRAL_IDX, dtype=int)
            predicted_labels[mod.SOLAR_START_SLOT + 12:mod.SOLAR_START_SLOT + 24] = 4
            hybrid = actual.copy()

            orig_actual = mod.load_actual_loss_adjusted_with_presence
            orig_dayahead = mod.load_dayahead_with_presence
            orig_constraints = mod.build_operational_constraint_mask
            orig_snapshot = mod.load_forecast_weather_snapshot
            try:
                mod.load_actual_loss_adjusted_with_presence = lambda day: (actual.copy(), present.copy())
                mod.load_dayahead_with_presence = lambda day: (forecast.copy(), present.copy())
                mod.build_operational_constraint_mask = lambda day: (
                    np.zeros(mod.SLOTS_DAY, dtype=bool),
                    {"operational_mask": np.zeros(mod.SLOTS_DAY, dtype=bool)},
                )
                mod.load_forecast_weather_snapshot = lambda day: {
                    "meta": {
                        "error_class_debug": {
                            "slot_weather_buckets": [str(v) for v in slot_buckets],
                            "hybrid_baseline_kwh": [float(v) for v in hybrid],
                            "predicted_labels": [int(v) for v in predicted_labels],
                            "class_confidence": [0.85] * mod.SLOTS_DAY,
                        }
                    }
                }
                with self.assertLogs(mod.log.name, level="INFO") as captured:
                    mod.forecast_qa(date(2026, 3, 21))
            finally:
                mod.load_actual_loss_adjusted_with_presence = orig_actual
                mod.load_dayahead_with_presence = orig_dayahead
                mod.build_operational_constraint_mask = orig_constraints
                mod.load_forecast_weather_snapshot = orig_snapshot

            joined = "\n".join(captured.output)
            self.assertIn("QA weather buckets [2026-03-20]", joined)
            self.assertIn("clear_stable:WAPE=", joined)
            self.assertIn("QA classifier [2026-03-20]", joined)
        finally:
            logging.shutdown()
            shutil.rmtree(tmp_root, ignore_errors=True)

    def test_forecast_qa_stores_resolution_history(self):
        tmp_root = WORK_TMP / "qa-resolution-history"
        shutil.rmtree(tmp_root, ignore_errors=True)
        tmp_root.mkdir(parents=True, exist_ok=True)
        try:
            mod = load_module(tmp_root, "qa-resolution-history")
            actual = np.zeros(mod.SLOTS_DAY, dtype=float)
            actual[mod.SOLAR_START_SLOT:mod.SOLAR_END_SLOT] = 100.0
            forecast = actual.copy()
            forecast[mod.SOLAR_START_SLOT + 12:mod.SOLAR_START_SLOT + 24] += 15.0
            solcast = actual.copy()
            solcast[mod.SOLAR_START_SLOT + 24:mod.SOLAR_START_SLOT + 36] += 8.0
            present = np.zeros(mod.SLOTS_DAY, dtype=bool)
            present[mod.SOLAR_START_SLOT:mod.SOLAR_END_SLOT] = True
            slot_buckets = np.array(["offsolar"] * mod.SLOTS_DAY, dtype=object)
            slot_buckets[mod.SOLAR_START_SLOT:mod.SOLAR_START_SLOT + 30] = "clear_stable"
            slot_buckets[mod.SOLAR_START_SLOT + 30:mod.SOLAR_END_SLOT] = "mixed_volatile"
            stored = {}

            orig_actual = mod.load_actual_loss_adjusted_with_presence
            orig_dayahead = mod.load_dayahead_with_presence
            orig_constraints = mod.build_operational_constraint_mask
            orig_snapshot = mod.load_forecast_weather_snapshot
            orig_solcast_snapshot = mod.load_solcast_snapshot
            orig_update_meta = mod.update_forecast_weather_snapshot_meta
            try:
                mod.load_actual_loss_adjusted_with_presence = lambda day: (actual.copy(), present.copy())
                mod.load_dayahead_with_presence = lambda day: (forecast.copy(), present.copy())
                mod.build_operational_constraint_mask = lambda day: (
                    np.zeros(mod.SLOTS_DAY, dtype=bool),
                    {"operational_mask": np.zeros(mod.SLOTS_DAY, dtype=bool)},
                )
                mod.load_forecast_weather_snapshot = lambda day: {
                    "meta": {
                        "target_regime": "clear",
                        "error_class_debug": {
                            "slot_weather_buckets": [str(v) for v in slot_buckets],
                        },
                    },
                    "signature": {"day_regime": "clear"},
                    "applied_signature": {"day_regime": "clear"},
                }
                mod.load_solcast_snapshot = lambda day: {
                    "forecast_kwh": solcast.copy(),
                    "present": present.copy(),
                }
                mod.update_forecast_weather_snapshot_meta = lambda day, updates: stored.setdefault("payload", (day, updates)) is None or True

                mod.forecast_qa(date(2026, 3, 21))
            finally:
                mod.load_actual_loss_adjusted_with_presence = orig_actual
                mod.load_dayahead_with_presence = orig_dayahead
                mod.build_operational_constraint_mask = orig_constraints
                mod.load_forecast_weather_snapshot = orig_snapshot
                mod.load_solcast_snapshot = orig_solcast_snapshot
                mod.update_forecast_weather_snapshot_meta = orig_update_meta

            self.assertIn("payload", stored)
            saved_day, updates = stored["payload"]
            self.assertEqual(saved_day, "2026-03-20")
            self.assertIn("resolution_debug", updates)
            debug = updates["resolution_debug"]
            self.assertEqual(int(debug["resolution_minutes"]), mod.SLOT_MIN)
            self.assertEqual(str(debug["source_power_unit"]), "mw")
            self.assertEqual(str(debug["energy_unit"]), "kwh_per_slot")
            self.assertEqual(str(debug["actual_basis"]), "loss_adjusted_actual")
            self.assertIn("overall", debug)
            self.assertIn("buckets", debug)
        finally:
            logging.shutdown()
            shutil.rmtree(tmp_root, ignore_errors=True)

    def test_run_backtest_logs_bucket_and_regime_summaries(self):
        tmp_root = WORK_TMP / "backtest-weather-summary"
        shutil.rmtree(tmp_root, ignore_errors=True)
        tmp_root.mkdir(parents=True, exist_ok=True)
        try:
            mod = load_module(tmp_root, "backtest-weather-summary")
            actual = np.zeros(mod.SLOTS_DAY, dtype=float)
            actual[mod.SOLAR_START_SLOT:mod.SOLAR_END_SLOT] = 100.0
            present = np.zeros(mod.SLOTS_DAY, dtype=bool)
            present[mod.SOLAR_START_SLOT:mod.SOLAR_END_SLOT] = True
            forecast = actual.copy()
            forecast[mod.SOLAR_START_SLOT + 6:mod.SOLAR_START_SLOT + 18] += 10.0
            hybrid = actual.copy()
            slot_buckets = np.array(["offsolar"] * mod.SLOTS_DAY, dtype=object)
            slot_buckets[mod.SOLAR_START_SLOT:mod.SOLAR_START_SLOT + 40] = "clear_stable"
            slot_buckets[mod.SOLAR_START_SLOT + 40:mod.SOLAR_END_SLOT] = "mixed_stable"
            predicted_labels = np.full(mod.SLOTS_DAY, mod.ERROR_CLASS_NEUTRAL_IDX, dtype=int)
            predicted_labels[mod.SOLAR_START_SLOT + 6:mod.SOLAR_START_SLOT + 18] = 3

            orig_actual = mod.load_actual_loss_adjusted_with_presence
            orig_snapshot = mod.load_forecast_weather_snapshot
            orig_training = mod.build_training_state
            orig_run_dayahead = mod.run_dayahead
            orig_constraints = mod.build_operational_constraint_mask
            orig_clear_cache = mod.clear_forecast_data_cache
            try:
                mod.clear_forecast_data_cache = lambda: None
                mod.load_actual_loss_adjusted_with_presence = lambda day: (actual.copy(), present.copy())
                mod.load_forecast_weather_snapshot = lambda day: {"meta": {}}
                mod.build_training_state = lambda reference_day: {"ok": True}
                mod.run_dayahead = lambda target_date, reference_day, runtime_state=None, persist=False, require_saved_snapshot_for_past=True: {
                    "forecast": forecast.copy(),
                    "hybrid_baseline": hybrid.copy(),
                    "weather_source": "snapshot",
                    "target_regime": "clear",
                    "solcast_meta": {"used_solcast": True, "mean_blend": 0.84},
                    "error_class_meta": {
                        "slot_weather_buckets": slot_buckets.copy(),
                        "predicted_labels": predicted_labels.copy(),
                        "class_confidence": np.full(mod.SLOTS_DAY, 0.78, dtype=float),
                    },
                }
                mod.build_operational_constraint_mask = lambda day: (
                    np.zeros(mod.SLOTS_DAY, dtype=bool),
                    {"operational_mask": np.zeros(mod.SLOTS_DAY, dtype=bool)},
                )
                with self.assertLogs(mod.log.name, level="INFO") as captured:
                    ok = mod.run_backtest([date(2026, 3, 20)])
            finally:
                mod.clear_forecast_data_cache = orig_clear_cache
                mod.load_actual_loss_adjusted_with_presence = orig_actual
                mod.load_forecast_weather_snapshot = orig_snapshot
                mod.build_training_state = orig_training
                mod.run_dayahead = orig_run_dayahead
                mod.build_operational_constraint_mask = orig_constraints

            self.assertTrue(ok)
            joined = "\n".join(captured.output)
            self.assertIn("Backtest buckets [2026-03-20]", joined)
            self.assertIn("clear_stable:WAPE=", joined)
            self.assertIn("Backtest regimes: clear:WAPE=", joined)
        finally:
            logging.shutdown()
            shutil.rmtree(tmp_root, ignore_errors=True)

if __name__ == "__main__":
    unittest.main()
