"""Slice A unit tests — vendor_pdu.py FC 0x71 SCOPE peek + FC11 Report Slave ID.

Byte fixtures derived from the hardware-validated probe runs on 2026-04-27:
  - .109 slave=2 (comm board, port 502 + MBAP)        → DebugDesc=20, serial=400152A17R52
  - .133 slave=4 (EKI-1222-BE fallback, port 502)     → DebugDesc=57, serial=400152A18R44

Frame layouts and field offsets are pinned here so any future refactor of
vendor_pdu.py that breaks the wire format will fail the suite immediately.

Pure stdlib — no socket I/O, no pymodbus dependency.
"""
from __future__ import annotations

import struct
import unittest
from pathlib import Path
from unittest.mock import MagicMock

ROOT = Path(__file__).resolve().parents[2]
import sys
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services.vendor_pdu import (  # noqa: E402
    SlaveIdInfo,
    VendorPduError,
    build_fc71_peek_pdu,
    parse_fc11_slave_id,
    parse_fc71_response_pdu,
    read_slave_id,
    vendor_scope_peek,
)

# ─── Frame builders for synthesizing fake server responses ──────────────────

def _mbap_wrap(txn_id: int, slave: int, fc: int, body_after_fc: bytes) -> bytes:
    """Build a full MBAP+PDU frame as the inverter would send it back."""
    pdu = bytes([fc]) + body_after_fc
    length = 1 + len(pdu)
    return struct.pack(">HHHB", txn_id, 0x0000, length, slave) + pdu

def _make_fc71_response_body(addr: int, data_bytes: bytes) -> bytes:
    """Build FC 0x71 response body (post-FC): [addr_hi][addr_lo][bc_words][data]."""
    bc_words = len(data_bytes) // 2
    return bytes([(addr >> 8) & 0xFF, addr & 0xFF, bc_words]) + data_bytes

# ─── Hardware-derived StopReason payload (.109 slave=2, captured 2026-04-27) ─

# 25 UINT16 fields, big-endian. Decoded values mirror what ISM displays:
#   PotAC=1073.3 kW, Vac=400, Iac=1500, Frec=600, Cos=1000, Temp=42,
#   Alarma=0, MotParo=0, MesDia=0x0418 (April 24), HoraMin=0x1230 (18:48),
#   DebugDesc=20.
STOP_REASON_50B_NODE1 = struct.pack(
    ">25H",
    10733,    # 0  PotAC (×0.1 kW) → 1073.3 kW
    7820,     # 1  Vpv (×0.1 V)
    4000,     # 2  Vac1
    4001,     # 3  Vac2
    3998,     # 4  Vac3
    1500,     # 5  Iac1
    1499,     # 6  Iac2
    600,      # 7  Frec1
    600,      # 8  Frec2
    600,      # 9  Frec3
    1000,     # 10 Cos
    42,       # 11 Temp (°C)
    0,        # 12 Alarma
    0,        # 13 MotParo
    0x0418,   # 14 MesDia (DD/MM = 24/04 → 0x18=24, 0x04=4)
    0x1230,   # 15 HoraMin
    0,        # 16 Ref1
    0,        # 17 Pos1
    0,        # 18 Alarmas1
    0,        # 19 Ref2
    0,        # 20 Pos2
    0,        # 21 Alarmas2
    0,        # 22 Flags
    0,        # 23 TimeoutBand
    20,       # 24 DebugDesc  ← the prize
)
assert len(STOP_REASON_50B_NODE1) == 50

# ─── ARRAYHISTMOTPARO fixture (31 UINT16 counters, TOTAL=62292 in last slot) ─

ARRAYHIST_62B = struct.pack(
    ">31H",
    *([5] * 30),   # 30 motive counters, each = 5
    62292,         # TOTAL slot
)
assert len(ARRAYHIST_62B) == 62

# ─── FC11 Report Slave ID fixture (102-byte INGECON Motorola payload) ───────

def _build_fc11_payload(serial_ascii: str, model_ascii: str,
                         fw_main: str, fw_aux: str) -> bytes:
    """Synthesize a 102-byte FC11 payload matching the Motorola layout."""
    buf = bytearray(102)
    buf[0:2] = b"\x7d\xff"  # header
    serial_b = serial_ascii.encode("ascii")
    assert len(serial_b) == 12
    buf[2:14] = serial_b
    # bytes 14..33 → live snapshot (20 bytes); leave zeroed
    model_b = model_ascii.encode("ascii").ljust(10, b" ")
    buf[34:44] = model_b[:10]
    # bytes 44..51 → build/version (8 bytes); leave zeroed
    fw_main_b = fw_main.encode("ascii").ljust(9, b" ")
    buf[70:79] = fw_main_b[:9]
    fw_aux_b = fw_aux.encode("ascii").ljust(9, b" ")
    buf[86:95] = fw_aux_b[:9]
    return bytes(buf)

