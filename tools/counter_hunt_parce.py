"""
Hunt for parcE / Etotal register locations empirically.

For every UInt32 register pair across offsets 0..78 (both hi-lo and lo-hi byte
order), check if the value behaves like a counter whose delta tracks PAC
integration. Produces a ranked table of candidate offsets per unit + cross-unit
consensus.

Usage:
  python tools/counter_hunt_parce.py <scan.jsonl>
"""

from __future__ import annotations

import json
import statistics
import sys
from collections import defaultdict
from pathlib import Path

def u32_hi_lo(a, b):
    if a is None or b is None: return None
    return ((int(a) & 0xFFFF) << 16) | (int(b) & 0xFFFF)

def u32_lo_hi(a, b):
    if a is None or b is None: return None
    return ((int(b) & 0xFFFF) << 16) | (int(a) & 0xFFFF)

def main():
    if len(sys.argv) < 2:
        print("usage: counter_hunt_parce.py <scan.jsonl>", file=sys.stderr)
        return 2
    path = Path(sys.argv[1]).resolve()
    if not path.is_file():
        print(f"not a file: {path}", file=sys.stderr); return 2

    by_unit = defaultdict(list)
    for line in path.open("r", encoding="utf-8"):
        try: r = json.loads(line)
        except Exception: continue
        if r.get("kind") != "scan": continue
        by_unit[(r["inv"], r["unit"])].append(r)
    for k in by_unit: by_unit[k].sort(key=lambda r: r["ts_ms"])

    print(f"[LOAD] {sum(len(v) for v in by_unit.values())} scans across {len(by_unit)} units")

    # For each (inv,unit), over the whole window:
    #   - compute PAC_integrated_kWh using production semantics (dt cap 30s,
    #     pac_reg × 10 → W, vdc·idc zero-guard)
    #   - for each offset 0..78, try BOTH hi-lo and lo-hi decode and track
    #       * is_monotonic (allowing equal)
    #       * delta_raw
    #       * ratio = delta_raw / pac_int_wh  (expected ~1 for Wh-units, ~0.001 for kWh, ~10 for 0.1Wh)
    #   - keep candidates whose ratio is in a plausible band

    def integrate_pac(rows):
        # rows sorted by ts
        total_wh = 0.0
        last_ts = None
        last_pac_w = 0.0
        for r in rows:
            regs = r["regs"]
            def g(i):
                v = regs[i] if i < len(regs) else None
                return 0 if v is None else int(v)
            vdc = g(8); idc = g(9); pac_reg = g(18)
            pac_w = 0.0 if (vdc == 0 or idc == 0) else min(pac_reg * 10.0, 260_000.0)
            ts = r["ts_ms"]
            if last_ts is None:
                last_ts, last_pac_w = ts, pac_w
                continue
            dt_s = max(0.0, min((ts - last_ts) / 1000.0, 30.0))
            if dt_s > 0 and pac_w >= 0:
                total_wh += (last_pac_w + pac_w) / 2.0 * dt_s / 3600.0
            last_ts, last_pac_w = ts, pac_w
        return total_wh

    # Consensus accumulator: offset+order -> list of (inv,unit, ratio, monotonic_ok)
    consensus_hilo = defaultdict(list)
    consensus_lohi = defaultdict(list)

    per_unit_top = {}

    for (inv, unit), rows in by_unit.items():
        if len(rows) < 5: continue
        pac_int_wh = integrate_pac(rows)
        if pac_int_wh <= 0: continue

        best_candidates = []

        for order in ("hi_lo", "lo_hi"):
            decoder = u32_hi_lo if order == "hi_lo" else u32_lo_hi
            target = consensus_hilo if order == "hi_lo" else consensus_lohi
            for off in range(0, 78):
                vals = []
                ok = True
                for r in rows:
                    regs = r["regs"]
                    if off + 1 >= len(regs):
                        ok = False; break
                    a = regs[off]; b = regs[off + 1]
                    if a is None or b is None:
                        ok = False; break
                    v = decoder(a, b)
                    vals.append(v)
                if not ok or len(vals) < 5: continue

                # Skip trivially tiny values with zero growth
                delta = vals[-1] - vals[0]
                if delta <= 0: continue

                # Monotonic (non-decreasing)
                decreases = sum(1 for a, b in zip(vals, vals[1:]) if b < a)

                # Plausibility: ratio of raw delta to pac_int_wh
                # Candidates:
                #   1.0 → counter is in Wh
                #   0.001 → counter is in kWh
                #   10.0 → counter is in 0.1 Wh
                ratio = delta / pac_int_wh
                band = None
                if 0.85 <= ratio <= 1.15:     band = "Wh"
                elif 0.00085 <= ratio <= 0.00115: band = "kWh"
                elif 8.5 <= ratio <= 11.5:    band = "0.1Wh"
                elif 85 <= ratio <= 115:      band = "0.01Wh"
                if band is None: continue

                # To reduce noise, demand ≥95% monotonic
                mono_pct = 1.0 - decreases / max(1, len(vals) - 1)
                if mono_pct < 0.95: continue

                best_candidates.append((off, order, band, ratio, delta, decreases, vals[0], vals[-1]))
                target[(off, band)].append((inv, unit, ratio))

        best_candidates.sort(key=lambda t: (t[2] != "kWh", abs({"Wh":1.0,"kWh":0.001,"0.1Wh":10.0,"0.01Wh":100.0}[t[2]] - t[3])))
        per_unit_top[(inv, unit)] = {
            "pac_int_wh": pac_int_wh,
            "candidates": best_candidates,
        }

    # Cross-unit consensus — offsets that appear as candidates on MANY units
    print()
    print("=" * 72)
    print(" CROSS-UNIT CONSENSUS — which offsets look like counters on MOST units")
    print("=" * 72)

    all_cons = []
    for (off, band), lst in consensus_hilo.items():
        all_cons.append(("hi_lo", off, band, lst))
    for (off, band), lst in consensus_lohi.items():
        all_cons.append(("lo_hi", off, band, lst))
    all_cons.sort(key=lambda x: -len(x[3]))
    print(f"{'order':<6} {'offset':<7} {'band':<8} {'units':<7} {'ratio_median':<14} {'ratio_stddev':<14}")
    for order, off, band, lst in all_cons[:40]:
        ratios = [r[2] for r in lst]
        med = statistics.median(ratios) if ratios else 0
        sd = statistics.pstdev(ratios) if len(ratios) > 1 else 0
        print(f"{order:<6} {off:<7} {band:<8} {len(lst):<7} {med:<14.6f} {sd:<14.6f}")

    # Per-unit examples
    print()
    print("=" * 72)
    print(" PER-UNIT TOP CANDIDATES (first 10 units)")
    print("=" * 72)
    for (inv, unit), info in list(per_unit_top.items())[:10]:
        print(f"\ninv={inv}/u{unit}   PAC-integrated={info['pac_int_wh']:.1f} Wh")
        for off, order, band, ratio, delta, dec, first, last in info["candidates"][:6]:
            print(f"   off={off:<3} order={order:<5} band={band:<7} ratio={ratio:<10.6f} delta={delta:<12} dec={dec:<3} first={first} last={last}")

    return 0

if __name__ == "__main__":
    sys.exit(main())
