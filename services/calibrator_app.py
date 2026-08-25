"""Calibration-only FastAPI service (standalone dual-transport).

Part of the Field Calibration tool (Slice C2, Phase 2).
Plan: plans/2026-05-12-inverter-calibration-tool.md

This service:
  - Exposes /calibration/* routes (identical shape to inverter_engine.py)
  - Delegates to calibration_core + calibration_io (single-source read/write)
  - Manages dual transport: Modbus TCP (Ethernet) + Modbus RTU (serial COM)
  - Owns its own lockdown state (engine has its own copy)
  - Does NOT import inverter_engine, NOT run poller, NOT write adsi.db

Isolation: Transport-agnostic calibration logic is in:
  - calibration_core.py (read functions, constants)
  - calibration_io.py (write functions, unlock, verify pipeline)

Environment variables:
  - CALIBRATOR_PORT: service port (default 9200)
  - CALIBRATOR_HOST: bind address (default 127.0.0.1)

Transport registry:
  - A POST /transport/select call sets the active transport + client
  - Only one active client at a time (switching closes the prior)
  - All /calibration/* endpoints route through the active client
"""

from __future__ import annotations

import sys
import os

# Survival-boot guard — mirrors services/inverter_engine.py:12-15. Electron
# spawns this child without a console, so sys.stdout/stderr can be None;
# uvicorn's default log formatter calls sys.stdout.isatty() and crashes
# ("'NoneType' object has no attribute 'isatty'") without this.
if sys.stdout is None:
    sys.stdout = open(os.devnull, "w")
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w")

import asyncio
import json
import threading
import time
from typing import Optional, Dict, Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
import uvicorn

from services import calibration_core as _calib_core
from services import calibration_io as _calib_io
from services import calibration_decoder as _calib_dec
from drivers import modbus_tcp, modbus_rtu

# Phase 3 — EXPERIMENTAL gated firmware upgrade. These imports are the ONLY
# wiring between the calibrator service and the brick-risk feature; the
# safety gates themselves live in firmware_transport.flash_inverter_node and
# are NOT re-implemented here (single choke point — see
# audits/2026-05-18/ism-per-node-firmware-upgrade.md).
from services import firmware_transport as _fw_tx
from services import firmware_loader as _fw_loader
from services import vendor_pdu as _vendor_pdu
from services import firmware_buslock as _fw_lock

# ─── Configuration ────────────────────────────────────────────────────────

CALIBRATOR_PORT = int(os.getenv("CALIBRATOR_PORT", "9200"))
CALIBRATOR_HOST = os.getenv("CALIBRATOR_HOST", "127.0.0.1")

# ─── FastAPI app ────────────────────────────────────────────────────────

app = FastAPI(title="CalibratorService", version="1.0.0")

# ─── Transport registry (single active client + lock) ────────────────────

class TransportRegistry:
    """Manages the active calibration transport (TCP or serial)."""
    def __init__(self):
        self._client = None
        self._lock = threading.Lock()
        self._transport_type = None  # "tcp" or "serial"
        self._tcp_ip = None
        self._serial_port = None
        self._serial_cfg = None      # full {port,baudrate,...} for firmware

    def get_client(self) -> Any:
        """Return the active client, or None if not connected."""
        return self._client

    def get_lock(self) -> threading.Lock:
        """Return the per-client lock."""
        return self._lock

    def get_transport_type(self) -> Optional[str]:
        """Return the active transport type or None."""
        return self._transport_type

    def get_tcp_ip(self) -> Optional[str]:
        """Return the TCP target IP if active transport is TCP."""
        return self._tcp_ip if self._transport_type == "tcp" else None

    def get_serial_port(self) -> Optional[str]:
        """Return the serial port if active transport is serial."""
        return self._serial_port if self._transport_type == "serial" else None

    def get_serial_config(self) -> Optional[dict]:
        """Full serial parameters for the firmware RTU transport (the
        calibrator owns the COM settings; flash_inverter_node does not).
        Returns None unless the active transport is serial."""
        if self._transport_type != "serial" or not self._serial_cfg:
            return None
        return dict(self._serial_cfg)

    def release_serial_port(self) -> Optional[dict]:
        """Close the calibrator's pymodbus serial client so the firmware
        RTU transport can take EXCLUSIVE ownership of the single COM
        handle for the duration of a flash (the serial analogue of the
        TCP bus-lock — a COM port cannot be opened twice). The remembered
        config is returned and retained so the operator can reconnect the
        transport afterwards. No-op for non-serial."""
        if self._transport_type != "serial":
            return None
        cfg = dict(self._serial_cfg) if self._serial_cfg else None
        if self._client is not None:
            try:
                self._client.close()
            except Exception:
                pass
        self._client = None       # frees the COM handle; cfg kept
        return cfg

    def set_tcp_client(self, ip: str) -> None:
        """Set up TCP transport to a given inverter IP."""
        self._close_current()
        try:
            client = modbus_tcp.create_client(ip, port=502, timeout=3.0)
            # create_client() swallows a failed connect and returns the client
            # regardless (pymodbus reconnects lazily). For the calibrator we
            # want Connect to be TRUTHFUL — verify the socket is actually open
            # so the operator gets immediate, accurate feedback instead of a
            # misleading "Connected" followed by an opaque read failure.
            try:
                opened = bool(client.connect())
            except Exception:
                opened = False
            if not opened and hasattr(client, "is_socket_open"):
                opened = bool(client.is_socket_open())
            if not opened:
                try:
                    client.close()
                except Exception:
                    pass
                raise RuntimeError(
                    f"cannot reach inverter at {ip}:502 — check the IP, "
                    f"network/cabling, and that the inverter's Modbus TCP "
                    f"port 502 is open"
                )
            self._client = client
            self._transport_type = "tcp"
            self._tcp_ip = ip
            self._serial_port = None
            print(f"[CalibratorService] TCP client connected to {ip}:502")
        except Exception as exc:
            print(f"[CalibratorService] TCP client creation failed: {exc}")
            raise

    def set_serial_client(self, port: str, baudrate: int = 9600, parity: str = "N",
                          stopbits: int = 1, bytesize: int = 8) -> None:
        """Set up serial RTU transport on a COM port."""
        self._close_current()
        try:
            client = modbus_rtu.create_serial_client(
                port=port, baudrate=baudrate, parity=parity,
                stopbits=stopbits, bytesize=bytesize, timeout=3.0
            )
            # pymodbus serial client needs explicit connect
            client.connect()
            self._client = client
            self._transport_type = "serial"
            self._tcp_ip = None
            self._serial_port = port
            self._serial_cfg = {
                "port": port, "baudrate": int(baudrate),
                "parity": str(parity).upper()[:1], "stopbits": int(stopbits),
                "bytesize": int(bytesize),
            }
            print(f"[CalibratorService] Serial client connected to {port} ({baudrate}, {parity}{stopbits}{bytesize})")
        except Exception as exc:
            print(f"[CalibratorService] Serial client creation failed: {exc}")
            raise

    def _close_current(self) -> None:
        """Close the active client cleanly."""
        if self._client is not None:
            try:
                self._client.close()
            except Exception:
                pass
        self._client = None
        self._transport_type = None
        self._tcp_ip = None
        self._serial_port = None
        self._serial_cfg = None

