"""Regression tests for leakage-safe virtual-nowcast rollout."""

from datetime import date

import numpy as np
import pandas as pd
import pytest

from services import forecast_engine as fe


def _inputs(actual_scale=1.2, cutoff=80):
    dayahead = np.zeros(fe.SLOTS_DAY, dtype=float)
    dayahead[fe.SOLAR_START_SLOT:fe.SOLAR_END_SLOT] = 100.0
    actual = np.zeros(fe.SLOTS_DAY, dtype=float)
    actual[fe.SOLAR_START_SLOT:cutoff + 1] = 100.0 * actual_scale
    present = np.zeros(fe.SLOTS_DAY, dtype=bool)
    present[fe.SOLAR_START_SLOT:cutoff + 1] = True
    return {
        "dayahead": dayahead,
        "dayahead_present": dayahead > 0,
        "actual": actual,
        "actual_present": present,
        "outage_mask": np.zeros(fe.SLOTS_DAY, dtype=bool),
        "cap_dispatch_mask": np.zeros(fe.SLOTS_DAY, dtype=bool),
        "constraint_meta": {},
    }


def _patch_robust_dependencies(monkeypatch, inputs):
    monkeypatch.setattr(fe, "_load_intraday_inputs", lambda _day: inputs)
    monkeypatch.setattr(fe, "_load_energy_reporting_coverage", lambda _day: np.ones(fe.SLOTS_DAY))
    monkeypatch.setattr(fe, "curtailed_mask", lambda *_a, **_k: np.zeros(fe.SLOTS_DAY, dtype=bool))
    monkeypatch.setattr(fe, "slot_cap_kwh", lambda *_a, **_k: 1_000.0)
    monkeypatch.setattr(fe, "_intraday_weather_frame", lambda _day: pd.DataFrame(index=range(fe.SLOTS_DAY)))
    monkeypatch.setattr(
        fe,
        "_load_dayahead_bands_from_db",
        lambda _day: (inputs["dayahead"] * 0.8, inputs["dayahead"] * 1.2),
    )
    monkeypatch.setattr(fe, "_setting_float_or_none", lambda *_a, **_k: None)


def _series_values(series):
    return np.asarray([float(row["kWh_inc"]) for row in series], dtype=float)


def test_weighted_median_rejects_outlier():
    value = fe._weighted_median(np.array([0.0, 0.02, 0.03, 5.0]), np.ones(4))
    assert value == pytest.approx(0.02)


def test_half_life_decay():
    assert fe._nowcast_short_weight(0) == pytest.approx(1.0)
    assert fe._nowcast_short_weight(fe.NOWCAST_HALF_LIFE_MINUTES) == pytest.approx(0.5)
    assert fe._nowcast_short_weight(fe.NOWCAST_HALF_LIFE_MINUTES * 2) == pytest.approx(0.25)


def test_robust_nowcast_decays_and_preserves_ordered_bands(monkeypatch):
    inputs = _inputs(cutoff=80)
    _patch_robust_dependencies(monkeypatch, inputs)
    series, meta = fe._build_robust_intraday_nowcast(date(2026, 5, 10), cutoff_slot=80)
    assert meta["run_status"] == "success"
    assert meta["actual_source"] == "pac_loss_adjusted"
    assert meta["eligible_slots"] >= fe.INTRADAY_MIN_OBS_SLOTS
    by_slot = {fe._parse_slot_from_time_text("2026-05-10", r["time"]): r for r in series}
    near = float(by_slot[81]["kWh_inc"])
    far = float(by_slot[120]["kWh_inc"])
    assert near > far > 100.0
    for row in series:
        assert np.isfinite([row["kWh_lo"], row["kWh_inc"], row["kWh_hi"]]).all()
        assert row["kWh_lo"] <= row["kWh_inc"] <= row["kWh_hi"]


def test_future_actuals_cannot_leak_before_cutoff(monkeypatch):
    inputs = _inputs(cutoff=100)
    inputs["actual"][81:101] = 900.0
    inputs["actual_present"][81:101] = True
    _patch_robust_dependencies(monkeypatch, inputs)
    series_a, meta_a = fe._build_robust_intraday_nowcast(date(2026, 5, 10), cutoff_slot=80)
    inputs["actual"][81:101] = 1.0
    series_b, meta_b = fe._build_robust_intraday_nowcast(date(2026, 5, 10), cutoff_slot=80)
    assert _series_values(series_a) == pytest.approx(_series_values(series_b))
    assert meta_a["recent_log_ratio"] == pytest.approx(meta_b["recent_log_ratio"])
    assert meta_a["eligible_slots"] == meta_b["eligible_slots"]


