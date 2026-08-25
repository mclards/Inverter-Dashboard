"""
2026-06-08 unit tests — per-IP self-healing Modbus client rebuild decision.

Covers `should_rebuild_client()` in services/inverter_engine.py without importing
the full engine (which pulls pymodbus / FastAPI). We text-extract the pure
function plus its two threshold constants and exec them in an isolated namespace,
matching the style of test_counter_health.py.
"""
import re
import unittest
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

def _const(name, src):
    m = re.search(rf"^{name}\s*=\s*([0-9.]+)", src, re.MULTILINE)
    assert m, f"could not find constant {name}"
    return float(m.group(1))

def _load():
    src = MODULE_PATH.read_text(encoding="utf-8")
    ns = {
        "IP_REBUILD_AFTER_S": _const("IP_REBUILD_AFTER_S", src),
        "IP_REBUILD_MIN_INTERVAL_S": _const("IP_REBUILD_MIN_INTERVAL_S", src),
    }
    exec(_extract("should_rebuild_client", src), ns)
    return ns

class TestShouldRebuildClient(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ns = _load()
        cls.AFTER = cls.ns["IP_REBUILD_AFTER_S"]
        cls.MININT = cls.ns["IP_REBUILD_MIN_INTERVAL_S"]

    def _call(self, **kw):
        base = dict(
            now=10_000.0,
            last_success=10_000.0 - (self.AFTER + 5),   # well past the failure window
            last_rebuild=10_000.0 - (self.MININT + 5),  # well past the rate limit
            disabled=False,
            write_pending=False,
            fw_active=False,
        )
        base.update(kw)
        # Fetch from the namespace dict (not a bound attribute) so `self` is not
        # injected as the first positional arg.
        return type(self).ns["should_rebuild_client"](**base)

    def test_rebuilds_when_dead_long_enough(self):
        self.assertTrue(self._call())

    def test_disabled_flag_blocks(self):
        self.assertFalse(self._call(disabled=True))

    def test_write_pending_blocks(self):
        self.assertFalse(self._call(write_pending=True))

    def test_firmware_flash_blocks(self):
        self.assertFalse(self._call(fw_active=True))

    def test_recent_success_blocks(self):
        # Successful read 1s ago -> not dead long enough.
        self.assertFalse(self._call(last_success=10_000.0 - 1.0))

    def test_exactly_at_failure_threshold_rebuilds(self):
        # Contract is "elapsed >= threshold rebuilds" (only strictly-less blocks),
        # so exactly AFTER seconds of failure IS eligible.
        self.assertTrue(self._call(last_success=10_000.0 - self.AFTER))

    def test_just_before_failure_threshold_blocks(self):
        self.assertFalse(self._call(last_success=10_000.0 - (self.AFTER - 0.01)))

    def test_recent_rebuild_rate_limited(self):
        # Dead long enough, but rebuilt 1s ago -> rate-limited.
        self.assertFalse(self._call(last_rebuild=10_000.0 - 1.0))

    def test_exactly_at_rebuild_interval_rebuilds(self):
        self.assertTrue(self._call(last_rebuild=10_000.0 - self.MININT))

    def test_just_before_rebuild_interval_rate_limited(self):
        self.assertFalse(self._call(last_rebuild=10_000.0 - (self.MININT - 0.01)))

if __name__ == "__main__":
    unittest.main()
