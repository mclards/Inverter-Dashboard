# =================================================
#   Inverter Dashboard Ã¢â‚¬â€ Hybrid Engine
#   ASYNCIO POLLING + WRITE THREADS
#
#   Designed & Developed by Engr. Clariden MontaÃƒÂ±o REE (Engr. M.)
#   Ã‚Â© 2026 Engr. Clariden MontaÃƒÂ±o REE. All rights reserved.
# =================================================
import sys
import os

# Fix for frozen/GUI environments where stdout/stderr may be None
if sys.stdout is None:
    sys.stdout = open(os.devnull, 'w')
if sys.stderr is None:
    sys.stderr = open(os.devnull, 'w')

try:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

import subprocess
import re
import os
import asyncio
import json
import time
import sqlite3
import math
import uuid as _uuid_mod
import random as _random_mod
from typing import Optional, List
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import threading
from queue import Queue, Full

from fastapi import FastAPI, Request, HTTPException
from pydantic import BaseModel
from fastapi.responses import JSONResponse
import uvicorn
from fastapi.middleware.cors import CORSMiddleware

try:
    from drivers.modbus_tcp import create_client, read_input, read_holding, write_single
except ImportError:
    try:
        from .drivers.modbus_tcp import create_client, read_input, read_holding, write_single
    except ImportError:
        create_client = read_input = read_holding = write_single = None

try:
    from shared_data import shared
    import firmware_buslock
except ImportError:
    from .shared_data import shared
    from . import firmware_buslock

try:
    from stop_reason import read_with_lock as _read_with_lock
except Exception:
    _read_with_lock = None

try:
    from serial_io import read_serial_with_lock as _read_serial, write_serial_with_lock as _write_serial
except Exception:
    _read_serial = _write_serial = None

try:
    from calibration_io import (
        write_one_with_lock,
        write_bulk_with_lock,
        write_cfg_field_with_lock,
        consign_apc_with_lock,
        preflight_read_with_lock,
    )
except Exception:
    write_one_with_lock = write_bulk_with_lock = write_cfg_field_with_lock = consign_apc_with_lock = preflight_read_with_lock = None

# RS485-USB fleet bridge removed in v2.11.x (field calibration moved to the
# standalone Inverter Calibration Tool). Kept as a None sentinel so the
# remaining `if rs485_bridge is not None:` guards below stay valid no-ops
# with no behaviour change to live polling.
rs485_bridge = None

ENGINE_PORT = int(os.getenv("INVERTER_ENGINE_PORT", "9100"))
ENGINE_HOST = str(os.getenv("INVERTER_ENGINE_HOST", "127.0.0.1") or "127.0.0.1").strip() or "127.0.0.1"

# Slice ÃŽÂ² Ã¢â‚¬â€ slow-poll cadence for diagnostic registers (addr 64-116).
# Runtime tunable via ADSI_SLOW_POLL_INTERVAL_S env var; operator restart
# required to apply changes. Range: 5-300 seconds (clamped). Set to 0 to
# disable the slow-poll tier entirely.
# Plan: plans/2026-05-10-modbus-registers-official-revamp.md Ã‚Â§4 Slice ÃŽÂ²
try:
    SLOW_POLL_INTERVAL_S = int(os.getenv("ADSI_SLOW_POLL_INTERVAL_S", "30"))
except (TypeError, ValueError):
    SLOW_POLL_INTERVAL_S = 30
if SLOW_POLL_INTERVAL_S != 0:
    SLOW_POLL_INTERVAL_S = max(5, min(300, SLOW_POLL_INTERVAL_S))

# -------------------------------------------------
#   FastAPI app  Ã¢â‚¬â€  created ONCE with CORS middleware
# -------------------------------------------------

app = FastAPI()

# T3.14 fix (Phase 8, 2026-04-14): restrict CORS to the loopback dashboard
# origin so that if the service port is ever accidentally exposed beyond
# 127.0.0.1 (e.g. firewall misconfiguration, future remote-access feature),
# an untrusted browser origin cannot POST /write.  The service ALSO binds
# to ENGINE_HOST (default 127.0.0.1) which is the primary defence Ã¢â‚¬â€ this
# is belt-and-braces.  Override with INVERTER_ENGINE_CORS_ORIGINS env var
# (comma-separated) if the operator needs to add a reverse-proxy origin.
_cors_default = ["http://127.0.0.1:3500", "http://localhost:3500"]
_cors_env = os.getenv("INVERTER_ENGINE_CORS_ORIGINS", "").strip()
_cors_origins = [o.strip() for o in _cors_env.split(",") if o.strip()] if _cors_env else _cors_default
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

# -------------------------------------------------
#   Helpers
# -------------------------------------------------

def _signed_int16(raw):
    """Convert Modbus raw UInt16 to signed Int16 (two's complement).

    Per Ingeteam INGECON SUN Modbus RTU spec
    (docs/IngeconSunPMax-Entire-Modbus-RTU-Registers.pdf Ã‚Â§2 pg 4-5):
      - Reg 30010 (addr 9) `Idc`  Ã¢â‚¬â€ signed, 1 A/LSB (PDF: "In Amps")
      - Reg 30019 (addr 18) `PAC` Ã¢â‚¬â€ signed, raw Ãƒâ€” 10 = W ("in tens of Watt")
    Slow-poll signed fields:
      - Reg 30069 (addr 68) `QAC` Ã¢â‚¬â€ signed, raw Ãƒâ€” 10 = VAr ("Reactive power
        DIV 10", same convention as Nominal power DIV 10 Ã¢â€ â€™ raw Ãƒâ€” 10 = real)
      - Reg 30072-73 (addr 71-72) Ã¢â‚¬â€ signed Ã‚Â°C temperatures (Slice ÃŽÂ± only
        addresses Idc/PAC; temps already signed-handled in read_fast_async)

    Audit: audits/2026-05-11/register-decode-traceback.md.
    Related plan: plans/2026-05-10-modbus-registers-official-revamp.md Ã‚Â§4 Slice ÃŽÂ±
    """
    u16 = int(raw) & 0xFFFF
    return u16 - 0x10000 if u16 > 0x7FFF else u16

def free_engine_port():
    """Kill any process currently listening on ENGINE_PORT (Windows only)."""
    try:
        result = subprocess.run(["netstat", "-ano"], capture_output=True, text=True)
        pattern = rf"TCP\s+\S+:{ENGINE_PORT}\s+\S+\s+LISTENING\s+(\d+)"
        pids = re.findall(pattern, result.stdout)
        for pid in set(pids):
            subprocess.run(["taskkill", "/PID", pid, "/F", "/T"], capture_output=True)
            print(f"[PORT {ENGINE_PORT}] Killed PID {pid}")
    except Exception as e:
        print(f"[PORT {ENGINE_PORT}] Error:", e)

def hex_h_to_dec(val):
    """Convert a HEX+H string (e.g. '01000H') to an integer. Returns None on failure."""
    try:
        if isinstance(val, str) and val.upper().endswith("H"):
            return int(val[:-1], 16)
    except Exception:
        pass
    return None

def inverter_number_from_ip(ip):
    """Return the inverter number (1Ã¢â‚¬â€œ27) for a given IP address, or None."""
    for inv_num, inv_ip in ip_map.items():
        if inv_ip == ip:
            return int(inv_num)
    return None

# -------------------------------------------------
#   Configuration  Ã¢â‚¬â€  paths & tunables
# -------------------------------------------------

PORTABLE_ROOT = str(
    os.getenv("INVERTER_PORTABLE_DATA_DIR")
    or os.getenv("IM_PORTABLE_DATA_DIR")
    or os.getenv("ADSI_PORTABLE_DATA_DIR")
    or ""
).strip()
EXPLICIT_DATA_DIR = str(
    os.getenv("INVERTER_DATA_DIR")
    or os.getenv("IM_DATA_DIR")
    or os.getenv("ADSI_DATA_DIR")
    or ""
).strip()

# A repository-local `storage` directory is useful only for explicitly opted-in
# isolated developer runs. Auto-selecting it on Windows made a normal
# `python inverter_engine.py` launch silently ignore the operator's ProgramData
# configuration. Electron supplies INVERTER_DATA_DIR for production launches.
if (
    not PORTABLE_ROOT
    and not EXPLICIT_DATA_DIR
    and os.getenv("ADSI_USE_REPO_STORAGE", "").strip().lower() in {"1", "true", "yes"}
):
    _auto_storage = Path(__file__).resolve().parent.parent.parent.parent / "storage"
    if _auto_storage.exists():
        PORTABLE_ROOT = str(_auto_storage)
    elif sys.platform.startswith("linux") and Path("/var/lib/inverter-dashboard").exists():
        PORTABLE_ROOT = "/var/lib/inverter-dashboard"

if PORTABLE_ROOT:
    PROGRAMDATA_DIR = Path(PORTABLE_ROOT) / "programdata"
else:
    PROGRAMDATA_ROOT = (
        os.getenv("PROGRAMDATA")
        or os.getenv("ALLUSERSPROFILE")
        or str(Path.home())
    )
    PROGRAMDATA_DIR = Path(PROGRAMDATA_ROOT) / "Inverter-Dashboard"
PROGRAMDATA_DIR.mkdir(parents=True, exist_ok=True)

if EXPLICIT_DATA_DIR:
    DATA_DIR = Path(EXPLICIT_DATA_DIR)
elif PORTABLE_ROOT:
    DATA_DIR = Path(PORTABLE_ROOT) / "db"
else:
    DATA_DIR = PROGRAMDATA_DIR / "db"
DATA_DIR.mkdir(parents=True, exist_ok=True)

DB_PATH = DATA_DIR / "inverter.db"
if not DB_PATH.exists() and (DATA_DIR / "adsi.db").exists():
    DB_PATH = DATA_DIR / "adsi.db"

if PORTABLE_ROOT:
    IPCONFIG_PATH = Path(PORTABLE_ROOT) / "config" / "ipconfig.json"
else:
    # Match the Electron/gateway canonical configuration path. DATA_DIR is
    # normally this exact location; retaining the explicit expression guards
    # a launcher that did not pass INVERTER_DATA_DIR.
    IPCONFIG_PATH = (
        DATA_DIR / "ipconfig.json"
        if EXPLICIT_DATA_DIR
        else Path(PROGRAMDATA_ROOT) / "Inverter-Dashboard" / "db" / "ipconfig.json"
    )
IPCONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
LEGACY_IPCONFIG_PATHS = [
    DATA_DIR / "ipconfig.json",
    PROGRAMDATA_DIR / "config" / "ipconfig.json",
    PROGRAMDATA_DIR / "ipconfig.json",
    # NOTE: Intentionally excluding Path(__file__).parent / "ipconfig.json"
    # and Path.cwd() / "ipconfig.json". In a PyInstaller bundle __file__'s
    # directory is the extracted _MEIxxxx dir which may contain a stale
    # build-time ipconfig, and CWD depends on how the installer launches
    # the service Ã¢â‚¬â€  both would be replaced on every update and could
]
AUTORESET_PATH = PROGRAMDATA_DIR / "autoreset.json"
SERVICE_STOP_FILE_RAW = str(
    os.getenv("IM_SERVICE_STOP_FILE")
    or os.getenv("ADSI_SERVICE_STOP_FILE")
    or ""
).strip()
SERVICE_STOP_FILE = Path(SERVICE_STOP_FILE_RAW) if SERVICE_STOP_FILE_RAW else None
SERVICE_STOP_POLL_SEC = 0.25

DEFAULT_INTERVAL  = 0.05   # default poll interval per inverter
MIN_POLL_INTERVAL = 0.05   # hard floor Ã¢â‚¬â€ protects against runaway tight loops
# Ingeteam Level 2 workflow (AAV2011IFA01_ p.8, 0008H alarm) recommends no
# faster than 1 Hz per unit at the SCADA level: "reduce the frequency at which
# the SCADA communicates with the inverter (1 communication per second
# recommended)". Per-inverter intervals below this threshold are allowed but
# emit a startup warning so operators know the upstream vendor guidance.
RECOMMENDED_POLL_INTERVAL = 1.0

# Ã¢â€â‚¬Ã¢â€â‚¬ Tunable constants Ã¢â‚¬â€ overridden at runtime from DB 'inverterPollConfig' Ã¢â€â‚¬Ã¢â€â‚¬
READ_SPACING    = 0.005  # seconds between input / holding reads
RECONNECT_DELAY = 0.5    # seconds to wait after reconnect before retry read
_modbus_timeout = 1.0    # Modbus TCP read timeout (passed to create_client)

# -------------------------------------------------
#   Global state
# -------------------------------------------------

ip_map          = {}   # inv_num (str) -> ip
inverters       = []   # ordered list of active IPs
clients         = {}   # ip -> modbus client
thread_locks    = {}   # ip -> threading.Lock
write_queues    = {}   # ip -> Queue
write_threads   = {}   # ip -> Thread
write_pending   = {}   # ip -> threading.Event set while control write is queued/running
# T3.3 fix: this lock makes (mark_write_pending + q.put) and (q.empty() + evt.clear())
# atomic with respect to each other, closing a TOCTOU where a job enqueued between
# the worker's empty-check and clear could have its pending signal silently dropped.
write_pending_lock = threading.Lock()
# T3.5 fix: tracks the monotonic timestamp of the last operator /write call per
# (ip, unit).  handle_auto_reset suppresses the opposite-direction reset for
# AUTO_RESET_WRITE_HOLD_SEC seconds after a manual write to avoid races where
# the auto-reset loop immediately undoes an operator command.
last_operator_write_ts = {}
AUTO_RESET_WRITE_HOLD_SEC = 5.0
intervals       = {}   # ip -> poll interval (float)
static_units    = {}   # ip -> [unit list] or None

auto_reset_state = {}  # (ip, unit) -> {"state": str, "since": float, "busy": bool}
_last_unit_fail  = {}  # ip -> timestamp of last failed unit-detect

# Ã¢â€â‚¬Ã¢â€â‚¬ Per-unit dead-node backoff (2026-05-29) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
# All units behind one inverter IP share ONE TCP socket and ONE per-IP lock.
# A single slave that stops answering (absent/faulted node, pulled fibre, RS485
# branch fault) otherwise forces a full shared-socket reconnect + double
# read-timeout (~2.5 s) on EVERY poll cycle inside read_fast_async()/safe_read().
# Because poll_inverter reads units sequentially on the shared socket, that
# penalty drags the inverter's HEALTHY sibling nodes down with it Ã¢â‚¬â€ their
# dashboard refresh collapses from sub-second to multi-second and the shared
# connection is torn down/rebuilt every cycle. To isolate a dead node: once a
# unit misses UNIT_DEAD_FAIL_THRESHOLD consecutive reads it is "throttled" and
# re-probed only every UNIT_DEAD_REPROBE_S instead of every cycle, so the
# siblings keep their fast cadence. Recovery is detected on the next re-probe
# (well within the dashboard's 20 s offline threshold). Fail-open: set
# DISABLE_UNIT_DEAD_BACKOFF=1 to restore the legacy every-cycle probe.
UNIT_DEAD_FAIL_THRESHOLD = 3       # consecutive misses before a unit is throttled
UNIT_DEAD_REPROBE_S      = 15.0    # throttled units are re-probed at most this often
DISABLE_UNIT_DEAD_BACKOFF = os.environ.get(
    "DISABLE_UNIT_DEAD_BACKOFF", ""
).strip() in ("1", "true", "yes")
# (ip, unit) -> {"fail": int, "throttled": bool, "next_probe": float monotonic}
_unit_health = {}

# Ã¢â€â‚¬Ã¢â€â‚¬ Per-IP self-healing client rebuild (2026-06-08) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
# The per-IP ModbusTcpClient is cached for the whole process lifetime (see
# `clients` + rebuild_global_maps). The only failure recovery elsewhere is
# close()/connect() on that SAME object, to the SAME IP (safe_read /
# drivers/modbus_tcp.py). When a client/socket reaches a state that close/connect
# cannot clear (a pymodbus 2.5.3 sync-client wedge, an IP-keyed black-hole path
# through the Mikrotik/Advantech chain, or an Ingeteam AAX0041 gateway that has
# stopped servicing this TCP session), polling for that inverter stays dead even
# though the IP still pings. Historically the ONLY fix was to change the
# inverter's IP Ã¢â‚¬â€ which forces rebuild_global_maps to construct a brand-new
# client object. This makes that recovery automatic: after IP_REBUILD_AFTER_S of
# zero successful reads on an IP, the poll loop discards the wedged client and
# builds a fresh one (rate-limited to IP_REBUILD_MIN_INTERVAL_S so a genuinely
# powered-off inverter is harmless). Fail-open: DISABLE_IP_CLIENT_REBUILD=1
# restores the legacy "close/connect same object only" behavior.
IP_REBUILD_AFTER_S        = 30.0   # zero successful reads this long -> rebuild client
IP_REBUILD_MIN_INTERVAL_S = 60.0   # never rebuild the same IP more often than this
DISABLE_IP_CLIENT_REBUILD = os.environ.get(
    "DISABLE_IP_CLIENT_REBUILD", ""
).strip() in ("1", "true", "yes")
# ip -> {"last_success": float monotonic, "last_rebuild": float monotonic}
_ip_health = {}

def should_rebuild_client(now, last_success, last_rebuild,
                          disabled, write_pending, fw_active):
    """Pure decision: should this IP's Modbus client be rebuilt now?

    Rebuild only when the inverter has produced NO successful read for at least
    IP_REBUILD_AFTER_S, AND we have not already rebuilt within
    IP_REBUILD_MIN_INTERVAL_S. Never rebuild mid-write or while a firmware flash
    owns the bus (the swap would tear a socket out from under that operation).
    Kept side-effect-free so it can be unit-tested without Modbus/hardware.
    """
    if disabled or write_pending or fw_active:
        return False
    if (now - last_success) < IP_REBUILD_AFTER_S:
        return False
    if (now - last_rebuild) < IP_REBUILD_MIN_INTERVAL_S:
        return False
    return True

def _swap_ip_client(ip, new_client):
    """Close the old per-IP client and install `new_client`, holding the per-IP
    lock so we never tear a socket out from under an in-flight write/read frame.
    MUST run in a worker thread (via run_in_executor): `thread_locks[ip]` is a
    blocking threading.Lock that a write worker can hold for ~2 s, so acquiring
    it on the asyncio event loop would stall every inverter's polling. The
    existing read/write paths only ever take this lock inside executor threads;
    this mirrors that rule.

    `setdefault` (atomic under the GIL) guarantees we always operate under the
    canonical lock: even if rebuild_global_maps is concurrently bringing this IP
    up, both paths converge on the same Lock object, so the swap is never
    unsynchronized.
    """
    lock = thread_locks.setdefault(ip, threading.Lock())
    with lock:
        old = clients.get(ip)
        try:
            if old:
                old.close()
        except Exception:
            pass
        clients[ip] = new_client

async def rebuild_ip_client(ip, reason):
    """Discard a wedged per-IP Modbus client and install a fresh one.

    Both blocking steps run in the executor: create_client (a blocking
    connect()) and _swap_ip_client (which acquires the per-IP threading.Lock).
    Neither may run on the event-loop thread. `clients[ip] = new` is a single
    atomic dict rebind under the GIL (same guarantee rebuild_global_maps relies
    on). Returns True on success.
    """
    loop = asyncio.get_running_loop()
    try:
        new = await loop.run_in_executor(executor, create_client, ip, 502, _modbus_timeout)
    except Exception as exc:
        print(f"[POLL] {ip} client rebuild FAILED ({reason}): {type(exc).__name__}: {exc}")
        return False

    try:
        await loop.run_in_executor(executor, _swap_ip_client, ip, new)
    except Exception as exc:
        print(f"[POLL] {ip} client swap FAILED ({reason}): {type(exc).__name__}: {exc}")
        return False

    h = _ip_health.setdefault(ip, {"last_success": time.monotonic(), "last_rebuild": 0.0})
    h["last_rebuild"] = time.monotonic()
    # Fresh socket -> let every node on this inverter re-probe at full cadence.
    for _u in (1, 2, 3, 4):
        _unit_health.pop((ip, _u), None)
    print(f"[POLL] {ip} client rebuilt ({reason})")
    return True

# Phase 8 code-review fix (2026-04-15): module-scope initializers for the
# one-time-log guards used by T3.17 (PAC clamp) so a race between concurrent
# first-time writers cannot lose an entry.  Previously the guards used
# `global X; try: X except NameError: X = set()` inside the function, which
# has a small window where two threads both hit NameError and one
# re-initialises away the other's just-added entry.  Pre-initialising at
# module scope closes the window Ã¢â‚¬â€ the first `add()` always lands in the
# already-existing set.
_pac_clamp_notified: set = set()

auto_reset_cfg = {
    "enabled":                 False,
    "wait_clear_hex":          "01000H",
    "auto_reset_alarms":       [],
    "wait_clear_timeout_sec":  10,
}

# Per-unit last-known on_off state: holds the most recent successful holding-register
# read. If the next read returns None (transient failure), we fall back to this value
# so Node does not briefly see the inverter as OFF and skip a persistence cycle.
_last_known_on_off = {}   # key: f"{ip}_{unit}" -> int (0 or 1)

executor = ThreadPoolExecutor(max_workers=16)
WRITE_WAIT_TIMEOUT_MIN_SEC = 8.0
WRITE_WAIT_TIMEOUT_MAX_SEC = 20.0
WRITE_QUEUE_SLOT_SEC = 1.5

def service_stop_requested():
    try:
        return bool(SERVICE_STOP_FILE and SERVICE_STOP_FILE.exists())
    except Exception:
        return False

def clear_service_stop_file():
    if not SERVICE_STOP_FILE:
        return
    try:
        SERVICE_STOP_FILE.unlink(missing_ok=True)
    except TypeError:
        try:
            if SERVICE_STOP_FILE.exists():
                SERVICE_STOP_FILE.unlink()
        except Exception:
            pass
    except Exception:
        pass

def _resolve_future_threadsafe(loop, fut, value):
    try:
        if fut.done():
            return
        fut.set_result(value)
    except Exception:
        pass

# -------------------------------------------------
#   ipconfig.json  Ã¢â‚¬â€  load
# -------------------------------------------------

DEFAULT_LOSS_PCT = 2.5

def _default_ipconfig():
    cfg = {"inverters": {}, "poll_interval": {}, "units": {}, "losses": {}}
    for i in range(1, 28):
        key = str(i)
        cfg["inverters"][key] = f"192.168.1.{100 + i}"
        cfg["poll_interval"][key] = float(DEFAULT_INTERVAL)
        # The sanitiser uses this as the fallback for a missing ``units``
        # entry.  Keep every config section structurally complete so a valid
        # legacy/partial ipconfig can never prevent the telemetry service
        # from starting.
        cfg["units"][key] = [1, 2, 3, 4]
        cfg["losses"][key] = float(DEFAULT_LOSS_PCT)
    return cfg

def _sanitize_ipconfig(data):
    out = _default_ipconfig()
    src = data if isinstance(data, dict) else {}
    src_inv = src.get("inverters", {}) if isinstance(src.get("inverters"), dict) else {}
    src_poll = src.get("poll_interval", {}) if isinstance(src.get("poll_interval"), dict) else {}
    src_units = src.get("units", {}) if isinstance(src.get("units"), dict) else {}
    src_losses = src.get("losses", {}) if isinstance(src.get("losses"), dict) else {}

    for i in range(1, 28):
        key = str(i)

        ip_raw = src_inv.get(key, src_inv.get(i, out["inverters"][key]))
        ip = str(ip_raw).strip()

        poll_raw = src_poll.get(key, src_poll.get(i, out["poll_interval"][key]))
        try:
            poll = float(poll_raw)
        except Exception:
            poll = float(DEFAULT_INTERVAL)

        units_raw = src_units.get(key, src_units.get(i, out["units"][key]))
        if isinstance(units_raw, list):
            units = []
            for u in units_raw:
                try:
                    n = int(u)
                except Exception:
                    continue
                if 1 <= n <= 4 and n not in units:
                    units.append(n)
        else:
            units = [1, 2, 3, 4]

        loss_raw = src_losses.get(key, src_losses.get(i, out["losses"][key]))
        try:
            loss = float(loss_raw)
        except Exception:
            loss = float(out["losses"][key])
        if not math.isfinite(loss) or loss < 0 or loss > 100:
            loss = float(out["losses"][key])

        out["inverters"][key] = ip
        out["poll_interval"][key] = poll if poll >= 0.01 else float(DEFAULT_INTERVAL)
        out["units"][key] = units if units else [1]
        out["losses"][key] = loss

    return out

def _read_ipconfig_from_db():
    if not DB_PATH.exists():
        return None

    conn = None
    try:
        conn = sqlite3.connect(str(DB_PATH), timeout=1.0)
        row = conn.execute(
            "SELECT value FROM settings WHERE key=?",
            ("ipConfigJson",),
        ).fetchone()
        if not row or not row[0]:
            return None
        return json.loads(row[0])
    except Exception:
        return None
    finally:
        try:
            if conn:
                conn.close()
        except Exception:
            pass

