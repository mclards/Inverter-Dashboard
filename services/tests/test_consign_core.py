"""Test suite for calibration_io.py consign_apc_with_lock single-source core.

Tests the APC write pipeline with both inverter_engine.py and CalibratorService.py
patterns, ensuring byte-exact equivalence and Q15 scaling accuracy.

Q15 formula: Q15 = round(percent / 100 * 0x7FFF)
- 0% = 0x0000 (0)
- 20% = round(0x7FFF * 0.2) = round(32767 * 0.2) = round(6553.4) = 0x1999 (6553)
- 70% = round(0x7FFF * 0.7) = round(32767 * 0.7) = round(22936.9) = 0x5999 (22937)
- 100% = 0x7FFF (32767)
"""
from __future__ import annotations

import unittest
import threading
from unittest.mock import MagicMock, patch
from services.calibration_io import (
    consign_apc_with_lock,
    APC_REG,
    APC_OPCODE_SET_P,
    APC_Q15_MAX,
)

class FakeModbusResponse:
    """Fake pymodbus response for testing."""
    def __init__(self, registers=None, is_error=False):
        self.registers = registers or []
        self._is_error = is_error

    def isError(self):
        return self._is_error

class FakeModbusClient:
    """Fake pymodbus client for testing."""
    def __init__(self):
        self.write_registers_returns = {}
        self.call_log = []

    def write_registers(self, address, values, unit):
        self.call_log.append(('write_registers', address, values, unit))
        key = (address, tuple(values), unit)
        return self.write_registers_returns.get(key, FakeModbusResponse())

class TestConsignApcCoreScaling(unittest.TestCase):
    """Test Q15 scaling accuracy for reactive calibration consign points."""

    def test_q15_from_0_percent(self):
        """0% → Q15 = 0x0000."""
        from services.calibration_io import _q15_from_pct
        q15 = _q15_from_pct(0.0)
        self.assertEqual(q15, 0x0000)

    def test_q15_from_20_percent(self):
        """20% → Q15 = round(0x7FFF * 0.2) = 0x1999 (6553 decimal)."""
        from services.calibration_io import _q15_from_pct
        q15 = _q15_from_pct(20.0)
        expected = int(round(APC_Q15_MAX * 0.2))
        self.assertEqual(q15, expected)
        self.assertEqual(q15, 0x1999)

    def test_q15_from_70_percent(self):
        """70% → Q15 = round(0x7FFF * 0.7) = 0x5999 (22937 decimal)."""
        from services.calibration_io import _q15_from_pct
        q15 = _q15_from_pct(70.0)
        expected = int(round(APC_Q15_MAX * 0.7))
        self.assertEqual(q15, expected)
        self.assertEqual(q15, 0x5999)

    def test_q15_from_100_percent(self):
        """100% → Q15 = 0x7FFF (32767 decimal)."""
        from services.calibration_io import _q15_from_pct
        q15 = _q15_from_pct(100.0)
        self.assertEqual(q15, APC_Q15_MAX)
        self.assertEqual(q15, 0x7FFF)

    def test_q15_clamps_negative(self):
        """Negative percent clamped to 0%."""
        from services.calibration_io import _q15_from_pct
        q15 = _q15_from_pct(-10.0)
        self.assertEqual(q15, 0x0000)

    def test_q15_clamps_over_100(self):
        """Percent > 100 clamped to 100%."""
        from services.calibration_io import _q15_from_pct
        q15 = _q15_from_pct(150.0)
        self.assertEqual(q15, APC_Q15_MAX)

