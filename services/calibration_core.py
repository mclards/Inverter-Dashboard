"""Field Calibration register I/O core — transport-agnostic.

This module contains the single-source logic for reading calibration data
from INGECON inverters. Functions are transport-neutral — the caller injects
a pymodbus-style client and a per-IP threading.Lock.

Shared by:
  - services/inverter_engine.py (FastAPI layer with async wrapper + fleet client map)
  - CalibratorService.py (serial Modbus client — future)

No I/O beyond Modbus; no SQLite; no FastAPI/uvicorn dependencies.
Register map & field decoder: services/calibration_decoder.py (import-only).

Plan: plans/2026-05-12-inverter-calibration-tool.md
"""
from __future__ import annotations

import time
from services import calibration_decoder as _calib_dec

# ─── Constants ────────────────────────────────────────────────────────────

_CALIB_READ_BASE  = _calib_dec.CALIBRATION_BLOCK_BASE   # 80
_CALIB_READ_COUNT = _calib_dec.CALIBRATION_BLOCK_LEN    # 15

def _call_client(fn, *args, **kwargs):
    unit = kwargs.pop("unit", None)
    if unit is not None:
        try:
            return fn(*args, device_id=unit, **kwargs)
        except TypeError:
            try:
                return fn(*args, slave=unit, **kwargs)
            except TypeError:
                return fn(*args, unit=unit, **kwargs)
    return fn(*args, **kwargs)

def _read_calibration_block_sync(client, lock, slave: int,
                                   base: int = _CALIB_READ_BASE,
                                   count: int = _CALIB_READ_COUNT) -> dict:
    """Blocking FC03 read of the calibration block. Returns raw regs.

    Caller holds the executor; we hold the per-IP lock only for the wire
    transaction (~50 ms) so the poller can resume immediately.
    """
    try:
        with lock:
            r = _call_client(client.read_holding_registers, address=base, count=count, unit=slave)
        if r is None:
            return {"ok": False, "error": "null_response"}
        if r.isError():
            return {"ok": False, "error": f"modbus_error: {r}"}
        regs = list(r.registers) if hasattr(r, "registers") else []
        if len(regs) < count:
            return {"ok": False, "error": f"short_frame: got {len(regs)}/{count}"}
        return {"ok": True, "regs": regs, "base": base, "count": count}
    except Exception as exc:
        return {"ok": False, "error": f"exception: {exc}"}

def _read_live_for_calibration_sync(client, lock, slave: int) -> dict:
    """Read the input registers that pair with each calibration scale factor."""
    out = {
        "vac1_v": None, "vac2_v": None, "vac3_v": None,
        "iac1_a": None, "iac2_a": None, "iac3_a": None,
        "vdc_v": None,  "idc_a": None,  "pac_w": None,
        "qac_var": None, "vpv_p_v": None, "vpv_n_v": None,
        "state_raw":       None,
        "state_phase":     None,
        "state_stop":      None,
        "state_blocked":   None,
        "state_grid_fault": None,
        "nominal_power_w": None,
        "pct_of_pn":       None,
        "read_at_ms": int(time.time() * 1000),
    }
    try:
        with lock:
            r1 = _call_client(client.read_input_registers, address=0, count=19, unit=slave)
            r2 = _call_client(client.read_input_registers, address=64, count=13, unit=slave)
        if r1 is not None and not r1.isError() and hasattr(r1, "registers"):
            regs = list(r1.registers)
            def g(i):
                return int(regs[i]) & 0xFFFF if i < len(regs) else None
            # Vac/Iac decoded raw — no scaling needed; matches what the LCD
            # shows. PAC at addr 18 is in WATTS via raw × 10 convention, but
            # we display the raw inverter value here so the operator sees
            # the same number the display shows during calibration.
            out["vdc_v"]  = g(8)
            # Idc (addr 9) and Pac (addr 18) are SIGNED int16 per the
            # INGECON Modbus reference (Reg 30010 Idc — signed, 1 A/LSB;
            # Reg 30019 Pac — signed, tens of W). At idle the Ipv sensor
            # zero-offset reads slightly negative (e.g. -18 A → 0xFFEE),
            # which displayed as 65518 A in the Utility Tool when this
            # path used u16. Fixed 2026-05-21.
            idc_raw = g(9)
            if idc_raw is not None:
                out["idc_a"] = idc_raw - 0x10000 if idc_raw & 0x8000 else idc_raw
            out["vac1_v"] = g(10)
            out["vac2_v"] = g(11)
            out["vac3_v"] = g(12)
            out["iac1_a"] = g(13)
            out["iac2_a"] = g(14)
            out["iac3_a"] = g(15)
            pac_raw = g(18)
            if pac_raw is not None:
                if pac_raw & 0x8000:
                    pac_raw -= 0x10000
                # raw × 10 = real W (PDF page 7, "30019 PAC in tens of Watt")
                out["pac_w"] = pac_raw * 10
        if r2 is not None and not r2.isError() and hasattr(r2, "registers"):
            regs2 = list(r2.registers)
            def g2(i):
                return int(regs2[i]) & 0xFFFF if i < len(regs2) else None
            # Qac at addr 68 (reg 4 of this read) — Int16 signed, raw × 10 = VAr.
            q_raw = g2(4)
            if q_raw is not None:
                if q_raw & 0x8000:
                    q_raw -= 0x10000
                out["qac_var"] = q_raw * 10
            # Estado bitfield at addr 73 (reg 9 of this read) — Slice κ.10.
            estado_raw = g2(9)
            if estado_raw is not None:
                out["state_raw"]        = estado_raw
                out["state_phase"]      = estado_raw & 0xFF
                out["state_stop"]       = 1 if (estado_raw & 0x0100) else 0
                out["state_blocked"]    = 1 if (estado_raw & 0x0200) else 0
                out["state_grid_fault"] = 1 if (estado_raw & 0x0400) else 0
            out["vpv_n_v"] = g2(10)   # addr 74
            out["vpv_p_v"] = g2(11)   # addr 75
            # NominalPower at addr 76 (reg 12 of this read) — reported in
            # tens of W; × 10 → W. Required for the Pac/Pn safety gate.
            nom_raw = g2(12)
            if nom_raw is not None:
                out["nominal_power_w"] = int(nom_raw) * 10
        # Derive %Pn for the operator-facing context. Defensive: skip when
        # nominal_power_w is 0/None so we never divide by zero.
        if out["pac_w"] is not None and out["nominal_power_w"]:
            try:
                out["pct_of_pn"] = round(
                    100.0 * float(out["pac_w"]) / float(out["nominal_power_w"]), 1,
                )
            except (TypeError, ValueError, ZeroDivisionError):
                out["pct_of_pn"] = None
    except Exception as exc:
        # Best-effort: any value we already populated stays; rest stays None.
        out["_warn"] = f"live_read_partial: {exc}"
    return out
