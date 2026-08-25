"""P0 regression coverage for causal and operational nowcast remediation."""

from __future__ import annotations

import json
import sqlite3
import subprocess
import sys
import threading
import time
from datetime import date, datetime, timedelta

import numpy as np
import pandas as pd
import pytest

from services import forecast_engine as fe


DAY = date(2026, 5, 10)
DAY_S = DAY.isoformat()


def _inputs(cutoff: int = 90, scale: float = 1.2, cap: float = 1_000.0) -> dict:
    dayahead = np.zeros(fe.SLOTS_DAY, dtype=float)
    dayahead[fe.SOLAR_START_SLOT:fe.SOLAR_END_SLOT] = 100.0
    actual = np.zeros(fe.SLOTS_DAY, dtype=float)
    actual[fe.SOLAR_START_SLOT:cutoff + 1] = 100.0 * scale
    present = np.zeros(fe.SLOTS_DAY, dtype=bool)
    present[fe.SOLAR_START_SLOT:cutoff + 1] = True
    return {
        "dayahead": dayahead,
        "dayahead_lo": dayahead * 0.8,
        "dayahead_hi": dayahead * 1.2,
        "dayahead_present": np.arange(fe.SLOTS_DAY) >= fe.SOLAR_START_SLOT,
        "actual": actual,
        "actual_present": present,
        "outage_mask": np.zeros(fe.SLOTS_DAY, dtype=bool),
        "cap_dispatch_mask": np.zeros(fe.SLOTS_DAY, dtype=bool),
        "manual_constraint_mask": np.zeros(fe.SLOTS_DAY, dtype=bool),
        "export_curtailment_mask": np.zeros(fe.SLOTS_DAY, dtype=bool),
        "constraint_meta": {},
        "capacity_coverage": np.ones(fe.SLOTS_DAY),
        "weather_frame": pd.DataFrame(index=range(fe.SLOTS_DAY)),
        "slot_cap_kwh": cap,
        "blend_max": 0.72,
    }


def _series(inputs: dict) -> list[dict]:
    return fe.to_ui_series(
        inputs["dayahead"], inputs["dayahead_lo"], inputs["dayahead_hi"], DAY_S
    )


def _issuance_weather() -> dict:
    records = []
    for hour in range(24):
        records.append({
            "time": f"{DAY_S} {hour:02d}:00:00", "rad": 0.0,
            "rad_direct": 0.0, "rad_diffuse": 0.0, "cloud": 0.0,
            "cloud_low": 0.0, "cloud_mid": 0.0, "cloud_high": 0.0,
            "temp": 25.0, "rh": 60.0, "wind": 1.0, "precip": 0.0, "cape": 0.0,
        })
    return {"day": DAY_S, "saved_ts": 1, "raw_hourly": records, "applied_hourly": records}


def _constraint_snapshot(cap: float = 1_000.0, blend: float = 0.72) -> dict:
    plant_max_kw = cap * 60.0 / fe.SLOT_MIN
    export_limit_mw = 6.0
    return {
        "schema_version": 2,
        "captured_ts": 1,
        "slot_cap_kwh": cap,
        "cap_dispatch_mask": [0] * fe.SLOTS_DAY,
        "manual_constraint_mask": [0] * fe.SLOTS_DAY,
        "outage_mask": [0] * fe.SLOTS_DAY,
        "constraint_event_count": 0,
        "export_curtailment": {
            "tolerance": 0.97,
            "export_limit_mw": export_limit_mw,
            "export_cap_slot_kwh": export_limit_mw * 1000.0 * fe.SLOT_MIN / 60.0,
            "baseline_multiplier": 1.05,
        },
        "capacity_basis": {
            "inverter_node_map": {"1": [1, 2, 3, 4]},
            "reporting_capacity_kw": {"1": 1000.0},
            "total_reporting_capacity_kw": 1000.0,
            "node_kw_dependable": 250.0,
            "plant_max_kw": plant_max_kw,
            "plant_dependable_kw": max(1.0, plant_max_kw * 0.95),
        },
        "nowcast_config": {"forecastIntradayBlendMax": blend},
    }


