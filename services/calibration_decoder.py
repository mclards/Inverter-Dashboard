"""Field Calibration register decoder — Phase 1 (read-only).

Decodes the INGECON SUN PowerMax three-phase config block (holding registers
0x0000..0x00B0, 177 UInt16s).  Layout extracted from
`FV.IngeBLL.Maquinas.TrifFot.Data.HoldingRegisters.CfgTrifAU` via .NET
reflection on `_ism/FV.IngeBLL.dll` and independently confirmed against
the user inverter's `.INGECONsettings` export (RTC offset 0-5, PotenciaNominal
at 17, etc.) and the display firmware string table (F_E_Vac1, Per. Vacio,
Pot. Reactiv_X1..X2, Comp. Reacti_Y1..Y2).

Calibration write target block (offsets 81-94) is **stable across all
firmware revisions since CfgTrif_V**, present in CfgTrifAS and CfgTrifAU.

This module is pure — no I/O, no SQLite, no Modbus.  The caller (the
FastAPI endpoint in services/inverter_engine.py) is responsible for
acquiring the per-IP lock and performing the FC03 read.  See the plan at
`plans/2026-05-12-inverter-calibration-tool.md` for full architecture.
"""
from __future__ import annotations

import datetime as _dt
import re
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

# ─── Block geometry ────────────────────────────────────────────────────────

# Whole config block as exported by ISM.  FC03 from offset 0, length 177.
CONFIG_BLOCK_BASE   = 0x0000
CONFIG_BLOCK_LENGTH = 177

# Calibration sub-block — what Phase 1 reads + Phase 2 will write.
# Includes offset 80 (ValidCfgCode) as a preflight integrity sentinel.
CALIBRATION_BLOCK_BASE  = 80
CALIBRATION_BLOCK_LEN   = 15   # offsets 80..94 inclusive

# The 14 writable scale-factor registers.  Tuple shape:
#   (offset, field_name, display_label, group, signed, description)
# `group` mirrors the display firmware submenu organization so the UI can
# render in the same order operators already know from the panel.
CALIBRATION_FIELDS: List[tuple] = [
    # offset, field,                display label,        group,         signed, description
    (81, "Fesc_vac_1",        "F_E_Vac1",          "AC Voltage", False, "AC voltage full-scale, phase 1 (J6/L1)"),
    (82, "Fesc_vac_2",        "F_E_Vac2",          "AC Voltage", False, "AC voltage full-scale, phase 2 (J7/L2)"),
    (83, "Fesc_vac_3",        "F_E_Vac3",          "AC Voltage", False, "AC voltage full-scale, phase 3 (J8/L3)"),
    (84, "Fesc_iac_1_baja",   "F_E_Iac1",          "AC Current", False, "AC current full-scale, phase 1 (IAC1, low-gain)"),
    (85, "Fesc_iac_2_baja",   "F_E_Iac2",          "AC Current", False, "AC current full-scale, phase 2 (IAC2)"),
    (86, "Fesc_iac_3_baja",   "F_E_Iac3",          "AC Current", False, "AC current full-scale, phase 3 (IAC3)"),
    (87, "Fesc_ipv",          "F_E_Ipv",           "DC",         False, "DC input current full-scale (IPV)"),
    (88, "Fesc_vpv_p",        "F_E_Vpvp",          "DC",         False, "DC voltage full-scale, positive input"),
    (89, "Fesc_vpv_n",        "F_E_Vpvn",          "DC",         False, "DC voltage full-scale, negative input"),
    (90, "comp_per_vacio",    "Per. Vacio",        "Active P",   False, "Self-consumption / standby comp"),
    (91, "comp_reactiva_x1",  "Pot. Reactiv_X1",   "Reactive 1", False, "Reactive curve X1 (Pn=20%)"),
    # 2026-05-20 audit fix: comp_reactiva_y1/y2 were forced signed=True
    # here, contradicting the ISM TSV (which declares both as plain
    # HR_UInt16Attribute). The signed read displayed register values
    # >= 32768 as large negative numbers in the Utility Tool while ISM
    # showed them as positive, producing a 65536-unit mismatch. They are
    # now UInt16 in both decode AND write paths, matching ISM.
    (92, "comp_reactiva_y1",  "Comp. Reacti_Y1",   "Reactive 1", False, "Reactive curve Y1"),
    (93, "comp_reactiva_x2",  "Pot. Reactiv_X2",   "Reactive 2", False, "Reactive curve X2 (Pn=70%)"),
    (94, "comp_reactiva_y2",  "Comp. Reacti_Y2",   "Reactive 2", False, "Reactive curve Y2"),
]

