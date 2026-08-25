"""Encoders + validators for L2 config-block writes (Utility Tool tabs B/C/D/I).

Mirror of services/calibration_decoder.py's _decode_one() in the WRITE
direction. Pure module — no I/O, no Modbus, no sockets. Callers must
acquire the per-IP transport lock and issue the FC16 write themselves;
this module only turns a user-supplied value into the raw uint16 (or
performs the read-modify-write merge for the `bits` kind).

Kind coverage in v1:
  u16, i16, x10, c100, can  — direct encoders
  bits                       — read-modify-write via merge_bit()
  dt6, recta, byte           — REFUSED (CfgEncodeError). dt6 is the
                               config-date stamp; recta is the calibration
                               line equation; byte packs two u8s. None
                               are safe to bulk-write from a flat input,
                               and ISM is the right tool for those.

NEVER writable (regardless of kind):
  ValidCfgCode       — sentinel, guarded separately by the write path
  FechaConfiguracion — same as kind=dt6 above; explicit belt+braces
  NumGrabaciones     — DSP-maintained write counter

The encoder is intentionally STRICT — out-of-range / wrong-multiple
values raise CfgEncodeError rather than silently quantizing. The UI shows
the error verbatim so the operator can correct the value.
"""

from __future__ import annotations

from typing import Any, Dict

class CfgEncodeError(ValueError):
    """Encoder refused the user-supplied value for a config field."""

# Kinds the v1 encoder does NOT support. The Python endpoint should
# return a 400 with a clear message rather than attempting to encode.
UNSUPPORTED_KINDS = frozenset({"dt6", "recta", "byte"})

# Field names that must never be written from this tool. ValidCfgCode is
# the integrity sentinel checked by the calibration write path; the
# Date and write-counter are DSP-maintained. Belt-and-braces against a
# future field-map change that flips a kind to a writable type.
NON_WRITABLE_FIELDS = frozenset({
    "ValidCfgCode",
    "FechaConfiguracion",
    "NumGrabaciones",
    # NumeroNodoModbus changes the inverter's Modbus slave address. Writing
    # it mid-session moves the unit to a NEW address, so the post-write
    # verify re-read (still issued on the OLD slave) fails/times out and the
    # tool's own transport can no longer reach the inverter — a self-brick
    # that also misreports the (actually-applied) write as "verify_failed".
    # Slave-address changes must be done on-site via ISM, where connectivity
    # can be re-established immediately. (audit CRITICAL-001, 2026-05-31)
    "NumeroNodoModbus",
})

def is_writable_field(field_meta: Dict[str, Any]) -> bool:
    """Return True iff this field's (kind, field name) is eligible for
    a Utility Tool write. The actual transport write still requires the
    lock + sentinel guard + verify cycle handled by the caller."""
    if not field_meta or not isinstance(field_meta, dict):
        return False
    if str(field_meta.get("field") or "") in NON_WRITABLE_FIELDS:
        return False
    kind = str(field_meta.get("kind") or "").strip()
    if not kind:
        # A field with no kind has no encoder — refuse it, matching
        # encode_value() which raises CfgEncodeError on a missing kind.
        # (audit CFG-001, 2026-05-31)
        return False
    return kind not in UNSUPPORTED_KINDS

