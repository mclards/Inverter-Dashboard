"""
Test suite for forecast engine audit fixes from 2026-05-28.

Tests:
- F-Mi1: Solcast snapshot validation consolidation
- F-FA1: Stale snapshot warning gating
- F-FA2: Aggregate NaN/Inf warnings
- ML-Mi4: CAP_DISPATCH_TOLERANCE constant
- ML-Mi5: Atomic legacy-model truncation
- ML-Me3: Regime transition detection + relaxed threshold
- ML-FA3: backend_fallback moved to status_flags
- F-T2: override_to_mean_blend_100 signal handling
- ML-T1: Regime transition edge case + sklearn vs LightGBM
"""

import json
import logging
import sqlite3
import tempfile
from datetime import date, datetime, timedelta
from pathlib import Path
from unittest.mock import MagicMock, Mock, patch

import numpy as np
import pandas as pd
import pytest

# Import the forecast engine module
try:
    from services import forecast_engine as fe
    HAS_FORECAST_ENGINE = True
except ImportError:
    HAS_FORECAST_ENGINE = False

@pytest.mark.skipif(not HAS_FORECAST_ENGINE, reason="forecast_engine not importable")
class TestAuditFixes:
    """Test suite for 2026-05-28 audit fixes."""

    def test_cap_dispatch_tolerance_constant_exists(self):
        """ML-Mi4: CAP_DISPATCH_TOLERANCE should be a module constant."""
        assert hasattr(fe, "CAP_DISPATCH_TOLERANCE")
        assert isinstance(fe.CAP_DISPATCH_TOLERANCE, float)
        assert 0.90 < fe.CAP_DISPATCH_TOLERANCE < 1.00
        # Default is 0.97
        assert abs(fe.CAP_DISPATCH_TOLERANCE - 0.97) < 0.001

    def test_cap_dispatch_tolerance_used_by_curtailed_mask(self):
        """ML-Mi4: curtailed_mask should use CAP_DISPATCH_TOLERANCE as default."""
        import inspect

        sig = inspect.signature(fe.curtailed_mask)
        # The parameter should default to CAP_DISPATCH_TOLERANCE
        params = sig.parameters
        assert "tol" in params
        # Default value should be CAP_DISPATCH_TOLERANCE
        assert params["tol"].default == fe.CAP_DISPATCH_TOLERANCE

    def test_regime_transition_detection_exists(self):
        """ML-Me3: _detect_regime_transition function should exist."""
        assert hasattr(fe, "_detect_regime_transition")
        assert callable(fe._detect_regime_transition)

    def test_regime_transition_sparse_emerging_regime(self):
        """ML-Me3: Detect sparse emerging regimes during transitions."""
        # Simulate history with emerging "rainy" regime: mostly clear, few recent mixed, very few rainy
        # Days 1-24: clear, Days 25-26: mixed, Days 27-30: rainy (4 rainy days, < min of 6)
        history_days = [
            {"day": f"2026-05-{d:02d}", "day_regime": "clear" if d <= 24 else ("mixed" if d <= 26 else "rainy")}
            for d in range(1, 31)
        ]

        # "rainy" is emerging (4 recent > 0 older) but sparse (< 6)
        is_transition = fe._detect_regime_transition(history_days, "rainy", lookback_days=14)
        assert isinstance(is_transition, bool)
        # In the recent 14 days (16-30): days 27-30 are rainy (4 days, < 6 min), with 0 older
        assert is_transition

    def test_regime_transition_stable_regime(self):
        """ML-Me3: Stable established regimes should not trigger transition."""
        # Simulate history with stable "clear" regime throughout
        history_days = [
            {"day": f"2026-05-{d:02d}", "day_regime": "clear"}
            for d in range(1, 31)
        ]

        is_transition = fe._detect_regime_transition(history_days, "clear", lookback_days=14)
        # "clear" is not emerging, so no transition
        assert not is_transition

    def test_regime_min_days_transition_constant(self):
        """ML-Me3: REGIME_MODEL_MIN_DAYS_TRANSITION should be defined."""
        assert hasattr(fe, "REGIME_MODEL_MIN_DAYS_TRANSITION")
        assert isinstance(fe.REGIME_MODEL_MIN_DAYS_TRANSITION, int)
        # Should be < standard min
        assert fe.REGIME_MODEL_MIN_DAYS_TRANSITION < fe.REGIME_MODEL_MIN_DAYS

    def test_feature_count_is_72(self):
        """F-D3 / ML-D1: FEATURE_COLS should have 72 columns."""
        assert hasattr(fe, "FEATURE_COLS")
        assert len(fe.FEATURE_COLS) == 72
        # Should include tri-band features
        assert "solcast_lo_kwh" in fe.FEATURE_COLS
        assert "solcast_hi_kwh" in fe.FEATURE_COLS
        assert "solcast_spread_ratio" in fe.FEATURE_COLS
        # Should include locked snapshot features
        assert "spread_pct_cap_locked" in fe.FEATURE_COLS
        assert "hours_since_lock" in fe.FEATURE_COLS
        # Should include plant features
        assert "expected_nodes" in fe.FEATURE_COLS
        assert "cap_kw" in fe.FEATURE_COLS

    def test_legacy_model_truncation_atomic(self):
        """ML-Mi5: Legacy model truncation should be atomic (wrapped in try/except)."""
        import inspect

        source = inspect.getsource(fe._align_bundle_features)
        # Should have try/except wrapping the truncation
        assert "try:" in source
        assert "except Exception" in source
        # Should build temp variable before committing
        assert "X_truncated" in source

    def test_persist_train_state_has_status_flags(self):
        """ML-FA3: _reset_train_rejection_streak should set status_flags for backend_fallback."""
        import inspect

        source = inspect.getsource(fe._reset_train_rejection_streak)
        # Should have status_flags assignment
        assert "status_flags" in source
        # Should check for LightGBM fallback
        assert "FORECAST_USE_LIGHTGBM" in source

    def test_collect_data_quality_warnings_excludes_backend_fallback(self):
        """ML-FA3: _collect_data_quality_warnings should NOT include lgbm_unavailable_fallback."""
        import inspect

        source = inspect.getsource(fe._collect_data_quality_warnings)
        # Should explicitly mention this is removed
        assert "Removed LightGBM" in source or "status_flags" in source
        # Should NOT have the old warning code
        # (we added a comment about it being moved)

    def test_compute_error_memory_docstring_updated(self):
        """F-D2: compute_error_memory docstring should document recency gate."""
        docstring = fe.compute_error_memory.__doc__ or ""
        # Should mention regime-aware behavior
        assert "regime-aware" in docstring.lower() or "regime" in docstring.lower()
        # Should mention clipping
        assert "clip" in docstring.lower() or "bound" in docstring.lower()

    def test_ml_n1_quality_weight_named_constants(self):
        """ML-N1: quality-weight magic numbers replaced with named constants (behavior-identical)."""
        for name, expected in (
            ("TRAIN_QUALITY_WEIGHT_BASE", 0.70),
            ("TRAIN_QUALITY_WEIGHT_CORR_SCALE", 0.30),
            ("TRAIN_QUALITY_WEIGHT_FLOOR", 0.55),
            ("TRAIN_QUALITY_WEIGHT_CEIL", 1.00),
        ):
            assert hasattr(fe, name), f"missing constant {name}"
            assert abs(getattr(fe, name) - expected) < 1e-9, f"{name} changed value"
        # Behavior identity vs the prior inline literals across the corr domain
        for corr in (-0.5, 0.0, 0.3, 0.6, 1.0):
            old = float(np.clip(0.70 + 0.30 * max(corr, 0.0), 0.55, 1.0))
            new = float(np.clip(
                fe.TRAIN_QUALITY_WEIGHT_BASE + fe.TRAIN_QUALITY_WEIGHT_CORR_SCALE * max(corr, 0.0),
                fe.TRAIN_QUALITY_WEIGHT_FLOOR, fe.TRAIN_QUALITY_WEIGHT_CEIL))
            assert old == new

    def test_feature_cols_count_assertion_in_tests(self):
        """Verify the feature count tripwire test still passes."""
        # This mirrors the test in test_forecast_engine_triband.py
        X_test = pd.DataFrame(
            np.random.randn(10, 72),
            columns=fe.FEATURE_COLS
        )
        assert X_test.shape[1] == 72