def test_global_deadline_is_nonblocking_and_single_flight(monkeypatch):
    release = threading.Event()
    entered = threading.Event()
    active = 0
    maximum_active = 0
    guard = threading.Lock()

    def slow_builder(*_args):
        nonlocal active, maximum_active
        with guard:
            active += 1
            maximum_active = max(maximum_active, active)
        entered.set()
        release.wait(2.0)
        with guard:
            active -= 1
        return None, {"run_status": "skipped"}

    monkeypatch.setattr(fe, "_build_current_intraday_adjusted_forecast", slow_builder)
    monkeypatch.setattr(fe, "_nowcast_timed_out_worker", None)
    started = time.monotonic()
    series, meta = fe.build_intraday_adjusted_forecast(
        DAY, mode_override="off", execution_budget_seconds=0.03
    )
    assert entered.is_set()
    assert series is None
    assert "timeout" in meta["fallback_reason"]
    assert time.monotonic() - started < 0.3

    started = time.monotonic()
    _series_out, quarantined = fe.build_intraday_adjusted_forecast(
        DAY, mode_override="off", execution_budget_seconds=0.03
    )
    assert "worker_quarantined" in quarantined["fallback_reason"]
    assert time.monotonic() - started < 0.1
    assert maximum_active == 1
    release.set()
    assert entered.wait(0.2)
    deadline = time.monotonic() + 1.0
    while fe._nowcast_timed_out_worker is not None and time.monotonic() < deadline:
        time.sleep(0.01)
    assert fe._nowcast_timed_out_worker is None


@pytest.mark.parametrize("builder_name", [
    "_build_current_intraday_adjusted_forecast",
    "_build_robust_intraday_nowcast",
])
def test_builders_exclude_nonfinite_and_overcap_actuals_and_order_bands(monkeypatch, builder_name):
    inputs = _inputs()
    inputs["actual"][75] = np.nan
    inputs["actual"][76] = np.inf
    inputs["actual"][77] = 1_500.0
    monkeypatch.setattr(fe, "curtailed_mask", lambda *_a, **_k: np.zeros(fe.SLOTS_DAY, dtype=bool))
    monkeypatch.setattr(fe, "confidence_bands", lambda mid, *_a, **_k: (mid * 0.8, mid * 1.2))
    monkeypatch.setattr(fe, "_setting_float_or_none", lambda *_a, **_k: pytest.fail("live setting read during injected run"))
    builder = getattr(fe, builder_name)
    series, meta = builder(DAY, cutoff_slot=90, input_bundle=inputs)
    assert series
    assert meta["excluded_invalid_actual_slots"] == 2
    assert meta["excluded_over_cap_actual_slots"] == 1
    by_slot = {fe._parse_slot_from_time_text(DAY_S, row["time"]): row for row in series}
    for slot in (75, 76, 77):
        assert by_slot[slot]["kWh_inc"] == pytest.approx(100.0)
    for row in series:
        assert 0.0 <= row["kWh_lo"] <= row["kWh_inc"] <= row["kWh_hi"] <= 1_000.0


def test_injected_replay_bundle_ignores_live_baseline_weather_cap_and_blend(monkeypatch):
    inputs = _inputs(cap=1_000.0)
    monkeypatch.setattr(fe, "_load_intraday_inputs", lambda *_a, **_k: pytest.fail("live inputs reloaded"))
    monkeypatch.setattr(fe, "_intraday_weather_frame", lambda *_a, **_k: pytest.fail("live weather reloaded"))
    monkeypatch.setattr(fe, "_load_dayahead_bands_from_db", lambda *_a, **_k: pytest.fail("live bands reloaded"))
    monkeypatch.setattr(fe, "_load_energy_reporting_coverage", lambda *_a, **_k: pytest.fail("live coverage reloaded"))
    monkeypatch.setattr(fe, "_setting_float_or_none", lambda *_a, **_k: pytest.fail("live blend reloaded"))
    monkeypatch.setattr(fe, "curtailed_mask", lambda *_a, **_k: np.zeros(fe.SLOTS_DAY, dtype=bool))

    monkeypatch.setattr(fe, "slot_cap_kwh", lambda *_a, **_k: 10.0)
    first, _ = fe._build_robust_intraday_nowcast(DAY, 90, input_bundle=inputs)
    monkeypatch.setattr(fe, "slot_cap_kwh", lambda *_a, **_k: 9_000.0)
    second, _ = fe._build_robust_intraday_nowcast(DAY, 90, input_bundle=inputs)
    assert [row["kWh_inc"] for row in first] == pytest.approx([row["kWh_inc"] for row in second])


