"""Calibration write pipeline â€” Phase 2 of the Field Calibration tool.

Plan: plans/2026-05-12-inverter-calibration-tool.md Â§3
Mirrors the proven `services/serial_io.py` pattern:

    UNLOCK  â†’  WRITE-ONE or WRITE-BULK  â†’  SLEEP(1000 ms)  â†’  VERIFY (FC03 read-back)

All four Modbus exchanges happen under a single per-IP lock acquisition so
the poller cannot interleave between unlock and write.  The unlock magic
(`0xFFFA â† [0x0065, 0x07A7]`) is the same gate proven on hardware for the
serial-number write (Slice C, 2026-04-27).  Whether the same magic gates
the calibration window (offsets 81-94) is open question Â§4.1 of the plan
â€” this module is the implementation; the on-site spike confirms scope.

The module is pure-Python with no SQLite/HTTP â€” the caller
(FastAPI endpoint in `services/inverter_engine.py`) provides the locked
client and audits the result via Node.

Safety preflight (always-on):
  1. Read offset 80 (ValidCfgCode) â€” must be 0x1F1F or operation refuses
  2. Read target offset before write â€” captures `value_before` for audit
  3. After write + sleep, read target offset back â€” pass if matches
  4. Re-read offset 80 â€” confirm sentinel survived the write
"""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Dict, Iterable, List, Optional, Tuple

try:
    from calibration_decoder import (
        CALIBRATION_FIELDS,
        VALID_CFG_CODE_EXPECTED,
    )
except ImportError:
    try:
        from services.calibration_decoder import (
            CALIBRATION_FIELDS,
            VALID_CFG_CODE_EXPECTED,
        )
    except ImportError:
        CALIBRATION_FIELDS = {}
        VALID_CFG_CODE_EXPECTED = 0x55AA

# â”€â”€â”€ Wire constants (shared with serial_io) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

UNLOCK_REGISTER = 0xFFFA
UNLOCK_VALUES   = (0x0065, 0x07A7)

VALID_CFG_OFFSET = 80
VERIFY_DELAY_S   = 1.0
DEFAULT_TIMEOUT_S = 3.0

# v2.11.x â€” verify tolerance band. Operator preference (2026-05-13):
# the inverter quantizes some scale factors internally (writing 1884
# may land on 1814 because the firmware rounds to a coarser step).
# Treating that as a hard "Write failed: readback mismatch" was alarming
# and inaccurate â€” the write DID land, just on a quantization grid.
# We now mark the write as successful when the readback is within
# either Â±5 % OR Â±10 absolute units of the requested value (whichever
# is larger), and surface a `quantized=true` flag + note instead of an
# error. Anything outside that band is still a true verify failure
# (e.g. write didn't take, register was clobbered by a parallel read).
VERIFY_TOLERANCE_PCT       = 5.0
VERIFY_TOLERANCE_ABS_UNITS = 10

# â”€â”€â”€ Errors â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

class CalibIoError(Exception):
    """Operational failure during the calibration pipeline."""

class CalibRangeError(CalibIoError):
    """Caller asked us to write outside the allowed offset window or with
    a value far outside the current value (range guard)."""

class CalibPreflightError(CalibIoError):
    """Sentinel / safety preflight failed; do NOT write."""

# â”€â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

# offset -> (field, is_signed, label)
_FIELD_INDEX: Dict[int, Tuple[str, bool, str]] = {
    off: (field, signed, label)
    for off, field, label, _group, signed, _desc in CALIBRATION_FIELDS
}

ALLOWED_OFFSETS = frozenset(_FIELD_INDEX.keys())   # {81..94}

def is_writable_offset(off: int) -> bool:
    return int(off) in ALLOWED_OFFSETS

def field_for_offset(off: int) -> Optional[str]:
    e = _FIELD_INDEX.get(int(off))
    return e[0] if e else None

def is_signed_offset(off: int) -> bool:
    e = _FIELD_INDEX.get(int(off))
    return bool(e and e[1])

