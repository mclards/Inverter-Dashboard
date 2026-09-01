# Forecast ML Training & Day-Ahead Generation Integrity Evaluation

**File**: `evals/forecast-ml-dayahead-integrity.md`
**Engine**: `services/forecast_engine.py` (14,923 lines)
**Site**: Davao del Sur Solar Plant — `LAT 6.772269°N, LON 125.284455°E` (UTC+8)
**Scope**: This document is the authoritative evaluation specification for:

1. [ML Training Pipeline Integrity](#1-ml-training-pipeline-integrity)
2. [Day-Ahead Generation Integrity](#2-day-ahead-generation-integrity)
3. [QA Comparison & Eligibility Gates](#3-qa-comparison--eligibility-gates)
4. [Error Memory Bias Correction](#4-error-memory-bias-correction)
5. [EMOS-B Spread Calibration](#5-emos-b-spread-calibration)
6. [Automated Evaluation Assertions](#6-automated-evaluation-assertions)
7. [Health State Contract — `ml_train_state.json`](#7-health-state-contract--ml_train_statejson)
8. [Database Table Contracts](#8-database-table-contracts)
9. [Failure Modes & Escalation Matrix](#9-failure-modes--escalation-matrix)

> **Relationship to `SYSTEM_REVIEW_AND_EVALUATION.md`**: That document provides a broad operational overview (Section 5 covers forecast at a summary level with headline MAPE/RMSE metrics). **This document is complementary and non-overlapping** — it specifies per-slot pass/fail thresholds, gate logic from code constants, and actionable SQL assertions that can be run against the live database.

---

## Site & Plant Constants (Authoritative)

| Constant | Value | Source |
|---|---|---|
| `LAT`, `LON` | `6.772269°N`, `125.284455°E` | `forecast_engine.py:82–196` |
| Solar window | `05:00–17:55 PHT` | engine |
| Slot resolution | 5 minutes | engine |
| Slots per solar day | **156** | engine |
| `UNIT_KW_MAX` | `997.64 kW` per inverter (4 × 249.41 kW Pmax) | engine |
| `UNIT_KW_DEPENDABLE` | `906.92 kW` per inverter (4 × 226.73 kW Pnom) | engine |
| `EXPORT_MW` | `24.0 MW` (default export ceiling) | engine |
| `PLANT_MW_FALLBACK` | `26.94 MW` | engine |
| `GAMMA_TC` | `-0.004 /°C` (temperature coefficient) | engine |
| `TEMP_REF_C` | `25°C` | engine |
| `eta_inverter` | `≈ 98.6%` | engine |
| Day-ahead run times | **06:00 and 18:00 PHT** (`DA_RUN_HOURS_PRIMARY = {6, 18}`) | engine |

---
## 1. ML Training Pipeline Integrity

### 1.1 Training Window & Data Collection

The engine collects historical data via `collect_history_days()` before calling
`collect_training_data_hardened()`. The training window is a **rolling** lookback
that expires old data automatically.

| Parameter | Value | Evaluation Criterion |
|---|---|---|
| `N_TRAIN_DAYS` | **45 days** | Training data must span ≤ 45 calendar days from `target_date` |
| `SHAPE_LOOKBACK_DAYS` | **45 days** | Diurnal shape extraction window; must equal `N_TRAIN_DAYS` |
| `MIN_TRAIN_DAYS` | **5 days** | If `valid_days < 5`, training is **rejected** — ML not activated |
| `MIN_SAMPLES` | **60 slots/day** | Days with fewer than 60 usable 5-minute slots are excluded |

**Pass criteria**:
- `ml_train_state.json → training_samples_count` ≥ `MIN_TRAIN_DAYS × MIN_SAMPLES = 300`
- Training date range in state is ≤ 45 days older than the `last_training_date` field
- `valid_days` field (if present in state) ≥ `MIN_TRAIN_DAYS = 5`

**Fail condition**:
`consecutive_train_rejection_count ≥ 1` → at least one training cycle failed to meet minimum-data requirements. Escalation triggers at count ≥ `_TRAIN_REJECTION_ALERT_THRESHOLD = 3`.

---

### 1.2 Anomaly Rejection Gates

During `collect_training_data_hardened()`, each candidate training day passes through
**three anomaly gates**. A day failing any gate is excluded from the training set and
does **not** increment `valid_days`.

| Gate | Constant | Threshold | Meaning |
|---|---|---|---|
| Capacity factor floor | `ANOM_MIN_CF` | **0.02** | Day rejected if CF < 2% (effectively dark/shutdown) |
| Capacity factor ceiling | `ANOM_MAX_CF` | **1.05** | Day rejected if CF > 105% (sensor spike / data error) |
| Radiation-generation correlation | `ANOM_RAD_CORR` | **0.55** | Day rejected if Pearson r(GHI, P_gen) < 0.55 |

**Pass criteria for each training day**:
```
0.02 ≤ CF ≤ 1.05
AND
Pearson_r(GHI_timeseries, P_gen_timeseries) ≥ 0.55
```

---

### 1.3 Outage Detection & Severity Classification

| Parameter | Value | Condition |
|---|---|---|
| `AVAIL_OUTAGE_THRESHOLD` | **0.95** | Slot power ratio below which slot is outage-tainted |
| `AVAIL_DAY_MINOR_PCT` | **0.05** | Day is `minor` outage if 0–5% slots tainted |
| `AVAIL_DAY_MODERATE_PCT` | **0.15** | Day is `moderate` outage if 5–15% slots tainted |
| `AVAIL_DAY_SEVERE_PCT` | **0.30** | Day is `severe` outage if > 30% slots tainted |
| `EST_ACTUAL_WEIGHT_FACTOR` | **0.93** | 7% discount when satellite-reconstructed actual is used |

**Severity → training inclusion policy**:
- `no_outage` → included at full weight
- `minor` → included; may carry reduced weight
- `moderate` → included with warning flag; `outage_days_detected` data warning emitted
- `severe` → **excluded** from training set; contributes to rejection count

**Pass criterion**: `ml_train_state.json → outage_summary` lists ≤ 20% of training
window days as `moderate`/`severe`.

---

### 1.4 Recency Weighting

| Parameter | Value | Effect |
|---|---|---|
| `TRAIN_WEIGHT_HALF_LIFE_DAYS` | **14.0 days** | Weight halves every 14 days |
| `TRAIN_WEIGHT_FLOOR` | **0.18** | Oldest samples never drop below 18% weight |

**Weight formula**:
```
w(d) = max(0.5^(d / 14.0), 0.18)
```
where `d` = days before `target_date`.

| Day offset | Weight |
|---|---|
| d=0 (yesterday) | 1.000 |
| d=14 | 0.500 |
| d=28 | 0.250 → floored to **0.18** |
| d=44 (max window edge) | **0.18** (floor active) |

---

### 1.5 ML Backend Selection

| Backend | Condition | `ml_backend_type` value |
|---|---|---|
| LightGBM | `FORECAST_USE_LIGHTGBM=1` AND `lightgbm` importable | `lightgbm` |
| scikit-learn GBR | LightGBM unavailable or env flag unset | `sklearn_gbr` |

`ml_train_state.json → status_flags` must contain `backend_fallback: true` if
scikit-learn is in use on a production system. This is a **WARNING** condition.

```bash
# On the Linux appliance:
python3 -c "import lightgbm; print('LightGBM OK:', lightgbm.__version__)"
```

---

### 1.6 Global vs. Regime Model Formation

**Weather Regime Buckets** (6 categories):

| Regime | Key Discriminants |
|---|---|
| `clear_stable` | High `Kt` (clearness index), low cloud cover %, negligible rain |
| `clear_edge` | Moderate `Kt`, some scattered cloud, no rain |
| `mixed_stable` | Low–moderate `Kt`, patchy cloud cover |
| `mixed_volatile` | Low `Kt`, high DRAD (diffuse ratio), variable |
| `overcast` | Very low `Kt`, high cloud cover % |
| `rainy` | Rain mm > threshold, low `Kt`, high CAPE |

**Regime model formation thresholds**:

| Parameter | Value | Condition |
|---|---|---|
| `REGIME_MODEL_MIN_DAYS` | **6** | Standard: regime model formed only if ≥ 6 training days in regime |
| `REGIME_MODEL_MIN_DAYS_TRANSITION` | **3** | Relaxed threshold during regime-transition periods |
| `REGIME_MODEL_MIN_SAMPLES` | **320** | Minimum total slot samples within regime for model formation |

**Pass criteria**:
- `training_regimes_count = 0` → `no_regime_data` warning must appear in `data_warnings`
- Each formed regime model is trained on ≥ 320 samples
- `training_features_count` must be ≈ 28–35

---

### 1.7 ML Blend Weights & Ramp Slot Damping

| Parameter | Value | Meaning |
|---|---|---|
| `ML_BLEND_MIN` | **0.35** | ML component never contributes less than 35% |
| `ML_BLEND_MAX` | **1.00** | ML component may contribute up to 100% when confident |
| `ML_BLEND_ALPHA` | **0.45** | Exponential smoothing factor applied to blend history |
| `RAMP_SLOT_BLEND_SCALE` | **0.62** | At ramp slots, ML weight is reduced by 38% |

**Effective ramp blend floor**:
```
ramp_blend_min = 0.35 × 0.62 ≈ 0.217
```

---

### 1.8 Error Classifier (5-Class Bias Predictor)

| Class | Meaning |
|---|---|
| `strong_over` | Forecast will significantly exceed actual |
| `mild_over` | Forecast will modestly exceed actual |
| `neutral` | Forecast and actual within normal error band |
| `mild_under` | Forecast will modestly underestimate actual |
| `strong_under` | Forecast will significantly underestimate actual |

**Pass criteria**:
- All 5 classes must appear in training data at least once per cycle
- Predicted class stored in day-ahead advisory metadata (`forecast_run_audit → notes_json`)
- Class prediction accuracy ≥ 55% on `eligible` QA rows over any 30-day window

---

### 1.9 Training Rejection Streak Escalation

| State | Threshold | Action |
|---|---|---|
| `consecutive_train_rejection_count = 0` | — | Normal; ML active |
| Count 1–2 | Below alert | ML uses previous bundle; log INFO |
| Count ≥ 3 | `_TRAIN_REJECTION_ALERT_THRESHOLD = 3` | **WARNING** logged; `high_rejection_streak` in `data_warnings` |
| No bundle file | — | Engine falls back to `physics_only` variant |

**Pass criterion**: Count must be `0` on any healthy production morning after 06:00 PHT run.

---

### 1.10 Model Bundle Integrity

| File | Contents |
|---|---|
| `pv_dayahead_model_bundle.joblib` | Active bundle: global + regime models + error classifier + scaler |
| `pv_dayahead_model_bundle.joblib.prev1` | Previous checkpoint |
| `pv_dayahead_model_bundle.joblib.prev2` | Checkpoint –2 |
| `pv_dayahead_model_bundle.joblib.prev3` | Checkpoint –3 (oldest retained) |

SHA-256 stored in `ml_train_state.json → model_file_sha256`. On bundle load,
engine re-computes SHA-256 and rejects the file if it does not match — automatic
rollback to `.prev1`.

```bash
# Verify bundle checksum integrity on the appliance:
python3 -c "
import hashlib, json, pathlib
base = pathlib.Path('/opt/inverter-dashboard/data/forecast')
state = json.loads((base / 'ml_train_state.json').read_text())
bundle = base / 'pv_dayahead_model_bundle.joblib'
sha = hashlib.sha256(bundle.read_bytes()).hexdigest()
expected = state['model_file_sha256']
print('PASS' if sha == expected else f'FAIL: {sha} != {expected}')
"
```

---
## 2. Day-Ahead Generation Integrity

### 2.1 Forecast Variant Selection & Fallback Chain

```
solcast_direct (Solcast-only, no ML residual)
    ↓
ml_solcast_hybrid (fresh Solcast + ML residual)       ← PREFERRED
    ↓
ml_solcast_hybrid_stale (stale Solcast + ML residual) ← DEGRADED
    ↓
ml_without_solcast (ML-only, physics-seeded)          ← DEGRADED
    ↓
physics_only (clear-sky physics formula only)          ← FALLBACK
```

| Variant | Production Status |
|---|---|
| `ml_solcast_hybrid` | **PASS** (preferred) |
| `solcast_direct` | **ACCEPTABLE** (no ML bundle yet) |
| `ml_solcast_hybrid_stale` | **WARNING** (stale Solcast) |
| `ml_without_solcast` | **ALERT** (Solcast unavailable) |
| `physics_only` | **CRITICAL** (ML + Solcast both failed) |

---

### 2.2 Solcast Freshness Gate Pipeline

| Class | Coverage Threshold | Effect on Variant |
|---|---|---|
| `fresh` | ≥ **0.95** (95%) | Full use; `ml_solcast_hybrid` eligible |
| `stale_usable` | ≥ **0.80** (80%) | Downgraded; `ml_solcast_hybrid_stale` |
| `stale_reject` | < 0.80 | Solcast rejected; falls to `ml_without_solcast` |
| `missing` | No snapshot for target date | Same fallback as `stale_reject` |
| `not_expected` | Solcast not configured | Solcast branch skipped entirely |

**Coverage formula**:
```
coverage = usable_solcast_slots / 156
```

**Evaluation assertion** (SQL):
```sql
SELECT target_date, solcast_freshness_class, COUNT(*) AS run_count
FROM   forecast_run_audit
WHERE  target_date >= date('now', '-30 days')
  AND  is_authoritative_runtime = 1
GROUP  BY target_date, solcast_freshness_class
ORDER  BY target_date DESC;
-- Expected: solcast_freshness_class = 'fresh' for ≥ 90% of production days
```

---

### 2.3 Physics Model Formula (Clear-Sky Baseline)

**Physics generation estimate (per 5-minute slot)**:

```
P_phys(t) = GHI(t) × C_cloud(t) × DC_cap × eta_inv × [1 + GAMMA_TC × (T_cell(t) - T_ref)]
```

Where:
- `GHI(t)` — Global Horizontal Irradiance at slot `t` (W/m²)
- `C_cloud(t)` — cloud attenuation factor (0–1)
- `DC_cap` — total DC capacity = `UNIT_KW_MAX × n_inverters`
- `eta_inv` — inverter efficiency ≈ **0.986**
- `GAMMA_TC` = **-0.004 /°C**
- `T_cell(t)` — cell temperature (°C)
- `T_ref` = **25°C**

**Pass criteria**:
- `physics_total_kwh > 0` on any solar day
- On a clear day (Kt ≥ 0.75), physics estimate within 15% of Solcast P50
- Physics estimate never exceeds `PLANT_MW_FALLBACK × 24 × 1000 = 646,560 kWh/day`

---

### 2.4 Run Schedule & Advisory Lock Guard

| Parameter | Value |
|---|---|
| `DA_RUN_HOURS_PRIMARY` | `{6, 18}` → **06:00 and 18:00 PHT** |
| Advisory lock max age | **300 seconds (5 minutes)** |

**Advisory lock semantics**: If a valid advisory lock is present (age < 300 s),
the current run is **skipped** (idempotent guard).

**Evaluation assertion** (SQL):
```sql
SELECT target_date, COUNT(*) AS auth_run_count
FROM   forecast_run_audit
WHERE  is_authoritative_runtime = 1
  AND  target_date >= date('now', '-30 days')
GROUP  BY target_date
HAVING auth_run_count > 2;
-- Expected: 0 rows
```

---

## 3. QA Comparison & Eligibility Gates

### 3.1 `comparison_quality` Classification

| Tier | `include_in_error_memory` | `include_in_source_scoring` | Meaning |
|---|---|---|---|
| `"eligible"` | **TRUE** | TRUE | Full quality; counted in bias correction |
| `"review"` | FALSE | TRUE | Partial quality; source scoring only |
| `"insufficient"` | FALSE | FALSE | Too few actuals; excluded entirely |

### 3.2 `include_in_error_memory` Gate (All 7 Conditions Must Pass)

| # | Condition | Threshold | Fail → tier |
|---|---|---|---|
| 1 | `actual_slots_count ≥` | **132** (85% of 156 solar slots) | → `review` or `insufficient` |
| 2 | `forecast_slots_count ≥` | **132** | → `review` |
| 3 | `usable_slots ≥` | **132** | → `review` or `insufficient` |
| 4 | `constrained_ratio ≤` | **0.30** (max 30% MW-capped/manually constrained) | → `review` |
| 5 | `not provider_mismatch` | Provider used must match expected | → `review` |
| 6 | `solcast_freshness_class not in` | `{"missing", "stale_reject"}` | → `review` |
| 7 | `not degraded_variant` | `forecast_variant` not `ml_without_solcast` or `ml_solcast_hybrid_stale` when Solcast expected | → `review` |

**Why 132 slots?**
`132 / 156 = 84.6%` — effectively **85% of the solar day**. Days with more than
15% of the solar window missing actual readings cannot reliably benchmark the forecast.

**`constrained_ratio` formula**:
```
constrained_ratio = (cap_masked_slots + manual_masked_slots + operational_masked_slots) / usable_slots
```

### 3.3 QA Metrics Stored Per Day

| Column | Formula | Interpretation |
|---|---|---|
| `daily_wape_pct` | `Σ\|actual − forecast\| / Σactual × 100` | Weighted Absolute Percentage Error |
| `daily_mape_pct` | `mean(\|actual − forecast\| / actual) × 100` | Mean Absolute Percentage Error |
| `daily_total_ape_pct` | `\|Σactual − Σforecast\| / Σactual × 100` | Total energy APE (day-level) |
| `total_abs_error_kwh` | `Σ\|actual_kwh − forecast_kwh\|` | Absolute slot-sum error |

**Acceptance thresholds**:

| Metric | Target | Alert threshold |
|---|---|---|
| `daily_wape_pct` | ≤ 15% | > 25% triggers investigation |
| `daily_mape_pct` | ≤ 20% | > 35% on 3+ consecutive eligible days |
| `daily_total_ape_pct` | ≤ 10% | > 20% on any individual day |

**Evaluation assertion** (SQL):
```sql
SELECT
  ROUND(AVG(daily_wape_pct), 2)  AS avg_wape_pct,
  ROUND(MAX(daily_wape_pct), 2)  AS max_wape_pct,
  COUNT(*)                        AS eligible_days,
  SUM(CASE WHEN daily_wape_pct > 25 THEN 1 ELSE 0 END) AS alert_days
FROM forecast_error_compare_daily
WHERE comparison_quality = 'eligible'
  AND target_date >= date('now', '-30 days');
-- Pass: avg_wape_pct ≤ 15, alert_days = 0
```

---
## 4. Error Memory Bias Correction

### 4.1 Core Parameters

| Parameter | Value | Meaning |
|---|---|---|
| `ERR_MEMORY_DAYS` | **7** (default) | Default lookback window |
| Regime-specific lookback | `clear`→7d, `mixed`→10d, `overcast`→14d, `rainy`→21d | Longer windows for unstable regimes |
| `ERR_MEMORY_DECAY` | **0.72** | Geometric decay per day |
| `ERROR_ALPHA` | **0.28** | Blend factor: `corrected = raw + 0.28 × bias_estimate` |

**Decay weight formula**:
```
w(d) = 0.72^d
```
Example: `w(0)=1.0`, `w(1)=0.72`, `w(3)=0.373`, `w(7)=0.095`

### 4.2 Regime Mismatch Penalty Matrix

| Historical regime | Current regime | Cross-weight |
|---|---|---|
| `overcast` | `rainy` | **0.70** |
| `rainy` | `overcast` | **0.70** |
| `clear_stable` | `clear_edge` | **0.75** |
| `clear_edge` | `clear_stable` | **0.75** |
| `mixed_stable` | `mixed_volatile` | **0.60** |
| `mixed_volatile` | `mixed_stable` | **0.60** |
| Any other cross-regime pair | — | **0.00** (excluded) |

### 4.3 Error Memory Staleness

| Condition | Warning flag | Threshold |
|---|---|---|
| No eligible row in DB | `error_memory_stale` | `eligible_row_count == 0` |
| Last eligible day > 30 days ago | `error_memory_stale` | `last_eligible_date > now − 30d` |
| Regime data sparse | `error_memory_sparse_regime` | `fallback_to_legacy = True` |

**Evaluation assertion** (SQL):
```sql
SELECT
  MAX(target_date)  AS last_eligible_date,
  COUNT(*)          AS total_eligible_days,
  julianday('now') - julianday(MAX(target_date)) AS days_since_last_eligible
FROM forecast_error_compare_daily
WHERE include_in_error_memory = 1
  AND comparison_quality = 'eligible';
-- Pass: days_since_last_eligible ≤ 30, total_eligible_days ≥ 7
-- Fail: days_since_last_eligible > 30
```

---

## 5. EMOS-B Spread Calibration

### 5.1 Parameters

| Parameter | Value | Meaning |
|---|---|---|
| `EMOS_LOOKBACK_DAYS` | **30** | Days of QA history used for spread fitting |
| `EMOS_MIN_DAYS` | **7** | Minimum eligible days before EMOS is applied |
| `EMOS_SPREAD_SCALE_MIN` | **0.70** | Spread may be compressed by no more than 30% |
| `EMOS_SPREAD_SCALE_MAX` | **1.30** | Spread may be expanded by no more than 30% |

**Spread scale formula**:
```
scale = clamp(fitted_sigma_actual / fitted_sigma_forecast, 0.70, 1.30)
P10_calibrated(t) = P50(t) - scale × (P50(t) - P10_raw(t))
P90_calibrated(t) = P50(t) + scale × (P90_raw(t) - P50(t))
```

**Pass criteria**:
- `locked_spread_pct_cap_avg` in `[0.70, 1.30]` for every row
- Median over 30 days in `[0.85, 1.15]`

**Evaluation assertion** (SQL):
```sql
SELECT
  ROUND(AVG(locked_spread_pct_cap_avg), 3) AS avg_spread_scale,
  ROUND(MIN(locked_spread_pct_cap_avg), 3) AS min_spread_scale,
  ROUND(MAX(locked_spread_pct_cap_avg), 3) AS max_spread_scale
FROM forecast_error_compare_daily
WHERE comparison_quality IN ('eligible', 'review')
  AND target_date >= date('now', '-30 days')
  AND locked_spread_pct_cap_avg IS NOT NULL;
-- Pass: avg ∈ [0.85, 1.15], min ≥ 0.70, max ≤ 1.30
```

---
## 6. Automated Evaluation Assertions

Save as `evals/run_forecast_eval.py` and run on the appliance:

```python
#!/usr/bin/env python3
"""
Forecast ML & Day-Ahead Integrity Evaluation Runner
Run: python3 evals/run_forecast_eval.py [--db /path/to/adsi.db]
"""
import sqlite3, json, hashlib, pathlib, argparse, sys
from datetime import datetime, timedelta, timezone

FAIL_COUNT = 0

def check(name, cond, detail=""):
    global FAIL_COUNT
    status = "PASS" if cond else "FAIL"
    if not cond:
        FAIL_COUNT += 1
    print(f"  [{status}] {name}" + (f" — {detail}" if detail else ""))
    return cond

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db",     default="/opt/inverter-dashboard/data/db/adsi.db")
    ap.add_argument("--state",  default="/opt/inverter-dashboard/data/forecast/ml_train_state.json")
    ap.add_argument("--bundle", default="/opt/inverter-dashboard/data/forecast/pv_dayahead_model_bundle.joblib")
    args = ap.parse_args()

    print("=== Forecast ML & Day-Ahead Integrity Evaluation ===\n")

    # 1. ML Train State
    print("1. ML Train State")
    state_path = pathlib.Path(args.state)
    state = {}
    if state_path.exists():
        state = json.loads(state_path.read_text())
        check("State file parseable", True)
        check("consecutive_train_rejection_count < 3",
              state.get("consecutive_train_rejection_count", 0) < 3,
              f"count={state.get('consecutive_train_rejection_count')}")
        check("No high_rejection_streak warning",
              "high_rejection_streak" not in state.get("data_warnings", []))
        check("No error_memory_stale warning",
              "error_memory_stale" not in state.get("data_warnings", []))
        check("backend_fallback not active",
              not state.get("status_flags", {}).get("backend_fallback", False),
              "LightGBM should be primary in production")
        check("training_samples_count >= 300",
              state.get("training_samples_count", 0) >= 300,
              f"count={state.get('training_samples_count')}")
        check("training_regimes_count > 0",
              state.get("training_regimes_count", 0) > 0)
        em = state.get("error_memory", {})
        check("error_memory.fallback_to_legacy is False",
              not em.get("fallback_to_legacy", False))
        check("error_memory.eligible_row_count >= 7",
              em.get("eligible_row_count", 0) >= 7,
              f"eligible={em.get('eligible_row_count')}")
    else:
        check("State file exists", False, args.state)

    # 2. Bundle SHA-256
    print("\n2. Model Bundle Integrity")
    bundle_path = pathlib.Path(args.bundle)
    if bundle_path.exists() and state:
        actual_sha = hashlib.sha256(bundle_path.read_bytes()).hexdigest()
        expected_sha = state.get("model_file_sha256", "")
        check("Bundle SHA-256 matches state", actual_sha == expected_sha,
              f"expected={expected_sha[:12]}... actual={actual_sha[:12]}...")
    else:
        check("Bundle file exists", bundle_path.exists(), args.bundle)

    # 3. Database assertions
    print("\n3. QA Comparison Table")
    db = sqlite3.connect(args.db)
    db.row_factory = sqlite3.Row
    cutoff_30 = (datetime.now(timezone.utc) - timedelta(days=30)).date().isoformat()

    row = db.execute("""
        SELECT
          AVG(daily_wape_pct)   AS avg_wape,
          MAX(daily_wape_pct)   AS max_wape,
          COUNT(*)              AS eligible_days,
          SUM(CASE WHEN daily_wape_pct > 25 THEN 1 ELSE 0 END) AS alert_days,
          MAX(target_date)      AS last_eligible_date,
          julianday('now') - julianday(MAX(target_date)) AS days_stale
        FROM forecast_error_compare_daily
        WHERE comparison_quality = 'eligible'
          AND target_date >= ?
    """, (cutoff_30,)).fetchone()

    if row and row["eligible_days"] > 0:
        check("avg_wape_pct <= 15%", (row["avg_wape"] or 999) <= 15,
              f"{round(row['avg_wape'],2)}%")
        check("max_wape_pct <= 25%", (row["max_wape"] or 999) <= 25,
              f"{round(row['max_wape'],2)}%")
        check("0 alert days (WAPE > 25%)", row["alert_days"] == 0,
              f"{row['alert_days']} alert days")
        check("eligible_days >= 7 in last 30d", row["eligible_days"] >= 7,
              f"{row['eligible_days']} days")
        check("error memory not stale (<= 30d)", (row["days_stale"] or 999) <= 30,
              f"last={row['last_eligible_date']}")
    else:
        check("Eligible QA rows exist in last 30 days", False)

    row2 = db.execute("""
        SELECT COUNT(*) AS dup_auth_runs
        FROM (
          SELECT target_date, COUNT(*) c
          FROM forecast_run_audit
          WHERE is_authoritative_runtime = 1
            AND target_date >= ?
          GROUP BY target_date
          HAVING c > 2
        )
    """, (cutoff_30,)).fetchone()
    check("No duplicate authoritative runs (> 2/day)", row2["dup_auth_runs"] == 0,
          f"{row2['dup_auth_runs']} dates with > 2 auth runs")

    row3 = db.execute("""
        SELECT AVG(locked_spread_pct_cap_avg) AS avg_spread
        FROM forecast_error_compare_daily
        WHERE comparison_quality IN ('eligible', 'review')
          AND target_date >= ?
          AND locked_spread_pct_cap_avg IS NOT NULL
    """, (cutoff_30,)).fetchone()
    if row3 and row3["avg_spread"] is not None:
        check("EMOS spread scale in [0.85, 1.15]",
              0.85 <= row3["avg_spread"] <= 1.15,
              f"avg_spread={round(row3['avg_spread'],3)}")

    # 4. Solcast freshness
    print("\n4. Solcast Freshness (last 30 days)")
    rows = db.execute("""
        SELECT solcast_freshness_class, COUNT(*) AS cnt
        FROM forecast_run_audit
        WHERE is_authoritative_runtime = 1 AND target_date >= ?
        GROUP BY solcast_freshness_class ORDER BY cnt DESC
    """, (cutoff_30,)).fetchall()
    total_runs = sum(r["cnt"] for r in rows)
    fresh_count = next((r["cnt"] for r in rows if r["solcast_freshness_class"]=="fresh"), 0)
    for r in rows:
        pct = 100*r["cnt"]/max(total_runs,1)
        print(f"    {r['solcast_freshness_class']}: {r['cnt']} ({pct:.1f}%)")
    check(">= 90% of auth runs have fresh Solcast",
          total_runs > 0 and fresh_count/total_runs >= 0.90,
          f"{100*fresh_count/max(total_runs,1):.1f}%")

    # 5. Forecast variant
    print("\n5. Forecast Variant Distribution (last 30 days)")
    rows = db.execute("""
        SELECT forecast_variant, COUNT(*) AS cnt
        FROM forecast_run_audit
        WHERE is_authoritative_runtime = 1 AND target_date >= ?
        GROUP BY forecast_variant ORDER BY cnt DESC
    """, (cutoff_30,)).fetchall()
    hybrid_count = next((r["cnt"] for r in rows if r["forecast_variant"]=="ml_solcast_hybrid"), 0)
    degraded = sum(r["cnt"] for r in rows
                   if r["forecast_variant"] in ("ml_without_solcast", "physics_only"))
    for r in rows:
        pct = 100*r["cnt"]/max(total_runs,1)
        print(f"    {r['forecast_variant']}: {r['cnt']} ({pct:.1f}%)")
    check("ml_solcast_hybrid is dominant variant",
          total_runs > 0 and hybrid_count/total_runs >= 0.70,
          f"{100*hybrid_count/max(total_runs,1):.1f}%")
    check("0 degraded-variant days",
          degraded == 0, f"{degraded} degraded runs")

    db.close()
    print(f"\n{'='*52}")
    print(f"Result: {'PASS' if FAIL_COUNT == 0 else 'FAIL'} ({FAIL_COUNT} assertion(s) failed)")
    sys.exit(0 if FAIL_COUNT == 0 else 1)

if __name__ == "__main__":
    main()
```

---
## 7. Health State Contract — `ml_train_state.json`

### 7.1 Required Fields

| Field | Type | Healthy Value |
|---|---|---|
| `consecutive_train_rejection_count` | `int` | `0` |
| `last_rejection_ts` | `str`/`null` | `null` (or old timestamp if count = 0) |
| `last_successful_train_ts` | `str` (ISO8601) | Within last 24h on production morning |
| `training_result` | `str` | `"success"` |
| `last_training_date` | `str` (YYYY-MM-DD) | Yesterday's date (after 06:00 PHT run) |
| `ml_backend_type` | `str` | `"lightgbm"` (production) |
| `ml_backend_detail` | `str` | LightGBM version string |
| `model_file_path` | `str` | Path to `.joblib` bundle |
| `model_file_mtime_ms` | `int` | Recent epoch-ms timestamp |
| `model_file_sha256` | `str` | 64-char hex SHA-256 |
| `training_samples_count` | `int` | ≥ 300 |
| `training_features_count` | `int` | 28–40 |
| `training_regimes_count` | `int` | 1–6 |
| `data_warnings` | `list[str]` | `[]` (empty = healthy) |
| `status_flags` | `dict` | `{}` or `{"backend_fallback": false}` |
| `outage_summary` | `dict`/`list` | No `severe` days in last 7 days |
| `error_memory.fallback_to_legacy` | `bool` | `false` |
| `error_memory.fallback_reason` | `str`/`null` | `null` |
| `error_memory.last_eligible_date` | `str` | Within last 7 days |
| `error_memory.eligible_row_count` | `int` | ≥ 7 |

### 7.2 `data_warnings` Flag Reference

| Warning flag | Meaning | Severity |
|---|---|---|
| `insufficient_training_days` | `history_days < N_TRAIN_DAYS (45)` | WARNING |
| `high_rejection_streak` | `consecutive_train_rejection_count >= 3` | ALERT |
| `no_regime_data` | No regime buckets in training bundle | ALERT |
| `outage_days_detected` | ≥ 1 moderate/severe outage day in window | WARNING |
| `error_memory_sparse_regime` | Fell back to legacy error memory | WARNING |
| `error_memory_stale` | No eligible QA row in 30+ days | ALERT |
| `est_actual_reconstruction_active` | Satellite-derived actual used (0.93 weight) | INFO |

---

## 8. Database Table Contracts

### 8.1 `forecast_error_compare_daily` (Evaluation-Critical Columns)

| Column | Type | Notes |
|---|---|---|
| `target_date` | TEXT (YYYY-MM-DD) | Solar day |
| `run_audit_id` | INTEGER | FK to `forecast_run_audit` |
| `forecast_variant` | TEXT | Variant used for this comparison |
| `solcast_freshness_class` | TEXT | Freshness at time of run |
| `total_forecast_kwh` | REAL | P50 day total |
| `total_actual_kwh` | REAL | Actual metered generation |
| `total_abs_error_kwh` | REAL | Sum of abs slot errors |
| `daily_wape_pct` | REAL | WAPE (%) |
| `daily_mape_pct` | REAL | MAPE (%) |
| `daily_total_ape_pct` | REAL | Day-total APE (%) |
| `usable_slot_count` | INTEGER | Slots used in WAPE/MAPE |
| `available_actual_slots` | INTEGER | Slots with non-null actual data |
| `cap_masked_slots` | INTEGER | MW-curtailed slots |
| `manual_masked_slots` | INTEGER | Operator-masked slots |
| `include_in_error_memory` | INTEGER (0/1) | 1 = eligible for bias correction |
| `include_in_source_scoring` | INTEGER (0/1) | 1 = eligible for source scoring |
| `comparison_quality` | TEXT | `eligible` / `review` / `insufficient` |
| `locked_spread_pct_cap_avg` | REAL | EMOS-B calibrated spread scale |
| `locked_total_p50_kwh` | REAL | Locked Solcast P50 for the day |
| `locked_total_p10_kwh` | REAL | Locked Solcast P10 |
| `locked_total_p90_kwh` | REAL | Locked Solcast P90 |
| `actual_source` | TEXT | `metered` / `satellite_reconstructed` |
| `notes_json` | TEXT (JSON) | Audit notes incl. error classifier prediction |

### 8.2 `forecast_run_audit`

| Column | Type | Notes |
|---|---|---|
| `target_date` | TEXT | Solar day |
| `generated_ts` | TEXT (ISO8601) | When the run completed |
| `provider_used` | TEXT | `solcast` / `physics` / etc. |
| `forecast_variant` | TEXT | See §2.1 |
| `run_status` | TEXT | `success` / `partial` / `failed` |
| `solcast_freshness_class` | TEXT | Freshness at run time |
| `final_forecast_total_kwh` | REAL | Published P50 day-energy |
| `is_authoritative_runtime` | INTEGER (0/1) | 1 = canonical advisory |
| `attempt_number` | INTEGER | 1 = first run; ≥ 2 = retry |
| `physics_total_kwh` | REAL | Clear-sky physics baseline |
| `hybrid_total_kwh` | REAL | ML+Solcast hybrid (if applicable) |
| `notes_json` | TEXT (JSON) | Error classifier class, blend weights, lock info |

---

## 9. Failure Modes & Escalation Matrix

| Symptom | Probable Cause | Check | Escalation |
|---|---|---|---|
| `consecutive_train_rejection_count >= 3` | Data pipeline failure, DB lock, outage storm | `ml_train_state.json → data_warnings` | Inspect DB WAL; check generation data for last 5 days |
| `forecast_variant = physics_only` every day | LightGBM not installed; bundle corruption; Solcast API failure | `python3 -c "import lightgbm"` + bundle SHA check | Reinstall LightGBM; restore `.prev1` bundle |
| `comparison_quality` never `eligible` | Actuals not being written; ≥ 15% slots missing; high curtailment | `SELECT * FROM forecast_error_compare_daily ORDER BY target_date DESC LIMIT 7` | Confirm SCADA Modbus polling is recording actuals |
| `error_memory_stale` warning active | No eligible QA day in > 30 days | SQL assertion §4.3 | Investigate masking pipeline; check actuals collection |
| `avg_wape > 25%` over 3+ days | Regime shift, ML bundle stale, Solcast calibration drift | Compare `weather_source` vs. actual satellite data | Trigger manual retraining; verify Solcast site resource ID |
| `locked_spread_pct_cap_avg` at 0.70 or 1.30 | EMOS-B fitting on too-few days or extreme systematic bias | Count eligible days for EMOS window | Wait for 7+ eligible days |
| `solcast_freshness_class = stale_reject` for > 3 days | Solcast API key expired / quota exhausted | Check Solcast dashboard; test via gateway | Rotate API key in Forecast Configuration settings |
| `backend_fallback = true` | LightGBM not importable | `python3 -c "import lightgbm"` | `pip install lightgbm`; set `FORECAST_USE_LIGHTGBM=1` |
| Bundle SHA-256 mismatch | File corruption, partial write, disk issue | Checksum assertion §1.10 | Restore from `.prev1`; check disk health |

---

## 10. Evaluation Cadence & Ownership

| Evaluation | Frequency | Owner | Method |
|---|---|---|---|
| ML training health check | **Daily** (after 06:00 PHT run) | Automated | `ml_train_state.json → data_warnings = []` and `consecutive_train_rejection_count = 0` |
| QA WAPE/MAPE review | **Daily** (~20:00 PHT, after actuals captured) | Dashboard Forecast page | Review `forecast_error_compare_daily` for yesterday |
| Full eval script run | **Weekly** | Developer | `python3 evals/run_forecast_eval.py` on appliance |
| ML bundle rollback test | **Monthly** | Developer | Rename `.joblib → .bak`; confirm engine auto-loads `.prev1` |
| Solcast freshness audit | **Monthly** | Developer | SQL assertion §2.2; confirm ≥ 90% fresh days |
| EMOS-B spread audit | **Monthly** | Developer | SQL assertion §5.2; confirm scale in [0.85, 1.15] |
| Error memory regime coverage | **Quarterly** | Developer | Verify all 6 regime buckets appear in last 90 days of `forecast_error_compare_daily` |

---

*Last updated: 2026-09-01 | Engine reference: `services/forecast_engine.py` (14,923 lines)*
*Companion document: `evals/SYSTEM_REVIEW_AND_EVALUATION.md` (broad system overview)*
