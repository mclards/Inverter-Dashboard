"""Regression test for firmware-flash guard ordering in inverter poller.

SAFETY-CRITICAL INVARIANT:
  In both `poll_inverter(ip)` and `slow_poll_inverter(ip)`, the call to
  `firmware_flash_active(ip)` MUST textually appear BEFORE the first call
  to `detect_units_async(ip)` within that function.

WHY THIS MATTERS:
  `detect_units_async(ip)` issues Modbus probe reads to discover inverter
  units. If the dashboard engine starts while a firmware flash is already
  in progress (calibrator opened first, dashboard second), this is the FIRST
  bus traffic to that inverter. An unguarded probe would COLLIDE with the
  calibrator's flash and BRICK the inverter firmware.

  The firmware_flash_active(ip) guard checks a cross-process lockfile
  (fail-open, no crash on missing marker) and short-circuits the entire
  poller cycle if a flash is active, allowing the calibrator to be the sole
  Modbus master.

  If someone reorders or removes either guard, a cold-start collision becomes
  possible. This test catches that regression immediately.

IMPLEMENTATION NOTES:
  • Reads services/inverter_engine.py as plain text (no import).
  • Extracts the function bodies by slicing from the async def line to the
    next top-level function definition.
  • Asserts guard appears before detect in both functions.
  • Explicit failure messages indicate which function regressed and why.
"""

import os
import re
import unittest

def _read_source(path):
    """Read a Python source file as text."""
    with open(path, "r", encoding="utf-8") as fh:
        return fh.read()

def _extract_function_body(source, func_name):
    """
    Extract the body of an async def func_name(...) from source text.

    Returns the text from the line after the 'async def' through the line
    before the next top-level function definition (at column 0).
    Raises ValueError if the function is not found.
    """
    # Find the function definition line
    pattern = rf"^async def {re.escape(func_name)}\([^)]*\):"
    match = re.search(pattern, source, re.MULTILINE)
    if not match:
        raise ValueError(f"Function 'async def {func_name}(...)' not found in source")

    # Start after the def line and its docstring/header
    start_idx = match.end()

    # Find the next top-level function or end of file
    # Top-level = begins at column 0 with "async def " or "def "
    remainder = source[start_idx:]
    next_func_match = re.search(r"\n(?:async )?def ", remainder)

    if next_func_match:
        end_idx = start_idx + next_func_match.start()
    else:
        # No next function; consume to end of file
        end_idx = len(source)

    return source[start_idx:end_idx]

class PollFirmwareGuardOrderTest(unittest.TestCase):
    """Ensure firmware_flash_active guard appears before detect_units_async."""

    @classmethod
    def setUpClass(cls):
        """Load the inverter_engine.py source once."""
        engine_path = os.path.join(
            os.path.dirname(__file__), "..", "inverter_engine.py"
        )
        cls.source = _read_source(engine_path)

    def test_slow_poll_inverter_guard_before_detect(self):
        """
        In slow_poll_inverter(ip), firmware_flash_active(ip) must appear
        textually before detect_units_async(ip).
        """
        body = _extract_function_body(self.source, "slow_poll_inverter")

        # Verify both calls are present
        self.assertIn(
            "firmware_flash_active(ip)",
            body,
            "slow_poll_inverter missing firmware_flash_active(ip) guard",
        )
        self.assertIn(
            "detect_units_async(ip)",
            body,
            "slow_poll_inverter missing detect_units_async(ip) call",
        )

        # Verify guard comes first
        guard_pos = body.index("firmware_flash_active(ip)")
        detect_pos = body.index("detect_units_async(ip)")

        self.assertLess(
            guard_pos,
            detect_pos,
            f"slow_poll_inverter: firmware_flash_active guard at pos {guard_pos} "
            f"but detect_units_async at pos {detect_pos} — guard must come FIRST "
            f"to prevent unguarded probe collision on cold-start with active flash",
        )

    def test_poll_inverter_guard_before_first_detect(self):
        """
        In poll_inverter(ip), the FIRST firmware_flash_active(ip) guard in the
        function must appear textually before the FIRST detect_units_async(ip) call.

        Note: poll_inverter has a second firmware_flash_active check inside the
        inner loop (after units are known); that is a per-cycle guard for flashes
        that BEGIN mid-polling. This test enforces the FIRST guard at function
        entry, before ANY detect_units_async probe.
        """
        body = _extract_function_body(self.source, "poll_inverter")

        # Verify at least one of each call is present
        self.assertIn(
            "firmware_flash_active(ip)",
            body,
            "poll_inverter missing firmware_flash_active(ip) guard",
        )
        self.assertIn(
            "detect_units_async(ip)",
            body,
            "poll_inverter missing detect_units_async(ip) call",
        )

        # Find the FIRST occurrence of each
        guard_pos = body.index("firmware_flash_active(ip)")
        detect_pos = body.index("detect_units_async(ip)")

        self.assertLess(
            guard_pos,
            detect_pos,
            f"poll_inverter: first firmware_flash_active guard at pos {guard_pos} "
            f"but first detect_units_async at pos {detect_pos} — guard must come FIRST "
            f"to prevent unguarded probe collision on cold-start with active flash; "
            f"if someone moved the outer guard inside the inner loop, collision is possible",
        )

if __name__ == "__main__":
    unittest.main()
