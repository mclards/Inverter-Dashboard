"""Stop Reason / DebugDesc reader (Slice B of v2.10.0).

Parses INGECON's 25-UINT16 (50-byte) StopReason struct returned by the
vendor FC 0x71 SCOPE peek, plus the 31-counter ARRAYHISTMOTPARO histogram.

Layout verified 2026-04-27 against ISM's "Stop Reasons" window on two
physical inverters (.109 slave=2 comm-board, .133 slave=4 EKI fallback).

Per the v2.9.0 counter-recovery pattern, this module is **read-only**:
Python reads via Modbus → returns JSON-serializable dicts → Node
persists into SQLite via an internal HTTP endpoint
(`/api/stop-reasons/internal/capture`).
"""
from __future__ import annotations

import hashlib
import struct
import threading
from dataclasses import asdict, dataclass
from typing import Optional

from services.vendor_pdu import VendorPduError, vendor_scope_peek

# ─── Per-node SCOPE addresses (Trifasico::LeeMotivosDeParo) ─────────────────
NODE_BASE_ADDR = 0xFEB5
NODE_STRIDE = 0x19
NODE_MAX_SUPPORTED = 3   # v2.10.0 cap; node 4 (0xFF00) returns garbage

ARRAYHIST_ADDR = 0xFE09
ARRAYHIST_COUNT_WORDS = 31

STOP_REASON_COUNT_WORDS = 25
STOP_REASON_BYTES = 50   # 25 * 2

# ─── StopReason record ─────────────────────────────────────────────────────

@dataclass(frozen=True)
class StopReasonRecord:
    """Decoded 25-UINT16 StopReason struct.

    Layout (verified 2026-04-30 against an operator-supplied trip
    capture; supersedes the 2026-04-27 ISM-display-derived guess for
    PotAC, Vpv, and Vac which all turned out to be 10× off):
      idx 0   PotAC (signed int16, raw W) — divide by 1000 for kW.
              Cross-checked: 23.5 kW = 207V × 38.9A × √3 with PF=1.
      idx 1   Vpv   (raw V) — INGECON SUN PE DC bus, typically 600-900 V.
      idx 2-4 Vac1/2/3 (raw V) — matches daily-log poll path at
              reg(10/11/12) → inverter_5min_param.vac1_v.
      idx 5-6 Iac1/2 (×0.1 A)
      idx 7-9 Frec1/2/3 (×0.01 Hz)
      idx 10  Cos (×0.001)
      idx 11  Temp (°C, signed)
      idx 12  Alarma (u16 bitmap, 0=none)
      idx 13  MotParo (primary stop motive code)
      idx 14  MesDia (HB=month, LB=day — DD/MM display)
      idx 15  HoraMin (HB=hour, LB=min)
      idx 16-17  Ref1/Pos1 (signed)
      idx 18  Alarmas1 (u16 bitmap)
      idx 19-20  Ref2/Pos2 (signed)
      idx 21  Alarmas2 (u16 bitmap)
      idx 22  Flags (u16 bitmap)
      idx 23  TimeoutBand
      idx 24  DebugDesc ★ vendor diagnostic sub-code
    """
    pot_ac: float
    vpv: float
    vac1: float
    vac2: float
    vac3: float
    iac1: float
    iac2: float
    frec1: float
    frec2: float
    frec3: float
    cos: float
    temp: int
    alarma: int
    motparo: int
    mes_dia_month: int
    mes_dia_day: int
    hora_min_hour: int
    hora_min_min: int
    ref1: int
    pos1: int
    alarmas1: int
    ref2: int
    pos2: int
    alarmas2: int
    flags: int
    timeout_band: int
    debug_desc: int

    def is_active_event(self) -> bool:
        """True if any fault/motive flag is non-zero."""
        return bool(
            self.alarma or self.motparo or self.alarmas1
            or self.alarmas2 or self.flags or self.debug_desc
        )

    def event_when_struct(self) -> str:
        """Inverter-RTC stamp formatted DD/MM HH:MM (forensic only — Slice F
        treats this as advisory; canonical event_at_ms is poller-stamped)."""
        return (
            f"{self.mes_dia_day:02d}/{self.mes_dia_month:02d} "
            f"{self.hora_min_hour:02d}:{self.hora_min_min:02d}"
        )

    def fingerprint(self) -> str:
        """Stable hash for de-duping repeated reads of the same event.

        Collapses (motparo, debug_desc, struct timestamp, alarma bitmap,
        alarmas1 bitmap) — fields that won't change unless a NEW event
        occurs. Used by the UNIQUE constraint on inverter_stop_reasons.
        """
        key = struct.pack(
            ">HHBBBBHH",
            self.motparo, self.debug_desc,
            self.mes_dia_month, self.mes_dia_day,
            self.hora_min_hour, self.hora_min_min,
            self.alarma, self.alarmas1,
        )
        return hashlib.sha1(key).hexdigest()[:16]