FC11_PAYLOAD_109_SLAVE2 = _build_fc11_payload(
    "400152A17R52", "AAV1003BA", "AAS1091AA", "AAS1092_F"
)
assert len(FC11_PAYLOAD_109_SLAVE2) == 102

# ──────────────────────────────────────────────────────────────────────────────
# build_fc71_peek_pdu
# ──────────────────────────────────────────────────────────────────────────────
class BuildFc71PeekPduTests(unittest.TestCase):

    def test_node1_addr_x25_words(self):
        """Frame for Node 1 StopReason peek: addr=0xFEB5, count=25."""
        pdu = build_fc71_peek_pdu(0xFEB5, 25)
        self.assertEqual(pdu, bytes([0xFE, 0xB5, 0x80, 25, 0, 0, 0, 0]))
        self.assertEqual(len(pdu), 8)

    def test_arrayhist_addr_x31_words(self):
        """Frame for ARRAYHISTMOTPARO: addr=0xFE09, count=31."""
        pdu = build_fc71_peek_pdu(0xFE09, 31)
        self.assertEqual(pdu, bytes([0xFE, 0x09, 0x80, 31, 0, 0, 0, 0]))

    def test_node_address_formula(self):
        """Per-node address formula: 0xFEB5 + (N-1) * 0x19."""
        node1, node2, node3 = 0xFEB5, 0xFECE, 0xFEE7
        for addr in (node1, node2, node3):
            pdu = build_fc71_peek_pdu(addr, 25)
            echo = (pdu[0] << 8) | pdu[1]
            self.assertEqual(echo, addr)

    def test_addr_range_rejected(self):
        with self.assertRaises(VendorPduError):
            build_fc71_peek_pdu(-1, 25)
        with self.assertRaises(VendorPduError):
            build_fc71_peek_pdu(0x10000, 25)

    def test_count_range_rejected(self):
        with self.assertRaises(VendorPduError):
            build_fc71_peek_pdu(0xFEB5, 0)
        with self.assertRaises(VendorPduError):
            build_fc71_peek_pdu(0xFEB5, 0x80)

# ──────────────────────────────────────────────────────────────────────────────
# parse_fc71_response_pdu
# ──────────────────────────────────────────────────────────────────────────────
class ParseFc71ResponsePduTests(unittest.TestCase):

    def test_parses_stop_reason_payload(self):
        body = _make_fc71_response_body(0xFEB5, STOP_REASON_50B_NODE1)
        data = parse_fc71_response_pdu(body, 0xFEB5)
        self.assertEqual(len(data), 50)
        # DebugDesc lives at byte offset 48 (UINT16 idx 24)
        debug_desc = struct.unpack(">H", data[48:50])[0]
        self.assertEqual(debug_desc, 20)
        # PotAC at idx 0 → 1073.3 kW
        pot_ac_raw = struct.unpack(">H", data[0:2])[0]
        self.assertEqual(pot_ac_raw, 10733)

    def test_parses_arrayhist_payload(self):
        body = _make_fc71_response_body(0xFE09, ARRAYHIST_62B)
        data = parse_fc71_response_pdu(body, 0xFE09)
        self.assertEqual(len(data), 62)
        total = struct.unpack(">H", data[60:62])[0]
        self.assertEqual(total, 62292)

    def test_addr_echo_mismatch_raises(self):
        body = _make_fc71_response_body(0xFEB5, STOP_REASON_50B_NODE1)
        with self.assertRaises(VendorPduError) as ctx:
            parse_fc71_response_pdu(body, 0xFECE)
        self.assertIn("addr echo mismatch", str(ctx.exception))

    def test_truncated_body_raises(self):
        body = _make_fc71_response_body(0xFEB5, STOP_REASON_50B_NODE1)
        with self.assertRaises(VendorPduError) as ctx:
            parse_fc71_response_pdu(body[:20], 0xFEB5)
        self.assertIn("truncated", str(ctx.exception))

    def test_too_short_raises(self):
        with self.assertRaises(VendorPduError):
            parse_fc71_response_pdu(b"\xFE", 0xFEB5)

