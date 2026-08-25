"""Test suite for calibration_core.py — transport-agnostic calibration I/O.

Tests the core blocking Modbus functions with injected FakeModbusClient,
ensuring byte-exact equivalence across transport implementations.

Shared equivalence contract: these vectors define the permissible output
for each input register state, used identically by inverter_engine.py
and future CalibratorService.py serial client.
"""
from __future__ import annotations

import unittest
import threading
from unittest.mock import MagicMock
from services.calibration_core import (
    _read_calibration_block_sync,
    _read_live_for_calibration_sync,
    _CALIB_READ_BASE,
    _CALIB_READ_COUNT,
)

class FakeModbusResponse:
    """Fake pymodbus response object."""
    def __init__(self, registers=None, is_error=False):
        self.registers = registers or []
        self._is_error = is_error

    def isError(self):
        return self._is_error

class FakeModbusClient:
    """Fake pymodbus ModbusSerialClient / ModbusTcpClient for testing."""
    def __init__(self):
        self.read_holding_registers_returns = {}
        self.read_input_registers_returns = {}
        self.call_log = []

    def read_holding_registers(self, address, count, unit):
        """Fake FC03 read."""
        self.call_log.append(('read_holding', address, count, unit))
        key = (address, count, unit)
        return self.read_holding_registers_returns.get(key, FakeModbusResponse())

    def read_input_registers(self, address, count, unit):
        """Fake FC04 read."""
        self.call_log.append(('read_input', address, count, unit))
        key = (address, count, unit)
        return self.read_input_registers_returns.get(key, FakeModbusResponse())

class TestReadCalibrationBlockSync(unittest.TestCase):
    """Test _read_calibration_block_sync transport-neutral core."""

    def setUp(self):
        self.client = FakeModbusClient()
        self.lock = threading.Lock()

    def test_success_reads_15_regs_at_base_80(self):
        """Happy path: FC03 read returns 15 registers starting at addr 80."""
        # Set up fake response: 15 arbitrary register values.
        test_regs = list(range(1000, 1015))  # 15 regs: 1000, 1001, ..., 1014
        response = FakeModbusResponse(registers=test_regs)
        self.client.read_holding_registers_returns[(80, 15, 1)] = response

        result = _read_calibration_block_sync(self.client, self.lock, slave=1)

        self.assertTrue(result["ok"])
        self.assertEqual(result["regs"], test_regs)
        self.assertEqual(result["base"], 80)
        self.assertEqual(result["count"], 15)

    def test_success_with_custom_base_and_count(self):
        """Test with non-default base/count parameters."""
        test_regs = [500, 501, 502]
        response = FakeModbusResponse(registers=test_regs)
        self.client.read_holding_registers_returns[(100, 3, 2)] = response

        result = _read_calibration_block_sync(
            self.client, self.lock, slave=2, base=100, count=3
        )

        self.assertTrue(result["ok"])
        self.assertEqual(result["regs"], test_regs)
        self.assertEqual(result["base"], 100)
        self.assertEqual(result["count"], 3)

    def test_null_response(self):
        """Client returns None (communication failure)."""
        self.client.read_holding_registers_returns[(80, 15, 1)] = None

        result = _read_calibration_block_sync(self.client, self.lock, slave=1)

        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "null_response")

    def test_modbus_error(self):
        """Client returns error response."""
        response = FakeModbusResponse(is_error=True)
        self.client.read_holding_registers_returns[(80, 15, 1)] = response

        result = _read_calibration_block_sync(self.client, self.lock, slave=1)

        self.assertFalse(result["ok"])
        self.assertIn("modbus_error", result["error"])

    def test_short_frame_fewer_than_expected(self):
        """Response returns fewer registers than requested."""
        # Request 15, get only 10
        test_regs = list(range(10))
        response = FakeModbusResponse(registers=test_regs)
        self.client.read_holding_registers_returns[(80, 15, 1)] = response

        result = _read_calibration_block_sync(self.client, self.lock, slave=1)

        self.assertFalse(result["ok"])
        self.assertIn("short_frame", result["error"])

    def test_exception_during_read(self):
        """Modbus client raises exception."""
        def raise_error(*args, **kwargs):
            raise RuntimeError("Simulated communication error")

        self.client.read_holding_registers = raise_error

        result = _read_calibration_block_sync(self.client, self.lock, slave=1)

        self.assertFalse(result["ok"])
        self.assertIn("exception", result["error"])

    def test_lock_is_acquired(self):
        """Verify lock is held during the transaction."""
        acquired = []

        class LockTracker:
            def __init__(self):
                self._lock = threading.Lock()

            def __enter__(self):
                acquired.append(True)
                return self._lock.__enter__()

            def __exit__(self, *args):
                return self._lock.__exit__(*args)

        lock = LockTracker()
        test_regs = [1000] * 15
        response = FakeModbusResponse(registers=test_regs)
        self.client.read_holding_registers_returns[(80, 15, 1)] = response

        result = _read_calibration_block_sync(self.client, lock, slave=1)

        self.assertTrue(result["ok"])
        self.assertTrue(acquired, "Lock should have been acquired")

    def test_constant_defaults(self):
        """Verify module constants have expected values."""
        self.assertEqual(_CALIB_READ_BASE, 80)
        self.assertEqual(_CALIB_READ_COUNT, 15)