def _read_ipconfig_file(path_obj):
    try:
        if not path_obj.exists():
            return None
        with open(path_obj, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None

def _write_ipconfig_file(path_obj, cfg):
    try:
        path_obj.parent.mkdir(parents=True, exist_ok=True)
        with open(path_obj, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2)
        return True
    except Exception:
        return False

def _load_ipconfig_sync():
    """Synchronous load; called via executor so the event loop stays unblocked."""
    # 1) Primary source: the managed ProgramData config file. The dashboard
    # exposes this exact file to field operators, so a valid edit must take
    # effect even when an older DB mirror is still present after an upgrade.
    canonical_raw = _read_ipconfig_file(IPCONFIG_PATH)
    if canonical_raw is not None:
        return _sanitize_ipconfig(canonical_raw)

    # 2) DB mirror. Node synchronizes this from the canonical file at startup
    # and on topology saves; it remains the safe fallback during a temporary
    # file-system outage.
    db_raw = _read_ipconfig_from_db()
    if db_raw is not None:
        cfg = _sanitize_ipconfig(db_raw)
        _write_ipconfig_file(IPCONFIG_PATH, cfg)
        return cfg

    # 2) Fallbacks: AppData ipconfig, then legacy paths. These paths live in
    #    user-data locations that are preserved across updates. Bundle-dir and
    #    CWD paths are intentionally excluded (see LEGACY_IPCONFIG_PATHS).
    candidate_paths = [IPCONFIG_PATH]
    candidate_paths.extend(LEGACY_IPCONFIG_PATHS)

    for p in candidate_paths:
        raw = _read_ipconfig_file(p)
        if raw is None:
            continue
        cfg = _sanitize_ipconfig(raw)
        _write_ipconfig_file(IPCONFIG_PATH, cfg)
        # Do NOT write back to the DB from the fallback path. _read_ipconfig_from_db
        # returns None on both "key missing" AND "transient SQLite lock" Ã¢â‚¬â€ writing
        # back on the latter would silently overwrite a newer value Node just wrote.
        # Node's loadIpConfigFromDb already seeds the DB from legacy files on
        # startup when its own read returns empty, so this migration is already
        # covered by the Node side without the race window.
        return cfg

    # 3) Default if nothing exists. Do NOT promote the default into the DB Ã¢â‚¬â€
    #    a Node restart may still populate the real setting from a mirror
    #    file that appeared after we checked.
    cfg = _default_ipconfig()
    _write_ipconfig_file(IPCONFIG_PATH, cfg)
    print("[IPCONFIG] Created default ipconfig.json at", IPCONFIG_PATH)
    return cfg

async def load_ipconfig():
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(executor, _load_ipconfig_sync)

# -------------------------------------------------
#   inverterPollConfig  Ã¢â‚¬â€  live-tunable constants
# -------------------------------------------------

def _load_poll_config_sync():
    """Read inverterPollConfig JSON from the SQLite settings table."""
    if not DB_PATH.exists():
        return {}
    conn = None
    try:
        conn = sqlite3.connect(str(DB_PATH), timeout=1.0)
        row = conn.execute(
            "SELECT value FROM settings WHERE key=?",
            ("inverterPollConfig",),
        ).fetchone()
        if not row or not row[0]:
            return {}
        cfg = json.loads(row[0])
        return cfg if isinstance(cfg, dict) else {}
    except Exception:
        return {}
    finally:
        try:
            if conn:
                conn.close()
        except Exception:
            pass

def _apply_poll_config(cfg):
    """Apply a poll-config dict to the module-level tunable constants."""
    global READ_SPACING, RECONNECT_DELAY, _modbus_timeout

    if "readSpacing" in cfg:
        v = float(cfg["readSpacing"])
        READ_SPACING = max(0.001, min(v, 1.0))
    if "reconnectDelay" in cfg:
        v = float(cfg["reconnectDelay"])
        RECONNECT_DELAY = max(0.1, min(v, 10.0))
    if "modbusTimeout" in cfg:
        v = float(cfg["modbusTimeout"])
        _modbus_timeout = max(0.2, min(v, 10.0))

# -------------------------------------------------
#   autoreset.json  Ã¢â‚¬â€  load
# -------------------------------------------------

def load_autoreset_config():
    global auto_reset_cfg

    if not AUTORESET_PATH.exists():
        with open(AUTORESET_PATH, "w") as f:
            json.dump(auto_reset_cfg, f, indent=2)
        return

    try:
        with open(AUTORESET_PATH, "r") as f:
            auto_reset_cfg = json.load(f)
    except Exception as e:
        print("[AUTORESET] Load failed:", e)

# -------------------------------------------------
#   Write worker thread  (one per inverter)
# -------------------------------------------------

def write_worker_loop(ip, lock, q):
    """
    Runs in a daemon thread. Drains the write queue and executes
    write_single() under the inverter's lock. Stops on a None sentinel.
    """
    while True:
        pending_evt = write_pending.get(ip)
        job = q.get()
        if job is None:
            if pending_evt:
                pending_evt.clear()
            break

        client = clients.get(ip)
        fut  = job["future"]
        loop = job.get("loop")
        if not client:
            try:
                if loop and not fut.done():
                    loop.call_soon_threadsafe(_resolve_future_threadsafe, loop, fut, False)
            except Exception:
                pass
            # T3.3 fix: atomic empty-check + clear so a concurrent
            # enqueue_write_atomically cannot race with the clear.
            if pending_evt:
                with write_pending_lock:
                    if q.empty():
                        pending_evt.clear()
            continue

        steps = job.get("steps")
        if isinstance(steps, list) and steps:
            normalized_steps = []
            for step in steps:
                try:
                    normalized_steps.append({
                        "address": int(step.get("address", 16)),
                        "value":   int(step.get("value")),
                        "unit":    int(step.get("unit")),
                    })
                except Exception:
                    continue
        else:
            normalized_steps = [{
                "address": int(job["address"]),
                "value":   int(job["value"]),
                "unit":    int(job["unit"]),
            }]

        # T3.4 fix: re-validate each step at dequeue time.  Defence in depth
        # against direct queue injection (tests, future refactors) that
        # bypasses the API-level bounds check.  Invalid steps are dropped
        # and the write resolves as failure rather than hitting Modbus.
        validated_steps = []
        for step in normalized_steps:
            if not (1 <= step["unit"] <= 4) or step["value"] not in (0, 1):
                print(
                    f"[write_worker] rejecting invalid step ip={ip} "
                    f"unit={step.get('unit')} value={step.get('value')}"
                )
                continue
            validated_steps.append(step)
        if not validated_steps:
            try:
                if loop and not fut.done():
                    loop.call_soon_threadsafe(_resolve_future_threadsafe, loop, fut, False)
            except Exception:
                pass
            if pending_evt:
                with write_pending_lock:
                    if q.empty():
                        pending_evt.clear()
            continue
        normalized_steps = validated_steps

        batch_mode = bool(job.get("batch")) or len(normalized_steps) > 1
        result_payload = [] if batch_mode else False

        # T3.12 fix (Phase 6, 2026-04-14) Ã¢â‚¬â€ REVISED Slice ÃŽÂº.9 (2026-05-12):
        # post-write read-back is now a LOGGED DIAGNOSTIC, not a failure
        # gate. Field observation 2026-05-12: register 16 holds the actual
        # ON/OFF state, not the commanded state. INGECON inverters take
        # several seconds to physically transition (grid sync, soft-start
        # ramp, K1 contactor mechanical), so an immediate readback sees
        # the OLD state and trips a mismatch even when the FC6 ACK landed
        # cleanly and the command is being executed. The original intent
        # (catching silent-interlock rejections) is preserved via the
        # poller's continuous reading of register 16 Ã¢â‚¬â€ a real rejection
        # leaves the on_off indicator on the inverter card stuck in the
        # prior state for the operator to see.  Returns True/False/None
        # for forensic logging only; callers MUST NOT downgrade step_ok
        # on a False verdict.
        def _verify_step(step):
            try:
                regs = read_holding(client, step["address"], 1, step["unit"])
                if regs and len(regs) >= 1:
                    return int(regs[0]) == int(step["value"])
            except Exception:
                pass
            return None  # could not verify; do not downgrade

        try:
            with lock:
                if batch_mode:
                    result_payload = []
                    for step in normalized_steps:
                        step_ok = write_single(
                            client,
                            step["address"],
                            step["value"],
                            step["unit"],
                        )
                        if step_ok:
                            # Slice ÃŽÂº.9 (2026-05-12) Ã¢â‚¬â€ log-only diagnostic;
                            # do NOT downgrade step_ok. See _verify_step
                            # docstring for rationale.
                            verdict = _verify_step(step)
                            if verdict is False:
                                print(
                                    f"[write_worker] post-write verify mismatch (logged, not failed) "
                                    f"ip={ip} unit={step['unit']} "
                                    f"wrote={step['value']} addr={step['address']} Ã¢â‚¬â€ "
                                    f"register may need time to reflect commanded state"
                                )
                        result_payload.append({
                            "unit": step["unit"],
                            "ok": bool(step_ok),
                        })
                else:
                    step = normalized_steps[0]
                    result_payload = write_single(
                        client,
                        step["address"],
                        step["value"],
                        step["unit"],
                    )
                    if result_payload:
                        # Slice ÃŽÂº.9 (2026-05-12) Ã¢â‚¬â€ log-only diagnostic;
                        # do NOT downgrade result_payload.
                        verdict = _verify_step(step)
                        if verdict is False:
                            print(
                                f"[write_worker] post-write verify mismatch (logged, not failed) "
                                f"ip={ip} unit={step['unit']} "
                                f"wrote={step['value']} addr={step['address']} Ã¢â‚¬â€ "
                                f"register may need time to reflect commanded state"
                            )
        except Exception:
            result_payload = [] if batch_mode else False

        try:
            if loop and not fut.done():
                loop.call_soon_threadsafe(
                    _resolve_future_threadsafe,
                    loop,
                    fut,
                    result_payload,
                )
        except Exception:
            pass
        finally:
            # T3.3 fix: atomic empty-check + clear under write_pending_lock,
            # so a concurrent enqueue_write_atomically cannot enqueue a job
            # between the empty check and the clear.
            if pending_evt:
                with write_pending_lock:
                    if q.empty():
                        pending_evt.clear()

# -------------------------------------------------
#   Safe reads  (run in executor, auto-reconnect)
# -------------------------------------------------

def _threaded_read_input(client, addr, count, unit, lock):
    try:
        with lock:
            return read_input(client, addr, count, unit)
    except Exception:
        return None

def _threaded_read_holding(client, addr, count, unit, lock):
    try:
        with lock:
            return read_holding(client, addr, count, unit)
    except Exception:
        return None

async def safe_read(func, client, addr, count, unit, ip):
    """
    Attempt a register read; on failure, reconnect once and retry.
    Returns the register list or None.
    """
    loop = asyncio.get_running_loop()
    lock = thread_locks.get(ip)
    if lock is None:
        return None

    # Ã¢â€â‚¬Ã¢â€â‚¬ First attempt Ã¢â€â‚¬Ã¢â€â‚¬
    try:
        result = await loop.run_in_executor(executor, func, client, addr, count, unit, lock)
        if result:
            return result
    except Exception:
        pass

    # Ã¢â€â‚¬Ã¢â€â‚¬ Reconnect + retry Ã¢â€â‚¬Ã¢â€â‚¬
    def reconnect_and_read():
        try:
            with lock:
                try:   client.close()
                except Exception: pass
                try:   client.connect()
                except Exception: pass

            time.sleep(RECONNECT_DELAY)

            with lock:
                if func is _threaded_read_input:
                    return read_input(client, addr, count, unit)
                else:
                    return read_holding(client, addr, count, unit)
        except Exception:
            return None

    try:
        return await loop.run_in_executor(executor, reconnect_and_read)
    except Exception:
        return None

def is_write_pending(ip):
    evt = write_pending.get(ip)
    return bool(evt and evt.is_set())

# Ã¢â€â‚¬Ã¢â€â‚¬ Cross-process firmware-flash bus lock Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
# While the standalone calibrator flashes an inverter's firmware over the
# same transparent TCP->RTU gateway, a second Modbus master (this poller)
# interleaving frames makes the DSP reject the flash ("error code 2").
# When the calibrator has published a claim for `ip` we skip ALL Modbus to
# it for the cycle Ã¢â‚¬â€ exactly like the proven is_write_pending() backoff.
# FAIL-OPEN: any marker problem -> firmware_buslock.active_ips() == {} ->
# polling continues unchanged. The set is re-read at most every 2 s so 27
# poll tasks don't hammer the file.
_fw_active_cache = {"ts": 0.0, "ips": set()}
_FW_ACTIVE_CACHE_TTL_S = 2.0

def firmware_flash_active(ip):
    now = time.time()
    c = _fw_active_cache
    if now - c["ts"] >= _FW_ACTIVE_CACHE_TTL_S:
        try:
            c["ips"] = firmware_buslock.active_ips()
        except Exception:
            c["ips"] = set()          # fail-open Ã¢â‚¬â€ never silence polling
        c["ts"] = now
    return ip in c["ips"]

def compute_write_wait_timeout(ip, step_count=1):
    q = write_queues.get(ip)
    lock = thread_locks.get(ip)
    pending = 0
    try:
        pending = int(q.qsize()) if q is not None else 0
    except Exception:
        pending = 0
    try:
        extra_steps = max(0, int(step_count) - 1)
    except Exception:
        extra_steps = 0
    base = max(WRITE_WAIT_TIMEOUT_MIN_SEC, (_modbus_timeout * 4.0) + 2.0)
    timeout = base + ((pending + extra_steps) * WRITE_QUEUE_SLOT_SEC)
    if lock and lock.locked():
        timeout += max(WRITE_QUEUE_SLOT_SEC, _modbus_timeout * 2.0)
    return max(WRITE_WAIT_TIMEOUT_MIN_SEC, min(WRITE_WAIT_TIMEOUT_MAX_SEC, timeout))

def mark_write_pending(ip):
    evt = write_pending.get(ip)
    if evt is None:
        evt = threading.Event()
        write_pending[ip] = evt
    evt.set()
    return evt

def enqueue_write_atomically(ip, job):
    """T3.3 fix: atomically mark pending and enqueue.

    Prevents the worker from observing q.empty()==True between the API
    thread's mark_write_pending() and its subsequent q.put(), which would
    cause the pending event to be cleared immediately after the job is
    enqueued (silently dropping the wake-up signal that callers rely on).
    """
    with write_pending_lock:
        # T3.11 fix (Phase 6): bounded queue rejects with Full when capacity
        # exceeded.  Use put_nowait so the API thread never blocks.  Caller
        # converts the WriteQueueFullError to HTTP 429 / WS error response.
        try:
            write_queues[ip].put_nowait(job)
        except Full:
            raise WriteQueueFullError(
                f"Write queue for {ip} is full ({write_queues[ip].maxsize} pending). "
                f"Retry shortly."
            )
        mark_write_pending(ip)

class WriteQueueFullError(RuntimeError):
    """T3.11 fix (Phase 6): raised when per-IP write queue is at capacity."""
    pass

def note_operator_write(ip, unit):
    """T3.5 fix: record the time of an operator-initiated write so
    handle_auto_reset can suppress auto-reset actions on the same (ip, unit)
    for a short hold window, avoiding operator/auto-reset collisions."""
    try:
        last_operator_write_ts[(ip, int(unit))] = time.monotonic()
    except Exception:
        pass

def operator_write_hold_active(ip, unit):
    try:
        ts = last_operator_write_ts.get((ip, int(unit)))
    except Exception:
        return False
    if ts is None:
        return False
    return (time.monotonic() - ts) < AUTO_RESET_WRITE_HOLD_SEC

# -------------------------------------------------
#   Auto-reset alarm handler
# -------------------------------------------------

async def handle_auto_reset(ip, unit, alarm_val):
    """
    State machine that resets a tripped inverter:
      armed          Ã¢â€ â€™ alarm detected Ã¢â€ â€™ write OFF Ã¢â€ â€™ waiting_clear
      waiting_clear  Ã¢â€ â€™ alarm clears   Ã¢â€ â€™ write ON  Ã¢â€ â€™ armed
      waiting_clear  Ã¢â€ â€™ timeout        Ã¢â€ â€™              armed
    """
    key = (ip, unit)

    # Guard: block concurrent executions for the same inverter/unit
    entry = auto_reset_state.get(key)
    if entry and entry.get("busy"):
        return

    if not auto_reset_cfg.get("enabled"):
        return

    # v2.11.x Calibration Session Lockdown: refuse auto-reset on the
    # inverter under calibration. The operator may deliberately drive
    # the inverter into states that trip alarms (e.g. consign 0%); an
    # auto-reset firing would race the calibration writes.
    try:
        inv_num = None
        for k, v in (ip_map or {}).items():
            if str(v).strip() == str(ip).strip():
                inv_num = int(k); break
        if inv_num is not None and _is_under_calibration(inv_num, int(unit)):
            return
    except Exception:
        pass

    # Guard: fatal error (0x7FFF) cannot be cleared remotely. Per Ingeteam
    # Level 1 workflow (AAV2011IMC01_ p.14) and Level 2 (AAV2011IFA01_ p.18):
    #   "When a FATAL ERROR occurs, the inverter is unblocked by entering a
    #    code through the display."
    # Looping auto-reset on 7FFF just burns Modbus writes and obscures the
    # real state. Skip and log once per state entry so operators see the note.
    if alarm_val == 0x7FFF:
        if not entry or entry.get("state") != "fatal_locked":
            print(
                f"[AUTORESET] {ip} unit {unit}: alarm 0x7FFF (fatal) Ã¢â‚¬â€ "
                f"cannot be auto-reset. Requires display-code unlock at the unit. "
                f"See docs/Inverter-Incident-Workflow.pdf p.14.",
                flush=True,
            )
        auto_reset_state[key] = {"state": "fatal_locked", "since": time.time(), "busy": False}
        return

    alarm_hex_list = auto_reset_cfg.get("auto_reset_alarms", [])
    if not alarm_hex_list:
        return

    alarm_dec_list = [d for a in alarm_hex_list if (d := hex_h_to_dec(a)) is not None]

    clear_dec = hex_h_to_dec(auto_reset_cfg.get("wait_clear_hex", "01000H"))
    if clear_dec is None:
        return

    wait_timeout = float(auto_reset_cfg.get("wait_clear_timeout_sec", 10))

    entry = auto_reset_state.get(key, {"state": "armed", "since": 0, "busy": False})
    state = entry["state"]
    now   = time.time()

    entry["busy"] = True
    auto_reset_state[key] = entry

    try:
        # Ã¢â€â‚¬Ã¢â€â‚¬ State: armed Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
        if state == "armed" and alarm_val in alarm_dec_list:
            # T3.5 fix: suppress auto-reset if an operator write just happened
            # on this (ip, unit) Ã¢â‚¬â€ avoids racing with manual control.
            if operator_write_hold_active(ip, unit):
                return

            loop = asyncio.get_running_loop()
            fut  = loop.create_future()

            # T3.3 fix: atomic mark+enqueue.
            try:
                enqueue_write_atomically(ip, {
                    "address": 16,
                    "value":   0,       # OFF
                    "unit":    unit,
                    "future":  fut,
                    "loop":    loop,
                })
            except WriteQueueFullError as e:
                # T3.11 fix (Phase 6): auto-reset is best-effort; on a full
                # queue, log and skip this cycle Ã¢â‚¬â€ next alarm tick will retry.
                print(f"[AUTORESET] queue full, skipping OFF for {ip} unit {unit}: {e}")
                return

            try:
                ok = await asyncio.wait_for(
                    asyncio.shield(fut),
                    timeout=max(2.0, compute_write_wait_timeout(ip)),
                )
            except asyncio.TimeoutError:
                ok = False

            if not ok:
                print(f"[AUTORESET] OFF write FAILED  {ip}  unit {unit}")
                return

            auto_reset_state[key] = {"state": "waiting_clear", "since": now, "busy": True}
            print(f"[AUTORESET] OFF OK Ã¢â€ â€™ waiting_clear  {ip}  unit {unit}")
            return

        # Ã¢â€â‚¬Ã¢â€â‚¬ State: waiting_clear Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
        if state == "waiting_clear":
            elapsed = now - entry["since"]

            if alarm_val == clear_dec:
                # T3.5 fix: same operator-write hold applies to the ON re-arm.
                if operator_write_hold_active(ip, unit):
                    # Don't re-arm ON while operator is actively controlling.
                    return

                loop = asyncio.get_running_loop()
                fut  = loop.create_future()

                # T3.3 fix: atomic mark+enqueue.
                try:
                    enqueue_write_atomically(ip, {
                        "address": 16,
                        "value":   1,   # ON
                        "unit":    unit,
                        "future":  fut,
                        "loop":    loop,
                    })
                except WriteQueueFullError as e:
                    # T3.11 fix (Phase 6): same best-effort skip as the OFF path.
                    print(f"[AUTORESET] queue full, skipping ON for {ip} unit {unit}: {e}")
                    return

                auto_reset_state[key] = {"state": "armed", "since": 0}
                print(f"[AUTORESET] CLEAR Ã¢â€ â€™ ON  {ip}  unit {unit}")
                return

            if elapsed >= wait_timeout:
                auto_reset_state[key] = {"state": "armed", "since": 0}
                print(f"[AUTORESET] CLEAR TIMEOUT ({wait_timeout}s) Ã¢â€ â€™ re-armed  {ip}  unit {unit}")
                return

    finally:
        entry = auto_reset_state.get(key)
        if entry:
            entry["busy"] = False

# -------------------------------------------------
#   Unit detection
# -------------------------------------------------

async def detect_units_async(ip):
    """
    Return the active unit list for an IP.
    Honours static overrides; throttles on repeated failure.
    """
    now = time.time()
    if _last_unit_fail.get(ip, 0) + 5 > now:
        return []

    # Static override wins
    if ip in static_units and static_units[ip]:
        return static_units[ip]

    client = clients.get(ip)
    if not client:
        return []

    units = []
    for u in [1, 2, 3, 4]:
        if is_write_pending(ip):
            await asyncio.sleep(0.05)
            break
        r = await safe_read(_threaded_read_input, client, 1, 1, u, ip)
        if r:
            units.append(u)

    if not units:
        _last_unit_fail[ip] = now
        await asyncio.sleep(0.5)

    return units

# -------------------------------------------------
#   Fast packet read
# -------------------------------------------------

def _u32_hi_lo(regs, off):
    """UInt32 decode for Ingeteam big-endian word-pair (high word first).

    Raises ValueError on a truncated frame so callers detect the gap instead of
    silently consuming a zero Ã¢â‚¬â€ corrupted Etotal/parcE during crash-recovery
    seed would reset kwh_today on restart.
    """
    if off + 1 >= len(regs):
        raise ValueError(f"truncated frame: need {off + 2} regs, got {len(regs)}")
    a = regs[off] or 0
    b = regs[off + 1] or 0
    return ((a & 0xFFFF) << 16) | (b & 0xFFFF)

def _rtc_from_regs(regs, server_year=None):
    """
    Decode RTC from regs(20..25). Returns (dt_naive_or_None, valid: bool).

    Validity:
      Ã¢â‚¬Â¢ year within Ã‚Â±5 of server_year (catches inv-21/u3 2047 fault pattern)
        Ã¢â‚¬â€ when server_year is None, accept 2000..2100 for offline/testing
      Ã¢â‚¬Â¢ month 1..12, day 1..31, hour 0..23, minute 0..59, second 0..59
    Drift (minor clock skew) is handled by the caller via rtc_drift_s; the
    decoder rejects only clearly-corrupt RTCs.
    """
    try:
        if len(regs) < 26:
            return (None, False)
        y  = int(regs[20] or 0)
        mo = int(regs[21] or 0)
        dy = int(regs[22] or 0)
        h  = int(regs[23] or 0)
        mi = int(regs[24] or 0)
        s  = int(regs[25] or 0)
        if not (2000 <= y <= 2100): return (None, False)
        if server_year is not None and abs(y - int(server_year)) > 5:
            return (None, False)
        if not (1 <= mo <= 12):      return (None, False)
        if not (1 <= dy <= 31):      return (None, False)
        if not (0 <= h  <= 23):      return (None, False)
        if not (0 <= mi <= 59):      return (None, False)
        if not (0 <= s  <= 59):      return (None, False)
        from datetime import datetime as _dt
        return (_dt(y, mo, dy, h, mi, s), True)
    except Exception:
        return (None, False)

async def read_fast_async(client, unit, ip):
    """
    Read 78 input registers + ON/OFF holding register.
    Returns a dict keyed to the field names expected by Node-RED,
    plus the v2.9.0 hardware-counter / RTC / full-alarm fields,
    or None on failure.

    Widened from 26Ã¢â€ â€™60 regs in v2.9.0 (Slice A) to capture:
      Ã¢â‚¬Â¢ Etotal (reg 0-1, UInt32 hi-lo)
      Ã¢â‚¬Â¢ Alarm bitfield (reg 6-7, UInt32 hi-lo) Ã¢â‚¬â€ was truncated to 16-bit
      Ã¢â‚¬Â¢ Fac grid frequency (reg 19)
      Ã¢â‚¬Â¢ parcE partial kWh (reg 58-59, UInt32 hi-lo)
    Widened from 60Ã¢â€ â€™72 regs in v2.10.x to capture:
      Ã¢â‚¬Â¢ temp_c heatsink temperature (reg 71, raw Ã‚Â°C minus 1 for ISM parity)
    Widened from 72Ã¢â€ â€™78 regs in v2.10.x (Slice ÃŽÂ²) to capture:
      Ã¢â‚¬Â¢ AAP0016 analog inputs (reg 41-44): 12-bit ADC, 0-4095
      Ã¢â‚¬Â¢ AAP0016 PT100 probes (reg 45-46): temperature via ADC
    All legacy keys preserved; new keys are additive (null if AAP0016 not installed).
    """
    if is_write_pending(ip):
        await asyncio.sleep(min(READ_SPACING, 0.01))
        return None

    regs = await safe_read(_threaded_read_input, client, 0, 78, unit, ip)
    if not regs:
        return None

    onoff = None
    if not is_write_pending(ip):
        await asyncio.sleep(READ_SPACING)
        onoff = await safe_read(_threaded_read_holding, client, 16, 1, unit, ip)

    def reg(i):
        return regs[i] if len(regs) > i else 0

    # Ã¢â€â‚¬Ã¢â€â‚¬ on_off: hold last known value on transient holding-register failure (Fix #6) Ã¢â€â‚¬Ã¢â€â‚¬
    on_off_key = f"{ip}_{unit}"
    on_off_raw = onoff[0] if onoff else None
    if on_off_raw is not None:
        _last_known_on_off[on_off_key] = on_off_raw
    on_off_val = on_off_raw if on_off_raw is not None else _last_known_on_off.get(on_off_key)

    # Ã¢â€â‚¬Ã¢â€â‚¬ Fix #3: warn when inverter RTC date diverges from server wall-clock Ã¢â€â‚¬Ã¢â€â‚¬
    inv_num_for_log = inverter_number_from_ip(ip)
    y_reg  = reg(20)
    mo_reg = reg(21)
    dy_reg = reg(22)
    if y_reg and mo_reg and dy_reg:
        inverter_date = f"{y_reg}-{_pad2(mo_reg)}-{_pad2(dy_reg)}"
        server_date   = time.strftime("%Y-%m-%d")
        if inverter_date != server_date:
            print(
                f"[CLOCK] Date mismatch inv={inv_num_for_log} unit={unit}"
                f" inverter={inverter_date} server={server_date}"
                f" Ã¢â‚¬â€ bucket ts will use server clock but 'day' field uses inverter date"
            )

    # Ã¢â€â‚¬Ã¢â€â‚¬ v2.9.0 Slice A: decode hardware counters + RTC + full alarm Ã¢â€â‚¬Ã¢â€â‚¬
    now_ms      = int(time.time() * 1000)
    _server_year = time.localtime().tm_year
    rtc_dt, rtc_valid = _rtc_from_regs(regs, server_year=_server_year)
    rtc_ms      = int(rtc_dt.timestamp() * 1000) if rtc_dt else None
    rtc_drift_s = round((rtc_ms - now_ms) / 1000.0, 2) if rtc_ms is not None else None

    try:
        alarm_32   = _u32_hi_lo(regs, 6)
        etotal_kwh = _u32_hi_lo(regs, 0)
        parce_kwh  = _u32_hi_lo(regs, 58)
        # v2.11.x Slice ÃŽÂº Ã¢â‚¬â€ grid-connection cycle counters. Both are UInt32
        # hi-lo encoded just like Etotal. `conex` is the lifetime count
        # (since the inverter was commissioned); `conex_resettable` is an
        # operator-resettable variant. K1 contactor wear correlates with
        # cycle count, so the dashboard tracks the delta per day per node.
        conex_lifetime   = _u32_hi_lo(regs, 4)
        conex_resettable = _u32_hi_lo(regs, 62)
    except ValueError as ve:
        print(f"[POLL] {ip} unit {unit} truncated frame, dropping: {ve}")
        return None
    fac_hz     = round((reg(19) or 0) / 100.0, 2)

    # v2.10.x All Parameters Data Ã¢â‚¬â€ additional fields needed by the
    # 5-min aggregator. Register map verified against capture-inverter1.pcapng
    # (INV01 / Slave 1 @ 16:50:57 4/27/2026 Ã¢â‚¬â€ every screenshot value matched).
    #   reg 16 = CosPhi Ãƒâ€” 1000  (0..1000)
    #   reg 17 = Phi Sine Sign  (0=Ã¢Ë†â€™, 1=+) Ã¢â‚¬â€ kept for ISM column parity
    #   reg 71 = TempCI (cooling-system / heatsink temperature, signed Ã‚Â°C).
    #
    #            Ã¢â€â‚¬Ã¢â€â‚¬ Two-source cross-validation Ã¢â€â‚¬Ã¢â€â‚¬
    #            (a) ISM live display: 30-sample Ãƒâ€” 30-second monitor on
    #                192.168.1.109 / s1 (2026-04-28 08:37Ã¢â‚¬â€œ08:52). reg 71
    #                tracked the ISM "Temp (Ã‚Â°C)" column exactly with a
    #                constant +1 Ã‚Â°C offset (reg 71 reads 1 Ã‚Â°C higher than
    #                ISM displays). reg 70 stayed at 0 Ã¢â‚¬â€ confirmed not a
    #                hi/lo pair.
    #            (b) Stop Reason snapshot (services/stop_reason.py:50): the
    #                vendor FC 0x71 SCOPE struct's idx-11 `temp` field is
    #                signed int16, raw Ã‚Â°C, no scaling Ã¢â‚¬â€ verified 2026-04-27
    #                to match ISM display directly. Since reg 71 = ISM + 1
    #                and StopReason.temp = ISM, we have:
    #                    StopReason.temp == reg(71) - 1
    #                Subtracting 1 here makes the continuous Parameters-page
    #                Temp column align with both ISM AND the StopReason
    #                snapshot captured at fault time.
    #
    #            Per the alarm reference (server/alarms.js:266 Overtemperature):
    #              Ã¢â‚¬Â¢ TempCI alarm threshold = 78 Ã‚Â°C
    #              Ã¢â‚¬Â¢ TempCI = -14 Ã‚Â°C is a SENSOR FAULT sentinel (open NTC),
    #                NOT a real reading Ã¢â‚¬â€ return None so the dashboard's
    #                Temp column shows "Ã¢â‚¬â€" instead of a misleading number.
    #              Ã¢â‚¬Â¢ reg 72 looks like TempINT (internal electronics, threshold
    #                80 Ã‚Â°C, slower response) Ã¢â‚¬â€ capture but don't surface yet.
    cosphi_x1000 = int(reg(16) or 0)
    cosphi_val   = round(cosphi_x1000 / 1000.0, 3) if cosphi_x1000 else 0.0
    phi_sign     = 1 if int(reg(17) or 0) else 0
    # Signed int16 interpretation so the -14 sentinel and any cold-weather
    # negatives decode correctly. Modbus regs are unsigned by default.
    raw_temp_ci   = int(reg(71) or 0)
    if raw_temp_ci & 0x8000:
        raw_temp_ci -= 0x10000
    if raw_temp_ci == -14:
        # Sensor fault Ã¢â‚¬â€ open NTC. Don't average a fake number into the
        # 5-min slot; let the column render "Ã¢â‚¬â€" so the operator notices.
        temp_c_val = None
    elif raw_temp_ci == 0:
        # Inverter offline / register not yet refreshed.
        temp_c_val = None
    else:
        temp_c_val = raw_temp_ci - 1   # ISM-parity calibration

    return {
        "ts":            now_ms,
        # Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ existing fields (preserve exactly for Node-RED / poller compatibility) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
        "alarm":         reg(7),               # DEPRECATED Ã¢â‚¬â€ 16-bit legacy, remove in v2.10
        "vdc":           reg(8),
        "idc":           reg(9),
        "vac1":          reg(10),
        "vac2":          reg(11),
        "vac3":          reg(12),
        "iac1":          reg(13),
        "iac2":          reg(14),
        "iac3":          reg(15),
        "pac":           reg(18),
        "year":          reg(20),
        "month":         reg(21),
        "day":           reg(22),
        "hour":          reg(23),
        "minute":        reg(24),
        "second":        reg(25),
        "on_off":        on_off_val,
        # Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ NEW fields (v2.9.0 Slice A) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
        "alarm_32":      alarm_32,              # full 32-bit alarm bitfield
        "fac_hz":        fac_hz,                # grid frequency (Hz)
        "etotal_kwh":    etotal_kwh,            # lifetime kWh counter (UInt32)
        "parce_kwh":     parce_kwh,             # partial kWh counter  (UInt32)
        # v2.11.x Slice ÃŽÂº Ã¢â‚¬â€ grid-connection cycle counters (K1 contactor wear).
        # `conex_lifetime` is the lifetime grid-connection count since
        # commissioning; `conex_resettable` is the operator-resettable variant.
        # Both are within the existing 0-77 fast-read range so no extra
        # Modbus traffic. Persisted by the poller as the per-slot snapshot;
        # the dashboard derives ÃŽâ€-cycles/day per node from these snapshots.
        "conex_lifetime":   conex_lifetime,
        "conex_resettable": conex_resettable,
        "rtc_iso":       rtc_dt.isoformat() if rtc_dt else None,
        "rtc_ms":        rtc_ms,
        "rtc_valid":     bool(rtc_valid),
        "rtc_drift_s":   rtc_drift_s,
        # Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ NEW fields (v2.10.x All Parameters Data) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
        "cosphi":        cosphi_val,            # 0.000 .. 1.000
        "phi_sign":      phi_sign,              # 0=neg, 1=pos
        # Inverter heatsink temperature (Ã‚Â°C) Ã¢â‚¬â€ sourced from input reg 71,
        # widened block read above to 72 regs to include it. ISM-parity
        # offset (-1) applied during decode; see the temp_raw block. None
        # while the inverter is offline / sleeping (raw 0 sentinel).
        "temp_c":        temp_c_val,
        # Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ NEW fields (v2.10.x Slice ÃŽÂ² Ã¢â‚¬â€ AAP0016 analog inputs) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
        "analog_in_1":   int(reg(41) or 0),        # 12-bit ADC input 1 (0Ã¢â‚¬â€œ4095)
        "analog_in_2":   int(reg(42) or 0),        # 12-bit ADC input 2
        "analog_in_3":   int(reg(43) or 0),        # 12-bit ADC input 3
        "analog_in_4":   int(reg(44) or 0),        # 12-bit ADC input 4
        "pt100_1":       int(reg(45) or 0),        # PT100 probe 1 (raw ADC)
        "pt100_2":       int(reg(46) or 0),        # PT100 probe 2 (raw ADC)
    }

async def read_slow_async(client, unit, ip):
    """
    Read 53 diagnostic input registers (addr 64Ã¢â‚¬â€œ116).
    Runs on a slow cadence (default 30 s per SLOW_POLL_INTERVAL_S setting).

    Returns a dict keyed to slow-field names, or None on failure.
    Safe defaults (0 or None) for missing regs preserve backward-compat if
    the device doesn't support the full range.

    Wire format: read_input_registers(address=64, count=53, unit=unit)
      Modbus addresses 30065Ã¢â‚¬â€œ30117 (PDF Ã‚Â§2 p6Ã¢â‚¬â€œ9)

    Field decode (per PDF + plan Ã‚Â§2 register map):
      addr 64-65  30065-30066  Instantaneous alarms        UInt32 hi-lo
      addr 66-67  30067-30068  Maintained alarms            UInt32 hi-lo
      addr 68     30069        QAC reactive power (signed)  Int16, raw Ãƒâ€” 10 = VAr
      addr 69     30070        Zpos (impedance POS-EARTH)   UInt16 (assumed kÃŽÂ© Ã¢â‚¬â€ verify vs ISM)
      addr 70     30071        Zneg (impedance NEG-EARTH)   UInt16 (assumed kÃŽÂ© Ã¢â‚¬â€ verify vs ISM)
      addr 71     30072        (reserved)
      addr 72     30073        TempINT control electronics  Int16 signed, Ã‚Â°C
      addr 73     30074        Estado inverter state        UInt16 bitfield
      addr 74-75  30075-30076  VpvN / VpvP solar voltages   UInt16 each, V
      addr 76     30077        Nominal power ÃƒÂ·10            UInt16, raw Ãƒâ€” 10 = W
      addr 77-107 30078-30108  (skip: standard stop-reason history, Slice ÃŽÂµ)
      addr 108    30109        Time-to-connect remaining    UInt16 seconds
      addr 109    30110        Time-to-connect total        UInt16 seconds
      addr 110-115 30111-30115 (skip: MS mirrors, dynamic on this site)
      addr 116    30117        Power-reduction status bits   UInt16 bitfield

    Notes:
      - TempINT (addr 72) threshold 80 Ã‚Â°C; newly captured, not yet surfaced in UI
      - Estado (addr 73) decoded by Slice ÃŽÂ³; Slice ÃŽÂ² just captures raw bitfield
      - Nominal power (addr 76) cross-checks operator-configured ratedKw
      - Power-reduction bits (addr 116) bit 0 = limited, bit 1 = Modbus reduction (critical for Slice ÃŽÂ´)
    """
    if is_write_pending(ip):
        await asyncio.sleep(min(READ_SPACING, 0.01))
        return None

    regs = await safe_read(_threaded_read_input, client, 64, 53, unit, ip)
    if not regs:
        return None

    def reg(i):
        return regs[i] if len(regs) > i else 0

    # Instantaneous alarms (regs 0-1 in the read, offset 64 in the device)
    try:
        alarms_inst_32 = _u32_hi_lo(regs, 0)   # regs[0:2] Ã¢â€ â€™ addr 64-65
    except ValueError:
        alarms_inst_32 = 0

    # Maintained alarms (regs 2-3 in the read, offset 66 in the device)
    try:
        alarms_maint_32 = _u32_hi_lo(regs, 2)  # regs[2:4] Ã¢â€ â€™ addr 66-67
    except ValueError:
        alarms_maint_32 = 0

    # QAC reactive power (addr 68, reg index 4 in this read) Ã¢â‚¬â€ Int16 signed.
    # PDF page 7: "30069 QAC (Reactive power DIV 10)" Ã¢â‚¬â€ same convention as
    # 30019 PAC ("in tens of Watt") and 30077 Nominal power ("DIV 10"), both
    # confirmed as raw Ãƒâ€” 10 = real (W). By symmetry: raw Ãƒâ€” 10 = VAr here.
    # Earlier code used raw / 10 which under-reported reactive power by 100Ãƒâ€”.
    # See audits/2026-05-11/register-decode-traceback.md Finding 1.
    qac_raw = int(reg(4) or 0)
    if qac_raw & 0x8000:
        qac_raw -= 0x10000
    qac_var = qac_raw * 10 if qac_raw != 0 else None  # None = offline/silent

    # Impedances
    zpos_kohm = int(reg(5) or 0)   # addr 69, unsigned
    zneg_kohm = int(reg(6) or 0)   # addr 70, unsigned

    # Control electronics temperature (addr 72, reg index 8 in this read) Ã¢â‚¬â€ Int16 signed
    tempint_raw = int(reg(8) or 0)
    if tempint_raw & 0x8000:
        tempint_raw -= 0x10000
    # Threshold: 80 Ã‚Â°C per PDF. Unlike TempCI, no -1 offset or -14 sentinel documented.
    # Store as-is; UI can apply thresholds.
    tempint_c = tempint_raw if tempint_raw != 0 else None

    # Estado inverter state (addr 73, reg index 9) Ã¢â‚¬â€ UInt16 bitfield, decoded by Slice ÃŽÂ³
    inverter_state_raw = int(reg(9) or 0)

    # Solar field voltages (addr 74-75, reg indices 10-11)
    vpv_n_v = int(reg(10) or 0)   # Negative-earth
    vpv_p_v = int(reg(11) or 0)   # Positive-earth

    # Nominal power ÃƒÂ·10 (addr 76, reg index 12) Ã¢â‚¬â€ UInt16, units = tens of W
    nominal_power_w = int((reg(12) or 0) * 10)  # Convert tens to watts

    # Time-to-connect counters (addr 108-109, reg indices 44-45)
    time_to_connect_s = int(reg(44) or 0)        # Remaining
    time_to_connect_total_s = int(reg(45) or 0)  # Configured total

    # Power-reduction status bits (addr 116, reg index 52 in this read)
    power_reduction_bits = int(reg(52) or 0)

    return {
        "ts":                   int(time.time() * 1000),
        # Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Alarm windows Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
        "alarms_inst_32":       alarms_inst_32,     # 1-second reset window
        "alarms_maint_32":      alarms_maint_32,    # Reset on grid reconnect
        # Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Reactive / diagnostics Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
        "qac_var":              qac_var,            # Reactive W (None if offline)
        "zpos_kohm":            zpos_kohm,          # Impedance POS-EARTH
        "zneg_kohm":            zneg_kohm,          # Impedance NEG-EARTH
        "tempint_c":            tempint_c,          # Control electronics Ã‚Â°C (threshold 80)
        # Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ State / capability Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
        "inverter_state_raw":   inverter_state_raw, # Decoded by Slice ÃŽÂ³
        "vpv_n_v":              vpv_n_v,            # Solar field voltage NEG-EARTH
        "vpv_p_v":              vpv_p_v,            # Solar field voltage POS-EARTH
        "nominal_power_w":      nominal_power_w,    # Rated power as reported by device
        # Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Connection / control Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
        "time_to_connect_s":           time_to_connect_s,
        "time_to_connect_total_s":     time_to_connect_total_s,
        "power_reduction_bits":        power_reduction_bits,  # Bit 1 = Modbus reduction active (Slice ÃŽÂ´)
        "unit":                 unit,  # Pass along for frame merge
    }

async def read_standard_stop_reasons(client, slave, ip):
    """
    Read 31 input registers (30078Ã¢â‚¬â€œ30108) Ã¢â‚¬â€ standard-Modbus stop-reason ring buffer.

    Returns a dict:
      {
        "inverter_ip": str,
        "slave": int,
        "read_at_ms": int,
        "pointer": int,         # 0..4, slot index of most recent event
        "slots": [ {slot, pointer_points_here, timestamp_iso, motive_code, motive_name, raw} Ãƒâ€” 5 ]
      }

    Triggered on-demand from Node via the /stop-reasons/standard FastAPI route.
    Per-IP lock mirrors Slice ÃŽÂ² (read_slow_async) to avoid concurrent reads.

    Offline marker: year=0 Ã¢â€ â€™ timestamp_iso="offline", motive_code=-1.

    Wire format (Slice ÃŽÂµ spec Ã‚Â§3):
      read_input_registers(addr=77, count=31, slave=slave)
      Pointer at reg 30078 Ã¢â€ â€™ most recent slot (0Ã¢â‚¬â€œ4)
      5 slots of 6 regs each: [year, month, day, hour, minute, motive_code]

    Related plan: plans/2026-05-10-modbus-registers-official-revamp.md Ã‚Â§4 Slice ÃŽÂµ
    """
    from datetime import datetime as _dt

    if is_write_pending(ip):
        await asyncio.sleep(min(READ_SPACING, 0.01))
        return None

    regs = await safe_read(_threaded_read_input, client, 77, 31, slave, ip)
    if not regs or len(regs) < 31:
        return None

    def reg(i):
        return regs[i] if len(regs) > i else 0

    read_at_ms = int(time.time() * 1000)
    pointer = int(reg(0) or 0) & 0x07  # Mask to 0-7, expect 0-4
    slots = []

    # Parse 5 slots (6 registers each)
    for slot_idx in range(5):
        base = 1 + (slot_idx * 6)
        year = int(reg(base) or 0)
        month = int(reg(base + 1) or 0)
        day = int(reg(base + 2) or 0)
        hour = int(reg(base + 3) or 0)
        minute = int(reg(base + 4) or 0)
        motive_code_raw = int(reg(base + 5) or 0)

        # Decode signed motive code using the same _signed_int16 helper
        motive_code = _signed_int16(motive_code_raw)

        # Check for offline slot (year=0)
        if year == 0:
            timestamp_iso = "offline"
            motive_code = -1
            captured_at_ms = None
        else:
            # Clamp invalid datetime values to valid ranges
            year_adj = 2000 + min(max(int(year), 0), 99)
            month_clamped = min(max(int(month), 1), 12)
            day_clamped = min(max(int(day), 1), 31)
            hour_clamped = min(max(int(hour), 0), 23)
            minute_clamped = min(max(int(minute), 0), 59)

            try:
                dt_obj = _dt(year_adj, month_clamped, day_clamped, hour_clamped, minute_clamped, 0)
                timestamp_iso = dt_obj.isoformat() + "Z"
                captured_at_ms = int(dt_obj.timestamp() * 1000)
            except (ValueError, OverflowError):
                # Fallback for truly invalid datetimes
                timestamp_iso = f"invalid({year_adj:04d}-{month_clamped:02d}-{day_clamped:02d}T{hour_clamped:02d}:{minute_clamped:02d})"
                captured_at_ms = None

        slot_dict = {
            "slot": slot_idx,
            "pointer_points_here": (slot_idx == pointer),
            "timestamp_iso": timestamp_iso,
            "motive_code": motive_code,
            "motive_name": _get_motive_label(motive_code),
            "raw": {
                "year": int(reg(base)),
                "month": int(reg(base + 1)),
                "day": int(reg(base + 2)),
                "hour": int(reg(base + 3)),
                "minute": int(reg(base + 4)),
                "motive_code_raw": motive_code_raw,
            }
        }
        slots.append(slot_dict)

    # Sort: pointer-pointed slot first, then offline last
    def slot_sort_key(s):
        if s["timestamp_iso"] == "offline":
            return (1, 0)  # offline last
        if s["pointer_points_here"]:
            return (0, 0)  # pointer first
        return (0, 1)     # other valid slots after pointer

    slots.sort(key=slot_sort_key)

    return {
        "inverter_ip": ip,
        "slave": int(slave),
        "read_at_ms": read_at_ms,
        "pointer": pointer,
        "slots": slots,
    }

def _get_motive_label(code):
    """
    Get the human-readable label for a motive code (0Ã¢â‚¬â€œ30, or edge cases like -1).

    Canonical source: server/motiveLabelsStd.js
    This table is embedded inline here for Python self-containedness.
    Both must stay in sync.

    Related plan: plans/slice-epsilon-implementation.md Ã‚Â§4
    """
    motive_labels = {
        0: "MOTIVO_PARO_NONE",
        1: "MOTIVO_PARO_VIN",
        2: "MOTIVO_PARO_FRED",
        3: "MOTIVO_PARO_VRED",
        4: "MOTIVO_PARO_VARISTORES",
        5: "MOTIVO_PARO_AISL_DC",
        6: "MOTIVO_PARO_IAC_EFICAZ",
        7: "MOTIVO_PARO_TEMPERATURA",
        8: "MOTIVO_PARO_LATENCIA_SPI",
        9: "MOTIVO_PARO_CONFIGURACION",
        10: "MOTIVO_PARO_PARO_MANUAL",
        11: "MOTIVO_PARO_BAJA_VPV_MED",
        12: "MOTIVO_PARO_HW_DESCX2",
        13: "MOTIVO_PARO_FRAMA3",
        14: "MOTIVO_PARO_MAX_IAC_INST",
        15: "MOTIVO_PARO_CARGA_FIRMWARE",
        16: "MOTIVO_PARO_REDUNDANTE",
        17: "MOTIVO_PARO_PROTECCION_PIB",
        18: "MOTIVO_PARO_ERROR_LEC_ADC",
        19: "MOTIVO_PARO_CONSUMO_POTENCIA",
        20: "MOTIVO_PARO_FUS_DC",
        21: "MOTIVO_PARO_TEMP_AUX",
        22: "MOTIVO_PARO_PROT_AC",
        23: "MOTIVO_PARO_MAGNETO",
        24: "MOTIVO_PARO_CONTACTOR",
        25: "MOTIVO_PARO_RESET_WD",
        26: "MOTIVO_PARO_PI_ANA_SAT",
        27: "MOTIVO_PARO_LATENCIA_ADC",
        28: "MOTIVO_PARO_ERROR_FATAL",
        29: "MOTIVO_PARO_FRAMA1",
        30: "MOTIVO_PARO_FRAMA2",
    }
    code_num = int(code)
    return motive_labels.get(code_num, f"unknown({code_num})")

# -------------------------------------------------
#   Slow-poll loop (one coroutine per inverter)
# -------------------------------------------------

async def slow_poll_inverter(ip):
    """
    Slow-poll diagnostic registers (addr 64Ã¢â‚¬â€œ116) every SLOW_POLL_INTERVAL_S (default 30 s).
    Merges slow data into shared[ip] by attaching slow fields to the most recent frame.

    Slice ÃŽÂ² (v2.10.x) Ã¢â‚¬â€ runs in parallel with fast-poll, independent timing.

    Operation:
      1. Wait for a live client (same as poll_inverter)
      2. Discover units via detect_units_async
      3. For each unit, call read_slow_async()
      4. Attach slow fields to the most recent frame in shared[ip] matching the unit
      5. Sleep for SLOW_POLL_INTERVAL_S and repeat

    Settings:
      - SLOW_POLL_INTERVAL_S: read once at module load from `ADSI_SLOW_POLL_INTERVAL_S`
        environment variable. Default 30, clamped to [5, 300] (or 0 to disable the
        slow-poll tier entirely). Operator restart required to apply changes.
        Runtime tuning via the settings API is NOT yet wired Ã¢â‚¬â€ deferred to a
        follow-up if operator demand emerges.
    """
    print(f"[SLOW-POLL] Started {ip} every {SLOW_POLL_INTERVAL_S}s")

    while True:
        # Cadence read from module-level SLOW_POLL_INTERVAL_S (env-tunable
        # via ADSI_SLOW_POLL_INTERVAL_S; clamped 5-300 s at startup, 0 = disabled).
        slow_interval = SLOW_POLL_INTERVAL_S

        # Disable slow-poll entirely if interval is 0 (operator opt-out).
        if slow_interval <= 0:
            await asyncio.sleep(60)
            continue

        # Ã¢â€â‚¬Ã¢â€â‚¬ Wait for a live client Ã¢â€â‚¬Ã¢â€â‚¬
        client = clients.get(ip)
        if not client:
            await asyncio.sleep(0.5)
            continue

        # Skip the whole slow-poll cycle (incl. unit detection probes)
        # while a firmware flash holds this inverter Ã¢â‚¬â€ see
        # firmware_flash_active() / poll_inverter().
        if firmware_flash_active(ip):
            await asyncio.sleep(min(slow_interval, 2.0))
            continue

        # Ã¢â€â‚¬Ã¢â€â‚¬ Discover units Ã¢â€â‚¬Ã¢â€â‚¬
        units = await detect_units_async(ip)

        if not units:
            await asyncio.sleep(1)
            continue

        # Ã¢â€â‚¬Ã¢â€â‚¬ Slow-poll cycle Ã¢â€â‚¬Ã¢â€â‚¬
        try:
            inv_num = inverter_number_from_ip(ip)

            for u in units:
                # Respect write-pending gate
                if is_write_pending(ip):
                    await asyncio.sleep(min(slow_interval, 0.05))
                    break

                # Read slow registers
                slow_data = await read_slow_async(client, u, ip)
                if not slow_data:
                    continue

                # Merge into shared[ip]: find the most recent frame matching this unit
                if ip in shared:
                    for frame in reversed(shared[ip]):
                        if frame.get("unit") == u:
                            # Attach all slow fields to this frame
                            frame.update(slow_data)
                            break

            await asyncio.sleep(slow_interval)

        except asyncio.CancelledError:
            # Cooperative cancel from supervisor
            raise
        except Exception as e:
            # Log and continue; do not let a single bad slow-poll cycle freeze
            print(f"[SLOW-POLL] {ip} cycle error (continuing): {type(e).__name__}: {e}")
            await asyncio.sleep(min(slow_interval, 1.0))

# -------------------------------------------------
#   Poll loop (one coroutine per inverter)
# -------------------------------------------------

async def poll_inverter(ip):
    interval = max(MIN_POLL_INTERVAL, intervals.get(ip, DEFAULT_INTERVAL))
    print(f"[POLL] Started  {ip}  every {interval}s")

    while True:
        # Ã¢â€â‚¬Ã¢â€â‚¬ Wait for a live client Ã¢â€â‚¬Ã¢â€â‚¬
        client = clients.get(ip)
        if not client:
            await asyncio.sleep(0.5)
            continue

        # Ã¢â€â‚¬Ã¢â€â‚¬ Firmware-flash backoff (BEFORE unit detection) Ã¢â€â‚¬Ã¢â€â‚¬
        # detect_units_async() issues Modbus probe reads. On a COLD engine
        # start while a calibrator flash is already in progress (calibrator
        # opened first, dashboard second), this is the FIRST bus traffic to
        # the inverter and would collide with the flash. slow_poll_inverter
        # already guards before its detect; poll_inverter must too. The
        # per-unit guard further down still covers a flash that begins
        # mid-cycle. FAIL-OPEN: no/*bad marker -> firmware_flash_active()
        # is False -> polling proceeds exactly as before.
        if firmware_flash_active(ip):
            await asyncio.sleep(min(interval, 1.0))
            continue

        # Ã¢â€â‚¬Ã¢â€â‚¬ Discover units Ã¢â€â‚¬Ã¢â€â‚¬
        units = await detect_units_async(ip)
        print(f"[POLL] {ip}  units: {units}")

        if not units:
            await asyncio.sleep(1)
            continue

        # Ã¢â€â‚¬Ã¢â€â‚¬ Continuous poll Ã¢â€â‚¬Ã¢â€â‚¬
        # T3.6 fix (Phase 6, 2026-04-14): wrap inner cycle in try/except so a
        # single bad read (KeyError from a mid-rebuild map flip, transient
        # asyncio.CancelledError edge, decode error from a misbehaving
        # inverter, etc.) does not kill the whole task and force the
        # supervisor's ~1 s restart.  The supervisor restart path was the
        # original "one bad inverter freezes everyone" symptom.
        while True:
            try:
                # Hot-reload safety (v2.11.0-beta.6): re-read the unit list AND
                # poll interval each cycle so that an ipconfig change
                # (add/remove node, retune poll interval) takes effect without
                # a service restart. Previously these were captured once at
                # task start; the inner loop never reached the outer
                # `detect_units_async` again while the client stayed up, so a
                # newly-added unit was never polled and its dashboard row
                # showed "-" forever.
                #
                # IMPORTANT: only consult the static override (configured
                # units). Bypass `detect_units_async` because its auto-probe
                # path issues 4 Modbus reads when `static_units[ip]` is empty,
                # which would multiply per-cycle bus traffic 4x for any
                # IP-only-configured inverter. The auto-detect result from the
                # outer iter is preserved by leaving `units` untouched in that
                # case. The 5 s probe-failure throttle inside
                # `detect_units_async` is also avoided so an operator config
                # change is honored immediately even after a probe miss.
                override = static_units.get(ip)
                if override and list(override) != units:
                    new_units = list(override)
                    print(f"[POLL] {ip}  units changed {units} -> {new_units}")
                    # Reclaim dead-node backoff state for units that are no
                    # longer polled, so a unit-count reduction can't leave
                    # orphaned _unit_health entries (bounded, but keep it tight).
                    if not DISABLE_UNIT_DEAD_BACKOFF:
                        for _gone in units:
                            if _gone not in new_units:
                                _unit_health.pop((ip, _gone), None)
                    units = new_units
                interval = max(MIN_POLL_INTERVAL, intervals.get(ip, DEFAULT_INTERVAL))

                client = clients.get(ip)
                if not client:
                    break

                # Firmware flash in progress for this inverter Ã¢â‚¬â€ back off
                # the bus entirely this cycle so the calibrator is the sole
                # Modbus master (mirrors the is_write_pending skip below).
                if firmware_flash_active(ip):
                    await asyncio.sleep(min(interval, 1.0))
                    continue

                out     = []
                inv_num = inverter_number_from_ip(ip)
                if inv_num is None:
                    print(f"[POLL] WARNING: no inverter number for IP {ip} Ã¢â‚¬â€ data will be dropped")
                    await asyncio.sleep(1)
                    break  # wait for ip_map to be rebuilt

                for u in units:
                    if is_write_pending(ip):
                        await asyncio.sleep(min(interval, 0.05))
                        break

                    # Ã¢â€â‚¬Ã¢â€â‚¬ Per-unit dead-node backoff Ã¢â€â‚¬Ã¢â€â‚¬
                    # Skip a unit that is in the throttled state until its
                    # re-probe window elapses, so one dead/absent node on this
                    # inverter can't inject a shared-socket reconnect + double
                    # read-timeout into every cycle and starve its healthy
                    # sibling nodes (which share the same TCP socket).
                    hk = (ip, u)
                    if not DISABLE_UNIT_DEAD_BACKOFF:
                        h = _unit_health.get(hk)
                        if h and h.get("throttled") and time.monotonic() < h.get("next_probe", 0.0):
                            continue

                    data = await read_fast_async(client, u, ip)
                    if not data:
                        # Track consecutive misses; throttle once a unit looks
                        # dead so the costly reconnect path is paid every
                        # UNIT_DEAD_REPROBE_S instead of every cycle.
                        #
                        # Exclude write-induced misses: read_fast_async returns
                        # None whenever a control write is pending on this IP, so
                        # counting those would let an operator write-burst
                        # false-throttle a perfectly reachable node. Only true
                        # no-answer reads advance the dead-node counter.
                        if not DISABLE_UNIT_DEAD_BACKOFF and not is_write_pending(ip):
                            h = _unit_health.get(hk) or {"fail": 0, "throttled": False, "next_probe": 0.0}
                            h["fail"] = int(h.get("fail", 0)) + 1
                            if h["fail"] >= UNIT_DEAD_FAIL_THRESHOLD:
                                if not h.get("throttled"):
                                    print(
                                        f"[POLL] {ip} unit {u} unresponsive x{h['fail']} Ã¢â‚¬â€ "
                                        f"throttling its probe to every {UNIT_DEAD_REPROBE_S:.1f}s so "
                                        f"the inverter's other nodes keep polling fast"
                                    )
                                h["throttled"] = True
                                h["next_probe"] = time.monotonic() + UNIT_DEAD_REPROBE_S
                            _unit_health[hk] = h
                        continue

                    # Healthy read Ã¢â‚¬â€ clear any throttle so the unit returns to
                    # the fast every-cycle cadence immediately on recovery.
                    if not DISABLE_UNIT_DEAD_BACKOFF and hk in _unit_health:
                        if _unit_health[hk].get("throttled"):
                            print(f"[POLL] {ip} unit {u} responsive again Ã¢â‚¬â€ resuming fast polling")
                        _unit_health.pop(hk, None)

                    data["source_ip"] = ip
                    data["inverter"] = inv_num if inv_num is not None else -1
                    data["unit"]     = u
                    data["node_number"] = u
                    out.append(data)

                    # Trigger auto-reset check (non-blocking)
                    key   = (ip, u)
                    entry = auto_reset_state.get(key, {"busy": False})
                    if not entry.get("busy"):
                        asyncio.create_task(handle_auto_reset(ip, u, data["alarm"]))

                    # v2.9.0 Slice E Ã¢â‚¬â€ drift / year-invalid clock-sync triggers (non-blocking)
                    try:
                        if data.get("rtc_valid") and data.get("rtc_drift_s") is not None:
                            if abs(float(data["rtc_drift_s"])) > _DRIFT_TRIGGER_THRESHOLD_S:
                                asyncio.create_task(
                                    maybe_trigger_drift_sync(ip, u, float(data["rtc_drift_s"]))
                                )
                        elif not data.get("rtc_valid"):
                            y_probe = int(data.get("year") or 0)
                            if y_probe > 2100 or (0 < y_probe < 2000):
                                asyncio.create_task(
                                    trigger_year_invalid_sync(ip, u, y_probe)
                                )
                    except Exception as _trig_exc:
                        # Never let trigger failure break poll loop
                        pass

                # Do not wipe last good frame on transient all-unit read misses.
                if out:
                    shared[ip] = list(out)

                # Ã¢â€â‚¬Ã¢â€â‚¬ Per-IP self-healing client rebuild Ã¢â€â‚¬Ã¢â€â‚¬
                # Track whether THIS inverter produced any successful read this
                # cycle. After IP_REBUILD_AFTER_S of nothing-but-misses, the
                # cached client/socket is likely wedged in a way close()/connect()
                # can't clear Ã¢â‚¬â€ rebuild it from scratch (what changing the IP used
                # to do manually). Rate-limited + skipped during writes/flash.
                now_mono = time.monotonic()
                h_ip = _ip_health.setdefault(
                    ip, {"last_success": now_mono, "last_rebuild": 0.0}
                )
                if out:
                    h_ip["last_success"] = now_mono
                elif should_rebuild_client(
                    now_mono,
                    h_ip["last_success"],
                    h_ip["last_rebuild"],
                    DISABLE_IP_CLIENT_REBUILD,
                    is_write_pending(ip),
                    firmware_flash_active(ip),
                ):
                    await rebuild_ip_client(
                        ip,
                        "no successful reads in %.0fs" % (now_mono - h_ip["last_success"]),
                    )

                await asyncio.sleep(interval)
            except asyncio.CancelledError:
                # Cooperative cancel from supervisor; propagate.
                raise
            except Exception as e:
                # Log and keep looping; do not let a single bad cycle freeze
                # this IP or trigger supervisor churn.
                print(f"[POLL] {ip} cycle error (continuing): {type(e).__name__}: {e}")
                await asyncio.sleep(min(interval, 1.0))

# -------------------------------------------------
#   Global map rebuild
# -------------------------------------------------

async def rebuild_global_maps(cfg=None):
    """
    Re-read ipconfig.json and reconcile clients / threads / queues.
    Safe to call at runtime (e.g. from the file watcher).
    """
    global ip_map, inverters, intervals, static_units

    if cfg is None:
        cfg = await load_ipconfig()

    # T3.9 fix (Phase 6, 2026-04-14): build the new maps in LOCAL variables
    # first, then atomically swap them into the module globals.  The previous
    # code mutated `intervals = {}` and `static_units.clear()` mid-rebuild;
    # any concurrent poll task iterating those dicts could see them empty
    # (KeyError, "no inverter number") for a window of ~1 ms.  CPython
    # single-statement rebinding of the module attribute is atomic under the
    # GIL, so swap-after-build is race-free without an explicit lock.
    new_ip_map = cfg["inverters"]
    poll_cfg   = cfg["poll_interval"]
    unit_cfg   = cfg["units"]

    new_inverters = []
    new_intervals = {}
    new_static_units = {}
    fast_poll_inverters = []
    for i in range(1, 28):
        ip = str(new_ip_map.get(str(i), "")).strip()
        if not ip:
            continue
        new_inverters.append(ip)
        try:
            poll = float(poll_cfg.get(str(i), DEFAULT_INTERVAL))
        except Exception:
            poll = DEFAULT_INTERVAL
        poll = poll if poll >= 0.01 else DEFAULT_INTERVAL
        effective = max(MIN_POLL_INTERVAL, poll)
        new_intervals[ip] = effective
        new_static_units[ip] = unit_cfg.get(str(i))
        if effective < RECOMMENDED_POLL_INTERVAL:
            fast_poll_inverters.append((i, ip, effective))
    if fast_poll_inverters:
        sample = ", ".join(
            f"inv{inv}@{iv:.2f}s" for inv, _ip, iv in fast_poll_inverters[:3]
        )
        more = f" (+{len(fast_poll_inverters) - 3} more)" if len(fast_poll_inverters) > 3 else ""
        print(
            f"[POLL WARN] {len(fast_poll_inverters)} inverter(s) polling faster than "
            f"{RECOMMENDED_POLL_INTERVAL:.1f}s recommended by Ingeteam Level 2 "
            f"(AAV2011IFA01_ p.8, 0x0008 alarm). Sample: {sample}{more}. "
            f"Tight polling can trigger DSP watchdog resets if the inverter firmware "
            f"enforces the 1 Hz recommendation.",
            flush=True,
        )

    # Atomic swaps (single-statement rebinding under GIL).
    # Phase 8 code-review fix (2026-04-15): use rebind for `static_units` too
    # (was clear()+update() before).  Previously a concurrent reader of
    # `detect_units_async` could observe static_units mid-rebuild as empty
    # and fall through to Modbus auto-detect for the ~1 Ã‚Âµs window.  Rebind
    # avoids the window entirely, matching `intervals` and `ip_map`.
    ip_map = new_ip_map
    inverters[:] = new_inverters  # in-place because consumers hold the list ref
    intervals = new_intervals
    static_units = new_static_units

    # Ã¢â€â‚¬Ã¢â€â‚¬ Bring up new inverters Ã¢â€â‚¬Ã¢â€â‚¬
    for ip in inverters:
        if ip not in clients:
            loop = asyncio.get_running_loop()
            try:
                c = await loop.run_in_executor(executor, create_client, ip, 502, _modbus_timeout)
            except Exception:
                c = None
            clients[ip] = c

        thread_locks.setdefault(ip, threading.Lock())
        write_pending.setdefault(ip, threading.Event())
        # T3.11 fix (Phase 6, 2026-04-14): bound the write queue per-IP so a
        # burst of operator clicks (or a stuck UI retry loop) cannot grow
        # RAM unbounded.  64 in-flight commands per inverter is well above
        # any realistic operator workflow; producers see queue.Full and
        # propagate as a 429 to the caller.
        write_queues.setdefault(ip, Queue(maxsize=64))

        if ip not in write_threads or not write_threads[ip].is_alive():
            t = threading.Thread(
                target=write_worker_loop,
                args=(ip, thread_locks[ip], write_queues[ip]),
                daemon=True,
            )
            write_threads[ip] = t
            t.start()

    # Ã¢â€â‚¬Ã¢â€â‚¬ Tear down removed inverters Ã¢â€â‚¬Ã¢â€â‚¬
    for ip in list(clients.keys()):
        if ip not in inverters:
            if ip in write_queues:
                try:   write_queues[ip].put(None)
                except Exception: pass
                write_queues.pop(ip, None)

            write_threads.pop(ip, None)

            try:   clients.pop(ip).close()
            except Exception: pass

            thread_locks.pop(ip, None)
            evt = write_pending.pop(ip, None)
            if evt:
                evt.clear()
            intervals.pop(ip, None)
            shared.pop(ip, None)   # remove stale live-data so dropped inverters don't linger in /data
            _ip_health.pop(ip, None)  # drop self-healing rebuild state for removed IP
            for _u in (1, 2, 3, 4):
                _unit_health.pop((ip, _u), None)  # drop dead-node backoff state for removed IP

    # Ã¢â€â‚¬Ã¢â€â‚¬ Reclaim metrics_state for nodes no longer in the config Ã¢â€â‚¬Ã¢â€â‚¬
    # PY-POLL-002 fix (2026-05-29): rebuild teardown above prunes clients /
    # shared / locks for a removed IP, but the five metrics_state dicts
    # (pacEnergy, pdcData, uiAlarm, lastUpdate, pacEnergyHistory) are keyed by
    # `{inverter}_{module}` and were never reclaimed Ã¢â‚¬â€ so a node removed from
    # ipconfig leaked memory (pacEnergyHistory grows one float per day) AND
    # lingered in /metrics output until its 31.5 s offline cutoff every poll.
    #
    # Build the live node-key set "{inverter}_{unit}" from the NEW config,
    # probing slots 1..27 of ip_map (immune to malformed/extra keys Ã¢â‚¬â€ no int()
    # on arbitrary dict keys). Identity is the inverter NUMBER, not the IP Ã¢â‚¬â€ so
    # a re-cabled inverter (same number, new IP) keeps its accumulators; only
    # genuinely removed numbers AND units dropped from an inverter's unit list
    # are reclaimed. An inverter with no explicit unit override (auto-detect)
    # keeps all four slots since its real unit set isn't known here. Node owns
    # the authoritative PAC integration regardless, so this can never lose
    # energy even if a node key is mis-derived.
    configured_nodes = set()
    for i in range(1, 28):
        ip_i = str(ip_map.get(str(i), "")).strip()
        if not ip_i:
            continue
        u_list = static_units.get(ip_i)
        units_for_i = []
        for u in (u_list if u_list else (1, 2, 3, 4)):
            try:
                units_for_i.append(int(u))
            except Exception:
                continue
        if not units_for_i:
            units_for_i = [1, 2, 3, 4]
        for u in units_for_i:
            configured_nodes.add(f"{i}_{u}")
    for _sub in ("pacEnergy", "pdcData", "uiAlarm", "lastUpdate", "pacEnergyHistory"):
        _d = metrics_state.get(_sub)
        if not isinstance(_d, dict):
            continue
        for _nk in list(_d.keys()):
            if str(_nk) not in configured_nodes:
                _d.pop(_nk, None)

    print(f"[IPCONFIG] Maps rebuilt Ã¢â‚¬â€ {len(inverters)} inverter(s) active")

# -------------------------------------------------
#   v2.9.0 Slice C/E/F Ã¢â‚¬â€ health gates, crash recovery, clock triggers
# -------------------------------------------------

NODE_API_BASE = os.environ.get("NODE_API_BASE", "http://127.0.0.1:3500")
DISABLE_COUNTER_RECOVERY = os.environ.get("DISABLE_COUNTER_RECOVERY", "").strip() in ("1", "true", "yes")

# Last-sync-attempt throttle for drift trigger: {(inv, unit) -> ts_ms}.
# PY-C-004 audit flagged this as "unbounded growth" but keys are
# (inverter_number, unit_number) integers Ã¢â‚¬â€ bounded by fleet size
# (Ã¢â€°Â¤ 27 Ãƒâ€” 4 + 27 Ãƒâ€” 4 year-keys Ã¢â€°Ë† 216 entries max, not IPs). No TTL needed.
_last_drift_sync_at = {}
_DRIFT_SYNC_COOLDOWN_MS = 4 * 3600 * 1000    # 4 h
_DRIFT_TRIGGER_THRESHOLD_S = 3600.0          # 1 h Ã¢â‚¬â€ overrideable by Node setting

def _http_get_json(url: str, timeout_s: float = 5.0):
    """Stdlib HTTP GET returning parsed JSON or None on failure."""
    import urllib.request
    try:
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            if getattr(resp, "status", 200) != 200:
                return None
            body = resp.read().decode("utf-8", errors="replace")
            return json.loads(body) if body else None
    except Exception:
        return None

def _http_post_json(url: str, payload: dict, timeout_s: float = 3.0):
    """Stdlib HTTP POST of JSON body. Returns parsed JSON or None."""
    import urllib.request
    try:
        data = json.dumps(payload or {}).encode("utf-8")
        req = urllib.request.Request(
            url, data=data,
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
        )
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            return json.loads(body) if body else {}
    except Exception:
        return None

# Ã¢â€â‚¬Ã¢â€â‚¬ Slice F Ã¢â‚¬â€ health gates Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

def rtc_year_valid(frame_or_state: dict, server_now=None) -> bool:
    """Last observed RTC year within Ã‚Â±1 of server year."""
    from datetime import datetime as _dt
    if not frame_or_state or not frame_or_state.get("rtc_valid"):
        return False
    rtc_ms = frame_or_state.get("rtc_ms")
    if rtc_ms is None:
        return False
    try:
        rtc_dt = _dt.fromtimestamp(int(rtc_ms) / 1000.0)
    except Exception:
        return False
    now = server_now or _dt.now()
    return abs(rtc_dt.year - now.year) <= 1

def counter_advancing(history: list, window_s: int = 300,
                       pac_idle_w: int = 500) -> bool:
    """
    history: list of dicts ordered oldestÃ¢â€ â€™newest, each with keys
             {ts_ms, etotal_kwh, pac_w}.
    Returns True if EITHER:
      Ã¢â‚¬Â¢ etotal_kwh strictly increased at least once in the window
      Ã¢â‚¬Â¢ mean(pac_w) over the window < pac_idle_w  (unit idle Ã¢â€ â€™ no tick expected)
    """
    if not history or len(history) < 2:
        return True
    now_ms = history[-1].get("ts_ms", 0)
    cutoff = now_ms - window_s * 1000
    recent = [r for r in history if r.get("ts_ms", 0) >= cutoff]
    if len(recent) < 2:
        return True
    mean_pac = sum(r.get("pac_w", 0) for r in recent) / float(len(recent))
    if mean_pac < pac_idle_w:
        return True
    vals = [r.get("etotal_kwh", 0) for r in recent]
    return any(b > a for a, b in zip(vals, vals[1:]))

def parce_precision_ok(history: list, pac_integrated_wh: float,
                       window_s: int = 300) -> bool:
    """parcE delta/PAC ratio sanity: catches firmware that exposes parcE at wrong scale."""
    if pac_integrated_wh <= 0 or not history or len(history) < 2:
        return True
    dp = history[-1].get("parce_kwh", 0) - history[0].get("parce_kwh", 0)
    if dp <= 0:
        return False
    ratio = dp / float(pac_integrated_wh)
    return 0.00050 <= ratio <= 0.01100

def trust_etotal(frame_state, history, server_now=None) -> bool:
    return rtc_year_valid(frame_state, server_now) and counter_advancing(history)

def trust_parce(frame_state, history, pac_wh, server_now=None) -> bool:
    return (rtc_year_valid(frame_state, server_now)
            and counter_advancing(history)
            and parce_precision_ok(history, pac_wh))

# Ã¢â€â‚¬Ã¢â€â‚¬ Slice C Ã¢â‚¬â€ crash-recovery seed Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

async def audit_counter_recovery(inverter, unit, source, recovered_kwh, reason):
    """Best-effort audit-log write to Node for each recovery decision."""
    loop = asyncio.get_running_loop()
    def _post():
        _http_post_json(
            f"{NODE_API_BASE}/api/audit/counter-recovery",
            {"inverter": int(inverter), "unit": int(unit),
             "source": source, "recovered_kwh": float(recovered_kwh or 0),
             "reason": reason or ""},
            timeout_s=3.0,
        )
    try:
        await loop.run_in_executor(executor, _post)
    except Exception:
        pass

def classify_seed_decision(
    cur_etotal,
    cur_parce,
    today_baseline_etotal,
    today_baseline_parce,
    yesterday_etotal,
    yesterday_present,
    rtc_year_ok,
    night_gap_sanity_kwh=50,
    delta_sanity_cap_kwh=50_000,
):
    """
    Pure decision function for v2.9.1 crash-recovery seed gating.

    Returns (recovered_kwh, source, reason) where source Ã¢Ë†Ë† {"etotal","parce","zero"}
    and reason is set when source=="zero". Yesterday's snapshot is the primary
    anchor: without it (or if today's baseline is inconsistent with it) the
    function refuses to seed.
    """
    etotal_delta = int(cur_etotal) - int(today_baseline_etotal or 0)
    parce_delta  = int(cur_parce)  - int(today_baseline_parce  or 0)
    night_gap = int(today_baseline_etotal or 0) - int(yesterday_etotal or 0)

    yesterday_ok = (
        bool(yesterday_present) and
        int(yesterday_etotal or 0) > 0 and
        int(today_baseline_etotal or 0) >= int(yesterday_etotal or 0) and
        night_gap <= night_gap_sanity_kwh
    )

    etotal_ok = (
        bool(rtc_year_ok) and yesterday_ok and
        etotal_delta >= 0 and etotal_delta < delta_sanity_cap_kwh
    )
    parce_ok = (
        bool(rtc_year_ok) and yesterday_ok and
        parce_delta >= 0 and parce_delta < delta_sanity_cap_kwh
    )

    if etotal_ok and etotal_delta > 0:
        return float(etotal_delta), "etotal", ""
    if parce_ok and parce_delta > 0:
        return float(parce_delta), "parce", ""

    if not yesterday_present:
        reason = "no_yesterday_snapshot"
    elif int(yesterday_etotal or 0) <= 0:
        reason = "yesterday_etotal_zero"
    elif int(today_baseline_etotal or 0) < int(yesterday_etotal or 0):
        reason = "baseline_below_yesterday"
    elif night_gap > night_gap_sanity_kwh:
        reason = "midnight_gap_too_large"
    elif not rtc_year_ok:
        reason = "rtc_invalid"
    elif etotal_delta < 0:
        reason = "counter_regressed"
    elif etotal_delta >= delta_sanity_cap_kwh:
        reason = "sanity_cap_exceeded"
    else:
        reason = "counter_flat"

    return 0.0, "zero", reason

async def seed_pac_from_baseline():
    """
    v2.9.0 Slice C Ã¢â‚¬â€ seed PAC integrator per unit from today's baseline +
    first successful poll. Called once during startup before poll loops spin up.

    Safe behaviour on failure: PAC starts at 0 (pre-v2.9.0 default).
    Controlled via DISABLE_COUNTER_RECOVERY env var.
    """
    if DISABLE_COUNTER_RECOVERY:
        print("[RECOVERY] DISABLE_COUNTER_RECOVERY=1 Ã¢â‚¬â€ skipping Etotal/parcE seed")
        return

    from datetime import datetime as _dt
    loop = asyncio.get_running_loop()
    date_key = _dt.now().strftime("%Y-%m-%d")

    # Fetch baselines from Node. Node may not be up yet Ã¢â‚¬â€ retry briefly.
    data = None
    for attempt in range(6):  # ~30 s max (5 s Ãƒâ€” 6)
        data = await loop.run_in_executor(
            executor,
            _http_get_json,
            f"{NODE_API_BASE}/api/counter-baseline/{date_key}",
            5.0,
        )
        if data is not None:
            break
        print(f"[RECOVERY] Node not ready (attempt {attempt + 1}/6); backing off 5 s")
        await asyncio.sleep(5)

    if data is None:
        print("[RECOVERY] Node unreachable Ã¢â‚¬â€ PAC starts at 0 for all units")
        return

    baselines = {
        (int(b.get("inverter", 0)), int(b.get("unit", 0))): b
        for b in (data.get("baselines") or [])
    }

    # v2.9.1 Ã¢â‚¬â€ refuse to seed any unit that lacks a clear snapshot of
    # yesterday's last reading. Without that anchor we cannot confirm today's
    # baseline is consistent (e.g., baseline accidentally captured during a
    # transient bad first-frame read), so the safe path is to start at 0.
    yesterday = {
        (int(y.get("inverter", 0)), int(y.get("unit", 0))): y
        for y in (data.get("yesterday") or [])
    }

    if not baselines:
        print(f"[RECOVERY] No baselines for {date_key} yet Ã¢â‚¬â€ zero-seed + wait for first poll")
        return

    # v2.9.1 Ã¢â‚¬â€ gap-ratio crash detector. If solar-window readings are dense
    # (ratio >= threshold), this is a clean restart; PAC should accumulate
    # from the live moment forward and we leave the integrator at 0. Only when
    # readings are sparse (low ratio inside the open solar window) do we seed
    # the integrator from hardware-counter deltas.
    crash_detected = bool(data.get("crash_detected"))
    gap_ratio = data.get("gap_ratio")
    gap_thr   = data.get("gap_threshold")
    if not crash_detected:
        print(f"[RECOVERY] clean restart Ã¢â‚¬â€ gap_ratio={gap_ratio} thr={gap_thr}; "
              "PAC integrator starts at 0 (live accumulation only)")
        # Audit one row so operators can see why we declined to seed.
        await audit_counter_recovery(0, 0, "skip", 0.0,
                                     f"clean_restart gap_ratio={gap_ratio} thr={gap_thr}")
        return

    print(f"[RECOVERY] crash detected Ã¢â‚¬â€ gap_ratio={gap_ratio} thr={gap_thr}; "
          "evaluating per-unit seed decisions")

    # Energy that a healthy plant accumulates between yesterday's last RTC-valid
    # frame and today's midnight. ~0 kWh on a working install (sun is down, only
    # standby losses). Anything materially larger means today's baseline was
    # captured at a non-midnight wallclock and is unsafe to subtract from.
    NIGHT_GAP_SANITY_KWH = 50

    seeded = 0
    fallbacks = 0

    for ip, client in list(clients.items()):
        inv = inverter_number_from_ip(ip)
        if inv is None:
            continue
        units = static_units.get(ip) or [1, 2, 3, 4]
        for unit in units:
            try:
                regs = await safe_read(_threaded_read_input, client, 0, 60, unit, ip)
            except Exception:
                regs = None
            if not regs:
                continue

            try:
                cur_etotal = _u32_hi_lo(regs, 0)
                cur_parce  = _u32_hi_lo(regs, 58)
            except ValueError as ve:
                print(f"[RECOVERY] {ip} unit {unit} truncated frame, skipping seed: {ve}")
                continue
            _server_year = time.localtime().tm_year
            rtc_dt, rtc_valid = _rtc_from_regs(regs, server_year=_server_year)

            b = baselines.get((int(inv), int(unit)))
            if not b:
                continue

            y = yesterday.get((int(inv), int(unit)))
            year_ok = bool(rtc_valid and rtc_dt and abs(rtc_dt.year - _dt.now().year) <= 1)

            recovered_kwh, source, reason = classify_seed_decision(
                cur_etotal=cur_etotal,
                cur_parce=cur_parce,
                today_baseline_etotal=int(b.get("etotal_baseline") or 0),
                today_baseline_parce=int(b.get("parce_baseline") or 0),
                yesterday_etotal=int((y or {}).get("etotal_kwh") or 0),
                yesterday_present=bool(y),
                rtc_year_ok=year_ok,
                night_gap_sanity_kwh=NIGHT_GAP_SANITY_KWH,
            )

            nk = f"{int(inv)}_{int(unit)}"
            now_ms = int(time.time() * 1000)
            metrics_state["pacEnergy"][nk] = {
                "lastTime":           now_ms,
                "lastPacRaw":         0.0,
                "lastPacChangeTime":  now_ms,
                "totalWh":            recovered_kwh * 1000.0,
                "date":               date_key,
            }
            metrics_state.setdefault("pacEnergyHistory", {}).setdefault(nk, {})[date_key] = round(recovered_kwh, 6)

            if source == "zero":
                fallbacks += 1
                print(f"[RECOVERY] inv {inv}/u{unit} zero-seeded ({reason})")
            else:
                seeded += 1
                print(f"[RECOVERY] inv {inv}/u{unit} recovered={recovered_kwh:.2f} kWh source={source}")

            await audit_counter_recovery(inv, unit, source, recovered_kwh, reason)

    print(f"[RECOVERY] done Ã¢â‚¬â€ seeded={seeded} zero-fallback={fallbacks}")

# Ã¢â€â‚¬Ã¢â€â‚¬ Slice E Ã¢â‚¬â€ drift + year-invalid triggers Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

async def _post_sync_clock_for(inv: int, unit: int, trigger: str):
    """Tell Node to execute a sync-clock for this unit via /api/sync-clock-internal."""
    loop = asyncio.get_running_loop()
    def _post():
        return _http_post_json(
            f"{NODE_API_BASE}/api/sync-clock-internal",
            {"inverter": int(inv), "unit": int(unit), "trigger": trigger},
            timeout_s=10.0,
        )
    try:
        return await loop.run_in_executor(executor, _post)
    except Exception:
        return None

async def maybe_trigger_drift_sync(ip, unit, drift_s):
    """Throttled drift-based sync: at most once per 4 h per (inv, unit)."""
    inv = inverter_number_from_ip(ip)
    if inv is None:
        return
    key = (int(inv), int(unit))
    now = int(time.time() * 1000)
    last = _last_drift_sync_at.get(key, 0)
    if now - last < _DRIFT_SYNC_COOLDOWN_MS:
        return
    _last_drift_sync_at[key] = now
    print(f"[CLOCK] drift trigger inv {inv}/u{unit} drift={drift_s:.0f}s")
    await _post_sync_clock_for(inv, unit, "drift")

async def trigger_year_invalid_sync(ip, unit, y_probe):
    """Year-invalid trigger Ã¢â‚¬â€ light throttle (10 min) to avoid hammering."""
    inv = inverter_number_from_ip(ip)
    if inv is None:
        return
    key = (int(inv), int(unit), "year")
    now = int(time.time() * 1000)
    last = _last_drift_sync_at.get(key, 0)
    if now - last < 10 * 60 * 1000:
        return
    _last_drift_sync_at[key] = now
    print(f"[CLOCK] YEAR-INVALID trigger inv {inv}/u{unit} year_probe={y_probe}")
    await _post_sync_clock_for(inv, unit, "year_invalid")

# -------------------------------------------------
#   v2.9.0 Slice D Ã¢â‚¬â€ clock-sync transport
# -------------------------------------------------
#
# Wireshark capture of ISM's Isla::Sincronizar (docs/capture-file.pcapng,
# frame #8017) confirmed the on-wire protocol is plain Modbus FC16
# (Write Multiple Registers) broadcast to unit 0, starting at register 0,
# writing six UINT16s [year, month, day, hour, minute, second]. No vendor
# function code, no template Ã¢â‚¬â€ pymodbus' built-in write_registers is enough.

async def sync_clock(ip: str, unit: int, target_dt=None,
                     readback_delay_ms: int = 1000):
    """
    Write the server datetime to one inverter+unit. Returns a dict:
        { ok, drift_before_s, drift_after_s, accepted, error }.

    Per ISM packet capture (docs/capture-file.pcapng frame #8017):
      Ã¢â‚¬Â¢ Modbus FC16 Write Multiple Registers
      Ã¢â‚¬Â¢ Unit ID: 0 (broadcast Ã¢â‚¬â€ frame propagates to every unit on the daisy chain)
      Ã¢â‚¬Â¢ Start address: 0
      Ã¢â‚¬Â¢ Values: [year, month, day, hour, minute, second] as UINT16
    For per-unit sync we still pass the slave ID through so a single inverter
    can be targeted explicitly when desired.
    """
    from datetime import datetime as _dt
    target_dt = target_dt or _dt.now()

    client = clients.get(ip)
    if not client:
        return {
            "ok": False, "accepted": False,
            "error": "no_client", "drift_before_s": None, "drift_after_s": None,
            "target_iso": target_dt.isoformat(),
        }

    lock = thread_locks.get(ip)
    if lock is None:
        return {
            "ok": False, "accepted": False,
            "error": "no_lock", "drift_before_s": None, "drift_after_s": None,
            "target_iso": target_dt.isoformat(),
        }

    loop = asyncio.get_running_loop()
    _server_year = time.localtime().tm_year

    def _do_sync():
        import time as _t
        with lock:
            # 1. read current RTC Ã¢â€ â€™ drift_before
            before_regs = read_input(client, 20, 6, unit)
            padded_before = [0] * 20 + list(before_regs or [0] * 6)
            rtc_before_dt, _ = _rtc_from_regs(padded_before, server_year=_server_year)
            drift_before = None
            if rtc_before_dt:
                drift_before = (rtc_before_dt - target_dt).total_seconds()

            # 2. write [Y,M,D,h,m,s] via FC16 to the requested slave
            values = [
                int(target_dt.year),
                int(target_dt.month),
                int(target_dt.day),
                int(target_dt.hour),
                int(target_dt.minute),
                int(target_dt.second),
            ]
            write_ok = False
            write_err = None
            try:
                r = client.write_registers(address=0, values=values, unit=int(unit))
                write_ok = bool(r and not r.isError())
                if not write_ok and r is not None:
                    write_err = f"modbus_error: {r}"
            except Exception as exc:
                write_err = f"write_exception: {exc}"

            # 3. read-back
            _t.sleep(readback_delay_ms / 1000.0)
            after_regs = read_input(client, 20, 6, unit)
            padded_after = [0] * 20 + list(after_regs or [0] * 6)
            rtc_after_dt, after_valid = _rtc_from_regs(padded_after, server_year=_server_year)
            drift_after = None
            if rtc_after_dt:
                now_after = _dt.now()
                drift_after = (rtc_after_dt - now_after).total_seconds()

            accepted = bool(
                write_ok
                and after_valid and drift_after is not None
                and abs(drift_after) < 5.0
            )
            return {
                "ok": accepted,
                "drift_before_s": drift_before,
                "drift_after_s":  drift_after,
                "accepted":       accepted,
                "rtc_before_iso": rtc_before_dt.isoformat() if rtc_before_dt else None,
                "rtc_after_iso":  rtc_after_dt.isoformat()  if rtc_after_dt  else None,
                "write_ok":       write_ok,
                "error":          None if accepted else (write_err or "readback_mismatch"),
                "target_iso":     target_dt.isoformat(),
            }

    try:
        return await loop.run_in_executor(executor, _do_sync)
    except Exception as exc:
        return {
            "ok": False, "accepted": False,
            "error": f"executor_error: {exc}",
            "drift_before_s": None, "drift_after_s": None,
            "target_iso": target_dt.isoformat(),
        }

async def sync_clock_inverter(ip: str, units, target_dt=None,
                              readback_delay_ms: int = 1000):
    """
    Sync ALL daisy-chained nodes of one inverter with a SINGLE Modbus FC16
    broadcast write (unit=0). One frame fans out to every slave on the bus;
    we then read each unit's RTC back individually to verify.

    Returns:
      {
        ok: bool,                 # True iff every readback drift_after < 5 s
        target_iso: str,
        write_ok: bool,           # True iff broadcast write didn't raise
        error: str | None,        # Top-level write error, if any
        accepted: int,            # Count of units whose readback was good
        total: int,               # Number of units checked
        units: [
          { unit, drift_before_s, drift_after_s, accepted, error,
            rtc_before_iso, rtc_after_iso }, ...
        ],
      }
    """
    from datetime import datetime as _dt
    target_dt = target_dt or _dt.now()
    unit_list = sorted({int(u) for u in (units or [1, 2, 3, 4]) if u})

    base = {
        "ok": False, "target_iso": target_dt.isoformat(),
        "write_ok": False, "error": None,
        "accepted": 0, "total": len(unit_list), "units": [],
    }

    client = clients.get(ip)
    if not client:
        return {**base, "error": "no_client"}

    lock = thread_locks.get(ip)
    if lock is None:
        return {**base, "error": "no_lock"}

    loop = asyncio.get_running_loop()
    _server_year = time.localtime().tm_year

    def _do():
        import time as _t
        per_unit = []
        write_ok = False
        write_err = None
        with lock:
            # 1. drift_before per unit
            before = {}
            for u in unit_list:
                regs = read_input(client, 20, 6, u)
                padded = [0] * 20 + list(regs or [0] * 6)
                rtc_dt, _ = _rtc_from_regs(padded, server_year=_server_year)
                before[u] = (
                    rtc_dt,
                    (rtc_dt - target_dt).total_seconds() if rtc_dt else None,
                )

            # 2. Single FC16 broadcast write (unit=0).  Per Modbus spec,
            # broadcast slaves do not reply Ã¢â‚¬â€ so a None/error response from
            # pymodbus is normal here; we rely on readback for verification.
            values = [
                int(target_dt.year), int(target_dt.month), int(target_dt.day),
                int(target_dt.hour), int(target_dt.minute), int(target_dt.second),
            ]
            try:
                client.write_registers(address=0, values=values, unit=0)
                write_ok = True
            except Exception as exc:
                write_err = f"write_exception: {exc}"
                write_ok = False

            # 3. drift_after per unit
            _t.sleep(readback_delay_ms / 1000.0)
            for u in unit_list:
                regs = read_input(client, 20, 6, u)
                padded = [0] * 20 + list(regs or [0] * 6)
                rtc_after_dt, valid = _rtc_from_regs(padded, server_year=_server_year)
                drift_after = None
                if rtc_after_dt:
                    drift_after = (rtc_after_dt - _dt.now()).total_seconds()
                rtc_before_dt, drift_before = before.get(u, (None, None))
                accepted = bool(
                    write_ok and valid
                    and drift_after is not None and abs(drift_after) < 5.0
                )
                per_unit.append({
                    "unit": int(u),
                    "drift_before_s": drift_before,
                    "drift_after_s":  drift_after,
                    "accepted":       accepted,
                    "rtc_before_iso": rtc_before_dt.isoformat() if rtc_before_dt else None,
                    "rtc_after_iso":  rtc_after_dt.isoformat()  if rtc_after_dt  else None,
                    "error":          None if accepted else (write_err or "readback_mismatch"),
                })
        return write_ok, write_err, per_unit

    try:
        write_ok, write_err, per_unit = await loop.run_in_executor(executor, _do)
        accepted = sum(1 for u in per_unit if u["accepted"])
        return {
            "ok":         bool(write_ok and accepted == len(per_unit) and per_unit),
            "target_iso": target_dt.isoformat(),
            "write_ok":   write_ok,
            "error":      write_err,
            "accepted":   accepted,
            "total":      len(per_unit),
            "units":      per_unit,
        }
    except Exception as exc:
        return {**base, "error": f"executor_error: {exc}"}

# Ã¢â€â‚¬Ã¢â€â‚¬ Bulk-auth helper (mirrors server/bulkControlAuth.js adsiMM pattern) Ã¢â€â‚¬Ã¢â€â‚¬
def _check_bulk_auth(header_value: str) -> bool:
    """Accept `adsiMM` for the prior, current OR next minute (Ã‚Â±1 in both
    directions), padded or unpadded. Case-insensitive. The next-minute offset
    keeps this in lock-step with the Node gates (getPlantWideAuthKeys,
    requireTopologyAuth) so a key the operator typed off a slightly-fast clock
    is accepted here too."""
    if not header_value:
        return False
    raw = str(header_value).strip()
    # Strip optional "Bearer " prefix.
    if raw.lower().startswith("bearer "):
        raw = raw.split(" ", 1)[1].strip()
    raw = raw.lower()
    from datetime import datetime as _dt, timedelta
    now = _dt.now()
    candidates = set()
    for offset in (0, -1, 1):
        m = (now + timedelta(minutes=offset)).minute
        candidates.add(f"adsi{m}")
        candidates.add(f"adsi{m:02d}")
    return raw in candidates

# -------------------------------------------------
#   Polling manager  (supervises poll tasks)
# -------------------------------------------------

async def start_polling_manager():
    """Wait for at least one inverter, then launch and supervise poll tasks."""
    while not inverters:
        await asyncio.sleep(0.2)

    tasks = {ip: asyncio.create_task(poll_inverter(ip)) for ip in inverters}
    slow_tasks = {ip: asyncio.create_task(slow_poll_inverter(ip)) for ip in inverters}

    async def _supervisor():
        while True:
            # Restart crashed tasks
            for ip in inverters:
                if ip not in tasks or tasks[ip].done():
                    tasks[ip] = asyncio.create_task(poll_inverter(ip))
                if ip not in slow_tasks or slow_tasks[ip].done():
                    slow_tasks[ip] = asyncio.create_task(slow_poll_inverter(ip))

            # Cancel tasks for removed inverters
            for ip in list(tasks):
                if ip not in inverters:
                    tasks.pop(ip).cancel()
            for ip in list(slow_tasks):
                if ip not in inverters:
                    slow_tasks.pop(ip).cancel()

            await asyncio.sleep(1)

    asyncio.create_task(_supervisor())

# -------------------------------------------------
#   File watcher  (hot-reload ipconfig.json)
# -------------------------------------------------

async def ipconfig_watcher():
    """Re-build maps whenever DB/file-backed ipconfig or poll config changes."""
    last_signature = None
    last_poll_sig = ""
    loop = asyncio.get_running_loop()
    while True:
        # Ã¢â€â‚¬Ã¢â€â‚¬ Check ipconfig Ã¢â€â‚¬Ã¢â€â‚¬
        try:
            cfg = await load_ipconfig()
            signature = json.dumps(cfg, sort_keys=True, separators=(",", ":"))
            if signature != last_signature:
                if last_signature is not None:
                    print("[WATCH] ipconfig changed Ã¢â‚¬â€ reloading")
                last_signature = signature
                await rebuild_global_maps(cfg)
                # Reconcile RS485 bridge buses on ipconfig change
                if rs485_bridge is not None:
                    try:
                        await rs485_bridge.reconcile(cfg)
                    except Exception as exc:
                        print(f"[RS485-BRIDGE] reconcile error: {exc}")
        except Exception:
            pass

        # Ã¢â€â‚¬Ã¢â€â‚¬ Check poll config (inverterPollConfig) Ã¢â€â‚¬Ã¢â€â‚¬
        try:
            poll_cfg = await loop.run_in_executor(executor, _load_poll_config_sync)
            poll_sig = json.dumps(poll_cfg, sort_keys=True, separators=(",", ":"))
            if poll_sig != last_poll_sig:
                last_poll_sig = poll_sig
                old_timeout = _modbus_timeout
                _apply_poll_config(poll_cfg)
                if _modbus_timeout != old_timeout:
                    # Fix B (2026-06-08): rebuild_global_maps() only builds a
                    # client for an IP NOT already in `clients`, so calling it
                    # here never recreated existing clients Ã¢â‚¬â€ the new timeout
                    # silently never applied. Explicitly rebuild each existing
                    # inverter's client (fresh object carries the new timeout),
                    # which also gives operators a no-IP-change recovery lever.
                    print(f"[WATCH] modbusTimeout changed to {_modbus_timeout}s Ã¢â‚¬â€ rebuilding {len(inverters)} client(s)")
                    for _ip in list(inverters):
                        await rebuild_ip_client(_ip, "modbusTimeout change")
                elif last_poll_sig != "{}":
                    print(f"[WATCH] poll config updated: {poll_cfg}")
        except Exception:
            pass

        await asyncio.sleep(1)

# -------------------------------------------------
#   Metrics state  (mirrors Node-RED global context)
# -------------------------------------------------

metrics_state = {
    "pacEnergy":        {},   # nk -> {lastPacRaw, lastPacChangeTime, lastTime, totalWh, date}
    "pdcData":          {},   # nk -> {lastPdcRaw}
    "uiAlarm":          {},   # nk -> {AlarmValue, AlarmText}
    "lastUpdate":       {},   # nk -> timestamp ms
    "pacEnergyHistory": {},   # nk -> {date: kWh}
}

OFFLINE_THRESHOLD_MS = 30_000
FREEZE_THRESHOLD_MS  = 30_000

def _pad2(n): return str(int(n)).zfill(2)

def _update_metrics_from_frame(frame: dict):
    """Replicates Node-RED parser + engine: update in-memory metrics state from one raw frame."""
    ms  = metrics_state
    now = int(time.time() * 1000)

    inverter = int(frame.get("inverter") or 0)
    module   = int(frame.get("unit")     or 0)
    if not inverter or not module:
        return

    nk = f"{inverter}_{module}"
    ms["lastUpdate"][nk] = now

    vdc = float(frame.get("vdc") or 0)
    idc = float(_signed_int16(frame.get("idc") or 0))

    pdc_raw = (vdc * idc) if vdc * idc <= 265_000 else 0
    ms["pdcData"][nk] = {"lastPdcRaw": pdc_raw}

    pac_reg  = float(_signed_int16(frame.get("pac") or 0))
    # T3.17 fix (Phase 8, 2026-04-14): log when the clamp triggers so an
    # Ingeteam firmware variant that uses a different word order surfaces
    # as a loud warning instead of silently-zeroed PAC.  Previously a bad
    # register layout produced 0 kW forever with no log signal.
    _pac_scaled = pac_reg * 10
    if _pac_scaled > 260_000:
        _clamp_key = nk  # e.g. "3_2" for inverter 3 unit 2
        if _clamp_key not in _pac_clamp_notified:
            print(
                f"[POLL] PAC sanity-clamp triggered for {_clamp_key}: raw={pac_reg} "
                f"scaled={_pac_scaled:.0f}W > 260kW cap.  Possible word-swap/firmware "
                f"variant mismatch; values reported as 0.  Verify register layout."
            )
            _pac_clamp_notified.add(_clamp_key)
    pac_cand = _pac_scaled if _pac_scaled <= 260_000 else 0

    # Zero-coherence guard Ã¢â‚¬â€ per-leg, noise-tolerant. Mirrors the Node-side
    # guard in server/poller.js parseRow. The inverter exposes Vdc, Idc, and
    # the three AC phase currents as independent registers; analog scaling
    # and quantization noise can leave a leg sitting just above zero even
    # when the real value is zero. Compare each leg against a small noise
    # floor instead of strict ==0, and evaluate each leg INDEPENDENTLY
    # rather than relying on the multiplied Vdc*Idc product.
    #
    # Register units (raw, before scaling) Ã¢â‚¬â€ verified 1 A/LSB for this PowerMax
    # hardware (audits/2026-05-11/register-decode-traceback.md Finding 3; the
    # safePdc 265 kW clamp only reconciles with vdcÃ‚Â·idc at 1 A/LSB). Earlier
    # "0.1 A/LSB" comments here were stale and contradicted the live thresholds.
    #   vdc  Ã¢â‚¬â€ 1 V/LSB
    #   idc  Ã¢â‚¬â€ 1 A/LSB
    #   iac* Ã¢â‚¬â€ 1 A/LSB
    #
    # Force pac_raw to 0 if ANY leg is at/below its noise floor:
    #   Ã¢â‚¬Â¢ Vdc at noise floor       Ã¢â€ â€™ no real DC bus voltage
    #   Ã¢â‚¬Â¢ Idc at noise floor       Ã¢â€ â€™ no real DC current
    #   Ã¢â‚¬Â¢ iac1/iac2/iac3 at noise  Ã¢â€ â€™ that phase carries no current,
    #                                 3-phase output incomplete
    # Voltages on the AC side are intentionally ignored per operator
    # guidance (grid voltage can be present without the inverter exporting).
    #
    # Without this guard, the 50ms PAC integrator below would accumulate
    # phantom Wh into pacEnergy.totalWh whenever a leg drops to noise floor
    # while pac_reg still reports a small residual Ã¢â‚¬â€ that totalWh becomes
    # kwh_today, which Node prefers over its own trapezoid integrator.
    NOISE_VDC = 1.0   # Ã¢â€°Â¤1 V on the DC bus is noise floor
    NOISE_IDC = 1.0   # Ã¢â€°Â¤1 A DC is noise floor (idc is 1 A/LSB on this hardware)
    NOISE_IAC = 1.0   # Ã¢â€°Â¤1 A on a phase is noise floor (iac is 1 A/LSB)
    iac1_raw = float(frame.get("iac1") or 0)
    iac2_raw = float(frame.get("iac2") or 0)
    iac3_raw = float(frame.get("iac3") or 0)
    if (
        vdc      <= NOISE_VDC or
        idc      <= NOISE_IDC or
        iac1_raw <= NOISE_IAC or
        iac2_raw <= NOISE_IAC or
        iac3_raw <= NOISE_IAC
    ):
        pac_raw = 0.0
    else:
        pac_raw = pac_cand

    y  = frame.get("year")   or 0
    mo = frame.get("month")  or 0
    dy = frame.get("day")    or 0
    formatted_date = f"{y}-{_pad2(mo)}-{_pad2(dy)}" if y else time.strftime("%Y-%m-%d")

    pe = ms["pacEnergy"].get(nk)
    if not pe:
        ms["pacEnergy"][nk] = {
            "lastTime": now, "lastPacRaw": pac_raw,
            "lastPacChangeTime": now, "totalWh": 0.0, "date": formatted_date,
        }
    else:
        new_day = pe["date"] != formatted_date
        if new_day:
            pe.update({"date": formatted_date, "totalWh": 0.0,
                        "lastTime": now, "lastPacRaw": pac_raw,
                        "lastPacChangeTime": now})
        else:
            # Fix #2: cap dt at 30s to match Node's MAX_PAC_DT_S.
            # Without this cap, /metrics energy grows unbounded during any dropout
            # and always diverges from the Node energy_5min DB totals.
            dt_sec = min((now - pe["lastTime"]) / 1000.0, 30.0)
            if pac_raw != pe["lastPacRaw"]:
                pe["lastPacChangeTime"] = now
            if dt_sec > 0 and pac_raw >= 0:
                avg = (pe["lastPacRaw"] + pac_raw) / 2.0
                pe["totalWh"] += (avg * dt_sec) / 3600.0
            pe["lastPacRaw"] = pac_raw
            pe["lastTime"]   = now

    alarm_val = int(frame.get("alarm") or 0)
    alarm_hex = format(alarm_val, '05X') + "H"
    ms["uiAlarm"][nk] = {"AlarmValue": alarm_val, "AlarmText": alarm_hex}

    kwh_pac = ms["pacEnergy"][nk]["totalWh"] / 1000.0
    if nk not in ms["pacEnergyHistory"]:
        ms["pacEnergyHistory"][nk] = {}
    ms["pacEnergyHistory"][nk][formatted_date] = round(kwh_pac, 6)

def _build_metrics() -> list:
    """
    Replicates the Node-RED ENGINE NODE output exactly.
    Returns list of dicts: Inverter, Module, Pac, Pdc,
                           ONLINE, AlarmValue, Alarm, on_off, Date, Time
    """
    ms  = metrics_state
    now = int(time.time() * 1000)

    # Update state from all current live frames
    for arr in shared.values():
        if isinstance(arr, list):
            for frame in arr:
                _update_metrics_from_frame(frame)

    # Build on_off lookup from live frames
    live_map = {}
    for arr in shared.values():
        if isinstance(arr, list):
            for f in arr:
                inv = f.get("inverter"); unit = f.get("unit")
                if inv and unit:
                    live_map[f"{inv}_{unit}"] = f.get("on_off")

    results = []

    for nk, pe in ms["pacEnergy"].items():
        parts    = nk.split("_")
        inverter = int(parts[0])
        module   = int(parts[1])

        last_seen = ms["lastUpdate"].get(nk, 0)
        online    = (now - last_seen) < OFFLINE_THRESHOLD_MS

        # Skip nodes that have been offline too long
        if not online and (now - last_seen) > OFFLINE_THRESHOLD_MS + 1500:
            continue

        pac_raw = pe.get("lastPacRaw", 0)
        pdc_raw = ms["pdcData"].get(nk, {}).get("lastPdcRaw", 0)

        pac_frozen  = (now - pe.get("lastPacChangeTime", now)) >= FREEZE_THRESHOLD_MS
        display_pac = 0.0 if (not online or pac_frozen) else pac_raw
        display_pdc = 0.0 if (not online or pac_frozen) else pdc_raw

        alarm_info = ms["uiAlarm"].get(nk, {"AlarmValue": 0, "AlarmText": "00000H"})

        lt  = pe.get("lastTime", now)
        ldt = time.localtime(lt / 1000)
        time_str = f"{ldt.tm_hour:02d}:{ldt.tm_min:02d}:{ldt.tm_sec:02d}"
        date_str = time.strftime("%Y-%m-%d")

        results.append({
            "Inverter":   inverter,
            "Module":     module,
            "Date":       date_str,
            "Time":       time_str,
            "Pac":        round(display_pac, 2),
            "Pdc":        round(display_pdc, 2),
            "ONLINE":     online,
            "lastUpdate": last_seen,
            "AlarmValue": alarm_info.get("AlarmValue", 0),
            "Alarm":      alarm_info.get("AlarmText", "00000H"),
            "on_off":     live_map.get(nk),
        })

    results.sort(key=lambda x: (x["Inverter"], x["Module"]))
    return results

# -------------------------------------------------
#   REST endpoints  (registered on the app above)
# -------------------------------------------------

# T3.13 + T3.18 fix (Phase 8, 2026-04-14): Liveness/readiness endpoint for
# Electron parent and external monitors.  Returns both coarse liveness
# (process responding) and functional health (recent polls, connected
# clients).  `stale=true` when the newest frame across all inverters is
# older than 30 s Ã¢â‚¬â€ the "process alive but stuck" failure mode.
@app.get("/health")
def get_health():
    now_ms = int(time.time() * 1000)
    newest_ts = 0
    connected = 0
    for arr in shared.values():
        if isinstance(arr, list):
            for frame in arr:
                ts = int(frame.get("ts") or 0)
                if ts > newest_ts:
                    newest_ts = ts
        if arr:
            connected += 1
    age_ms = (now_ms - newest_ts) if newest_ts > 0 else -1
    stale = age_ms < 0 or age_ms > 30_000
    status = "ok" if not stale and connected > 0 else ("degraded" if connected > 0 else "unready")
    return {
        "status": status,
        "stale": stale,
        "newest_frame_age_ms": age_ms,
        "connected_inverter_count": connected,
        "configured_inverter_count": len(inverters),
        "now_ms": now_ms,
    }

@app.get("/data")
def get_data():
    """Return a flat list of all live inverter data frames (raw modbus).

    Stale-frame guard: Python caches the last successful Modbus frame per IP.
    Frames older than STALE_FRAME_MAX_AGE_MS are excluded so Node sees no frame
    (and naturally marks the inverter offline) when Modbus is down.

    Energy enrichment: each fresh frame is enriched with `kwh_today` Ã¢â‚¬â€ the
    per-unit accumulated kWh from Python's high-frequency (50ms) integrator.
    Node uses this value directly instead of re-integrating PAC at 200ms.
    """
    STALE_FRAME_MAX_AGE_MS = 3000  # must match STALE_FRAME_MAX_AGE_MS in Node poller.js
    now_ms = int(time.time() * 1000)
    flat = []
    for arr in shared.values():
        if isinstance(arr, list):
            for frame in arr:
                frame_ts = int(frame.get("ts") or 0)
                age_ms = now_ms - frame_ts
                if 0 <= age_ms <= STALE_FRAME_MAX_AGE_MS:
                    # Ensure metrics state is current for this frame, then read kwh_today
                    _update_metrics_from_frame(frame)
                    inv  = frame.get("inverter")
                    unit = frame.get("unit")
                    nk   = f"{inv}_{unit}" if inv and unit else None
                    pe   = metrics_state["pacEnergy"].get(nk) if nk else None
                    kwh_today = round(pe["totalWh"] / 1000.0, 6) if pe else 0.0
                    enriched = dict(frame)
                    enriched["kwh_today"] = kwh_today
                    flat.append(enriched)
    return flat

@app.get("/metrics")
def get_metrics():
    """
    Return processed inverter metrics Ã¢â‚¬â€ mirrors Node-RED engine output.
    Fields per node: Inverter, Module, Date, Time, Pac(W), Pdc(W),
                     ONLINE, AlarmValue, Alarm, on_off
    """
    return _build_metrics()

class WriteCommand(BaseModel):
    inverter: int
    unit:     int
    value:    int

class WriteBatchCommand(BaseModel):
    inverter: int
    units:    list[int]
    value:    int

def _sanitize_write_units(units_raw):
    units = []
    for unit_raw in units_raw if isinstance(units_raw, list) else []:
        try:
            unit = int(unit_raw)
        except Exception:
            continue
        if 1 <= unit <= 4 and unit not in units:
            units.append(unit)
    return units

@app.post("/write")
async def write_command(cmd: WriteCommand):
    """Queue a single-register write (address 16) for the specified inverter/unit."""

    # T3.1 fix: validate unit range at the API boundary.
    # Ingeteam nodes are 1..4 (see SKILL.md Ã‚Â§Current Metrics Ã¢â‚¬â€ 4 nodes per inverter).
    if not isinstance(cmd.unit, int) or not (1 <= cmd.unit <= 4):
        return JSONResponse({"status": "error", "msg": "invalid unit (must be 1..4)"}, 400)

    # T3.2 fix: ON/OFF register only accepts 0 (off) or 1 (on);
    # value == 2 is the historic "skip" sentinel retained below.
    if cmd.value == 2:
        return {"status": "skipped"}
    if cmd.value not in (0, 1):
        return JSONResponse({"status": "error", "msg": "invalid value (must be 0 or 1)"}, 400)

    ip = ip_map.get(str(cmd.inverter))
    if not ip:
        return JSONResponse({"status": "error", "msg": "invalid inverter"}, 400)

    client = clients.get(ip)
    if not client:
        return JSONResponse({"status": "error", "msg": "client not available"}, 400)

    loop = asyncio.get_running_loop()
    fut  = loop.create_future()

    # T3.3 fix: atomic mark+enqueue.  T3.5: record operator write timestamp
    # so handle_auto_reset can suppress the opposite-direction reset.
    note_operator_write(ip, cmd.unit)
    try:
        enqueue_write_atomically(ip, {
            "address": 16,
            "value":   cmd.value,
            "unit":    cmd.unit,
            "future":  fut,
            "loop":    loop,
        })
    except WriteQueueFullError as e:
        # T3.11 fix (Phase 6): map bounded-queue overflow to HTTP 429 so the
        # operator UI can surface a clear "system busy, retry shortly" hint.
        return JSONResponse({"status": "error", "msg": str(e)}, 429)

    wait_timeout = compute_write_wait_timeout(ip)
    try:
        ok = await asyncio.wait_for(asyncio.shield(fut), timeout=wait_timeout)
    except asyncio.TimeoutError:
        return JSONResponse({"status": "error", "msg": f"write timeout after {wait_timeout:.1f}s"}, 500)

    if not ok:
        return JSONResponse({"status": "error", "msg": "write failed"}, 500)

    return {"status": "ok"}

@app.post("/write/batch")
async def write_batch_command(cmd: WriteBatchCommand):
    """Queue a write batch (address 16) for one inverter across multiple units."""

    units = _sanitize_write_units(cmd.units)
    if not units:
        return JSONResponse({"status": "error", "msg": "no valid units"}, 400)

    # T3.2 fix: same ON/OFF bounds as /write.
    if cmd.value == 2:
        return {
            "status":  "skipped",
            "results": [{"unit": unit, "ok": True} for unit in units],
        }
    if cmd.value not in (0, 1):
        return JSONResponse({"status": "error", "msg": "invalid value (must be 0 or 1)"}, 400)

    ip = ip_map.get(str(cmd.inverter))
    if not ip:
        return JSONResponse({"status": "error", "msg": "invalid inverter"}, 400)

    client = clients.get(ip)
    if not client:
        return JSONResponse({"status": "error", "msg": "client not available"}, 400)

    loop = asyncio.get_running_loop()
    fut  = loop.create_future()

    # T3.3 fix: atomic mark+enqueue.  T3.5: record operator write timestamp
    # for each target unit so auto-reset is held off.
    for unit in units:
        note_operator_write(ip, unit)
    try:
        enqueue_write_atomically(ip, {
            "steps": [
                {"address": 16, "value": cmd.value, "unit": unit}
                for unit in units
            ],
            "future": fut,
            "loop":   loop,
            "batch":  True,
        })
    except WriteQueueFullError as e:
        return JSONResponse({"status": "error", "msg": str(e)}, 429)

    wait_timeout = compute_write_wait_timeout(ip, len(units))
    try:
        results = await asyncio.wait_for(asyncio.shield(fut), timeout=wait_timeout)
    except asyncio.TimeoutError:
        return JSONResponse(
            {"status": "error", "msg": f"write timeout after {wait_timeout:.1f}s"},
            500,
        )

    safe_results = []
    for unit in units:
        match = None
        if isinstance(results, list):
            match = next(
                (entry for entry in results if int(entry.get("unit", -1)) == unit),
                None,
            )
        safe_results.append({
            "unit": unit,
            "ok": bool(match and match.get("ok")),
        })

    ok_count = sum(1 for entry in safe_results if entry["ok"])
    fail_count = len(safe_results) - ok_count

    if ok_count == len(safe_results):
        return {"status": "ok", "results": safe_results}
    if ok_count > 0:
        return {
            "status":    "partial",
            "results":   safe_results,
            "okCount":   ok_count,
            "failCount": fail_count,
        }
    return JSONResponse(
        {
            "status":    "error",
            "msg":       "write failed",
            "results":   safe_results,
            "okCount":   0,
            "failCount": fail_count,
        },
        500,
    )

# Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ v2.9.0 Slice D Ã¢â‚¬â€ clock-sync endpoints Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

def _extract_auth_header(request):
    """Return the best-available bulk-auth header value (lowercased, trimmed)."""
    if request is None:
        return ""
    headers = getattr(request, "headers", {}) or {}
    # FastAPI headers are case-insensitive MultiDict.
    for name in ("x-bulk-auth", "authorization"):
        val = headers.get(name) if hasattr(headers, "get") else None
        if val:
            return str(val).strip()
    return ""

@app.post("/sync-clock/{inverter}/{unit}")
async def api_sync_clock_one(inverter: int, unit: int, request: Request):
    auth = _extract_auth_header(request)
    if not _check_bulk_auth(auth):
        raise HTTPException(401, "unauthorized")

    ip = ip_map.get(str(int(inverter)))
    if not ip:
        raise HTTPException(400, f"no IP configured for inverter {inverter}")

    from datetime import datetime as _dt
    target_dt = _dt.now()
    result = await sync_clock(ip, int(unit), target_dt)
    return {"inverter": int(inverter), "unit": int(unit), **result}

@app.post("/sync-clock/inverter/{inverter}")
async def api_sync_clock_inverter(inverter: int, request: Request):
    """Sync ALL nodes of one inverter using a single FC16 broadcast frame
    (unit=0). Body may pass `units: [1,2,3,4]` to override the unit list
    that gets read back; defaults to ipconfig.units[inverter] when omitted."""
    auth = _extract_auth_header(request)
    if not _check_bulk_auth(auth):
        raise HTTPException(401, "unauthorized")

    inv_int = int(inverter)
    ip = ip_map.get(str(inv_int))
    if not ip:
        raise HTTPException(400, f"no IP configured for inverter {inverter}")

    cfg = await load_ipconfig()
    unit_map = cfg.get("units", {}) or {}
    body_units = None
    try:
        body = await request.json()
        if isinstance(body, dict) and isinstance(body.get("units"), list):
            body_units = body["units"]
    except Exception:
        body_units = None
    units = (
        body_units
        or unit_map.get(str(inv_int))
        or unit_map.get(inv_int)
        or [1, 2, 3, 4]
    )

    from datetime import datetime as _dt
    target_dt = _dt.now()
    result = await sync_clock_inverter(ip, units, target_dt)
    # Tag every per-unit row with the inverter number for the Node logger.
    tagged_units = [{"inverter": inv_int, **u} for u in result.get("units", [])]
    return {
        "inverter":   inv_int,
        "ip":         ip,
        "target_iso": result.get("target_iso"),
        "write_ok":   result.get("write_ok"),
        "error":      result.get("error"),
        "accepted":   result.get("accepted"),
        "total":      result.get("total"),
        "results":    tagged_units,
    }

@app.post("/sync-clock/broadcast")
async def api_sync_clock_all(request: Request):
    """Fan out per-inverter broadcasts across the whole fleet Ã¢â‚¬â€ one Modbus
    FC16 frame per inverter (NOT per unit). Used by the daily auto-sync cron.
    """
    auth = _extract_auth_header(request)
    if not _check_bulk_auth(auth):
        raise HTTPException(401, "unauthorized")

    from datetime import datetime as _dt
    target_dt = _dt.now()
    cfg = await load_ipconfig()
    inv_map = cfg.get("inverters", {}) or {}
    unit_map = cfg.get("units", {}) or {}

    flat_results = []

    async def _sync_one_inverter(inv_key, ip, units):
        try:
            inv = int(inv_key)
        except Exception:
            return
        try:
            r = await sync_clock_inverter(ip, units, target_dt)
        except Exception as exc:
            for u in units or [1, 2, 3, 4]:
                flat_results.append({
                    "inverter": inv, "unit": int(u),
                    "accepted": False,
                    "error": f"exception: {exc}",
                    "drift_before_s": None, "drift_after_s": None,
                })
            return
        for row in r.get("units", []):
            flat_results.append({"inverter": inv, **row})

    tasks = []
    for inv_key, ip in inv_map.items():
        if not ip:
            continue
        units = unit_map.get(inv_key) or unit_map.get(str(inv_key)) or [1, 2, 3, 4]
        tasks.append(_sync_one_inverter(inv_key, ip, units))
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)

    accepted = sum(1 for r in flat_results if r.get("accepted"))
    return {
        "target_iso": target_dt.isoformat(),
        "total":      len(flat_results),
        "accepted":   accepted,
        "results":    flat_results,
    }

# Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ 2026-06-08 Ã¢â‚¬â€ Manual comms reconnect (force fresh Modbus client) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

@app.post("/reconnect/{inverter}")
async def api_reconnect_inverter(inverter: int, request: Request):
    """Force a fresh per-IP Modbus client for one inverter (operator action).

    Equivalent to what changing the inverter's IP used to do by accident Ã¢â‚¬â€ it
    discards a wedged cached client/socket and builds a brand-new one, without
    touching the inverter's IP or any inverter state. Bulk-auth gated (the Node
    proxy injects the rolling adsiMM key); no Modbus write is performed.
    """
    auth = _extract_auth_header(request)
    if not _check_bulk_auth(auth):
        raise HTTPException(401, "unauthorized")

    inv_int = int(inverter)
    if inv_int < 1 or inv_int > 27:
        raise HTTPException(400, "inverter number out of range (1-27)")
    ip = ip_map.get(str(inv_int))
    if not ip:
        raise HTTPException(400, f"no IP configured for inverter {inverter}")

    ok = await rebuild_ip_client(ip, "operator reconnect")
    return {"inverter": inv_int, "ip": ip, "ok": bool(ok)}

# Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ v2.10.0 Slice B Ã¢â‚¬â€ Stop Reasons (vendor FC 0x71 SCOPE peek) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

