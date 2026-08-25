"""
Slice F unit tests — v2.9.0 hardware-counter health gates (Python side).

Parity with server/tests/counterHealth.test.js.
"""
import unittest
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "services" / "inverter_engine.py"

def _extract(fn_name, src):
    marker = f"def {fn_name}("
    i = src.find(marker)
    assert i >= 0, f"could not find def {fn_name}"
    lines = src[i:].splitlines(keepends=True)
    buf = []
    for idx, line in enumerate(lines):
        if idx == 0:
            buf.append(line)
            continue
        if line and not line.startswith((" ", "\t", "\n", "#")):
            break
        buf.append(line)
    return "".join(buf)

def _load():
    src = MODULE_PATH.read_text(encoding="utf-8")
    ns = {}
    exec("from datetime import datetime", ns)
    for name in ("rtc_year_valid", "counter_advancing",
                 "parce_precision_ok", "trust_etotal", "trust_parce"):
        exec(_extract(name, src), ns)
    return ns

class RtcYearValidTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ns = _load()

    def test_current_year_ok(self):
        state = {"rtc_valid": True, "rtc_ms": int(datetime(2026, 4, 24).timestamp() * 1000)}
        self.assertTrue(self.ns["rtc_year_valid"](state, datetime(2026, 4, 24)))

    def test_plus_one_year_ok(self):
        state = {"rtc_valid": True, "rtc_ms": int(datetime(2027, 1, 1).timestamp() * 1000)}
        self.assertTrue(self.ns["rtc_year_valid"](state, datetime(2026, 12, 31)))

    def test_2047_rejected(self):
        state = {"rtc_valid": True, "rtc_ms": int(datetime(2047, 5, 11).timestamp() * 1000)}
        self.assertFalse(self.ns["rtc_year_valid"](state, datetime(2026, 4, 24)))

    def test_rtc_valid_false(self):
        state = {"rtc_valid": False, "rtc_ms": None}
        self.assertFalse(self.ns["rtc_year_valid"](state, datetime(2026, 4, 24)))

class CounterAdvancingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ns = _load()

    def _build(self, etotals, pacs, ts_base=1_700_000_000_000):
        return [
            {"ts_ms": ts_base + i * 100_000, "etotal_kwh": e, "pac_w": p}
            for i, (e, p) in enumerate(zip(etotals, pacs))
        ]

    def test_active_and_advancing(self):
        h = self._build([1000, 1001, 1002, 1003], [8000] * 4)
        self.assertTrue(self.ns["counter_advancing"](h))

    def test_active_and_frozen(self):
        h = self._build([1000] * 4, [8000] * 4)
        self.assertFalse(self.ns["counter_advancing"](h))

    def test_idle_and_frozen_ok(self):
        h = self._build([1000] * 4, [0, 10, 0, 5])
        self.assertTrue(self.ns["counter_advancing"](h))

    def test_short_history(self):
        self.assertTrue(self.ns["counter_advancing"]([]))
        self.assertTrue(self.ns["counter_advancing"]([{"ts_ms": 0, "etotal_kwh": 1, "pac_w": 5000}]))

class ParcePrecisionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ns = _load()

    def test_in_band(self):
        h = [{"ts_ms": 0, "parce_kwh": 100}, {"ts_ms": 1, "parce_kwh": 108}]
        self.assertTrue(self.ns["parce_precision_ok"](h, 8000))  # ratio 0.001

    def test_flat_rejected(self):
        h = [{"ts_ms": 0, "parce_kwh": 100}, {"ts_ms": 1, "parce_kwh": 100}]
        self.assertFalse(self.ns["parce_precision_ok"](h, 8000))

    def test_empty_allowed(self):
        self.assertTrue(self.ns["parce_precision_ok"]([], 0))

class TrustCompositionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ns = _load()

    def _hist(self, etotals, parces, pacs, ts_base=1_700_000_000_000):
        return [
            {"ts_ms": ts_base + i * 100_000,
             "etotal_kwh": e, "parce_kwh": p2, "pac_w": p1}
            for i, (e, p2, p1) in enumerate(zip(etotals, parces, pacs))
        ]

    def test_all_conditions_pass(self):
        state = {"rtc_valid": True, "rtc_ms": int(datetime(2026, 4, 24).timestamp() * 1000)}
        h = self._hist([1000, 1001, 1002, 1003], [100, 102, 105, 108], [8000]*4)
        self.assertTrue(self.ns["trust_etotal"](state, h, datetime(2026, 4, 24)))
        self.assertTrue(self.ns["trust_parce"](state, h, 8000, datetime(2026, 4, 24)))

    def test_frozen_counter_untrusted(self):
        state = {"rtc_valid": True, "rtc_ms": int(datetime(2026, 4, 24).timestamp() * 1000)}
        h = self._hist([1000]*4, [100]*4, [8000]*4)
        self.assertFalse(self.ns["trust_etotal"](state, h, datetime(2026, 4, 24)))

    def test_rtc_invalid_untrusted(self):
        state = {"rtc_valid": True, "rtc_ms": int(datetime(2047, 5, 11).timestamp() * 1000)}
        h = self._hist([1000, 1001, 1002, 1003], [100, 102, 105, 108], [8000]*4)
        self.assertFalse(self.ns["trust_etotal"](state, h, datetime(2026, 4, 24)))

if __name__ == "__main__":
    unittest.main()