def _i16(u: int) -> int:
    """Reinterpret an unsigned 16-bit value as signed."""
    return u - 0x10000 if u & 0x8000 else u

def parse_stop_reason(raw: bytes) -> StopReasonRecord:
    """Decode the 50-byte FC 0x71 SCOPE response payload."""
    if len(raw) < STOP_REASON_BYTES:
        raise ValueError(
            f"raw too short for StopReason: {len(raw)}b (need {STOP_REASON_BYTES})"
        )
    w = struct.unpack(">25H", raw[:STOP_REASON_BYTES])
    return StopReasonRecord(
        # v2.10.4 — Cross-validated against an operator-supplied capture
        # (2026-04-28 09:59:17 INV1 N1 undervoltage trip):
        #   raw PotAC = 23545, Vpv = 604, Vac = 207/204/203,
        #   Iac = 389/386, Frec = 5991, Cos = 1000.
        #
        # Sanity check at the trip:
        #   207 V phase × 38.9 A × √3 ≈ 13.95 kW per phase
        #   Total 3-phase active power ≈ 24 kW with PF=1
        #   PotAC raw 23545 ÷ 1000 = 23.5 kW ← matches measured power
        #   PotAC raw 23545 ÷ 10    = 2354 kW ← exceeds 997.64 kW rated cap
        #
        # So PotAC is reported in raw watts (signed), NOT ×0.1 kW.
        # Vpv is raw volts (DC bus typically 600-900 V on INGECON SUN PE).
        # Vac1/2/3 are raw volts (matches daily-log poll path at reg
        # 10/11/12 which renders correctly at xxx.x V via the same site
        # firmware). Iac stays at ×0.1 A — consistent with the power
        # cross-check above.
        pot_ac=_i16(w[0]) / 1000.0,
        vpv=float(w[1]),
        vac1=float(w[2]),
        vac2=float(w[3]),
        vac3=float(w[4]),
        iac1=w[5] / 10.0,
        iac2=w[6] / 10.0,
        frec1=w[7] / 100.0,
        frec2=w[8] / 100.0,
        frec3=w[9] / 100.0,
        cos=w[10] / 1000.0,
        temp=_i16(w[11]),
        alarma=w[12],
        motparo=w[13],
        mes_dia_month=(w[14] >> 8) & 0xFF,
        mes_dia_day=w[14] & 0xFF,
        hora_min_hour=(w[15] >> 8) & 0xFF,
        hora_min_min=w[15] & 0xFF,
        ref1=_i16(w[16]),
        pos1=_i16(w[17]),
        alarmas1=w[18],
        ref2=_i16(w[19]),
        pos2=_i16(w[20]),
        alarmas2=w[21],
        flags=w[22],
        timeout_band=w[23],
        debug_desc=w[24],
    )

def to_capture_payload(record: StopReasonRecord, *, raw: bytes,
                       inverter_ip: str, slave: int, node: int,
                       read_at_ms: int,
                       event_at_ms: Optional[int] = None,
                       trigger_source: str = "manual",
                       alarm_id: Optional[int] = None) -> dict:
    """Build the JSON dict POSTed to the Node-side capture endpoint.

    Mirrors the row schema in inverter_stop_reasons (server/db.js).
    """
    d = asdict(record)
    d.update({
        "inverter_ip": inverter_ip,
        "slave": int(slave),
        "node": int(node),
        "read_at_ms": int(read_at_ms),
        "event_at_ms": int(event_at_ms) if event_at_ms is not None else None,
        "trigger_source": trigger_source,
        "alarm_id": int(alarm_id) if alarm_id is not None else None,
        "fingerprint": record.fingerprint(),
        "event_when_struct": record.event_when_struct(),
        "is_active_event": record.is_active_event(),
        "raw_hex": raw[:STOP_REASON_BYTES].hex(),
    })
    return d

# ─── ARRAYHISTMOTPARO (lifetime stop-motive counters) ──────────────────────