def test_replay_present_nan_is_never_scored(monkeypatch):
    inputs = _inputs(cutoff=100)
    inputs["actual"][81] = np.nan
    inputs["actual_present"][81] = True
    inputs["replay_provenance"] = {"issuance_id": "DI-test"}
    monkeypatch.setattr(fe, "_build_replay_intraday_input_bundle", lambda *_a, **_k: inputs)
    base_series = _series(inputs)
    monkeypatch.setattr(fe, "_build_current_intraday_adjusted_forecast", lambda *_a, **_k: (base_series, {}))
    monkeypatch.setattr(fe, "_build_robust_intraday_nowcast", lambda *_a, **_k: (base_series, {}))
    monkeypatch.setattr(fe, "curtailed_mask", lambda *_a, **_k: np.zeros(fe.SLOTS_DAY, dtype=bool))
    monkeypatch.setattr(fe, "_load_nowcast_baseline_link", lambda: {})
    result = fe.replay_intraday_nowcast(DAY, 80, persist=False)
    assert result["variants"]["unchanged_dayahead"]["scored_slots_5m"] == 0
    assert result["variants"]["unchanged_dayahead"]["wape_5m"] is None


def test_immutable_issuance_round_trip_uses_recorded_cap_and_detects_tampering(monkeypatch, tmp_path):
    db_path = tmp_path / "adsi.db"
    monkeypatch.setattr(fe, "APP_DB_FILE", db_path)
    monkeypatch.setattr(fe, "MODEL_BUNDLE_FILE", tmp_path / "missing-model")
    monkeypatch.setattr(fe, "ARTIFACT_FILE", tmp_path / "missing-artifact")
    monkeypatch.setattr(fe, "slot_cap_kwh", lambda *_a, **_k: 1_000.0)
    inputs = _inputs()
    issuance_id = fe._capture_immutable_dayahead_issuance(
        DAY_S, _series(inputs), _issuance_weather(),
        constraint_snapshot=_constraint_snapshot(cap=1_000.0),
    )
    assert issuance_id
    with sqlite3.connect(db_path) as conn:
        generated_ts = conn.execute(
            "SELECT generated_ts FROM forecast_dayahead_issuance WHERE issuance_id=?", (issuance_id,)
        ).fetchone()[0]

    monkeypatch.setattr(fe, "slot_cap_kwh", lambda *_a, **_k: 10.0)
    loaded = fe._load_immutable_dayahead_bundle_from_db(DAY_S, generated_ts)
    assert loaded and loaded["issuance_id"] == issuance_id
    assert loaded["dayahead"][fe.SOLAR_START_SLOT] == pytest.approx(100.0)

    with sqlite3.connect(db_path) as conn:
        conn.execute(
            "UPDATE forecast_dayahead_immutable SET kwh_inc=kwh_inc+1 WHERE issuance_id=? AND slot=?",
            (issuance_id, fe.SOLAR_START_SLOT),
        )
        conn.commit()
    assert fe._load_immutable_dayahead_bundle_from_db(DAY_S, generated_ts) is None


def test_legacy_immutable_rows_are_quarantined_not_deleted(tmp_path):
    db_path = tmp_path / "adsi.db"
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            "CREATE TABLE forecast_dayahead_immutable(generated_ts INTEGER,date TEXT,slot INTEGER,kwh_inc REAL)"
        )
        conn.execute("INSERT INTO forecast_dayahead_immutable VALUES(1,?,?,?)", (DAY_S, 72, 4.0))
        conn.commit()
        fe._ensure_immutable_dayahead_tables(conn)
        conn.commit()
        quarantine = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'forecast_dayahead_immutable_legacy_quarantine%'"
        ).fetchone()[0]
        assert conn.execute(f"SELECT COUNT(*) FROM {quarantine}").fetchone()[0] == 1
        assert "issuance_id" in fe._sqlite_table_columns(conn, "forecast_dayahead_immutable")


def test_artifact_validation_is_strict_and_failed_temp_is_cleaned(monkeypatch, tmp_path):
    artifact_path = tmp_path / "activity.joblib"
    monkeypatch.setattr(fe, "ARTIFACT_FILE", artifact_path)
    invalid = {
        "schema_version": 2,
        "training_cutoff_date": "2026-05-01",
        "capacity_weighted_profiles": {"default": {
            "support_count": 1,
            "active_capacity_fraction": [0.0] * (fe.SLOTS_DAY - 1) + [float("nan")],
            "uncertainty": 0.0,
        }},
    }
    assert fe.save_forecast_artifacts(invalid) is False
    assert list(tmp_path.glob("*.tmp")) == []
    assert not artifact_path.exists()