@app.post("/stop-reasons/{inverter}/{slave}")
async def api_stop_reasons_read(inverter: int, slave: int, request: Request):
    """Read StopReason snapshots for one inverter+slave via vendor FC 0x71.

    Returns JSON-ready dicts. No persistence side-effect Ã¢â‚¬â€ Node's route
    handler decides whether to write rows into inverter_stop_reasons.

    Query / body knobs:
      Ã¢â‚¬Â¢ nodes:              CSV list "1,2,3"  (default: all 1..3)
      Ã¢â‚¬Â¢ include_histogram:  bool (default false)
    Bulk-auth gated Ã¢â‚¬â€ same key as clock-sync broadcast since this drives
    Modbus traffic on the shared bus.
    """
    auth = _extract_auth_header(request)
    if not _check_bulk_auth(auth):
        raise HTTPException(401, "unauthorized")

    inv_int = int(inverter)
    ip = ip_map.get(str(inv_int))
    if not ip:
        raise HTTPException(400, f"no IP configured for inverter {inverter}")

    client = clients.get(ip)
    if client is None:
        raise HTTPException(503, f"no Modbus client for {ip}")
    lock = thread_locks.get(ip)
    if lock is None:
        raise HTTPException(503, f"no per-IP lock for {ip}")

    # Parse knobs from query OR body (so callers can use either form).
    body = {}
    try:
        body = await request.json() if request.headers.get("content-type", "").startswith("application/json") else {}
    except Exception:
        body = {}
    qp = request.query_params

    def _parse_nodes(val):
        if val is None or val == "":
            return None
        if isinstance(val, list):
            raw = val
        else:
            raw = str(val).split(",")
        out = []
        for s in raw:
            try:
                n = int(str(s).strip())
                if 1 <= n <= 3:  # NODE_MAX_SUPPORTED
                    out.append(n)
            except Exception:
                continue
        return out or None

    nodes = _parse_nodes(body.get("nodes")) or _parse_nodes(qp.get("nodes"))
    include_histogram = bool(
        body.get("include_histogram")
        or qp.get("include_histogram") in ("1", "true", "True", "yes")
    )

    loop = asyncio.get_running_loop()
    try:
        result = await loop.run_in_executor(
            executor,
            lambda: _read_with_lock(
                client, lock, int(slave),
                nodes=nodes, include_histogram=include_histogram,
            ),
        )
    except Exception as exc:
        raise HTTPException(500, f"executor_error: {exc}")

    return {
        "ok": True,
        "inverter": inv_int,
        "ip": ip,
        "slave": int(slave),
        "read_at_ms": int(time.time() * 1000),
        "nodes": result.get("nodes", []),
        "histogram": result.get("histogram"),
    }

# Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ v2.10.x Slice ÃŽÂµ Ã¢â‚¬â€ Standard-Modbus Stop-Reason Cross-Check Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

@app.post("/stop-reasons/standard/{inverter}/{slave}")
async def api_stop_reasons_standard(inverter: int, slave: int, request: Request):
    """
    Read standard-Modbus stop-reason ring buffer (regs 30078Ã¢â‚¬â€œ30108) on-demand.

    Returns JSON-ready dict with 5-slot history decoded. No persistence side-effect
    Ã¢â‚¬â€ Node's internal endpoint `/api/stop-reasons/internal/standard-save` decides
    whether to write rows.

    Bulk-auth gated (same as vendor SCOPE read).
    """
    auth = _extract_auth_header(request)
    if not _check_bulk_auth(auth):
        raise HTTPException(401, "unauthorized")

    inv_int = int(inverter)
    ip = ip_map.get(str(inv_int))
    if not ip:
        raise HTTPException(400, f"no IP configured for inverter {inverter}")

    client = clients.get(ip)
    if client is None:
        raise HTTPException(503, f"no Modbus client for {ip}")

    try:
        result = await read_standard_stop_reasons(client, int(slave), ip)
    except Exception as exc:
        raise HTTPException(500, f"read_error: {exc}")

    if result is None:
        return {
            "ok": False,
            "inverter": inv_int,
            "ip": ip,
            "slave": int(slave),
            "error": "read_failed",
        }

    return {
        "ok": True,
        "inverter": inv_int,
        "ip": ip,
        "slave": int(slave),
        **result,  # inverter_ip, read_at_ms, pointer, slots
    }

# Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ v2.10.0 Slice C Ã¢â‚¬â€ Serial Number Read / Edit / Send Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

@app.get("/serial/ports")
async def api_serial_ports():
    """List available serial ports (for RS485-USB bridge configuration).

    Returns:
        [{"device": "COM3", "description": "..."}]
        Empty list if pyserial not available.
    """
    if rs485_bridge is None:
        return []
    try:
        return rs485_bridge.list_serial_ports()
    except Exception:
        return []

@app.get("/serial/{inverter}/{slave}")
async def api_serial_read(inverter: int, slave: int, request: Request):
    """FC11 Report Slave ID read for one inverter+slave.

    Returns:
      {
        ok, inverter, ip, slave, read_at_ms,
        serial, serial_format, format_warning,
        model_code, firmware_main, firmware_aux,
        live_snapshot_hex, raw_payload_hex,
      }

    Bulk-auth gated.  Optional query: `?fmt=motorola|tx|auto` (default auto).
    """
    auth = _extract_auth_header(request)
    if not _check_bulk_auth(auth):
        raise HTTPException(401, "unauthorized")

    inv_int = int(inverter)
    ip = ip_map.get(str(inv_int))
    if not ip:
        raise HTTPException(400, f"no IP configured for inverter {inverter}")

    client = clients.get(ip)
    if client is None:
        raise HTTPException(503, f"no Modbus client for {ip}")
    lock = thread_locks.get(ip)
    if lock is None:
        raise HTTPException(503, f"no per-IP lock for {ip}")

    fmt = (request.query_params.get("fmt") or "auto").strip().lower()
    if fmt not in ("auto", "motorola", "tx"):
        raise HTTPException(400, f"unknown fmt '{fmt}'")

    # Optional per-call timeout override (Node passes 5s for fleet scans
    # because the comm board needs more headroom than the 3s default
    # when the bus is warm with poller traffic).  Clamped to [1.0, 15.0]
    # so a runaway value can't stall the executor pool.
    raw_to = request.query_params.get("timeout_s")
    try:
        timeout_s = float(raw_to) if raw_to is not None else 0.0
    except (TypeError, ValueError):
        timeout_s = 0.0
    if timeout_s <= 0:
        timeout_s = 3.0
    timeout_s = max(1.0, min(15.0, timeout_s))

    loop = asyncio.get_running_loop()
    try:
        result = await loop.run_in_executor(
            executor,
            lambda: _read_serial(
                client, lock, int(slave),
                expected_fmt=fmt, timeout_s=timeout_s,
            ),
        )
    except Exception as exc:
        raise HTTPException(500, f"executor_error: {exc}")

    return {
        "ok": bool(result.get("ok")),
        "inverter": inv_int,
        "ip": ip,
        "slave": int(slave),
        "read_at_ms": int(time.time() * 1000),
        **{k: v for k, v in result.items() if k not in ("ok", "slave")},
    }