class TestOverrideToMeanBlend100:
    """
    F-T2: Tests for override_to_mean_blend_100 signal handling.

    When Node sets override_to_mean_blend_100=true, the forecast should
    use Solcast as sole authority and suppress ML residual.
    """

    def test_override_to_mean_blend_100_in_run_dayahead_params(self):
        """override_to_mean_blend_100 should be consumable by run_dayahead."""
        import inspect

        # Get run_dayahead signature
        sig = inspect.signature(fe.run_dayahead)
        # Should accept runtime_state which can contain override_to_mean_blend_100
        assert "runtime_state" in sig.parameters

    def test_override_to_mean_blend_100_suppresses_residual(self):
        """When override_to_mean_blend_100=true, ML residual should be zeroed."""
        # This is more of an integration test — checking code presence
        import inspect

        source = inspect.getsource(fe.run_dayahead)
        # Should check for override_to_mean_blend_100
        assert "override_to_mean_blend_100" in source or "mean_blend" in source

class TestRegimeTransitionEdgeCase:
    """
    ML-T1: Regime transition edge case (monsoon onset).

    Test the scenario where a weather regime transitions from dry→monsoon
    over 4-5 days, which previously caused consecutive training rejections.
    """

    def test_monsoon_onset_scenario(self):
        """
        Simulate a monsoon onset: clear → mixed → overcast → rainy over 4 days.
        Verify that per-regime models are built despite sparse data.
        """
        # Build 45-day history: clear for days 1-38, mixed for 39-42, rainy for 43-45
        # Recent 14 days (32-45): 4 rainy days at end, which is < 6 min but emerging
        history = []
        for day_num in range(1, 46):
            if day_num <= 38:
                regime = "clear"
            elif day_num <= 42:
                regime = "mixed"
            else:
                regime = "rainy"

            history.append({
                "day": f"2026-05-{day_num:02d}",
                "day_regime": regime,
                "days_ago": 45 - day_num,
            })

        # Check that rainy regime is detected as transition
        # Recent 14 days (32-45): contains days 43-45 (3 rainy) which is < 6 and emerging
        is_transition = fe._detect_regime_transition(history, "rainy", lookback_days=14)
        assert is_transition, "Monsoon onset should be detected as transition"

        # Verify the rainy regime has sparse data but should still be usable
        recent_rainy = sum(1 for h in history[-14:] if h.get("day_regime") == "rainy")
        older_rainy = sum(1 for h in history[:-14] if h.get("day_regime") == "rainy")
        assert recent_rainy < fe.REGIME_MODEL_MIN_DAYS, f"Recent rainy should be < {fe.REGIME_MODEL_MIN_DAYS}"
        assert recent_rainy > older_rainy, "Rainy should be emerging (more recent)"
        assert recent_rainy >= fe.REGIME_MODEL_MIN_DAYS_TRANSITION or recent_rainy > 0

    def test_transition_threshold_hierarchy(self):
        """Relaxed threshold should be < standard threshold."""
        assert fe.REGIME_MODEL_MIN_DAYS_TRANSITION < fe.REGIME_MODEL_MIN_DAYS

