"""Slice C unit tests — services/serial_io.py.

Validates the wire-level decisions captured byte-for-byte from
frmSetSerial.SetMotorolaSerialNumber / SetTexasSerialNumber:

  • Format guards  (length, ASCII, printable)
  • Register packing (high-byte first, big-endian UINT16 pairs)
  • UNLOCK frame addr 0xFFFA values [0x0065, 0x07A7]
  • WRITE  frame addr 0x9C74 with 6 (Motorola) or 16 (TX) regs
  • VERIFY (readback under same lock, 1 s settle delay)

Pure stdlib; no pymodbus dependency, no socket I/O.
"""
from __future__ import annotations

import struct
import sys
import threading
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services.serial_io import (  # noqa: E402
    SERIAL_BYTE_LEN,
    SERIAL_REGISTER,
    SERIAL_REG_COUNT,
    UNLOCK_REGISTER,
    UNLOCK_VALUES,
    SerialFormatError,
    SerialIoError,
    info_to_dict,
    read_serial_with_lock,
    serial_to_registers,
    validate_serial_format,
    write_serial_with_lock,
)
from services.vendor_pdu import SlaveIdInfo  # noqa: E402

# ─── Fixtures (shared with test_vendor_pdu.py) ─────────────────────────────

MOTOROLA_SERIAL = "400152A17R52"  # .109 slave=2, captured 2026-04-27
EKI_MOTOROLA_SERIAL = "400152A18R44"  # .133 slave=4 EKI fallback

def _build_fc11_payload(serial_ascii: str, model_ascii: str = "AAV1003BA",
                         fw_main: str = "AAS1091AA",
                         fw_aux: str = "AAS1092_F") -> bytes:
    buf = bytearray(102)
    buf[0:2] = b"\x7d\xff"
    s = serial_ascii.encode("ascii")
    assert len(s) == 12
    buf[2:14] = s
    m = model_ascii.encode("ascii").ljust(10, b" ")
    buf[34:44] = m[:10]
    fwm = fw_main.encode("ascii").ljust(9, b" ")
    buf[70:79] = fwm[:9]
    fwa = fw_aux.encode("ascii").ljust(9, b" ")
    buf[86:95] = fwa[:9]
    return bytes(buf)

def _make_slave_id_info(serial: str = MOTOROLA_SERIAL) -> SlaveIdInfo:
    """Build a SlaveIdInfo without going through the byte-level parser."""
    payload = _build_fc11_payload(serial)
    return SlaveIdInfo(
        serial=serial,
        serial_format="motorola",
        model_code="AAV1003BA",
        firmware_main="AAS1091AA",
        firmware_aux="AAS1092_F",
        live_snapshot_raw=bytes(payload[14:34]),
        raw_payload=payload,
    )

# ──────────────────────────────────────────────────────────────────────────────
# validate_serial_format
# ──────────────────────────────────────────────────────────────────────────────
class ValidateSerialFormatTests(unittest.TestCase):

    def test_motorola_valid(self):
        validate_serial_format("400152A17R52", "motorola")

    def test_tx_valid(self):
        validate_serial_format("A" * 32, "tx")

    def test_motorola_too_short(self):
        with self.assertRaises(SerialFormatError) as ctx:
            validate_serial_format("SHORT", "motorola")
        self.assertIn("12 chars", str(ctx.exception))

    def test_tx_too_short(self):
        with self.assertRaises(SerialFormatError) as ctx:
            validate_serial_format("A" * 16, "tx")
        self.assertIn("32 chars", str(ctx.exception))

    def test_unknown_fmt(self):
        with self.assertRaises(SerialFormatError) as ctx:
            validate_serial_format("400152A17R52", "weird")
        self.assertIn("unknown fmt", str(ctx.exception))

    def test_non_ascii_rejected(self):
        # 12 chars but contains a non-ASCII char
        with self.assertRaises(SerialFormatError) as ctx:
            validate_serial_format("400152A17R5é", "motorola")
        self.assertIn("ASCII", str(ctx.exception))

    def test_non_printable_rejected(self):
        with self.assertRaises(SerialFormatError) as ctx:
            validate_serial_format("400152A17R5\x01", "motorola")
        self.assertIn("non-printable", str(ctx.exception))

    def test_non_string_rejected(self):
        with self.assertRaises(SerialFormatError):
            validate_serial_format(12345, "motorola")  # type: ignore[arg-type]