def _u16(value: int) -> int:
    """Encode a Python int (possibly signed) as a UInt16 the wire wants."""
    v = int(value)
    if v < 0:
        v = (v + 0x10000) & 0xFFFF
    return v & 0xFFFF

def _signed16(u: int) -> int:
    u = int(u) & 0xFFFF
    return u - 0x10000 if u >= 0x8000 else u

# â”€â”€â”€ Modbus operations (sync â€” caller MUST hold lock) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def _do_unlock(client, slave: int) -> None:
    try:
        r = client.write_registers(
            address=UNLOCK_REGISTER,
            values=list(UNLOCK_VALUES),
            unit=int(slave),
        )
    except Exception as exc:
        raise CalibIoError(f"unlock_exception: {exc}") from exc
    if r is None or r.isError():
        raise CalibIoError(f"unlock_modbus_error: {r}")

def _do_write_one(client, slave: int, offset: int, value_u16: int) -> None:
    try:
        # Single-register write via FC16 (write_registers with one value)
        # â€” same path the serial write uses, more uniform than FC06.
        r = client.write_registers(
            address=int(offset),
            values=[int(value_u16) & 0xFFFF],
            unit=int(slave),
        )
    except Exception as exc:
        raise CalibIoError(f"write_exception: {exc}") from exc
    if r is None or r.isError():
        raise CalibIoError(f"write_modbus_error: {r}")

def _do_write_bulk(client, slave: int, base_offset: int, values_u16: List[int]) -> None:
    try:
        r = client.write_registers(
            address=int(base_offset),
            values=[int(v) & 0xFFFF for v in values_u16],
            unit=int(slave),
        )
    except Exception as exc:
        raise CalibIoError(f"write_bulk_exception: {exc}") from exc
    if r is None or r.isError():
        raise CalibIoError(f"write_bulk_modbus_error: {r}")

def _do_read_block(client, slave: int, base: int, count: int) -> List[int]:
    """Read `count` UInt16s starting at `base`. Raises on Modbus failure."""
    try:
        r = client.read_holding_registers(address=int(base), count=int(count), unit=int(slave))
    except Exception as exc:
        raise CalibIoError(f"read_exception: {exc}") from exc
    if r is None or r.isError():
        raise CalibIoError(f"read_modbus_error: {r}")
    regs = list(r.registers) if hasattr(r, "registers") else []
    if len(regs) < count:
        raise CalibIoError(f"read_short_frame: got {len(regs)}/{count}")
    return [int(v) & 0xFFFF for v in regs]

def _preflight(client, slave: int) -> Dict[str, object]:
    """Read offset 80 + 81-94. Returns the full read; raises if sentinel
    isn't `VALID_CFG_CODE_EXPECTED` (`0x1F1F`)."""
    regs = _do_read_block(client, int(slave), VALID_CFG_OFFSET, 15)
    sentinel = regs[0]
    if sentinel != VALID_CFG_CODE_EXPECTED:
        raise CalibPreflightError(
            f"ValidCfgCode = 0x{sentinel:04X}, expected 0x{VALID_CFG_CODE_EXPECTED:04X}; "
            f"calibration block is in an unexpected state; refusing write"
        )
    return {
        "sentinel":  sentinel,
        "regs":      regs,
        "by_offset": {VALID_CFG_OFFSET + i: regs[i] for i in range(len(regs))},
    }

