"""
Test cases for Solcast tri-band LightGBM features.

Tests:
- Tri-band snapshot loading and exposure
- Feature construction with tri-band data
- Fallback when tri-band data is missing
- Training data handling of mixed tri-band/single-value rows
"""

import numpy as np
import pandas as pd
import pytest
import time
from datetime import date, datetime

from services.forecast_engine import (
    build_features,
    load_solcast_snapshot,
    solcast_prior_from_snapshot,
    collect_training_data_hardened,
    FEATURE_COLS,
    SLOTS_DAY,
    SOLAR_START_SLOT,
    SOLAR_END_SLOT,
)

class TestTriBandSnapshotLoading:
    """Test load_solcast_snapshot() tri-band exposure."""

    def test_snapshot_with_triband_values(self):
        """Verify tri-band columns loaded from database."""
        # This test requires a test database with tri-band data
        # Placeholder for integration test
        pass

    def test_snapshot_with_missing_triband(self):
        """Verify fallback when lo/hi are NULL."""
        # This test requires a test database with NULL lo/hi
        # Placeholder for integration test
        pass

class TestTriBandFeatureConstruction:
    """Test build_features() tri-band feature construction."""

    def _make_test_snapshot(self):
        """Create a synthetic tri-band snapshot for testing."""
        return {
            "day": "2026-03-30",
            "present": np.ones(SLOTS_DAY, dtype=bool),
            "forecast_kwh": np.full(SLOTS_DAY, 10.0),
            "forecast_lo_kwh": np.full(SLOTS_DAY, 8.0),  # 20% spread
            "forecast_hi_kwh": np.full(SLOTS_DAY, 12.0),
            "est_actual_kwh": np.full(SLOTS_DAY, 10.0),
            "forecast_mw": np.full(SLOTS_DAY, 1.2),
            "forecast_lo_mw": np.full(SLOTS_DAY, 0.96),
            "forecast_hi_mw": np.full(SLOTS_DAY, 1.44),
            "est_actual_mw": np.full(SLOTS_DAY, 1.2),
            "spread_frac": np.full(SLOTS_DAY, 0.20),
            "coverage_ratio": 1.0,
            "coverage_slots": SOLAR_END_SLOT - SOLAR_START_SLOT,
            "pulled_ts": int(time.time() * 1000),
            "source": "solcast",
        }

    def _make_test_weather(self):
        """Create minimal test weather DataFrame."""
        return pd.DataFrame({
            "time": pd.date_range("2026-03-30", periods=SLOTS_DAY, freq="5min"),
            "rad": np.random.uniform(0, 800, SLOTS_DAY),
            "cloud": np.random.uniform(0, 100, SLOTS_DAY),
            "temp": np.random.uniform(20, 35, SLOTS_DAY),
            "rh": np.random.uniform(40, 90, SLOTS_DAY),
        })

    def test_solcast_prior_from_snapshot_exposes_triband(self):
        """Verify prior_lo_kwh and prior_hi_kwh exposed."""
        snapshot = self._make_test_snapshot()
        w5 = self._make_test_weather()

        prior = solcast_prior_from_snapshot("2026-03-30", w5, snapshot, None)

        assert prior is not None
        assert "prior_lo_kwh" in prior
        assert "prior_hi_kwh" in prior
        assert "has_triband" in prior
        assert prior["has_triband"] == True
        # Verify values after bias correction
        assert np.allclose(prior["prior_lo_kwh"][SOLAR_START_SLOT:SOLAR_END_SLOT], 8.0, atol=1.0)
        assert np.allclose(prior["prior_hi_kwh"][SOLAR_START_SLOT:SOLAR_END_SLOT], 12.0, atol=1.0)

    def test_build_features_with_triband(self):
        """Verify tri-band features constructed correctly."""
        snapshot = self._make_test_snapshot()
        w5 = self._make_test_weather()

        prior = solcast_prior_from_snapshot("2026-03-30", w5, snapshot, None)
        features = build_features(w5, "2026-03-30", prior)

        # Check new columns exist
        assert "solcast_lo_kwh" in features.columns
        assert "solcast_hi_kwh" in features.columns
        assert "solcast_lo_vs_physics" in features.columns
        assert "solcast_hi_vs_physics" in features.columns
        assert "solcast_spread_pct" in features.columns
        assert "solcast_spread_ratio" in features.columns

        # Check correct shape
        assert len(features) == SLOTS_DAY
        assert features.shape[1] == len(FEATURE_COLS)

        # Check spread computation: 100*(hi-lo)/forecast = 100*(12-8)/10 = 40%
        solar_spread = features.loc[SOLAR_START_SLOT:SOLAR_END_SLOT-1, "solcast_spread_pct"]
        assert np.allclose(solar_spread[solar_spread > 0], 40.0, atol=2.0)

    def test_build_features_without_triband(self):
        """Verify fallback when tri-band not available."""
        # Create snapshot with no tri-band signal
        snapshot = self._make_test_snapshot()
        snapshot["forecast_lo_kwh"] = snapshot["forecast_kwh"].copy()
        snapshot["forecast_hi_kwh"] = snapshot["forecast_kwh"].copy()

        w5 = self._make_test_weather()

        prior = solcast_prior_from_snapshot("2026-03-30", w5, snapshot, None)
        assert prior["has_triband"] == False  # Should detect no spread

        features = build_features(w5, "2026-03-30", prior)

        # Check fallback: zero spread
        assert np.allclose(features["solcast_lo_kwh"], features["solcast_prior_kwh"])
        assert np.allclose(features["solcast_hi_kwh"], features["solcast_prior_kwh"])
        assert np.allclose(features["solcast_spread_pct"], 0.0, atol=1.0)
        assert np.allclose(features["solcast_spread_ratio"], 0.0, atol=0.01)

    def test_spread_metrics_constraints(self):
        """Verify spread metrics stay within bounds."""
        snapshot = self._make_test_snapshot()
        # Force extreme spread
        snapshot["forecast_lo_kwh"] = np.full(SLOTS_DAY, 2.0)
        snapshot["forecast_hi_kwh"] = np.full(SLOTS_DAY, 20.0)

        w5 = self._make_test_weather()
        prior = solcast_prior_from_snapshot("2026-03-30", w5, snapshot, None)
        features = build_features(w5, "2026-03-30", prior)

        # Spread pct clipped to 200%
        assert np.all(features["solcast_spread_pct"] <= 200.0)
        # Spread ratio clipped to [-1, 1]
        assert np.all(features["solcast_spread_ratio"] >= -1.0)
        assert np.all(features["solcast_spread_ratio"] <= 1.0)

