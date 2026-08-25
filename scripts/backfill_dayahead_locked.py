"""Backfill solcast_dayahead_locked from an old DB snapshot (v2.8+).

Uses the April 3 backup (`adsi_backup_1.db`) as source. For each forecast_day
in the backup where forecast_mw is populated (i.e., tri-band day-ahead data),
inserts rows into the LIVE adsi.db's solcast_dayahead_locked table with
capture_reason='backfill_approx'.

Important honesty constraint: these rows are NOT real 10 AM locked snapshots.
They represent Solcast's state at the time the backup was captured (Apr 3 ~22:37).
Downstream consumers (error memory, ML training) should treat them as lower-weight
approximations — the dashboard's Python compute_error_memory() and the ML feature
builder will apply a 0.3x weight to rows with capture_reason='backfill_approx'.

Filters:
  - forecast_mw IS NOT NULL (must be a real forecast, not est_actual-only)
  - forecast_day >= cutoff (default: day after backup capture, to avoid
    backfilling data that was already historical from the backup's perspective)

Usage:
  python scripts/backfill_dayahead_locked.py --dry-run
  python scripts/backfill_dayahead_locked.py --apply
  python scripts/backfill_dayahead_locked.py --apply --source path/to/other.db
"""
import argparse
import os
import sqlite3
import sys
import time
from datetime import datetime, timedelta

LIVE_DB = r"C:\ProgramData\InverterDashboard\db\adsi.db"
DEFAULT_SOURCE_DB = r"C:\ProgramData\InverterDashboard\db\backups\adsi_backup_1.db"

# Plant capacity fallback if settings query fails (matches computePlantMaxKwFromConfig default)
FALLBACK_PLANT_CAP_MW = 26.94  # 108 nodes × 249.41 kW (Ingeteam template Pmax per stage) / 1000

def read_plant_cap_mw(db_path: str) -> float:
    """Read plant capacity from live settings. Fall back to 26.94 MW if unavailable."""
    try:
        uri = f"file:{db_path}?mode=ro"
        conn = sqlite3.connect(uri, uri=True, timeout=5.0)
        try:
            # Node computes this from ipconfig node count × 249.41 kW (Ingeteam Pmax).
            # We don't have that logic in Python, so we read a hint if available.
            row = conn.execute(
                "SELECT value FROM settings WHERE key = 'plantMaxKwMw'"
            ).fetchone()
            if row and row[0]:
                v = float(row[0])
                if v > 0:
                    return v
        finally:
            conn.close()
    except Exception as e:
        print(f"  warn: could not read plant cap from settings: {e}")
    return FALLBACK_PLANT_CAP_MW

def compute_spread_pct_cap(p10, p90, plant_cap_mw):
    if p10 is None or p90 is None:
        return None
    if plant_cap_mw is None or plant_cap_mw <= 0:
        return None
    return ((p90 - p10) / plant_cap_mw) * 100.0

