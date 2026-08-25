"""
Counter Integrity Analyzer
==========================

Consumes the JSONL produced by tools/counter_integrity_tester.py and produces
a per-(inverter,unit) reliability report for Etotal vs PAC-integration.

Questions answered:
  1. Does Etotal track the parallel PAC-trapezoidal integration?
  2. Is Etotal strictly monotonic per unit?
  3. What is the inverter RTC drift distribution?
  4. Are there units whose word-order / firmware variant looks off?

Usage:
  python tools/counter_integrity_analyze.py <samples.jsonl> [--md <out.md>]
"""

from __future__ import annotations

import argparse
import json
import pathlib
import statistics
import sys
from collections import defaultdict
from datetime import datetime

def load(path: pathlib.Path):
    samples = []
    events = []
    for line in path.open("r", encoding="utf-8"):
        try:
            r = json.loads(line)
        except Exception:
            continue
        kind = r.get("kind")
        if kind == "sample":
            samples.append(r)
        elif kind == "event":
            events.append(r)
    return samples, events

def per_unit(samples):
    by_unit = defaultdict(list)
    for s in samples:
        by_unit[(s["inv"], s["unit"])].append(s)
    for k, arr in by_unit.items():
        arr.sort(key=lambda r: r["ts_ms"])
    return by_unit

def analyze_unit(arr):
    first, last = arr[0], arr[-1]
    dur_s = (last["ts_ms"] - first["ts_ms"]) / 1000.0
    n = len(arr)

    # Etotal deltas
    etotal_vals = [s["etotal_kwh"] for s in arr]
    etotal_start, etotal_end = etotal_vals[0], etotal_vals[-1]
    etotal_delta = etotal_end - etotal_start
    # Monotonicity (count strict decreases)
    decreases = sum(1 for a, b in zip(etotal_vals, etotal_vals[1:]) if b < a)
    # Magnitude of any decrease
    max_decrease = max((a - b for a, b in zip(etotal_vals, etotal_vals[1:]) if b < a), default=0)

    # PAC integration delta
    int_start = arr[0]["kwh_today_integrated"]
    int_end = arr[-1]["kwh_today_integrated"]
    int_delta = int_end - int_start

    # Abs error
    abs_err = abs(int_delta - etotal_delta)
    abs_err_pct = (abs_err / etotal_delta * 100.0) if etotal_delta > 0 else None

    # Mean PAC over window (sanity)
    pac_vals = [s["pac_W"] for s in arr if s.get("pac_W") is not None]
    mean_pac_W = statistics.fmean(pac_vals) if pac_vals else 0.0

    # RTC drift
    drifts = [s["rtc_drift_s"] for s in arr if s.get("rtc_drift_s") is not None]
    if drifts:
        drift_mean = statistics.fmean(drifts)
        drift_stddev = statistics.pstdev(drifts) if len(drifts) > 1 else 0.0
        drift_min = min(drifts)
        drift_max = max(drifts)
    else:
        drift_mean = drift_stddev = drift_min = drift_max = None

    # Word-order sniff — Ingeteam Etotal word-high first; r0 should be "small"
    # (hundreds/low thousands for kWh in low GWh range), r1 spans u16.
    r0_vals = [s["etotal_r0"] for s in arr]
    r1_vals = [s["etotal_r1"] for s in arr]
    r0_max = max(r0_vals)
    r0_mean = statistics.fmean(r0_vals)
    # Heuristic: a healthy PowerMax node in a multi-year plant has r0 in ~40-70
    # (Etotal ~2.6-4.6 million kWh = 0x28xxxx-0x46xxxx → high word 40-70).
    # If r0 > 200 or r0 swings a lot, flag as suspect.
    r0_suspicious = r0_max > 200 or (max(r0_vals) - min(r0_vals)) > 2

    # Etotal gap (Wh) vs PAC integration (Wh)
    # Convert etotal kWh → Wh to compare same units.
    etotal_delta_wh = etotal_delta * 1000.0
    int_delta_wh = int_delta * 1000.0
    # Ratio (integrated / etotal)
    ratio = (int_delta_wh / etotal_delta_wh) if etotal_delta_wh > 0 else None

    return {
        "n": n,
        "dur_s": dur_s,
        "etotal_start": etotal_start,
        "etotal_end": etotal_end,
        "etotal_delta_kwh": etotal_delta,
        "etotal_decreases": decreases,
        "etotal_max_decrease_kwh": max_decrease,
        "integrated_start_kwh": int_start,
        "integrated_end_kwh": int_end,
        "integrated_delta_kwh": int_delta,
        "abs_err_kwh": abs_err,
        "abs_err_pct": abs_err_pct,
        "ratio_int_over_etotal": ratio,
        "mean_pac_W": mean_pac_W,
        "drift_mean_s": drift_mean,
        "drift_stddev_s": drift_stddev,
        "drift_min_s": drift_min,
        "drift_max_s": drift_max,
        "r0_mean": r0_mean,
        "r0_max": r0_max,
        "r0_suspicious": r0_suspicious,
    }