@dataclass(frozen=True)
class StopMotiveHistogram:
    """31 UINT16 counters: slots 0..29 = MOTIVO_PARO codes, slot 30 = TOTAL."""
    counters: tuple
    raw: bytes

    @property
    def total(self) -> int:
        return self.counters[30]

    def to_capture_payload(self, *, inverter_ip: str, slave: int,
                            read_at_ms: int) -> dict:
        return {
            "inverter_ip": inverter_ip,
            "slave": int(slave),
            "read_at_ms": int(read_at_ms),
            "total_count": int(self.total),
            "counters": list(self.counters),
            "raw_hex": self.raw[:62].hex(),
        }

def parse_arrayhist(raw: bytes) -> StopMotiveHistogram:
    if len(raw) < 62:
        raise ValueError(f"ARRAYHISTMOTPARO raw too short: {len(raw)}b (need 62)")
    counters = struct.unpack(">31H", raw[:62])
    return StopMotiveHistogram(counters=counters, raw=bytes(raw[:62]))

# ─── Modbus read helpers (sync — caller must hold thread_locks[ip]) ────────

def read_node_stop_reason(client, slave: int, node: int,
                           timeout_s: float = 3.0) -> tuple[bytes, StopReasonRecord]:
    """Read a node's StopReason snapshot via FC 0x71 SCOPE peek.

    Caller MUST hold the per-IP `threading.Lock` from
    `inverter_engine.thread_locks[ip]` to serialize against the poller.
    Returns (raw_bytes, decoded_record).
    """
    if not (1 <= node <= NODE_MAX_SUPPORTED):
        raise ValueError(
            f"node {node} outside supported range 1..{NODE_MAX_SUPPORTED}"
        )
    addr = NODE_BASE_ADDR + (node - 1) * NODE_STRIDE
    raw = vendor_scope_peek(client, slave, addr, STOP_REASON_COUNT_WORDS,
                             timeout_s=timeout_s)
    return raw, parse_stop_reason(raw)

def read_arrayhistmotparo(client, slave: int,
                           timeout_s: float = 3.0) -> StopMotiveHistogram:
    """Read the 31-counter lifetime histogram via FC 0x71 SCOPE peek.

    Caller MUST hold the per-IP threading.Lock.
    """
    raw = vendor_scope_peek(client, slave, ARRAYHIST_ADDR,
                             ARRAYHIST_COUNT_WORDS, timeout_s=timeout_s)
    return parse_arrayhist(raw)

def read_all_nodes(client, slave: int, *, max_node: int = NODE_MAX_SUPPORTED,
                    timeout_s: float = 3.0) -> list[tuple[int, bytes, StopReasonRecord]]:
    """Read all nodes 1..max_node sequentially under the same lock-held call.

    Returns a list of (node, raw, record) tuples. Per-node failures are
    NOT swallowed — the caller decides whether one bad node aborts the
    whole sweep.
    """
    out = []
    for node in range(1, max_node + 1):
        raw, rec = read_node_stop_reason(client, slave, node, timeout_s=timeout_s)
        out.append((node, raw, rec))
    return out

# ─── Lock-holding orchestrator ─────────────────────────────────────────────

def read_with_lock(client, lock: threading.Lock, slave: int, *,
                    nodes: Optional[list[int]] = None,
                    include_histogram: bool = False,
                    timeout_s: float = 3.0) -> dict:
    """Acquire `lock`, read the requested nodes (and optionally the
    histogram), and return JSON-ready dicts.

    Used by the FastAPI route handler so the heavy I/O happens inside
    the per-IP serialization boundary that protects the poller.
    """
    if nodes is None:
        nodes = list(range(1, NODE_MAX_SUPPORTED + 1))
    out_nodes = []
    out_histogram = None
    err = None
    with lock:
        for node in nodes:
            try:
                raw, rec = read_node_stop_reason(client, slave, node,
                                                  timeout_s=timeout_s)
                out_nodes.append({
                    "node": node,
                    "ok": True,
                    "raw_hex": raw[:STOP_REASON_BYTES].hex(),
                    "record": asdict(rec),
                    "fingerprint": rec.fingerprint(),
                    "is_active_event": rec.is_active_event(),
                    "event_when_struct": rec.event_when_struct(),
                })
            except VendorPduError as e:
                out_nodes.append({"node": node, "ok": False, "error": str(e)})
            except Exception as e:
                err = f"unexpected: {e}"
                out_nodes.append({"node": node, "ok": False, "error": err})
        if include_histogram:
            try:
                hist = read_arrayhistmotparo(client, slave, timeout_s=timeout_s)
                out_histogram = {
                    "ok": True,
                    "total": hist.total,
                    "counters": list(hist.counters),
                    "raw_hex": hist.raw.hex(),
                }
            except Exception as e:
                out_histogram = {"ok": False, "error": str(e)}
    return {"nodes": out_nodes, "histogram": out_histogram}
