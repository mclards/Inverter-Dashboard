"""
Modbus TCP transport layer for Ingeteam INGECON SUN inverter polling.

Authority & References:
  - Ingeteam INGECON SUN Modbus RTU specification (3-phase PowerMax 920TL)
    docs/IngeconSunPMax-Entire-Modbus-RTU-Registers.pdf (AAS1000ICB08)
  - v2.10.x revamp plan: plans/2026-05-10-modbus-registers-official-revamp.md

Supported Function Codes (FC):
  - FC 0x03 — Read Holding Registers (read_holding)
  - FC 0x04 — Read Input Registers (read_input)
  - FC 0x06 — Write Single Register (write_single)
  - FC 0x10 — Write Multiple Registers (write_multiple)

FD-Pressure Mitigations (Phase 6, v2.8.11+):
  - T3.7 — On socket exception, force clean reconnect to avoid FD leak
  - T3.10 — Re-apply socket timeout before every read (Windows TCP quirk)

Register Decoding Rules (Modbus standard):
  - UInt16 — 16-bit unsigned (registers 0–65535)
  - Int16 — 16-bit signed via two's complement (Slice α, v2.10.x+)
            Per spec, Idc (reg 30010) and PAC (reg 30019) are Int16.
  - UInt32 hi-lo — 32-bit unsigned as (hi<<16)|lo pair
            E.g., Etotal (regs 30001-30002), Alarmas (regs 30007-30008)

See services/inverter_engine.py for frame assembly and v2.10.x sign extension.
"""

from pymodbus.client import ModbusTcpClient
import time

# T3.7 + T3.10 fix (Phase 6, 2026-04-14):
#   T3.7 — On a TRUE exception during read (not just an isError() result),
#          the underlying socket may be in a corrupted state.  Close the
#          client so the next read forces a clean reconnect; pymodbus
#          handles reconnect transparently on the next call.  Without
#          this, FD pressure can accumulate over weeks of uptime.
#   T3.10 — pymodbus sets the timeout at construct/connect time, but
#           Windows TCP can reset SO_RCVTIMEO on long-idle sockets.
#           Re-apply socket.settimeout() before every read so a hang
#           cannot exceed the advertised timeout.  Best-effort: only
#           applies when the underlying socket attribute exists.
#
# Both are wrapped in try/except so a missing attribute on a future
# pymodbus version cannot break reads — the read still proceeds with
# whatever timeout is currently set.

def _refresh_timeout(client):
    """Best-effort re-apply socket timeout before a read."""
    try:
        sock = getattr(client, "socket", None)
        timeout = getattr(client, "timeout", None)
        if sock is not None and timeout is not None:
            sock.settimeout(float(timeout))
    except Exception:
        pass

def _close_quietly(client):
    try:
        client.close()
    except Exception:
        pass

def create_client(ip, port=502, timeout=1.0):
    """
    Create a persistent Modbus TCP client.
    timeout: TCP read timeout in seconds; configurable from dashboard settings.
    """
    try:
        client = ModbusTcpClient(
            host=ip,
            port=port,
            timeout=timeout,
            retries=0,
            reconnect_delay=0.0,
            reconnect_delay_max=0.0,
        )
    except TypeError:
        try:
            client = ModbusTcpClient(host=ip, port=port, timeout=timeout, retries=0)
        except TypeError:
            try:
                client = ModbusTcpClient(host=ip, port=port, timeout=timeout, retry_on_empty=False)
            except TypeError:
                client = ModbusTcpClient(host=ip, port=port, timeout=timeout)
    try:
        client.connect()
    except Exception:
        pass
    return client

def _call_modbus(fn, *args, **kwargs):
    slave = kwargs.pop("slave", kwargs.pop("unit", kwargs.pop("device_id", None)))
    if slave is not None:
        try:
            return fn(*args, slave=slave, **kwargs)
        except TypeError:
            try:
                return fn(*args, device_id=slave, **kwargs)
            except TypeError:
                try:
                    return fn(*args, unit=slave, **kwargs)
                except TypeError:
                    return fn(*args, **kwargs)
    return fn(*args, **kwargs)

def read_input(client, address, count, unit):
    _refresh_timeout(client)
    try:
        if hasattr(client, "connected") and not client.connected:
            try: client.connect()
            except Exception: pass
        r = _call_modbus(client.read_input_registers, address=address, count=count, slave=unit)
        if r and not r.isError() and hasattr(r, "registers"):
            return r.registers
    except Exception:
        # Force clean reconnect on next read; do NOT swallow the FD.
        _close_quietly(client)
    return None

def read_holding(client, address, count, unit):
    _refresh_timeout(client)
    try:
        if hasattr(client, "connected") and not client.connected:
            try: client.connect()
            except Exception: pass
        r = _call_modbus(client.read_holding_registers, address=address, count=count, slave=unit)
        if r and not r.isError() and hasattr(r, "registers"):
            return r.registers
    except Exception:
        _close_quietly(client)
    return None

def write_single(client, address, value, unit):
    """
    Safe FC6 single register write. Returns True on success.
    """
    try:
        r = _call_modbus(client.write_register, address, value, slave=unit)
        if r and not r.isError():
            return True
    except Exception:
        pass

    # reconnect and retry
    try:
        client.close()
    except Exception:
        pass

    time.sleep(0.1)

    try:
        client.connect()
    except Exception:
        pass

    time.sleep(0.1)

    try:
        r = _call_modbus(client.write_register, address, value, slave=unit)
        if r and not r.isError():
            return True
    except Exception:
        pass

    return False
