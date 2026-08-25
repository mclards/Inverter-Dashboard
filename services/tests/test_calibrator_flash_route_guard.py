"""Regression test: calibrator Modbus routes fast-fail during a flash.

SAFETY/UX INVARIANT:
  The firmware-flash worker holds the registry per-IP lock
  (`with bus_lock:` in firmware_transport.flash_inverter_node) for the
  ENTIRE multi-minute flash. Every calibration/identity HTTP route that
  issues Modbus also takes that SAME lock (`lock = _registry.get_lock()`).
  Without a guard, any such route called during a flash (e.g. the UI
  live-calibration timer, or an operator click) blocks for minutes with
  no feedback — a frozen, standalone-reproducible UI hang, and a pile-up
  of blocked worker threads.

  Therefore EVERY route that does `lock = _registry.get_lock()` MUST first
  call `_fw_flash_in_progress()` and fast-fail. The flash STARTER
  (`bus_lock = _registry.get_lock()` in /firmware/flash) must NOT be
  guarded (it assigns the lock for the worker; it does not contend).

WHY A STATIC TEST:
  services.calibrator_app pulls heavy deps (FastAPI/pymodbus) and is
  ABI-sensitive; this mirrors test_poll_firmware_guard_order.py and parses
  the source as text instead of importing it.
"""

import os
import re
import unittest

def _read_source(path):
    with open(path, "r", encoding="utf-8") as fh:
        return fh.read()

class CalibratorFlashRouteGuardTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        p = os.path.join(os.path.dirname(__file__), "..", "calibrator_app.py")
        cls.source = _read_source(p)
        cls.lines = cls.source.splitlines()

    def test_helper_exists(self):
        self.assertIn(
            "def _fw_flash_in_progress()",
            self.source,
            "calibrator_app must define the _fw_flash_in_progress() guard helper",
        )

    def test_every_calibration_lock_acquire_is_guarded(self):
        """Each `lock = _registry.get_lock()` must be immediately preceded
        by the `if _fw_flash_in_progress():` fast-fail."""
        offenders = []
        guarded = 0
        for i, ln in enumerate(self.lines):
            if ln.strip() == "lock = _registry.get_lock()":
                # look back over the few lines above for the guard call
                window = "\n".join(self.lines[max(0, i - 3):i])
                if "_fw_flash_in_progress()" in window:
                    guarded += 1
                else:
                    offenders.append(i + 1)
        self.assertEqual(
            offenders, [],
            f"calibration/identity routes acquire the registry lock WITHOUT a "
            f"_fw_flash_in_progress() fast-fail at lines {offenders} — these "
            f"will freeze the UI for the whole flash. Add the guard.",
        )
        # Sanity: we actually found and validated several (not zero — which
        # would mean the anchor string changed and the test went blind).
        self.assertGreaterEqual(
            guarded, 5,
            f"expected several guarded calibration routes, found {guarded} — "
            f"the lock-acquire idiom may have changed; update this test.",
        )

    def test_flash_starter_is_not_guarded(self):
        """The /firmware/flash starter uses `bus_lock = _registry.get_lock()`
        (assigns the lock for the worker) and must NOT carry the fast-fail —
        otherwise no flash could ever start."""
        m = re.search(r"^\s*bus_lock = _registry\.get_lock\(\)",
                      self.source, re.MULTILINE)
        self.assertIsNotNone(
            m, "expected the flash starter `bus_lock = _registry.get_lock()`")
        start = self.source.rfind("\n", 0, m.start())
        window = self.source[max(0, start - 200):m.start()]
        self.assertNotIn(
            "_fw_flash_in_progress()", window,
            "the /firmware/flash starter must NOT be guarded by "
            "_fw_flash_in_progress() — it would deadlock flashing entirely",
        )

if __name__ == "__main__":
    unittest.main()