# â”€â”€â”€ Range guard â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def validate_value(offset: int, new_value: int, current_value: Optional[int],
                   *, max_delta_pct: float = 50.0) -> None:
    """Refuse obvious mistakes:
      â€¢ offset must be in the writable set
      â€¢ value must fit UInt16 (or Int16 if signed)
      â€¢ if `current_value` is known and != 0, `|new - cur| / |cur| <= max_delta_pct`

    Operator can opt out of the % guard by passing `max_delta_pct=None`.
    """
    if not is_writable_offset(offset):
        raise CalibRangeError(f"offset {offset} is not in the writable set {sorted(ALLOWED_OFFSETS)}")
    v = int(new_value)
    if is_signed_offset(offset):
        if v < -0x8000 or v > 0x7FFF:
            raise CalibRangeError(f"signed value {v} out of Int16 range")
    else:
        if v < 0 or v > 0xFFFF:
            raise CalibRangeError(f"unsigned value {v} out of UInt16 range")
    if max_delta_pct is None or current_value is None:
        return
    cur = int(current_value)
    # Normalize current to the same numeric domain as `new_value`. For signed
    # offsets, the by_offset dict carries the UInt16 wire form (e.g. 65171
    # for what is really -365 on Int16). Convert before delta comparison so
    # the guard doesn't blow up on negative writes.
    if is_signed_offset(offset) and cur > 0x7FFF:
        cur = cur - 0x10000
    if cur == 0:
        return    # %-delta meaningless against zero baseline; let it through
    delta_pct = abs(v - cur) / abs(cur) * 100.0
    if delta_pct > float(max_delta_pct):
        raise CalibRangeError(
            f"new value {v} differs from current {cur} by {delta_pct:.1f}% "
            f"(guard {max_delta_pct:.1f}%); pass `max_delta_pct=null` to force"
        )

# â”€â”€â”€ Public write APIs â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

@dataclass
class WriteOneResult:
    ok:             bool
    status:         str
    offset:         int
    field:          str
    value_before:   Optional[int]
    value_requested: int
    value_after:    Optional[int]
    verify_ok:      bool
    error:          Optional[str]
    sentinel_before: Optional[int]
    sentinel_after:  Optional[int]

def write_one_with_lock(
    client,
    lock: threading.Lock,
    slave: int,
    offset: int,
    new_value: int,
    *,
    max_delta_pct: Optional[float] = 50.0,
    verify_delay_s: float = VERIFY_DELAY_S,
) -> dict:
    """Three-stage pipeline: UNLOCK â†’ WRITE â†’ VERIFY for one register.

    Single lock acquisition. Returns a dict ready for HTTP serialization.
    """
    out = {
        "ok":             False,
        "status":         "preflight_failed",
        "offset":         int(offset),
        "field":          field_for_offset(offset) or "",
        "value_before":   None,
        "value_requested": int(new_value),
        "value_after":    None,
        "verify_ok":      False,
        "error":          None,
        "sentinel_before": None,
        "sentinel_after":  None,
    }

    if not is_writable_offset(offset):
        out["error"] = f"offset {offset} not writable"
        return out

    with lock:
        # PREFLIGHT â€” sentinel + capture value_before
        try:
            pre = _preflight(client, int(slave))
        except CalibPreflightError as exc:
            out["status"] = "preflight_failed"
            out["error"]  = str(exc)
            return out
        except CalibIoError as exc:
            out["status"] = "preflight_read_failed"
            out["error"]  = str(exc)
            return out

        out["sentinel_before"] = pre["sentinel"]
        cur_raw = pre["by_offset"].get(int(offset))
        out["value_before"] = (_signed16(cur_raw) if cur_raw is not None and is_signed_offset(offset)
                               else cur_raw)

        # RANGE GUARD
        try:
            validate_value(int(offset), int(new_value), out["value_before"],
                           max_delta_pct=max_delta_pct)
        except CalibRangeError as exc:
            out["status"] = "range_guard"
            out["error"]  = str(exc)
            return out

        # UNLOCK
        try:
            _do_unlock(client, int(slave))
        except CalibIoError as exc:
            out["status"] = "unlock_failed"
            out["error"]  = str(exc)
            return out

        # WRITE
        try:
            _do_write_one(client, int(slave), int(offset), _u16(new_value))
        except CalibIoError as exc:
            out["status"] = "write_failed"
            out["error"]  = str(exc)
            return out

        # VERIFY â€” sleep then re-read sentinel + target offset together.
        time.sleep(max(0.0, float(verify_delay_s)))
        try:
            post = _do_read_block(client, int(slave), VALID_CFG_OFFSET, 15)
        except CalibIoError as exc:
            out["status"] = "verify_read_failed"
            out["error"]  = str(exc)
            return out

        out["sentinel_after"] = post[0]
        post_value = post[int(offset) - VALID_CFG_OFFSET]
        if is_signed_offset(offset):
            post_value_disp = _signed16(post_value)
            req_disp        = _signed16(_u16(new_value))
        else:
            post_value_disp = post_value
            req_disp        = _u16(new_value)
        out["value_after"] = post_value_disp
        # Conservative verify â€” allow the inverter to quantize within a
        # tolerance band. Exact match â†’ success. Within tolerance â†’
        # success_quantized (still ok=true, just flagged). Outside â†’
        # verify_failed (true error: write didn't take or got clobbered).
        exact_match  = post_value_disp == req_disp
        delta_units  = abs(int(post_value_disp) - int(req_disp))
        denom        = max(1, abs(int(req_disp)))
        delta_pct    = (delta_units / denom) * 100.0
        tol_units    = max(int(VERIFY_TOLERANCE_ABS_UNITS),
                           int((VERIFY_TOLERANCE_PCT / 100.0) * denom))
        within_tol   = delta_units <= tol_units
        out["verify_ok"]    = exact_match or within_tol
        out["quantized"]    = (not exact_match) and within_tol
        out["delta_units"]  = delta_units
        out["delta_pct"]    = round(delta_pct, 2)

        sentinel_ok = post[0] == VALID_CFG_CODE_EXPECTED
        if not sentinel_ok:
            out["status"] = "sentinel_clobbered"
            out["error"]  = (
                f"ValidCfgCode changed from 0x{pre['sentinel']:04X} to 0x{post[0]:04X}; "
                f"calibration block may revert on next boot â€” investigate immediately"
            )
            return out

        if exact_match:
            out["ok"]     = True
            out["status"] = "success"
        elif within_tol:
            out["ok"]     = True
            out["status"] = "success_quantized"
            out["note"]   = (
                f"inverter quantized {req_disp} â†’ {post_value_disp} "
                f"(Î” {delta_units} units, {delta_pct:.2f} % â€” within tolerance)"
            )
        else:
            out["status"] = "verify_failed"
            out["error"]  = (
                f"readback {post_value_disp} differs from requested {req_disp} "
                f"by {delta_units} units ({delta_pct:.2f} %), beyond Â±{tol_units}-unit tolerance"
            )
        return out