_registry = TransportRegistry()

# ─── Calibration lockdown state (per-service instance) ────────────────────

_calibration_lockdown = {
    "active": False,
    "inverter": None,
    "slave": None,
    "session_id": None,
}

# ─── Endpoints ────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    """Service health + transport status."""
    client = _registry.get_client()
    transport = _registry.get_transport_type()
    connected = client is not None
    return {
        "ok": True,
        "service": "CalibratorService",
        "version": "1.0.0",
        "transport": transport,
        "connected": connected,
        "tcp_ip": _registry.get_tcp_ip(),
        "serial_port": _registry.get_serial_port(),
    }

def _validate_ipv4(ip_str: str) -> bool:
    """FIX E: Validate IPv4 dotted-quad format (each octet 0-255)."""
    import re
    # Pattern: four octets (0-255) separated by dots
    pattern = r"^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$"
    match = re.match(pattern, ip_str.strip())
    if not match:
        return False
    # Check each octet is in range 0-255
    for octet in match.groups():
        if int(octet) > 255:
            return False
    return True

def _validate_serial_port(port_str: str, allowed_ports: list = None) -> bool:
    """FIX E: Validate COM port format or presence in current port list.

    Windows COM port must match COM1-COM299 pattern or be in allowed_ports enumeration.
    Reject paths with backslash, forward slash, or colon (except COM prefix).
    """
    import re
    port_clean = str(port_str).strip().upper()

    # Check for illegal path chars
    if "\\" in port_clean or "/" in port_clean or (":" in port_clean and not port_clean.startswith("COM")):
        return False

    # Windows COM pattern: COM1-COM299
    com_pattern = r"^COM([1-9]|[1-9][0-9]|[1-2][0-9]{2})$"
    if re.match(com_pattern, port_clean):
        return True

    # Also accept if port is in the allowed enumeration (from /serial/ports)
    if allowed_ports and port_clean in [p.upper() for p in allowed_ports]:
        return True

    return False

def _validate_baud_and_params(baudrate: int, parity: str, stopbits: int, bytesize: int) -> bool:
    """FIX E: Validate serial parameters are in acceptable ranges."""
    valid_bauds = {1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200}
    valid_parity = {"N", "E", "O"}
    valid_stopbits = {1, 2}
    valid_bytesize = {7, 8}

    return (
        baudrate in valid_bauds
        and parity.upper() in valid_parity
        and stopbits in valid_stopbits
        and bytesize in valid_bytesize
    )

@app.post("/transport/select")
async def transport_select(req: Request):
    """Select and configure the active transport.

    Body:
      {
        "transport": "tcp" | "serial",
        "tcp": { "ip": "192.168.1.101" },            # if transport == "tcp"
        "serial": {                                    # if transport == "serial"
          "port": "COM3",
          "baudrate": 9600,
          "parity": "N",  # N/E/O
          "stopbits": 1,
          "bytesize": 8
        }
      }
    """
    try:
        body = await req.json()
    except Exception:
        raise HTTPException(400, "invalid JSON")

    transport = str(body.get("transport", "")).lower().strip()
    if transport not in ("tcp", "serial"):
        raise HTTPException(400, "transport must be 'tcp' or 'serial'")

    try:
        if transport == "tcp":
            tcp_cfg = body.get("tcp") or {}
            ip = str(tcp_cfg.get("ip") or "").strip()
            if not ip:
                raise HTTPException(400, "tcp.ip required for TCP transport")
            # FIX E: Validate IPv4 format before building client
            if not _validate_ipv4(ip):
                raise HTTPException(400, "invalid IPv4 address format")
            _registry.set_tcp_client(ip)
        else:  # serial
            serial_cfg = body.get("serial") or {}
            port = str(serial_cfg.get("port") or "").strip()
            if not port:
                raise HTTPException(400, "serial.port required for serial transport")

            # FIX E: Get current available ports for validation
            try:
                import serial.tools.list_ports
                available_ports = [p.device for p in serial.tools.list_ports.comports()]
            except Exception:
                available_ports = []

            # FIX E: Validate serial port
            if not _validate_serial_port(port, available_ports):
                raise HTTPException(400, "invalid serial port format or unavailable")

            # FIX E: Validate numeric parameters
            try:
                baudrate = int(serial_cfg.get("baudrate", 9600))
                parity = str(serial_cfg.get("parity", "N")).upper()
                stopbits = int(serial_cfg.get("stopbits", 1))
                bytesize = int(serial_cfg.get("bytesize", 8))
            except (ValueError, TypeError):
                raise HTTPException(400, "invalid serial parameter type")

            # FIX E: Validate parameter ranges
            if not _validate_baud_and_params(baudrate, parity, stopbits, bytesize):
                raise HTTPException(400, "serial parameters out of range")

            # All validation passed, set up the client
            _registry.set_serial_client(port, baudrate, parity, stopbits, bytesize)
    except HTTPException:
        raise
    except Exception as exc:
        # The transport setup errors here are our own controlled strings
        # (validated IP / COM only) or pymodbus connectivity text — safe and
        # genuinely useful to surface so the operator can fix the IP/port/
        # cabling instead of guessing. (FIX E still applies to value writes.)
        msg = str(exc).strip() or "transport setup failed"
        raise HTTPException(503, f"transport setup failed: {msg}")

    return {
        "ok": True,
        "transport": transport,
        "connected": True,
        "message": f"Active transport: {transport}",
    }

@app.get("/serial/ports")
async def serial_ports():
    """List available serial ports (for UI port selector)."""
    try:
        import serial.tools.list_ports
        ports = [p.device for p in serial.tools.list_ports.comports()]
        return {"ok": True, "ports": ports}
    except Exception as exc:
        return {"ok": False, "error": str(exc), "ports": []}

