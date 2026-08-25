"""Slice B unit tests — services/stop_reason.py struct parser + helpers.

Fixtures are derived from the same hardware-validated runs as
test_vendor_pdu.py so any future drift in the StopReason layout
(field order, scaling, signedness, DD/MM date split) trips here first.
"""
from __future__ import annotations

import struct
import sys
import threading
import unittest
from pathlib import Path
from unittest.mock import MagicMock

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services.stop_reason import (  # noqa: E402
    ARRAYHIST_ADDR,
    ARRAYHIST_COUNT_WORDS,
    NODE_BASE_ADDR,
    NODE_MAX_SUPPORTED,
    NODE_STRIDE,
    STOP_REASON_BYTES,
    STOP_REASON_COUNT_WORDS,
    StopMotiveHistogram,
    StopReasonRecord,
    parse_arrayhist,
    parse_stop_reason,
    read_with_lock,
    to_capture_payload,
)

# ─── Hardware-derived fixture (same source as test_vendor_pdu.py) ───────────

def _make_stopreason_bytes(*,
                            pot_ac_raw=10733, vpv=7820,
                            vac=(4000, 4001, 3998),
                            iac=(1500, 1499),
                            frec=(600, 600, 600),
                            cos=1000, temp=42,
                            alarma=0, motparo=0,
                            mes_dia_word=0x0418,
                            hora_min_word=0x1230,
                            ref1=0, pos1=0, alarmas1=0,
                            ref2=0, pos2=0, alarmas2=0,
                            flags=0, timeout_band=0,
                            debug_desc=20) -> bytes:
    return struct.pack(
        ">25H",
        pot_ac_raw, vpv,
        vac[0], vac[1], vac[2],
        iac[0], iac[1],
        frec[0], frec[1], frec[2],
        cos, temp,
        alarma, motparo,
        mes_dia_word, hora_min_word,
        ref1 & 0xFFFF, pos1 & 0xFFFF, alarmas1,
        ref2 & 0xFFFF, pos2 & 0xFFFF, alarmas2,
        flags, timeout_band, debug_desc,
    )

HEALTHY_RAW = _make_stopreason_bytes()  # DebugDesc=20, MotParo=0

# Inverter 23 (.133 EKI) DebugDesc=57 captured during validation
EVENT_RAW = _make_stopreason_bytes(
    motparo=20, debug_desc=57, alarma=0x0200, alarmas1=0x0600,
    pot_ac_raw=0,  # inverter stopped
)

# ─── ARRAYHISTMOTPARO fixture (TOTAL=62292 in slot 30) ─────────────────────

ARRAYHIST_62B = struct.pack(">31H", *([5] * 30 + [62292]))