def write_bulk_with_lock(
    client,
    lock: threading.Lock,
    slave: int,
    writes: List[Tuple[int, int]],
    *,
    max_delta_pct: Optional[float] = 50.0,
    verify_delay_s: float = VERIFY_DELAY_S,
) -> dict:
    """Write multiple (offset, value) pairs under a single unlock.

    Pairs must be contiguous offsets 81-94 OR non-contiguous (single-reg
    writes for each).  We auto-detect: if contiguous and same direction,
    one FC16 multi-write; otherwise per-register FC16 calls.  Either way
    one unlock per session.
    """
    out: Dict[str, object] = {
        "ok":           False,
        "status":       "preflight_failed",
        "writes":       [],
        "sentinel_before": None,
        "sentinel_after":  None,
        "error":        None,
    }
    if not writes:
        out["status"] = "no_writes"
        out["error"]  = "writes list is empty"
        return out

    # Validate all targets upfront.
    for off, _v in writes:
        if not is_writable_offset(off):
            out["error"] = f"offset {off} not writable"
            return out

    # Sort by offset for both efficiency and determinism.
    writes_sorted: List[Tuple[int, int]] = sorted(
        [(int(o), int(v)) for o, v in writes], key=lambda x: x[0],
    )

    with lock:
        # PREFLIGHT
        try:
            pre = _preflight(client, int(slave))
        except CalibPreflightError as exc:
            out["status"] = "preflight_failed"
            out["error"]  = str(exc)
            return out
        except CalibIoError as exc:
            out["status"] = "preflight_read_failed"
            out["error"]  = str(exc)
            return out
        out["sentinel_before"] = pre["sentinel"]

        # RANGE GUARDS
        for off, new_v in writes_sorted:
            cur = pre["by_offset"].get(int(off))
            try:
                validate_value(int(off), int(new_v), cur, max_delta_pct=max_delta_pct)
            except CalibRangeError as exc:
                out["status"] = "range_guard"
                out["error"]  = f"offset {off}: {exc}"
                return out

        # UNLOCK
        try:
            _do_unlock(client, int(slave))
        except CalibIoError as exc:
            out["status"] = "unlock_failed"
            out["error"]  = str(exc)
            return out

        # WRITE â€” prefer one FC16 multi-write if offsets are contiguous.
        offsets = [o for o, _ in writes_sorted]
        contiguous = all(offsets[i] - offsets[i - 1] == 1 for i in range(1, len(offsets)))
        try:
            if contiguous and len(offsets) > 1:
                _do_write_bulk(client, int(slave), offsets[0],
                               [_u16(v) for _o, v in writes_sorted])
            else:
                for off, val in writes_sorted:
                    _do_write_one(client, int(slave), int(off), _u16(int(val)))
        except CalibIoError as exc:
            out["status"] = "write_failed"
            out["error"]  = str(exc)
            return out

        # VERIFY
        time.sleep(max(0.0, float(verify_delay_s)))
        try:
            post = _do_read_block(client, int(slave), VALID_CFG_OFFSET, 15)
        except CalibIoError as exc:
            out["status"] = "verify_read_failed"
            out["error"]  = str(exc)
            return out
        out["sentinel_after"] = post[0]

        results: List[Dict[str, object]] = []
        all_ok = True
        any_quantized = False
        for off, new_v in writes_sorted:
            cur     = pre["by_offset"].get(int(off))
            post_v  = post[int(off) - VALID_CFG_OFFSET]
            if is_signed_offset(off):
                post_disp = _signed16(post_v)
                req_disp  = _signed16(_u16(int(new_v)))
                cur_disp  = _signed16(cur) if cur is not None else None
            else:
                post_disp = post_v
                req_disp  = _u16(int(new_v))
                cur_disp  = cur
            # Same conservative tolerance band as the single-write path â€”
            # exact match OR within Â±5 % / Â±10 units â†’ success.
            exact      = post_disp == req_disp
            delta_u    = abs(int(post_disp) - int(req_disp))
            denom      = max(1, abs(int(req_disp)))
            tol_units  = max(int(VERIFY_TOLERANCE_ABS_UNITS),
                             int((VERIFY_TOLERANCE_PCT / 100.0) * denom))
            within     = delta_u <= tol_units
            ok         = exact or within
            quantized  = (not exact) and within
            if quantized:
                any_quantized = True
            if not ok:
                all_ok = False
            results.append({
                "offset":          int(off),
                "field":           field_for_offset(off) or "",
                "value_before":    cur_disp,
                "value_requested": int(new_v),
                "value_after":     post_disp,
                "verify_ok":       ok,
                "quantized":       quantized,
                "delta_units":     delta_u,
                "delta_pct":       round((delta_u / denom) * 100.0, 2),
            })
        out["writes"]        = results
        out["any_quantized"] = any_quantized

        if post[0] != VALID_CFG_CODE_EXPECTED:
            out["status"] = "sentinel_clobbered"
            out["error"]  = (
                f"ValidCfgCode changed from 0x{pre['sentinel']:04X} to 0x{post[0]:04X}"
            )
            return out

        out["ok"]     = all_ok
        out["status"] = (
            "success_quantized" if all_ok and any_quantized else
            "success"           if all_ok else
            "partial_verify_failed"
        )
        return out