# Offsets present in the config block we also surface as read-only context.
# These help the operator confirm the inverter is in the expected configuration
# before any (future) calibration writes happen.
CONTEXT_FIELDS: List[tuple] = [
    # offset, field,                  description,                        decoder
    (6,   "VdcStart",               "DC start voltage threshold",        "u16"),
    (7,   "TiempoArranqueTension",  "Start-up time (s)",                 "u16"),
    (8,   "VdcStop",                "DC stop voltage threshold",         "u16"),
    (10,  "Vacmin",                 "AC voltage minimum",                "u16"),
    (11,  "Vacmax",                 "AC voltage maximum",                "u16"),
    (12,  "Facmin",                 "AC frequency minimum (Hz)",         "centesimas"),
    (13,  "Facmax",                 "AC frequency maximum (Hz)",         "centesimas"),
    (14,  "TanFi",                  "tan(phi) setpoint (raw)",           "u16"),
    (17,  "PotenciaNominal",        "Nominal active power (W)",          "decenas"),
    (18,  "PotenciaLimite",         "Limit active power (W)",            "decenas"),
    (32,  "CountryCode",            "Country / grid-standard code",      "u16hex"),
    (80,  "ValidCfgCode",           "Config-block validity marker",      "u16hex"),
]

# The marker the firmware writes after a successful ISM session.  A read that
# returns anything else means the block is in an unexpected state and Phase 2
# writes MUST refuse to proceed until an operator confirms via on-site spike.
VALID_CFG_CODE_EXPECTED = 0x1F1F

# ─── Decoders for the typed firmware attribute helpers ─────────────────────

def _signed16(u: int) -> int:
    u = int(u) & 0xFFFF
    return u - 0x10000 if u >= 0x8000 else u

def _decode_value(raw: int, decoder: str) -> Any:
    """Map ISM HR_*Attribute decorations onto Python primitives.

    `decoder` names mirror the .NET attribute suffixes so the table reads
    in lock-step with the source CfgTrif* classes.
    """
    u = int(raw) & 0xFFFF
    if decoder == "u16":
        return u
    if decoder == "u16hex":
        return f"0x{u:04X}"
    if decoder == "i16":
        return _signed16(u)
    if decoder == "centesimas":     # Int16, scale ÷ 100
        return round(_signed16(u) / 100.0, 4)
    if decoder == "decimas":        # Int16, scale ÷ 10
        return round(_signed16(u) / 10.0, 4)
    if decoder == "milesimas":      # Int16, scale ÷ 1000
        return round(_signed16(u) / 1000.0, 4)
    if decoder == "decenas":        # UInt16, scale × 10
        return u * 10
    raise ValueError(f"unknown decoder: {decoder}")

# ─── Pure decode ───────────────────────────────────────────────────────────

@dataclass
class CalibrationField:
    offset:    int
    field:     str
    label:     str
    group:     str
    raw_u16:   int
    signed:    int
    is_signed: bool
    desc:      str

def decode_calibration_block(regs: List[int],
                             base_offset: int = CALIBRATION_BLOCK_BASE) -> Dict[str, Any]:
    """Decode the 15-register calibration block (offsets 80..94).

    `regs` must be `regs[i]` = holding-register at wire offset `base_offset + i`.
    Tolerant of short reads (returns what it has plus an `incomplete` flag).
    """
    out_fields: List[Dict[str, Any]] = []
    incomplete = False
    valid_cfg_raw: Optional[int] = None
    for off, fld, label, group, signed, desc in CALIBRATION_FIELDS:
        idx = off - base_offset
        if 0 <= idx < len(regs):
            raw = int(regs[idx]) & 0xFFFF
            row = CalibrationField(
                offset=off, field=fld, label=label, group=group,
                raw_u16=raw,
                signed=_signed16(raw) if signed else raw,
                is_signed=bool(signed),
                desc=desc,
            )
            out_fields.append(row.__dict__)
        else:
            incomplete = True
    # ValidCfgCode sentinel at offset 80 (first register of the read window)
    sentinel_idx = 80 - base_offset
    if 0 <= sentinel_idx < len(regs):
        valid_cfg_raw = int(regs[sentinel_idx]) & 0xFFFF
    return {
        "fields":              out_fields,
        "valid_cfg_code_raw":  valid_cfg_raw,
        "valid_cfg_code_hex":  f"0x{valid_cfg_raw:04X}" if valid_cfg_raw is not None else None,
        "valid_cfg_code_ok":   valid_cfg_raw == VALID_CFG_CODE_EXPECTED,
        "incomplete":          incomplete,
    }

# ─── Full grouped settings (Utility Tool read-only tabs) ───────────────────
#
# Field/offset/kind map is generated from the ISM-reflected TSV into the
# committed artifact `cfg_trif_map.py` (no _spike/_ism runtime dependency).
# Enum *member* names are not in the artifact; boolean enums are decoded
# from their name-encoded polarity, the few multi-value enums actually used
# in the surfaced B/C/D/I tabs have a small curated table here.

