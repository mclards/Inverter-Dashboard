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

# ─── Core sync functions (blocking, Modbus client injected) ────────────────

def _read_calibration_block_sync(client, lock, slave: int,
                                  base: int = _CALIB_READ_BASE,
                                  count: int = _CALIB_READ_COUNT) -> dict:
    """Blocking FC03 read of the calibration block. Returns raw regs.

    Caller holds the executor; we hold the per-IP lock only for the wire
    transaction (~50 ms) so the poller can resume immediately.
    """
    try:
        with lock:
            r = client.read_holding_registers(address=base, count=count, slave=slave)
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
    """Read the input registers that pair with each calibration scale factor.

    Used by the Field Calibration page so the operator sees the LIVE measured
    value (Vac, Iac, Vdc, Idc, Pac, Qac) alongside the scale factor being
    edited. Mirrors the TrinPM20 video workflow: read the display value,
    compare to the external meter, modify scale factor until they match.

    Two FC04 reads under one lock acquisition:
      • addr 0,  count 19 → Vdc(8), Idc(9), Vac1-3(10-12), Iac1-3(13-15), Pac(18)
      • addr 64, count 13 → Qac(68), Estado(73), VpvN(74), VpvP(75), NomPower(76)

    Returns a dict with each live value or None on per-field failure.  Never
    raises — calibration state must remain readable even if the input regs
    are momentarily unavailable.

    v2.11.0-beta.6 — Slice κ.10 TrinPM20 gates: extended count 12→13 to
    include input reg 30077 (NominalPower ÷ 10). Adds `state_raw` (Estado
    bitfield from reg 30074) and `nominal_power_w` so calibration safety
    gates can refuse Fesc_ipv writes below 70 % Pn, refuse reactive-curve
    writes at the wrong consign target, and refuse any write while the
    inverter is in `error`/`blocked` phase. See server/calibrationRoutes
    requireSafeForOffset gate.
    """
    out = {
        "vac1_v": None, "vac2_v": None, "vac3_v": None,
        "iac1_a": None, "iac2_a": None, "iac3_a": None,
        "vdc_v": None,  "idc_a": None,  "pac_w": None,
        "qac_var": None, "vpv_p_v": None, "vpv_n_v": None,
        # Slice κ.10 — TrinPM20 safety-gate fields:
        "state_raw":       None,    # Estado bitfield (reg 30074)
        "state_phase":     None,    # decoded low-byte phase (0=initial, 1=init-mag, 2=grid-connected, 3=error)
        "state_stop":      None,    # bit 8 — 1 = stop, 0 = run
        "state_blocked":   None,    # bit 9 — 1 = blocked
        "state_grid_fault": None,   # bit 10 — 1 = grid fault detected
        "nominal_power_w": None,    # reg 30077 × 10
        "pct_of_pn":       None,    # pac_w / nominal_power_w × 100 (rounded 0.1)
        "read_at_ms": int(time.time() * 1000),
    }
    try:
        with lock:
            r1 = client.read_input_registers(address=0, count=19, slave=slave)
            r2 = client.read_input_registers(address=64, count=13, slave=slave)
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
