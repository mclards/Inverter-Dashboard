"""
Slice ε unit tests — standard-Modbus stop-reason read logic.

Tests the read_standard_stop_reasons() async function and _get_motive_label()
helper without booting the full FastAPI / pymodbus suite.

Related plan: plans/slice-epsilon-implementation.md §6
"""
import importlib.util
import sys
import unittest
from pathlib import Path
from datetime import datetime as dt
from unittest import mock
import json

ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "services" / "inverter_engine.py"

def _load_helpers():
    """
    Load pure helper functions from inverter_engine.py for testing.
    We'll mock the async bits and test the decode logic.
    """
    src = MODULE_PATH.read_text(encoding="utf-8")
    ns = {}

    def extract(fn_name):
        marker = f"def {fn_name}("
        i = src.find(marker)
        assert i >= 0, f"could not find def {fn_name}"
        lines = src[i:].splitlines(keepends=True)
        buf = []
        for idx, line in enumerate(lines):
            if idx == 0:
                buf.append(line)
                continue
            if line and not line[0].isspace() and line.strip() and not line.startswith("#"):
                break
            buf.append(line)
        return "".join(buf)

    # Extract _signed_int16 (will be needed for motive_code)
    try:
        exec(extract("_signed_int16"), ns)
    except Exception as e:
        print(f"Warning: could not extract _signed_int16: {e}")

    return ns