@app.post("/serial/{inverter}/{slave}")
async def api_serial_write(inverter: int, slave: int, request: Request):
    """UNLOCK + WRITE + readback-VERIFY pipeline for one inverter+slave.

    Body:
      {
        new_serial: str,        # 12 (Motorola) or 32 (TX) ASCII chars
        fmt:        str,        # 'motorola' | 'tx'
        verify_delay_s: float,  # optional override (default 1.0)
      }

    Bulk-auth gated.  Returns the same shape as
    services.serial_io.write_serial_with_lock plus identification fields.
    """
    auth = _extract_auth_header(request)
    if not _check_bulk_auth(auth):
        raise HTTPException(401, "unauthorized")

    inv_int = int(inverter)
    ip = ip_map.get(str(inv_int))
    if not ip:
        raise HTTPException(400, f"no IP configured for inverter {inverter}")

    client = clients.get(ip)
    if client is None:
        raise HTTPException(503, f"no Modbus client for {ip}")
    lock = thread_locks.get(ip)
    if lock is None:
        raise HTTPException(503, f"no per-IP lock for {ip}")

    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        raise HTTPException(400, "body must be a JSON object")
    new_serial = str(body.get("new_serial") or "").strip()
    fmt = str(body.get("fmt") or "").strip().lower()
    if not new_serial:
        raise HTTPException(400, "new_serial required")
    if fmt not in ("motorola", "tx"):
        raise HTTPException(400, "fmt must be 'motorola' or 'tx'")
    verify_delay_s = float(body.get("verify_delay_s") or 1.0)

    loop = asyncio.get_running_loop()
    try:
        result = await loop.run_in_executor(
            executor,
            lambda: _write_serial(
                client, lock, int(slave),
                new_serial=new_serial, fmt=fmt,
                verify_delay_s=verify_delay_s,
            ),
        )
    except Exception as exc:
        raise HTTPException(500, f"executor_error: {exc}")

    return {
        "ok": result.get("status") == "success",
        "inverter": inv_int,
        "ip": ip,
        "slave": int(slave),
        "fmt": fmt,
        "acted_at_ms": int(time.time() * 1000),
        **result,
    }

# Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Active Power Control (APC) Ã¢â‚¬â€ Continuous %P Setpoint Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
# Transport-agnostic core exported from calibration_io.py (2026-05-17 C1 move).
# Verified protocol 2026-05-04: FC16 Ã¢â€ â€™ reg 0x03E8 (1000)
#   opcode 0x0005 = STOP  |  0x0006 = START  |  0x0003 = SET-ACTIVE-PCT
#   reg[1001] = Q15 setpoint = (pct/100) Ãƒâ€” 0x7FFF  (only when opcode=0x0003)
# Wire test: PAC 143 kW Ã¢â€ â€™ 125 kW within 8 s at 50 % on inverter .126 slave 1.
# See plans/2026-05-04-curtailment-control.md Ã‚Â§1 for full verification record.
try:
    from calibration_io import (
        APC_REG,
        APC_OPCODE_SET_P,
        APC_OPCODE_STOP,
        APC_OPCODE_START,
        APC_Q15_MAX,
        consign_apc_with_lock,
    )
except ImportError:
    try:
        from services.calibration_io import (
            APC_REG,
            APC_OPCODE_SET_P,
            APC_OPCODE_STOP,
            APC_OPCODE_START,
            APC_Q15_MAX,
            consign_apc_with_lock,
        )
    except ImportError:
        APC_REG = APC_OPCODE_SET_P = APC_OPCODE_STOP = APC_OPCODE_START = APC_Q15_MAX = consign_apc_with_lock = None

# Per-slave setpoint state Ã¢â‚¬â€ updated on each confirmed write.
# Key: (ip, slave)  Value: {active_pct, opcode, applied_ts, job_id, source}
curtailment_state: dict = {}

# In-flight and completed ramp job snapshots Ã¢â‚¬â€ keyed by job_id (UUID str).
ramp_jobs: dict = {}

# Serializes job creation; ramp execution itself is per-job async.
ramp_lock = threading.Lock()

# Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
# Slice ÃŽÂ¶ Ã¢â‚¬â€ Reactive power + grid-code controls (PDF Ã‚Â§3 cmd 1, 9, 11 + read-back).
# Implementation reference: plans/2026-05-10-modbus-registers-official-revamp.md Ã‚Â§4 Slice ÃŽÂ¶
# Reference card: docs/Inverter-Modbus-Reference.md Ã‚Â§6.
#
# Risk gating: ALL writes here REQUIRE
#   1. operator-typed adsiMM bulk auth key (server-side gate)
#   2. featureFlag `gridControlEnabled` = "1" in settings (default "0")
#   3. security-reviewer agent pass on the diff
#   4. 2-week single-inverter soak before fleet-wide enable
# Read-back endpoint is auth-gated but flag-free Ã¢â‚¬â€ visibility is always safe.
# Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

# Command codes per PDF Ã‚Â§3 pg 15-17:
_GC_OPCODE_PHI_TANGENT  = 0x0001  # Change phi tangent target (PF control)
_GC_OPCODE_REACTIVE_KVAR = 0x0009  # Change reactive power ref (kVAr)
_GC_OPCODE_DISABLE_REACTIVE = 0x000B  # Disable reactive ref (restore default)

# Limits per PDF Ã‚Â§3 pg 15-17:
_GC_PHI_TANGENT_MAX = 15870  # Ã‚Â±0.484 tan(Ãâ€ ) Ã¢â€°Ë† PF 0.90 lag/lead.
                              # NGCP PGC GCR 4.4.4.1 requires PF 0.95 Ã¢â€ â€™ Ã‚Â±10780.

# Read-back of all five grid-control holding registers (41006-41010):
_GC_READ_BASE_ADDR = 0x03ED   # 1005 = 41006
_GC_READ_COUNT     = 5         # 41006, 41007, 41008, 41009 (reserved), 41010

def _signed16_to_raw(value: int) -> int:
    """Encode a signed Int16 as the raw UInt16 the Modbus wire expects.
    Mirror of `_signed_int16` (decode side) at module top. Clamps to Ã‚Â±0x7FFF."""
    v = max(-0x8000, min(0x7FFF, int(value)))
    return v & 0xFFFF

async def set_phi_tangent(ip: str, slave: int, phi_raw: int) -> dict:
    """Cmd 1 Ã¢â‚¬â€ set tan(Ãâ€ ) target. `phi_raw` is the Int16 wire value (NOT a PF
    or tan(Ãâ€ ) float Ã¢â‚¬â€ caller must convert). Returns {ok, raw, error?}.
    NGCP PF 0.95 lag/lead Ã¢â€ â€™ tan(Ãâ€ ) = Ã‚Â±0.329 Ã¢â€ â€™ raw Ã‚Â±10780."""
    raw = _signed16_to_raw(phi_raw)
    if abs(int(phi_raw)) > _GC_PHI_TANGENT_MAX:
        print(f"[grid-control] {ip}/{slave} cmd 1 REJECTED: phi_raw {phi_raw} exceeds Ã‚Â±{_GC_PHI_TANGENT_MAX}")
        return {"ok": False, "error": f"phi_raw {phi_raw} exceeds Ã‚Â±{_GC_PHI_TANGENT_MAX}"}
    result = await write_command_register(ip, slave, _GC_OPCODE_PHI_TANGENT, raw)
    if result.get("ok"):
        print(f"[grid-control] {ip}/{slave} cmd 1 (phi-tangent) OK raw={raw}")
    else:
        print(f"[grid-control] {ip}/{slave} cmd 1 (phi-tangent) FAIL raw={raw}: {result.get('error')}")
    return {**result, "raw": raw}

async def set_reactive_kvar(ip: str, slave: int, kvar_div10: int) -> dict:
    """Cmd 9 Ã¢â‚¬â€ set reactive power reference.
    `kvar_div10` is the raw Int16 written to the inverter. Wire convention
    per PDF Ã‚Â§3 cmd 9 (cross-checked with reg 30069 + 30077): raw Ãƒâ€” 10 = VAr,
    therefore kVAr = raw / 100. Caller (UI) computes raw = round(kVAr Ãƒâ€” 100).
    Earlier code+UI used the /10 convention which under-wrote by 10Ãƒâ€”.
    See audits/2026-05-11/register-decode-traceback.md Finding 2.
    Returns {ok, raw, error?}."""
    raw = _signed16_to_raw(kvar_div10)
    kvar_disp = kvar_div10 / 100.0
    result = await write_command_register(ip, slave, _GC_OPCODE_REACTIVE_KVAR, raw)
    if result.get("ok"):
        print(f"[grid-control] {ip}/{slave} cmd 9 (reactive) OK raw={raw} (~{kvar_disp:.2f}kVAr)")
    else:
        print(f"[grid-control] {ip}/{slave} cmd 9 (reactive) FAIL raw={raw}: {result.get('error')}")
    return {**result, "raw": raw}

async def disable_reactive(ip: str, slave: int) -> dict:
    """Cmd 11 Ã¢â‚¬â€ disable reactive reference, restore device default."""
    result = await write_command_register(ip, slave, _GC_OPCODE_DISABLE_REACTIVE)
    if result.get("ok"):
        print(f"[grid-control] {ip}/{slave} cmd 11 (disable-reactive) OK Ã¢â‚¬â€ restored default")
    else:
        print(f"[grid-control] {ip}/{slave} cmd 11 (disable-reactive) FAIL: {result.get('error')}")
    return result

def _read_grid_control_state_sync(client, lock, slave: int) -> dict:
    """Blocking holding-register read for 41006-41010. Returns the raw decoded
    UInt16 list under `regs` plus per-field convenience names. Ã‚Â±sign handling
    for phi_tangent and reactive_target is left to the caller (Node side)."""
    try:
        with lock:
            r = client.read_holding_registers(address=_GC_READ_BASE_ADDR,
                                              count=_GC_READ_COUNT, unit=slave)
        if r is None:
            return {"ok": False, "error": "null_response"}
        if r.isError():
            return {"ok": False, "error": f"modbus_error: {r}"}
        regs = list(r.registers) if hasattr(r, "registers") else []
        if len(regs) < _GC_READ_COUNT:
            return {"ok": False, "error": f"short_frame: got {len(regs)}/{_GC_READ_COUNT}"}
        # 41006 = power-reduction Q15 (UInt16, 0..32767)
        # 41007 = phi-tangent target  (Int16 Ã¢â‚¬â€ caller must cast)
        # 41008 = reactive target     (Int16 Ã¢â‚¬â€ caller must cast)
        # 41009 = reserved
        # 41010 = restrictive freq limits flag (UInt16, 0/1)
        return {
            "ok":              True,
            "regs":            regs,
            "power_q15":       regs[0],
            "phi_tangent_raw": regs[1],
            "reactive_raw":    regs[2],
            "freq_limits_on":  regs[4] & 0x0001,
        }
    except Exception as exc:
        return {"ok": False, "error": f"exception: {exc}"}

async def read_grid_control_state(ip: str, slave: int) -> dict:
    """Single-transaction read of holding 41006-41010 (5 regs). Used by the
    Slice ÃŽÂ¶ read-back UI chip and by Slice ÃŽÂ¸ Test T3 step capture."""
    client = clients.get(ip)
    if not client:
        return {"ok": False, "error": "no_client"}
    lock = thread_locks.get(ip)
    if lock is None:
        return {"ok": False, "error": "no_lock"}
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        executor,
        _read_grid_control_state_sync,
        client, lock, slave,
    )

def _compute_ramp_plan(current_pct: float, target_pct: float, targets: list,
                       mag_step: float = 25.0, batch_count: int = 4) -> dict:
    """Compute ramp sub-steps and fleet batches (no I/O)."""
    delta = abs(target_pct - current_pct)
    sub_n = max(1, math.ceil(delta / mag_step) if mag_step > 0 else 1)
    if delta == 0:
        sub_setpoints = [target_pct]
    else:
        step = (target_pct - current_pct) / sub_n
        sub_setpoints = [current_pct + step * (i + 1) for i in range(sub_n)]
        sub_setpoints[-1] = target_pct   # exact target, no float drift

    bc = max(1, min(batch_count, len(targets)))
    batches: List[list] = [[] for _ in range(bc)]
    for i, t in enumerate(targets):
        batches[i % bc].append(t)

    return {
        "sub_setpoints": sub_setpoints,
        "sub_count":     len(sub_setpoints),
        "batches":       batches,
        "batch_count":   bc,
        "target_count":  len(targets),
    }

async def _execute_ramp(job_id: str, targets: list, sub_setpoints: list,
                        batches: list, opcode_str: str,
                        substep_hold_s: float, batch_spacing_ms: float,
                        jitter_ms: float) -> None:
    """Background coroutine Ã¢â‚¬â€ drives the two-axis ramp, updates curtailment_state."""
    job = ramp_jobs.get(job_id)
    if job is None:
        return

    ts_start    = time.time()
    total_writes = len(sub_setpoints) * sum(len(b) for b in batches)
    completed   = 0
    errors: list = []

    job["status"]       = "running"
    job["ts_start"]     = ts_start
    job["total_writes"] = total_writes

    try:
        for sub_idx, sub_pct in enumerate(sub_setpoints):
            if job.get("abort"):
                break

            job["current_sub"] = sub_idx

            for batch_idx, batch in enumerate(batches):
                if job.get("abort"):
                    break

                job["current_batch"] = batch_idx

                async def _write_one(tgt=None, _sub=sub_pct, _si=sub_idx, _bi=batch_idx):
                    ip_    = tgt.get("ip") or tgt.get("inverter_ip") or ""
                    slave_ = int(tgt.get("slave", 1))
                    if jitter_ms > 0:
                        await asyncio.sleep(_random_mod.uniform(0, jitter_ms) / 1000.0)
                    if opcode_str == "stop":
                        r = await stop_inverter_apc(ip_, slave_)
                        st_pct = 0.0
                        st_op  = APC_OPCODE_STOP
                    elif opcode_str == "start":
                        r = await start_inverter_apc(ip_, slave_)
                        st_pct = 100.0
                        st_op  = APC_OPCODE_START
                    else:
                        r = await set_active_power_pct(ip_, slave_, _sub)
                        st_pct = _sub
                        st_op  = APC_OPCODE_SET_P
                    if r.get("ok"):
                        curtailment_state[(ip_, slave_)] = {
                            "active_pct": st_pct,
                            "opcode":     st_op,
                            "applied_ts": int(time.time() * 1000),
                            "job_id":     job_id,
                            "source":     "operator",
                        }
                    return {
                        "ip": ip_, "slave": slave_,
                        "ok": r.get("ok"), "error": r.get("error"),
                        "sub_step": _si, "batch_idx": _bi,
                        "setpoint_pct": _sub,
                    }

                write_tasks = [_write_one(tgt=t) for t in batch]
                batch_results = await asyncio.gather(*write_tasks, return_exceptions=True)

                for res in batch_results:
                    if isinstance(res, Exception):
                        errors.append({"error": str(res)})
                    else:
                        completed += 1
                        if not res.get("ok"):
                            errors.append(res)

                job["completed_writes"] = completed
                job["errors"]           = errors

                if batch_idx < len(batches) - 1 and not job.get("abort"):
                    await asyncio.sleep(batch_spacing_ms / 1000.0)

            if sub_idx < len(sub_setpoints) - 1 and not job.get("abort"):
                await asyncio.sleep(substep_hold_s)

    except asyncio.CancelledError:
        job["status"] = "aborted"
        raise
    except Exception as exc:
        job["status"] = "error"
        job["error"]  = str(exc)
        return

    if job.get("abort"):
        job["status"] = "aborted"
    elif completed == 0 and errors:
        job["status"] = "failed"
    elif errors:
        job["status"] = "partial"
    else:
        job["status"] = "completed"

    job["ts_end"]           = time.time()
    job["elapsed_s"]        = round(job["ts_end"] - ts_start, 2)
    job["completed_writes"] = completed
    job["errors"]           = errors

class ApcPreviewRequest(BaseModel):
    targets:     list
    target_pct:  float
    current_pct: Optional[float] = 100.0

class ApcRunRequest(BaseModel):
    targets:    list
    target_pct: Optional[float] = None
    opcode:     Optional[str]   = "set"   # "set" | "stop" | "start"
    mode:       str             = "ramp"
    force:      bool            = False

@app.post("/curtail/preview")
async def curtail_preview(req: ApcPreviewRequest):
    """Return ramp plan (sub-steps, batches, estimated time) without writing."""
    targets = [dict(t) if not isinstance(t, dict) else t for t in req.targets]
    if not targets:
        raise HTTPException(400, "targets is empty")
    pct = float(req.target_pct)
    if not (0.0 <= pct <= 100.0):
        raise HTTPException(400, "target_pct must be 0..100")

    plan = _compute_ramp_plan(
        current_pct=float(req.current_pct or 100.0),
        target_pct=pct,
        targets=targets,
        mag_step=25.0,
        batch_count=4,
    )
    sub_n = plan["sub_count"]
    bc    = plan["batch_count"]
    # holds between sub-steps + batch spacings within each sub-step
    est_ms = int(
        (sub_n - 1) * 6000 +          # 6 s hold per sub-step gap
        sub_n * (bc - 1) * 1500        # 1.5 s spacing per batch gap
    )
    return {
        "ok":            True,
        "sub_count":     sub_n,
        "batch_count":   bc,
        "target_count":  len(targets),
        "sub_setpoints": plan["sub_setpoints"],
        "est_total_ms":  est_ms,
        "est_total_s":   round(est_ms / 1000, 1),
    }

@app.post("/curtail/run")
async def curtail_run(req: ApcRunRequest):
    """Start a ramp job. Returns {job_id}. 409 if a ramp is already running (force=true aborts it)."""
    opcode_str = (req.opcode or "set").lower()
    if opcode_str not in ("set", "stop", "start"):
        raise HTTPException(400, "opcode must be 'set', 'stop', or 'start'")

    if opcode_str == "set":
        if req.target_pct is None:
            raise HTTPException(400, "target_pct required when opcode=set")
        pct = float(req.target_pct)
        if not (0.0 <= pct <= 100.0):
            raise HTTPException(400, "target_pct must be 0..100")
    else:
        pct = 0.0 if opcode_str == "stop" else 100.0

    targets = [dict(t) if not isinstance(t, dict) else t for t in req.targets]
    if not targets:
        raise HTTPException(400, "targets is empty")

    with ramp_lock:
        active_job = next(
            (j for j in ramp_jobs.values() if j.get("status") == "running"),
            None,
        )
        if active_job and not req.force:
            raise HTTPException(409, f"ramp job {active_job['job_id']} is running; pass force=true to abort it")
        if active_job:
            active_job["abort"] = True

        job_id = str(_uuid_mod.uuid4())

        if opcode_str in ("stop", "start"):
            sub_setpoints = [pct]
        else:
            current_pct = 100.0
            st = curtailment_state.get(
                (targets[0].get("ip", ""), int(targets[0].get("slave", 1)))
            )
            if st:
                current_pct = float(st.get("active_pct", 100.0))
            plan = _compute_ramp_plan(current_pct, pct, targets, mag_step=25.0, batch_count=4)
            sub_setpoints = plan["sub_setpoints"]

        bc      = max(1, min(4, len(targets)))
        batches = [[] for _ in range(bc)]
        for i, t in enumerate(targets):
            batches[i % bc].append(t)

        job: dict = {
            "job_id":           job_id,
            "status":           "queued",
            "opcode":           opcode_str,
            "target_pct":       pct,
            "targets":          targets,
            "sub_setpoints":    sub_setpoints,
            "sub_count":        len(sub_setpoints),
            "batch_count":      bc,
            "total_writes":     len(sub_setpoints) * sum(len(b) for b in batches),
            "completed_writes": 0,
            "current_sub":      0,
            "current_batch":    0,
            "errors":           [],
            "abort":            False,
            "ts_start":         None,
            "ts_end":           None,
            "elapsed_s":        None,
        }
        ramp_jobs[job_id] = job

    asyncio.create_task(_execute_ramp(
        job_id=job_id,
        targets=targets,
        sub_setpoints=sub_setpoints,
        batches=batches,
        opcode_str=opcode_str,
        substep_hold_s=6.0,
        batch_spacing_ms=1500.0,
        jitter_ms=80.0,
    ))

    return {"ok": True, "job_id": job_id}

@app.post("/curtail/abort/{job_id}")
async def curtail_abort(job_id: str):
    """Signal an in-flight ramp to stop after its current write. Returns job snapshot."""
    job = ramp_jobs.get(job_id)
    if not job:
        raise HTTPException(404, f"job {job_id} not found")
    if job.get("status") not in ("running", "queued"):
        raise HTTPException(409, f"job {job_id} is already {job.get('status')}")
    job["abort"] = True
    return {"ok": True, "job_id": job_id, "status": "abort_requested"}

@app.get("/curtail/state")
async def curtail_state_view():
    """Return all known per-slave setpoint states."""
    rows = []
    for (ip, slave), st in curtailment_state.items():
        rows.append({"ip": ip, "slave": slave, **st})
    return {"ok": True, "states": rows}

