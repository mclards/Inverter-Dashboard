#!/usr/bin/env python3
"""
Forecast ML & Day-Ahead Integrity Evaluation Runner
Evaluates forecast ML training state, model bundle integrity, QA comparison metrics,
Solcast freshness, and forecast variant distributions.

Usage:
  python evals/run_forecast_eval.py [--db PATH] [--state PATH] [--bundle PATH]
"""
import sqlite3
import json
import hashlib
import pathlib
import argparse
import sys
import os
from datetime import datetime, timedelta, timezone

FAIL_COUNT = 0
WARN_COUNT = 0


def check(name, cond, detail="", is_warn=False):
    global FAIL_COUNT, WARN_COUNT
    if cond:
        status = "PASS"
    elif is_warn:
        status = "WARN"
        WARN_COUNT += 1
    else:
        status = "FAIL"
        FAIL_COUNT += 1
    msg = f"  [{status}] {name}"
    if detail:
        msg += f" — {detail}"
    print(msg)
    return cond


def default_paths():
    """Discover default paths based on operating system and environment."""
    if sys.platform == "win32":
        base_dir = pathlib.Path(r"C:\ProgramData\Inverter-Dashboard")
        db_path = base_dir / "db" / "adsi.db"
        state_path = base_dir / "forecast" / "ml_train_state.json"
        bundle_path = base_dir / "forecast" / "pv_dayahead_model_bundle.joblib"
    else:
        base_dir = pathlib.Path("/var/lib/inverter-dashboard")
        db_path = base_dir / "db" / "adsi.db"
        state_path = base_dir / "forecast" / "ml_train_state.json"
        bundle_path = base_dir / "forecast" / "pv_dayahead_model_bundle.joblib"
    return str(db_path), str(state_path), str(bundle_path)