# ──────────────────────────────────────────────────────────────────────────────
# serial_to_registers — wire-level packing
# ──────────────────────────────────────────────────────────────────────────────
class SerialToRegistersTests(unittest.TestCase):

    def test_motorola_packing(self):
        regs = serial_to_registers("400152A17R52", "motorola")
        self.assertEqual(len(regs), 6)
        # '4' = 0x34, '0' = 0x30 → high byte / low byte of first reg
        self.assertEqual(regs[0], (0x34 << 8) | 0x30)
        self.assertEqual(regs[1], (0x30 << 8) | 0x31)
        self.assertEqual(regs[2], (0x35 << 8) | 0x32)
        self.assertEqual(regs[3], (0x41 << 8) | 0x31)
        self.assertEqual(regs[4], (0x37 << 8) | 0x52)
        self.assertEqual(regs[5], (0x35 << 8) | 0x32)

    def test_tx_packing_length(self):
        regs = serial_to_registers("Z" * 32, "tx")
        self.assertEqual(len(regs), 16)
        self.assertEqual(regs[0], (0x5A << 8) | 0x5A)

    def test_packing_round_trip(self):
        """Bytes packed into regs should round-trip to the original ASCII."""
        regs = serial_to_registers("400152A17R52", "motorola")
        recovered = b"".join(struct.pack(">H", r) for r in regs)
        self.assertEqual(recovered.decode("ascii"), "400152A17R52")

    def test_packing_validates_format(self):
        with self.assertRaises(SerialFormatError):
            serial_to_registers("SHORT", "motorola")

# ──────────────────────────────────────────────────────────────────────────────
# Wire constants — regression guard
# ──────────────────────────────────────────────────────────────────────────────
class WireConstantsTests(unittest.TestCase):

    def test_unlock_register(self):
        self.assertEqual(UNLOCK_REGISTER, 0xFFFA)
        self.assertEqual(UNLOCK_VALUES, (0x0065, 0x07A7))

    def test_serial_register(self):
        self.assertEqual(SERIAL_REGISTER, 0x9C74)

    def test_byte_lengths(self):
        self.assertEqual(SERIAL_BYTE_LEN["motorola"], 12)
        self.assertEqual(SERIAL_BYTE_LEN["tx"], 32)

    def test_register_counts(self):
        self.assertEqual(SERIAL_REG_COUNT["motorola"], 6)
        self.assertEqual(SERIAL_REG_COUNT["tx"], 16)