class TestReadLiveForCalibrationSync(unittest.TestCase):
    """Test _read_live_for_calibration_sync transport-neutral core."""

    def setUp(self):
        self.client = FakeModbusClient()
        self.lock = threading.Lock()

    def test_success_both_reads(self):
        """Happy path: both FC04 reads succeed, all fields populated."""
        # First read: 19 regs starting at addr 0
        # Indices: Vdc@8, Idc@9, Vac1@10, Vac2@11, Vac3@12,
        #          Iac1@13, Iac2@14, Iac3@15, Pac@18
        regs1 = [0] * 19
        regs1[8] = 400    # Vdc
        regs1[9] = 50     # Idc
        regs1[10] = 230   # Vac1
        regs1[11] = 230   # Vac2
        regs1[12] = 230   # Vac3
        regs1[13] = 100   # Iac1
        regs1[14] = 100   # Iac2
        regs1[15] = 100   # Iac3
        regs1[18] = 230   # Pac raw (× 10 = 2300 W)

        # Second read: 13 regs starting at addr 64
        # Indices: Qac@(68-64=4), Estado@(73-64=9), VpvN@(74-64=10),
        #          VpvP@(75-64=11), NomPower@(76-64=12)
        regs2 = [0] * 13
        regs2[4] = 50 & 0xFFFF      # Qac = 50 VAr (positive, no sign bit)
        regs2[9] = 0x0002           # Estado: phase=2 (grid-connected)
        regs2[10] = 200             # VpvN
        regs2[11] = 450             # VpvP
        regs2[12] = 100             # NomPower = 100 × 10 = 1000 W

        response1 = FakeModbusResponse(registers=regs1)
        response2 = FakeModbusResponse(registers=regs2)
        self.client.read_input_registers_returns[(0, 19, 1)] = response1
        self.client.read_input_registers_returns[(64, 13, 1)] = response2

        result = _read_live_for_calibration_sync(self.client, self.lock, slave=1)

        # Verify all AC voltage/current values
        self.assertEqual(result["vdc_v"], 400)
        self.assertEqual(result["idc_a"], 50)
        self.assertEqual(result["vac1_v"], 230)
        self.assertEqual(result["vac2_v"], 230)
        self.assertEqual(result["vac3_v"], 230)
        self.assertEqual(result["iac1_a"], 100)
        self.assertEqual(result["iac2_a"], 100)
        self.assertEqual(result["iac3_a"], 100)
        self.assertEqual(result["pac_w"], 2300)  # raw 230 × 10
        self.assertEqual(result["qac_var"], 500)  # raw 50 × 10
        self.assertEqual(result["vpv_n_v"], 200)
        self.assertEqual(result["vpv_p_v"], 450)
        self.assertEqual(result["nominal_power_w"], 1000)  # raw 100 × 10
        self.assertAlmostEqual(result["pct_of_pn"], 230.0, places=1)  # 2300/1000*100
        self.assertEqual(result["state_raw"], 0x0002)
        self.assertEqual(result["state_phase"], 0x0002)
        self.assertEqual(result["state_stop"], 0)
        self.assertEqual(result["state_blocked"], 0)
        self.assertEqual(result["state_grid_fault"], 0)

    def test_idc_negative_signed(self):
        """Idc (input reg 30010, addr 9) is Int16 signed per PDF pg 4.

        Regression for 2026-05-21: an idle inverter (DC contactor open) reads
        a small negative DC current from sensor zero-offset, e.g. -18 A which
        encodes to 0xFFEE on the wire. Before the fix the value was decoded
        as u16 → 65518, making the operator believe the Ipv reading had
        exploded after a 1961 → 1962 F_E_Ipv write.
        """
        regs1 = [0] * 19
        regs2 = [0] * 13
        # -18 A as two's-complement u16 = 0xFFEE
        regs1[9] = 0xFFEE
        response1 = FakeModbusResponse(registers=regs1)
        response2 = FakeModbusResponse(registers=regs2)
        self.client.read_input_registers_returns[(0, 19, 1)] = response1
        self.client.read_input_registers_returns[(64, 13, 1)] = response2

        result = _read_live_for_calibration_sync(self.client, self.lock, slave=1)

        self.assertEqual(result["idc_a"], -18)
        # Boundary cases — full signed Int16 range must round-trip.
        for raw, expected in [
            (0x0000, 0),
            (0x0001, 1),
            (0x7FFF, 32767),
            (0x8000, -32768),
            (0xFFFF, -1),
        ]:
            regs1[9] = raw
            response1 = FakeModbusResponse(registers=list(regs1))
            self.client.read_input_registers_returns[(0, 19, 1)] = response1
            result = _read_live_for_calibration_sync(self.client, self.lock, slave=1)
            self.assertEqual(result["idc_a"], expected,
                             f"idc raw 0x{raw:04X} should decode to {expected}")

    def test_pac_negative_signed(self):
        """Pac (input reg 30019, addr 18) is Int16 signed per PDF pg 5.

        Pac is reported in tens of W (raw * 10 = real W). A slightly negative
        Pac at idle (sensor noise) must NOT decode as a giant positive W.
        Regression paired with test_idc_negative_signed.
        """
        regs1 = [0] * 19
        regs2 = [0] * 13
        # Pac raw -5 (= 0xFFFB) → -50 W after × 10
        regs1[18] = 0xFFFB
        response1 = FakeModbusResponse(registers=regs1)
        response2 = FakeModbusResponse(registers=regs2)
        self.client.read_input_registers_returns[(0, 19, 1)] = response1
        self.client.read_input_registers_returns[(64, 13, 1)] = response2

        result = _read_live_for_calibration_sync(self.client, self.lock, slave=1)

        self.assertEqual(result["pac_w"], -50)
        # Max-negative Int16 must scale to -327680 W, not +327670.
        regs1[18] = 0x8000
        response1 = FakeModbusResponse(registers=list(regs1))
        self.client.read_input_registers_returns[(0, 19, 1)] = response1
        result = _read_live_for_calibration_sync(self.client, self.lock, slave=1)
        self.assertEqual(result["pac_w"], -32768 * 10)

    def test_qac_negative_signed(self):
        """Qac as signed Int16 (negative value)."""
        regs1 = [0] * 19
        regs2 = [0] * 13
        # Qac = -50 VAr (0xFFCE in two's complement)
        regs2[4] = 0xFFCE & 0xFFFF

        response1 = FakeModbusResponse(registers=regs1)
        response2 = FakeModbusResponse(registers=regs2)
        self.client.read_input_registers_returns[(0, 19, 1)] = response1
        self.client.read_input_registers_returns[(64, 13, 1)] = response2

        result = _read_live_for_calibration_sync(self.client, self.lock, slave=1)

        # -50 × 10 = -500 VAr
        self.assertEqual(result["qac_var"], -500)

    def test_estado_bits_all_set(self):
        """Estado with all relevant bits set (stop, blocked, grid fault)."""
        regs1 = [0] * 19
        regs2 = [0] * 13
        # Estado: low byte = 0x03 (phase=3), then bit 8=1 (stop), bit 9=1 (blocked), bit 10=1 (grid_fault)
        # Binary: 0000_0111_0000_0011 = 0x0703
        regs2[9] = 0x0703

        response1 = FakeModbusResponse(registers=regs1)
        response2 = FakeModbusResponse(registers=regs2)
        self.client.read_input_registers_returns[(0, 19, 1)] = response1
        self.client.read_input_registers_returns[(64, 13, 1)] = response2

        result = _read_live_for_calibration_sync(self.client, self.lock, slave=1)

        self.assertEqual(result["state_phase"], 0x03)
        self.assertEqual(result["state_stop"], 1)
        self.assertEqual(result["state_blocked"], 1)
        self.assertEqual(result["state_grid_fault"], 1)

    def test_pct_of_pn_calculation(self):
        """Verify %Pn derived field calculation."""
        regs1 = [0] * 19
        regs1[18] = 750  # Pac = 7500 W
        regs2 = [0] * 13
        regs2[12] = 100  # NomPower = 1000 W

        response1 = FakeModbusResponse(registers=regs1)
        response2 = FakeModbusResponse(registers=regs2)
        self.client.read_input_registers_returns[(0, 19, 1)] = response1
        self.client.read_input_registers_returns[(64, 13, 1)] = response2

        result = _read_live_for_calibration_sync(self.client, self.lock, slave=1)

        # 7500 / 1000 × 100 = 750.0
        self.assertAlmostEqual(result["pct_of_pn"], 750.0, places=1)

    def test_pct_of_pn_zero_when_nom_power_zero(self):
        """Skip %Pn calculation when nominal_power_w is 0."""
        regs1 = [0] * 19
        regs1[18] = 750  # Pac = 7500 W
        regs2 = [0] * 13
        regs2[12] = 0    # NomPower = 0 (should skip calc)

        response1 = FakeModbusResponse(registers=regs1)
        response2 = FakeModbusResponse(registers=regs2)
        self.client.read_input_registers_returns[(0, 19, 1)] = response1
        self.client.read_input_registers_returns[(64, 13, 1)] = response2

        result = _read_live_for_calibration_sync(self.client, self.lock, slave=1)

        self.assertIsNone(result["pct_of_pn"])

    def test_first_read_null(self):
        """First FC04 read returns None; second succeeds."""
        regs2 = [0] * 13
        regs2[4] = 100
        response2 = FakeModbusResponse(registers=regs2)
        self.client.read_input_registers_returns[(0, 19, 1)] = None
        self.client.read_input_registers_returns[(64, 13, 1)] = response2

        result = _read_live_for_calibration_sync(self.client, self.lock, slave=1)

        # First read failed, so Vdc/Idc/Vac/Iac/Pac should be None
        self.assertIsNone(result["vdc_v"])
        self.assertIsNone(result["pac_w"])
        # Second read succeeded
        self.assertEqual(result["qac_var"], 1000)  # 100 × 10

    def test_both_reads_null(self):
        """Both reads return None; fields all None."""
        self.client.read_input_registers_returns[(0, 19, 1)] = None
        self.client.read_input_registers_returns[(64, 13, 1)] = None

        result = _read_live_for_calibration_sync(self.client, self.lock, slave=1)

        # All measured fields should be None
        self.assertIsNone(result["vdc_v"])
        self.assertIsNone(result["pac_w"])
        self.assertIsNone(result["qac_var"])
        self.assertIsNone(result["nominal_power_w"])

    def test_exception_partial_read(self):
        """Exception during read; best-effort warning set."""
        def raise_error(*args, **kwargs):
            raise RuntimeError("Simulated error")

        self.client.read_input_registers = raise_error

        result = _read_live_for_calibration_sync(self.client, self.lock, slave=1)

        # Should have a warning, not raise
        self.assertIn("_warn", result)
        self.assertIn("live_read_partial", result["_warn"])

    def test_read_at_ms_present(self):
        """Verify read_at_ms timestamp is set."""
        regs1 = [0] * 19
        regs2 = [0] * 13
        response1 = FakeModbusResponse(registers=regs1)
        response2 = FakeModbusResponse(registers=regs2)
        self.client.read_input_registers_returns[(0, 19, 1)] = response1
        self.client.read_input_registers_returns[(64, 13, 1)] = response2

        result = _read_live_for_calibration_sync(self.client, self.lock, slave=1)

        # Should be an int millisecond timestamp
        self.assertIsInstance(result["read_at_ms"], int)
        self.assertGreater(result["read_at_ms"], 1000000000000)  # > Jan 2001

if __name__ == "__main__":
    unittest.main()
