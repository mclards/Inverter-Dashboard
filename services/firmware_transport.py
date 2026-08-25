"""Phase 2 — GATED live firmware transport + safety orchestrator.

EXPERIMENTAL. This is the only module in the feature that can put real
bytes on the wire to an inverter. It exists so the irreversible operation
is funnelled through ONE choke point where every safety gate from the
2026-05-18 security review is enforced *before* a socket is touched.

Nothing here runs unless an operator explicitly drives Phase 3 with
mode="live" AND every gate passes. Default everywhere is dry-run. A live
flash additionally requires: a prior SUCCESSFUL dry-run of the same image,
explicit irreversible-acknowledgement, a TCP host (serial rejected),
single non-broadcast node, a verified file (path/size/.S/filename + SHA256
allowlist), an FC11 model/version compatibility check (downgrade blocked
unless forced), a caller-supplied RS-485 poller-lockout context manager, a
caller-supplied audit sink, and a watchdog deadline.

Transport framing mirrors the proven `services/vendor_pdu.py` pattern
(raw MBAP over port 502 — works fleet-wide through the transparent
TCP→RTU gateway; see audits/2026-05-18/ism-per-node-firmware-upgrade.md
and memory/inverter_comm_board_architecture.md).
"""
from __future__ import annotations

import hashlib
import os
import re
import struct
import threading
import time
from contextlib import AbstractContextManager
from typing import Callable, Optional

from services import firmware_loader as fw
from services.firmware_loader import (FirmwareError, FirmwareImage,
                                      FlashResult, TransportError)

# Re-exported for callers/tests.
__all__ = [
    "FlashGateError", "ModbusVendorTcpTransport", "ModbusVendorRtuTransport",
    "verify_firmware_file", "verify_inverter_compatible",
    "flash_inverter_node",
]

_MBAP_PROTO = 0x0000
_MODBUS_TCP_PORT = 502
_FILENAME_RE = re.compile(r"^[A-Za-z]{3}\d{4}")   # ISM "LLLnnnn..." rule

_TXN_LOCK = threading.Lock()
_TXN = [0]

def _next_txn() -> int:
    with _TXN_LOCK:
        _TXN[0] = (_TXN[0] + 1) & 0xFFFF
        return _TXN[0]

class FlashGateError(FirmwareError):
    """A required safety gate failed. Raised BEFORE any wire I/O — a live
    flash never starts unless every gate passes."""

# ─── Live transport (implements firmware_loader.Transport) ─────────────────

class ModbusVendorTcpTransport:
    """Raw MBAP transport for vendor firmware frames over Modbus-TCP.

    A firmware frame is `[node, func, …payload…, xor]`. On the wire the
    node becomes the MBAP unit-id and the PDU is `frame[1:]`; the
    transparent gateway rebuilds the RTU `[node, …]` the DSP expects (same
    contract proven for FC 0x71 / FC11 in vendor_pdu.py). The response's
    unit-id is re-prepended so `flash_node` sees `[node, func, status, …]`.

    TCP ONLY by construction — there is no serial path here, which is the
    security review's "no 0x96 baud-switch race" requirement.
    """

    def __init__(self, host: str, *, port: int = _MODBUS_TCP_PORT,
                 connect_timeout_s: float = 5.0):
        if not isinstance(host, str) or not host.strip():
            raise FlashGateError("live transport requires a TCP host string")
        self._host = host.strip()
        self._port = int(port)
        self._connect_timeout = connect_timeout_s
        self._sock = None
        self._socket_factory = None  # test seam; None ⇒ real socket

    # -- connection -------------------------------------------------------
    def connect(self) -> None:
        if self._sock is not None:
            return
        if self._socket_factory is not None:
            self._sock = self._socket_factory(self._host, self._port,
                                              self._connect_timeout)
            return
        import socket as _socket
        try:
            self._sock = _socket.create_connection(
                (self._host, self._port), timeout=self._connect_timeout)
        except OSError as e:
            raise TransportError(f"connect {self._host}:{self._port}: {e}") from e

    def close(self) -> None:
        if self._sock is not None:
            try:
                self._sock.close()
            except OSError:
                pass
            self._sock = None

    def __enter__(self):
        self.connect()
        return self

    def __exit__(self, *exc):
        self.close()
        return False

    def _recv_exact(self, n: int, timeout_s: float) -> bytes:
        buf = b""
        self._sock.settimeout(timeout_s)
        while len(buf) < n:
            try:
                chunk = self._sock.recv(n - len(buf))
            except OSError as e:
                raise TransportError(f"recv: {e}") from e
            if not chunk:
                raise TransportError("peer closed during firmware exchange")
            buf += chunk
        return buf

    # -- Transport protocol ----------------------------------------------
    def query(self, frame: bytes, timeout_s: float) -> bytes:
        """Send one firmware frame, return `[node, func, status, …]`.

        Raises TransportError on any link failure (flash_node treats that
        as a recoverable no-reply within num_intentos).
        """
        if self._sock is None:
            self.connect()
        if len(frame) < 2:
            raise TransportError("frame too short to transmit")
        node = frame[0] & 0xFF
        pdu = bytes(frame[1:])                     # func .. payload .. xor
        txn = _next_txn()
        mbap = struct.pack(">HHHB", txn, _MBAP_PROTO, len(pdu) + 1, node)
        wire = mbap + pdu
        try:
            self._sock.settimeout(timeout_s)
            self._sock.sendall(wire)
        except OSError as e:
            raise TransportError(f"send: {e}") from e
        hdr = self._recv_exact(7, timeout_s)
        r_txn, r_proto, r_len, r_unit = struct.unpack(">HHHB", hdr)
        if r_proto != _MBAP_PROTO:
            raise TransportError(f"bad MBAP proto 0x{r_proto:04X}")
        if r_txn != txn:
            raise TransportError(
                f"MBAP txn mismatch got 0x{r_txn:04X} want 0x{txn:04X}")
        if r_len < 1:
            raise TransportError("MBAP length underflow")
        body = self._recv_exact(r_len - 1, timeout_s)  # r_len incl. unit
        # Re-prepend the unit so flash_node's [0]=node/[1]=func/[2]=status
        # indexing matches the RTU view (vendor_pdu.py contract).
        return bytes([r_unit]) + body