@app.get("/calibration/state/{slave}")
async def api_calibration_state(slave: int):
    """Read calibration block (offsets 80-94) + live values for a slave unit.

    Parameters:
      - slave: Modbus slave/unit ID (1-based inverter unit number)

    For TCP: resolves to the currently-selected IP; for serial, uses the open port.

    Returns:
      {
        "ok": true/false,
        "slave": <unit>,
        "calibration": {...},
        "live": {...},
        "error": "string or null"
      }
    """
    client = _registry.get_client()
    if not client:
        return {"ok": False, "error": "no_client", "slave": int(slave)}

    if _fw_flash_in_progress():
        return {"ok": False, "error": "firmware_flash_in_progress"}
    lock = _registry.get_lock()
    loop = asyncio.get_running_loop()

    try:
        # SINGLE-SOURCE CONTRACT — must mirror inverter_engine.py's
        # api_calibration_state byte-for-byte:
        #   1. `ok` is gated ONLY on the calibration-block read.
        #   2. the raw regs are DECODED via calibration_decoder (the UI
        #      renders decoded fields + valid_cfg_code, NOT the raw block).
        #   3. `live` is BEST-EFFORT data with no "ok" key — it never gates
        #      success ("calibration state must remain readable even if the
        #      input regs are momentarily unavailable").
        # The previous handler returned the raw block as `calibration` and
        # ANDed in live_result.get("ok") (which is always None → ok=False),
        # so a perfectly good read showed "read failed". Fixed here.
        raw = await loop.run_in_executor(
            None,
            _calib_core._read_calibration_block_sync,
            client, lock, int(slave),
        )
        if not raw.get("ok"):
            return {
                "ok": False,
                "slave": int(slave),
                "error": raw.get("error") or "calibration block read failed",
            }
        decoded = _calib_dec.decode_calibration_block(
            raw["regs"], base_offset=_calib_core._CALIB_READ_BASE,
        )
        live = await loop.run_in_executor(
            None,
            _calib_core._read_live_for_calibration_sync,
            client, lock, int(slave),
        )
        return {
            "ok": True,
            "slave": int(slave),
            "base": raw["base"],
            "count": raw["count"],
            "regs": raw["regs"],
            "calibration": decoded,
            "live": live,
            "read_at_ms": int(time.time() * 1000),
        }
    except Exception as exc:
        return {"ok": False, "error": str(exc), "slave": int(slave)}

@app.post("/calibration/write")
async def api_calibration_write(req: Request):
    """Write a single calibration register.

    Body: { slave, offset, value, max_delta_pct?, verify_delay_s? }

    Returns: write_one_with_lock result (detailed status + readback).
    """
    try:
        body = await req.json()
    except Exception:
        raise HTTPException(400, "invalid JSON")

    slave = int(body.get("slave") or 0)
    offset = int(body.get("offset") or 0)
    value = int(body.get("value") or 0)

    if slave <= 0:
        raise HTTPException(400, "slave required")
    if offset <= 0:
        raise HTTPException(400, "offset required")

    client = _registry.get_client()
    if not client:
        raise HTTPException(503, "no_client")

    if _fw_flash_in_progress():
        return {"ok": False, "error": "firmware_flash_in_progress"}
    lock = _registry.get_lock()
    loop = asyncio.get_running_loop()

    try:
        result = await loop.run_in_executor(
            None,
            _calib_io.write_one_with_lock,
            client, lock, int(slave), int(offset), int(value),
        )
        result["slave"] = int(slave)
        result["read_at_ms"] = int(time.time() * 1000)
        return result
    except Exception as exc:
        raise HTTPException(500, f"executor_error: {exc}")

@app.post("/calibration/write-bulk")
async def api_calibration_write_bulk(req: Request):
    """Write multiple calibration registers.

    Body:
      {
        "slave": 1,
        "writes": [ { "offset": 81, "value": 1125 }, ... ],
        "max_delta_pct": 50.0
      }

    Returns: write_bulk_with_lock result.
    """
    try:
        body = await req.json()
    except Exception:
        raise HTTPException(400, "invalid JSON")

    slave = int(body.get("slave") or 0)
    writes_raw = body.get("writes") or []

    if slave <= 0:
        raise HTTPException(400, "slave required")
    if not isinstance(writes_raw, list) or not writes_raw:
        raise HTTPException(400, "writes (non-empty list) required")

    pairs = []
    for w in writes_raw:
        try:
            pairs.append((int(w["offset"]), int(w["value"])))
        except (KeyError, ValueError, TypeError) as exc:
            raise HTTPException(400, f"invalid writes entry: {exc}")

    client = _registry.get_client()
    if not client:
        raise HTTPException(503, "no_client")

    if _fw_flash_in_progress():
        return {"ok": False, "error": "firmware_flash_in_progress"}
    lock = _registry.get_lock()
    loop = asyncio.get_running_loop()

    try:
        result = await loop.run_in_executor(
            None,
            _calib_io.write_bulk_with_lock,
            client, lock, int(slave), pairs,
        )
        result["slave"] = int(slave)
        result["read_at_ms"] = int(time.time() * 1000)
        return result
    except Exception as exc:
        raise HTTPException(500, f"executor_error: {exc}")

@app.post("/calibration/config-write")
async def api_calibration_config_write(req: Request):
    """Write ONE L2 config-block field (Utility Tool tabs B/C/D/I).

    Body: {
      slave:      int,
      field:      str,            # field name from cfg_trif_map.FIELDS
      value:      any,            # user-supplied natural value (e.g. 5000 W, 60.00 Hz)
      verify_delay_s?: float,
    }

    The endpoint looks the field up in cfg_trif_map.FIELDS (single source
    of truth — same map the read decoder uses), routes through the pure
    encoder in cfg_block_write.encode_value, then calls the locked write
    helper in calibration_io.write_cfg_field_with_lock. The same UNLOCK
    magic + sentinel guard + verify cycle as the calibration write path.

    Refuses cleanly (with the encoder's error message) for:
      - kinds dt6 / recta / byte (use ISM)
      - fields ValidCfgCode / FechaConfiguracion / NumGrabaciones
      - any value outside the kind's safe range

    Auth + audit are owned by the Node proxy layer; this Python endpoint
    is reachable only on loopback by design.
    """
    try:
        body = await req.json()
    except Exception:
        raise HTTPException(400, "invalid JSON")

    slave = int(body.get("slave") or 0)
    field_name = str(body.get("field") or "").strip()
    new_value = body.get("value")
    verify_delay_s = float(body.get("verify_delay_s") or 1.0)

    if slave <= 0:
        raise HTTPException(400, "slave required")
    if not field_name:
        raise HTTPException(400, "field required")
    if new_value is None:
        raise HTTPException(400, "value required")

    # Resolve the field metadata from the SAME map the read decoder uses
    # — guarantees encoder + decoder stay in lockstep through future regens.
    try:
        from services import cfg_trif_map as _cfg_map
    except Exception as exc:
        raise HTTPException(500, f"cfg_trif_map unavailable: {exc}")

    field_meta = None
    for f in (getattr(_cfg_map, "FIELDS", None) or []):
        if str(f.get("field") or "") == field_name:
            field_meta = f
            break
    if field_meta is None:
        raise HTTPException(400, f"unknown field '{field_name}'")

    client = _registry.get_client()
    if not client:
        raise HTTPException(503, "no_client")

    if _fw_flash_in_progress():
        return {"ok": False, "error": "firmware_flash_in_progress"}

    lock = _registry.get_lock()
    loop = asyncio.get_running_loop()

    try:
        result = await loop.run_in_executor(
            None,
            lambda: _calib_io.write_cfg_field_with_lock(
                client, lock, int(slave), field_meta, new_value,
                verify_delay_s=verify_delay_s,
                is_flash_active=_fw_flash_in_progress,
            ),
        )
        result["slave"] = int(slave)
        result["read_at_ms"] = int(time.time() * 1000)
        return result
    except Exception as exc:
        raise HTTPException(500, f"executor_error: {exc}")