# ──────────────────────────────────────────────────────────────────────────────
# parse_stop_reason
# ──────────────────────────────────────────────────────────────────────────────
class ParseStopReasonTests(unittest.TestCase):

    def test_decodes_pot_ac_with_signed_scaling(self):
        rec = parse_stop_reason(HEALTHY_RAW)
        # v2.10.4: PotAC is raw watts (signed). Fixture pot_ac_raw=10733
        # → 10.733 kW after /1000.
        self.assertAlmostEqual(rec.pot_ac, 10.733, places=3)

    def test_negative_pot_ac_decodes_signed(self):
        # 0xFCDB = -805 raw watts → -0.805 kW after /1000 (small overnight
        # aux load, e.g. fans / electronics drawing from the grid).
        raw = _make_stopreason_bytes(pot_ac_raw=0xFCDB)
        rec = parse_stop_reason(raw)
        self.assertAlmostEqual(rec.pot_ac, -0.805, places=3)

    def test_decodes_voltage_and_frequency_scaling(self):
        rec = parse_stop_reason(HEALTHY_RAW)
        # v2.10.4: Vpv and Vac are raw volts (no /10 scaling). Fixture
        # vpv=7820 → 7820.0 V (synthetic; real site readings are ~600-900 V
        # for the DC bus). Fixture vac=4000 → 4000.0 V (synthetic; real
        # site phase voltage is ~207-230 V).
        # Frec stays at /100, Cos stays at /1000.
        self.assertAlmostEqual(rec.vpv, 7820.0, places=2)
        self.assertAlmostEqual(rec.vac1, 4000.0, places=2)
        self.assertAlmostEqual(rec.frec1, 6.00, places=2)
        self.assertAlmostEqual(rec.cos, 1.000, places=3)

    def test_mes_dia_split_high_byte_month_low_byte_day(self):
        """ISM displays DD/MM — 0x0418 means day=24, month=4."""
        rec = parse_stop_reason(HEALTHY_RAW)
        self.assertEqual(rec.mes_dia_month, 4)
        self.assertEqual(rec.mes_dia_day, 24)
        self.assertEqual(rec.event_when_struct(), "24/04 18:48")

    def test_debug_desc_at_idx_24(self):
        rec = parse_stop_reason(HEALTHY_RAW)
        self.assertEqual(rec.debug_desc, 20)
        rec2 = parse_stop_reason(EVENT_RAW)
        self.assertEqual(rec2.debug_desc, 57)

    def test_is_active_event_false_when_all_zero(self):
        raw = _make_stopreason_bytes(debug_desc=0)  # everything zero
        rec = parse_stop_reason(raw)
        self.assertFalse(rec.is_active_event())

    def test_is_active_event_true_when_motparo_set(self):
        rec = parse_stop_reason(EVENT_RAW)
        self.assertTrue(rec.is_active_event())

    def test_is_active_event_true_when_only_debug_desc_set(self):
        raw = _make_stopreason_bytes(debug_desc=57)
        rec = parse_stop_reason(raw)
        self.assertTrue(rec.is_active_event())

    def test_too_short_raises(self):
        with self.assertRaises(ValueError) as ctx:
            parse_stop_reason(b"\x00" * 10)
        self.assertIn("too short", str(ctx.exception))

    def test_extra_bytes_ignored(self):
        """SCOPE may return more than 50 bytes — parser truncates."""
        rec = parse_stop_reason(HEALTHY_RAW + b"\xFF" * 20)
        self.assertEqual(rec.debug_desc, 20)

    def test_signed_temp_handles_below_zero(self):
        raw = _make_stopreason_bytes(temp=0xFFEC)  # -20°C
        rec = parse_stop_reason(raw)
        self.assertEqual(rec.temp, -20)

# ──────────────────────────────────────────────────────────────────────────────
# fingerprint — de-dup key
# ──────────────────────────────────────────────────────────────────────────────
class FingerprintTests(unittest.TestCase):

    def test_same_event_same_fingerprint(self):
        f1 = parse_stop_reason(EVENT_RAW).fingerprint()
        f2 = parse_stop_reason(EVENT_RAW).fingerprint()
        self.assertEqual(f1, f2)

    def test_different_debug_desc_different_fingerprint(self):
        a = parse_stop_reason(_make_stopreason_bytes(motparo=20, debug_desc=57))
        b = parse_stop_reason(_make_stopreason_bytes(motparo=20, debug_desc=58))
        self.assertNotEqual(a.fingerprint(), b.fingerprint())

    def test_different_struct_timestamp_different_fingerprint(self):
        a = parse_stop_reason(_make_stopreason_bytes(hora_min_word=0x1230))
        b = parse_stop_reason(_make_stopreason_bytes(hora_min_word=0x1231))
        self.assertNotEqual(a.fingerprint(), b.fingerprint())

    def test_telemetry_drift_does_not_change_fingerprint(self):
        """Fingerprint must NOT change for the same fault even if PotAC/Vac
        wiggle between reads — those aren't event identity."""
        a = parse_stop_reason(_make_stopreason_bytes(motparo=20, debug_desc=57,
                                                       pot_ac_raw=0, temp=42))
        b = parse_stop_reason(_make_stopreason_bytes(motparo=20, debug_desc=57,
                                                       pot_ac_raw=15, temp=43))
        self.assertEqual(a.fingerprint(), b.fingerprint())

