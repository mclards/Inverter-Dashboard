"""
v2.9.1 unit tests for classify_seed_decision — the gate that refuses
crash-recovery seeding unless we have a clear snapshot of yesterday's
last reading.

Discovered by `python -m unittest discover -s services/tests`.
"""
import os
import re
import sys
import types
import unittest

def _load_classifier():
    """Load the classify_seed_decision helper without executing the rest of
    inverter_engine.py (which spawns asyncio loops, opens files, etc.)."""
    here = os.path.dirname(__file__)
    src_path = os.path.normpath(os.path.join(here, "..", "inverter_engine.py"))
    with open(src_path, "r", encoding="utf-8") as fh:
        text = fh.read()
    match = re.search(
        r"^def classify_seed_decision\b.*?(?=\n(?:async def|def) )",
        text,
        flags=re.DOTALL | re.MULTILINE,
    )
    if not match:
        raise RuntimeError("classify_seed_decision not found in inverter_engine.py")
    namespace = {}
    exec(match.group(0), namespace)
    return namespace["classify_seed_decision"]

classify_seed_decision = _load_classifier()

HEALTHY = dict(
    cur_etotal=30_500,
    cur_parce=30_500,
    today_baseline_etotal=30_000,   # set ~midnight
    today_baseline_parce=30_000,
    yesterday_etotal=30_000,         # last frame at 23:55 yesterday
    yesterday_present=True,
    rtc_year_ok=True,
)

class SeedGateHappyPath(unittest.TestCase):
    def test_seeds_etotal_delta_when_all_anchors_present(self):
        kwh, source, reason = classify_seed_decision(**HEALTHY)
        self.assertEqual(source, "etotal")
        self.assertEqual(reason, "")
        self.assertAlmostEqual(kwh, 500.0)

    def test_falls_back_to_parce_when_etotal_flat_but_parce_advanced(self):
        scenario = {
            **HEALTHY,
            "cur_etotal": 30_000,        # no etotal advance
            "cur_parce":  30_500,
        }
        kwh, source, reason = classify_seed_decision(**scenario)
        self.assertEqual(source, "parce")
        self.assertAlmostEqual(kwh, 500.0)

class SeedGateRefusesWithoutYesterdaySnapshot(unittest.TestCase):
    """The whole point of v2.9.1: zero-seed when we cannot anchor."""

    def test_refuses_when_yesterday_absent(self):
        scenario = {**HEALTHY, "yesterday_present": False, "yesterday_etotal": 0}
        kwh, source, reason = classify_seed_decision(**scenario)
        self.assertEqual(source, "zero")
        self.assertEqual(reason, "no_yesterday_snapshot")
        self.assertEqual(kwh, 0.0)

    def test_refuses_when_yesterday_etotal_zero(self):
        scenario = {**HEALTHY, "yesterday_etotal": 0}
        kwh, source, reason = classify_seed_decision(**scenario)
        self.assertEqual(source, "zero")
        self.assertEqual(reason, "yesterday_etotal_zero")

    def test_refuses_when_today_baseline_below_yesterday(self):
        # The classic "baseline got captured during transient bad first-frame"
        # inflation case: cur_etotal − tiny_baseline = lifetime counter.
        scenario = {
            **HEALTHY,
            "today_baseline_etotal": 1,   # bad first-frame value
            "yesterday_etotal":      30_000,
        }
        kwh, source, reason = classify_seed_decision(**scenario)
        self.assertEqual(source, "zero")
        self.assertEqual(reason, "baseline_below_yesterday")

    def test_refuses_when_midnight_gap_too_large(self):
        # Today's baseline captured at 09:00 (not midnight), so the gap from
        # yesterday's last reading is huge.
        scenario = {
            **HEALTHY,
            "today_baseline_etotal": 31_500,   # 1500 kWh after yesterday
            "yesterday_etotal":      30_000,
        }
        kwh, source, reason = classify_seed_decision(**scenario)
        self.assertEqual(source, "zero")
        self.assertEqual(reason, "midnight_gap_too_large")

    def test_allows_small_overnight_gap(self):
        # Inverter standby losses ≤ NIGHT_GAP_SANITY_KWH should pass.
        scenario = {
            **HEALTHY,
            "today_baseline_etotal": 30_010,   # 10 kWh overnight standby
            "yesterday_etotal":      30_000,
        }
        kwh, source, _ = classify_seed_decision(**scenario)
        self.assertEqual(source, "etotal")
        self.assertAlmostEqual(kwh, HEALTHY["cur_etotal"] - 30_010)

class SeedGateRespectsExistingHealthGates(unittest.TestCase):
    def test_refuses_on_invalid_rtc_year(self):
        scenario = {**HEALTHY, "rtc_year_ok": False}
        kwh, source, reason = classify_seed_decision(**scenario)
        self.assertEqual(source, "zero")
        self.assertEqual(reason, "rtc_invalid")

    def test_refuses_on_counter_regressed(self):
        # Both counters regressed below baseline → no path is viable.
        scenario = {**HEALTHY, "cur_etotal": 29_000, "cur_parce": 29_000}
        kwh, source, reason = classify_seed_decision(**scenario)
        self.assertEqual(source, "zero")
        self.assertEqual(reason, "counter_regressed")

    def test_refuses_on_sanity_cap_exceeded(self):
        # Both deltas > sanity cap → reject everything.
        scenario = {
            **HEALTHY,
            "cur_etotal": 100_000,                # etotal delta = 70_000
            "cur_parce":  100_000,                # parce  delta = 70_000
        }
        kwh, source, reason = classify_seed_decision(**scenario)
        self.assertEqual(source, "zero")
        self.assertEqual(reason, "sanity_cap_exceeded")

    def test_returns_counter_flat_when_no_movement(self):
        scenario = {
            **HEALTHY,
            "cur_etotal": HEALTHY["today_baseline_etotal"],
            "cur_parce":  HEALTHY["today_baseline_parce"],
        }
        kwh, source, reason = classify_seed_decision(**scenario)
        self.assertEqual(source, "zero")
        self.assertEqual(reason, "counter_flat")
        self.assertEqual(kwh, 0.0)

if __name__ == "__main__":
    unittest.main()
