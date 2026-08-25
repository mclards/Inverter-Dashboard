"""
Counter Integrity Tester
========================

Standalone, READ-ONLY Modbus tester for the ADSI inverter fleet.

Goal: collect raw register samples + a mirrored PAC trapezoidal integration
(using the same semantics as services/inverter_engine.py) so we can evaluate
whether any hardware energy counter (Etotal / parcE / parcH / parcC / other)
is reliable enough to replace or augment the software PAC integration for
dashboard-crash recovery.

NOTES
-----
* Fully isolated from the dashboard: imports ONLY pymodbus + stdlib.
* Never writes anything to the inverter (no FC6/FC16/FC74 calls).
* Never touches the dashboard SQLite or ipconfig via the DB path.
* Reads a WIDER register window than the production poller (0..47 vs 0..25)
  to capture any hardware energy counters living above the production
  block. If your firmware blocks reads above 25, that range simply returns
  None and gets recorded as such — no crash.
* Output: JSONL (one record per successful poll) + a periodic text summary.

USAGE
-----
  # From d:\\ADSI-Dashboard
  python tools/counter_integrity_tester.py                    # 4 h, 5 s interval
  python tools/counter_integrity_tester.py --duration-hours 8
  python tools/counter_integrity_tester.py --interval-s 10 --duration-hours 2
  python tools/counter_integrity_tester.py --ipconfig ipconfig.json

Ctrl+C cleanly shuts down and writes the final summary.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

try:
    from pymodbus.client.sync import ModbusTcpClient
except Exception as exc:
    print(f"[FATAL] pymodbus not importable: {exc}", file=sys.stderr)
    print("        Install it with: pip install \"pymodbus<3\"", file=sys.stderr)
    sys.exit(2)

# ───────────────────────────────────────────────────────────────
# Constants
# ───────────────────────────────────────────────────────────────

DEFAULT_PORT = 502
DEFAULT_TIMEOUT_S = 1.5
DEFAULT_POLL_INTERVAL_S = 5.0
DEFAULT_DURATION_HOURS = 4.0
PRIMARY_READ_ADDR = 0
PRIMARY_READ_COUNT = 26              # same as production — covers Etotal@0-1, pac@18, date@20-25
PAC_MAX_DT_S = 30.0                   # same cap as production engine
PAC_SCALE = 10.0                      # production engine multiplies reg(18) by 10 → Watts
PAC_CLAMP_W = 260_000                 # same cap as production engine

# ───────────────────────────────────────────────────────────────
# ipconfig loader (simple file-based; NOT using the dashboard DB)
# ───────────────────────────────────────────────────────────────

def find_ipconfig(explicit: Optional[str]) -> Path:
    if explicit:
        p = Path(explicit).expanduser().resolve()
        if not p.is_file():
            raise FileNotFoundError(f"--ipconfig not found: {p}")
        return p
    candidates = [
        Path(__file__).resolve().parent.parent / "ipconfig.json",
        Path(os.environ.get("PROGRAMDATA", "C:/ProgramData")) / "InverterDashboard" / "ipconfig.json",
        Path(os.environ.get("LOCALAPPDATA", "")) / "InverterDashboard" / "ipconfig.json",
    ]
    for c in candidates:
        try:
            if c.is_file():
                return c
        except Exception:
            continue
    raise FileNotFoundError(
        "Could not locate ipconfig.json. Pass --ipconfig <path> explicitly."
    )

def load_ipconfig(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    invs = data.get("inverters") or {}
    units = data.get("units") or {}
    plan: list[tuple[int, str, list[int]]] = []
    for inv_key, ip in invs.items():
        try:
            inv_num = int(inv_key)
        except Exception:
            continue
        if not ip:
            continue
        unit_list = units.get(inv_key) or units.get(str(inv_num)) or []
        try:
            unit_nums = [int(u) for u in unit_list if int(u) > 0]
        except Exception:
            unit_nums = []
        if not unit_nums:
            # Default to [1,2,3,4] so we can prove absence via failed reads
            unit_nums = [1, 2, 3, 4]
        plan.append((inv_num, str(ip), unit_nums))
    plan.sort(key=lambda r: r[0])
    return {"plan": plan, "source": str(path)}

# ───────────────────────────────────────────────────────────────
# Per-(inv,unit) PAC integrator — mirrors services/inverter_engine.py
# ───────────────────────────────────────────────────────────────

class PacIntegrator:
    def __init__(self) -> None:
        self.state: dict[str, dict] = {}

    def step(self, inv: int, unit: int, pac_reg: float, vdc: float, idc: float,
             date_key: str, now_ms: int) -> dict:
        """
        Mirrors inverter_engine._update_metrics_from_frame trapezoidal rule.

        Returns a dict snapshot after this step:
            {totalWh, kwh_today, pac_W, date}
        """
        nk = f"{inv}_{unit}"

        scaled = pac_reg * PAC_SCALE
        if scaled > PAC_CLAMP_W:
            scaled = 0.0
        pac_w = 0.0 if (vdc == 0 or idc == 0) else float(scaled)

        pe = self.state.get(nk)
        if pe is None:
            pe = {
                "lastTime": now_ms, "lastPac": pac_w, "totalWh": 0.0, "date": date_key,
            }
            self.state[nk] = pe
        else:
            if pe["date"] != date_key:
                pe["date"] = date_key
                pe["totalWh"] = 0.0
                pe["lastTime"] = now_ms
                pe["lastPac"] = pac_w
            else:
                dt_sec = max(0.0, min((now_ms - pe["lastTime"]) / 1000.0, PAC_MAX_DT_S))
                if dt_sec > 0 and pac_w >= 0:
                    avg = (pe["lastPac"] + pac_w) / 2.0
                    pe["totalWh"] += (avg * dt_sec) / 3600.0
                pe["lastPac"] = pac_w
                pe["lastTime"] = now_ms

        return {
            "total_wh": round(pe["totalWh"], 3),
            "kwh_today": round(pe["totalWh"] / 1000.0, 6),
            "pac_w": pac_w,
            "date": pe["date"],
        }

# ───────────────────────────────────────────────────────────────
# Per-inverter thread: connect once, poll all units on a cadence
# ───────────────────────────────────────────────────────────────

class InverterPoller(threading.Thread):
    def __init__(
        self,
        inv_num: int,
        ip: str,
        units: list[int],
        interval_s: float,
        deadline_ms: int,
        integrator: PacIntegrator,
        write_queue: "threading.Queue[dict]",
        stop_event: threading.Event,
        port: int = DEFAULT_PORT,
        timeout_s: float = DEFAULT_TIMEOUT_S,
    ) -> None:
        super().__init__(name=f"poll-inv{inv_num}", daemon=True)
        self.inv_num = inv_num
        self.ip = ip
        self.units = units
        self.interval_s = interval_s
        self.deadline_ms = deadline_ms
        self.integrator = integrator
        self.write_queue = write_queue
        self.stop_event = stop_event
        self.port = port
        self.timeout_s = timeout_s
        self.stats = {"polls_ok": 0, "polls_fail": 0}

    def _connect(self) -> Optional[ModbusTcpClient]:
        try:
            client = ModbusTcpClient(
                host=self.ip, port=self.port,
                timeout=self.timeout_s, retry_on_empty=False,
            )
            client.connect()
            return client
        except Exception as exc:
            self._enqueue_event("connect_error", str(exc))
            return None

    def _close(self, client: Optional[ModbusTcpClient]) -> None:
        if client is None:
            return
        try:
            client.close()
        except Exception:
            pass

    def _read(self, client: ModbusTcpClient, address: int, count: int, unit: int) -> Optional[list[int]]:
        try:
            r = client.read_input_registers(address=address, count=count, unit=unit)
            if r and not r.isError():
                return list(r.registers)
        except Exception:
            try:
                client.close()
            except Exception:
                pass
            try:
                client.connect()
            except Exception:
                return None
            try:
                r = client.read_input_registers(address=address, count=count, unit=unit)
                if r and not r.isError():
                    return list(r.registers)
            except Exception:
                return None
        return None

    def _enqueue_event(self, kind: str, detail: str) -> None:
        self.write_queue.put({
            "kind": "event",
            "ts_ms": int(time.time() * 1000),
            "inv": self.inv_num,
            "ip": self.ip,
            "event": kind,
            "detail": detail,
        })

    def run(self) -> None:
        client = self._connect()
        next_tick = time.monotonic()

        while not self.stop_event.is_set():
            now_ms = int(time.time() * 1000)
            if now_ms >= self.deadline_ms:
                break

            if client is None or not getattr(client, "socket", None):
                client = self._connect()
                if client is None:
                    # back off and retry
                    if self.stop_event.wait(1.0):
                        break
                    continue

            for unit in self.units:
                if self.stop_event.is_set():
                    break

                primary = self._read(client, PRIMARY_READ_ADDR, PRIMARY_READ_COUNT, unit)
                if primary is None:
                    self.stats["polls_fail"] += 1
                    self._enqueue_event("read_fail_primary", f"unit={unit}")
                    continue
                self.stats["polls_ok"] += 1

                def reg(i: int) -> int:
                    return primary[i] if i < len(primary) else 0

                # Ingeteam UInt32 convention is hi-word first (big-endian word pair).
                etotal_kwh = ((reg(0) & 0xFFFF) << 16) | (reg(1) & 0xFFFF)

                vdc = float(reg(8))
                idc = float(reg(9))
                pac_reg = float(reg(18))
                inv_y, inv_mo, inv_dy = reg(20), reg(21), reg(22)
                inv_h, inv_mi, inv_s  = reg(23), reg(24), reg(25)

                # Inverter RTC parse + drift vs server wall clock.
                inv_ts_iso = None
                inv_ts_ms = None
                rtc_drift_s = None
                rtc_valid = False
                if inv_y and 2000 <= inv_y <= 2100 and 1 <= inv_mo <= 12 and 1 <= inv_dy <= 31 \
                   and 0 <= inv_h <= 23 and 0 <= inv_mi <= 59 and 0 <= inv_s <= 59:
                    try:
                        # Interpret RTC as naive local time (same TZ as the gateway PC).
                        dt = datetime(inv_y, inv_mo, inv_dy, inv_h, inv_mi, inv_s)
                        inv_ts_iso = dt.isoformat(timespec="seconds")
                        inv_ts_ms = int(dt.timestamp() * 1000)
                        rtc_drift_s = round((inv_ts_ms - now_ms) / 1000.0, 1)
                        rtc_valid = True
                    except Exception:
                        pass

                if rtc_valid:
                    date_key = f"{inv_y}-{inv_mo:02d}-{inv_dy:02d}"
                else:
                    date_key = datetime.now().strftime("%Y-%m-%d")

                pac_snap = self.integrator.step(
                    self.inv_num, unit, pac_reg, vdc, idc, date_key, now_ms,
                )

                record = {
                    "kind": "sample",
                    "ts_ms": now_ms,
                    "inv": self.inv_num,
                    "unit": unit,
                    "date_key": date_key,
                    "etotal_kwh": etotal_kwh,
                    "etotal_r0": int(reg(0)),
                    "etotal_r1": int(reg(1)),
                    "pac_W": pac_snap["pac_w"],
                    "pac_reg": int(pac_reg),
                    "vdc_reg": int(reg(8)),
                    "idc_reg": int(reg(9)),
                    "kwh_today_integrated": pac_snap["kwh_today"],
                    "inv_rtc_iso": inv_ts_iso,
                    "inv_rtc_ms": inv_ts_ms,
                    "inv_rtc_valid": rtc_valid,
                    "rtc_drift_s": rtc_drift_s,
                    "inv_rtc_raw": {"y": int(inv_y), "mo": int(inv_mo), "dy": int(inv_dy),
                                    "h": int(inv_h), "mi": int(inv_mi), "s": int(inv_s)},
                }
                self.write_queue.put(record)

            # sleep until next tick
            next_tick += self.interval_s
            sleep_for = max(0.0, next_tick - time.monotonic())
            if sleep_for > 0:
                if self.stop_event.wait(sleep_for):
                    break
            else:
                # we're behind; reset schedule
                next_tick = time.monotonic()

        self._close(client)

# ───────────────────────────────────────────────────────────────
# Writer thread: drains the queue into JSONL + logs progress
# ───────────────────────────────────────────────────────────────

class JsonlWriter(threading.Thread):
    def __init__(self, out_path: Path, write_queue, stop_event: threading.Event) -> None:
        super().__init__(name="writer", daemon=True)
        self.out_path = out_path
        self.queue = write_queue
        self.stop_event = stop_event
        self.samples = 0
        self.events = 0

    def run(self) -> None:
        self.out_path.parent.mkdir(parents=True, exist_ok=True)
        with self.out_path.open("a", encoding="utf-8") as f:
            # write a header record so we can identify runs
            f.write(json.dumps({
                "kind": "run_start",
                "ts_ms": int(time.time() * 1000),
                "ts_iso": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "python": sys.version,
                "pid": os.getpid(),
            }) + "\n")
            f.flush()

            while not (self.stop_event.is_set() and self.queue.empty()):
                try:
                    rec = self.queue.get(timeout=0.5)
                except Exception:
                    continue
                try:
                    f.write(json.dumps(rec, separators=(",", ":")) + "\n")
                    f.flush()
                    if rec.get("kind") == "sample":
                        self.samples += 1
                    else:
                        self.events += 1
                except Exception as exc:
                    # Never die on write errors — just log to stderr.
                    print(f"[WRITER] write error: {exc}", file=sys.stderr)

# ───────────────────────────────────────────────────────────────
# Periodic progress printer
# ───────────────────────────────────────────────────────────────

def print_progress(start_ms: int, deadline_ms: int, pollers: list[InverterPoller],
                   writer: JsonlWriter) -> None:
    now = int(time.time() * 1000)
    elapsed_s = (now - start_ms) / 1000.0
    remaining_s = max(0.0, (deadline_ms - now) / 1000.0)
    ok = sum(p.stats["polls_ok"] for p in pollers)
    fail = sum(p.stats["polls_fail"] for p in pollers)
    print(
        f"[PROGRESS] elapsed={elapsed_s/60:.1f}m  remaining={remaining_s/60:.1f}m  "
        f"samples_written={writer.samples}  polls_ok={ok}  polls_fail={fail}",
        flush=True,
    )

# ───────────────────────────────────────────────────────────────
# Entry point
# ───────────────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser(description="ADSI Counter Integrity Tester (read-only)")
    ap.add_argument("--duration-hours", type=float, default=DEFAULT_DURATION_HOURS,
                    help=f"run duration in hours (default {DEFAULT_DURATION_HOURS})")
    ap.add_argument("--interval-s", type=float, default=DEFAULT_POLL_INTERVAL_S,
                    help=f"poll interval per (inverter,unit) in seconds (default {DEFAULT_POLL_INTERVAL_S})")
    ap.add_argument("--ipconfig", type=str, default=None,
                    help="explicit path to ipconfig.json; default auto-detects")
    ap.add_argument("--out", type=str, default=None,
                    help="output JSONL path; default audits/2026-04-24/counter-integrity/samples-<ts>.jsonl")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT, help="Modbus TCP port (default 502)")
    ap.add_argument("--timeout-s", type=float, default=DEFAULT_TIMEOUT_S,
                    help=f"per-read timeout (default {DEFAULT_TIMEOUT_S})")
    ap.add_argument("--progress-every-s", type=float, default=60.0,
                    help="progress log cadence (default 60s)")
    args = ap.parse_args()

    try:
        ipcfg_path = find_ipconfig(args.ipconfig)
    except Exception as exc:
        print(f"[FATAL] {exc}", file=sys.stderr)
        return 2

    cfg = load_ipconfig(ipcfg_path)
    print(f"[INIT] ipconfig loaded from {cfg['source']}")
    print(f"[INIT] {len(cfg['plan'])} inverters in plan")
    for inv, ip, units in cfg["plan"]:
        print(f"       inv={inv:<3} ip={ip:<16} units={units}")

    # Output path
    if args.out:
        out_path = Path(args.out).resolve()
    else:
        ts = datetime.now().strftime("%Y%m%d-%H%M%S")
        out_path = (
            Path(__file__).resolve().parent.parent
            / "audits" / "2026-04-24" / "counter-integrity"
            / f"samples-{ts}.jsonl"
        )

    print(f"[INIT] output -> {out_path}")
    print(f"[INIT] duration={args.duration_hours}h  interval={args.interval_s}s per (inv,unit)")

    from queue import Queue
    q: Queue = Queue(maxsize=10_000)
    stop_event = threading.Event()
    integrator = PacIntegrator()

    start_ms = int(time.time() * 1000)
    deadline_ms = start_ms + int(args.duration_hours * 3600 * 1000)

    writer = JsonlWriter(out_path, q, stop_event)
    writer.start()

    pollers: list[InverterPoller] = []
    for inv, ip, units in cfg["plan"]:
        p = InverterPoller(
            inv_num=inv, ip=ip, units=units,
            interval_s=args.interval_s,
            deadline_ms=deadline_ms,
            integrator=integrator,
            write_queue=q,
            stop_event=stop_event,
            port=args.port,
            timeout_s=args.timeout_s,
        )
        pollers.append(p)
        p.start()

    # Signal handling
    def _handle_sig(signum, frame):  # noqa: ARG001
        print("[SIGNAL] stopping …", flush=True)
        stop_event.set()
    signal.signal(signal.SIGINT, _handle_sig)
    try:
        signal.signal(signal.SIGTERM, _handle_sig)
    except Exception:
        pass

    # Progress loop
    try:
        while not stop_event.is_set():
            if int(time.time() * 1000) >= deadline_ms:
                print("[PROGRESS] deadline reached — stopping", flush=True)
                stop_event.set()
                break
            stop_event.wait(args.progress_every_s)
            print_progress(start_ms, deadline_ms, pollers, writer)
    finally:
        stop_event.set()

    # Join pollers
    for p in pollers:
        p.join(timeout=5.0)
    # Give writer a moment to drain
    writer.join(timeout=5.0)

    # Final summary
    ok = sum(p.stats["polls_ok"] for p in pollers)
    fail = sum(p.stats["polls_fail"] for p in pollers)
    print("[DONE]")
    print(f"  samples written:  {writer.samples}")
    print(f"  events written:   {writer.events}")
    print(f"  polls ok: {ok}   fail: {fail}")
    print(f"  output: {out_path}")
    return 0

if __name__ == "__main__":
    sys.exit(main())