# ──────────────────────────────────────────────────────────────────────────────
# read_serial_with_lock — full lock-held FC11 read
# ──────────────────────────────────────────────────────────────────────────────
class ReadSerialWithLockTests(unittest.TestCase):

    def _make_client_returning(self, payload: bytes):
        """Mock client whose .socket round-trips an FC11 reply with `payload`."""
        captured = []

        class Sock:
            def __init__(self):
                self._reply = b""

            def settimeout(self, t):
                pass

            def sendall(self, data):
                captured.append(bytes(data))
                txn = struct.unpack(">H", bytes(data)[0:2])[0]
                slave = bytes(data)[6]
                # FC11 response body: [byte_count][payload]
                body = bytes([len(payload)]) + payload
                pdu = bytes([0x11]) + body
                length = 1 + len(pdu)
                self._reply = struct.pack(">HHHB", txn, 0, length, slave) + pdu

            def recv(self, n):
                chunk, self._reply = self._reply[:n], self._reply[n:]
                return chunk

            def close(self):
                pass

        client = MagicMock()
        client.socket = Sock()
        return client, captured

    def test_motorola_serial_read(self):
        payload = _build_fc11_payload(MOTOROLA_SERIAL)
        client, _ = self._make_client_returning(payload)
        lock = threading.Lock()
        out = read_serial_with_lock(client, lock, slave=2)
        self.assertTrue(out["ok"])
        self.assertEqual(out["serial"], MOTOROLA_SERIAL)
        self.assertEqual(out["serial_format"], "motorola")
        self.assertEqual(out["model_code"], "AAV1003BA")
        self.assertIsNone(out["format_warning"])
        # Lock released after call
        self.assertTrue(lock.acquire(blocking=False))
        lock.release()

    def test_eki_inverter_serial_read(self):
        payload = _build_fc11_payload(EKI_MOTOROLA_SERIAL)
        client, _ = self._make_client_returning(payload)
        out = read_serial_with_lock(client, threading.Lock(), slave=4)
        self.assertTrue(out["ok"])
        self.assertEqual(out["serial"], EKI_MOTOROLA_SERIAL)

    def test_format_mismatch_warns_but_returns_ok(self):
        payload = _build_fc11_payload(MOTOROLA_SERIAL)
        client, _ = self._make_client_returning(payload)
        out = read_serial_with_lock(
            client, threading.Lock(), slave=2, expected_fmt="tx",
        )
        self.assertTrue(out["ok"])
        self.assertIsNotNone(out["format_warning"])
        self.assertIn("motorola", out["format_warning"])
        self.assertIn("tx", out["format_warning"])

    def test_modbus_exception_returns_error(self):
        captured = []

        class ExcSock:
            def __init__(self): self._reply = b""

            def settimeout(self, t): pass

            def sendall(self, data):
                captured.append(bytes(data))
                txn = struct.unpack(">H", bytes(data)[0:2])[0]
                # FC=0x91 (0x11 | 0x80), exception 0x02 ILLEGAL_ADDR
                body = struct.pack(">HHHB", txn, 0, 3, 2) + b"\x91\x02"
                self._reply = body

            def recv(self, n):
                chunk, self._reply = self._reply[:n], self._reply[n:]
                return chunk

            def close(self): pass

        client = MagicMock()
        client.socket = ExcSock()
        out = read_serial_with_lock(client, threading.Lock(), slave=2)
        self.assertFalse(out["ok"])
        self.assertIn("exception", out["error"].lower())

# ──────────────────────────────────────────────────────────────────────────────
# write_serial_with_lock — UNLOCK + WRITE + VERIFY pipeline
# ──────────────────────────────────────────────────────────────────────────────
class FakeWriteRegistersResponse:
    def __init__(self, error=False):
        self._error = error

    def isError(self):
        return self._error