# ─── Live transport — RS485 / Modbus-RTU (the most-direct path) ────────────

#
# Why a second transport: RS485-USB is the *most direct* link to the
# inverter DSP — it bypasses the comm board and the transparent TCP→RTU
# gateway entirely, which removes a translation layer (and the
# concurrent-second-TCP-socket soak risk) from an irreversible operation.
# ISM itself flashes firmware over serial. We deliberately do NOT emit the
# `0x96` high-speed (baud-bump) frame — `firmware_loader.flash_node` never
# sends it — so there is no baud-switch race; the flash runs at the bus's
# configured fixed baud. Wire framing is plain Modbus RTU: the vendor PDU
# `[func,…,xor]` prefixed by the node unit-id and suffixed by CRC16
# (poly 0xA001, init 0xFFFF), exactly as ISM's `Add_CRC` builds it.

def _modbus_crc16(data: bytes) -> int:
    """Modbus RTU CRC16 (poly 0xA001, init 0xFFFF). Kept local so this
    module stays import-light (no pymodbus pull); identical to
    drivers.modbus_rtu.crc16_modbus and ISM's auchCRCHi/Lo tables."""
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if (crc & 1) else (crc >> 1)
    return crc & 0xFFFF

class ModbusVendorRtuTransport:
    """Raw Modbus-RTU transport for vendor firmware frames over RS485.

    A firmware frame is `[node, func, …payload…, xor]`. On the wire the
    ADU is `[node] + frame[1:] + CRC16(le)` — the DSP's native RTU view,
    no gateway in the middle. The reply ADU `[node, func, status, …, CRC]`
    is CRC-checked and the unit-id-prefixed PDU returned so `flash_node`
    sees `[node, func, status, …]` (identical contract to the TCP
    transport, so the state machine is transport-agnostic).

    `_serial_factory` is a test seam (None ⇒ real pyserial). pyserial is
    imported lazily so the unit tests never need the hardware dependency.
    """

    def __init__(self, port: str, *, baudrate: int = 9600, parity: str = "N",
                 stopbits: int = 1, bytesize: int = 8,
                 read_timeout_s: float = 3.0):
        if not isinstance(port, str) or not port.strip():
            raise FlashGateError("serial transport requires a COM port")
        self._port = port.strip()
        self._baud = int(baudrate)
        self._parity = str(parity or "N").upper()[:1]
        self._stopbits = int(stopbits)
        self._bytesize = int(bytesize)
        self._read_timeout = float(read_timeout_s)
        self._ser = None
        self._serial_factory = None  # test seam; None ⇒ real pyserial

    # -- connection -------------------------------------------------------
    def connect(self) -> None:
        if self._ser is not None:
            return
        if self._serial_factory is not None:
            self._ser = self._serial_factory(
                self._port, self._baud, self._parity, self._stopbits,
                self._bytesize, self._read_timeout)
            return
        try:
            import serial as _pyserial  # lazy: hardware-only dependency
        except ImportError as e:  # pragma: no cover - env without pyserial
            raise TransportError(f"pyserial not available: {e}") from e
        _PAR = {"N": _pyserial.PARITY_NONE, "E": _pyserial.PARITY_EVEN,
                "O": _pyserial.PARITY_ODD}
        _STOP = {1: _pyserial.STOPBITS_ONE, 2: _pyserial.STOPBITS_TWO}
        _BITS = {7: _pyserial.SEVENBITS, 8: _pyserial.EIGHTBITS}
        try:
            self._ser = _pyserial.Serial(
                port=self._port, baudrate=self._baud,
                parity=_PAR.get(self._parity, _pyserial.PARITY_NONE),
                stopbits=_STOP.get(self._stopbits, _pyserial.STOPBITS_ONE),
                bytesize=_BITS.get(self._bytesize, _pyserial.EIGHTBITS),
                timeout=self._read_timeout)
        except Exception as e:
            raise TransportError(f"open {self._port}: {e}") from e

    def close(self) -> None:
        if self._ser is not None:
            try:
                self._ser.close()
            except Exception:
                pass
            self._ser = None

    def __enter__(self):
        self.connect()
        return self

    def __exit__(self, *exc):
        self.close()
        return False

    def _set_timeout(self, t: float) -> None:
        try:
            self._ser.timeout = t
        except Exception:
            pass

    def _read_adu(self, want: int, timeout_s: float) -> bytes:
        """Read up to `want` bytes within timeout. RTU has no length
        prefix, so we read the expected count; pyserial returns early on
        timeout (short read ⇒ caller treats it as a no/short reply, which
        is exactly how flash_node's bounded retry handles it)."""
        self._set_timeout(timeout_s)
        try:
            return bytes(self._ser.read(want))
        except Exception as e:
            raise TransportError(f"serial read: {e}") from e

    # -- Transport protocol ----------------------------------------------
    def query(self, frame: bytes, timeout_s: float) -> bytes:
        """Send one firmware frame as an RTU ADU, return `[node,func,
        status,…]`. Raises TransportError on any link/CRC failure
        (flash_node treats that as a recoverable no-reply)."""
        if self._ser is None:
            self.connect()
        if len(frame) < 2:
            raise TransportError("frame too short to transmit")
        node = frame[0] & 0xFF
        pdu = bytes(frame[1:])                       # func .. payload .. xor
        adu = bytes([node]) + pdu
        adu += struct.pack("<H", _modbus_crc16(adu))  # CRC16 lo,hi
        try:
            try:
                self._ser.reset_input_buffer()
            except Exception:
                pass
            self._ser.write(adu)
            try:
                self._ser.flush()
            except Exception:
                pass
        except Exception as e:
            raise TransportError(f"serial write: {e}") from e
        # Flash replies (0x90/0x91/0x92) are fixed: [node,func,status]+CRC
        # = 5 bytes. (FC11 identity uses report_slave_id(), not query().)
        resp = self._read_adu(5, timeout_s)
        if len(resp) < 5:
            raise TransportError(
                f"short/no RTU reply ({len(resp)}B)")
        if _modbus_crc16(resp[:-2]) != struct.unpack("<H", resp[-2:])[0]:
            raise TransportError("RTU CRC mismatch")
        return resp[:-2]                              # [node,func,status]

    # -- FC11 Report-Slave-ID over RTU (identity / compat gate) ----------
    def report_slave_id(self, node: int, timeout_s: float = 3.0):
        """Issue FC11 (0x11) over RTU and parse the INGECON slave-ID.

        Returns a services.vendor_pdu.SlaveIdInfo so the compat gate is
        transport-agnostic (the TCP path uses vendor_pdu.read_slave_id;
        this is its RS485 twin — variable-length response read by
        draining within the timeout)."""
        from services import vendor_pdu as _vpdu
        if self._ser is None:
            self.connect()
        adu = bytes([node & 0xFF, 0x11])
        adu += struct.pack("<H", _modbus_crc16(adu))
        try:
            try:
                self._ser.reset_input_buffer()
            except Exception:
                pass
            self._ser.write(adu)
            try:
                self._ser.flush()
            except Exception:
                pass
        except Exception as e:
            raise TransportError(f"serial write (FC11): {e}") from e
        # INGECON returns ~102B payload → ADU ≈ 107B. No length prefix:
        # read a generous bound; pyserial returns what arrived at timeout.
        raw = self._read_adu(260, timeout_s)
        if len(raw) < 5:
            raise TransportError(f"short FC11 RTU reply ({len(raw)}B)")
        if raw[1] != 0x11:
            raise TransportError(
                f"unexpected FC in FC11 reply: 0x{raw[1]:02X}")
        byte_count = raw[2]
        end = 3 + byte_count
        if len(raw) < end + 2:
            raise TransportError(
                f"truncated FC11 payload (need {end + 2}B, got {len(raw)}B)")
        if _modbus_crc16(raw[:end]) != struct.unpack("<H",
                                                     raw[end:end + 2])[0]:
            raise TransportError("FC11 RTU CRC mismatch")
        return _vpdu.parse_fc11_slave_id(raw[3:end])

