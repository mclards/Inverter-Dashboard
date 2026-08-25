"""Tests for services/cfg_block_write — the L2 config write encoder.

Pure unit tests, no I/O. Covers every kind v1 claims to support and pins
the refusal behaviour for the unsupported kinds + the non-writable
fields. Field metadata shapes mirror the cfg_trif_map.py FIELDS rows so
a future map regen can't silently break the contract.
"""

from __future__ import annotations

import pytest

from services.cfg_block_write import (
    CfgEncodeError,
    encode_value,
    is_writable_field,
    merge_bit,
)

def _meta(kind: str, field: str = "Test", bits=None) -> dict:
    return {
        "offset": 0, "field": field, "kind": kind, "enum": None,
        "bits": bits, "label": field, "group": "B", "unit": "",
        "signed": kind == "i16",
    }

# ─── u16 ──────────────────────────────────────────────────────────────

def test_u16_zero_and_max_accept():
    assert encode_value(_meta("u16"), 0) == 0
    assert encode_value(_meta("u16"), 65535) == 0xFFFF

def test_u16_string_input_accepts_decimal_and_hex():
    assert encode_value(_meta("u16"), "1000") == 1000
    assert encode_value(_meta("u16"), "0x64") == 0x64

def test_u16_negative_rejected():
    with pytest.raises(CfgEncodeError):
        encode_value(_meta("u16"), -1)

def test_u16_overflow_rejected():
    with pytest.raises(CfgEncodeError):
        encode_value(_meta("u16"), 65536)

# ─── i16 ──────────────────────────────────────────────────────────────

def test_i16_round_trip_negative():
    # -1 → two's-complement 0xFFFF
    assert encode_value(_meta("i16"), -1) == 0xFFFF
    assert encode_value(_meta("i16"), -32768) == 0x8000

def test_i16_positive_max():
    assert encode_value(_meta("i16"), 32767) == 0x7FFF

def test_i16_out_of_range_rejected():
    with pytest.raises(CfgEncodeError):
        encode_value(_meta("i16"), 32768)
    with pytest.raises(CfgEncodeError):
        encode_value(_meta("i16"), -32769)

# ─── x10 (nominal power, kW-class values) ─────────────────────────────

def test_x10_multiple_of_10_accepted():
    # Decoder: raw=500 → display 5000. So encoding 5000 → raw 500.
    assert encode_value(_meta("x10", "PotenciaNominal"), 5000) == 500
    assert encode_value(_meta("x10", "PotenciaNominal"), 0) == 0
    assert encode_value(_meta("x10", "PotenciaNominal"), 650000) == 65000

def test_x10_not_multiple_of_10_rejected_with_hint():
    with pytest.raises(CfgEncodeError) as exc:
        encode_value(_meta("x10", "PotenciaNominal"), 5005)
    msg = str(exc.value)
    assert "5000" in msg and "5010" in msg  # hint shows both nearest

def test_x10_negative_rejected():
    with pytest.raises(CfgEncodeError):
        encode_value(_meta("x10"), -10)

def test_x10_raw_overflow_rejected():
    # value=655360 would give raw=65536 — over u16 max
    with pytest.raises(CfgEncodeError):
        encode_value(_meta("x10"), 655360)

# ─── c100 (Hz / scaled-by-100 fields) ─────────────────────────────────

def test_c100_grid_frequencies():
    # 60.00 Hz → 6000
    assert encode_value(_meta("c100", "Facmin"), 60.00) == 6000
    assert encode_value(_meta("c100", "Facmax"), 50.00) == 5000

def test_c100_negative_decoded_as_signed():
    # -1.23 → -123 → two's-complement 0xFF85
    raw = encode_value(_meta("c100"), -1.23)
    assert raw == (0x10000 - 123) & 0xFFFF

def test_c100_rounding():
    # 60.005 → 6000 or 6001 (nearest int)
    raw = encode_value(_meta("c100"), 60.004)
    assert raw == 6000
    raw = encode_value(_meta("c100"), 60.006)
    assert raw == 6001

def test_c100_string_input():
    assert encode_value(_meta("c100"), "50.00") == 5000

def test_c100_out_of_range_rejected():
    with pytest.raises(CfgEncodeError):
        encode_value(_meta("c100"), 400.0)  # 40000 > i16 max

# ─── can (CAN node id, low byte) ──────────────────────────────────────