@pytest.mark.parametrize("schema", [0, True, 1.9, "2"])
def test_artifact_schema_version_requires_exact_integer(schema):
    valid, reason = fe._validate_forecast_artifact({"schema_version": schema})
    assert valid is False
    assert reason in {"invalid_schema_version", "unsupported_schema_version"}


def test_allow_build_returns_none_unless_save_and_reload_validate(monkeypatch, tmp_path):
    monkeypatch.setattr(fe, "ARTIFACT_FILE", tmp_path / "artifact.joblib")
    monkeypatch.setattr(fe, "build_solcast_reliability_artifact", lambda *_a, **_k: None)
    monkeypatch.setattr(fe, "collect_history_days", lambda *_a, **_k: [{"day": "2026-05-01"}])
    monkeypatch.setattr(fe, "build_forecast_artifacts", lambda *_a, **_k: {
        "schema_version": 1, "activity_records": [{"day": "2026-05-01"}],
    })
    monkeypatch.setattr(fe, "save_forecast_artifacts", lambda *_a, **_k: False)
    assert fe.load_forecast_artifacts(today=DAY, allow_build=True) is None

    # A claimed save that did not produce a reloadable file also fails closed.
    monkeypatch.setattr(fe, "save_forecast_artifacts", lambda *_a, **_k: True)
    assert fe.load_forecast_artifacts(today=DAY, allow_build=True) is None


def test_live_and_future_1000h_masks_refresh_after_new_readings(monkeypatch, tmp_path):
    db_path = tmp_path / "adsi.db"
    monkeypatch.setattr(fe, "APP_DB_FILE", db_path)
    monkeypatch.setattr(fe, "ARCHIVE_DIR", tmp_path / "archive")
    monkeypatch.setattr(fe, "_get_inverter_node_map", lambda: {1: [1, 2, 3, 4]})
    with sqlite3.connect(db_path) as conn:
        conn.execute("CREATE TABLE readings(ts INTEGER, inverter INTEGER, unit INTEGER, alarm INTEGER)")
        conn.commit()

    for target in (datetime.now(fe._TZ_UTC8).date(), datetime.now(fe._TZ_UTC8).date() + timedelta(days=1)):
        target_s = target.isoformat()
        assert not fe._build_1000h_inverter_outage_mask(target_s).any()
        slot = 80
        ts = int(datetime.combine(target, datetime.min.time(), fe._TZ_UTC8).timestamp() * 1000) + slot * 300000
        with sqlite3.connect(db_path) as conn:
            conn.executemany(
                "INSERT INTO readings(ts,inverter,unit,alarm) VALUES(?,?,?,4096)",
                [(ts, 1, unit) for unit in (1, 2, 3, 4)],
            )
            conn.commit()
        fe._reset_forecast_cycle_cache()
        assert fe._build_1000h_inverter_outage_mask(target_s)[slot]