try:                       # packaged / `from services import ...`
    from . import cfg_trif_map as _cfg_map           # type: ignore
except Exception:                                    # pragma: no cover
    try:
        import cfg_trif_map as _cfg_map              # type: ignore
    except Exception:
        _cfg_map = None                              # decode_full_settings degrades

# Curated multi-value enums (single-bit selectors in the requested tabs).
# Evidence: ISM CfgTrifAU field names + 2026-05-19 audit + 2026-05-21
# live cross-check against ISM page-2 screenshot ("DC Input Voltage
# Reference: MPPT" for the bit-1 = 0 state, which we previously rendered
# as "disabled" — wrong terminology for the field's actual semantics).
_CURATED_ENUMS = {
    "EnumMarchaParo":            {0: "Paro (stop)", 1: "Marcha (run)"},
    "eReferenciaTensionEntrada": {0: "MPPT", 1: "Fixed"},
    "eIdiomaLocalOIngles":       {0: "Local", 1: "English"},
}

# Boolean enums encode polarity in their type name — decode without the DLL.
_BOOL_ENUM_PATTERNS = [
    (re.compile(r"^e_?Si(\d)_No(\d)$"),                    ("YES", "no")),
    (re.compile(r"^e(\d)Activado_(\d)Desactivado$"),       ("ON", "off")),
    (re.compile(r"^e_(\d)OFF_(\d)ON$"),                    None),   # explicit
    (re.compile(r"^e_(\d)ON_(\d)OFF$"),                    None),
    (re.compile(r"^eHabilitado(\d)Deshab\d?$"),            ("ENABLED", "disabled")),
    (re.compile(r"^eDeshabilitado(\d)Habilitado(\d)$"),    ("disabled", "ENABLED")),
]

def _decode_enum_bit(enum_name: Optional[str], bit_val: int) -> str:
    if enum_name and enum_name in _CURATED_ENUMS:
        return _CURATED_ENUMS[enum_name].get(bit_val, str(bit_val))
    if enum_name:
        n = enum_name
        m = re.match(r"^e_?Si(\d)_No(\d)$", n)
        if m:
            return "YES" if bit_val == int(m.group(1)) else "no"
        m = re.match(r"^e(\d)Activado_(\d)Desactivado$", n)
        if m:
            return "ON" if bit_val == int(m.group(1)) else "off"
        m = re.match(r"^e_(\d)OFF_(\d)ON$", n)
        if m:
            return "OFF" if bit_val == int(m.group(1)) else "ON"
        m = re.match(r"^e_(\d)ON_(\d)OFF$", n)
        if m:
            return "ON" if bit_val == int(m.group(1)) else "OFF"
        m = re.match(r"^eHabilitado(\d)Deshab\d?$", n)
        if m:
            return "ENABLED" if bit_val == int(m.group(1)) else "disabled"
        m = re.match(r"^eDeshabilitado(\d)Habilitado(\d)$", n)
        if m:
            return "disabled" if bit_val == int(m.group(1)) else "ENABLED"
    return str(bit_val)

def _decode_one(regs: List[int], f: Dict[str, Any]) -> Dict[str, Any]:
    off = int(f["offset"])
    n = len(regs)
    raw = regs[off] & 0xFFFF if 0 <= off < n else None
    kind = f["kind"]
    decoded: Any = None
    if raw is None:
        decoded = None
    elif kind == "u16":
        decoded = raw
    elif kind == "i16":
        decoded = _signed16(raw)
    elif kind == "x10":
        decoded = raw * 10
    elif kind == "c100":
        decoded = round(_signed16(raw) / 100.0, 2)
    elif kind == "recta":
        decoded = round(raw / 63351.0 * 100.0, 2)
    elif kind == "can":
        # ISM HR_PutoNodoCanAttribute.Read (IL-verified 2026-05-20):
        #   display = (raw - 1) as u16
        # i.e. the inverter stores `(display + 1)` in the register. A
        # display value of "CAN node 1" lives at raw 2. The earlier
        # `raw & 0xFF` showed the raw register and was off-by-one
        # against ISM. Match ISM's wrap behaviour exactly so values are
        # bit-identical.
        decoded = (raw - 1) & 0xFFFF
    elif kind == "byte":
        decoded = {"lo": raw & 0xFF, "hi": raw >> 8}
    elif kind == "dt6" and off + 6 <= n:
        y, mo, dy, hr, mi, se = (regs[off + i] & 0xFFFF for i in range(6))
        decoded = f"{y:04d}-{mo:02d}-{dy:02d} {hr:02d}:{mi:02d}:{se:02d}"
    elif kind == "bits" and f.get("bits") is not None:
        spec = [int(b) for b in str(f["bits"]).split(";")]
        if len(spec) == 1:
            bv = (raw >> spec[0]) & 1
            decoded = _decode_enum_bit(f.get("enum"), bv)
        else:
            start, width = spec[0], spec[1]
            decoded = (raw >> start) & ((1 << width) - 1)
    else:
        decoded = raw
    return {
        "offset": off,
        "field": f["field"],
        "label": f.get("label") or f["field"],
        "group": f["group"],
        "unit": f.get("unit", ""),
        "raw_u16": raw,
        "raw_hex": (f"0x{raw:04X}" if raw is not None else None),
        "decoded": decoded,
        "writable": False,
    }