# ──────────────────────────────────────────────────────────────────────────────
# to_capture_payload — JSON-ready dict for the Node-side endpoint
# ──────────────────────────────────────────────────────────────────────────────
class ToCapturePayloadTests(unittest.TestCase):

    def test_minimal_manual_capture(self):
        rec = parse_stop_reason(EVENT_RAW)
        payload = to_capture_payload(
            rec, raw=EVENT_RAW,
            inverter_ip="192.168.1.133", slave=4, node=1,
            read_at_ms=1745847600000,
        )
        self.assertEqual(payload["inverter_ip"], "192.168.1.133")
        self.assertEqual(payload["slave"], 4)
        self.assertEqual(payload["node"], 1)
        self.assertEqual(payload["trigger_source"], "manual")
        self.assertIsNone(payload["alarm_id"])
        self.assertIsNone(payload["event_at_ms"])
        self.assertEqual(payload["debug_desc"], 57)
        self.assertEqual(payload["motparo"], 20)
        self.assertTrue(payload["is_active_event"])
        self.assertEqual(payload["fingerprint"], rec.fingerprint())
        self.assertEqual(len(payload["raw_hex"]), STOP_REASON_BYTES * 2)

    def test_alarm_transition_capture_carries_event_ts_and_alarm_id(self):
        rec = parse_stop_reason(EVENT_RAW)
        payload = to_capture_payload(
            rec, raw=EVENT_RAW,
            inverter_ip="192.168.1.133", slave=4, node=1,
            read_at_ms=1745847600500,
            event_at_ms=1745847600000,    # poller-stamped, before read
            trigger_source="alarm_transition",
            alarm_id=4321,
        )
        self.assertEqual(payload["trigger_source"], "alarm_transition")
        self.assertEqual(payload["event_at_ms"], 1745847600000)
        self.assertEqual(payload["alarm_id"], 4321)
        self.assertLess(payload["event_at_ms"], payload["read_at_ms"])

# ──────────────────────────────────────────────────────────────────────────────
# parse_arrayhist
# ──────────────────────────────────────────────────────────────────────────────
class ParseArrayhistTests(unittest.TestCase):

    def test_total_at_slot_30(self):
        hist = parse_arrayhist(ARRAYHIST_62B)
        self.assertEqual(hist.total, 62292)
        self.assertEqual(len(hist.counters), 31)
        self.assertEqual(hist.counters[30], 62292)

    def test_to_capture_payload(self):
        hist = parse_arrayhist(ARRAYHIST_62B)
        payload = hist.to_capture_payload(
            inverter_ip="192.168.1.109", slave=2, read_at_ms=1745847600000
        )
        self.assertEqual(payload["total_count"], 62292)
        self.assertEqual(len(payload["counters"]), 31)
        self.assertEqual(payload["raw_hex"], ARRAYHIST_62B.hex())

    def test_too_short_raises(self):
        with self.assertRaises(ValueError):
            parse_arrayhist(b"\x00" * 10)

# ──────────────────────────────────────────────────────────────────────────────
# Address constants (regression guard)
# ──────────────────────────────────────────────────────────────────────────────
class AddressConstantsTests(unittest.TestCase):

    def test_node_addresses_match_decompile(self):
        """0xFEB5 + (N-1)*0x19 → Node 1=0xFEB5, Node 2=0xFECE, Node 3=0xFEE7."""
        self.assertEqual(NODE_BASE_ADDR + 0 * NODE_STRIDE, 0xFEB5)
        self.assertEqual(NODE_BASE_ADDR + 1 * NODE_STRIDE, 0xFECE)
        self.assertEqual(NODE_BASE_ADDR + 2 * NODE_STRIDE, 0xFEE7)

    def test_arrayhist_constants(self):
        self.assertEqual(ARRAYHIST_ADDR, 0xFE09)
        self.assertEqual(ARRAYHIST_COUNT_WORDS, 31)

    def test_stop_reason_count_and_bytes(self):
        self.assertEqual(STOP_REASON_COUNT_WORDS, 25)
        self.assertEqual(STOP_REASON_BYTES, 50)

    def test_node_cap_is_3(self):
        """v2.10.0 caps at 3 nodes — node 4 (0xFF00) returns garbage."""
        self.assertEqual(NODE_MAX_SUPPORTED, 3)