def test_atomic_intraday_rows_and_success_audit_preserve_prior_on_failure(monkeypatch, tmp_path):
    db_path = tmp_path / "adsi.db"
    monkeypatch.setattr(fe, "APP_DB_FILE", db_path)
    monkeypatch.setattr(fe, "FORECAST_CTX", tmp_path / "forecast.json")
    monkeypatch.setattr(fe, "_read_operation_mode", lambda: "gateway")
    with sqlite3.connect(db_path) as conn:
        fe._ensure_forecast_table(conn, "forecast_intraday_adjusted")
        conn.execute(
            """INSERT INTO forecast_intraday_adjusted(
                   date,ts,slot,time_hms,kwh_inc,kwh_lo,kwh_hi,source,updated_ts,series_run_id
               ) VALUES(?,?,?,?,?,?,?,?,?,?)""",
            (DAY_S, 1, fe.SOLAR_START_SLOT, "05:00:00", 7.0, 6.0, 8.0, "prior", 1, "IR-prior"),
        )
        conn.commit()

    series = _series(_inputs())
    for row in series:
        row["series_run_id"] = "IR-new"
    meta = {
        "series_run_id": "IR-new", "execution_mode": "active",
        "run_status": "success", "authoritative_write_status": "success",
        "output_updated_ts": 12345,
    }
    original_insert = fe._insert_intraday_run_audit_row
    monkeypatch.setattr(
        fe, "_insert_intraday_run_audit_row",
        lambda *_a, **_k: (_ for _ in ()).throw(RuntimeError("audit insert failed")),
    )
    assert fe._write_intraday_series_and_success_audit_atomic(
        DAY_S, series, meta, updated_ts=12345
    ) is False
    with sqlite3.connect(db_path) as conn:
        assert conn.execute(
            "SELECT kwh_inc,series_run_id FROM forecast_intraday_adjusted WHERE date=?",
            (DAY_S,),
        ).fetchall() == [(7.0, "IR-prior")]

    monkeypatch.setattr(fe, "_insert_intraday_run_audit_row", original_insert)
    assert fe._write_intraday_series_and_success_audit_atomic(
        DAY_S, series, meta, updated_ts=12345
    ) is True
    with sqlite3.connect(db_path) as conn:
        assert conn.execute(
            "SELECT COUNT(DISTINCT slot),COUNT(DISTINCT series_run_id) FROM forecast_intraday_adjusted WHERE date=?",
            (DAY_S,),
        ).fetchone() == (fe.SOLAR_SLOTS, 1)
        assert conn.execute(
            "SELECT run_status,series_run_id,output_updated_ts FROM forecast_intraday_run_audit WHERE target_date=?",
            (DAY_S,),
        ).fetchall() == [("success", "IR-new", 12345)]


def test_replay_aggregate_counts_distinct_paired_days_and_excludes_skipped_builder():
    horizons = (5, 15)

    def metrics(status="scored"):
        out = {"status": status, "remaining_day_total_ape_pct": 4.0 if status == "scored" else None}
        for horizon in horizons:
            out[f"scored_slots_{horizon}m"] = 1 if status == "scored" else 0
            out[f"wape_{horizon}m"] = 3.0 if status == "scored" else None
            out[f"mae_{horizon}m"] = 2.0 if status == "scored" else None
            out[f"rmse_{horizon}m"] = 2.5 if status == "scored" else None
        return out

    results = [
        {"target_date": DAY_S, "variants": {"current": metrics(), "robust_decay": metrics()}},
        {"target_date": DAY_S, "variants": {"current": metrics(), "robust_decay": metrics()}},
        {"target_date": (DAY + timedelta(days=1)).isoformat(), "variants": {
            "current": metrics(), "robust_decay": metrics("skipped_builder"),
        }},
    ]
    summary = fe._build_replay_aggregate(
        results, ("current", "robust_decay"), horizons, skipped_runs=2
    )
    assert summary["eligible_runs"] == 2
    assert summary["eligible_days"] == 1
    assert summary["excluded_ineligible_runs"] == 1
    assert summary["eligible_days_by_variant"]["robust_decay"] == 1


def test_parent_locked_child_runs_direct_once_without_python_lock_or_audit(monkeypatch):
    calls = []
    monkeypatch.setenv("ADSI_FORECAST_DIRECT_UNDER_PARENT_LOCK", "1")
    monkeypatch.setattr(fe, "clear_forecast_data_cache", lambda: None)
    monkeypatch.setattr(fe, "train_model", lambda *_a, **_k: True)
    monkeypatch.setattr(fe, "forecast_qa", lambda *_a, **_k: None)
    monkeypatch.setattr(fe, "_delegate_run_dayahead", lambda *_a, **_k: pytest.fail("delegated back to Node"))
    monkeypatch.setattr(fe, "_dayahead_gen_lock_acquire", lambda *_a, **_k: pytest.fail("child reacquired parent lock"))

    def run(*args, **kwargs):
        calls.append((args, kwargs))
        return True

    monkeypatch.setattr(fe, "run_dayahead", run)
    assert fe.run_manual_generation([DAY]) is True
    assert len(calls) == 1
    assert calls[0][1]["write_audit"] is False
    assert calls[0][1]["audit_generator_mode"] == "node_parent_locked_child"


