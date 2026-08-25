"""Regression test: the committed cfg_trif_map.FIELDS must match the
ISM ground-truth TSV (_spike/cfg_trif_AU_map.tsv) for every field we
expose to the Utility Tool.

This locks the 2026-05-20 audit finding: comp_reactiva_y1 / y2 had a
hand-coded override forcing them to signed i16, but the ISM TSV
declares them as plain UInt16. The forced signed read produced wrong
values (>= 32768 displayed as a large negative number) and contaminated
the prior "Y-drift" observation. Any future regen / hand-edit that
re-introduces a kind mismatch fails this test loudly.
"""
from __future__ import annotations

import os
import re

import pytest

from services.cfg_trif_map import FIELDS

_TSV_PATH = os.path.join(
    os.path.dirname(__file__), "..", "..", "_spike", "cfg_trif_AU_map.tsv"
)

# Map our `kind` to the ISM HR_*Attribute or HREnumAsBitArray family.
_KIND_TO_ISM = {
    "u16":   {"UInt16"},
    "i16":   {"Int16"},
    "c100":  {"Int16Centesimas2Single"},
    "x10":   {"UInt16Decenas"},
    "recta": {"recta"},
    "dt6":   {"DateTime"},
    "can":   {"PutoNodoCan", "UInt16"},
    "byte":  {"Byte", "ByteLo", "ByteHi"},
    "bits":  {"BitArray"},
}

def _parse_ism_tsv():
    """Return dict[field] = (offset, ism_kind_token). Pure parser."""
    if not os.path.exists(_TSV_PATH):
        pytest.skip(f"ISM TSV not present: {_TSV_PATH}")
    out = {}
    with open(_TSV_PATH, "r", encoding="utf-8-sig") as fh:
        next(fh)
        for ln in fh:
            ln = ln.rstrip()
            if not (ln.startswith("CfgTrif") or ln.startswith("CfgTrifAU")):
                continue
            parts = ln.split("\t")
            if len(parts) < 4:
                continue
            _cls, field, _ftype, attrs = parts
            # Probe the various attribute shapes in order; first match wins.
            m = re.search(r"HR_([A-Za-z0-9_]+?)Attribute\((\d+)\)", attrs)
            be = re.search(
                r"HREnumAsBitArrayAttribute\((\d+),\[([^\]]+)\]", attrs)
            he = re.search(r"HoldingRegisterEnumAttribute\((\d+)", attrs)
            recta = re.search(r"HR_recta[A-Za-z0-9_]*\((\d+)\)", attrs)
            dt = re.search(r"HR_DateTimeAttribute\((\d+)\)", attrs)
            if m:
                out[field] = (int(m.group(2)), m.group(1))
            elif be:
                out[field] = (int(be.group(1)), "BitArray")
            elif he:
                out[field] = (int(he.group(1)), "HoldingEnum")
            elif recta:
                out[field] = (int(recta.group(1)), "recta")
            elif dt:
                out[field] = (int(dt.group(1)), "DateTime")
    return out

def test_every_committed_field_matches_ism_offset():
    ism = _parse_ism_tsv()
    for f in FIELDS:
        name = str(f.get("field") or "")
        if name not in ism:
            # Some fields (calibration scale factors) are handled in
            # calibration_decoder, not cfg_trif_map. Skip those if the
            # committed map decides to expose them anyway.
            continue
        ism_off, _ism_kind = ism[name]
        assert int(f["offset"]) == ism_off, (
            f"{name}: cfg_trif_map offset={f['offset']} disagrees with ISM "
            f"offset={ism_off}"
        )

def test_every_committed_field_matches_ism_kind():
    ism = _parse_ism_tsv()
    for f in FIELDS:
        name = str(f.get("field") or "")
        if name not in ism:
            continue
        _off, ism_kind = ism[name]
        allowed = _KIND_TO_ISM.get(str(f["kind"]), set())
        assert ism_kind in allowed, (
            f"{name}: cfg_trif_map kind={f['kind']!r} (expects one of "
            f"{sorted(allowed)}) disagrees with ISM kind={ism_kind!r}"
        )

def test_reactive_y_coords_are_unsigned():
    """Pin the 2026-05-20 audit fix in place."""
    by_field = {f["field"]: f for f in FIELDS}
    for name in ("comp_reactiva_y1", "comp_reactiva_y2"):
        meta = by_field.get(name)
        assert meta is not None, f"{name} missing from cfg_trif_map.FIELDS"
        assert meta["kind"] == "u16", (
            f"{name} must be u16 (ISM declares UInt16); a signed read "
            f"distorts any register value >= 32768 into a large negative."
        )
        assert meta["signed"] is False, f"{name}.signed must be False"

def test_calibration_decoder_y_coords_are_unsigned():
    """Same guarantee on the calibration write path (offsets 92, 94)."""
    from services.calibration_decoder import CALIBRATION_FIELDS
    by_off = {row[0]: row for row in CALIBRATION_FIELDS}
    for off, name in ((92, "comp_reactiva_y1"), (94, "comp_reactiva_y2")):
        row = by_off.get(off)
        assert row is not None, f"calibration row at offset {off} missing"
        assert row[1] == name, f"offset {off}: expected {name}, got {row[1]}"
        # row tuple: (offset, field, label, group, signed, desc)
        assert row[4] is False, (
            f"calibration_decoder offset {off} ({name}) must be unsigned "
            f"(ISM declares UInt16)"
        )

def test_can_kind_is_off_by_one_against_raw():
    """ISM HR_PutoNodoCanAttribute stores (display + 1) in the register.

    The IL was disassembled 2026-05-20 (32-bit PowerShell on FV.IngeBLL):
        Read:    return (regs[offset] - 1) as u16
        Refresh: regs[offset] = (input + 1) as u16

    Earlier our decoder did `raw & 0xFF` which displayed the raw register
    and was off-by-one against ISM (operator saw 2 where ISM showed 1).
    This test pins both the decoder and the encoder against that fix.
    """
    from services.calibration_decoder import _decode_one
    meta = {"offset": 0, "field": "NumeroNodoCAN", "kind": "can",
            "enum": None, "bits": None, "label": "NumeroNodoCAN",
            "group": "B", "unit": "", "signed": False}
    # raw 2 -> display 1, raw 1 -> display 0, raw 17 -> display 16
    assert _decode_one([2], meta)["decoded"] == 1
    assert _decode_one([1], meta)["decoded"] == 0
    assert _decode_one([17], meta)["decoded"] == 16

    from services.cfg_block_write import encode_value
    assert encode_value(meta, 1) == 2
    assert encode_value(meta, 0) == 1
    assert encode_value(meta, 16) == 17