class TestTrainingDataWithTriBand:
    """Test training data collection handles tri-band mix."""

    def test_collect_training_data_hardened_mixed(self):
        """Verify training accepts mixed tri-band/single-value data.

        T4.1 / T4.2 update (v2.8.8): solcast_prior_from_snapshot now
        short-circuits tri-band features to zero-spread for past dates
        (where P10/P90 no longer represent real day-ahead confidence bands).
        Training rows built from past dates are therefore expected to have
        zero spread — this test was previously asserting the buggy behaviour
        (past-date rows contributing non-zero spread that polluted training).
        The assertion is relaxed to verify structural correctness only.
        """
        today = date(2026, 3, 29)

        # This will load both old (no tri-band) and new (tri-band) days
        result = collect_training_data_hardened(today, solcast_reliability=None)

        if result[0] is not None:  # If we have training data
            X, y, w, scale, days = result
            # Verify new columns exist and shape is correct
            assert "solcast_lo_kwh" in X.columns
            assert "solcast_hi_kwh" in X.columns
            assert X.shape[1] == len(FEATURE_COLS)
            # Spread must stay within defined bounds regardless of source.
            spread_vals = X["solcast_spread_pct"]
            assert float(spread_vals.min()) >= 0.0
            assert float(spread_vals.max()) <= 200.0

    def test_feature_count_consistency(self):
        """Verify FEATURE_COLS count matches actual features.

        v2.8 housekeeping: expected count bumped 70 → 72 after the locked
        snapshot additions (`spread_pct_cap_locked`, `hours_since_lock`).
        Update this assertion in the same commit as any future FEATURE_COLS
        change so the tripwire stays meaningful.
        """
        assert len(FEATURE_COLS) == 72, f"Expected 72 features, got {len(FEATURE_COLS)}"

if __name__ == "__main__":
    pytest.main([__file__, "-v"])