class WriteSerialWithLockTests(unittest.TestCase):

    def _make_client(self, *, write_returns_error=False, write_raises=None,
                      readback_serial=MOTOROLA_SERIAL):
        """Build a client whose write_registers + read_slave_id are scriptable."""
        client = MagicMock()
        write_calls = []

        def write_regs(address=None, values=None, unit=None, **kw):
            write_calls.append({
                "address": address,
                "values": list(values) if values is not None else None,
                "unit": unit,
            })
            if write_raises:
                raise write_raises
            return FakeWriteRegistersResponse(error=write_returns_error)

        client.write_registers = MagicMock(side_effect=write_regs)
        client.write_calls = write_calls

        # Stub read_slave_id by attaching a socket that returns the readback
        # payload — the real read_slave_id() in vendor_pdu reads from
        # client.socket so we wire that up.
        readback_payload = _build_fc11_payload(readback_serial)

        class Sock:
            def __init__(self):
                self._reply = b""

            def settimeout(self, t):
                pass

            def sendall(self, data):
                txn = struct.unpack(">H", bytes(data)[0:2])[0]
                slave = bytes(data)[6]
                body = bytes([len(readback_payload)]) + readback_payload
                pdu = bytes([0x11]) + body
                length = 1 + len(pdu)
                self._reply = struct.pack(">HHHB", txn, 0, length, slave) + pdu

            def recv(self, n):
                chunk, self._reply = self._reply[:n], self._reply[n:]
                return chunk

            def close(self):
                pass

        client.socket = Sock()
        return client

    def test_success_path_motorola(self):
        client = self._make_client(readback_serial=MOTOROLA_SERIAL)
        out = write_serial_with_lock(
            client, threading.Lock(), slave=2,
            new_serial=MOTOROLA_SERIAL, fmt="motorola",
            verify_delay_s=0.0,    # don't actually sleep in tests
        )
        self.assertEqual(out["status"], "success")
        self.assertTrue(out["unlock_done"])
        self.assertTrue(out["write_done"])
        self.assertTrue(out["verify_passed"])
        self.assertEqual(out["readback"], MOTOROLA_SERIAL)

        # Two write_registers calls: unlock then write
        self.assertEqual(len(client.write_calls), 2)
        unlock_call = client.write_calls[0]
        self.assertEqual(unlock_call["address"], 0xFFFA)
        self.assertEqual(unlock_call["values"], [0x0065, 0x07A7])
        self.assertEqual(unlock_call["unit"], 2)
        write_call = client.write_calls[1]
        self.assertEqual(write_call["address"], 0x9C74)
        self.assertEqual(len(write_call["values"]), 6)

    def test_format_error_short_circuits_no_modbus_calls(self):
        client = self._make_client()
        out = write_serial_with_lock(
            client, threading.Lock(), slave=2,
            new_serial="SHORT", fmt="motorola", verify_delay_s=0.0,
        )
        self.assertEqual(out["status"], "format_error")
        self.assertFalse(out["unlock_done"])
        self.assertFalse(out["write_done"])
        # Crucially: no Modbus traffic was sent before failing the format gate
        self.assertEqual(len(client.write_calls), 0)

    def test_unlock_failure_short_circuits_write(self):
        client = self._make_client(write_returns_error=True)
        out = write_serial_with_lock(
            client, threading.Lock(), slave=2,
            new_serial=MOTOROLA_SERIAL, fmt="motorola", verify_delay_s=0.0,
        )
        self.assertEqual(out["status"], "unlock_failed")
        self.assertFalse(out["unlock_done"])
        self.assertFalse(out["write_done"])
        # Only the unlock attempt happened, no write was issued
        self.assertEqual(len(client.write_calls), 1)
        self.assertIn("unlock_modbus_error", out["error"])

    def test_unlock_exception_short_circuits_write(self):
        client = self._make_client(write_raises=ConnectionResetError("peer closed"))
        out = write_serial_with_lock(
            client, threading.Lock(), slave=2,
            new_serial=MOTOROLA_SERIAL, fmt="motorola", verify_delay_s=0.0,
        )
        self.assertEqual(out["status"], "unlock_failed")
        self.assertIn("unlock_exception", out["error"])
        self.assertIn("peer closed", out["error"])

    def test_verify_mismatch_returns_verify_failed(self):
        # Inverter accepts the writes but readback returns the OLD serial
        client = self._make_client(readback_serial=MOTOROLA_SERIAL)
        out = write_serial_with_lock(
            client, threading.Lock(), slave=2,
            new_serial="400152A18R44", fmt="motorola",  # different serial
            verify_delay_s=0.0,
        )
        self.assertEqual(out["status"], "verify_failed")
        self.assertTrue(out["unlock_done"])
        self.assertTrue(out["write_done"])
        self.assertFalse(out["verify_passed"])
        self.assertEqual(out["readback"], MOTOROLA_SERIAL)
        self.assertIn("readback mismatch", out["error"])
        self.assertIn(MOTOROLA_SERIAL, out["error"])

    def test_unknown_fmt_caught_by_format_gate(self):
        client = self._make_client()
        out = write_serial_with_lock(
            client, threading.Lock(), slave=2,
            new_serial="A" * 12, fmt="rocket", verify_delay_s=0.0,
        )
        self.assertEqual(out["status"], "format_error")
        self.assertEqual(len(client.write_calls), 0)

    # ── Lost-write-ACK handling (operator-confirmed 2026-05-19) ────────────
    # The inverter applies the serial write but its Modbus stack re-inits,
    # so the FC16 *response* is dropped. The read-back is authoritative:
    # a lost ACK with a confirming read-back is SUCCESS, never write_failed.

    def _make_client_unlock_ok_write_fails(self, *, readback_serial,
                                           readback_raises=False):
        """Unlock (write-call #1) OK; serial write (#2) raises a
        no-response error; FC11 read-back returns `readback_serial`
        (or raises if `readback_raises`)."""
        client = MagicMock()
        write_calls = []

        def write_regs(address=None, values=None, unit=None, **kw):
            write_calls.append({"address": address, "unit": unit})
            if len(write_calls) == 1:
                return FakeWriteRegistersResponse(error=False)  # unlock OK
            raise OSError(
                "Modbus Error: [Invalid Message] No response received, "
                "expected at least 8 bytes (0 received)"
            )

        client.write_registers = MagicMock(side_effect=write_regs)
        client.write_calls = write_calls
        payload = _build_fc11_payload(readback_serial)

        class Sock:
            def __init__(self):
                self._reply = b""

            def settimeout(self, t):
                pass

            def sendall(self, data):
                if readback_raises:
                    raise OSError("read-back unreachable")
                txn = struct.unpack(">H", bytes(data)[0:2])[0]
                slave = bytes(data)[6]
                pdu = bytes([0x11]) + bytes([len(payload)]) + payload
                self._reply = struct.pack(
                    ">HHHB", txn, 0, 1 + len(pdu), slave) + pdu

            def recv(self, n):
                chunk, self._reply = self._reply[:n], self._reply[n:]
                return chunk

            def close(self):
                pass

        client.socket = Sock()
        return client

    def _fast_verify(self):
        """Patch the verify settle/backoff to 0 so tests don't sleep."""
        import services.serial_io as sio
        return patch.multiple(
            sio, WRITE_ACK_LOST_SETTLE_S=0.0, VERIFY_READ_BACKOFF_S=0.0,
        )

    def test_write_ack_lost_but_readback_confirms_is_success(self):
        client = self._make_client_unlock_ok_write_fails(
            readback_serial="400152A18R44")
        with self._fast_verify():
            out = write_serial_with_lock(
                client, threading.Lock(), slave=2,
                new_serial="400152A18R44", fmt="motorola", verify_delay_s=0.0,
            )
        self.assertEqual(out["status"], "success")
        self.assertTrue(out["verify_passed"])
        self.assertTrue(out["write_done"])
        self.assertTrue(out.get("write_ack_lost"))
        self.assertEqual(out["readback"], "400152A18R44")
        self.assertIn("read-back confirms", out["error"])

    def test_write_failed_when_readback_still_old(self):
        client = self._make_client_unlock_ok_write_fails(
            readback_serial=MOTOROLA_SERIAL)  # serial did NOT change
        with self._fast_verify():
            out = write_serial_with_lock(
                client, threading.Lock(), slave=2,
                new_serial="400152A18R44", fmt="motorola", verify_delay_s=0.0,
            )
        self.assertEqual(out["status"], "write_failed")
        self.assertFalse(out["verify_passed"])
        self.assertEqual(out["readback"], MOTOROLA_SERIAL)
        self.assertIn("readback mismatch", out["error"])

    def test_write_unconfirmed_when_readback_unavailable(self):
        client = self._make_client_unlock_ok_write_fails(
            readback_serial=MOTOROLA_SERIAL, readback_raises=True)
        with self._fast_verify():
            out = write_serial_with_lock(
                client, threading.Lock(), slave=2,
                new_serial="400152A18R44", fmt="motorola", verify_delay_s=0.0,
            )
        self.assertEqual(out["status"], "write_unconfirmed")
        self.assertFalse(out["verify_passed"])
        self.assertIsNone(out["readback"])
        self.assertIn("rescan", out["error"])

# ──────────────────────────────────────────────────────────────────────────────
# info_to_dict — HTTP serialization
# ──────────────────────────────────────────────────────────────────────────────
class InfoToDictTests(unittest.TestCase):

    def test_round_trip(self):
        info = _make_slave_id_info(MOTOROLA_SERIAL)
        d = info_to_dict(info)
        self.assertEqual(d["serial"], MOTOROLA_SERIAL)
        self.assertEqual(d["serial_format"], "motorola")
        self.assertEqual(d["model_code"], "AAV1003BA")
        # Hex strings round-trip the raw bytes
        self.assertEqual(bytes.fromhex(d["live_snapshot_hex"]), info.live_snapshot_raw)
        self.assertEqual(bytes.fromhex(d["raw_payload_hex"]), info.raw_payload)
        self.assertEqual(len(d["raw_payload_hex"]), 102 * 2)

if __name__ == "__main__":
    unittest.main()