def decode_full_settings(regs: List[int]) -> Dict[str, Any]:
    """Decode the full categorized settings map for the Utility Tool tabs.

    Returns {available, group_titles, groups:{<letter>:[field,...]}}.
    Read-only — no write metadata, never references offsets 81-94 here
    (calibration scale factors stay owned by decode_calibration_block).
    """
    if _cfg_map is None or not getattr(_cfg_map, "FIELDS", None):
        return {"available": False, "group_titles": {}, "groups": {}}
    groups: Dict[str, List[Dict[str, Any]]] = {}
    for f in _cfg_map.FIELDS:
        row = _decode_one(regs, f)
        groups.setdefault(f["group"], []).append(row)
    return {
        "available": True,
        "group_titles": dict(getattr(_cfg_map, "GROUP_TITLES", {})),
        "groups": groups,
    }

def decode_config_block(regs: List[int]) -> Dict[str, Any]:
    """Decode the full 177-register config block when the caller requests it.

    Returns calibration sub-block + context fields (clock, nominal power,
    grid envelope, country code).  Used by the diagnostic view.
    """
    n = len(regs)
    # RTC mirror at offsets 0-5
    rtc: Optional[Dict[str, int]] = None
    if n >= 6:
        try:
            yr, mo, dy, hr, mi, se = (int(regs[i]) & 0xFFFF for i in range(6))
            # The firmware mirrors local RTC; we don't apply a timezone here.
            rtc = {"year": yr, "month": mo, "day": dy,
                   "hour": hr, "minute": mi, "second": se}
            # Provide ISO if it's a real-looking date.  Defensive: bad year
            # (e.g. 2047 RTC-stale pattern) should still be reported, not crash.
            try:
                _dt.datetime(yr, mo, dy, hr, mi, se)
                rtc["iso"] = f"{yr:04d}-{mo:02d}-{dy:02d}T{hr:02d}:{mi:02d}:{se:02d}"
            except ValueError:
                rtc["iso"] = None
        except Exception:
            rtc = None

    context: List[Dict[str, Any]] = []
    for off, fld, desc, dec in CONTEXT_FIELDS:
        if 0 <= off < n:
            try:
                value = _decode_value(regs[off], dec)
            except Exception:
                value = None
            context.append({
                "offset": off, "field": fld, "desc": desc,
                "value": value, "raw_u16": int(regs[off]) & 0xFFFF,
            })

    calib = decode_calibration_block(regs, base_offset=0)
    return {
        "rtc":        rtc,
        "context":    context,
        "calibration": calib,
        "full":       decode_full_settings(regs),
        "block_len":   n,
    }

# ─── Convenience: fleet-wide aggregation helper (Node-side will call this) ─

def summarize_fleet(per_node_states: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Given a list of per-(inverter, slave) decoded calibration states,
    compute per-field median + each node's delta vs median.  Useful for
    spotting modules that drifted out of family.

    Input shape: each entry must have `inverter`, `slave`, and
    `calibration.fields[*]` from `decode_calibration_block`.
    """
    by_field: Dict[str, List[int]] = {}
    for st in per_node_states:
        fields = (st.get("calibration") or {}).get("fields") or []
        for f in fields:
            by_field.setdefault(f["field"], []).append(int(f.get("signed", f["raw_u16"])))

    medians: Dict[str, float] = {}
    for k, vals in by_field.items():
        if not vals:
            continue
        s = sorted(vals)
        n = len(s)
        medians[k] = (s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2.0)

    enriched: List[Dict[str, Any]] = []
    for st in per_node_states:
        deltas: Dict[str, float] = {}
        fields = (st.get("calibration") or {}).get("fields") or []
        for f in fields:
            med = medians.get(f["field"])
            if med is None or med == 0:
                deltas[f["field"]] = None
            else:
                v = int(f.get("signed", f["raw_u16"]))
                deltas[f["field"]] = round((v - med) / med * 100.0, 3)
        enriched.append({
            "inverter": st.get("inverter"),
            "slave":    st.get("slave"),
            "deltas_pct": deltas,
            "valid_cfg_code_ok": (st.get("calibration") or {}).get("valid_cfg_code_ok"),
        })

    return {"medians": medians, "per_node": enriched}