def test_intraday_audit_outcomes_preserve_prior_and_timestamp_only_committed_output(monkeypatch):
    audits = []
    monkeypatch.setattr(fe, "_forecast_series_exists", lambda *_a, **_k: True)
    monkeypatch.setattr(fe, "_write_intraday_run_audit", lambda _day, meta: audits.append(dict(meta)) or 1)
    monkeypatch.setattr(
        fe,
        "build_intraday_adjusted_forecast",
        lambda _day: (None, {"execution_mode": "active", "run_status": "skipped", "observed_slots": 0}),
    )
    assert fe.run_intraday_adjusted(DAY) is False
    assert audits[-1]["run_status"] == "skipped"
    assert audits[-1]["authoritative_write_status"] == "preserved"
    assert audits[-1]["prior_series_preserved"] == 1
    assert "output_updated_ts" not in audits[-1]

    written = {}
    series = _series(_inputs())
    for row in series:
        row["series_run_id"] = "IR-test"
    monkeypatch.setattr(
        fe,
        "build_intraday_adjusted_forecast",
        lambda _day: (series, {
            "execution_mode": "active", "run_status": "success",
            "authoritative_algorithm": fe.NOWCAST_ALGORITHM_VERSION,
        }),
    )

    def write(_day, _series, meta, *, updated_ts=None):
        written["updated_ts"] = updated_ts
        written["meta"] = dict(meta)
        return True

    monkeypatch.setattr(fe, "_write_intraday_series_and_success_audit_atomic", write)
    assert fe.run_intraday_adjusted(DAY) is True
    assert written["meta"]["output_updated_ts"] == written["updated_ts"]
    assert written["meta"]["authoritative_write_status"] == "success"
    assert written["meta"]["prior_series_preserved"] == 0
    assert len(audits) == 1  # success audit is part of the atomic writer


def test_completed_shadow_scorer_uses_exact_stored_checkpoints(monkeypatch, tmp_path):
    db_path = tmp_path / "adsi.db"
    monkeypatch.setattr(fe, "APP_DB_FILE", db_path)
    monkeypatch.setattr(fe, "MODEL_BUNDLE_FILE", tmp_path / "missing-model")
    monkeypatch.setattr(fe, "ARTIFACT_FILE", tmp_path / "missing-artifact")
    monkeypatch.setattr(fe, "slot_cap_kwh", lambda *_a, **_k: 1_000.0)
    inputs = _inputs()
    issuance_id = fe._capture_immutable_dayahead_issuance(
        DAY_S, _series(inputs), _issuance_weather(),
        constraint_snapshot=_constraint_snapshot(),
    )
    assert issuance_id
    with sqlite3.connect(db_path) as conn:
        issuance_ts = conn.execute(
            "SELECT generated_ts FROM forecast_dayahead_issuance WHERE issuance_id=?", (issuance_id,)
        ).fetchone()[0]
        fe._ensure_intraday_audit_table(conn)
        future_count = fe.SOLAR_END_SLOT - 81
        checkpoints = {}
        for minutes in fe.NOWCAST_REPLAY_HORIZONS_MIN:
            slot = 80 + int(np.ceil(minutes / fe.SLOT_MIN))
            checkpoints[str(minutes)] = {
                "slot": slot,
                "time": f"{slot * fe.SLOT_MIN // 60:02d}:{slot * fe.SLOT_MIN % 60:02d}:00",
                "p10_kwh": 80.0,
                "p50_kwh": 100.0,
                "p90_kwh": 120.0,
            }
        checkpoints["remaining_day"] = {
            "p10_kwh": 80.0 * future_count,
            "p50_kwh": 100.0 * future_count,
            "p90_kwh": 120.0 * future_count,
        }
        notes = {
            "checkpoints": checkpoints
        }
        conn.execute(
            """
            INSERT INTO forecast_intraday_run_audit(
                target_date, generated_ts, cutoff_slot, algorithm_version,
                execution_mode, run_status, notes_json
            ) VALUES(?,?,?,?,?,?,?)
            """,
            (DAY_S, issuance_ts + 1, 80, fe.NOWCAST_ALGORITHM_VERSION, "shadow", "success", json.dumps(notes)),
        )
        conn.commit()

    actual = np.zeros(fe.SLOTS_DAY)
    actual[fe.SOLAR_START_SLOT:fe.SOLAR_END_SLOT] = 110.0
    present = np.zeros(fe.SLOTS_DAY, dtype=bool)
    present[fe.SOLAR_START_SLOT:fe.SOLAR_END_SLOT] = True
    monkeypatch.setattr(fe, "load_actual_loss_adjusted_with_presence", lambda *_a, **_k: (actual, present))
    monkeypatch.setattr(
        fe, "build_operational_constraint_mask",
        lambda *_a, **_k: (np.zeros(fe.SLOTS_DAY, dtype=bool), {
            "cap_dispatch_mask": np.zeros(fe.SLOTS_DAY, dtype=bool),
            "manual_constraint_mask": np.zeros(fe.SLOTS_DAY, dtype=bool),
        }),
    )
    monkeypatch.setattr(fe, "_query_1000h_inverter_outage_mask", lambda *_a, **_k: np.zeros(fe.SLOTS_DAY, dtype=bool))
    outcome = fe.score_completed_shadow_checkpoints(DAY, persist=True)
    assert outcome["audits_scored"] == 1
    with sqlite3.connect(db_path) as conn:
        stored = json.loads(conn.execute(
            "SELECT notes_json FROM forecast_intraday_run_audit WHERE target_date=?", (DAY_S,)
        ).fetchone()[0])["checkpoint_scores"]
    assert stored["issuance_id"] == issuance_id
    assert stored["horizons"]["5"]["absolute_error_kwh"] == pytest.approx(10.0)
    assert stored["horizons"]["5"]["scored_slot_count"] == 1
    assert stored["remaining_day"]["status"] == "scored"
    assert stored["remaining_day"]["scored_slot_count"] == future_count