@app.get("/curtail/jobs/{job_id}")
async def curtail_job_view(job_id: str):
    """Return snapshot of one ramp job."""
    job = ramp_jobs.get(job_id)
    if not job:
        raise HTTPException(404, f"job {job_id} not found")
    return {"ok": True, "job": dict(job)}

# Ã¢â€â‚¬Ã¢â€â‚¬ Slice ÃŽÂ¶ Ã¢â‚¬â€ Grid-control endpoints (reactive + PF + read-back) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
# All write paths are auth-gated by Node-side `gridControlEnabled` flag +
# adsiMM key. Python service trusts upstream auth (loopback-only call site)
# but enforces argument validation. Read-back (`/grid-control/state`) is safe
# and unconditional.

class GridControlPhiReq(BaseModel):
    ip:    str
    slave: int
    phi_raw: int   # Int16 wire value; NGCP PF 0.95 Ã¢â€ â€™ Ã‚Â±10780

class GridControlReactiveReq(BaseModel):
    ip:    str
    slave: int
    kvar_div10: int  # Int16, raw kVAr / 10 per PDF cmd 9

class GridControlDisableReq(BaseModel):
    ip:    str
    slave: int

@app.post("/grid-control/phi")
async def api_grid_control_phi(req: GridControlPhiReq):
    """Cmd 1 Ã¢â‚¬â€ set tan(Ãâ€ ) target. Caller passes raw Int16 (already scaled)."""
    return await set_phi_tangent(req.ip, int(req.slave), int(req.phi_raw))

@app.post("/grid-control/reactive")
async def api_grid_control_reactive(req: GridControlReactiveReq):
    """Cmd 9 Ã¢â‚¬â€ set reactive power reference. Caller passes raw Int16 (kVAr ÃƒÂ· 10)."""
    return await set_reactive_kvar(req.ip, int(req.slave), int(req.kvar_div10))

@app.post("/grid-control/disable")
async def api_grid_control_disable(req: GridControlDisableReq):
    """Cmd 11 Ã¢â‚¬â€ disable reactive reference, restore default."""
    return await disable_reactive(req.ip, int(req.slave))

@app.get("/grid-control/state/{ip}/{slave}")
async def api_grid_control_state(ip: str, slave: int):
    """Read holding 41006-41010 in one transaction. Returns raw regs +
    convenience-decoded fields. Sign-cast for phi/reactive is left to Node."""
    return await read_grid_control_state(ip, int(slave))

# Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
# Field Calibration (Phase 1 Ã¢â‚¬â€ read-only) Ã¢â‚¬â€ display-bypass calibration tool.
# Plan: plans/2026-05-12-inverter-calibration-tool.md
# Decoder + register map: services/calibration_decoder.py
# Block geometry: 15 holding regs at offsets 0x0050..0x005E (decimal 80-94).
# Sentinel: offset 80 ValidCfgCode must read 0x1F1F.
# Phase 1 has NO writes Ã¢â‚¬â€ see Phase 2 for the future calibration_io module.
# Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

try:
    import calibration_decoder as _calib_dec
except ImportError:
    try:
        from services import calibration_decoder as _calib_dec
    except ImportError:
        _calib_dec = None
try:
    from calibration_core import (
        _read_calibration_block_sync,
        _read_live_for_calibration_sync,
        _CALIB_READ_BASE,
        _CALIB_READ_COUNT,
    )
except ImportError:
    try:
        from .calibration_core import (
            _read_calibration_block_sync,
            _read_live_for_calibration_sync,
            _CALIB_READ_BASE,
            _CALIB_READ_COUNT,
        )
    except ImportError:
        _read_calibration_block_sync = _read_live_for_calibration_sync = None
        _CALIB_READ_BASE = 0x50
        _CALIB_READ_COUNT = 15

async def read_calibration_block(ip: str, slave: int) -> dict:
    """Single-transaction FC03 read of holding 0x50..0x5E (15 regs)."""
    client = clients.get(ip)
    if not client:
        return {"ok": False, "error": "no_client"}
    lock = thread_locks.get(ip)
    if lock is None:
        return {"ok": False, "error": "no_lock"}
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        executor,
        _read_calibration_block_sync,
        client, lock, int(slave),
    )

async def read_live_for_calibration(ip: str, slave: int) -> dict:
    """Async wrapper around `_read_live_for_calibration_sync` (per-IP lock)."""
    client = clients.get(ip)
    if not client:
        return {"_warn": "no_client"}
    lock = thread_locks.get(ip)
    if lock is None:
        return {"_warn": "no_lock"}
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        executor,
        _read_live_for_calibration_sync,
        client, lock, int(slave),
    )

@app.get("/calibration/state/{ip}/{slave}")
async def api_calibration_state(ip: str, slave: int):
    """Read + decode the calibration block for one (inverter, slave).

    Returns {ok, regs, calibration: {fields, valid_cfg_code_*}, live: {...}}
    or {ok: False, error}.  No auth here (Node enforces topology auth before
    proxying Ã¢â‚¬â€ same pattern as /grid-control/state).

    `live` mirrors the LCD's calibration screen: Vac1-3, Iac1-3, Vdc, Idc,
    Pac, Qac, VpvP, VpvN. Each value pairs with one or more scale factors
    in the calibration block so the operator sees the meter value next to
    the factor they're editing.
    """
    raw = await read_calibration_block(ip, int(slave))
    if not raw.get("ok"):
        return raw
    decoded = _calib_dec.decode_calibration_block(raw["regs"], base_offset=_CALIB_READ_BASE)
    live = await read_live_for_calibration(ip, int(slave))
    return {
        "ok":           True,
        "ip":           ip,
        "slave":        int(slave),
        "base":         raw["base"],
        "count":        raw["count"],
        "regs":         raw["regs"],
        "calibration":  decoded,
        "live":         live,
        "read_at_ms":   int(time.time() * 1000),
    }

@app.post("/calibration/write")
async def api_calibration_write(req: Request):
    """Write ONE calibration register with preflight + range guard + verify.

    Body:
      {
        ip:             "192.168.1.101",
        slave:          1,
        offset:         81,             # must be in 81..94
        value:          1125,           # int (will be sign-encoded if needed)
        max_delta_pct:  50.0,           # optional, null disables guard
      }

    No auth here Ã¢â‚¬â€ Node enforces adsiMM + topology + session-id before
    proxying.  Returns the full write-result dict for audit logging.
    """
    try:
        body = await req.json()
    except Exception:
        raise HTTPException(400, "invalid JSON")
    ip = str(body.get("ip") or "").strip()
    slave = int(body.get("slave") or 0)
    offset = int(body.get("offset") or 0)
    if not ip:        raise HTTPException(400, "ip required")
    if slave <= 0:    raise HTTPException(400, "slave required")
    if offset <= 0:   raise HTTPException(400, "offset required")
    if "value" not in body:
        raise HTTPException(400, "value required")

    client = clients.get(ip)
    if not client:    raise HTTPException(503, f"no client for {ip}")
    lock = thread_locks.get(ip)
    if lock is None:  raise HTTPException(503, f"no lock for {ip}")
    loop = asyncio.get_running_loop()
    try:
        result = await loop.run_in_executor(
            executor,
            lambda: write_one_with_lock(
                client, lock, slave, offset, int(body["value"]),
                max_delta_pct=body.get("max_delta_pct", 50.0),
                verify_delay_s=float(body.get("verify_delay_s", 1.0)),
            ),
        )
    except Exception as exc:
        raise HTTPException(500, f"executor_error: {exc}")
    result["ip"] = ip
    result["slave"] = slave
    result["read_at_ms"] = int(time.time() * 1000)
    return result

@app.post("/calibration/write-bulk")
async def api_calibration_write_bulk(req: Request):
    """Write multiple calibration registers under a single unlock + verify.

    Body:
      {
        ip:    "192.168.1.101",
        slave: 1,
        writes: [
          { offset: 81, value: 1125 },
          { offset: 84, value: 1684 },
          ...
        ],
        max_delta_pct: 50.0,
      }

    Returns the bulk write result.
    """
    try:
        body = await req.json()
    except Exception:
        raise HTTPException(400, "invalid JSON")
    ip = str(body.get("ip") or "").strip()
    slave = int(body.get("slave") or 0)
    writes_raw = body.get("writes") or []
    if not ip:       raise HTTPException(400, "ip required")
    if slave <= 0:   raise HTTPException(400, "slave required")
    if not isinstance(writes_raw, list) or not writes_raw:
        raise HTTPException(400, "writes (non-empty list) required")

    pairs = []
    for w in writes_raw:
        try:
            pairs.append((int(w["offset"]), int(w["value"])))
        except (KeyError, ValueError, TypeError) as exc:
            raise HTTPException(400, f"invalid writes entry: {exc}")

    client = clients.get(ip)
    if not client:   raise HTTPException(503, f"no client for {ip}")
    lock = thread_locks.get(ip)
    if lock is None: raise HTTPException(503, f"no lock for {ip}")
    loop = asyncio.get_running_loop()
    try:
        result = await loop.run_in_executor(
            executor,
            lambda: write_bulk_with_lock(
                client, lock, slave, pairs,
                max_delta_pct=body.get("max_delta_pct", 50.0),
                verify_delay_s=float(body.get("verify_delay_s", 1.0)),
            ),
        )
    except Exception as exc:
        raise HTTPException(500, f"executor_error: {exc}")
    result["ip"] = ip
    result["slave"] = slave
    result["read_at_ms"] = int(time.time() * 1000)
    return result

_calibration_lockdown = {"active": False, "inverter": None, "slave": None, "session_id": None}

def _is_under_calibration(inverter: int, unit: int) -> bool:
    """Returns True if the (inverter, slave) is the active calibration target.
    Used by handle_auto_reset to skip the target inverter while a session
    is in progress.  Node owns the canonical session state and pushes
    updates via POST /calibration/lockdown."""
    if not _calibration_lockdown["active"]:
        return False
    return (int(_calibration_lockdown["inverter"]) == int(inverter)
            and int(_calibration_lockdown["slave"]) == int(unit))

@app.post("/calibration/lockdown")
async def api_calibration_lockdown(req: Request):
    """NodeÃ¢â€ â€™Python lockdown sync. Set `active=false` to release."""
    try:
        body = await req.json()
    except Exception:
        raise HTTPException(400, "invalid JSON")
    active = bool(body.get("active"))
    if active:
        inverter = int(body.get("inverter") or 0)
        slave = int(body.get("slave") or 0)
        if not inverter or not slave:
            raise HTTPException(400, "inverter+slave required when active=true")
        _calibration_lockdown.update({
            "active": True, "inverter": inverter, "slave": slave,
            "session_id": str(body.get("session_id") or ""),
        })
    else:
        _calibration_lockdown.update({
            "active": False, "inverter": None, "slave": None, "session_id": None,
        })
    print(f"[calibration-lockdown] now active={_calibration_lockdown['active']} target={_calibration_lockdown.get('inverter')}/{_calibration_lockdown.get('slave')}", flush=True)
    return {"ok": True, "state": dict(_calibration_lockdown)}

@app.post("/calibration/config-write")
async def api_calibration_config_write(req: Request):
    """Write ONE L2 config-block field (Utility Tool tabs B/C/D/I).

    Body: {
      ip:         str,
      slave:      int,
      field:      str,            # name from cfg_trif_map.FIELDS
      value:      any,            # natural value (e.g. 5000 W, 60.00 Hz)
      verify_delay_s?: float,
    }

    Mirror of /calibration/write but for the broader L2 config offsets
    (B/C/D/I groups). Field lookup + encoding via cfg_block_write; lock +
    sentinel + verify cycle via calibration_io.write_cfg_field_with_lock.
    Auth + audit are owned by the Node proxy layer.
    """
    try:
        body = await req.json()
    except Exception:
        raise HTTPException(400, "invalid JSON")
    ip = str(body.get("ip") or "").strip()
    slave = int(body.get("slave") or 0)
    field_name = str(body.get("field") or "").strip()
    if not ip:
        raise HTTPException(400, "ip required")
    if slave <= 0:
        raise HTTPException(400, "slave required")
    if not field_name:
        raise HTTPException(400, "field required")
    if "value" not in body:
        raise HTTPException(400, "value required")

    client = clients.get(ip)
    if not client:
        raise HTTPException(503, f"no client for {ip}")
    lock = thread_locks.get(ip)
    if lock is None:
        raise HTTPException(503, f"no lock for {ip}")

    if firmware_flash_active(ip):
        return {"ok": False, "error": "firmware_flash_in_progress", "ip": ip}

    try:
        import cfg_trif_map as _cfg_map
    except ImportError:
        try:
            from services import cfg_trif_map as _cfg_map
        except Exception as exc:
            raise HTTPException(500, f"cfg_trif_map unavailable: {exc}")
    field_meta = None
    for f in (getattr(_cfg_map, "FIELDS", None) or []):
        if str(f.get("field") or "") == field_name:
            field_meta = f
            break
    if field_meta is None:
        raise HTTPException(400, f"unknown field '{field_name}'")
    loop = asyncio.get_running_loop()
    try:
        result = await loop.run_in_executor(
            executor,
            lambda: write_cfg_field_with_lock(
                client, lock, slave, field_meta, body["value"],
                verify_delay_s=float(body.get("verify_delay_s") or 1.0),
                # In-lock TOCTOU close: if a firmware flash claims the
                # bus marker between the pre-check and the lock, refuse.
                is_flash_active=lambda: firmware_flash_active(ip),
            ),
        )
    except Exception as exc:
        raise HTTPException(500, f"executor_error: {exc}")
    result["ip"] = ip
    result["slave"] = slave
    result["read_at_ms"] = int(time.time() * 1000)
    return result

@app.post("/calibration/consign")
async def api_calibration_consign(req: Request):
    """Drive APC setpoint (opcode 0x0003) to specified percent for calibration consign.

    Body: { ip, slave, percent }   percent in [0, 100]

    Delegates to calibration_io.consign_apc_with_lock (single-source core).
    Returns {ok, pct, q15, error?}.
    """
    try:
        body = await req.json()
    except Exception:
        raise HTTPException(400, "invalid JSON")
    ip = str(body.get("ip") or "").strip()
    slave = int(body.get("slave") or 0)
    pct = float(body.get("percent", -1))
    if not ip:
        raise HTTPException(400, "ip required")
    if slave <= 0:
        raise HTTPException(400, "slave required")
    if pct < 0 or pct > 100:
        raise HTTPException(400, "percent must be 0..100")

    # Resolve client + lock from the fleet registry
    client = clients.get(ip)
    if not client:
        return {"ok": False, "pct": pct, "q15": 0, "error": "no_client"}
    lock = thread_locks.get(ip)
    if lock is None:
        return {"ok": False, "pct": pct, "q15": 0, "error": "no_lock"}

    # Delegate to single-source calibration core
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        executor,
        consign_apc_with_lock,
        client, lock, int(slave), float(pct),
    )

@app.get("/calibration/preflight/{ip}/{slave}")
async def api_calibration_preflight(ip: str, slave: int):
    """Read sentinel + 81-94 and report sentinel_ok. Used before session start."""
    client = clients.get(ip)
    if not client:   return {"ok": False, "error": "no_client"}
    lock = thread_locks.get(ip)
    if lock is None: return {"ok": False, "error": "no_lock"}
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        executor,
        lambda: preflight_read_with_lock(client, lock, int(slave)),
    )

@app.get("/calibration/cfg-map")
async def api_calibration_cfg_map():
    """Return the STATIC Utility Tool field map (offsets, kinds, groups,
    labels, units). No transport, no Modbus Ã¢â‚¬â€ lets the dashboard render
    the Utility Tool tab layout even before a successful Read."""
    try:
        try:
            from services import cfg_trif_map as _m  # type: ignore
        except Exception:
            import cfg_trif_map as _m                # type: ignore
        return {
            "ok": True,
            "fields": list(_m.FIELDS),
            "group_titles": dict(_m.GROUP_TITLES),
        }
    except Exception as exc:
        return {"ok": False, "error": str(exc)}

@app.get("/calibration/full-config/{ip}/{slave}")
async def api_calibration_full_config(ip: str, slave: int):
    """Diagnostic-only Ã¢â‚¬â€ read the full 177-register config block and decode
    RTC + context fields alongside the calibration sub-block.  Slow (one
    big FC03), so only used by the 'Full Config Dump' button in the UI,
    not by the at-a-glance read."""
    client = clients.get(ip)
    if not client:
        return {"ok": False, "error": "no_client"}
    lock = thread_locks.get(ip)
    if lock is None:
        return {"ok": False, "error": "no_lock"}

    def _read_full(c, lk, s):
        # The INGECON comm-board / EKI gateway caps FC03 responses at ~49
        # registers per frame regardless of the protocol's 125-register
        # ceiling, so a single 177-register read returns a short_frame.
        # Chunk into 48-reg slices and concatenate.  All slices share one
        # per-IP lock acquisition so no other Modbus traffic interleaves.
        CHUNK = 48
        try:
            base  = _calib_dec.CONFIG_BLOCK_BASE
            total = _calib_dec.CONFIG_BLOCK_LENGTH
            out: list[int] = []
            with lk:
                offset = 0
                while offset < total:
                    need = min(CHUNK, total - offset)
                    r = c.read_holding_registers(
                        address=base + offset,
                        count=need,
                        unit=s,
                    )
                    if r is None or r.isError():
                        return {"ok": False, "error": f"modbus_error@{offset}: {r}"}
                    got = list(r.registers) if hasattr(r, "registers") else []
                    if len(got) < need:
                        return {"ok": False, "error": f"short_frame@{offset}: got {len(got)}/{need}"}
                    out.extend(got)
                    offset += need
            if len(out) < total:
                return {"ok": False, "error": f"short_frame: got {len(out)}/{total}"}
            return {"ok": True, "regs": out}
        except Exception as exc:
            return {"ok": False, "error": f"exception: {exc}"}

    loop = asyncio.get_running_loop()
    raw = await loop.run_in_executor(executor, _read_full, client, lock, int(slave))
    if not raw.get("ok"):
        return raw
    decoded = _calib_dec.decode_config_block(raw["regs"])
    return {
        "ok": True, "ip": ip, "slave": int(slave),
        "block_base": _calib_dec.CONFIG_BLOCK_BASE,
        "block_len":  _calib_dec.CONFIG_BLOCK_LENGTH,
        "decoded":    decoded,
        "regs_hex":   " ".join(f"{v & 0xFFFF:04X}" for v in raw["regs"]),
        "read_at_ms": int(time.time() * 1000),
    }

@app.get("/calibration/scan/{ip}/{slave}")
async def api_calibration_scan(ip: str, slave: int):
    """Read-only fleet-scan probe Ã¢â‚¬â€ TCP only, TRANSIENT socket.

    Mirrors the calibrator_app.py endpoint of the same name so the
    Utility Tool's "Fleet Scan" tab can iterate ipconfig and decode the
    full 177-register config block per node REGARDLESS of whether that
    inverter is currently in the dashboard poller's rotation. Opens a
    SHORT-LIVED Modbus-TCP client, reads, decodes, closes Ã¢â‚¬â€ deliberately
    does NOT touch `clients`/`thread_locks` (the shared poller state) so
    an active poll on a different inverter is never disturbed and there
    is no per-IP lock contention with the poller.

    Read-only FC03 only. Never writes. Treats firmware-flash-in-progress
    as a hard stop (same fail-open semantics as the regular poll).
    Returns {ok, ip, slave, decoded, read_at_ms} | {ok:false, error}.
    """
    # Firmware-flash bus lock: if this IP is being flashed, refuse the
    # scan so we don't compete with the calibrator on the RS-485 bus.
    # fail-open: active_ips() returns {} on any marker problem.
    try:
        active_fw_ips = firmware_buslock.active_ips()
    except Exception:
        active_fw_ips = set()
    if str(ip) in active_fw_ips:
        return {"ok": False, "error": "firmware_flash_in_progress"}

    loop = asyncio.get_running_loop()

    def _scan(addr: str, s: int):
        # Same CHUNK ceiling the comm-board / EKI gateway uses (~49 reg max
        # per FC03 response regardless of the protocol's 125-reg ceiling).
        CHUNK = 48
        client = None
        try:
            client = create_client(addr, port=502, timeout=3.0)
            try:
                opened = bool(client.connect())
            except Exception:
                opened = False
            if not opened and hasattr(client, "is_socket_open"):
                opened = bool(client.is_socket_open())
            if not opened:
                return {"ok": False, "error": f"unreachable:{addr}"}
            base = _calib_dec.CONFIG_BLOCK_BASE
            total = _calib_dec.CONFIG_BLOCK_LENGTH
            out: list[int] = []
            offset = 0
            while offset < total:
                need = min(CHUNK, total - offset)
                r = client.read_holding_registers(
                    address=base + offset, count=need, unit=int(s))
                if r is None or r.isError():
                    return {"ok": False, "error": f"modbus_error@{offset}"}
                got = list(r.registers) if hasattr(r, "registers") else []
                if len(got) < need:
                    return {"ok": False,
                            "error": f"short_frame@{offset}: {len(got)}/{need}"}
                out.extend(got)
                offset += need
            return {"ok": True, "regs": out}
        except Exception as exc:
            return {"ok": False, "error": f"exception: {exc}"}
        finally:
            if client is not None:
                try:
                    client.close()
                except Exception:
                    pass

    try:
        raw = await loop.run_in_executor(executor, _scan, str(ip), int(slave))
        if not raw.get("ok"):
            return raw
        return {
            "ok": True,
            "ip": str(ip),
            "slave": int(slave),
            "decoded": _calib_dec.decode_config_block(raw["regs"]),
            "read_at_ms": int(time.time() * 1000),
        }
    except Exception as exc:
        return {"ok": False, "error": str(exc)}

from fastapi import WebSocket, WebSocketDisconnect

@app.websocket("/ws")
async def websocket_metrics(ws: WebSocket):
    await ws.accept()
    print("[WS] Client connected")

    try:
        while True:
            data = _build_metrics()   # use your existing metrics builder
            await ws.send_text(json.dumps(data))
            await asyncio.sleep(0.5)  # 500ms push
    except WebSocketDisconnect:
        print("[WS] Client disconnected")
    except Exception as e:
        print("[WS] Error:", e)

# -------------------------------------------------
#   Entry point
# -------------------------------------------------

async def main():
    if os.name == "nt":
        free_engine_port()

    clear_service_stop_file()
    load_autoreset_config()
    auto_reset_state.clear()

    await rebuild_global_maps()
    # T3.20 fix (Phase 8, 2026-04-14): warn loudly if ipconfig is empty at
    # startup.  The service stays up (so ipconfig hot-reload can add inverters
    # later) but the operator gets a clear signal rather than silently-empty
    # /data and /health responses.
    if not inverters:
        print(
            "[ENGINE] WARNING: ipconfig lists zero inverters. Service will stay up "
            "waiting for ipconfig hot-reload, but /data and /metrics will return empty "
            "until an inverter IP is configured.  Check %PROGRAMDATA%\\Inverter-Dashboard\\db\\ipconfig.json."
        )

    # v2.9.0 Slice C Ã¢â‚¬â€ crash-recovery seed before polling begins.
    # Runs in background so a stuck Node call never blocks engine startup.
    try:
        asyncio.create_task(seed_pac_from_baseline())
    except Exception as exc:
        print(f"[RECOVERY] could not schedule seed_pac_from_baseline: {exc}")

    # RS485-USB bridge (Option A) Ã¢â‚¬â€ start if configured.
    # Runs in background so a missing pyserial or port error never blocks engine startup.
    if rs485_bridge is not None:
        try:
            cfg = await load_ipconfig()
            asyncio.create_task(rs485_bridge.serve(cfg))
        except Exception as exc:
            print(f"[RS485-BRIDGE] could not start bridge: {exc}")

    asyncio.create_task(ipconfig_watcher())
    asyncio.create_task(start_polling_manager())

    print(f"[ENGINE] Hybrid engine started Ã¢â‚¬â€ listening on {ENGINE_HOST}:{ENGINE_PORT}")

    config = uvicorn.Config(
        app,
        host=ENGINE_HOST,
        port=ENGINE_PORT,
        log_level="critical",
        access_log=False,
    )
    server = uvicorn.Server(config)
    stop_task = None
    try:
        if SERVICE_STOP_FILE is not None:
            async def watch_service_stop():
                while not server.should_exit:
                    if service_stop_requested():
                        print("[ENGINE] Soft stop requested - shutting down...")
                        server.should_exit = True
                        return
                    await asyncio.sleep(SERVICE_STOP_POLL_SEC)

            stop_task = asyncio.create_task(watch_service_stop())
        await server.serve()
    finally:
        if stop_task is not None:
            stop_task.cancel()
            try:
                await stop_task
            except asyncio.CancelledError:
                pass
        # RS485-USB bridge shutdown
        if rs485_bridge is not None:
            try:
                await rs485_bridge.shutdown()
            except Exception as e:
                print(f"[RS485-BRIDGE] Shutdown error: {e}")
        clear_service_stop_file()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("[ENGINE] Stopping...")
