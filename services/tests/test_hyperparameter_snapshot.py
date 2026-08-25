"""
Snapshot tests for ML error-memory hyperparameters (v2.8 C1).

These tests lock in the current values of the module-level constants that
govern the error-memory learning loop. A future refactor that changes any
of these values will fail these tests, forcing an explicit code-review
conversation rather than a silent drift.

Intent: these are NOT tests of correctness. They are tripwires. If the
tuning is deliberately changed, update the expected values here in the
same commit.
"""
from __future__ import annotations

import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from services import forecast_engine as fe  # noqa: E402

class TestErrorMemoryConstants:
    """Scalar hyperparameters for `compute_error_memory` and its downstream."""

    def test_err_memory_days(self):
        assert fe.ERR_MEMORY_DAYS == 7, (
            "ERR_MEMORY_DAYS is the default lookback window (clear regime). "
            "Change only as part of a deliberate tuning pass."
        )

    def test_err_memory_decay(self):
        assert fe.ERR_MEMORY_DECAY == 0.72, (
            "ERR_MEMORY_DECAY is the geometric decay per day. "
            "0.72^6 = 0.14 → day 7 is ~14% of day 1. "
            "See audit L1 for the effective-window discussion."
        )

    def test_error_alpha(self):
        assert fe.ERROR_ALPHA == 0.28, (
            "ERROR_ALPHA is the fraction of mem_err applied to the final "
            "forecast. Combined with the ±100 kWh/slot clip, max bias is "
            "0.28 × 100 = 28 kWh/slot before damping."
        )

    def test_err_memory_regime_mismatch_penalty_fallback(self):
        assert fe.ERR_MEMORY_REGIME_MISMATCH_PENALTY == 0.25, (
            "Flat fallback penalty used when a regime pair is not in "
            "ERR_MEMORY_REGIME_PENALTY_MATRIX."
        )

class TestErrorMemoryDaysByRegime:
    """Per-regime lookback window overrides."""

    def test_clear_regime_window(self):
        assert fe.ERR_MEMORY_DAYS_BY_REGIME["clear"] == 7

    def test_mixed_regime_window(self):
        assert fe.ERR_MEMORY_DAYS_BY_REGIME["mixed"] == 10

    def test_overcast_regime_window(self):
        assert fe.ERR_MEMORY_DAYS_BY_REGIME["overcast"] == 14

    def test_rainy_regime_window(self):
        # Longest window because rainy days are rarest in the training window
        assert fe.ERR_MEMORY_DAYS_BY_REGIME["rainy"] == 21

    def test_regime_window_ordering(self):
        """Rarer regimes should have longer lookbacks."""
        d = fe.ERR_MEMORY_DAYS_BY_REGIME
        assert d["clear"] <= d["mixed"] <= d["overcast"] <= d["rainy"], (
            "Per-regime lookbacks must be non-decreasing from clear→rainy"
        )

class TestRegimePenaltyMatrix:
    """Graduated penalty matrix for cross-regime error memory weighting."""

    def test_matrix_is_symmetric(self):
        """Each (A, B) pair should have a matching (B, A) with the same weight."""
        m = fe.ERR_MEMORY_REGIME_PENALTY_MATRIX
        for (a, b), v in m.items():
            reverse = m.get((b, a))
            assert reverse is not None, f"Matrix missing reverse pair ({b}, {a})"
            assert reverse == v, (
                f"Matrix not symmetric: ({a},{b})={v} but ({b},{a})={reverse}"
            )

    def test_neighboring_regimes_penalized_less(self):
        """Overcast↔rainy should be penalized LESS than clear↔rainy."""
        m = fe.ERR_MEMORY_REGIME_PENALTY_MATRIX
        neighboring = m[("overcast", "rainy")]
        distant = m[("clear", "rainy")]
        assert neighboring > distant, (
            f"Neighboring regimes should share more error structure: "
            f"overcast↔rainy={neighboring} vs clear↔rainy={distant}"
        )

    def test_clear_vs_rainy_is_lowest(self):
        """The most distant pair should have the lowest weight."""
        m = fe.ERR_MEMORY_REGIME_PENALTY_MATRIX
        values = list(m.values())
        assert m[("clear", "rainy")] == min(values)

    def test_matrix_exact_values(self):
        """Snapshot the exact matrix values. Fail on any tuning change."""
        expected = {
            ("clear",    "mixed"):    0.50,
            ("clear",    "overcast"): 0.25,
            ("clear",    "rainy"):    0.20,
            ("mixed",    "clear"):    0.50,
            ("mixed",    "overcast"): 0.60,
            ("mixed",    "rainy"):    0.35,
            ("overcast", "clear"):    0.25,
            ("overcast", "mixed"):    0.60,
            ("overcast", "rainy"):    0.70,
            ("rainy",    "clear"):    0.20,
            ("rainy",    "mixed"):    0.35,
            ("rainy",    "overcast"): 0.70,
        }
        assert dict(fe.ERR_MEMORY_REGIME_PENALTY_MATRIX) == expected

class TestRegimeBlendConstants:
    """LightGBM regime-blend parameters."""

    def test_regime_model_min_days(self):
        assert fe.REGIME_MODEL_MIN_DAYS == 6

    def test_regime_blend_base(self):
        assert fe.REGIME_BLEND_BASE == 0.52

    def test_regime_blend_max(self):
        assert fe.REGIME_BLEND_MAX == 0.82

    def test_blend_ordering(self):
        assert fe.REGIME_BLEND_BASE < fe.REGIME_BLEND_MAX

class TestMinUsableSlotsForEligibility:
    """v2.8 H3: named constant derived from SOLAR_SLOTS."""

    def test_constant_present(self):
        assert hasattr(fe, "MIN_USABLE_SLOTS_FOR_ELIGIBILITY")

    def test_derived_from_solar_slots(self):
        # 85% of 156 = 132 (current value; will auto-adjust if SOLAR_SLOTS changes)
        assert fe.MIN_USABLE_SLOTS_FOR_ELIGIBILITY == int(fe.SOLAR_SLOTS * 0.85)

    def test_current_value(self):
        # Snapshot the current value for a tripwire on SOLAR_SLOTS changes
        assert fe.MIN_USABLE_SLOTS_FOR_ELIGIBILITY == 132

class TestSolcastCoverageThresholds:
    """v2.8 C1 (Solcast reliability audit): named coverage thresholds."""

    def test_fresh_threshold(self):
        assert fe.SOLCAST_COVERAGE_FRESH_THRESHOLD == 0.95

    def test_usable_threshold(self):
        assert fe.SOLCAST_COVERAGE_USABLE_THRESHOLD == 0.80

    def test_threshold_ordering(self):
        assert fe.SOLCAST_COVERAGE_USABLE_THRESHOLD < fe.SOLCAST_COVERAGE_FRESH_THRESHOLD

class TestSQLiteRetryConstants:
    """SQLite retry budget."""

    def test_retry_attempts(self):
        assert fe.SQLITE_RETRY_ATTEMPTS == 3

    def test_retry_backoff(self):
        assert fe.SQLITE_RETRY_BACKOFF_SEC == 0.35

    def test_read_timeout(self):
        assert fe.SQLITE_READ_TIMEOUT_SEC == 8.0

    def test_write_timeout(self):
        assert fe.SQLITE_WRITE_TIMEOUT_SEC == 20.0

    def test_write_timeout_greater_than_read(self):
        assert fe.SQLITE_WRITE_TIMEOUT_SEC > fe.SQLITE_READ_TIMEOUT_SEC