def preflight_read_with_lock(client, lock: threading.Lock, slave: int) -> dict:
    """Caller-friendly preflight: reads 80-94, returns sentinel + values."""
    out = {
        "ok":               False,
        "sentinel":         None,
        "sentinel_ok":      False,
        "by_offset":        {},
        "error":            None,
    }
    with lock:
        try:
            pre = _preflight(client, int(slave))
            out["ok"]          = True
            out["sentinel"]    = pre["sentinel"]
            out["sentinel_ok"] = True
            out["by_offset"]   = {int(k): int(v) for k, v in pre["by_offset"].items()}
        except CalibPreflightError as exc:
            # Still return the read if we got it
            try:
                regs = _do_read_block(client, int(slave), VALID_CFG_OFFSET, 15)
                out["sentinel"] = regs[0]
                out["by_offset"] = {VALID_CFG_OFFSET + i: regs[i] for i in range(len(regs))}
            except Exception:
                pass
            out["error"] = str(exc)
        except CalibIoError as exc:
            out["error"] = str(exc)
        return out

# â”€â”€â”€ Active Power Control (APC) â€” Continuous %P Setpoint â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# Verified protocol 2026-05-04: FC16 â†’ reg 0x03E8 (1000)
#   opcode 0x0005 = STOP  |  0x0006 = START  |  0x0003 = SET-ACTIVE-PCT
#   reg[1001] = Q15 setpoint = (pct/100) Ã— 0x7FFF  (only when opcode=0x0003)
# Wire test: PAC 143 kW â†’ 125 kW within 8 s at 50 % on inverter .126 slave 1.
# See plans/2026-05-04-curtailment-control.md Â§1 for full verification record.