# ─── Gate: firmware file verification (security review CRITICAL #1) ─────────

def verify_firmware_file(path: str, *, allowed_dir: Optional[str] = None,
                         expected_sha256: Optional[str] = None,
                         max_bytes: int = fw.MAX_SREC_BYTES) -> str:
    """Validate the operator-supplied .S path. Returns its SHA-256 hex.

    Enforces: real regular file; (optional) confined under allowed_dir
    after realpath (no traversal/symlink escape); `.S` suffix; size cap;
    ISM `LLLnnnn…` filename rule; (optional) SHA-256 allowlist match.
    Raises FlashGateError on any failure.
    """
    if not path or not isinstance(path, str):
        raise FlashGateError("no firmware path")
    real = os.path.realpath(path)
    if not os.path.isfile(real):
        raise FlashGateError(f"not a regular file: {path}")
    if allowed_dir is not None:
        base = os.path.realpath(allowed_dir)
        if os.path.commonpath([real, base]) != base:
            raise FlashGateError(
                f"firmware file escapes allowed dir: {path}")
    if os.path.splitext(real)[1].lower() != ".s":
        raise FlashGateError("firmware file must have a .S extension")
    size = os.path.getsize(real)
    if size == 0:
        raise FlashGateError("firmware file is empty")
    if size > max_bytes:
        raise FlashGateError(f"firmware file too large: {size} > {max_bytes}")
    stem = os.path.basename(real)
    if not _FILENAME_RE.match(stem):
        raise FlashGateError(
            "firmware filename must start with LLLnnnn (3 letters, 4 digits)")
    h = hashlib.sha256()
    with open(real, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    digest = h.hexdigest()
    if expected_sha256 is not None and digest.lower() != expected_sha256.lower():
        raise FlashGateError(
            "firmware SHA-256 does not match the operator-confirmed hash "
            f"(file={digest})")
    return digest

# ─── Gate: inverter ↔ file compatibility / downgrade (CRITICAL #2,#3) ───────

def _fw_code_from_filename(path: str) -> str:
    """`AAV1003IJK01BC_InverterFirmware.S` → `AAV1003IJK01BC` (upper)."""
    stem = os.path.splitext(os.path.basename(path))[0].upper()
    return stem.split("_")[0]

def verify_inverter_compatible(slave_id, image: FirmwareImage,
                               firmware_path: str, *,
                               allow_downgrade: bool = False) -> None:
    """Cross-check the live inverter (FC11 SlaveIdInfo) against the file.

    `slave_id` is a services.vendor_pdu.SlaveIdInfo (duck-typed: needs
    .model_code and .firmware_main). Blocks a flash whose filename code is
    not consistent with the unit's model, and blocks an apparent downgrade
    unless `allow_downgrade`. Raises FlashGateError on mismatch.
    """
    if slave_id is None:
        raise FlashGateError(
            "inverter identity (FC11) unavailable — cannot verify "
            "compatibility before flashing")
    code = _fw_code_from_filename(firmware_path)        # e.g. AAV1003IJK01BC
    model = (getattr(slave_id, "model_code", "") or "").upper().strip()
    # The AUTHORITATIVE running firmware for our Freescale/Motorola fleet is
    # FC11 model_code (AAV1003xx) — the SAME namespace as the .S filename
    # code. firmware_main / firmware_aux (FC11 AAS… bytes) are UNVERIFIED
    # auxiliary IDs and are NEVER the running firmware (proven by decompiling
    # ISM Ingecon::Identifica; see memory/fc11_freescale_slaveid_layout.md),
    # so they must not drive the compatibility/downgrade decision. (Earlier
    # code compared firmware_main vs the AAV filename code — two different
    # namespaces, so the guard never fired; fixed 2026-05-31.)
    model_alnum = re.sub(r"[^A-Z0-9]", "", model)
    code_alnum = re.sub(r"[^A-Z0-9]", "", code)
    model_key = model_alnum[:7]
    if model_key and not code_alnum.startswith(model_key):
        raise FlashGateError(
            f"firmware {code} is not for this unit (model {model!r}); "
            "refusing to flash a mismatched image")
    # Downgrade guard — mirrors ISM's CodigoFirmware.Version comparison: the
    # version is the trailing field of the code, both sides in the shared
    # AAV namespace (model_code = product-key + version; file = product-key +
    # IJK-variant + version). Compare version trailers, not the whole string.
    model_version = model_alnum[-2:] if len(model_alnum) >= 2 else ""
    file_version = code_alnum[-2:] if len(code_alnum) >= 2 else ""
    if (model_version and file_version and model_version > file_version
            and not allow_downgrade):
        raise FlashGateError(
            f"installed firmware version {model_version!r} (model {model!r}) "
            f"appears newer than file version {file_version!r} ({code!r}); "
            "downgrade requires explicit allow_downgrade=True")

def firmware_upgrade_direction(slave_id, firmware_path: str) -> dict:
    """ISM QueHableAhoraOCalleParaSiempre — classify the pending flash as
    upgrade / downgrade / same / unknown by comparing the running model_code
    version against the file's version (both AAV-namespace trailers).

    Pure, side-effect-free; returns a machine-readable dict the orchestrator
    logs to the audit trail and the UI surfaces BEFORE the irreversible step,
    exactly as ISM tells the operator "will be upgraded" / "will be
    DOWNGRADED" before flashing.
    """
    code = _fw_code_from_filename(firmware_path)
    model = (getattr(slave_id, "model_code", "") or "").upper().strip()
    code_alnum = re.sub(r"[^A-Z0-9]", "", code)
    model_alnum = re.sub(r"[^A-Z0-9]", "", model)
    file_version = code_alnum[-2:] if len(code_alnum) >= 2 else ""
    model_version = model_alnum[-2:] if len(model_alnum) >= 2 else ""
    if not model_version or not file_version:
        direction = "unknown"
    elif model_version < file_version:
        direction = "upgrade"
    elif model_version > file_version:
        direction = "downgrade"
    else:
        direction = "same"
    return {
        "direction": direction,
        "current": model_version,
        "new": file_version,
        "model_code": model,
        "file_code": code,
    }

# ─── The gated orchestrator ────────────────────────────────────────────────

def flash_inverter_node(
    *,
    firmware_path: str,
    node: int,
    arg_dsp: int = 1,
    frame_len: int = 512,
    legacy50: bool = False,
    mode: str = "dry-run",
    # ---- live-only required gates (all must be supplied for mode="live")
    host: Optional[str] = None,
    serial_port: Optional[str] = None,
    confirm_irreversible: bool = False,
    dry_run_result: Optional[FlashResult] = None,
    bus_lock: Optional[AbstractContextManager] = None,
    audit: Optional[Callable[[str, dict], None]] = None,
    slave_id=None,
    allowed_dir: Optional[str] = None,
    expected_sha256: Optional[str] = None,
    allow_downgrade: bool = False,
    watchdog_s: float = 600.0,
    transport: Optional[fw.Transport] = None,
    on_progress: Optional[Callable[[str, int], None]] = None,
):
    """Single choke point for firmware upgrade.

    mode="dry-run" (default): hardware-free `firmware_loader.dry_run`,
    returns (FlashResult, MockDSP). Cannot touch an inverter.

    mode="live": only proceeds if EVERY gate passes; otherwise raises
    FlashGateError before any socket use. Returns FlashResult.
    """
    if mode not in ("dry-run", "live"):
        raise FlashGateError(f"unknown mode {mode!r}")

    # File verification happens for BOTH modes (cheap, and a bad file must
    # never even be dry-run-blessed and then trusted for live).
    digest = verify_firmware_file(
        firmware_path, allowed_dir=allowed_dir,
        expected_sha256=expected_sha256)
    image = fw.load_srec(firmware_path, arg_dsp, frame_len)
    # ISM VerificaFicheroFirmware — embedded-code-vs-filename anti-"wrong
    # file" guard. Runs for BOTH modes so a renamed / corrupt image is
    # refused at dry-run time, before the operator can ever arm a live flash.
    fw.verify_embedded_firmware_code(firmware_path, arg_dsp)

    if mode == "dry-run":
        return fw.dry_run(image, node, legacy50=legacy50,
                          on_progress=on_progress)

    # ---- mode == "live": enforce the full gate checklist ----------------
    if confirm_irreversible is not True:
        raise FlashGateError(
            "live flash blocked: confirm_irreversible must be explicitly True")
    if not isinstance(node, int) or not (1 <= node <= 247):
        raise FlashGateError(
            f"live flash blocked: node must be 1..247 (got {node!r}); "
            "broadcast/0 is forbidden")
    # Exactly ONE physical link. TCP auto-builds its transport; serial
    # (the most-direct RS485 path) requires the caller to inject an opened
    # ModbusVendorRtuTransport because the COM/port settings live with the
    # caller (calibrator) — flash_inverter_node never owns serial config.
    use_serial = bool(serial_port)
    if use_serial:
        if host:
            raise FlashGateError(
                "live flash blocked: specify a TCP host OR a serial port, "
                "not both")
        if transport is None:
            raise FlashGateError(
                "live flash blocked: serial firmware flash requires an "
                "injected RTU transport (caller owns the COM port)")
        link_label = f"serial:{serial_port}"
    else:
        if not host or not isinstance(host, str):
            raise FlashGateError(
                "live flash blocked: a TCP host or a serial port is "
                "required")
        link_label = host
    if not (isinstance(dry_run_result, FlashResult) and dry_run_result.ok):
        raise FlashGateError(
            "live flash blocked: a successful dry-run of THIS image is "
            "required first")
    if dry_run_result.frames_total != image.counts.num_tramas_total + 2:
        raise FlashGateError(
            "live flash blocked: dry-run frame count does not match this "
            "image (stale/mismatched dry-run)")
    if bus_lock is None:
        raise FlashGateError(
            "live flash blocked: an RS-485 poller-lockout context manager "
            "must be supplied")
    if audit is None or not callable(audit):
        raise FlashGateError(
            "live flash blocked: an audit sink is required")
    verify_inverter_compatible(slave_id, image, firmware_path,
                               allow_downgrade=allow_downgrade)
    # ISM QueHableAhoraOCalleParaSiempre — record the upgrade/downgrade
    # direction BEFORE the irreversible step (the UI surfaces it; the audit
    # trail keeps the ground truth of what the operator was told).
    direction = firmware_upgrade_direction(slave_id, firmware_path)

    own_transport = False
    if transport is None:                       # TCP only — see gate above
        transport = ModbusVendorTcpTransport(host)
        own_transport = True

    audit("firmware.pre_flash.direction", {
        "host": link_label, "node": node,
        "allow_downgrade": allow_downgrade, **direction,
    })
    audit("firmware.live.start", {
        "host": link_label, "node": node,
        "file": os.path.basename(firmware_path),
        "sha256": digest, "frames": image.counts.num_tramas_total + 2,
        "legacy50": legacy50, "direction": direction["direction"],
    })
    started = time.monotonic()

    def _wd_sleep(s: float) -> None:
        if time.monotonic() - started > watchdog_s:
            raise FlashGateError(
                f"watchdog: flash exceeded {watchdog_s:.0f}s — aborted")
        time.sleep(s)

    frames = fw.build_all_frames(image, node, legacy50)
    try:
        with bus_lock:                              # exclusive RS-485 access
            if own_transport and hasattr(transport, "connect"):
                transport.connect()
            res = fw.flash_node(
                frames, transport, node=node, legacy=legacy50,
                sleep=_wd_sleep, on_progress=on_progress)
    except FirmwareError as e:
        audit("firmware.live.fail", {"host": link_label, "node": node,
                                     "error": str(e)})
        raise
    finally:
        if own_transport:
            try:
                transport.close()
            except Exception:
                pass

    audit("firmware.live.ok", {
        "host": link_label, "node": node, "acked": res.frames_acked,
        "no_replies": res.no_replies, "chk_errors": res.frame_chk_errors,
        "flash_errors": res.flash_errors,
    })
    return res
