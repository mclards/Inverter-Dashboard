"""
Wide-window register probe (READ-ONLY).

Reads registers 0..79 raw for a short window (default 5 min) across every
inverter/unit. Produces a JSONL of raw u16 arrays so we can offline-hunt for
counters that behave like parcE / parcH / parcC (monotonic, proportional to
pac_W * dt).

Usage:
  python tools/counter_wide_scan.py                  # 5 min, 5 s interval
  python tools/counter_wide_scan.py --duration-min 3
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from queue import Queue
from typing import Optional

from pymodbus.client.sync import ModbusTcpClient

def find_ipconfig(p: Optional[str]):
    if p:
        return Path(p).expanduser().resolve()
    for c in [
        Path(__file__).resolve().parent.parent / "ipconfig.json",
        Path(os.environ.get("PROGRAMDATA", "C:/ProgramData")) / "InverterDashboard" / "ipconfig.json",
    ]:
        if c.is_file():
            return c
    raise FileNotFoundError("ipconfig.json not found")

def load_plan(path: Path):
    d = json.loads(path.read_text("utf-8"))
    invs = d.get("inverters", {})
    units = d.get("units", {})
    plan = []
    for k, ip in invs.items():
        try:
            n = int(k)
        except Exception:
            continue
        u = units.get(k) or units.get(str(n)) or [1, 2, 3, 4]
        u = [int(x) for x in u if int(x) > 0]
        plan.append((n, str(ip), u))
    plan.sort()
    return plan

class Poller(threading.Thread):
    def __init__(self, inv, ip, units, interval, deadline, q, stop):
        super().__init__(daemon=True, name=f"poll-inv{inv}")
        self.inv, self.ip, self.units = inv, ip, units
        self.interval = interval
        self.deadline = deadline
        self.q = q
        self.stop = stop
        self.ok = 0
        self.fail = 0

    def _connect(self):
        try:
            c = ModbusTcpClient(host=self.ip, port=502, timeout=1.5, retry_on_empty=False)
            c.connect()
            return c
        except Exception:
            return None

    def _read(self, c, addr, count, unit):
        try:
            r = c.read_input_registers(address=addr, count=count, unit=unit)
            if r and not r.isError():
                return list(r.registers)
        except Exception:
            try: c.close()
            except Exception: pass
            try: c.connect()
            except Exception: return None
            try:
                r = c.read_input_registers(address=addr, count=count, unit=unit)
                if r and not r.isError():
                    return list(r.registers)
            except Exception:
                return None
        return None

    def run(self):
        c = self._connect()
        tick = time.monotonic()
        while not self.stop.is_set():
            if int(time.time() * 1000) >= self.deadline:
                break
            if c is None:
                c = self._connect()
                if c is None:
                    if self.stop.wait(1.0): break
                    continue
            for u in self.units:
                if self.stop.is_set(): break
                low  = self._read(c, 0,  40, u)
                high = self._read(c, 40, 40, u)
                if low is None:
                    self.fail += 1
                    continue
                self.ok += 1
                now_ms = int(time.time() * 1000)
                regs = low + (high or [None] * 40)
                self.q.put({
                    "kind": "scan",
                    "ts_ms": now_ms,
                    "inv": self.inv,
                    "unit": u,
                    "regs": regs,
                })
            tick += self.interval
            wait = max(0, tick - time.monotonic())
            if wait and self.stop.wait(wait): break
            if wait == 0: tick = time.monotonic()
        try: c.close()
        except Exception: pass

class Writer(threading.Thread):
    def __init__(self, path, q, stop):
        super().__init__(daemon=True)
        self.path, self.q, self.stop = path, q, stop
        self.n = 0

    def run(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", encoding="utf-8") as f:
            f.write(json.dumps({"kind": "start", "ts_ms": int(time.time()*1000)}) + "\n"); f.flush()
            while not (self.stop.is_set() and self.q.empty()):
                try: r = self.q.get(timeout=0.5)
                except Exception: continue
                f.write(json.dumps(r, separators=(",",":")) + "\n"); f.flush()
                if r.get("kind") == "scan": self.n += 1

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--duration-min", type=float, default=5.0)
    ap.add_argument("--interval-s", type=float, default=5.0)
    ap.add_argument("--out", type=str, default=None)
    args = ap.parse_args()

    path = find_ipconfig(None)
    plan = load_plan(path)
    print(f"[INIT] ipconfig={path}  units={sum(len(u) for _,_,u in plan)}")

    if args.out:
        out = Path(args.out).resolve()
    else:
        ts = datetime.now().strftime("%Y%m%d-%H%M%S")
        out = Path(__file__).resolve().parent.parent / "audits" / "2026-04-24" / "counter-integrity" / f"scan-{ts}.jsonl"
    print(f"[INIT] out={out}  duration={args.duration_min}m")

    q = Queue(maxsize=20000)
    stop = threading.Event()
    start_ms = int(time.time() * 1000)
    deadline = start_ms + int(args.duration_min * 60_000)

    w = Writer(out, q, stop); w.start()
    ps = []
    for inv, ip, units in plan:
        p = Poller(inv, ip, units, args.interval_s, deadline, q, stop); p.start(); ps.append(p)

    def sig(s, f): stop.set()
    signal.signal(signal.SIGINT, sig)
    try: signal.signal(signal.SIGTERM, sig)
    except Exception: pass

    try:
        while not stop.is_set():
            if int(time.time()*1000) >= deadline: stop.set(); break
            stop.wait(30)
            ok = sum(p.ok for p in ps); fail = sum(p.fail for p in ps)
            elapsed = (int(time.time()*1000) - start_ms)/1000
            remaining = max(0, (deadline - int(time.time()*1000))/1000)
            print(f"[PROGRESS] elapsed={elapsed:.0f}s  remaining={remaining:.0f}s  ok={ok} fail={fail} samples={w.n}", flush=True)
    finally:
        stop.set()

    for p in ps: p.join(5)
    w.join(5)
    ok = sum(p.ok for p in ps); fail = sum(p.fail for p in ps)
    print(f"[DONE] samples={w.n} ok={ok} fail={fail} out={out}")
    return 0

if __name__ == "__main__":
    sys.exit(main())