def test_build_identity_source_ignores_stale_json_and_frozen_fails_closed(monkeypatch, tmp_path):
    monkeypatch.delattr(sys, "frozen", raising=False)
    monkeypatch.delattr(sys, "_MEIPASS", raising=False)
    monkeypatch.setattr(fe, "_git_commit_hash", lambda: "a" * 40)
    original_sha = fe._file_sha256
    monkeypatch.setattr(fe, "_file_sha256", lambda path: "b" * 64 if path == fe.Path(fe.__file__).resolve() else original_sha(path))
    monkeypatch.setattr(
        fe.subprocess,
        "run",
        lambda *_a, **_k: subprocess.CompletedProcess([], 0, stdout=" M services/forecast_engine.py\n", stderr=""),
    )
    source = fe.resolve_forecast_build_identity()
    assert source["source_hash"] == "b" * 64
    assert source["git_dirty"] is True
    assert source["promotion_eligible"] is False

    valid = {
        "schema_version": 1, "package_version": "9.9.9", "git_commit": "c" * 40,
        "git_dirty": False, "git_status_available": True, "build_timestamp": 1,
        "build_timestamp_utc": "1970-01-01T00:00:00.001Z", "source_hash": "d" * 64,
        "build_channel": "signed-release", "source_path": "services/forecast_engine.py",
        "artifact_compatibility_version": 1, "identity_status": "verified",
        "promotion_eligible": True, "release_base_ref_available": True,
        "release_base_ref": "origin/main",
        "commits_behind_release_base": 0, "package_version_tag_exists": False,
        "release_ready": True,
    }
    (tmp_path / "forecast-build-info.json").write_text(json.dumps(valid), encoding="utf-8")
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "_MEIPASS", str(tmp_path), raising=False)
    frozen = fe.resolve_forecast_build_identity()
    assert frozen["package_version"] == "9.9.9"
    assert frozen["promotion_eligible"] is True

    valid["build_channel"] = "development"
    (tmp_path / "forecast-build-info.json").write_text(json.dumps(valid), encoding="utf-8")
    development = fe.resolve_forecast_build_identity()
    assert development["identity_status"] == "verified"
    assert development["promotion_eligible"] is False

    valid["build_channel"] = "signed-release"
    valid["build_timestamp"] = True
    (tmp_path / "forecast-build-info.json").write_text(json.dumps(valid), encoding="utf-8")
    bad_timestamp = fe.resolve_forecast_build_identity()
    assert bad_timestamp["identity_status"] == "unverified"
    assert bad_timestamp["promotion_eligible"] is False

    valid["build_timestamp"] = 1
    valid["git_commit"] = "short"
    (tmp_path / "forecast-build-info.json").write_text(json.dumps(valid), encoding="utf-8")
    invalid = fe.resolve_forecast_build_identity()
    assert invalid["identity_status"] == "unverified"
    assert invalid["promotion_eligible"] is False
