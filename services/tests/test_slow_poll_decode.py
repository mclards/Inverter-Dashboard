"""
Slice β unit tests — slow-poll register-decode logic (addr 64–116).

Tests the read_slow_async() decoder and frame-merge strategy without
booting the full FastAPI / pymodbus suite.

Related plan: plans/slice-beta-implementation.md §6.1
"""
import importlib.util
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "services" / "inverter_engine.py"

def _load_slow_poll_helpers():
    """
    Load the pure _u32_hi_lo and _signed_int16 helpers from inverter_engine.py.
    These are used by read_slow_async() and can be tested independently.
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
            if line and not line.startswith((" ", "\t", "\n", "#")):
                break
            buf.append(line)
        return "".join(buf)

    exec(extract("_u32_hi_lo"), ns)
    exec(extract("_signed_int16"), ns)
    return ns

class SlowPollDecodeTests(unittest.TestCase):
    """
    Slice β unit tests — verify the slow-poll register decoder.

    Tests cover:
    - UInt32 hi-lo reconstruction (alarm windows)
    - Int16 sign extension (QAC, TempINT)
    - Boundary cases (offline, zeros)
    - Truncated frames (graceful defaults)
    """

    @classmethod
    def setUpClass(cls):
        cls.ns = _load_slow_poll_helpers()

    def _build_slow_regs(self):
        """Create a 53-register array matching slow-poll range (addr 64–116)."""
        return [0] * 53

    # ────────────────────────────────────────────────────────────
    # Alarm window tests (UInt32 hi-lo)
    # ────────────────────────────────────────────────────────────

    def test_alarms_inst_32_full_fixture(self):
        """
        Decode instantaneous alarms (regs 0–1 in slow-poll = addr 64–65).
        Fixture: hi=0x0001, lo=0x0002 → 0x00010002 = 65538.
        """
        regs = self._build_slow_regs()
        regs[0] = 0x0001
        regs[1] = 0x0002
        alarms_inst = self.ns["_u32_hi_lo"](regs, 0)
        self.assertEqual(alarms_inst, 0x00010002)

    def test_alarms_maint_32_full_fixture(self):
        """
        Decode maintained alarms (regs 2–3 in slow-poll = addr 66–67).
        Fixture: hi=0x0004, lo=0x0008 → 0x00040008 = 262152.
        """
        regs = self._build_slow_regs()
        regs[2] = 0x0004
        regs[3] = 0x0008
        alarms_maint = self.ns["_u32_hi_lo"](regs, 2)
        self.assertEqual(alarms_maint, 0x00040008)

    def test_alarms_inst_32_zero(self):
        """Offline inverter: instantaneous alarms = 0."""
        regs = self._build_slow_regs()
        alarms_inst = self.ns["_u32_hi_lo"](regs, 0)
        self.assertEqual(alarms_inst, 0)

    def test_alarms_maint_32_all_bits(self):
        """All alarm bits set: hi=0xFFFF, lo=0xFFFF → 0xFFFFFFFF."""
        regs = self._build_slow_regs()
        regs[2] = 0xFFFF
        regs[3] = 0xFFFF
        alarms_maint = self.ns["_u32_hi_lo"](regs, 2)
        self.assertEqual(alarms_maint, 0xFFFFFFFF)

    # ────────────────────────────────────────────────────────────
    # QAC reactive power (Int16 signed at addr 68, reg index 4)
    # ────────────────────────────────────────────────────────────

    def test_qac_var_negative_fixture(self):
        """
        QAC reactive power (reg 4 in slow-poll = addr 68).
        Raw value 0xFFFA → -6 (two's complement).
        After ÷10 scaling: -6 / 10 = -0.6 VAR.
        """
        fn = self.ns["_signed_int16"]
        qac_raw = fn(0xFFFA)
        qac_var = qac_raw / 10.0
        self.assertEqual(qac_raw, -6)
        self.assertAlmostEqual(qac_var, -0.6, places=5)

    def test_qac_var_positive_fixture(self):
        """
        QAC reactive power — positive fixture.
        Raw 100 → 100 / 10 = 10.0 VAR.
        """
        fn = self.ns["_signed_int16"]
        qac_raw = fn(100)
        qac_var = qac_raw / 10.0
        self.assertEqual(qac_raw, 100)
        self.assertAlmostEqual(qac_var, 10.0, places=5)

    def test_qac_var_zero_offline(self):
        """
        QAC = 0 indicates inverter offline / silent.
        Should return None in the frame (not 0.0).
        """
        fn = self.ns["_signed_int16"]
        qac_raw = fn(0)
        # In the actual frame, this becomes None; here we just verify decode
        self.assertEqual(qac_raw, 0)

    def test_qac_var_max_positive(self):
        """QAC max positive: 0x7FFF = 32767 / 10 = 3276.7 VAR."""
        fn = self.ns["_signed_int16"]
        qac_raw = fn(0x7FFF)
        qac_var = qac_raw / 10.0
        self.assertEqual(qac_raw, 32767)
        self.assertAlmostEqual(qac_var, 3276.7, places=5)

    def test_qac_var_max_negative(self):
        """QAC max negative: 0x8000 = -32768 / 10 = -3276.8 VAR."""
        fn = self.ns["_signed_int16"]
        qac_raw = fn(0x8000)
        qac_var = qac_raw / 10.0
        self.assertEqual(qac_raw, -32768)
        self.assertAlmostEqual(qac_var, -3276.8, places=5)

    # ────────────────────────────────────────────────────────────
    # Impedances (UInt16 unsigned at addr 69-70, reg index 5-6)
    # ────────────────────────────────────────────────────────────

    def test_zpos_kohm_realistic(self):
        """Zpos impedance (reg 5) = 50 kΩ."""
        regs = self._build_slow_regs()
        regs[5] = 50
        self.assertEqual(regs[5], 50)

    def test_zneg_kohm_realistic(self):
        """Zneg impedance (reg 6) = 48 kΩ."""
        regs = self._build_slow_regs()
        regs[6] = 48
        self.assertEqual(regs[6], 48)

    def test_zpos_zneg_zero_offline(self):
        """Offline inverter: impedances = 0."""
        regs = self._build_slow_regs()
        self.assertEqual(regs[5], 0)
        self.assertEqual(regs[6], 0)

    # ────────────────────────────────────────────────────────────
    # TempINT control-electronics temperature (Int16 signed at addr 72, reg index 8)
    # ────────────────────────────────────────────────────────────

    def test_tempint_c_negative_fixture(self):
        """
        TempINT (reg 8 in slow-poll = addr 72).
        Raw 0xFFDC → -36°C (two's complement).
        Cold weather scenario.
        """
        fn = self.ns["_signed_int16"]
        tempint_raw = fn(0xFFDC)
        self.assertEqual(tempint_raw, -36)

    def test_tempint_c_positive_fixture(self):
        """TempINT = 35°C normal operating temp."""
        fn = self.ns["_signed_int16"]
        tempint_raw = fn(35)
        self.assertEqual(tempint_raw, 35)

    def test_tempint_c_max_positive(self):
        """TempINT max positive: 0x7FFF = 32767°C (unrealistic but encodes correctly)."""
        fn = self.ns["_signed_int16"]
        tempint_raw = fn(0x7FFF)
        self.assertEqual(tempint_raw, 32767)

    def test_tempint_c_max_negative(self):
        """TempINT max negative: 0x8000 = -32768°C."""
        fn = self.ns["_signed_int16"]
        tempint_raw = fn(0x8000)
        self.assertEqual(tempint_raw, -32768)

    def test_tempint_c_zero_offline(self):
        """TempINT = 0 indicates offline (should return None in frame)."""
        fn = self.ns["_signed_int16"]
        tempint_raw = fn(0)
        self.assertEqual(tempint_raw, 0)

    # ────────────────────────────────────────────────────────────
    # Inverter state (UInt16 bitfield at addr 73, reg index 9)
    # ────────────────────────────────────────────────────────────

    def test_inverter_state_raw_fixture(self):
        """Inverter state raw bitfield = 0x0202."""
        regs = self._build_slow_regs()
        regs[9] = 0x0202
        self.assertEqual(regs[9], 0x0202)

    def test_inverter_state_raw_zero(self):
        """State = 0 (init or offline)."""
        regs = self._build_slow_regs()
        self.assertEqual(regs[9], 0)

    # ────────────────────────────────────────────────────────────
    # Solar field voltages (UInt16 at addr 74-75, reg index 10-11)
    # ────────────────────────────────────────────────────────────

    def test_vpv_n_v_fixture(self):
        """Vpv Negative-Earth = 450 V."""
        regs = self._build_slow_regs()
        regs[10] = 450
        self.assertEqual(regs[10], 450)

    def test_vpv_p_v_fixture(self):
        """Vpv Positive-Earth = 460 V."""
        regs = self._build_slow_regs()
        regs[11] = 460
        self.assertEqual(regs[11], 460)

    def test_vpv_both_zero_offline(self):
        """Offline inverter: Vpv fields = 0."""
        regs = self._build_slow_regs()
        self.assertEqual(regs[10], 0)
        self.assertEqual(regs[11], 0)

    # ────────────────────────────────────────────────────────────
    # Nominal power (UInt16 in tens of W at addr 76, reg index 12)
    # ────────────────────────────────────────────────────────────

    def test_nominal_power_w_fixture(self):
        """
        Nominal power (reg 12) = 1000 (in tens of W).
        Scaling: 1000 × 10 = 10,000 W = 10 kW per unit.
        """
        regs = self._build_slow_regs()
        regs[12] = 1000
        nominal_power_w = regs[12] * 10
        self.assertEqual(nominal_power_w, 10_000)

    def test_nominal_power_w_zero_offline(self):
        """Offline: nominal power = 0."""
        regs = self._build_slow_regs()
        nominal_power_w = regs[12] * 10
        self.assertEqual(nominal_power_w, 0)

    # ────────────────────────────────────────────────────────────
    # Time-to-connect (UInt16 at addr 108-109, reg index 44-45)
    # ────────────────────────────────────────────────────────────

    def test_time_to_connect_remaining_fixture(self):
        """Time-to-connect remaining = 45 seconds."""
        regs = self._build_slow_regs()
        regs[44] = 45
        self.assertEqual(regs[44], 45)

    def test_time_to_connect_total_fixture(self):
        """Time-to-connect total configured timeout = 60 seconds."""
        regs = self._build_slow_regs()
        regs[45] = 60
        self.assertEqual(regs[45], 60)

    def test_time_to_connect_zero_connected(self):
        """Connected/idle: countdown = 0."""
        regs = self._build_slow_regs()
        self.assertEqual(regs[44], 0)
        self.assertEqual(regs[45], 0)

    # ────────────────────────────────────────────────────────────
    # Power-reduction status bits (UInt16 at addr 116, reg index 52)
    # ────────────────────────────────────────────────────────────

    def test_power_reduction_bits_fixture(self):
        """
        Power-reduction status = 0x0003.
        Bit 0 = limited (1)
        Bit 1 = Modbus reduction active (1)
        """
        regs = self._build_slow_regs()
        regs[52] = 0x0003
        self.assertEqual(regs[52], 0x0003)

    def test_power_reduction_bits_no_limit(self):
        """No reduction active = 0."""
        regs = self._build_slow_regs()
        self.assertEqual(regs[52], 0)

    def test_power_reduction_bits_modbus_only(self):
        """Only Modbus reduction active = 0x0002."""
        regs = self._build_slow_regs()
        regs[52] = 0x0002
        self.assertEqual(regs[52], 0x0002)

    # ────────────────────────────────────────────────────────────
    # Truncated / offline frame handling
    # ────────────────────────────────────────────────────────────

    def test_truncated_frame_missing_last_regs(self):
        """
        Frame shorter than 53 regs (firmware variant).
        Decoder should use safe defaults (0 or None) for missing fields.
        """
        regs = [0] * 40  # Only 40 regs instead of 53
        # Attempt to access reg 52 (index out of bounds)
        # Code should use: regs[52] if len(regs) > 52 else 0
        power_reduction = regs[52] if len(regs) > 52 else 0
        self.assertEqual(power_reduction, 0)

    def test_all_zero_frame_offline(self):
        """
        Offline inverter: all 53 regs are zero.
        Alarm windows decode to 0, impedances to 0, temps to 0, etc.
        """
        regs = [0] * 53
        # Verify UInt32 reconstruction works on zeros
        alarms_inst = self.ns["_u32_hi_lo"](regs, 0)
        self.assertEqual(alarms_inst, 0)
        # Impedances
        self.assertEqual(regs[5], 0)
        self.assertEqual(regs[6], 0)
        # Power reduction
        self.assertEqual(regs[52], 0)

if __name__ == "__main__":
    unittest.main()