@app.post("/calibration/consign")
async def api_calibration_consign(req: Request):
    """Drive APC setpoint (opcode 0x0003) to specified percent for calibration consign.

    Body: { slave, percent }  — percent in [0, 100]

    Delegates to calibration_io.consign_apc_with_lock (single-source core).
    Returns {ok, pct, q15, error?}.
    """
    try:
        body = await req.json()
    except Exception:
        raise HTTPException(400, "invalid JSON")

    slave = int(body.get("slave") or 0)
    pct = float(body.get("percent", -1))

    if slave <= 0:
        raise HTTPException(400, "slave required")
    if pct < 0 or pct > 100:
        raise HTTPException(400, "percent must be 0..100")

    # Resolve the active transport client
    client = _registry.get_client()
    if not client:
        return {"ok": False, "pct": pct, "q15": 0, "error": "no_client"}

    if _fw_flash_in_progress():
        return {"ok": False, "error": "firmware_flash_in_progress"}
    lock = _registry.get_lock()

    # Delegate to single-source calibration core
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        None,
        _calib_io.consign_apc_with_lock,
        client, lock, int(slave), float(pct),
    )

@app.get("/calibration/preflight/{slave}")
async def api_calibration_preflight(slave: int):
    """Read sentinel + calibration block for preflight validation.

    Returns {ok, sentinel, sentinel_ok, by_offset, error?}.
    """
    client = _registry.get_client()
    if not client:
        return {"ok": False, "error": "no_client"}

    if _fw_flash_in_progress():
        return {"ok": False, "error": "firmware_flash_in_progress"}
    lock = _registry.get_lock()
    loop = asyncio.get_running_loop()

    try:
        result = await loop.run_in_executor(
            None,
            _calib_io.preflight_read_with_lock,
            client, lock, int(slave),
        )
        return result
    except Exception as exc:
        return {"ok": False, "error": str(exc)}

@app.get("/calibration/full-config/{slave}")
async def api_calibration_full_config(slave: int):
    """Diagnostic read of the full 177-register config block.

    Returns {ok, block_base, block_len, decoded, regs_hex, read_at_ms}.
    """
    client = _registry.get_client()
    if not client:
        return {"ok": False, "error": "no_client"}

    if _fw_flash_in_progress():
        return {"ok": False, "error": "firmware_flash_in_progress"}
    lock = _registry.get_lock()
    loop = asyncio.get_running_loop()

    def _read_full(c, lk, s):
        """Read the full config block in 48-reg chunks under one lock."""
        CHUNK = 48
        try:
            base = _calib_dec.CONFIG_BLOCK_BASE
            total = _calib_dec.CONFIG_BLOCK_LENGTH
            out: list[int] = []
            with lk:
                offset = 0
                while offset < total:
                    need = min(CHUNK, total - offset)
                    r = c.read_holding_registers(
                        address=base + offset,
                        count=need,
                        unit=s,
                    )
                    if r is None or r.isError():
                        return {"ok": False, "error": f"modbus_error@{offset}: {r}"}
                    got = list(r.registers) if hasattr(r, "registers") else []
                    if len(got) < need:
                        return {"ok": False, "error": f"short_frame@{offset}: got {len(got)}/{need}"}
                    out.extend(got)
                    offset += need
            if len(out) < total:
                return {"ok": False, "error": f"short_frame: got {len(out)}/{total}"}
            return {"ok": True, "regs": out}
        except Exception as exc:
            return {"ok": False, "error": f"exception: {exc}"}

    try:
        raw = await loop.run_in_executor(None, _read_full, client, lock, int(slave))
        if not raw.get("ok"):
            return raw
        decoded = _calib_dec.decode_config_block(raw["regs"])
        return {
            "ok": True,
            "slave": int(slave),
            "block_base": _calib_dec.CONFIG_BLOCK_BASE,
            "block_len": _calib_dec.CONFIG_BLOCK_LENGTH,
            "decoded": decoded,
            "regs_hex": " ".join(f"{v & 0xFFFF:04X}" for v in raw["regs"]),
            "read_at_ms": int(time.time() * 1000),
        }
    except Exception as exc:
        return {"ok": False, "error": str(exc)}

@app.get("/calibration/cfg-map")
async def api_calibration_cfg_map():
    """Return the STATIC Utility Tool field map (offsets, kinds, groups,
    labels, units). No transport, no Modbus — lets the UI render the
    layout of every read-only tab even before a Connect/Read."""
    try:
        try:
            from services import cfg_trif_map as _m  # type: ignore
        except Exception:
            import cfg_trif_map as _m                # type: ignore
        return {
            "ok": True,
            "fields": list(_m.FIELDS),
            "group_titles": dict(_m.GROUP_TITLES),
        }
    except Exception as exc:
        return {"ok": False, "error": str(exc)}

@app.get("/calibration/scan/{ip}/{slave}")
async def api_calibration_scan(ip: str, slave: int):
    """Read-only fleet-scan probe — TCP only.

    Opens a SHORT-LIVED Modbus-TCP client to `ip`, reads the 177-reg config
    block, decodes it, and closes the socket. Deliberately does NOT touch
    the registered transport (`_registry`) so an active calibration/transport
    on a different inverter is never disturbed. Never writes.
    Returns {ok, ip, slave, decoded} | {ok:false, error}.
    """
    if _fw_flash_in_progress():
        return {"ok": False, "error": "firmware_flash_in_progress"}
    loop = asyncio.get_running_loop()

    def _scan(addr: str, s: int):
        CHUNK = 48
        client = None
        try:
            client = modbus_tcp.create_client(addr, port=502, timeout=3.0)
            try:
                opened = bool(client.connect())
            except Exception:
                opened = False
            if not opened and hasattr(client, "is_socket_open"):
                opened = bool(client.is_socket_open())
            if not opened:
                return {"ok": False, "error": f"unreachable:{addr}"}
            base = _calib_dec.CONFIG_BLOCK_BASE
            total = _calib_dec.CONFIG_BLOCK_LENGTH
            out: list[int] = []
            offset = 0
            while offset < total:
                need = min(CHUNK, total - offset)
                r = client.read_holding_registers(
                    address=base + offset, count=need, unit=int(s))
                if r is None or r.isError():
                    return {"ok": False, "error": f"modbus_error@{offset}"}
                got = list(r.registers) if hasattr(r, "registers") else []
                if len(got) < need:
                    return {"ok": False,
                            "error": f"short_frame@{offset}: {len(got)}/{need}"}
                out.extend(got)
                offset += need
            return {"ok": True, "regs": out}
        except Exception as exc:
            return {"ok": False, "error": f"exception: {exc}"}
        finally:
            if client is not None:
                try:
                    client.close()
                except Exception:
                    pass

    try:
        raw = await loop.run_in_executor(None, _scan, str(ip), int(slave))
        if not raw.get("ok"):
            return raw
        return {
            "ok": True,
            "ip": str(ip),
            "slave": int(slave),
            "decoded": _calib_dec.decode_config_block(raw["regs"]),
            "read_at_ms": int(time.time() * 1000),
        }
    except Exception as exc:
        return {"ok": False, "error": str(exc)}