def format_local_ts(ts_ms: int) -> str:
    try:
        dt = datetime.fromtimestamp(ts_ms / 1000.0)
        return dt.strftime("%Y-%m-%dT%H:%M:%S")
    except Exception:
        return ""

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", default=DEFAULT_SOURCE_DB, help="Path to source backup DB")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be inserted without writing")
    parser.add_argument("--apply", action="store_true", help="Actually insert rows")
    parser.add_argument(
        "--cutoff",
        default=None,
        help="Only backfill forecast_day >= this YYYY-MM-DD. Default: day after backup mtime.",
    )
    args = parser.parse_args()

    if not args.dry_run and not args.apply:
        print("Must specify --dry-run or --apply")
        return 2
    if args.dry_run and args.apply:
        print("--dry-run and --apply are mutually exclusive")
        return 2

    print("=" * 72)
    print("Solcast Day-Ahead Locked Backfill")
    print("=" * 72)

    if not os.path.isfile(args.source):
        print(f"ERROR: source DB not found: {args.source}")
        return 3
    if not os.path.isfile(LIVE_DB):
        print(f"ERROR: live DB not found: {LIVE_DB}")
        return 3

    # Backup capture timestamp = file mtime (best approximation available).
    backup_mtime = int(os.path.getmtime(args.source) * 1000)
    backup_captured_local = format_local_ts(backup_mtime)
    print(f"source     : {args.source}")
    print(f"live       : {LIVE_DB}")
    print(f"backup mtime: {backup_captured_local} ({backup_mtime})")

    # Default cutoff = day after backup mtime.
    if args.cutoff:
        cutoff = args.cutoff
    else:
        backup_dt = datetime.fromtimestamp(backup_mtime / 1000.0)
        cutoff = (backup_dt + timedelta(days=1)).strftime("%Y-%m-%d")
    print(f"cutoff     : {cutoff} (only forecast_day >= this)")

    # Read plant cap from live settings (for spread normalization)
    plant_cap_mw = read_plant_cap_mw(LIVE_DB)
    print(f"plant cap  : {plant_cap_mw} MW")

    # Read source rows
    print()
    print("-" * 72)
    print("Reading source rows...")
    src_uri = f"file:{args.source}?mode=ro"
    src_conn = sqlite3.connect(src_uri, uri=True, timeout=5.0)
    src_conn.row_factory = sqlite3.Row
    try:
        rows = src_conn.execute(
            """
            SELECT forecast_day, slot, ts_local, period_end_utc, period,
                   forecast_mw, forecast_lo_mw, forecast_hi_mw,
                   forecast_kwh, forecast_lo_kwh, forecast_hi_kwh,
                   source
              FROM solcast_snapshots
             WHERE forecast_mw IS NOT NULL
               AND forecast_lo_mw IS NOT NULL
               AND forecast_hi_mw IS NOT NULL
               AND forecast_day >= ?
             ORDER BY forecast_day, slot
            """,
            (cutoff,),
        ).fetchall()
    finally:
        src_conn.close()

    print(f"source rows (forecast_day >= {cutoff}, tri-band present): {len(rows)}")
    if not rows:
        print("Nothing to backfill.")
        return 0

    # Group by forecast_day for reporting
    by_day = {}
    for r in rows:
        by_day.setdefault(r["forecast_day"], []).append(r)
    print(f"forecast days: {sorted(by_day.keys())}")

    # Check live DB: which of these days are already locked? We skip those.
    print()
    print("-" * 72)
    print("Checking live DB for already-locked days...")
    live_uri = f"file:{LIVE_DB}?mode=ro"
    live_conn_ro = sqlite3.connect(live_uri, uri=True, timeout=5.0)
    try:
        days_to_check = list(by_day.keys())
        placeholders = ",".join("?" * len(days_to_check))
        existing = live_conn_ro.execute(
            f"""
            SELECT forecast_day, COUNT(*) AS n, MIN(capture_reason) AS reason
              FROM solcast_dayahead_locked
             WHERE forecast_day IN ({placeholders})
             GROUP BY forecast_day
            """,
            days_to_check,
        ).fetchall()
    finally:
        live_conn_ro.close()

    already_locked = {r[0]: (r[1], r[2]) for r in existing}
    for day, (n, reason) in already_locked.items():
        print(f"  SKIP {day}: already has {n} row(s) (reason={reason})")

    insertable_rows = [r for r in rows if r["forecast_day"] not in already_locked]
    print(f"insertable rows after skipping existing: {len(insertable_rows)}")
    if not insertable_rows:
        print("Nothing new to insert.")
        return 0

    # Print per-day summary
    print()
    print("-" * 72)
    print("Per-day summary (insertable):")
    by_day_ins = {}
    for r in insertable_rows:
        by_day_ins.setdefault(r["forecast_day"], []).append(r)
    for day in sorted(by_day_ins.keys()):
        drows = by_day_ins[day]
        spreads = []
        for r in drows:
            s = compute_spread_pct_cap(r["forecast_lo_mw"], r["forecast_hi_mw"], plant_cap_mw)
            if s is not None:
                spreads.append(s)
        spread_avg = sum(spreads) / len(spreads) if spreads else None
        spread_max = max(spreads) if spreads else None
        p50_total = sum((r["forecast_kwh"] or 0) for r in drows)
        print(
            f"  {day}: {len(drows):3d} slots, "
            f"p50_total_kwh={p50_total:.1f}, "
            f"spread_avg={f'{spread_avg:.1f}%' if spread_avg is not None else 'n/a'}, "
            f"spread_max={f'{spread_max:.1f}%' if spread_max is not None else 'n/a'}"
        )

    if args.dry_run:
        print()
        print("DRY RUN — no writes performed. Re-run with --apply to commit.")
        return 0

    # ---------- APPLY ----------
    print()
    print("-" * 72)
    print(f"APPLYING backfill: {len(insertable_rows)} rows into live DB...")

    live_conn = sqlite3.connect(LIVE_DB, timeout=15.0)
    live_conn.execute("PRAGMA busy_timeout = 15000")
    inserted = 0
    try:
        cur = live_conn.cursor()
        cur.execute("BEGIN IMMEDIATE")
        for r in insertable_rows:
            p10 = r["forecast_lo_mw"]
            p90 = r["forecast_hi_mw"]
            spread_mw = (p90 - p10) if (p10 is not None and p90 is not None) else None
            spread_pct_cap = compute_spread_pct_cap(p10, p90, plant_cap_mw)
            cur.execute(
                """
                INSERT OR IGNORE INTO solcast_dayahead_locked(
                  forecast_day, slot, ts_local, period_end_utc, period,
                  p50_mw, p10_mw, p90_mw, p50_kwh, p10_kwh, p90_kwh,
                  spread_mw, spread_pct_cap,
                  captured_ts, captured_local, capture_reason, solcast_source, plant_cap_mw
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    r["forecast_day"],
                    r["slot"],
                    r["ts_local"],
                    r["period_end_utc"],
                    r["period"],
                    r["forecast_mw"],
                    p10,
                    p90,
                    r["forecast_kwh"],
                    r["forecast_lo_kwh"],
                    r["forecast_hi_kwh"],
                    spread_mw,
                    spread_pct_cap,
                    backup_mtime,
                    backup_captured_local,
                    "backfill_approx",
                    r["source"] or "toolkit",
                    plant_cap_mw,
                ),
            )
            inserted += cur.rowcount if cur.rowcount > 0 else 0
        live_conn.commit()
    except Exception as e:
        live_conn.rollback()
        print(f"ERROR during apply: {e}")
        return 4
    finally:
        live_conn.close()

    print(f"Inserted: {inserted} rows")
    print()
    print("Backfill complete.")
    print("NOTE: rows labeled capture_reason='backfill_approx' should be weighted")
    print("      at 0.3x in the error memory learning loop (see Step 11 spec).")
    return 0

if __name__ == "__main__":
    sys.exit(main())
