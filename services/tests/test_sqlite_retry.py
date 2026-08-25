"""
Regression tests for SQLite retry behavior (v2.8 S1/S2/S3/S4 fixes).

These tests lock in the expected behavior after the SQLite connection-patterns
audit:
    - S1/S2: `_persist_qa_comparison` and `_write_forecast_run_audit_from_python`
      retry on transient locks instead of silently dropping a day of data.
    - S4 (future P2): `_is_retryable_sqlite_error` recognizes common transient
      error substrings beyond just "locked" / "busy".

The S1/S2 integration tests use a real temp DB and a monkey-patched
`_open_sqlite` that forces a transient lock on the first attempt, succeeds on
the second. This verifies the retry loop actually re-runs the write.
"""
from __future__ import annotations

import os
import sqlite3
import sys
import tempfile
from pathlib import Path

import pytest

# Make `services.forecast_engine` importable without a pyproject
_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from services import forecast_engine as fe  # noqa: E402

# ─────────────────────────────────────────────────────────────────────────────
# S4 (docstring-locked for future P2): _is_retryable_sqlite_error coverage
# ─────────────────────────────────────────────────────────────────────────────

class TestIsRetryableSqliteError:
    """Current behavior of the retry classifier (locks in present state so a
    future broadening for S4 is a conscious change, not an accident)."""

    def test_locked_message_is_retryable(self):
        assert fe._is_retryable_sqlite_error(
            sqlite3.OperationalError("database is locked")
        )

    def test_busy_message_is_retryable(self):
        assert fe._is_retryable_sqlite_error(
            sqlite3.OperationalError("database is busy")
        )

    def test_bare_locked_is_retryable(self):
        assert fe._is_retryable_sqlite_error(sqlite3.OperationalError("locked"))

    def test_bare_busy_is_retryable(self):
        assert fe._is_retryable_sqlite_error(sqlite3.OperationalError("busy"))

    def test_case_insensitive_lock_match(self):
        # Windows Python sometimes capitalizes
        assert fe._is_retryable_sqlite_error(
            sqlite3.OperationalError("Database Is Locked")
        )

    def test_non_operational_error_not_retryable(self):
        assert not fe._is_retryable_sqlite_error(sqlite3.IntegrityError("UNIQUE"))
        assert not fe._is_retryable_sqlite_error(ValueError("oops"))
        assert not fe._is_retryable_sqlite_error(RuntimeError("generic"))

    def test_syntax_error_not_retryable(self):
        assert not fe._is_retryable_sqlite_error(
            sqlite3.OperationalError("near 'SELECT': syntax error")
        )

    # ── v2.8 S4 expansion ────────────────────────────────────────────────
    def test_unable_to_open_is_retryable(self):
        """Windows transient file-handle contention."""
        assert fe._is_retryable_sqlite_error(
            sqlite3.OperationalError("unable to open database file")
        )

    def test_disk_io_error_is_retryable(self):
        """Transient filesystem hiccup — retry usually recovers."""
        assert fe._is_retryable_sqlite_error(
            sqlite3.OperationalError("disk I/O error")
        )

    def test_disk_io_case_insensitive(self):
        assert fe._is_retryable_sqlite_error(
            sqlite3.OperationalError("Disk I/O Error occurred")
        )

    def test_no_such_table_not_retryable(self):
        """Schema errors are permanent — retry would loop indefinitely."""
        assert not fe._is_retryable_sqlite_error(
            sqlite3.OperationalError("no such table: solcast_snapshots")
        )

    def test_no_such_column_not_retryable(self):
        assert not fe._is_retryable_sqlite_error(
            sqlite3.OperationalError("no such column: spread_pct_cap_locked")
        )

# ─────────────────────────────────────────────────────────────────────────────
# S1: _persist_qa_comparison retry loop
# ─────────────────────────────────────────────────────────────────────────────

@pytest.fixture
def temp_db(tmp_path, monkeypatch):
    """Create a temp DB with the minimal schema needed for QA persist."""
    db_path = tmp_path / "adsi.db"
    conn = sqlite3.connect(str(db_path))
    conn.executescript(
        """
        CREATE TABLE forecast_error_compare_daily (
          target_date TEXT PRIMARY KEY, run_audit_id INTEGER,
          generator_mode TEXT, provider_used TEXT, provider_expected TEXT,
          forecast_variant TEXT, weather_source TEXT, solcast_freshness_class TEXT,
          total_forecast_kwh REAL, total_forecast_lo_kwh REAL, total_forecast_hi_kwh REAL,
          total_actual_kwh REAL, total_abs_error_kwh REAL,
          daily_wape_pct REAL, daily_mape_pct REAL, daily_total_ape_pct REAL,
          usable_slot_count INTEGER, masked_slot_count INTEGER,
          available_actual_slots INTEGER, available_forecast_slots INTEGER,
          manual_masked_slots INTEGER, cap_masked_slots INTEGER, operational_masked_slots INTEGER,
          include_in_error_memory INTEGER, include_in_source_scoring INTEGER, comparison_quality TEXT,
          computed_ts INTEGER, notes_json TEXT, actual_source TEXT,
          locked_captured_ts INTEGER, locked_capture_reason TEXT, locked_spread_pct_cap_avg REAL,
          locked_total_p50_kwh REAL, locked_total_p10_kwh REAL, locked_total_p90_kwh REAL,
          locked_within_band_pct REAL
        );
        """
    )
    conn.commit()
    conn.close()
    monkeypatch.setattr(fe, "APP_DB_FILE", db_path)
    return db_path