APC_REG          = 0x03E8   # 1000 â€” command register
APC_OPCODE_SET_P = 0x0003
APC_OPCODE_STOP  = 0x0005
APC_OPCODE_START = 0x0006
APC_Q15_MAX      = 0x7FFF

def _q15_from_pct(pct: float) -> int:
    """Convert 0..100 % to Q15 integer (0x0000..0x7FFF). Clamps at bounds."""
    v = int(round((max(0.0, min(100.0, float(pct))) / 100.0) * APC_Q15_MAX))
    return max(0, min(APC_Q15_MAX, v))

def _consign_apc_sync(client, lock: threading.Lock, slave: int, pct: float) -> dict:
    """Write SET-ACTIVE-PCT (opcode 0x0003) with Q15 setpoint. Blocking.

    Caller MUST pass an already-verified pct in [0, 100].
    Returns {ok, pct, q15, error?} dict ready for HTTP serialization.
    """
    q15 = _q15_from_pct(pct)
    values = [APC_OPCODE_SET_P, q15]
    out = {"pct": float(pct), "q15": int(q15), "ok": False}

    try:
        with lock:
            r = client.write_registers(address=APC_REG, values=values, unit=int(slave))
        if r is None:
            out["error"] = "null_response"
            return out
        if r.isError():
            out["error"] = f"modbus_error: {r}"
            return out
        out["ok"] = True
        return out
    except Exception as exc:
        out["error"] = f"exception: {exc}"
        return out

def consign_apc_with_lock(client, lock: threading.Lock, slave: int, pct: float) -> dict:
    """Write APC setpoint for reactive calibration consign @ specified percent.

    Validates 0 <= pct <= 100, then calls _consign_apc_sync under the lock.
    Returns {ok, pct, q15, error?}.

    This is the single-source calibration-grade APC writer, used by both
    inverter_engine.py (async wrapper) and CalibratorService.py (standalone).
    """
    pct_f = float(pct)
    if pct_f < 0.0 or pct_f > 100.0:
        return {
            "ok": False,
            "pct": pct_f,
            "q15": 0,
            "error": f"percent must be 0..100, got {pct_f}",
        }
    return _consign_apc_sync(client, lock, int(slave), pct_f)

