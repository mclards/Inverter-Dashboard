"""Tests for capacity-weighted, energy-derived activity artifacts."""

import numpy as np
import pytest

from services import forecast_engine as fe


def test_sustained_activity_rejects_single_slot_spike():
    values = np.zeros(fe.SLOTS_DAY)
    values[70] = 10.0
    mask = fe._sustained_activity_mask(values, capacity_slot_kwh=10.0)
    assert not mask.any()


def test_sustained_activity_has_activation_and_deactivation_hysteresis():
    values = np.zeros(fe.SLOTS_DAY)
    values[70:80] = 2.0
    values[80:82] = 0.0
    values[82:90] = 2.0
    values[90:93] = 0.0
    mask = fe._sustained_activity_mask(values, capacity_slot_kwh=10.0)
    assert mask[70:80].all()
    assert mask[80:82].all()
    assert not mask[90:93].any()


def test_capacity_weighted_profile_and_rejection_reasons(monkeypatch):
    monkeypatch.setattr(fe, "_get_inverter_node_map", lambda: {1: [1, 2], 2: [1]})
    inv1 = np.zeros(fe.SLOTS_DAY); inv1[65:90] = 5.0
    inv2 = np.zeros(fe.SLOTS_DAY); inv2[75:85] = 5.0
    monkeypatch.setattr(fe, "_load_inverter_energy_for_day", lambda day: {1: inv1, 2: inv2})
    monkeypatch.setattr(fe, "_load_energy_reporting_coverage", lambda day: np.ones(fe.SLOTS_DAY))
    clean = {"day": "2026-05-01", "cap_dispatch_mask": np.zeros(fe.SLOTS_DAY), "inverter_outage_mask": np.zeros(fe.SLOTS_DAY)}
    capped = {"day": "2026-05-02", "cap_dispatch_mask": np.r_[np.zeros(70), np.ones(1), np.zeros(fe.SLOTS_DAY - 71)], "inverter_outage_mask": np.zeros(fe.SLOTS_DAY)}
    profiles, reasons = fe._build_capacity_weighted_activity_profiles([clean, capped])
    profile = profiles["default"]["active_capacity_fraction"]
    assert profiles["default"]["support_count"] == 1
    assert profile[68] == pytest.approx(2 / 3)
    assert profile[78] == 1.0
    assert reasons["cap_dispatch_day"] == 1


def test_artifact_schema_v1_and_v2_compatibility(monkeypatch, tmp_path):
    artifact_path = tmp_path / "activity.joblib"
    monkeypatch.setattr(fe, "ARTIFACT_FILE", artifact_path)
    v1 = {"schema_version": 1, "activity_records": [{"day": "2026-05-01"}]}
    fe.dump(v1, artifact_path)
    assert fe.load_forecast_artifacts() == v1
    v2 = {
        "schema_version": 2,
        "training_cutoff_date": "2026-05-02",
        "activity_records": [],
        "capacity_weighted_profiles": {"default": {
            "support_count": 1,
            "active_capacity_fraction": [0.0] * fe.SLOTS_DAY,
            "uncertainty": 0.0,
        }},
    }
    fe.dump(v2, artifact_path)
    assert fe.load_forecast_artifacts() == v2