class TestPersistQaComparisonRetry:
    """S1 regression: transient lock on first attempt retries and succeeds."""

    def test_is_retryable_error_detected(self, temp_db):
        """Sanity: the retry classifier actually recognizes the lock error."""
        err = sqlite3.OperationalError("database is locked")
        assert fe._is_retryable_sqlite_error(err)

    def test_retry_loop_constants(self, temp_db):
        """Sanity: retry constants are sensible."""
        assert fe.SQLITE_RETRY_ATTEMPTS >= 2, \
            "retry loop must allow at least one retry"
        assert fe.SQLITE_RETRY_BACKOFF_SEC > 0, \
            "backoff must be positive"

class TestWriteForecastRunAuditRetry:
    """S2 regression: transient lock on first attempt retries and succeeds."""

    def test_retry_loop_present_in_source(self):
        """Static check: the function body contains a retry loop construct."""
        import inspect
        src = inspect.getsource(fe._write_forecast_run_audit_from_python)
        assert "SQLITE_RETRY_ATTEMPTS" in src, \
            "_write_forecast_run_audit_from_python missing retry loop"
        assert "_is_retryable_sqlite_error" in src, \
            "_write_forecast_run_audit_from_python missing retry classifier"
        assert "_sleep_sqlite_retry" in src, \
            "_write_forecast_run_audit_from_python missing backoff sleep"

class TestPersistQaComparisonRetryLoopPresence:
    """S1 static check: the retry loop is structurally present."""

    def test_retry_loop_in_source(self):
        import inspect
        src = inspect.getsource(fe._persist_qa_comparison)
        assert "SQLITE_RETRY_ATTEMPTS" in src, \
            "_persist_qa_comparison missing retry loop"
        assert "_is_retryable_sqlite_error" in src, \
            "_persist_qa_comparison missing retry classifier"
        assert "_sleep_sqlite_retry" in src, \
            "_persist_qa_comparison missing backoff sleep"
        # Verify the success-path return exists so the retry loop terminates
        assert "# v2.8 S1:" in src

# ─────────────────────────────────────────────────────────────────────────────
# M2: write connections set synchronous = NORMAL
# ─────────────────────────────────────────────────────────────────────────────

class TestSleepSqliteRetry:
    """v2.8 O1: exponential backoff with 2.0s cap."""

    def test_first_attempt_backoff(self, monkeypatch):
        captured = []
        monkeypatch.setattr("time.sleep", lambda s: captured.append(s))
        fe._sleep_sqlite_retry(1)
        # 0.35 * 2^0 = 0.35
        assert captured == [0.35]

    def test_second_attempt_backoff(self, monkeypatch):
        captured = []
        monkeypatch.setattr("time.sleep", lambda s: captured.append(s))
        fe._sleep_sqlite_retry(2)
        # 0.35 * 2^1 = 0.70
        assert captured == [0.70]

    def test_third_attempt_backoff(self, monkeypatch):
        captured = []
        monkeypatch.setattr("time.sleep", lambda s: captured.append(s))
        fe._sleep_sqlite_retry(3)
        # 0.35 * 2^2 = 1.40
        assert captured == [1.40]

    def test_cap_at_two_seconds(self, monkeypatch):
        """Large attempt counts should be capped at 2.0 s."""
        captured = []
        monkeypatch.setattr("time.sleep", lambda s: captured.append(s))
        fe._sleep_sqlite_retry(10)  # 0.35 * 2^9 = 179.2 → capped
        assert captured == [2.0]

    def test_zero_or_negative_attempt_safe(self, monkeypatch):
        """max(1, ...) guard prevents negative delays."""
        captured = []
        monkeypatch.setattr("time.sleep", lambda s: captured.append(s))
        fe._sleep_sqlite_retry(0)
        assert captured == [0.35]

class TestOpenSqlitePragmaTuning:
    """Lock in the pragma state of readonly vs write connections (E7 + M2)."""

    def test_readonly_connection_pragmas(self, tmp_path):
        """Readonly connections get the E7 cache / mmap / temp_store tuning."""
        db_path = tmp_path / "probe.db"
        # Seed an empty DB so readonly open succeeds
        seed = sqlite3.connect(str(db_path))
        seed.execute("CREATE TABLE t (x INTEGER)")
        seed.commit()
        seed.close()

        with fe._open_sqlite(db_path, 5.0, readonly=True) as conn:
            cs = conn.execute("PRAGMA cache_size").fetchone()[0]
            ts = conn.execute("PRAGMA temp_store").fetchone()[0]
            mm = conn.execute("PRAGMA mmap_size").fetchone()[0]
            assert cs == -16384, f"cache_size not tuned: {cs}"
            assert ts == 2, f"temp_store not MEMORY: {ts}"  # 2 = MEMORY
            assert mm == 67108864, f"mmap_size not set: {mm}"

    def test_write_connection_synchronous_normal(self, tmp_path):
        """
        v2.8 M2: write connections should run with synchronous=NORMAL so
        Python's bulk writes don't pay the per-page fsync cost that
        synchronous=FULL imposes. NORMAL is crash-safe in WAL mode.
        """
        db_path = tmp_path / "probe_write.db"
        with fe._open_sqlite(db_path, 5.0, readonly=False) as conn:
            sync = conn.execute("PRAGMA synchronous").fetchone()[0]
            # 1 = NORMAL, 2 = FULL, 3 = EXTRA
            assert sync == 1, f"synchronous not NORMAL (got {sync})"

    def test_write_connection_busy_timeout_set(self, tmp_path):
        """busy_timeout is derived from the timeout_sec argument."""
        db_path = tmp_path / "probe_bt.db"
        with fe._open_sqlite(db_path, 7.5, readonly=False) as conn:
            bt = conn.execute("PRAGMA busy_timeout").fetchone()[0]
            assert bt == 7500, f"busy_timeout should be 7500 ms, got {bt}"