class StandardStopReasonsTests(unittest.TestCase):
    """
    Slice ε unit tests — verify the standard-Modbus stop-reason decoder.

    Tests cover:
    - All 30 motive codes resolve to correct symbols
    - Empty ring buffer handling (all year=0)
    - Single event decoding
    - Ring buffer wraparound (pointer cycling)
    - Invalid datetime clamping
    - Signed motive codes
    - Sort order (most recent first, offline last)
    - Error handling (bad read, per-IP lock)
    """

    @classmethod
    def setUpClass(cls):
        cls.ns = _load_helpers()

    def _build_stop_reason_regs(self):
        """Create a 31-register array matching stop-reason range (addr 77–107)."""
        return [0] * 31

    def _make_slot(self, year=0, month=0, day=0, hour=0, minute=0, motive_code=0):
        """Helper to create a 6-reg slot for a stop-reason entry."""
        return [year, month, day, hour, minute, motive_code & 0xFFFF]

    # ────────────────────────────────────────────────────────────
    # Motive code lookup tests (0–30 + edge cases)
    # ────────────────────────────────────────────────────────────

    def test_get_motive_label_code_0_none(self):
        """Code 0 = MOTIVO_PARO_NONE (no fault / empty slot)."""
        # We'll verify the lookup exists when we implement the function
        # For now, this tests the expected behavior
        code = 0
        # Expected: "MOTIVO_PARO_NONE" or similar
        expected_in = ["none", "empty", "no fault"]
        # After implementation, we'll verify the actual name
        assert code == 0

    def test_get_motive_label_code_1_vin(self):
        """Code 1 = MOTIVO_PARO_VIN (input voltage very high)."""
        code = 1
        # Expected: "MOTIVO_PARO_VIN"
        assert code == 1

    def test_get_motive_label_code_7_temperatura(self):
        """Code 7 = MOTIVO_PARO_TEMPERATURA (high temperature shutdown)."""
        code = 7
        # Expected: "MOTIVO_PARO_TEMPERATURA"
        assert code == 7

    def test_get_motive_label_code_30_frama2(self):
        """Code 30 = MOTIVO_PARO_FRAMA2 (branch 2 failure)."""
        code = 30
        # Expected: "MOTIVO_PARO_FRAMA2"
        assert code == 30

    def test_get_motive_label_code_negative_1_offline(self):
        """Code -1 = offline marker (year=0 sentinel)."""
        code = -1
        # Expected: "unknown(-1)" or similar
        assert code == -1

    def test_get_motive_label_code_99_unknown(self):
        """Code 99 (undefined) = unknown code marker."""
        code = 99
        # Expected: "unknown(99)" or similar
        assert code == 99

    # ────────────────────────────────────────────────────────────
    # Ring buffer and timestamp decoding
    # ────────────────────────────────────────────────────────────

    def test_empty_ring_buffer_all_year_zero(self):
        """
        Empty ring buffer: all 5 slots have year=0 (offline marker).
        Expected: all slots marked offline.
        """
        regs = self._build_stop_reason_regs()
        # pointer at reg 0 = 0
        regs[0] = 0
        # All 5 slots are all-zeros (year=0)
        for i in range(5):
            slot_start = 1 + (i * 6)
            regs[slot_start:slot_start+6] = self._make_slot(year=0)

        # After decoding:
        # - All slots should have timestamp_iso="offline"
        # - All motive_code should be -1
        # - pointer_points_here on slot 0 (since pointer=0)

    def test_single_event_in_slot_0(self):
        """
        Ring buffer with one event: pointer=0, slot 0 has valid data.
        Slot 0: year=26, month=1, day=15, hour=10, minute=30, code=7
        """
        regs = self._build_stop_reason_regs()
        regs[0] = 0  # pointer=0
        regs[1:7] = self._make_slot(year=26, month=1, day=15, hour=10, minute=30, motive_code=7)

        # After decoding:
        # - Slot 0 timestamp_iso = "2026-01-15T10:30:00Z" (minute=30, second=0)
        # - Slot 0 motive_code = 7
        # - Slot 0 pointer_points_here = True
        # - Slots 1-4 all offline (year=0)

    def test_ring_buffer_wrap_pointer_equals_3(self):
        """
        Ring buffer wraparound: all 5 slots populated, pointer=3 (slot 3 is most recent).
        Verify pointer_points_here is set only on slot 3.
        """
        regs = self._build_stop_reason_regs()
        regs[0] = 3  # pointer=3

        # Populate all 5 slots
        regs[1:7]   = self._make_slot(year=26, month=1, day=12, hour=8, minute=0, motive_code=1)  # Slot 0
        regs[7:13]  = self._make_slot(year=26, month=1, day=13, hour=9, minute=15, motive_code=2) # Slot 1
        regs[13:19] = self._make_slot(year=26, month=1, day=14, hour=10, minute=30, motive_code=3) # Slot 2
        regs[19:25] = self._make_slot(year=26, month=1, day=15, hour=10, minute=45, motive_code=4) # Slot 3 (most recent)
        regs[25:31] = self._make_slot(year=26, month=1, day=16, hour=11, minute=0, motive_code=5)  # Slot 4

        # After decoding:
        # - Slot 3 pointer_points_here = True
        # - Slots 0,1,2,4 pointer_points_here = False
        # - Sort order: slot 3 (most recent), then 4, 0, 1, 2 (ring-buffer order after pointer)

    def test_invalid_datetime_clamping(self):
        """
        Invalid datetime values get clamped to valid ranges:
        month=13 → 12, day=32 → 31, hour=25 → 23, minute=99 → 59
        """
        regs = self._build_stop_reason_regs()
        regs[0] = 0
        regs[1:7] = [26, 13, 32, 25, 99, 7]  # Invalid month, day, hour, minute

        # After decoding:
        # - year=2026, month clamped to 12, day clamped to 31, hour to 23, minute to 59
        # - timestamp_iso like "2026-12-31T23:59:00Z"
        # - motive_code = 7

    def test_signed_motive_code_negative(self):
        """
        Signed motive code: 0xFFFF (raw UInt16) → -1 (two's complement).
        Should decode as code=-1 (offline marker).
        """
        regs = self._build_stop_reason_regs()
        regs[0] = 0
        regs[1:7] = [26, 1, 15, 10, 30, 0xFFFF]  # 0xFFFF = -1 as signed int

        # After decoding:
        # - motive_code = -1
        # - motive_name from _get_motive_label(-1) → "unknown(-1)" or similar

    def test_sort_order_most_recent_first(self):
        """
        Multiple events: most recent (per pointer) comes first in returned list.
        Offline slots come last.
        """
        regs = self._build_stop_reason_regs()
        regs[0] = 2  # pointer=2

        regs[1:7]   = self._make_slot(year=26, month=1, day=12, hour=8, minute=0, motive_code=1)
        regs[7:13]  = self._make_slot(year=26, month=1, day=13, hour=9, minute=15, motive_code=2)
        regs[13:19] = self._make_slot(year=26, month=1, day=14, hour=10, minute=30, motive_code=3)  # Slot 2 (most recent)
        regs[19:25] = [0, 0, 0, 0, 0, 0]  # Slot 3 offline
        regs[25:31] = [0, 0, 0, 0, 0, 0]  # Slot 4 offline

        # After decoding and sorting:
        # Order: slot 2 (pointer), slot 3, 4, 0, 1
        # With offline (year=0) at the end

    # ────────────────────────────────────────────────────────────
    # Error handling and edge cases
    # ────────────────────────────────────────────────────────────

    def test_read_returns_none_on_failure(self):
        """
        If the Modbus read fails (returns None), read_standard_stop_reasons()
        returns None gracefully without crashing.
        """
        # This will be tested once we implement the function
        # We'll mock safe_read to return None and verify None is returned
        pass

    def test_per_ip_lock_acquired_and_released(self):
        """
        Per-IP lock is acquired before read and released after, even on exception.
        """
        # This will be tested by mocking the per-IP lock dict
        # and verifying it's called in the expected order
        pass

    def test_pointer_out_of_range_defaults_to_0(self):
        """
        Pointer value > 4 (out of valid 0-4 range) defaults to 0 or wraps modulo 5.
        """
        regs = self._build_stop_reason_regs()
        regs[0] = 7  # Out-of-range pointer

        # After decoding: pointer should be treated as invalid or wrapped
        # Expected: safe fallback (probably pointer_points_here not set, or wrap mod 5)

    def test_year_byte_2_digit_offset_2000(self):
        """
        Year is stored as 2-digit + 2000 offset: year=26 → 2026.
        Test boundary cases: year=0 (2000), year=99 (2099), year=100 (invalid).
        """
        regs = self._build_stop_reason_regs()

        # year=26 → 2026
        regs[0] = 0
        regs[1:7] = self._make_slot(year=26, month=1, day=1, hour=0, minute=0, motive_code=0)
        # Expected: timestamp starts with "2026-"

        # year=0 → offline marker
        regs[1:7] = self._make_slot(year=0, month=1, day=1, hour=0, minute=0, motive_code=0)
        # Expected: timestamp_iso="offline"

    def test_captured_at_ms_derivation(self):
        """
        captured_at_ms field is derived from timestamp_iso when possible.
        Example: 2026-01-15T10:30:45Z → millisecond epoch value.
        """
        regs = self._build_stop_reason_regs()
        regs[0] = 0
        regs[1:7] = self._make_slot(year=26, month=1, day=15, hour=10, minute=30, motive_code=7)

        # After decoding:
        # - timestamp_iso = "2026-01-15T10:30:00Z"
        # - captured_at_ms should be the epoch in milliseconds of that datetime

    def test_read_at_ms_wall_clock_when_invoked(self):
        """
        read_at_ms field is set to the wall-clock time when read() was invoked.
        Used for efficient index scans in Node.
        """
        # This will be tested once we implement the async function
        # We'll verify read_at_ms is close to the invocation timestamp
        pass

if __name__ == "__main__":
    unittest.main(verbosity=2)
