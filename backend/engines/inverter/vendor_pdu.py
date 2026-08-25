"""Vendor Modbus PDU helpers — FC 0x71 SCOPE memory peek + FC11 Report Slave ID.

Implements INGECON's vendor SCOPE protocol on top of the existing pymodbus
2.5.3 sync TCP client used by inverter_engine.py. Validated 2026-04-27
against both a working-comm-board inverter and an EKI-1222-BE fallback
inverter — same wire format works fleet-wide via port 502 + MBAP framing.

The vendor FC 0x71 PDU body (after the FC byte):
    [addr_hi][addr_lo][cmd=0x80][count_words][pad × 4]   →  request
    [addr_hi][addr_lo][bc_words][data × bc_words×2]      →  response

FC11 (Report Slave ID) is standard Modbus; INGECON's response carries a
102-byte slave-ID payload with serial + model + firmware + live snapshot.
See `parse_fc11_slave_id()` for the byte layout (verified against two
physical inverters).

Hardware reference: `_spike/eki_scope_probe.py` is the canonical wire
format reference; this module ports that pattern into production.
"""
from __future__ import annotations

import struct
import threading
from dataclasses import dataclass
from typing import Optional

# ─── FC 0x71 SCOPE memory peek ─────────────────────────────────────────────

class VendorPduError(Exception):
    """Raised when a vendor PDU exchange fails (transport, framing, or CRC)."""

def build_fc71_peek_pdu(addr: int, count_words: int) -> bytes:
    """Build the 9-byte FC 0x71 PDU body (FC byte excluded — pymodbus prepends).

    Frame on the wire (after slave + FC=0x71 from pymodbus):
        [addr_hi][addr_lo][0x80][count_words][0x00 × 4]
    """
    if not (0 <= addr <= 0xFFFF):
        raise VendorPduError(f"addr out of range (0..0xFFFF): 0x{addr:X}")
    if not (1 <= count_words <= 0x7F):
        raise VendorPduError(f"count_words out of range (1..127): {count_words}")
    return bytes([
        (addr >> 8) & 0xFF,
        addr & 0xFF,
        0x80,
        count_words & 0xFF,
        0x00, 0x00, 0x00, 0x00,
    ])

def parse_fc71_response_pdu(pdu_after_fc: bytes, expected_addr: int) -> bytes:
    """Parse the FC 0x71 response payload (FC byte already stripped by framer).

    Layout: [addr_hi][addr_lo][bc_words][data × bc_words×2]
    Returns the raw data bytes (count_words × 2).
    """
    if len(pdu_after_fc) < 3:
        raise VendorPduError(f"FC 0x71 response too short: {len(pdu_after_fc)} bytes")
    addr = (pdu_after_fc[0] << 8) | pdu_after_fc[1]
    if addr != expected_addr:
        raise VendorPduError(
            f"FC 0x71 addr echo mismatch: got 0x{addr:04X}, expected 0x{expected_addr:04X}"
        )
    bc_words = pdu_after_fc[2]
    expected_data_bytes = bc_words * 2
    if len(pdu_after_fc) < 3 + expected_data_bytes:
        raise VendorPduError(
            f"FC 0x71 response truncated: bc_words={bc_words} need "
            f"{3 + expected_data_bytes} got {len(pdu_after_fc)}"
        )
    return bytes(pdu_after_fc[3:3 + expected_data_bytes])