# ──────────────────────────────────────────────────────────────────────────────
# parse_fc11_slave_id
# ──────────────────────────────────────────────────────────────────────────────
class ParseFc11SlaveIdTests(unittest.TestCase):

    def test_motorola_serial_extracted(self):
        info = parse_fc11_slave_id(FC11_PAYLOAD_109_SLAVE2)
        self.assertIsInstance(info, SlaveIdInfo)
        self.assertEqual(info.serial, "400152A17R52")
        self.assertEqual(info.serial_format, "motorola")
        self.assertEqual(info.model_code, "AAV1003BA")
        self.assertEqual(info.firmware_main, "AAS1091AA")
        self.assertEqual(info.firmware_aux, "AAS1092_F")
        self.assertEqual(len(info.live_snapshot_raw), 20)
        self.assertEqual(len(info.raw_payload), 102)

    def test_alternate_serial_eki_inverter23(self):
        """Inverter 23 (.133 via EKI) returns serial 400152A18R44."""
        payload = _build_fc11_payload(
            "400152A18R44", "AAV1003BA", "AAS1091AA", "AAS1092_F"
        )
        info = parse_fc11_slave_id(payload)
        self.assertEqual(info.serial, "400152A18R44")
        self.assertEqual(info.serial_format, "motorola")

    def test_short_payload_raises(self):
        with self.assertRaises(VendorPduError) as ctx:
            parse_fc11_slave_id(b"\x7d\xff" + b"\x00" * 50)
        self.assertIn("too short", str(ctx.exception))

    def test_non_printable_serial_marked_unknown(self):
        buf = bytearray(102)
        buf[0:2] = b"\x7d\xff"
        buf[2:14] = b"\x00\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0a\x0b"
        info = parse_fc11_slave_id(bytes(buf))
        self.assertEqual(info.serial_format, "unknown")

# ──────────────────────────────────────────────────────────────────────────────
# vendor_scope_peek — end-to-end with a mock socket
# ──────────────────────────────────────────────────────────────────────────────
class FakeSocket:
    """Minimal socket double — captures sends, replays a queued recv buffer."""

    def __init__(self, recv_buf: bytes):
        self._recv = recv_buf
        self.sent = b""
        self._timeout = None

    def settimeout(self, t):
        self._timeout = t

    def sendall(self, data):
        self.sent += data

    def recv(self, n):
        if not self._recv:
            return b""
        chunk, self._recv = self._recv[:n], self._recv[n:]
        return chunk

    def close(self):
        pass

def _build_full_response_for_scope(slave: int, addr: int, data: bytes) -> bytes:
    """The exact bytes a real inverter would put on the wire for an FC 0x71 reply.

    NOTE: _recv_exact() reads txn_id from the wire — but vendor_scope_peek()
    generates its own txn_id internally. We patch it via the socket buffer:
    we capture the request and echo its txn_id.
    """
    raise NotImplementedError("use _make_response_echoing_request instead")

def _make_response_echoing_request(req_bytes: bytes, addr: int, data: bytes) -> bytes:
    """Build an FC 0x71 response that echoes the request's txn_id."""
    txn_id = struct.unpack(">H", req_bytes[0:2])[0]
    slave = req_bytes[6]
    body = _make_fc71_response_body(addr, data)
    return _mbap_wrap(txn_id, slave, 0x71, body)