def test_can_encodes_display_plus_one():
    # ISM HR_PutoNodoCanAttribute.Refresh stores (display + 1).
    # Operator types "1" → wire holds raw 2. Operator types "0" → raw 1.
    assert encode_value(_meta("can"), 0) == 1
    assert encode_value(_meta("can"), 1) == 2
    assert encode_value(_meta("can"), 16) == 17
    assert encode_value(_meta("can"), 254) == 255

def test_can_overflow_rejected():
    with pytest.raises(CfgEncodeError):
        encode_value(_meta("can"), 255)  # +1 would overflow our chosen ceiling
    with pytest.raises(CfgEncodeError):
        encode_value(_meta("can"), -1)

# ─── bits (single-bit and multi-bit slices) ───────────────────────────

def test_bits_single_returns_0_or_1():
    m = _meta("bits", field="MarchaParo", bits="0")
    assert encode_value(m, 1) == 1
    assert encode_value(m, 0) == 0

def test_bits_single_rejects_other_values():
    m = _meta("bits", field="MarchaParo", bits="0")
    with pytest.raises(CfgEncodeError):
        encode_value(m, 2)

def test_bits_slice_range_check():
    m = _meta("bits", field="Multi", bits="4;3")  # 3-bit slice at pos 4
    assert encode_value(m, 0) == 0
    assert encode_value(m, 7) == 7
    with pytest.raises(CfgEncodeError):
        encode_value(m, 8)  # 8 > 2^3 - 1

def test_bits_missing_specifier_rejected():
    with pytest.raises(CfgEncodeError):
        encode_value(_meta("bits", bits=None), 1)

# ─── merge_bit (read-modify-write helper) ─────────────────────────────

def test_merge_single_bit_set():
    # current 0b0000 0000 0000 0000, set bit 3 → 0b0000 0000 0000 1000
    assert merge_bit(0x0000, "3", 1) == 0x0008

def test_merge_single_bit_clear_preserves_others():
    # current 0b0000 0000 1111 1111, clear bit 2 → 0b0000 0000 1111 1011
    assert merge_bit(0x00FF, "2", 0) == 0x00FB

def test_merge_multi_bit_slice():
    # 3-bit slice at pos 4, current 0, write 5 → bits 4-6 = 101
    assert merge_bit(0x0000, "4;3", 5) == (5 << 4)

def test_merge_multi_bit_preserves_surrounding():
    # surrounding bits set; slice [4:7] writes 0
    current = 0xFFFF
    result = merge_bit(current, "4;3", 0)
    # bits 4,5,6 cleared, everything else stays
    assert result == (current & ~(0b111 << 4))

def test_merge_bit_out_of_range_rejected():
    with pytest.raises(CfgEncodeError):
        merge_bit(0, "16", 1)  # bit 16 doesn't exist in u16

# ─── refusals: unsupported kinds + protected fields ───────────────────

@pytest.mark.parametrize("kind", ["dt6", "recta", "byte"])
def test_unsupported_kind_refused(kind):
    with pytest.raises(CfgEncodeError) as exc:
        encode_value(_meta(kind), 0)
    assert "not supported" in str(exc.value).lower()

@pytest.mark.parametrize("name", ["ValidCfgCode", "FechaConfiguracion", "NumGrabaciones"])
def test_protected_field_refused(name):
    with pytest.raises(CfgEncodeError) as exc:
        encode_value(_meta("u16", field=name), 0)
    assert "not writable" in str(exc.value).lower()

# ─── is_writable_field ────────────────────────────────────────────────

def test_writable_predicate_true_for_supported():
    assert is_writable_field(_meta("u16", field="Vacmin")) is True
    assert is_writable_field(_meta("c100", field="Facmin")) is True
    assert is_writable_field(_meta("bits", field="MarchaParo", bits="0")) is True

def test_writable_predicate_false_for_unsupported():
    assert is_writable_field(_meta("dt6")) is False
    assert is_writable_field(_meta("recta")) is False

def test_writable_predicate_false_for_protected():
    assert is_writable_field(_meta("u16", field="ValidCfgCode")) is False
    assert is_writable_field(_meta("u16", field="FechaConfiguracion")) is False

def test_writable_predicate_safe_on_garbage():
    assert is_writable_field(None) is False
    assert is_writable_field({}) is False
    assert is_writable_field({"kind": "u16"}) is True  # no field name → not protected