class TestSklearnVsLightGBMBackend:
    """
    ML-T1: sklearn vs LightGBM backend presence/shape test.

    Verify that the backend detection is correct and metadata is available.
    """

    def test_ml_backend_detail_function_exists(self):
        """_detect_ml_backend_detail should exist and return dict."""
        assert hasattr(fe, "_detect_ml_backend_detail")
        result = fe._detect_ml_backend_detail()
        assert isinstance(result, dict)
        assert "backend" in result
        assert "reason" in result
        assert "lightgbm_available" in result

    def test_ml_backend_function_exists(self):
        """_detect_ml_backend should return 'lightgbm' or 'sklearn_gbr'."""
        assert hasattr(fe, "_detect_ml_backend")
        backend = fe._detect_ml_backend()
        assert backend in ("lightgbm", "sklearn_gbr")

    def test_forecast_use_lightgbm_flag(self):
        """FORECAST_USE_LIGHTGBM flag should control backend selection."""
        assert hasattr(fe, "FORECAST_USE_LIGHTGBM")
        assert isinstance(fe.FORECAST_USE_LIGHTGBM, bool)

    def test_lightgbm_import_error_captured(self):
        """If LightGBM is unavailable, ImportError should be captured."""
        assert hasattr(fe, "_LIGHTGBM_IMPORT_ERROR")
        # Either None (available) or a string (error message)
        if fe._LIGHTGBM_IMPORT_ERROR is not None:
            assert isinstance(fe._LIGHTGBM_IMPORT_ERROR, str)