@app.post("/calibration/lockdown")
async def api_calibration_lockdown(req: Request):
    """Sync calibration session lockdown state.

    Body: { active: true/false, inverter?, slave?, session_id? }

    Used by Node to prevent concurrent sessions on the same inverter/slave.
    This service maintains its own lockdown state independent of the engine.
    """
    try:
        body = await req.json()
    except Exception:
        raise HTTPException(400, "invalid JSON")

    active = bool(body.get("active"))
    if active:
        inverter = int(body.get("inverter") or 0)
        slave = int(body.get("slave") or 0)
        if not inverter or not slave:
            raise HTTPException(400, "inverter+slave required when active=true")
        _calibration_lockdown.update({
            "active": True,
            "inverter": inverter,
            "slave": slave,
            "session_id": str(body.get("session_id") or ""),
        })
    else:
        _calibration_lockdown.update({
            "active": False,
            "inverter": None,
            "slave": None,
            "session_id": None,
        })

    print(
        f"[CalibratorService-lockdown] now active={_calibration_lockdown['active']} "
        f"target={_calibration_lockdown.get('inverter')}/{_calibration_lockdown.get('slave')}",
        flush=True
    )
    return {"ok": True, "state": dict(_calibration_lockdown)}

# ═══════════════════════════════════════════════════════════════════════════
#  EXPERIMENTAL — Gated per-node firmware upgrade (Phase 3 wiring)
#
#  Irreversible / brick-risk on a live 997.64 kW plant. Every safety gate is
#  enforced by services.firmware_transport.flash_inverter_node (the single
#  choke point) — this layer ONLY: (a) confines the firmware path to a known
#  directory, (b) bridges HTTP ⇄ that orchestrator, (c) carries the prior
#  dry-run result across requests so the "must dry-run first" gate can hold,
#  (d) exposes progress + a cooperative abort, (e) records an audit trail.
#  Default everywhere is dry-run; live needs the full typed confirmation
#  chain driven by the operator from the UI.
# ═══════════════════════════════════════════════════════════════════════════

# Firmware files are confined to ONE directory (defence-in-depth on top of
# flash_inverter_node's allowed_dir/realpath check). Operators pick a file
# by basename only — no free-form path ever crosses the wire.
_FW_DIR = os.path.realpath(
    os.getenv("ADSI_FIRMWARE_DIR")
    or os.path.join(os.path.dirname(__file__), "..", "docs")
)

# Successful dry-run results, keyed by the (sha256, node, arg_dsp, frame_len,
# legacy50) tuple. A live flash MUST present a key that resolves here — that
# is how the cross-request "a successful dry-run of THIS image first" gate is
# satisfied (the sha256 is part of the key, so a changed file can't reuse an
# old blessing).
_fw_dryruns: Dict[tuple, Any] = {}
_fw_dryruns_lock = threading.Lock()

# Background live-flash jobs. A live flash runs minutes (mass-erase + ~117
# frames); it executes on a worker thread so the UI can poll progress and
# request a cooperative abort between frames.
_fw_jobs: Dict[str, Dict[str, Any]] = {}
_fw_jobs_lock = threading.Lock()
_FW_JOB_TTL_S = 3600          # finished jobs purge-able after 1 h
_FW_JOB_MAX = 64              # hard cap on retained job records

def _fw_flash_in_progress() -> bool:
    """True while any firmware flash job is live. The flash worker holds the
    registry per-IP lock (`with bus_lock:`) for the ENTIRE multi-minute
    flash, so any Modbus calibration/identity route that also takes that
    lock would otherwise block until the flash ends — a frozen,
    feedback-less UI. Those routes fast-fail on this instead, keeping the
    standalone tool responsive (and avoiding a pile-up of blocked worker
    threads). Cheap, read-only, lock-guarded snapshot."""
    with _fw_jobs_lock:
        return any(j.get("done") is False for j in _fw_jobs.values())

def _fw_prune_jobs() -> None:
    """Bound _fw_jobs memory: drop finished jobs past the TTL, and if the
    map is still over the cap, drop the oldest finished ones. Running jobs
    are never evicted. Call under no lock — it takes the lock itself."""
    now = time.time()
    with _fw_jobs_lock:
        for jid in [k for k, j in _fw_jobs.items()
                    if j.get("done")
                    and now - j.get("started_ms", 0) / 1000.0 > _FW_JOB_TTL_S]:
            _fw_jobs.pop(jid, None)
        if len(_fw_jobs) > _FW_JOB_MAX:
            finished = sorted(
                (j for j in _fw_jobs.values() if j.get("done")),
                key=lambda j: j.get("started_ms", 0))
            for j in finished[:len(_fw_jobs) - _FW_JOB_MAX]:
                _fw_jobs.pop(j["id"], None)

def _fw_audit_path() -> str:
    """JSONL audit sink. Python is read-only for adsi.db (Node owns DB
    writes), so the irreversible-operation trail is a flat append-only file
    next to the hot DB; the Node proxy also persists key events to audit_log.
    """
    base = os.getenv("PROGRAMDATA") or os.path.dirname(__file__)
    d = os.path.join(base, "Inverter-Dashboard")
    try:
        os.makedirs(d, exist_ok=True)
    except OSError:
        d = os.path.dirname(__file__)
    return os.path.join(d, "firmware-audit.jsonl")

def _fw_make_audit(sink_events: list):
    """Build an audit(event, detail) callable that fans out to (1) the
    in-memory job event list the UI polls and (2) the durable JSONL file."""
    path = _fw_audit_path()

    def _audit(event: str, detail: dict) -> None:
        rec = {"ts_ms": int(time.time() * 1000), "event": event,
               "detail": detail}
        sink_events.append(rec)
        try:
            with open(path, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(rec) + "\n")
        except OSError:
            pass  # audit file best-effort; never block/raise the flash on it

    return _audit

def _fw_resolve(body: dict):
    """Resolve the firmware image the operator chose.

    Two input shapes, returns ``(abs_path, allowed_dir)``:

      * ``{"path": "<absolute path>"}`` — the operator picked the file
        through the Electron native open-dialog (the calibrator runs in
        Electron and binds these endpoints to 127.0.0.1, so the path
        originates from a trusted OS picker, not arbitrary input). No
        directory confinement, but ``verify_firmware_file`` still enforces
        realpath + is-a-regular-file + ``.S`` + size cap + the ISM
        ``LLLnnnn`` filename rule + SHA, and the live flash still needs the
        FC11 compat gate, a prior dry-run of the same SHA, and the typed
        confirmation. ``allowed_dir`` is None (no extra confinement).
      * ``{"file": "<bare name>"}`` — legacy/convenience: a bare basename
        confined to ``_FW_DIR``. Path separators are rejected so traversal
        is impossible. ``allowed_dir`` is ``_FW_DIR``.
    """
    raw_path = body.get("path")
    if raw_path:
        if not isinstance(raw_path, str) or not raw_path.strip():
            raise HTTPException(400, "firmware path must be a non-empty string")
        p = raw_path.strip()
        if not os.path.isabs(p):
            raise HTTPException(400, "firmware path must be absolute")
        return os.path.normpath(p), None
    name = body.get("file")
    if name:
        if not isinstance(name, str):
            raise HTTPException(400, "firmware file name required")
        if ("/" in name) or ("\\" in name) or (os.sep in name) or name in (
                ".", ".."):
            raise HTTPException(400, "firmware file must be a bare name")
        return os.path.join(_FW_DIR, name), _FW_DIR
    raise HTTPException(400, "firmware path or file required")