def test_strict_exclusions_do_not_cascade_to_contaminated_slots(monkeypatch):
    inputs = _inputs(cutoff=66)
    inputs["cap_dispatch_mask"][60:63] = True
    inputs["outage_mask"][63:65] = True
    _patch_robust_dependencies(monkeypatch, inputs)
    coverage = np.ones(fe.SLOTS_DAY)
    coverage[65:67] = 0.2
    monkeypatch.setattr(fe, "_load_energy_reporting_coverage", lambda _day: coverage)
    _series, meta = fe._build_robust_intraday_nowcast(date(2026, 5, 10), cutoff_slot=66)
    assert meta["excluded_cap_slots"] == 3
    assert meta["excluded_outage_slots"] == 2
    assert meta["excluded_quality_slots"] == 2
    assert meta["eligible_slots"] < fe.INTRADAY_MIN_OBS_SLOTS
    assert meta["fallback_reason"] == "insufficient_eligible_slots"


def test_active_and_shadow_rollout_semantics(monkeypatch):
    current = [{"time": "05:00:00", "kWh_inc": 1.0, "kWh_lo": 0.8, "kWh_hi": 1.2}]
    challenger = [{"time": "05:00:00", "kWh_inc": 2.0, "kWh_lo": 1.8, "kWh_hi": 2.2}]
    monkeypatch.setattr(fe, "_build_current_intraday_adjusted_forecast", lambda *_a, **_k: (current, {"algorithm_version": fe.NOWCAST_CURRENT_ALGORITHM_VERSION}))
    monkeypatch.setattr(fe, "_build_robust_intraday_nowcast", lambda *_a, **_k: (challenger, {"algorithm_version": fe.NOWCAST_ALGORITHM_VERSION, "run_status": "success"}))
    shadow_series, shadow_meta = fe.build_intraday_adjusted_forecast(date(2026, 5, 10), mode_override="shadow")
    active_series, active_meta = fe.build_intraday_adjusted_forecast(date(2026, 5, 10), mode_override="active")
    assert shadow_series is current
    assert shadow_meta["authoritative_algorithm"] == fe.NOWCAST_CURRENT_ALGORITHM_VERSION
    assert shadow_meta["challenger_would_write"] is True
    assert active_series is challenger
    assert active_meta["authoritative_algorithm"] == fe.NOWCAST_ALGORITHM_VERSION


def test_active_automatically_falls_back_to_current(monkeypatch):
    current = [{"time": "05:00:00", "kWh_inc": 1.0, "kWh_lo": 0.8, "kWh_hi": 1.2}]
    monkeypatch.setattr(fe, "_build_current_intraday_adjusted_forecast", lambda *_a, **_k: (current, {"algorithm_version": fe.NOWCAST_CURRENT_ALGORITHM_VERSION}))
    monkeypatch.setattr(fe, "_build_robust_intraday_nowcast", lambda *_a, **_k: (None, {"algorithm_version": fe.NOWCAST_ALGORITHM_VERSION, "run_status": "fallback", "fallback_reason": "insufficient_eligible_slots"}))
    series, meta = fe.build_intraday_adjusted_forecast(date(2026, 5, 10), mode_override="active")
    assert series is current
    assert meta["authoritative_algorithm"] == fe.NOWCAST_CURRENT_ALGORITHM_VERSION
    assert meta["run_status"] == "success"
    assert meta["fallback_used"] is True
    assert meta["challenger_status"] == "fallback"


def test_replay_dry_run_never_persists(monkeypatch):
    inputs = _inputs(cutoff=100)
    inputs.update({
        "dayahead_lo": inputs["dayahead"] * 0.8,
        "dayahead_hi": inputs["dayahead"] * 1.2,
        "weather_frame": pd.DataFrame(index=range(fe.SLOTS_DAY)),
        "capacity_coverage": np.ones(fe.SLOTS_DAY),
        "slot_cap_kwh": 1_000.0,
        "replay_provenance": {"issuance_id": "DI-test", "basis_checksum": "a" * 64},
    })
    monkeypatch.setattr(fe, "_build_replay_intraday_input_bundle", lambda *_a, **_k: inputs)
    base_series = fe.to_ui_series(inputs["dayahead"], inputs["dayahead"] * 0.8, inputs["dayahead"] * 1.2, "2026-05-10")
    monkeypatch.setattr(fe, "_build_current_intraday_adjusted_forecast", lambda *_a, **_k: (base_series, {}))
    monkeypatch.setattr(fe, "_build_robust_intraday_nowcast", lambda *_a, **_k: (base_series, {}))
    monkeypatch.setattr(fe, "_load_nowcast_baseline_link", lambda: {"baseline_id": "BL-test", "baseline_sha256": "b" * 64, "promotion_eligible": False})
    monkeypatch.setattr(fe, "_save_json", lambda *_a, **_k: pytest.fail("dry replay attempted persistence"))
    result = fe.replay_intraday_nowcast(date(2026, 5, 10), 80, persist=False)
    assert result["persisted_to_live_tables"] is False
    assert result["actual_provenance"] == "pac_loss_adjusted"