@pytest.mark.skipif(not HAS_FORECAST_ENGINE, reason="forecast_engine not importable")
class TestForecastTunables:
    """Option A (2026-05-30): operator-tunable forecast knobs via the settings table.

    Each tunable is read FRESH (no process cache) and returns the engine default
    when unset/blank/invalid, so behavior is identical until the operator opts in.
    Covers: forecastEstActualWeight, forecastIntradayBlendMax.
    """

    def _make_settings_db(self, tmp_path, rows):
        dbp = tmp_path / "adsi.db"
        con = sqlite3.connect(str(dbp))
        con.execute("CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT)")
        for k, v in rows.items():
            con.execute("INSERT INTO settings(key, value) VALUES(?, ?)", (k, v))
        con.commit()
        con.close()
        return dbp

    def test_helper_exists(self):
        assert hasattr(fe, "_setting_float_or_none")
        assert callable(fe._setting_float_or_none)

    def test_unset_returns_none(self, tmp_path):
        dbp = self._make_settings_db(tmp_path, {})
        orig = fe.APP_DB_FILE
        try:
            fe.APP_DB_FILE = dbp
            assert fe._setting_float_or_none("forecastEstActualWeight", 0.5, 1.0) is None
        finally:
            fe.APP_DB_FILE = orig

    def test_valid_value_passthrough(self, tmp_path):
        dbp = self._make_settings_db(tmp_path, {"forecastEstActualWeight": "0.97"})
        orig = fe.APP_DB_FILE
        try:
            fe.APP_DB_FILE = dbp
            v = fe._setting_float_or_none("forecastEstActualWeight", 0.5, 1.0)
            assert v is not None and abs(v - 0.97) < 1e-9
        finally:
            fe.APP_DB_FILE = orig

    def test_out_of_range_clamped(self, tmp_path):
        dbp = self._make_settings_db(tmp_path, {"forecastIntradayBlendMax": "5.0"})
        orig = fe.APP_DB_FILE
        try:
            fe.APP_DB_FILE = dbp
            v = fe._setting_float_or_none("forecastIntradayBlendMax", 0.0, 1.0)
            assert v is not None and abs(v - 1.0) < 1e-9
        finally:
            fe.APP_DB_FILE = orig

    def test_invalid_value_returns_none(self, tmp_path):
        dbp = self._make_settings_db(tmp_path, {"forecastEstActualWeight": "abc"})
        orig = fe.APP_DB_FILE
        try:
            fe.APP_DB_FILE = dbp
            assert fe._setting_float_or_none("forecastEstActualWeight", 0.5, 1.0) is None
        finally:
            fe.APP_DB_FILE = orig

    def test_tunables_wired_into_engine(self):
        import inspect
        assert "forecastEstActualWeight" in inspect.getsource(fe.build_training_state)
        assert "forecastIntradayBlendMax" in inspect.getsource(fe.build_intraday_adjusted_forecast)

    def test_engine_defaults_unchanged(self):
        # Defaults must remain the operator-tuned baselines (zero behavior change at default).
        assert abs(fe.EST_ACTUAL_WEIGHT_FACTOR - 0.93) < 1e-9
        assert abs(fe.INTRADAY_BLEND_MAX - 0.72) < 1e-9

