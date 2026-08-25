"""Golden test for the Utility Tool full-settings decoder.

Locks decode_full_settings() against the known 400152914R81 export
(audit 2026-05-19) and diff-locks decode_calibration_block() so the
Utility Tool work cannot regress the calibration scale-factor path.
"""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import calibration_decoder as cd  # noqa: E402

# HEXSETTINGS blob from docs/400152914R81.INGECONsettings (177 regs).
_BLOB = (
    "07EA 0005 000A 0013 0021 0020 024A 003C 0210 0000 003F 00E6 167F 1860 "
    "0000 0000 0001 5891 616D 0005 7311 0A73 01F4 0000 0000 0000 0000 0000 "
    "0000 0000 0000 00DF 002A 4147 0000 0000 0000 0000 0000 0000 0000 0000 "
    "0000 0000 0000 0000 0000 0000 0000 0000 0000 0000 0000 0000 0000 0000 "
    "0000 0000 0000 0000 0000 0000 0000 0000 0000 0000 0000 0000 0000 0000 "
    "0000 0000 0000 0000 0000 0000 0000 0000 0000 0000 1F1F 045B 0450 0468 "
    "0691 068A 069A 079C 03FF 040D 05A0 0787 01B5 1E22 FF42 0002 0001 17D4 "
    "170C 1860 7FFF 1D59 003C 003C 0131 0131 00BC 0000 16BC 1824 0003 0003 "
    "0E15 0131 0001 01C2 0001 7FFF 0069 0062 03E8 0000 03E8 0014 03E8 0032 "
    "FC7C 0064 FC7C 0064 0005 0032 0064 0064 0000 0000 0014 0005 12EB 005A "
    "0000 005C 0000 006C ED15 006E 0000 0064 005A 0032 0000 0000 0000 0000 "
    "00E6 00BC 1823 16BC 03E8 012C 0001 0004 00D1 7FFF 006C 0064 0073 0064 "
    "03FC 0037 004E 0170 0190 0000 0000 282D 0000"
)
REGS = [int(x, 16) for x in _BLOB.split()]

def _by_field(full):
    out = {}
    for rows in full["groups"].values():
        for r in rows:
            out[r["field"]] = r
    return out

def test_block_length():
    assert len(REGS) == 177

def test_full_settings_available_and_grouped():
    full = cd.decode_full_settings(REGS)
    assert full["available"] is True
    assert set(full["groups"]) >= {"B", "C", "D", "I"}
    # every surfaced field is read-only
    for rows in full["groups"].values():
        for r in rows:
            assert r["writable"] is False

def test_audit_values_match():
    f = _by_field(cd.decode_full_settings(REGS))
    # B — Node & Startup
    assert f["TiempoArranqueTension"]["decoded"] == 60
    assert f["VdcStart"]["decoded"] == 586
    assert f["VdcStop"]["decoded"] == 528
    # 2026-05-20 audit fix: HR_PutoNodoCanAttribute.Read returns
    # (raw - 1). Register 95 holds raw 2 in the test fixture, so ISM
    # (and now this decoder) shows CAN node 1.
    assert f["NumeroNodoCAN"]["decoded"] == 1
    assert f["NumeroNodoModbus"]["decoded"] == 1
    assert f["MarchaParo"]["decoded"] == "Marcha (run)"
    # C — Grid Protection
    assert f["Vacmin"]["decoded"] == 63
    assert f["Vacmax"]["decoded"] == 230
    assert f["Facmin"]["decoded"] == 57.59
    assert f["Facmax"]["decoded"] == 62.40
    assert f["FMin_Disc"]["decoded"] == 58.20
    assert f["FMax_Disc"]["decoded"] == 61.79
    # D — Power & Reactive
    assert f["PotenciaNominal"]["decoded"] == 226730
    assert f["PotenciaLimite"]["decoded"] == 249410
    assert f["TanFi"]["decoded"] == 0
    # 2026-05-20 audit fix: comp_reactiva_y2 was previously signed=True
    # in the cfg map (a hand-coded override). ISM declares the field
    # HR_UInt16Attribute, so the unsigned read 65346 is correct
    # (previously this test asserted -190 = 65346 - 65536, the two's-
    # complement misinterpretation).
    assert f["comp_reactiva_y2"]["decoded"] == 65346
    # I — Isolation & Temp
    assert f["KZdc"]["decoded"] == 5000
    assert f["AmbTempRedTemp"]["decoded"] == 78
    assert f["IMAXWithoutTempDerating"]["decoded"] == 400
    # A — identity (country code raw 0x2A = 42 = NGCP)
    assert f["CountryCode"]["decoded"] == 42
    assert f["ValidCfgCode"]["raw_hex"] == "0x1F1F"

# ─── Diff-lock: calibration scale-factor decode must NOT change ────────────

_CALIB_GOLDEN = {
    81: 1115, 82: 1104, 83: 1128, 84: 1681, 85: 1674, 86: 1690,
    87: 1948, 88: 1023, 89: 1037, 90: 1440,
    # 2026-05-20 audit fix: offset 94 (comp_reactiva_y2) was previously
    # signed (-190 = 65346 two's-complement). ISM declares it UInt16; the
    # unsigned 65346 is the correct readback. Offset 92 (comp_reactiva_y1)
    # holds a small positive value (437) so its display is unchanged.
    91: 1927, 92: 437, 93: 7714, 94: 65346,
}

def test_calibration_block_diff_locked():
    out = cd.decode_calibration_block(REGS, base_offset=0)
    assert out["valid_cfg_code_hex"] == "0x1F1F"
    assert out["valid_cfg_code_ok"] is True
    got = {row["offset"]: row["signed"] for row in out["fields"]}
    assert got == _CALIB_GOLDEN

def test_config_block_embeds_full():
    d = cd.decode_config_block(REGS)
    assert "full" in d and d["full"]["available"] is True
    assert d["calibration"]["valid_cfg_code_ok"] is True
    assert d["rtc"]["iso"] == "2026-05-10T19:33:32"
