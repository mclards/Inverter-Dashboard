"""
Regression tests for `_spread_weight` (v2.8 H1/H2 fixes).

These tests lock in the intended boundary behavior after the P1 ML
error-correction reliability audit:
    - H1: docstring range [0.09, 1.0] matches implementation
    - H2: None / zero spread returns 0.5 (mid-trust), not 1.0 (max-trust)

A future refactor that silently breaks these edge cases should fail
loudly here instead of silently degrading the error memory signal.
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

# Make `services.forecast_engine` importable without a pyproject
_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from services.forecast_engine import _spread_weight  # noqa: E402

class TestSpreadWeightUnknownSpread:
    """H2: unknown/zero spread should return 0.5, not 1.0."""

    def test_none_spread_returns_mid_trust(self):
        assert _spread_weight(None, None) == 0.5

    def test_none_spread_with_scheduled_capture(self):
        # capture_reason other than "backfill_approx" does not discount
        assert _spread_weight(None, "scheduled_0600") == 0.5
        assert _spread_weight(None, "scheduled_0955") == 0.5
        assert _spread_weight(None, "manual") == 0.5

    def test_zero_spread_treated_as_unknown(self):
        # A literal 0 spread is also "we don't know" — not "perfectly certain"
        assert _spread_weight(0.0, None) == 0.5

    def test_negative_spread_clamped_to_unknown(self):
        # Defensive — negative spreads should never arrive but must not crash
        assert _spread_weight(-5.0, None) == 0.5

    def test_none_spread_with_backfill_compounds(self):
        # Unknown spread × backfill = 0.5 * 0.3 = 0.15
        assert _spread_weight(None, "backfill_approx") == 0.15

class TestSpreadWeightMeasuredSpread:
    """Fresh (non-backfill) measured spread → linear discount down to 0.3 floor."""

    def test_very_narrow_spread(self):
        # 5% spread → weight 0.95
        assert _spread_weight(5.0, None) == 0.95

    def test_moderate_spread(self):
        assert _spread_weight(30.0, None) == 0.70

    def test_wide_spread(self):
        assert _spread_weight(50.0, None) == 0.50

    def test_spread_at_floor(self):
        # 70% spread → 0.30 (exactly the floor)
        assert math.isclose(_spread_weight(70.0, None), 0.30, abs_tol=1e-9)

    def test_spread_beyond_floor(self):
        # 100% spread would be 0.0 but floor holds at 0.30
        assert math.isclose(_spread_weight(100.0, None), 0.30, abs_tol=1e-9)
        # 150% spread (nonsensical but shouldn't explode)
        assert math.isclose(_spread_weight(150.0, None), 0.30, abs_tol=1e-9)

class TestSpreadWeightBackfillCompound:
    """H1: backfill × spread compounds can return below 0.3 → [0.09, 0.30] range."""

    def test_narrow_spread_backfill(self):
        # 0% spread (unknown) × 0.3 = 0.15 — new H2 behavior
        assert _spread_weight(None, "backfill_approx") == 0.15

    def test_small_spread_backfill(self):
        # 5% spread: 0.95 × 0.3 = 0.285
        result = _spread_weight(5.0, "backfill_approx")
        assert math.isclose(result, 0.285, abs_tol=1e-9)

    def test_floor_spread_backfill_is_compound_floor(self):
        # 70% spread (at spread floor 0.3) × 0.3 = 0.09 — the absolute minimum
        result = _spread_weight(70.0, "backfill_approx")
        assert math.isclose(result, 0.09, abs_tol=1e-9)

    def test_docstring_range_lower_bound(self):
        # The lowest possible return value is 0.09 (spread floor × backfill)
        lowest = _spread_weight(100.0, "backfill_approx")
        assert math.isclose(lowest, 0.09, abs_tol=1e-9)

    def test_docstring_range_upper_bound(self):
        # The highest possible return value is 1.0 (0% measured spread,
        # non-backfill is not reachable after H2 since 0 → unknown → 0.5;
        # upper bound is achieved by any spread > 0 that's very small)
        highest = _spread_weight(0.001, None)
        assert math.isclose(highest, 0.99999, abs_tol=1e-4)

class TestSpreadWeightDoesNotCrash:
    """Defensive: no input combination should raise."""

    def test_all_combinations(self):
        for spread in (None, 0, 0.001, 5.0, 50.0, 100.0, 999.0, -1.0):
            for reason in (None, "", "scheduled_0600", "scheduled_0955",
                           "manual", "backfill_approx", "unknown_reason"):
                w = _spread_weight(spread, reason)
                assert 0.0 <= w <= 1.0, (
                    f"_spread_weight({spread!r}, {reason!r}) = {w} "
                    f"— out of [0, 1] range"
                )