@app.get("/firmware/files")
async def api_firmware_files():
    """List candidate .S firmware images in the confined directory.

    Read-only and side-effect-free — safe to call without arming anything.
    """
    try:
        entries = []
        for fn in sorted(os.listdir(_FW_DIR)):
            if not fn.lower().endswith(".s"):
                continue
            full = os.path.join(_FW_DIR, fn)
            if not os.path.isfile(full):
                continue
            entries.append({"name": fn, "size": os.path.getsize(full)})
        return {"ok": True, "dir": _FW_DIR, "files": entries}
    except OSError as exc:
        return {"ok": False, "error": str(exc), "dir": _FW_DIR, "files": []}

@app.get("/firmware/identity/{slave}")
async def api_firmware_identity(slave: int):
    """FC11 Report-Slave-ID for the target unit (model / firmware / serial).

    Used by the UI to show the operator *exactly which physical unit* a
    flash would hit, and to pre-check file↔unit compatibility before the
    irreversible step. Read-only; works over TCP or RS485/RTU.
    """
    ttype = _registry.get_transport_type()
    if _fw_flash_in_progress():
        return {"ok": False, "error": "firmware_flash_in_progress"}
    lock = _registry.get_lock()
    loop = asyncio.get_running_loop()

    if ttype == "tcp":
        client = _registry.get_client()
        if not client:
            return {"ok": False, "error": "no_client"}

        def _read(lk):
            with lk:
                return _vendor_pdu.read_slave_id(client, int(slave),
                                                 timeout_s=3.0)
    elif ttype == "serial":
        cfg = _registry.get_serial_config()
        if not cfg:
            return {"ok": False, "error": "no active serial transport"}

        def _read(lk):
            # A COM port opens once: briefly release the calibrator's
            # serial client, peek FC11 over our RTU transport, then
            # RESTORE the operator's session so this stays a harmless
            # read-only pre-check.
            with lk:
                _registry.release_serial_port()
                rtu = _fw_tx.ModbusVendorRtuTransport(
                    cfg["port"], baudrate=cfg["baudrate"],
                    parity=cfg["parity"], stopbits=cfg["stopbits"],
                    bytesize=cfg["bytesize"], read_timeout_s=3.0)
                try:
                    rtu.connect()
                    return rtu.report_slave_id(int(slave), timeout_s=3.0)
                finally:
                    rtu.close()
                    try:
                        _registry.set_serial_client(
                            cfg["port"], cfg["baudrate"], cfg["parity"],
                            cfg["stopbits"], cfg["bytesize"])
                    except Exception:
                        pass
    else:
        return {"ok": False, "error": "connect a transport first "
                "(Ethernet or RS485-USB)"}

    try:
        sid = await loop.run_in_executor(None, _read, lock)
        return {
            "ok": True,
            "slave": int(slave),
            "serial": sid.serial,
            "serial_format": sid.serial_format,
            "model_code": sid.model_code,
            "firmware_main": sid.firmware_main,
            "firmware_aux": sid.firmware_aux,
        }
    except Exception as exc:
        return {"ok": False, "slave": int(slave), "error": str(exc)}

@app.post("/firmware/dryrun")
async def api_firmware_dryrun(req: Request):
    """Hardware-free full flash simulation (the DEFAULT, safe mode).

    Body: { path | file, node, arg_dsp?, frame_len?, legacy50? }

    Never touches the wire. On success the FlashResult is cached so a
    subsequent live flash of the SAME image can satisfy the
    must-dry-run-first gate. Returns the result + sha256 + progress log.
    """
    try:
        body = await req.json()
    except Exception:
        raise HTTPException(400, "invalid JSON")

    path, allowed_dir = _fw_resolve(body)
    node = int(body.get("node") or 0)
    arg_dsp = int(body.get("arg_dsp") or 1)
    frame_len = int(body.get("frame_len") or 512)
    legacy50 = bool(body.get("legacy50") or False)
    if node <= 0:
        raise HTTPException(400, "node required")

    loop = asyncio.get_running_loop()
    progress: list = []

    def _run():
        try:
            sha = _fw_tx.verify_firmware_file(path, allowed_dir=allowed_dir)
        except _fw_loader.FirmwareError as e:
            return {"ok": False, "error": str(e)}
        try:
            res, _dsp = _fw_tx.flash_inverter_node(
                firmware_path=path, node=node, arg_dsp=arg_dsp,
                frame_len=frame_len, legacy50=legacy50, mode="dry-run",
                allowed_dir=allowed_dir,
                on_progress=lambda m, p: progress.append({"msg": m, "pct": p}),
            )
        except _fw_loader.FirmwareError as e:
            return {"ok": False, "error": str(e), "sha256": sha}
        if res.ok:
            key = (sha, node, arg_dsp, frame_len, bool(legacy50))
            with _fw_dryruns_lock:
                _fw_dryruns[key] = res
        return {
            "ok": bool(res.ok),
            "sha256": sha,
            "result": {
                "ok": res.ok, "frames_total": res.frames_total,
                "frames_acked": res.frames_acked,
                "no_replies": res.no_replies,
                "frame_chk_errors": res.frame_chk_errors,
                "flash_errors": res.flash_errors,
                "rx_frame_errors": res.rx_frame_errors,
                "message": res.message, "diag": res.diag(),
            },
            "progress": progress,
        }

    return await loop.run_in_executor(None, _run)

