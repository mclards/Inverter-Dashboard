"""services/firmware_buslock.py — cross-process firmware-flash bus lock.

A standalone calibrator firmware flash and the dashboard's live Modbus
poller are SEPARATE processes that both talk to the same transparent
TCP->RTU gateway. Two Modbus masters interleaving on the same RS-485
segment make the inverter DSP reject the flash start with "error code 2"
(busy). This module is the cross-process signal that lets the flashing
tool claim an inverter so the poller backs off it for the duration.

Contract:
  • Only the CALIBRATOR writes (claim/heartbeat/release). The poller and
    the inverter engine are READ-ONLY (active_ips).
  • Marker: %PROGRAMDATA%/InverterDashboard/firmware-active.json, written
    atomically (temp + os.replace).
  • A claim is ACTIVE iff expires_ms > now. A hard TTL bounds a crashed
    job; a live job heartbeats. release() is best-effort; the TTL is the
    real safety net.
  • FAIL-OPEN: any read/parse error -> NO active claims. A broken marker
    must never silence live polling. TCP only (a claim carries the
    gateway IP the poller contends on); serial flashes pass host=None and
    write no claim.
"""

import json
import os
import tempfile
import threading
import time

DEFAULT_TTL_S = 120
MAX_TTL_S = 3600  # hard ceiling: a single flash never legitimately needs >1h;
#                   caps a hand-edited/corrupt marker from silencing forever.
MAX_MARKER_BYTES = 100_000  # ~1000 claims; oversized => fail-open (no DoS stall)

_LOCK = threading.Lock()  # serialise this process's own read-modify-write

def _marker_path() -> str:
    # Mirror calibrator_app._fw_audit_path() resolution exactly.
    base = os.getenv("PROGRAMDATA") or os.path.dirname(__file__)
    d = os.path.join(base, "Inverter-Dashboard")
    try:
        os.makedirs(d, exist_ok=True)
    except OSError:
        d = os.path.dirname(__file__)
    return os.path.join(d, "firmware-active.json")

def _now_ms() -> int:
    return int(time.time() * 1000)

def _read_raw():
    """Return the parsed marker dict, or None on any problem (fail-open)."""
    try:
        p = _marker_path()
        if os.path.getsize(p) > MAX_MARKER_BYTES:
            return None  # oversized/garbage => fail-open, don't parse a bomb
        with open(p, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None

def filter_active(raw, now_ms):
    """PURE: given the parsed marker (or None) return the list of claims
    whose expires_ms is still in the future. Never raises."""
    if not isinstance(raw, dict):
        return []
    claims = raw.get("claims")
    if not isinstance(claims, list):
        return []
    out = []
    for c in claims:
        if not isinstance(c, dict):
            continue
        try:
            exp = int(c.get("expires_ms") or 0)
            ip = str(c.get("inverter_ip") or "").strip()
        except (TypeError, ValueError):
            continue
        if ip and exp > now_ms:
            out.append(c)
    return out

def active_ips(now_ms=None):
    """Set of gateway IPs with a live firmware claim. Fail-open: {} on any
    error. Cheap enough to call every poll cycle; callers may still cache."""
    if now_ms is None:
        now_ms = _now_ms()
    try:
        return {c["inverter_ip"] for c in filter_active(_read_raw(), now_ms)}
    except Exception:
        return set()

def _write(claims):
    """Atomically replace the marker with `claims` (temp + os.replace)."""
    path = _marker_path()
    payload = json.dumps({"claims": claims})
    d = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(prefix=".fwlock-", dir=d)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(payload)
        os.replace(tmp, path)
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass

def _upsert(inverter_ip, node, slave, job_id, ttl_s):
    """Drop expired + this job's prior claim, append a fresh one."""
    if not inverter_ip:
        return  # serial/RTU flash — no TCP poller contention, no claim
    try:
        ttl = max(1, min(int(ttl_s), MAX_TTL_S))
    except (TypeError, ValueError):
        ttl = DEFAULT_TTL_S
    now = _now_ms()
    with _LOCK:
        kept = [
            c for c in filter_active(_read_raw(), now)
            if str(c.get("job_id") or "") != str(job_id)
        ]
        kept.append({
            "inverter_ip": str(inverter_ip),
            "node": int(node or 0),
            "slave": int(slave or 0),
            "job_id": str(job_id),
            "pid": os.getpid(),
            "started_ms": now,
            "expires_ms": now + ttl * 1000,
        })
        _write(kept)

def claim(inverter_ip, node, slave, job_id, ttl_s=DEFAULT_TTL_S):
    """Calibrator: publish/refresh a flash claim for `inverter_ip`."""
    _upsert(inverter_ip, node, slave, job_id, ttl_s)

def heartbeat(inverter_ip, node, slave, job_id, ttl_s=DEFAULT_TTL_S):
    """Calibrator: extend the claim's expiry while the flash runs."""
    _upsert(inverter_ip, node, slave, job_id, ttl_s)

def release(job_id):
    """Calibrator: drop this job's claim (best-effort; TTL is the net)."""
    now = _now_ms()
    with _LOCK:
        kept = [
            c for c in filter_active(_read_raw(), now)
            if str(c.get("job_id") or "") != str(job_id)
        ]
        _write(kept)