def vendor_scope_peek(
    client,
    slave: int,
    addr: int,
    count_words: int,
    timeout_s: float = 3.0,
) -> bytes:
    """Issue an FC 0x71 SCOPE peek via the existing pymodbus sync client.

    Uses raw socket send/recv on the client's underlying socket — pymodbus
    2.x doesn't have first-class custom-FC support, but the client's
    socket is a regular TCP socket once `connect()` has happened. We
    build the MBAP-wrapped frame directly and parse the response.

    Returns the raw data payload (count_words × 2 bytes).
    Raises VendorPduError on framing/transport failure.
    """
    import socket as _socket

    # Lazy-connect if needed
    if not getattr(client, "socket", None):
        try:
            client.connect()
        except Exception as e:
            raise VendorPduError(f"connect failed: {e}") from e

    sock = client.socket
    if sock is None:
        raise VendorPduError("client has no socket after connect")

    # Build MBAP-wrapped frame
    pdu_body = build_fc71_peek_pdu(addr, count_words)
    full_pdu = bytes([0x71]) + pdu_body  # FC + body
    mbap_length = 1 + len(full_pdu)  # unit_id + PDU
    txn_id = _next_txn_id()
    mbap = struct.pack(">HHHB", txn_id, 0x0000, mbap_length, slave & 0xFF)
    frame = mbap + full_pdu

    # Send
    try:
        sock.settimeout(timeout_s)
        sock.sendall(frame)
    except (_socket.error, OSError) as e:
        _force_reconnect(client)
        raise VendorPduError(f"send failed: {e}") from e

    # Receive — read MBAP header first (7 bytes), then the declared length
    try:
        hdr = _recv_exact(sock, 7, timeout_s)
        resp_txn, resp_proto, resp_len, resp_unit = struct.unpack(">HHHB", hdr)
        if resp_txn != txn_id:
            raise VendorPduError(
                f"MBAP txn mismatch: got 0x{resp_txn:04X}, expected 0x{txn_id:04X}"
            )
        if resp_proto != 0x0000:
            raise VendorPduError(f"MBAP proto != 0: 0x{resp_proto:04X}")
        body = _recv_exact(sock, resp_len - 1, timeout_s)  # -1 because unit_id already in hdr
    except (_socket.error, OSError) as e:
        _force_reconnect(client)
        raise VendorPduError(f"recv failed: {e}") from e

    if len(body) < 1:
        raise VendorPduError("empty response body")
    fc = body[0]
    if fc & 0x80:
        # Modbus exception
        exc_code = body[1] if len(body) >= 2 else 0
        raise VendorPduError(
            f"FC 0x71 returned exception: FC=0x{fc:02X} code=0x{exc_code:02X}"
        )
    if fc != 0x71:
        raise VendorPduError(f"FC echo mismatch: got 0x{fc:02X}, expected 0x71")
    return parse_fc71_response_pdu(body[1:], addr)

# ─── FC11 Report Slave ID ──────────────────────────────────────────────────

@dataclass(frozen=True)
class SlaveIdInfo:
    """Parsed FC11 Report Slave ID payload (Motorola format).

    Layout verified against two physical inverters on 2026-04-27:
      [0..1]    header bytes (0x7D 0xFF)
      [2..13]   ASCII serial (12 bytes Motorola — e.g. "400152A17R52")
      [14..33]  20 bytes live snapshot (PotAC, Vac, Iac, Frec, Cos)
      [34..43]  10 bytes ASCII model code (e.g. "AAV1003BA ")
      [44..51]  8 bytes build/version
      [70..78]  9 bytes ASCII firmware module 1
      [86..94]  9 bytes ASCII firmware module 2
    """
    serial: str
    serial_format: str          # "motorola" or "tx" or "unknown"
    model_code: str
    firmware_main: str
    firmware_aux: str
    live_snapshot_raw: bytes    # 20 bytes raw
    raw_payload: bytes          # full 102-byte payload for forensics

def parse_fc11_slave_id(raw_payload: bytes) -> SlaveIdInfo:
    """Parse the slave-ID payload returned by FC11.

    raw_payload is the data after the byte_count field — typically 102 bytes
    for INGECON Motorola firmware.
    """
    if len(raw_payload) < 95:
        raise VendorPduError(f"slave-ID payload too short: {len(raw_payload)}b (need ≥95)")

    # Bytes 2..13 are the ASCII serial (12 chars for Motorola)
    serial_raw = raw_payload[2:14]
    serial = serial_raw.decode("ascii", errors="replace").rstrip("\x00 ")

    # Heuristic format detection: if the 12-byte serial decodes cleanly to
    # printable ASCII without trailing nulls, it's Motorola. TI variants
    # carry 32-byte serials and would have additional ASCII at offset 14+.
    is_printable = all(32 <= b < 127 for b in serial_raw)
    serial_format = "motorola" if is_printable else "unknown"

    return SlaveIdInfo(
        serial=serial,
        serial_format=serial_format,
        model_code=raw_payload[34:44].decode("ascii", errors="replace").rstrip("\x00 "),
        firmware_main=raw_payload[70:79].decode("ascii", errors="replace").rstrip("\x00 "),
        firmware_aux=raw_payload[86:95].decode("ascii", errors="replace").rstrip("\x00 "),
        live_snapshot_raw=bytes(raw_payload[14:34]),
        raw_payload=bytes(raw_payload),
    )