def _fw_live_worker(job_id: str, path: str, node: int, slave: int,
                    arg_dsp: int, frame_len: int, legacy50: bool,
                    expected_sha256: str, allow_downgrade: bool,
                    link_host, link_serial, transport_obj,
                    bus_lock, slave_id, allowed_dir):
    """Worker thread: drive the GATED live flash over the chosen link
    (TCP or RS485/RTU). All refusals come from flash_inverter_node; this
    only carries progress/abort/audit. `transport_obj` is the concrete,
    caller-owned transport (TCP: lazy-connect; serial: already open from
    the identity read) — flash_inverter_node never connects/closes an
    injected transport, so the worker owns its lifecycle."""
    job = _fw_jobs[job_id]
    audit = _fw_make_audit(job["events"])

    class _AbortableTransport:
        """Wraps the concrete transport; raises BETWEEN frames if the
        operator hit Abort. Raising a FirmwareError (not TransportError)
        makes flash_node propagate immediately rather than retry."""
        def __init__(self, inner):
            self._t = inner

        def connect(self):
            self._t.connect()

        def close(self):
            self._t.close()

        def query(self, frame, timeout_s):
            if job["abort"]:
                raise _fw_loader.FirmwareError(
                    "flash aborted by operator before frame send")
            return self._t.query(frame, timeout_s)

    def _prog(msg: str, pct: int = 0):
        job["progress"].append({"msg": msg, "pct": pct})

    # Keep the cross-process bus-lock claim fresh for the multi-minute
    # flash. Daemon thread so a hung flash can't wedge shutdown; the claim
    # carries a hard TTL so even a crashed worker self-clears for the
    # poller within ~2 min. No-op for serial flashes (link_host is None).
    def _fw_lock_heartbeat():
        while not job["done"]:
            try:
                if link_host:
                    _fw_lock.heartbeat(link_host, node, slave, job_id)
            except Exception:
                pass
            for _ in range(40):              # ~40 s, but bail fast on done
                if job["done"]:
                    return
                time.sleep(1)
    if link_host:
        threading.Thread(target=_fw_lock_heartbeat,
                          name=f"fw-lock-{job_id}", daemon=True).start()

    # Pre-load bus settle (TCP only). This is a best-effort safeguard for
    # the case where a dashboard/poller is running ON THE SAME (gateway)
    # PC: the cross-process claim was published before this thread, but a
    # local consumer re-reads the marker on a 1-2 s cache, so we wait out
    # that window before the first 0x90 so a same-box poller has provably
    # backed off. It is NOT a dependency on the dashboard — the standalone
    # tool needs no dashboard, and this settle does nothing (and the lock
    # is fail-open) when none is running. It also CANNOT prevent an
    # external master on another machine (ISM/SCADA/another PC's poller)
    # or a running inverter from causing "0x90 error code 2"; that is the
    # DSP refusing the load and must be resolved at the inverter.
    # Negligible vs a multi-minute flash; serial skips it; abort bails.
    if link_host:
        _prog("Settling the Modbus bus before load-start…", 0)
        for _ in range(7):                 # ~3.5 s, 0.5 s granularity
            if job["abort"]:
                break
            time.sleep(0.5)

    def _fw_post_flash_verify():
        """ISM Ingecon.Identifica — best-effort re-read of FC11 AFTER a
        successful flash to confirm the unit booted the new firmware and
        refresh its reported version. READ-ONLY; never flips job["ok"]. The
        DSP reboots into the new image, so a couple of spaced retries give it
        time to come back; if it still can't be read we say so plainly rather
        than fail the (already-successful) flash."""
        old_model = (getattr(slave_id, "model_code", "") or "")
        new_model = None
        err = None
        for _attempt in range(3):
            if job["abort"]:
                break
            try:
                if link_serial:
                    sid = transport_obj.report_slave_id(int(slave),
                                                        timeout_s=3.0)
                else:
                    client = _registry.get_client()
                    if not client:
                        raise RuntimeError("no client for re-identify")
                    with bus_lock:
                        sid = _vendor_pdu.read_slave_id(client, int(slave),
                                                        timeout_s=3.0)
                new_model = (getattr(sid, "model_code", "") or "")
                break
            except Exception as e:
                err = e
                time.sleep(3.0)          # allow the DSP reboot to settle
        if new_model is not None:
            changed = (new_model.strip().upper()
                       != old_model.strip().upper())
            audit("firmware.live.verify_ok", {
                "host": job["host"], "node": node, "slave": slave,
                "old_model_code": old_model, "new_model_code": new_model,
                "changed": changed,
            })
            job["verify"] = {"ok": True, "old": old_model,
                             "new": new_model, "changed": changed}
            _prog(f"Verified — inverter now reports {new_model or '—'}", 100)
        else:
            audit("firmware.live.verify_warn", {
                "host": job["host"], "node": node, "slave": slave,
                "old_model_code": old_model,
                "error": str(err) if err else "no_reply",
            })
            job["verify"] = {"ok": False, "old": old_model,
                             "error": str(err) if err else "no_reply"}
            _prog("Flash done, but could not re-read identity (unit may "
                  "still be rebooting) — verify manually.", 100)

    # Injected transports are owned by US, not flash_inverter_node (it only
    # connects/closes a transport it created itself), so close it here.
    abortable = _AbortableTransport(transport_obj)
    try:
        with _fw_dryruns_lock:
            dry = _fw_dryruns.get(
                (expected_sha256, node, arg_dsp, frame_len, bool(legacy50)))
        res = _fw_tx.flash_inverter_node(
            firmware_path=path, node=node, arg_dsp=arg_dsp,
            frame_len=frame_len, legacy50=legacy50, mode="live",
            host=link_host, serial_port=link_serial,
            confirm_irreversible=True, dry_run_result=dry,
            bus_lock=bus_lock, audit=audit, slave_id=slave_id,
            allowed_dir=allowed_dir, expected_sha256=expected_sha256,
            allow_downgrade=allow_downgrade,
            transport=abortable, on_progress=_prog,
        )
        job["result"] = {
            "ok": res.ok, "frames_total": res.frames_total,
            "frames_acked": res.frames_acked, "no_replies": res.no_replies,
            "frame_chk_errors": res.frame_chk_errors,
            "flash_errors": res.flash_errors,
            "rx_frame_errors": res.rx_frame_errors,
            "message": res.message, "diag": res.diag(),
        }
        job["ok"] = bool(res.ok)
        if res.ok:
            # ISM re-identifies the node after each flash; mirror that as a
            # read-only confirmation step (guarded — a failure here never
            # un-does a successful flash).
            try:
                _fw_post_flash_verify()
            except Exception:
                pass
    except Exception as exc:  # FlashGateError / FirmwareError / abort / link
        job["ok"] = False
        job["error"] = str(exc)
    finally:
        try:
            abortable.close()
        except Exception:
            pass
        job["done"] = True
        # Release the bus lock immediately so the dashboard resumes
        # polling this inverter the moment the flash ends (success, fail,
        # or abort). The TTL is the backstop if this best-effort fails.
        try:
            _fw_lock.release(job_id)
        except Exception:
            pass