def fmt(v, spec=""):
    if v is None:
        return "-"
    try:
        return f"{v:{spec}}"
    except Exception:
        return str(v)

def build_report(samples, events):
    by_unit = per_unit(samples)
    rows = []
    for k in sorted(by_unit.keys()):
        res = analyze_unit(by_unit[k])
        rows.append((k, res))

    out = []
    out.append("# Counter Integrity — PAC vs Etotal Analysis")
    out.append("")
    if samples:
        t0 = datetime.fromtimestamp(samples[0]["ts_ms"] / 1000)
        t1 = datetime.fromtimestamp(samples[-1]["ts_ms"] / 1000)
        out.append(f"- Window: {t0.strftime('%Y-%m-%d %H:%M:%S')} → {t1.strftime('%H:%M:%S')} "
                   f"({(t1 - t0).total_seconds() / 60:.1f} min)")
    out.append(f"- Samples: {len(samples)}")
    out.append(f"- Events (read failures / reconnects): {len(events)}")
    out.append(f"- Units: {len(rows)}")
    out.append("")

    # ============================================================
    # SECTION 1: Etotal vs PAC-integrated reliability table
    # ============================================================
    out.append("## 1. Etotal vs PAC-integrated delta (over run window)")
    out.append("")
    out.append("| inv/u | samples | mean_pac_kW | Δetotal (kWh) | Δintegrated (kWh) | |err| (kWh) | err% | ratio | monotonic |")
    out.append("|---|---|---|---|---|---|---|---|---|")
    bad_reliability = []
    for (inv, unit), r in rows:
        flag = ""
        if r["etotal_decreases"] > 0:
            flag = "**DEC**"
        elif r["abs_err_pct"] is not None and r["abs_err_pct"] > 5:
            flag = "**>5%**"
            bad_reliability.append((inv, unit, r))
        elif r["abs_err_pct"] is not None and r["abs_err_pct"] > 2:
            flag = "(>2%)"
        mono = "OK" if r["etotal_decreases"] == 0 else f"DEC×{r['etotal_decreases']} (max -{r['etotal_max_decrease_kwh']} kWh)"
        out.append(
            f"| {inv}/{unit} | {r['n']} | {r['mean_pac_W']/1000:.1f} | "
            f"{r['etotal_delta_kwh']} | "
            f"{fmt(r['integrated_delta_kwh'], '.3f')} | "
            f"{fmt(r['abs_err_kwh'], '.3f')} | "
            f"{fmt(r['abs_err_pct'], '.2f')} | "
            f"{fmt(r['ratio_int_over_etotal'], '.3f')} | {mono} {flag} |"
        )
    out.append("")

    # ============================================================
    # SECTION 2: RTC drift summary
    # ============================================================
    out.append("## 2. Inverter RTC drift")
    out.append("")
    out.append("| inv/u | mean_drift_s | stddev_s | min_s | max_s | range_s | verdict |")
    out.append("|---|---|---|---|---|---|---|")
    big_drift = []
    for (inv, unit), r in rows:
        if r["drift_mean_s"] is None:
            out.append(f"| {inv}/{unit} | - | - | - | - | - | no_rtc |")
            continue
        rng = r["drift_max_s"] - r["drift_min_s"]
        verdict = "OK"
        if abs(r["drift_mean_s"]) > 31_536_000:  # >1 year offset
            verdict = "**RTC_BROKEN**"
            big_drift.append((inv, unit, r))
        elif abs(r["drift_mean_s"]) > 300:
            verdict = "**>5min**"
            big_drift.append((inv, unit, r))
        elif abs(r["drift_mean_s"]) > 60:
            verdict = "(>1min)"
        out.append(
            f"| {inv}/{unit} | {r['drift_mean_s']:+.1f} | {r['drift_stddev_s']:.2f} | "
            f"{r['drift_min_s']:+.1f} | {r['drift_max_s']:+.1f} | {rng:.1f} | {verdict} |"
        )
    out.append("")

    # ============================================================
    # SECTION 3: Word-order / firmware-variant audit
    # ============================================================
    out.append("## 3. Etotal register word pattern audit")
    out.append("")
    out.append("Healthy pattern: r0 (high word) ~40-70, stable, much smaller than r1 (low word).")
    out.append("Anomalies indicate word-swap, firmware variant, or broken counter.")
    out.append("")
    out.append("| inv/u | r0_mean | r0_max | flag |")
    out.append("|---|---|---|---|")
    suspicious = []
    for (inv, unit), r in rows:
        if r["r0_suspicious"]:
            suspicious.append((inv, unit, r))
            flag = "**SUSPECT**"
        else:
            flag = "ok"
        out.append(f"| {inv}/{unit} | {r['r0_mean']:.1f} | {r['r0_max']} | {flag} |")
    out.append("")

    # ============================================================
    # SECTION 4: Top-level summary
    # ============================================================
    out.append("## 4. Summary")
    out.append("")
    out.append(f"- Units with |PAC − Etotal| error > 5% over window: **{len(bad_reliability)}**")
    for inv, unit, r in bad_reliability[:10]:
        out.append(f"  - {inv}/{unit}: err%={r['abs_err_pct']:.2f}  Δetotal={r['etotal_delta_kwh']}kWh  Δint={r['integrated_delta_kwh']:.3f}kWh")
    out.append(f"- Units with any Etotal decrease: **{sum(1 for _, r in rows if r['etotal_decreases'] > 0)}**")
    for (inv, unit), r in rows:
        if r["etotal_decreases"] > 0:
            out.append(f"  - {inv}/{unit}: {r['etotal_decreases']} decrease(s), max -{r['etotal_max_decrease_kwh']} kWh")
    out.append(f"- Units with RTC drift > 5 min (or broken): **{len(big_drift)}**")
    for inv, unit, r in big_drift[:10]:
        out.append(f"  - {inv}/{unit}: mean_drift={r['drift_mean_s']:+.1f}s  stddev={r['drift_stddev_s']:.1f}s")
    out.append(f"- Units with suspect r0 pattern: **{len(suspicious)}**")
    for inv, unit, r in suspicious[:10]:
        out.append(f"  - {inv}/{unit}: r0_mean={r['r0_mean']:.1f} r0_max={r['r0_max']}")
    out.append("")

    return "\n".join(out), rows

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("jsonl", type=str)
    ap.add_argument("--md", type=str, default=None)
    args = ap.parse_args()

    path = pathlib.Path(args.jsonl).resolve()
    if not path.is_file():
        print(f"not a file: {path}", file=sys.stderr)
        return 2

    samples, events = load(path)
    print(f"[LOAD] {len(samples)} samples, {len(events)} events from {path}")
    report, rows = build_report(samples, events)

    if args.md:
        out_path = pathlib.Path(args.md).resolve()
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(report, encoding="utf-8")
        print(f"[OUT] wrote markdown report to {out_path}")
    else:
        print(report)
    return 0

if __name__ == "__main__":
    sys.exit(main())