def read_slave_id(client, slave: int, timeout_s: float = 3.0) -> SlaveIdInfo:
    """Issue FC11 Report Slave ID and parse the result.

    Falls back to raw socket send if pymodbus 2.x doesn't expose FC11
    cleanly — INGECON's vendor extension carries 102 bytes vs the
    standard's "byte count + slave id + run/stop indicator" minimal form.
    """
    import socket as _socket

    if not getattr(client, "socket", None):
        try:
            client.connect()
        except Exception as e:
            raise VendorPduError(f"connect failed: {e}") from e

    sock = client.socket
    if sock is None:
        raise VendorPduError("client has no socket after connect")

    # Build MBAP-wrapped FC11 frame (PDU = single 0x11 byte, no body)
    txn_id = _next_txn_id()
    mbap = struct.pack(">HHHB", txn_id, 0x0000, 2, slave & 0xFF)  # length=2 (unit_id + FC)
    frame = mbap + bytes([0x11])

    try:
        sock.settimeout(timeout_s)
        sock.sendall(frame)
        hdr = _recv_exact(sock, 7, timeout_s)
        resp_txn, resp_proto, resp_len, resp_unit = struct.unpack(">HHHB", hdr)
        if resp_txn != txn_id:
            raise VendorPduError(
                f"MBAP txn mismatch: got 0x{resp_txn:04X}, expected 0x{txn_id:04X}"
            )
        body = _recv_exact(sock, resp_len - 1, timeout_s)
    except (_socket.error, OSError) as e:
        _force_reconnect(client)
        raise VendorPduError(f"recv failed: {e}") from e

    if len(body) < 2:
        raise VendorPduError(f"FC11 response too short: {len(body)}b")
    fc = body[0]
    if fc & 0x80:
        exc_code = body[1] if len(body) >= 2 else 0
        raise VendorPduError(f"FC11 exception: FC=0x{fc:02X} code=0x{exc_code:02X}")
    if fc != 0x11:
        raise VendorPduError(f"FC11 echo mismatch: got 0x{fc:02X}")

    byte_count = body[1]
    if len(body) < 2 + byte_count:
        raise VendorPduError(
            f"FC11 truncated: byte_count={byte_count} need {2 + byte_count} got {len(body)}"
        )
    payload = body[2:2 + byte_count]
    return parse_fc11_slave_id(payload)

# ─── Internals ─────────────────────────────────────────────────────────────

_TXN_ID_COUNTER = [0]
_TXN_ID_LOCK = threading.Lock()

def _next_txn_id() -> int:
    # PY-C-001 — protect the increment so concurrent vendor_scope_peek /
    # read_slave_id callers from different IP threads cannot race and emit
    # the same transaction id (which would let MBAP responses cross-match).
    with _TXN_ID_LOCK:
        _TXN_ID_COUNTER[0] = (_TXN_ID_COUNTER[0] + 1) & 0xFFFF
        val = _TXN_ID_COUNTER[0] or 1
    return val

def _recv_exact(sock, n: int, timeout_s: float) -> bytes:
    """Receive exactly n bytes or raise. Sock must already have timeout set."""
    import time as _time
    buf = b""
    deadline = _time.monotonic() + timeout_s
    while len(buf) < n:
        remaining = deadline - _time.monotonic()
        if remaining <= 0:
            raise OSError(f"recv_exact timeout: got {len(buf)}/{n} bytes")
        sock.settimeout(remaining)
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise OSError(f"recv_exact: peer closed after {len(buf)}/{n} bytes")
        buf += chunk
    return buf

def _force_reconnect(client) -> None:
    """Close the underlying socket so the next call forces a clean reconnect.
    Mirrors the T3.7 fix in drivers/modbus_tcp.py."""
    try:
        client.close()
    except Exception:
        pass
