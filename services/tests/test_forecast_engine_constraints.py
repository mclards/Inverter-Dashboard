import importlib.util
import logging
import os
import sqlite3
import shutil
import unittest
from datetime import datetime, date
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "services" / "forecast_engine.py"
WORK_TMP = ROOT / ".tmp" / "forecast-engine-tests"
WORK_TMP.mkdir(parents=True, exist_ok=True)

def load_module(temp_root: Path, tag: str):
    (temp_root / "data").mkdir(parents=True, exist_ok=True)
    (temp_root / "portable").mkdir(parents=True, exist_ok=True)
    os.environ["ADSI_DATA_DIR"] = str(temp_root / "data")
    os.environ["ADSI_PORTABLE_DATA_DIR"] = str(temp_root / "portable")
    spec = importlib.util.spec_from_file_location(f"forecast_engine_test_{tag}", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module

class ForecastEngineConstraintTests(unittest.TestCase):
    def test_operational_constraint_profile_tracks_carryover_and_mixed_scope(self):
        tmp_root = WORK_TMP / "profile"
        shutil.rmtree(tmp_root, ignore_errors=True)
        tmp_root.mkdir(parents=True, exist_ok=True)
        try:
            mod = load_module(tmp_root, "profile")
            conn = sqlite3.connect(mod.APP_DB_FILE)
            try:
                conn.execute(
                    """
                    CREATE TABLE audit_log (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        ts INTEGER NOT NULL,
                        operator TEXT,
                        inverter INTEGER NOT NULL,
                        node INTEGER NOT NULL,
                        action TEXT NOT NULL,
                        scope TEXT DEFAULT 'single',
                        result TEXT DEFAULT 'ok',
                        ip TEXT DEFAULT '',
                        reason TEXT DEFAULT ''
                    )
                    """
                )

                def ts(day: str, hhmm: str) -> int:
                    return int(datetime.fromisoformat(f"{day}T{hhmm}:00").timestamp() * 1000)

                rows = [
                    (ts("2026-03-18", "23:55"), 1, 1, "STOP", "plant-cap", "ok"),
                    (ts("2026-03-19", "08:15"), 1, 1, "START", "plant-cap", "ok"),
                    (ts("2026-03-19", "10:00"), 1, 1, "STOP", "plant-cap", "ok"),
                    (ts("2026-03-19", "10:05"), 2, 1, "STOP", "single", "ok"),
                    (ts("2026-03-19", "10:15"), 2, 1, "START", "single", "ok"),
                    (ts("2026-03-19", "10:20"), 1, 1, "START", "plant-cap", "ok"),
                ]
                conn.executemany(
                    "INSERT INTO audit_log (ts, inverter, node, action, scope, result) VALUES (?, ?, ?, ?, ?, ?)",
                    rows,
                )
                conn.commit()
            finally:
                conn.close()

            profile = mod.load_operational_constraint_profile("2026-03-19")
            _, meta = mod.build_operational_constraint_mask("2026-03-19")

            slot_0500 = (5 * 60) // mod.SLOT_MIN
            slot_1000 = (10 * 60) // mod.SLOT_MIN
            slot_1005 = (10 * 60 + 5) // mod.SLOT_MIN
            slot_1015 = (10 * 60 + 15) // mod.SLOT_MIN
            slot_1020 = (10 * 60 + 20) // mod.SLOT_MIN

            self.assertEqual(int(profile["commanded_off_nodes"][slot_0500]), 1)
            self.assertEqual(int(profile["cap_dispatched_off_nodes"][slot_0500]), 1)
            self.assertTrue(bool(meta["cap_dispatch_mask"][slot_0500]))

            self.assertEqual(int(profile["commanded_off_nodes"][slot_1000]), 1)
            self.assertEqual(int(profile["cap_dispatched_off_nodes"][slot_1000]), 1)
            self.assertTrue(bool(meta["cap_dispatch_mask"][slot_1000]))

            self.assertEqual(int(profile["commanded_off_nodes"][slot_1005]), 2)
            self.assertEqual(int(profile["cap_dispatched_off_nodes"][slot_1005]), 1)
            self.assertEqual(int(profile["manual_off_nodes"][slot_1005]), 1)
            self.assertFalse(bool(meta["cap_dispatch_mask"][slot_1005]))
            self.assertTrue(bool(meta["manual_constraint_mask"][slot_1005]))

            self.assertEqual(int(profile["commanded_off_nodes"][slot_1015]), 1)
            self.assertTrue(bool(meta["cap_dispatch_mask"][slot_1015]))

            self.assertEqual(int(profile["commanded_off_nodes"][slot_1020]), 0)
            self.assertFalse(bool(meta["operational_mask"][slot_1020]))
        finally:
            logging.shutdown()
            shutil.rmtree(tmp_root, ignore_errors=True)

    def test_error_memory_ignores_operational_slots(self):
        tmp_root = WORK_TMP / "error_memory"
        shutil.rmtree(tmp_root, ignore_errors=True)
        tmp_root.mkdir(parents=True, exist_ok=True)
        try:
            mod = load_module(tmp_root, "error_memory")
            conn = sqlite3.connect(mod.APP_DB_FILE)
            try:
                # Create the tables that compute_error_memory reads from
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS forecast_error_compare_daily (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        target_date TEXT NOT NULL,
                        run_audit_id INTEGER NOT NULL DEFAULT 0,
                        forecast_variant TEXT DEFAULT '',
                        provider_expected TEXT DEFAULT '',
                        include_in_error_memory INTEGER DEFAULT 0,
                        include_in_source_scoring INTEGER DEFAULT 0,
                        comparison_quality TEXT DEFAULT '',
                        actual_slot_count INTEGER DEFAULT 0,
                        forecast_slot_count INTEGER DEFAULT 0,
                        usable_slot_count INTEGER DEFAULT 0,
                        constrained_slot_count INTEGER DEFAULT 0,
                        mae_kwh REAL DEFAULT 0,
                        rmse_kwh REAL DEFAULT 0,
                        mape_pct REAL DEFAULT 0,
                        actual_total_kwh REAL DEFAULT 0,
                        forecast_total_kwh REAL DEFAULT 0,
                        abs_error_sum_kwh REAL DEFAULT 0,
                        solcast_freshness_class TEXT DEFAULT '',
                        day_regime TEXT DEFAULT '',
                        notes_json TEXT,
                        scored_ts INTEGER DEFAULT 0,
                        UNIQUE(target_date, run_audit_id)
                    )
                    """
                )
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS forecast_error_compare_slot (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        target_date TEXT NOT NULL,
                        run_audit_id INTEGER NOT NULL DEFAULT 0,
                        slot INTEGER NOT NULL,
                        signed_error_kwh REAL,
                        support_weight REAL DEFAULT 1.0,
                        usable_for_error_memory INTEGER DEFAULT 0,
                        actual_kwh REAL DEFAULT 0,
                        forecast_kwh REAL DEFAULT 0,
                        actual_present INTEGER DEFAULT 0,
                        forecast_present INTEGER DEFAULT 0,
                        operational_mask INTEGER DEFAULT 0,
                        manual_mask INTEGER DEFAULT 0,
                        cap_dispatch_mask INTEGER DEFAULT 0,
                        weather_bucket TEXT DEFAULT '',
                        UNIQUE(target_date, run_audit_id, slot)
                    )
                    """
                )
                # audit_log needed by build_operational_constraint_mask
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS audit_log (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        ts INTEGER NOT NULL,
                        operator TEXT,
                        inverter INTEGER NOT NULL,
                        node INTEGER NOT NULL,
                        action TEXT NOT NULL,
                        scope TEXT DEFAULT 'single',
                        result TEXT DEFAULT 'ok',
                        ip TEXT DEFAULT '',
                        reason TEXT DEFAULT ''
                    )
                    """
                )

                yesterday = "2026-03-19"
                run_audit_id = 1

                # Daily row: eligible for error memory
                conn.execute(
                    """
                    INSERT INTO forecast_error_compare_daily
                        (target_date, run_audit_id, forecast_variant, provider_expected,
                         include_in_error_memory, comparison_quality,
                         actual_slot_count, forecast_slot_count, usable_slot_count)
                    VALUES (?, ?, ?, ?, 1, 'eligible', 156, 156, 155)
                    """,
                    (yesterday, run_audit_id, "ml_solcast_hybrid_fresh", "ml_local"),
                )

                # Slot 100: operational mask = True → usable_for_error_memory = 0
                conn.execute(
                    """
                    INSERT INTO forecast_error_compare_slot
                        (target_date, run_audit_id, slot, signed_error_kwh,
                         support_weight, usable_for_error_memory, operational_mask)
                    VALUES (?, ?, 100, 70.0, 1.0, 0, 1)
                    """,
                    (yesterday, run_audit_id),
                )

                # Slot 101: no operational mask → usable_for_error_memory = 1
                conn.execute(
                    """
                    INSERT INTO forecast_error_compare_slot
                        (target_date, run_audit_id, slot, signed_error_kwh,
                         support_weight, usable_for_error_memory, operational_mask)
                    VALUES (?, ?, 101, 40.0, 1.0, 1, 0)
                    """,
                    (yesterday, run_audit_id),
                )
                conn.commit()
            finally:
                conn.close()

            err = mod.compute_error_memory(date(2026, 3, 20), pd.DataFrame(), target_regime="mixed")

            self.assertAlmostEqual(float(err[100]), 0.0, places=6)
            self.assertGreater(float(err[101]), 0.0)
        finally:
            logging.shutdown()
            shutil.rmtree(tmp_root, ignore_errors=True)

    def test_curtailed_mask_uses_configured_forecast_export_limit(self):
        tmp_root = WORK_TMP / "export_limit"
        shutil.rmtree(tmp_root, ignore_errors=True)
        tmp_root.mkdir(parents=True, exist_ok=True)
        try:
            mod = load_module(tmp_root, "export_limit")
            conn = sqlite3.connect(mod.APP_DB_FILE)
            try:
                conn.execute(
                    """
                    CREATE TABLE settings (
                        key TEXT PRIMARY KEY,
                        value TEXT
                    )
                    """
                )
                conn.execute(
                    "INSERT INTO settings (key, value) VALUES (?, ?)",
                    ("forecastExportLimitMw", "22.5"),
                )
                conn.commit()
            finally:
                conn.close()

            mod.clear_forecast_data_cache()
            actual = np.zeros(mod.SLOTS_DAY, dtype=float)
            baseline = np.zeros(mod.SLOTS_DAY, dtype=float)
            slot = 100
            actual[slot] = 1850.0
            baseline[slot] = 2200.0

            mask = mod.curtailed_mask(actual, baseline)
            self.assertTrue(bool(mask[slot]))
            self.assertAlmostEqual(float(mod.load_forecast_export_limit_mw()), 22.5, places=6)
        finally:
            logging.shutdown()
            shutil.rmtree(tmp_root, ignore_errors=True)

    def test_compute_forecast_metrics_excludes_missing_and_operational_slots(self):
        tmp_root = WORK_TMP / "metrics"
        shutil.rmtree(tmp_root, ignore_errors=True)
        tmp_root.mkdir(parents=True, exist_ok=True)
        try:
            mod = load_module(tmp_root, "metrics")
            actual = np.zeros(mod.SLOTS_DAY, dtype=float)
            forecast = np.zeros(mod.SLOTS_DAY, dtype=float)
            actual_present = np.zeros(mod.SLOTS_DAY, dtype=bool)
            forecast_present = np.zeros(mod.SLOTS_DAY, dtype=bool)
            exclude_mask = np.zeros(mod.SLOTS_DAY, dtype=bool)

            actual[100] = 100.0
            forecast[100] = 10.0
            actual_present[100] = True
            forecast_present[100] = True
            exclude_mask[100] = True

            actual[101] = 50.0
            forecast[101] = 40.0
            actual_present[101] = True
            forecast_present[101] = True

            actual[102] = 70.0
            forecast[102] = 20.0
            actual_present[102] = True

            metrics = mod.compute_forecast_metrics(
                actual,
                forecast,
                actual_present=actual_present,
                forecast_present=forecast_present,
                exclude_mask=exclude_mask,
            )

            self.assertIsNotNone(metrics)
            self.assertEqual(int(metrics["usable_slot_count"]), 1)
            self.assertAlmostEqual(float(metrics["actual_total_kwh"]), 50.0, places=6)
            self.assertAlmostEqual(float(metrics["forecast_total_kwh"]), 40.0, places=6)
            self.assertAlmostEqual(float(metrics["abs_error_sum_kwh"]), 10.0, places=6)
            self.assertAlmostEqual(float(metrics["mae_kwh"]), 10.0, places=6)
            self.assertAlmostEqual(float(metrics["rmse_kwh"]), 10.0, places=6)
            self.assertAlmostEqual(float(metrics["mape_pct"]), 20.0, places=6)
            self.assertEqual(int(metrics["operational_masked_slot_count"]), 1)
            self.assertEqual(int(metrics["missing_forecast_slot_count"]), 154)
        finally:
            logging.shutdown()
            shutil.rmtree(tmp_root, ignore_errors=True)

    def test_has_forecast_dayahead_in_db_requires_full_solar_window(self):
        tmp_root = WORK_TMP / "dayahead_presence"
        shutil.rmtree(tmp_root, ignore_errors=True)
        tmp_root.mkdir(parents=True, exist_ok=True)
        try:
            mod = load_module(tmp_root, "dayahead_presence")
            conn = sqlite3.connect(mod.APP_DB_FILE)
            try:
                conn.execute(
                    """
                    CREATE TABLE forecast_dayahead (
                        date TEXT NOT NULL,
                        ts INTEGER NOT NULL,
                        slot INTEGER NOT NULL,
                        time_hms TEXT,
                        kwh_inc REAL,
                        kwh_lo REAL,
                        kwh_hi REAL,
                        source TEXT,
                        updated_ts INTEGER,
                        PRIMARY KEY (date, slot)
                    )
                    """
                )
                day = "2026-03-20"
                conn.execute(
                    "INSERT INTO forecast_dayahead (date, ts, slot, time_hms, kwh_inc) VALUES (?, ?, ?, ?, ?)",
                    (day, 0, int(mod.SOLAR_START_SLOT), "05:00:00", 1.0),
                )
                conn.commit()
                self.assertFalse(mod._has_forecast_dayahead_in_db(day))

                rows = []
                for slot in range(int(mod.SOLAR_START_SLOT), int(mod.SOLAR_END_SLOT)):
                    hh = (slot * mod.SLOT_MIN) // 60
                    mm = (slot * mod.SLOT_MIN) % 60
                    rows.append(
                        (
                            day,
                            slot * mod.SLOT_MIN * 60 * 1000,
                            slot,
                            f"{hh:02d}:{mm:02d}:00",
                            1.0,
                        )
                    )
                conn.executemany(
                    """
                    INSERT OR REPLACE INTO forecast_dayahead (date, ts, slot, time_hms, kwh_inc)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    rows,
                )
                conn.commit()
            finally:
                conn.close()

            self.assertTrue(mod._has_forecast_dayahead_in_db(day))
        finally:
            logging.shutdown()
            shutil.rmtree(tmp_root, ignore_errors=True)

    def test_write_forecast_returns_false_when_db_write_fails_even_if_json_succeeds(self):
        tmp_root = WORK_TMP / "write_forecast"
        shutil.rmtree(tmp_root, ignore_errors=True)
        tmp_root.mkdir(parents=True, exist_ok=True)
        try:
            mod = load_module(tmp_root, "write_forecast")
            orig_save = mod._save_json
            orig_write_db = mod._write_forecast_db
            try:
                mod._save_json = lambda path, data: True
                mod._write_forecast_db = lambda key, day, series: False
                ok = mod.write_forecast(
                    "PacEnergy_DayAhead",
                    "2026-03-20",
                    [{"ts": 0, "kwh": 1.0}],
                )
            finally:
                mod._save_json = orig_save
                mod._write_forecast_db = orig_write_db

            self.assertFalse(ok)
        finally:
            logging.shutdown()
            shutil.rmtree(tmp_root, ignore_errors=True)

    def test_register_forecast_failure_backoff_caps_and_grows(self):
        tmp_root = WORK_TMP / "failure_backoff"
        shutil.rmtree(tmp_root, ignore_errors=True)
        tmp_root.mkdir(parents=True, exist_ok=True)
        try:
            mod = load_module(tmp_root, "failure_backoff")
            failures = 0
            mono_now = 1000.0
            observed = []
            for _ in range(5):
                failures, cooldown_until, backoff = mod._register_forecast_failure(
                    failures,
                    mono_now,
                    300,
                )
                observed.append(backoff)
                self.assertAlmostEqual(cooldown_until, mono_now + backoff, places=6)
            self.assertEqual(observed, [300, 600, 1200, 1800, 1800])
        finally:
            logging.shutdown()
            shutil.rmtree(tmp_root, ignore_errors=True)

    def test_resolve_service_target_date_prioritizes_today_before_sunrise_and_when_missing(self):
        tmp_root = WORK_TMP / "target_resolution"
        shutil.rmtree(tmp_root, ignore_errors=True)
        tmp_root.mkdir(parents=True, exist_ok=True)
        try:
            mod = load_module(tmp_root, "target_resolution")
            today = date(2026, 3, 19)

            self.assertEqual(
                mod._resolve_service_target_date(today, 2, da_today_in_db=False),
                today,
            )
            self.assertEqual(
                mod._resolve_service_target_date(today, 6, da_today_in_db=False),
                today,
            )
            self.assertEqual(
                mod._resolve_service_target_date(today, 6, da_today_in_db=True),
                date(2026, 3, 20),
            )
            self.assertEqual(
                mod._resolve_service_target_date(today, 20, da_today_in_db=True),
                date(2026, 3, 20),
            )
        finally:
            logging.shutdown()
            shutil.rmtree(tmp_root, ignore_errors=True)

if __name__ == "__main__":
    unittest.main()