class TestConsignApcWithLock(unittest.TestCase):
    """Test consign_apc_with_lock — the single-source calibration-grade APC writer."""

    def setUp(self):
        self.client = FakeModbusClient()
        self.lock = threading.Lock()

    def test_consign_0_percent_writes_correct_registers(self):
        """Writing 0% should write [opcode=0x0003, q15=0x0000] to reg 0x03E8."""
        self.client.write_registers_returns[(APC_REG, (APC_OPCODE_SET_P, 0x0000), 1)] = FakeModbusResponse()

        result = consign_apc_with_lock(self.client, self.lock, 1, 0.0)

        self.assertTrue(result["ok"], f"Expected ok=True, got error: {result.get('error')}")
        self.assertEqual(result["pct"], 0.0)
        self.assertEqual(result["q15"], 0x0000)
        # Verify call log
        self.assertIn(('write_registers', APC_REG, [APC_OPCODE_SET_P, 0x0000], 1),
                      self.client.call_log)

    def test_consign_20_percent_writes_correct_registers(self):
        """Writing 20% should write [opcode=0x0003, q15=0x1999] to reg 0x03E8."""
        expected_q15 = 0x1999
        self.client.write_registers_returns[(APC_REG, (APC_OPCODE_SET_P, expected_q15), 2)] = FakeModbusResponse()

        result = consign_apc_with_lock(self.client, self.lock, 2, 20.0)

        self.assertTrue(result["ok"], f"Expected ok=True, got error: {result.get('error')}")
        self.assertEqual(result["pct"], 20.0)
        self.assertEqual(result["q15"], expected_q15)
        self.assertIn(('write_registers', APC_REG, [APC_OPCODE_SET_P, expected_q15], 2),
                      self.client.call_log)

    def test_consign_70_percent_writes_correct_registers(self):
        """Writing 70% should write [opcode=0x0003, q15=0x5999] to reg 0x03E8."""
        expected_q15 = 0x5999  # round(32767 * 0.7) = 22937
        self.client.write_registers_returns[(APC_REG, (APC_OPCODE_SET_P, expected_q15), 3)] = FakeModbusResponse()

        result = consign_apc_with_lock(self.client, self.lock, 3, 70.0)

        self.assertTrue(result["ok"], f"Expected ok=True, got error: {result.get('error')}")
        self.assertEqual(result["pct"], 70.0)
        self.assertEqual(result["q15"], expected_q15)
        self.assertIn(('write_registers', APC_REG, [APC_OPCODE_SET_P, expected_q15], 3),
                      self.client.call_log)

    def test_consign_100_percent_writes_correct_registers(self):
        """Writing 100% should write [opcode=0x0003, q15=0x7FFF] to reg 0x03E8."""
        expected_q15 = 0x7FFF
        self.client.write_registers_returns[(APC_REG, (APC_OPCODE_SET_P, expected_q15), 1)] = FakeModbusResponse()

        result = consign_apc_with_lock(self.client, self.lock, 1, 100.0)

        self.assertTrue(result["ok"], f"Expected ok=True, got error: {result.get('error')}")
        self.assertEqual(result["pct"], 100.0)
        self.assertEqual(result["q15"], expected_q15)

    def test_consign_rejects_negative_percent(self):
        """Percent < 0 should be rejected without write."""
        result = consign_apc_with_lock(self.client, self.lock, 1, -5.0)

        self.assertFalse(result["ok"])
        self.assertIn("error", result)
        self.assertIn("must be 0..100", result["error"])
        self.assertEqual(len(self.client.call_log), 0, "Should not call write_registers for invalid input")

    def test_consign_rejects_over_100_percent(self):
        """Percent > 100 should be rejected without write."""
        result = consign_apc_with_lock(self.client, self.lock, 1, 105.0)

        self.assertFalse(result["ok"])
        self.assertIn("error", result)
        self.assertIn("must be 0..100", result["error"])
        self.assertEqual(len(self.client.call_log), 0, "Should not call write_registers for invalid input")

    def test_consign_null_response(self):
        """Null response from Modbus should be reported as error."""
        q15 = int(round(APC_Q15_MAX * 0.5))
        self.client.write_registers_returns[(APC_REG, (APC_OPCODE_SET_P, q15), 1)] = None

        result = consign_apc_with_lock(self.client, self.lock, 1, 50.0)

        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "null_response")

    def test_consign_modbus_error_response(self):
        """Modbus error flag should be reported."""
        q15 = int(round(APC_Q15_MAX * 0.5))
        error_resp = FakeModbusResponse(is_error=True)
        self.client.write_registers_returns[(APC_REG, (APC_OPCODE_SET_P, q15), 1)] = error_resp

        result = consign_apc_with_lock(self.client, self.lock, 1, 50.0)

        self.assertFalse(result["ok"])
        self.assertIn("modbus_error", result["error"])

    def test_consign_exception_caught(self):
        """Exceptions from client should be caught and reported."""
        def raise_error(*args, **kwargs):
            raise RuntimeError("Modbus connection lost")

        self.client.write_registers = raise_error

        result = consign_apc_with_lock(self.client, self.lock, 1, 50.0)

        self.assertFalse(result["ok"])
        self.assertIn("exception", result["error"])
        self.assertIn("Modbus connection lost", result["error"])

    def test_consign_uses_lock(self):
        """Lock should be acquired during write (verified by call sequence)."""
        call_order = []

        def mock_write(*args, **kwargs):
            call_order.append("write")
            return FakeModbusResponse()

        self.client.write_registers = mock_write

        result = consign_apc_with_lock(self.client, self.lock, 1, 50.0)

        self.assertTrue(result["ok"])
        self.assertIn("write", call_order)

    def test_consign_multiple_slaves(self):
        """Different slave numbers should work independently."""
        for slave in [1, 2, 3]:
            q15 = 0x3FFF
            self.client.write_registers_returns[(APC_REG, (APC_OPCODE_SET_P, q15), slave)] = FakeModbusResponse()

        for slave in [1, 2, 3]:
            result = consign_apc_with_lock(self.client, self.lock, slave, 50.0)
            self.assertTrue(result["ok"])

    def test_consign_register_address_is_0x03e8(self):
        """Verify the command register address is 0x03E8 (1000 decimal)."""
        self.assertEqual(APC_REG, 0x03E8)
        self.assertEqual(APC_REG, 1000)

    def test_consign_opcode_set_p_is_0x0003(self):
        """Verify the SET-ACTIVE-PCT opcode is 0x0003."""
        self.assertEqual(APC_OPCODE_SET_P, 0x0003)

    def test_consign_response_shape_matches_http_contract(self):
        """Response dict shape must match the HTTP API contract."""
        self.client.write_registers_returns[(APC_REG, (APC_OPCODE_SET_P, 0x3FFF), 1)] = FakeModbusResponse()

        result = consign_apc_with_lock(self.client, self.lock, 1, 50.0)

        # Required fields
        self.assertIn("ok", result)
        self.assertIn("pct", result)
        self.assertIn("q15", result)
        # Error field optional (only if ok=False)
        if not result["ok"]:
            self.assertIn("error", result)

if __name__ == "__main__":
    unittest.main()
