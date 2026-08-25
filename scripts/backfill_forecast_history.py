import argparse
import os
import sys
from datetime import date, datetime, time, timedelta, timezone

# Add parent dir to path so we can import services
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from services.forecast_engine import APP_DB_FILE, _open_sqlite, forecast_qa

def _epoch_ms_noon_utc(day_value: date) -> int:
    dt = datetime.combine(day_value, time(12, 0), tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)

def _ensure_learning_audit_rows(days_to_backfill: int, dry_run: bool) -> None:
    today = date.today()
    with _open_sqlite(APP_DB_FILE, 10.0) as conn:
        for d in range(1, days_to_backfill + 1):
            target_date = today - timedelta(days=d)
            target_str = target_date.isoformat()

            row = conn.execute(
                """
                SELECT id
                  FROM forecast_run_audit
                 WHERE target_date = ?
                   AND is_authoritative_learning = 1
                 ORDER BY generated_ts DESC
                 LIMIT 1
                """,
                (target_str,),
            ).fetchone()

            if row:
                continue

            generated_ts = _epoch_ms_noon_utc(target_date)
            if dry_run:
                print(f"[dry-run] Would insert learning audit row for {target_str}")
                continue

            print(f"Inserting learning audit row for {target_str}")
            conn.execute(
                """
                INSERT INTO forecast_run_audit (
                    target_date, generated_ts, generator_mode, provider_used, provider_expected,
                    forecast_variant, weather_source,
                    run_status, solcast_freshness_class,
                    is_authoritative_runtime, is_authoritative_learning,
                    notes_json
                ) VALUES (?, ?, 'learning_backfill', 'ml_local', 'ml_local',
                          'ml_without_solcast', 'backfill',
                          'success', 'not_expected',
                          0, 1,
                          ?)
                """,
                (
                    target_str,
                    generated_ts,
                    '{"source":"scripts/backfill_forecast_history.py","reason":"missing_learning_audit"}',
                ),
            )
        if not dry_run:
            conn.commit()

def _run_qa_backfill(days_to_backfill: int, dry_run: bool) -> None:
    if dry_run:
        print("[dry-run] Skipping forecast_qa execution.")
        return

    today = date.today()
    for d in range(1, days_to_backfill + 1):
        target_date = today - timedelta(days=d)
        target_str = target_date.isoformat()

        # forecast_qa(today_ref) evaluates today_ref - 1 day.
        qa_input_date = target_date + timedelta(days=1)
        print(f"Running forecast_qa to evaluate {target_str} ...")
        try:
            forecast_qa(qa_input_date)
        except Exception as e:
            print(f"Error evaluating {target_str}: {e}")

def _print_latest_comparison(limit: int = 5) -> None:
    print("\nLatest forecast_error_compare_daily rows:")
    with _open_sqlite(APP_DB_FILE, 10.0, readonly=True) as conn:
        rows = conn.execute(
            """
            SELECT target_date, provider_used, forecast_variant,
                   total_forecast_kwh, total_actual_kwh, daily_wape_pct
              FROM forecast_error_compare_daily
             ORDER BY target_date DESC
             LIMIT ?
            """,
            (int(limit),),
        ).fetchall()

    if not rows:
        print("  (none)")
        return

    for r in rows:
        fc = 0.0 if r[3] is None else float(r[3])
        act = 0.0 if r[4] is None else float(r[4])
        wape = 0.0 if r[5] is None else float(r[5])
        print(
            f"  {r[0]} | provider={str(r[1] or ''):<10} "
            f"| variant={str(r[2] or ''):<22} | FC={fc:.1f} | ACT={act:.1f} | WAPE={wape:.1f}%"
        )

def main() -> int:
    parser = argparse.ArgumentParser(
        description="Backfill forecast comparison history by creating missing learning audit rows and rerunning forecast_qa."
    )
    parser.add_argument("--days", type=int, default=14, help="Number of past days to backfill (default: 14)")
    parser.add_argument("--dry-run", action="store_true", help="Show actions without writing DB rows or running QA")
    args = parser.parse_args()

    days_to_backfill = max(1, int(args.days))
    print(f"Backfilling forecast comparison history for the last {days_to_backfill} days...")
    _ensure_learning_audit_rows(days_to_backfill, bool(args.dry_run))
    _run_qa_backfill(days_to_backfill, bool(args.dry_run))
    _print_latest_comparison(5)
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