def test_intraday_audit_is_gateway_only(monkeypatch):
    monkeypatch.setattr(fe, "_read_operation_mode", lambda: "remote")
    monkeypatch.setattr(fe, "_open_sqlite", lambda *_a, **_k: pytest.fail("remote audit opened SQLite"))
    assert fe._write_intraday_run_audit("2026-05-10", {}) is None


def test_weather_derivatives_are_causal_candidates_only():
    frame = pd.DataFrame({
        "cloud": np.arange(fe.SLOTS_DAY, dtype=float),
        "temp": np.arange(fe.SLOTS_DAY, dtype=float) * 2,
        "rad": np.arange(fe.SLOTS_DAY, dtype=float) ** 2,
    })
    candidates = fe.build_weather_derivative_candidates(frame)
    changed_future = frame.copy()
    changed_future.loc[100:, ["cloud", "temp", "rad"]] = 1e9
    candidates_changed = fe.build_weather_derivative_candidates(changed_future)
    assert candidates.loc[:99].equals(candidates_changed.loc[:99])
    assert not set(candidates.columns).intersection(fe.FEATURE_COLS)


def test_current_builder_constraint_fallback_cascades(monkeypatch):
    inputs = _inputs(cutoff=fe.SOLAR_START_SLOT + fe.INTRADAY_MIN_OBS_SLOTS + 2)
    # Give it enough solar slots but mask them out
    inputs["outage_mask"][fe.SOLAR_START_SLOT:] = True
    _patch_robust_dependencies(monkeypatch, inputs)
    monkeypatch.setattr(fe, "confidence_bands", lambda *_a, **_k: (np.zeros(fe.SLOTS_DAY), np.zeros(fe.SLOTS_DAY)))
    
    # 1. unconstrained fails (outage=True), cap-free succeeds (cap_dispatch=False)
    series, meta = fe._build_current_intraday_adjusted_forecast(date(2026, 5, 10))
    assert meta["constraint_mode"] == "cap-free"

    # 2. cap-free also fails (cap_dispatch=True), fallback to all-observed succeeds
    inputs["cap_dispatch_mask"][fe.SOLAR_START_SLOT:] = True
    series, meta = fe._build_current_intraday_adjusted_forecast(date(2026, 5, 10))
    assert meta["constraint_mode"] == "all-observed"

    # 3. all-observed fails (not enough actuals present)
    inputs["actual_present"][fe.SOLAR_START_SLOT:] = False
    series, meta = fe._build_current_intraday_adjusted_forecast(date(2026, 5, 10))
    assert series is None
    assert meta["constraint_mode"] == "all-observed"
    assert meta["observed_slots"] == 0


def test_load_forecast_artifacts_rejects_future_cutoff(monkeypatch, tmp_path):
    artifact_path = tmp_path / "activity.joblib"
    monkeypatch.setattr(fe, "ARTIFACT_FILE", artifact_path)
    # 1. Valid artifact (cutoff is before target date)
    v2_valid = {
        "schema_version": 2,
        "training_cutoff_date": "2026-05-01",
        "capacity_weighted_profiles": {"default": {
            "support_count": 1,
            "active_capacity_fraction": [0.0] * fe.SLOTS_DAY,
            "uncertainty": 0.0,
        }},
    }
    fe.dump(v2_valid, artifact_path)
    assert fe.load_forecast_artifacts(today=date(2026, 5, 2)) == v2_valid
    
    # 2. Invalid artifact (cutoff is after target date)
    v2_invalid = {
        "schema_version": 2,
        "training_cutoff_date": "2026-05-03",
        "capacity_weighted_profiles": {"default": {
            "support_count": 1,
            "active_capacity_fraction": [0.0] * fe.SLOTS_DAY,
            "uncertainty": 0.0,
        }},
    }
    fe.dump(v2_invalid, artifact_path)
    assert fe.load_forecast_artifacts(today=date(2026, 5, 2)) is None

    # 3. Invalid schema generation in save_forecast_artifacts
    assert fe.save_forecast_artifacts({"schema_version": 2}) is False
    assert fe.save_forecast_artifacts({"schema_version": 1}) is True