def main():
    def_db, def_state, def_bundle = default_paths()
    ap = argparse.ArgumentParser(description="Forecast ML & Day-Ahead Integrity Evaluator")
    ap.add_argument("--db", default=def_db, help="Path to adsi.db SQLite database")
    ap.add_argument("--state", default=def_state, help="Path to ml_train_state.json")
    ap.add_argument("--bundle", default=def_bundle, help="Path to pv_dayahead_model_bundle.joblib")
    args = ap.parse_args()

    print("=" * 64)
    print("  ADSI INVERTER DASHBOARD — FORECAST ML & DAY-AHEAD EVALUATION")
    print("=" * 64)
    print(f"Target DB:     {args.db}")
    print(f"Target State:  {args.state}")
    print(f"Target Bundle: {args.bundle}\n")

    # ---------------------------------------------------------
    # 1. ML Train State Evaluation
    # ---------------------------------------------------------
    print("1. ML Train State & Health Contract")
    state_path = pathlib.Path(args.state)
    state = {}
    if state_path.exists():
        try:
            state = json.loads(state_path.read_text(encoding="utf-8"))
            check("State file parseable JSON", True)

            rejection_count = state.get("consecutive_train_rejection_count", 0)
            check("consecutive_train_rejection_count < 3", rejection_count < 3,
                  f"count={rejection_count}")
            check("No high_rejection_streak warning",
                  "high_rejection_streak" not in state.get("data_warnings", []))
            check("No error_memory_stale warning",
                  "error_memory_stale" not in state.get("data_warnings", []))

            backend = state.get("ml_backend_type", "unknown")
            is_fallback = state.get("status_flags", {}).get("backend_fallback", False)
            check("ML backend is LightGBM", backend == "lightgbm",
                  f"backend={backend} (fallback={is_fallback})", is_warn=True)

            samples = state.get("training_samples_count", 0)
            check("training_samples_count >= 300 (min 5d x 60 slots)", samples >= 300,
                  f"samples={samples}")

            regimes = state.get("training_regimes_count", 0)
            check("training_regimes_count > 0", regimes > 0, f"regimes={regimes}")

            em = state.get("error_memory", {})
            check("error_memory.fallback_to_legacy is False",
                  not em.get("fallback_to_legacy", False),
                  f"reason={em.get('fallback_reason')}", is_warn=True)

            eligible_count = em.get("eligible_row_count", 0)
            check("error_memory.eligible_row_count >= 7", eligible_count >= 7,
                  f"eligible_rows={eligible_count}")
        except Exception as ex:
            check("State file read error", False, str(ex))
    else:
        check("ml_train_state.json exists", False, f"Not found at {args.state}", is_warn=True)

    # ---------------------------------------------------------
    # 2. Model Bundle Checksum Integrity
    # ---------------------------------------------------------
    print("\n2. Model Bundle Checksum & Integrity")
    bundle_path = pathlib.Path(args.bundle)
    if bundle_path.exists():
        try:
            actual_sha = hashlib.sha256(bundle_path.read_bytes()).hexdigest()
            expected_sha = state.get("model_file_sha256", "")
            if expected_sha:
                check("Bundle SHA-256 matches state", actual_sha == expected_sha,
                      f"expected={expected_sha[:12]}... actual={actual_sha[:12]}...")
            else:
                check("Bundle exists with non-zero size", bundle_path.stat().st_size > 1000,
                      f"size={bundle_path.stat().st_size} bytes (no state SHA to compare)")
        except Exception as ex:
            check("Bundle read error", False, str(ex))
    else:
        check("pv_dayahead_model_bundle.joblib exists", False,
              f"Not found at {args.bundle}", is_warn=True)

    # ---------------------------------------------------------
    # 3. QA Comparison Table Assertions
    # ---------------------------------------------------------
    print("\n3. QA Comparison Table (`forecast_error_compare_daily`)")
    db_path = pathlib.Path(args.db)
    if db_path.exists():
        try:
            db = sqlite3.connect(str(db_path))
            db.row_factory = sqlite3.Row
            cutoff_30 = (datetime.now(timezone.utc) - timedelta(days=30)).date().isoformat()

            # Check table existence
            table_check = db.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='forecast_error_compare_daily'"
            ).fetchone()

            if table_check:
                row = db.execute("""
                    SELECT
                      AVG(daily_wape_pct)           AS avg_wape,
                      MAX(daily_wape_pct)           AS max_wape,
                      COUNT(*)                       AS eligible_days,
                      SUM(CASE WHEN daily_wape_pct > 25 THEN 1 ELSE 0 END) AS alert_days,
                      MAX(target_date)               AS last_eligible_date,
                      julianday('now') - julianday(MAX(target_date)) AS days_stale
                    FROM forecast_error_compare_daily
                    WHERE comparison_quality = 'eligible'
                      AND target_date >= ?
                """, (cutoff_30,)).fetchone()

                if row and row["eligible_days"] and row["eligible_days"] > 0:
                    avg_wape = row["avg_wape"] or 0
                    max_wape = row["max_wape"] or 0
                    alert_days = row["alert_days"] or 0
                    eligible_days = row["eligible_days"]
                    days_stale = row["days_stale"] or 0

                    check("Average WAPE <= 15%", avg_wape <= 15.0, f"avg_wape={avg_wape:.2f}%")
                    check("Max daily WAPE <= 25%", max_wape <= 25.0, f"max_wape={max_wape:.2f}%")
                    check("0 alert days (WAPE > 25%)", alert_days == 0, f"alert_days={alert_days}")
                    check("Eligible QA days >= 7 in trailing 30d", eligible_days >= 7,
                          f"eligible_days={eligible_days}")
                    check("Error memory not stale (<= 30d)", days_stale <= 30,
                          f"last_eligible={row['last_eligible_date']} ({days_stale:.1f}d ago)")
                else:
                    check("Eligible QA rows in last 30 days", False,
                          "0 eligible rows found in trailing 30 days", is_warn=True)

                # EMOS spread scale check
                emos_row = db.execute("""
                    SELECT
                      AVG(locked_spread_pct_cap_avg) AS avg_spread,
                      MIN(locked_spread_pct_cap_avg) AS min_spread,
                      MAX(locked_spread_pct_cap_avg) AS max_spread,
                      COUNT(*) AS days
                    FROM forecast_error_compare_daily
                    WHERE comparison_quality IN ('eligible', 'review')
                      AND target_date >= ?
                      AND locked_spread_pct_cap_avg IS NOT NULL
                """, (cutoff_30,)).fetchone()

                if emos_row and emos_row["days"] and emos_row["days"] > 0:
                    avg_s = emos_row["avg_spread"]
                    min_s = emos_row["min_spread"]
                    max_s = emos_row["max_spread"]
                    check("EMOS spread scale within [0.70, 1.30] bounds",
                          min_s >= 0.699 and max_s <= 1.301,
                          f"range=[{min_s:.3f}, {max_s:.3f}]")
                    check("EMOS average spread scale in nominal [0.85, 1.15]",
                          0.85 <= avg_s <= 1.15,
                          f"avg_scale={avg_s:.3f}", is_warn=True)
            else:
                check("Table forecast_error_compare_daily exists", False, is_warn=True)

            # ---------------------------------------------------------
            # 4. Solcast Freshness & Variant Distribution
            # ---------------------------------------------------------
            print("\n4. Forecast Run Audit & Freshness (`forecast_run_audit`)")
            audit_table_check = db.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='forecast_run_audit'"
            ).fetchone()

            if audit_table_check:
                # Deduplication check
                dup_row = db.execute("""
                    SELECT COUNT(*) AS dup_dates
                    FROM (
                      SELECT target_date, COUNT(*) c
                      FROM forecast_run_audit
                      WHERE is_authoritative_runtime = 1
                        AND target_date >= ?
                      GROUP BY target_date
                      HAVING c > 2
                    )
                """, (cutoff_30,)).fetchone()
                dup_count = dup_row["dup_dates"] if dup_row else 0
                check("No duplicate authoritative runs (> 2/day)", dup_count == 0,
                      f"{dup_count} dates with > 2 runs")

                # Freshness breakdown
                fresh_rows = db.execute("""
                    SELECT solcast_freshness_class, COUNT(*) AS cnt
                    FROM forecast_run_audit
                    WHERE is_authoritative_runtime = 1 AND target_date >= ?
                    GROUP BY solcast_freshness_class ORDER BY cnt DESC
                """, (cutoff_30,)).fetchall()
                total_runs = sum(r["cnt"] for r in fresh_rows)
                fresh_cnt = next((r["cnt"] for r in fresh_rows if r["solcast_freshness_class"] == "fresh"), 0)
                for r in fresh_rows:
                    pct = 100 * r["cnt"] / max(total_runs, 1)
                    print(f"    - Freshness '{r['solcast_freshness_class']}': {r['cnt']} runs ({pct:.1f}%)")
                if total_runs > 0:
                    check("Solcast >= 90% fresh runs in trailing 30d", fresh_cnt / total_runs >= 0.90,
                          f"{100*fresh_cnt/total_runs:.1f}% fresh ({fresh_cnt}/{total_runs})", is_warn=True)

                # Variant breakdown
                variant_rows = db.execute("""
                    SELECT forecast_variant, COUNT(*) AS cnt
                    FROM forecast_run_audit
                    WHERE is_authoritative_runtime = 1 AND target_date >= ?
                    GROUP BY forecast_variant ORDER BY cnt DESC
                """, (cutoff_30,)).fetchall()
                hybrid_cnt = next((r["cnt"] for r in variant_rows if r["forecast_variant"] == "ml_solcast_hybrid"), 0)
                degraded_cnt = sum(r["cnt"] for r in variant_rows
                                   if r["forecast_variant"] in ("ml_without_solcast", "physics_only"))
                for r in variant_rows:
                    pct = 100 * r["cnt"] / max(total_runs, 1)
                    print(f"    - Variant '{r['forecast_variant']}': {r['cnt']} runs ({pct:.1f}%)")
                if total_runs > 0:
                    check("ml_solcast_hybrid is dominant variant (>= 70%)", hybrid_cnt / total_runs >= 0.70,
                          f"{100*hybrid_cnt/total_runs:.1f}% hybrid ({hybrid_cnt}/{total_runs})", is_warn=True)
                    check("0 degraded runs (ml_without_solcast / physics_only)", degraded_cnt == 0,
                          f"{degraded_cnt} degraded runs", is_warn=True)
            else:
                check("Table forecast_run_audit exists", False, is_warn=True)

            db.close()
        except Exception as ex:
            check("Database query execution", False, str(ex))
    else:
        check("adsi.db exists", False, f"Not found at {args.db}", is_warn=True)

    # ---------------------------------------------------------
    # Final Summary
    # ---------------------------------------------------------
    print("\n" + "=" * 64)
    if FAIL_COUNT == 0 and WARN_COUNT == 0:
        print("  VERDICT: ALL INTEGRITY CHECKS PASSED (100% HEALTHY)")
    elif FAIL_COUNT == 0:
        print(f"  VERDICT: PASSED WITH {WARN_COUNT} WARNING(S)")
    else:
        print(f"  VERDICT: FAILED ({FAIL_COUNT} critical failure(s), {WARN_COUNT} warning(s))")
    print("=" * 64)
    sys.exit(0 if FAIL_COUNT == 0 else 1)


if __name__ == "__main__":
    main()