@app.post("/firmware/flash")
async def api_firmware_flash(req: Request):
    """Arm + start the IRREVERSIBLE live flash (background job).

    Body: { path | file, node, slave?, arg_dsp?, frame_len?, legacy50?,
            confirm_irreversible:true, expected_sha256, allow_downgrade? }

    This endpoint only *starts* the job and returns a job_id. Every actual
    safety refusal (no prior dry-run, bad sha, broadcast node, serial
    transport, identity/compat, …) is raised by flash_inverter_node on the
    worker and surfaced via GET /firmware/job/{id}. Node gates this route
    behind topology auth + the typed confirmation.
    """
    try:
        body = await req.json()
    except Exception:
        raise HTTPException(400, "invalid JSON")

    path, allowed_dir = _fw_resolve(body)
    node = int(body.get("node") or 0)
    slave = int(body.get("slave") or node)
    arg_dsp = int(body.get("arg_dsp") or 1)
    frame_len = int(body.get("frame_len") or 512)
    legacy50 = bool(body.get("legacy50") or False)
    allow_downgrade = bool(body.get("allow_downgrade") or False)
    expected_sha256 = str(body.get("expected_sha256") or "").strip().lower()

    if body.get("confirm_irreversible") is not True:
        raise HTTPException(400, "confirm_irreversible must be the boolean "
                            "true (typed operator confirmation)")
    if node <= 0:
        raise HTTPException(400, "node required")
    if not expected_sha256:
        raise HTTPException(400, "expected_sha256 required (the operator-"
                            "confirmed hash from the dry-run)")

    # Pick the link from the active calibrator transport. BOTH are
    # supported: TCP (via the transparent gateway) and RS485/RTU (the
    # most-direct path — no comm board / gateway in the loop). The
    # identity (FC11) read happens up-front so the compat/downgrade gate
    # has real data and the audit records exactly which unit.
    ttype = _registry.get_transport_type()
    bus_lock = _registry.get_lock()
    loop = asyncio.get_running_loop()
    link_host = None
    link_serial = None
    transport_obj = None

    if ttype == "tcp":
        link_host = _registry.get_tcp_ip()
        if not link_host:
            raise HTTPException(400, "no active TCP inverter selected")
        client = _registry.get_client()
        if not client:
            raise HTTPException(503, "no_client")

        def _read_id_tcp(c, lk, s):
            with lk:
                return _vendor_pdu.read_slave_id(c, int(s), timeout_s=3.0)

        try:
            slave_id = await loop.run_in_executor(
                None, _read_id_tcp, client, bus_lock, int(slave))
        except Exception as exc:
            raise HTTPException(502, "could not read inverter identity "
                                f"(FC11) before flashing: {exc}")
        # TCP transport is built lazily (worker connects on first frame).
        transport_obj = _fw_tx.ModbusVendorTcpTransport(link_host)

    elif ttype == "serial":
        cfg = _registry.get_serial_config()
        if not cfg:
            raise HTTPException(400, "no active serial transport")
        link_serial = cfg["port"]
        rtu = _fw_tx.ModbusVendorRtuTransport(
            cfg["port"], baudrate=cfg["baudrate"], parity=cfg["parity"],
            stopbits=cfg["stopbits"], bytesize=cfg["bytesize"],
            read_timeout_s=3.0)

        # A COM port can't be opened twice. Release the calibrator's
        # pymodbus serial client (UNDER the bus lock, so no other thread
        # is mid-read on it) so our raw RTU transport takes EXCLUSIVE
        # ownership for the whole flash (serial analogue of the bus-lock).
        def _arm_serial(lk):
            with lk:
                _registry.release_serial_port()
                rtu.connect()
                return rtu.report_slave_id(int(slave), timeout_s=3.0)

        def _restore_serial(lk):
            # Pre-arm failure must be NON-DESTRUCTIVE: give the operator
            # their calibrator serial session back (same contract as the
            # read-only identity peek). Once the worker actually starts,
            # exclusive ownership is intended and the operator reconnects
            # after — see the panel warning + User Guide.
            with lk:
                try:
                    _registry.set_serial_client(
                        cfg["port"], cfg["baudrate"], cfg["parity"],
                        cfg["stopbits"], cfg["bytesize"])
                    print(f"[CalibratorService-fw] pre-arm failed; restored "
                          f"operator serial client on {cfg['port']}",
                          flush=True)
                except Exception as rexc:
                    # Best-effort, never raise — but DON'T be silent: the
                    # operator must know their serial session is down so
                    # they can reconnect it in the calibrator.
                    print(f"[CalibratorService-fw] WARNING: could not "
                          f"restore operator serial client on "
                          f"{cfg['port']} after a failed pre-arm "
                          f"identity read: {rexc} — reconnect the "
                          f"transport manually", flush=True)

        try:
            slave_id = await loop.run_in_executor(
                None, _arm_serial, bus_lock)
        except Exception as exc:
            try:
                rtu.close()
            except Exception:
                pass
            try:
                await loop.run_in_executor(None, _restore_serial, bus_lock)
            except Exception:
                pass
            raise HTTPException(502, "could not read inverter identity "
                                f"(FC11) over RS485 before flashing: {exc}")
        transport_obj = rtu          # reuse the open handle for the flash

    else:
        raise HTTPException(400, "connect a transport first (Ethernet or "
                            "RS485-USB) before arming a firmware flash")

    link_label = link_host or f"serial:{link_serial}"
    _fw_prune_jobs()  # bound retained job memory before adding another
    job_id = "fw-" + os.urandom(6).hex()
    with _fw_jobs_lock:
        _fw_jobs[job_id] = {
            "id": job_id, "done": False, "ok": None, "error": None,
            "abort": False, "progress": [], "events": [], "result": None,
            "verify": None,
            "node": node, "slave": slave, "host": link_label,
            "file": os.path.basename(path), "started_ms": int(time.time() * 1000),
        }

    # Cross-process bus lock: tell the dashboard poller (separate process,
    # same transparent TCP->RTU gateway) to back off this inverter for the
    # duration so two Modbus masters don't collide and trip the DSP "error
    # code 2". TCP only — a serial flash has no IP the poller contends on.
    # Published BEFORE the worker connects so there is no contention window;
    # the worker heartbeats it and always releases in its finally.
    if link_host:
        try:
            _fw_lock.claim(link_host, node, slave, job_id)
        except Exception:
            pass  # bus lock is best-effort; never block the flash on it

    t = threading.Thread(
        target=_fw_live_worker, name=f"fw-flash-{job_id}",
        args=(job_id, path, node, slave, arg_dsp, frame_len, legacy50,
              expected_sha256, allow_downgrade, link_host, link_serial,
              transport_obj, bus_lock, slave_id, allowed_dir),
        daemon=True,
    )
    t.start()
    return {"ok": True, "job_id": job_id, "node": node, "slave": slave,
            "host": link_label, "file": os.path.basename(path)}

@app.get("/firmware/job/{job_id}")
async def api_firmware_job(job_id: str):
    """Poll a live-flash job: progress, audit events, and terminal result."""
    job = _fw_jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "unknown firmware job")
    return {
        "ok": True, "id": job_id, "done": job["done"],
        "flash_ok": job["ok"], "error": job["error"],
        "aborting": job["abort"], "node": job["node"],
        "slave": job["slave"], "host": job["host"], "file": job["file"],
        "progress": job["progress"], "events": job["events"],
        "result": job["result"], "verify": job.get("verify"),
    }

@app.post("/firmware/job/{job_id}/abort")
async def api_firmware_job_abort(job_id: str):
    """Cooperative abort. Takes effect at the next inter-frame boundary —
    the bootloader-preservation invariant means an interrupted app-flash
    leaves the unit re-flashable (banks 3/4 are never transmitted)."""
    job = _fw_jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "unknown firmware job")
    job["abort"] = True
    return {"ok": True, "id": job_id, "aborting": True,
            "done": job["done"]}

# ─── Entry point ────────────────────────────────────────────────────────

async def main():
    print(f"[CalibratorService] Starting on {CALIBRATOR_HOST}:{CALIBRATOR_PORT}")
    config = uvicorn.Config(
        app,
        host=CALIBRATOR_HOST,
        port=CALIBRATOR_PORT,
        log_level="critical",
        access_log=False,
    )
    server = uvicorn.Server(config)
    await server.serve()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("[CalibratorService] Stopping...")
        if _registry.get_client():
            _registry._close_current()