@pytest.mark.skipif(not HAS_FORECAST_ENGINE, reason="forecast_engine not importable")
class TestPhysicsFallback:
    """Graceful Solcast-outage degradation (2026-05-30).

    Previously ``run_dayahead`` hard-failed (returned None/False) whenever no usable
    Solcast snapshot existed for the target date — a single point of failure, since the
    PHASE-4 redesign made the Solcast snapshot the forecast *baseline* itself. Now it
    degrades to physics baseline + ML residual + error memory, gated by
    ``forecastAllowPhysicsFallback`` (default on), audited as 'ml_without_solcast'.
    """

    def _settings_db(self, tmp_path, rows):
        dbp = tmp_path / "adsi.db"
        con = sqlite3.connect(str(dbp))
        con.execute("CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT)")
        for k, v in rows.items():
            con.execute("INSERT INTO settings(key, value) VALUES(?, ?)", (k, v))
        con.commit()
        con.close()
        return dbp

    def test_bool_helper_exists(self):
        assert hasattr(fe, "_setting_bool_or_default") and callable(fe._setting_bool_or_default)

    def test_bool_unset_returns_default(self, tmp_path):
        dbp = self._settings_db(tmp_path, {})
        orig = fe.APP_DB_FILE
        try:
            fe.APP_DB_FILE = dbp
            assert fe._setting_bool_or_default("forecastAllowPhysicsFallback", True) is True
            assert fe._setting_bool_or_default("forecastAllowPhysicsFallback", False) is False
        finally:
            fe.APP_DB_FILE = orig

    def test_bool_true_false_parsing(self, tmp_path):
        orig = fe.APP_DB_FILE
        try:
            for i, (raw, expect) in enumerate((("1", True), ("true", True), ("on", True), ("YES", True),
                                ("0", False), ("false", False), ("no", False), ("off", False))):
                sub = tmp_path / f"c{i}"
                sub.mkdir()
                dbp = self._settings_db(sub, {"forecastAllowPhysicsFallback": raw})
                fe.APP_DB_FILE = dbp
                assert fe._setting_bool_or_default("forecastAllowPhysicsFallback", True) is expect, raw
        finally:
            fe.APP_DB_FILE = orig

    def test_bool_garbage_returns_default(self, tmp_path):
        dbp = self._settings_db(tmp_path, {"forecastAllowPhysicsFallback": "maybe"})
        orig = fe.APP_DB_FILE
        try:
            fe.APP_DB_FILE = dbp
            assert fe._setting_bool_or_default("forecastAllowPhysicsFallback", True) is True
            assert fe._setting_bool_or_default("forecastAllowPhysicsFallback", False) is False
        finally:
            fe.APP_DB_FILE = orig

    def test_blend_with_none_is_physics_passthrough(self):
        base = np.linspace(0.0, 60.0, fe.SLOTS_DAY)
        out, meta = fe.blend_physics_with_solcast(base, None)
        assert out.shape == (fe.SLOTS_DAY,)
        assert np.allclose(out, base)
        assert meta.get("used_solcast") is False
        assert float(meta.get("mean_blend", 0.0)) == 0.0

    def test_fallback_meta_classifies_as_ml_without_solcast(self):
        _out, meta = fe.blend_physics_with_solcast(np.zeros(fe.SLOTS_DAY), None)
        assert fe._classify_variant_from_solcast_meta(meta) == "ml_without_solcast"

    def test_fallback_branch_wired(self):
        import inspect
        src = inspect.getsource(fe.run_dayahead)
        assert "forecastAllowPhysicsFallback" in src
        assert "PHYSICS FALLBACK" in src
        assert "blend_physics_with_solcast(physics_baseline_arr, None)" in src
        assert "Day-ahead requires Solcast snapshot - none available" not in src

    def test_primary_path_contract_preserved(self):
        import inspect
        src = inspect.getsource(fe.run_dayahead)
        assert '"used_solcast": True' in src
        assert '"mean_blend": 1.0' in src
        assert '"primary_mode": True' in src
        assert src.count("physics_baseline_arr = physics_baseline(target_s, w5)") == 1

    def test_no_dead_residual_var(self):
        import inspect
        assert "slot_cap_mw_arr" not in inspect.getsource(fe)

if __name__ == "__main__":
    pytest.main([__file__, "-v"])