def encode_value(field_meta: Dict[str, Any], value: Any) -> int:
    """Turn a user-supplied value into the raw uint16 to write.

    For kind=bits the returned value is the bit-field value (0/1 or
    small int); the CALLER must use merge_bit() to splice it into the
    current register before issuing the write. For every other kind the
    returned value can be written directly via FC16.

    Raises CfgEncodeError on any problem — UNSUPPORTED kind, out-of-range,
    wrong type, or a non-writable field. The caller surfaces the message
    to the UI verbatim.
    """
    if not field_meta or not isinstance(field_meta, dict):
        raise CfgEncodeError("missing field metadata")
    field = str(field_meta.get("field") or "")
    kind = str(field_meta.get("kind") or "")

    if field in NON_WRITABLE_FIELDS:
        raise CfgEncodeError(f"field '{field}' is not writable")
    if kind in UNSUPPORTED_KINDS:
        raise CfgEncodeError(
            f"kind '{kind}' is not supported for write in v1 — use ISM "
            f"for this field")
    if not kind:
        raise CfgEncodeError("field metadata missing 'kind'")

    try:
        if kind == "u16":
            v = _to_int(value, "u16")
            _check_range(v, 0, 65535, field, kind)
            return v & 0xFFFF

        if kind == "i16":
            v = _to_int(value, "i16")
            _check_range(v, -32768, 32767, field, kind)
            return v & 0xFFFF

        if kind == "x10":
            # The decoder returns `raw * 10`; the user enters the natural
            # value. Reverse: raw = value / 10. Enforce multiple-of-10 so
            # a user-typed "5005" doesn't silently round to 5000.
            v = _to_int(value, "x10")
            if v < 0:
                raise CfgEncodeError(
                    f"{field}: x10 value must be >= 0 (got {v})")
            if v % 10 != 0:
                raise CfgEncodeError(
                    f"{field}: x10 value must be a multiple of 10 "
                    f"(got {v}; try {v // 10 * 10} or {(v // 10 + 1) * 10})")
            raw = v // 10
            _check_range(raw, 0, 65535, field, "x10 raw")
            return raw & 0xFFFF

        if kind == "c100":
            # Decoder: round(_signed16(raw) / 100.0, 2). Reverse: round(v*100).
            f = _to_float(value, "c100")
            raw = int(round(f * 100.0))
            _check_range(raw, -32768, 32767, field, "c100 raw")
            return raw & 0xFFFF

        if kind == "can":
            # ISM HR_PutoNodoCanAttribute.Refresh (IL-verified 2026-05-20):
            #   regs[offset] = (display + 1) as u16
            # The operator types the natural CAN node number (e.g. "1");
            # we store (n + 1) on the wire. Display range is 0..254 so
            # the stored register stays inside 1..255 (typical CAN IDs).
            v = _to_int(value, "can")
            _check_range(v, 0, 254, field, kind)
            return (v + 1) & 0xFFFF

        if kind == "bits":
            # Decoder returns the enum for single-bit or the int for a
            # multi-bit slice. Encoder returns the SAME shape — caller
            # merges via merge_bit() once the current u16 is known.
            spec = str(field_meta.get("bits") or "")
            parts = [int(b) for b in spec.split(";") if b != ""]
            if not parts:
                raise CfgEncodeError(
                    f"{field}: bits field missing 'bits' specifier")
            if len(parts) == 1:
                v = _to_int(value, "bits")
                if v not in (0, 1):
                    raise CfgEncodeError(
                        f"{field}: single-bit value must be 0 or 1 (got {v})")
                return v
            start, width = parts[0], parts[1]
            v = _to_int(value, "bits")
            hi = (1 << width) - 1
            _check_range(v, 0, hi, field, f"bits[{start}:{start + width}]")
            return v

        raise CfgEncodeError(f"unknown kind '{kind}'")

    except CfgEncodeError:
        raise
    except (TypeError, ValueError) as exc:
        raise CfgEncodeError(f"{field}: {exc}") from exc

def merge_bit(current_register: int, bit_spec: str, new_bits: int) -> int:
    """For kind=bits — fold `new_bits` into the current 16-bit register.

    `bit_spec` is the same string the field metadata carries:
      "0"      → single bit at position 0
      "4;3"    → 3-bit field starting at bit 4 (inclusive)
    """
    cur = int(current_register) & 0xFFFF
    spec = [int(b) for b in str(bit_spec).split(";") if b != ""]
    if not spec:
        raise CfgEncodeError("merge_bit: empty bit spec")
    if len(spec) == 1:
        pos = spec[0]
        if pos < 0 or pos > 15:
            raise CfgEncodeError(f"merge_bit: bit position {pos} out of range")
        b = int(new_bits) & 1
        return ((cur & ~(1 << pos)) | (b << pos)) & 0xFFFF
    start, width = spec[0], spec[1]
    if start < 0 or width < 1 or start + width > 16:
        raise CfgEncodeError(
            f"merge_bit: slice [{start}:{start + width}] out of range")
    mask = ((1 << width) - 1) << start
    return ((cur & ~mask) | ((int(new_bits) & ((1 << width) - 1)) << start)) & 0xFFFF

# ── internal helpers ──────────────────────────────────────────────────────

def _to_int(v: Any, kind: str) -> int:
    if isinstance(v, bool):
        return int(v)
    if isinstance(v, int):
        return v
    if isinstance(v, float):
        if not v.is_integer():
            raise CfgEncodeError(f"{kind} value must be integer (got {v})")
        return int(v)
    s = str(v).strip()
    if not s:
        raise CfgEncodeError(f"{kind} value is empty")
    return int(s, 0)  # supports "100", "0x64", "0b1100100"

def _to_float(v: Any, kind: str) -> float:
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip()
    if not s:
        raise CfgEncodeError(f"{kind} value is empty")
    return float(s)

def _check_range(v, lo, hi, field, label):
    if v < lo or v > hi:
        raise CfgEncodeError(
            f"{field}: {label} value {v} out of range [{lo}, {hi}]")