# ──────────────────────────────────────────────────────────────────────────────
# read_with_lock — orchestrator that calls vendor_scope_peek under a lock
# ──────────────────────────────────────────────────────────────────────────────
class ReadWithLockTests(unittest.TestCase):
    """Drive read_with_lock against a fake socket that produces canned replies
    based on the requested SCOPE address. Verifies lock is held during I/O
    and partial-failure mode (one node errors, others succeed)."""

    def _build_client_with_address_replies(self, address_to_payload: dict):
        """Build a MagicMock client whose socket replies based on the request
        addr extracted from each sendall()."""
        captured_reqs = []

        class AddrAwareSock:
            def __init__(self):
                self._reply = b""

            def settimeout(self, t):
                pass

            def sendall(self, data):
                captured_reqs.append(bytes(data))
                buf = bytes(data)
                # MBAP[0:7] = txn(2) proto(2) len(2) unit(1)
                # PDU[7:]   = FC(1) addr_hi(1) addr_lo(1) ...
                txn = struct.unpack(">H", buf[0:2])[0]
                slave = buf[6]
                addr = (buf[8] << 8) | buf[9]
                count = buf[11]
                data_payload = address_to_payload.get(addr)
                if data_payload is None:
                    # Reply with FC 0x71 SLAVE_FAILURE exception
                    body = struct.pack(">HHHB", txn, 0, 3, slave) + b"\xF1\x04"
                    self._reply = body
                    return
                # Build legitimate FC 0x71 response
                pdu_body = bytes([(addr >> 8) & 0xFF, addr & 0xFF, count]) + data_payload
                full_pdu = bytes([0x71]) + pdu_body
                length = 1 + len(full_pdu)
                self._reply = struct.pack(">HHHB", txn, 0, length, slave) + full_pdu

            def recv(self, n):
                chunk, self._reply = self._reply[:n], self._reply[n:]
                return chunk

            def close(self):
                pass

        client = MagicMock()
        client.socket = AddrAwareSock()
        return client, captured_reqs

    def test_reads_three_nodes_under_lock(self):
        client, captured = self._build_client_with_address_replies({
            0xFEB5: HEALTHY_RAW,
            0xFECE: HEALTHY_RAW,
            0xFEE7: EVENT_RAW,
        })
        lock = threading.Lock()

        result = read_with_lock(client, lock, slave=2)

        self.assertEqual(len(result["nodes"]), 3)
        self.assertTrue(all(n["ok"] for n in result["nodes"]))
        self.assertEqual(result["nodes"][0]["record"]["debug_desc"], 20)
        self.assertEqual(result["nodes"][2]["record"]["debug_desc"], 57)
        self.assertTrue(result["nodes"][2]["is_active_event"])
        self.assertIsNone(result["histogram"])
        # Lock released after orchestrator returns
        self.assertTrue(lock.acquire(blocking=False))
        lock.release()

    def test_partial_failure_does_not_abort_sweep(self):
        # Only Node 1 + Node 3 wired up; Node 2 (0xFECE) → exception path
        client, _ = self._build_client_with_address_replies({
            0xFEB5: HEALTHY_RAW,
            0xFEE7: EVENT_RAW,
        })
        lock = threading.Lock()

        result = read_with_lock(client, lock, slave=2)

        self.assertEqual(len(result["nodes"]), 3)
        self.assertTrue(result["nodes"][0]["ok"])
        self.assertFalse(result["nodes"][1]["ok"])
        self.assertIn("exception", result["nodes"][1]["error"].lower())
        self.assertTrue(result["nodes"][2]["ok"])

    def test_include_histogram_reads_arrayhist(self):
        client, _ = self._build_client_with_address_replies({
            0xFEB5: HEALTHY_RAW,
            0xFE09: ARRAYHIST_62B,
        })
        lock = threading.Lock()

        result = read_with_lock(client, lock, slave=2, nodes=[1],
                                  include_histogram=True)

        self.assertEqual(len(result["nodes"]), 1)
        self.assertTrue(result["nodes"][0]["ok"])
        self.assertIsNotNone(result["histogram"])
        self.assertTrue(result["histogram"]["ok"])
        self.assertEqual(result["histogram"]["total"], 62292)

if __name__ == "__main__":
    unittest.main()