# â”€â”€â”€ L2 config block writes (Utility Tool tabs B/C/D/I) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# Mirrors write_one_with_lock above but operates on the broader L2 config
# block (offsets 0-176) rather than the calibration scale-factor window
# (offsets 81-94). The field metadata comes from services/cfg_trif_map.FIELDS
# (the same map the read decoder uses) and the user-supplied value is
# turned into a raw u16 by services/cfg_block_write.encode_value().
#
# Same UNLOCK magic (0xFFFA <- [0x0065, 0x07A7]) â€” the magic is the
# general "privileged write" gate proven by Slice C (serial write) and
# the calibration write path; same DSP, same protection register. Live-
# soak on hardware is still pending and must precede any production use.
#
# For kind='bits' the function performs a READ-MODIFY-WRITE on the target
# register so other bit fields sharing the same u16 (e.g. offset 16 packs
# MarchaParo at bit 0 and ConsignaDeVin at bit 1) are preserved.

def write_cfg_field_with_lock(
    client,
    lock: threading.Lock,
    slave: int,
    field_meta: Dict[str, object],
    new_value,
    *,
    verify_delay_s: float = VERIFY_DELAY_S,
    is_flash_active=None,
) -> dict:
    """Write one L2 config-block field. Returns a serializable dict.

    field_meta is one row from services.cfg_trif_map.FIELDS â€” the same
    metadata the read decoder uses. new_value is the operator-supplied
    natural value (e.g. 5000 W, not 500 raw; 60.00 Hz, not 6000 raw);
    cfg_block_write.encode_value does the kind-specific encoding.

    `is_flash_active` is an optional zero-arg callable. When provided it
    is invoked AFTER the per-IP lock is acquired so we close the TOCTOU
    window between the endpoint's pre-check and the actual write â€” a
    firmware flash that claims the bus mid-call is still caught.
    """
    # Imported lazily so that calibration_io.py keeps loading even if
    # cfg_block_write is temporarily broken â€” the calibration write path
    # (offsets 81-94) does not depend on this new code.
    try:
        from cfg_block_write import (
            encode_value, is_writable_field, merge_bit, CfgEncodeError,
        )
    except ImportError:
        try:
            from services.cfg_block_write import (
                encode_value, is_writable_field, merge_bit, CfgEncodeError,
            )
        except ImportError:
            encode_value = is_writable_field = merge_bit = CfgEncodeError = None

    offset = int(field_meta.get("offset") or -1)
    kind = str(field_meta.get("kind") or "")
    field_name = str(field_meta.get("field") or "")

    out: Dict[str, object] = {
        "ok":               False,
        "status":           "preflight_failed",
        "offset":           offset,
        "field":            field_name,
        "kind":             kind,
        "value_requested":  None,
        "raw_to_write":     None,
        "value_before_raw": None,
        "value_after_raw":  None,
        "verify_ok":        False,
        "sentinel_before":  None,
        "sentinel_after":   None,
        "error":            None,
    }

    if offset < 0 or offset >= 177:
        out["status"] = "bad_offset"
        out["error"] = f"offset {offset} outside L2 config block [0, 176]"
        return out

    if not is_writable_field(field_meta):
        out["status"] = "not_writable"
        out["error"] = (
            f"field '{field_name}' (kind '{kind}') is not writable â€” see "
            f"cfg_block_write.UNSUPPORTED_KINDS / NON_WRITABLE_FIELDS"
        )
        return out

    # Encode the user value to a raw register write. For kind='bits' the
    # encoder returns 0/1 (or a small int for slices) and the real wire
    # value is computed by merge_bit() once we've read the current u16.
    try:
        encoded = encode_value(field_meta, new_value)
    except CfgEncodeError as exc:
        out["status"] = "encode_failed"
        out["error"] = str(exc)
        return out
    out["value_requested"] = int(encoded)

    with lock:
        # Re-check firmware-flash AFTER lock acquisition. The endpoint's
        # pre-lock check is for early refusal; this second check closes
        # the TOCTOU window where a flash could start between the
        # endpoint check and us holding the lock.
        if is_flash_active is not None:
            try:
                if is_flash_active():
                    out["status"] = "firmware_flash_in_progress"
                    out["error"] = (
                        "firmware flash started during write window â€” "
                        "refused at lock acquisition")
                    return out
            except Exception as exc:
                # Fail-open: a broken probe must not silently disable
                # legitimate writes. Surface the probe error in the
                # status but do not stop the write.
                out["flash_probe_error"] = str(exc)

        # PREFLIGHT â€” sentinel must be 0x1F1F before any write attempt.
        try:
            sentinel_regs = _do_read_block(client, int(slave), VALID_CFG_OFFSET, 1)
        except CalibIoError as exc:
            out["status"] = "preflight_read_failed"
            out["error"] = str(exc)
            return out
        sentinel = int(sentinel_regs[0])
        out["sentinel_before"] = sentinel
        if sentinel != VALID_CFG_CODE_EXPECTED:
            out["status"] = "preflight_failed"
            out["error"] = (
                f"ValidCfgCode = 0x{sentinel:04X}, expected "
                f"0x{VALID_CFG_CODE_EXPECTED:04X}; refusing write"
            )
            return out

        # Read the CURRENT target register so we have value_before for
        # audit AND so the bits read-modify-write has the surrounding
        # bit fields to preserve.
        try:
            cur_reg = int(_do_read_block(client, int(slave), offset, 1)[0])
        except CalibIoError as exc:
            out["status"] = "preflight_read_failed"
            out["error"] = str(exc)
            return out
        out["value_before_raw"] = cur_reg

        if kind == "bits":
            try:
                final_u16 = merge_bit(
                    cur_reg, str(field_meta.get("bits") or ""), int(encoded)
                )
            except CfgEncodeError as exc:
                out["status"] = "encode_failed"
                out["error"] = str(exc)
                return out
        else:
            final_u16 = int(encoded) & 0xFFFF
        out["raw_to_write"] = final_u16

        # No-op write detection â€” if the requested final u16 already matches
        # the current register, skip the unlock+write entirely. Safer (no
        # bus traffic) and surfaces a clear status to the UI.
        if final_u16 == cur_reg:
            out["ok"] = True
            out["status"] = "no_change"
            out["value_after_raw"] = cur_reg
            out["sentinel_after"] = sentinel
            out["verify_ok"] = True
            return out

        # UNLOCK â€” same magic as the calibration window. Hardware-soak
        # for the broader L2 offsets is the gate before production use.
        try:
            _do_unlock(client, int(slave))
        except CalibIoError as exc:
            out["status"] = "unlock_failed"
            out["error"] = str(exc)
            return out

        # WRITE â€” single-register FC16. Multi-field write-all is sequenced
        # by the caller (one lock acquisition per field; one unlock per
        # write â€” same shape as write_one_with_lock).
        try:
            _do_write_one(client, int(slave), offset, final_u16)
        except CalibIoError as exc:
            out["status"] = "write_failed"
            out["error"] = str(exc)
            return out

        # VERIFY â€” sleep then re-read sentinel + target together.
        time.sleep(max(0.0, float(verify_delay_s)))
        try:
            post_target = int(_do_read_block(client, int(slave), offset, 1)[0])
            post_sentinel = int(_do_read_block(
                client, int(slave), VALID_CFG_OFFSET, 1)[0])
        except CalibIoError as exc:
            out["status"] = "verify_read_failed"
            out["error"] = str(exc)
            return out
        out["value_after_raw"] = post_target
        out["sentinel_after"] = post_sentinel

        if post_sentinel != VALID_CFG_CODE_EXPECTED:
            out["status"] = "sentinel_clobbered"
            out["error"] = (
                f"ValidCfgCode changed from 0x{sentinel:04X} to "
                f"0x{post_sentinel:04X}; calibration block may revert on "
                f"next boot â€” investigate immediately"
            )
            return out

        if post_target == final_u16:
            out["ok"] = True
            out["status"] = "success"
            out["verify_ok"] = True
        else:
            # No tolerance band here â€” config-block fields are integer
            # settings (Modbus#, country code, Hz envelope), not quantized
            # scale factors. A mismatch is a real failure.
            out["status"] = "verify_failed"
            out["error"] = (
                f"readback 0x{post_target:04X} differs from requested "
                f"0x{final_u16:04X}"
            )
        return out