class VendorScopePeekIntegrationTests(unittest.TestCase):
    """Drives vendor_scope_peek() against a fake socket, asserting wire format."""

    def test_sends_correct_mbap_frame_and_returns_data(self):
        # Queue up a response that matches what we'll send. We don't know the
        # txn_id ahead of time, so we use a two-phase fake: capture the
        # request, build a reply, replay it.
        client = MagicMock()
        captured_req = bytearray()

        class TwoPhaseSock:
            def __init__(self):
                self._reply = b""
                self._timeout = None

            def settimeout(self, t):
                self._timeout = t

            def sendall(self, data):
                captured_req.extend(data)
                # Build the response now that we have the request's txn_id
                self._reply = _make_response_echoing_request(
                    bytes(captured_req), 0xFEB5, STOP_REASON_50B_NODE1
                )

            def recv(self, n):
                if not self._reply:
                    return b""
                chunk, self._reply = self._reply[:n], self._reply[n:]
                return chunk

            def close(self):
                pass

        client.socket = TwoPhaseSock()

        data = vendor_scope_peek(client, slave=2, addr=0xFEB5, count_words=25)

        # Verify request format: MBAP(7) + FC(1) + body(8) = 16 bytes
        self.assertEqual(len(captured_req), 16)
        self.assertEqual(captured_req[6], 2, "slave id should be 2")
        self.assertEqual(captured_req[7], 0x71, "FC should be 0x71")
        self.assertEqual(captured_req[8:10], b"\xFE\xB5", "addr echo 0xFEB5")
        self.assertEqual(captured_req[10], 0x80, "cmd byte")
        self.assertEqual(captured_req[11], 25, "count_words")

        # Verify response decode
        self.assertEqual(len(data), 50)
        self.assertEqual(struct.unpack(">H", data[48:50])[0], 20, "DebugDesc")

    def test_modbus_exception_response_raises(self):
        captured_req = bytearray()

        class ExcSock:
            def __init__(self):
                self._reply = b""

            def settimeout(self, t): pass

            def sendall(self, data):
                captured_req.extend(data)
                txn_id = struct.unpack(">H", bytes(data)[0:2])[0]
                # FC=0xF1 (0x71 | 0x80), exception code 0x04 SLAVE_FAILURE
                self._reply = _mbap_wrap(txn_id, 2, 0xF1, b"\x04")

            def recv(self, n):
                chunk, self._reply = self._reply[:n], self._reply[n:]
                return chunk

            def close(self): pass

        client = MagicMock()
        client.socket = ExcSock()

        with self.assertRaises(VendorPduError) as ctx:
            vendor_scope_peek(client, slave=2, addr=0xFEB5, count_words=25)
        self.assertIn("exception", str(ctx.exception).lower())

    def test_txn_id_mismatch_raises(self):
        class MismatchSock:
            def __init__(self):
                self._reply = b""

            def settimeout(self, t): pass

            def sendall(self, data):
                # Reply with a wildly different txn_id (0xDEAD)
                body = _make_fc71_response_body(0xFEB5, STOP_REASON_50B_NODE1)
                self._reply = _mbap_wrap(0xDEAD, 2, 0x71, body)

            def recv(self, n):
                chunk, self._reply = self._reply[:n], self._reply[n:]
                return chunk

            def close(self): pass

        client = MagicMock()
        client.socket = MismatchSock()

        with self.assertRaises(VendorPduError) as ctx:
            vendor_scope_peek(client, slave=2, addr=0xFEB5, count_words=25)
        self.assertIn("txn mismatch", str(ctx.exception).lower())

    def test_no_socket_raises(self):
        client = MagicMock()
        client.socket = None
        client.connect.return_value = None
        # After connect(), socket is still None → should raise
        with self.assertRaises(VendorPduError):
            vendor_scope_peek(client, slave=2, addr=0xFEB5, count_words=25)

# ──────────────────────────────────────────────────────────────────────────────
# read_slave_id — end-to-end FC11
# ──────────────────────────────────────────────────────────────────────────────
class ReadSlaveIdIntegrationTests(unittest.TestCase):

    def test_reads_motorola_serial(self):
        captured_req = bytearray()

        class Fc11Sock:
            def __init__(self):
                self._reply = b""

            def settimeout(self, t): pass

            def sendall(self, data):
                captured_req.extend(data)
                txn_id = struct.unpack(">H", bytes(data)[0:2])[0]
                slave = bytes(data)[6]
                # FC11 response body: [byte_count][payload]
                body = bytes([len(FC11_PAYLOAD_109_SLAVE2)]) + FC11_PAYLOAD_109_SLAVE2
                self._reply = _mbap_wrap(txn_id, slave, 0x11, body)

            def recv(self, n):
                chunk, self._reply = self._reply[:n], self._reply[n:]
                return chunk

            def close(self): pass

        client = MagicMock()
        client.socket = Fc11Sock()

        info = read_slave_id(client, slave=2)

        # Verify request: MBAP(7) + FC(1) = 8 bytes total
        self.assertEqual(len(captured_req), 8)
        self.assertEqual(captured_req[6], 2, "slave id")
        self.assertEqual(captured_req[7], 0x11, "FC11")

        # Verify response decode
        self.assertEqual(info.serial, "400152A17R52")
        self.assertEqual(info.model_code, "AAV1003BA")

    def test_fc11_exception_raises(self):
        class ExcSock:
            def __init__(self): self._reply = b""
            def settimeout(self, t): pass

            def sendall(self, data):
                txn_id = struct.unpack(">H", bytes(data)[0:2])[0]
                # FC=0x91 (0x11 | 0x80), exception code 0x01 ILLEGAL_FUNCTION
                self._reply = _mbap_wrap(txn_id, 2, 0x91, b"\x01")

            def recv(self, n):
                chunk, self._reply = self._reply[:n], self._reply[n:]
                return chunk

            def close(self): pass

        client = MagicMock()
        client.socket = ExcSock()

        with self.assertRaises(VendorPduError) as ctx:
            read_slave_id(client, slave=2)
        self.assertIn("exception", str(ctx.exception).lower())

if __name__ == "__main__":
    unittest.main()
