"""
Solar Power Forecasting System
Day-Ahead Forecast Engine  v3.0

Architecture

1. Solar Geometry      - precise declination / hour-angle / air-mass / AOI
2. Clear-Sky Model     - Ineichen simplified + humidity attenuation
3. Cloud Transmittance - non-linear cloud-cover  transmission mapping (PH-tuned)
4. Physics Baseline    - per-slot kWh_inc from plant specs (dependable rating)
5. Residual ML         - GradientBoosting learns (actual  physics) residual
                         trained on last N_TRAIN_DAYS with recency weighting
6. Error Memory        - rolling weighted average of recent forecast errors
                         applied as a bias-correction term
7. Anomaly Guard       - rejects training days with irradiance/generation
                         inconsistencies before they corrupt the model
8. Forecast QA         - logs MAPE, MBE, skill-score vs persistence each cycle
9. Output              - 5-min kWh_inc series with confidence bands

Author  : Engr. Clariden Montao REE (Engr. M.)
Version : 3.0 (Day-Ahead Hardened)
 2026 Engr. Clariden Montao REE. All rights reserved.
"""

import sys
import os

if sys.stdout is None:
    sys.stdout = open(os.devnull, 'w')
if sys.stderr is None:
    sys.stderr = open(os.devnull, 'w')

try:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

import argparse
import hashlib
import json
import logging
import warnings
import math
import queue
import sqlite3
import subprocess
import threading
import time
import uuid
from datetime import date, datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path
from logging.handlers import RotatingFileHandler

import numpy as np
import pandas as pd
import requests
from joblib import dump, load
from sklearn.ensemble import GradientBoostingClassifier, GradientBoostingRegressor

try:
    import lightgbm as lgb
    _LIGHTGBM_AVAILABLE = True
    _LIGHTGBM_IMPORT_ERROR = None
except ImportError as _lgb_err:
    _LIGHTGBM_AVAILABLE = False
    # T4.9 fix (Phase 7, 2026-04-14): capture the ImportError message so the
    # operator can see WHY LightGBM isn't active (missing DLL, ABI mismatch,
    # wheel missing for platform, etc.) via /engine-health instead of the
    # opaque "lgbm_unavailable_fallback" flag.
    _LIGHTGBM_IMPORT_ERROR = str(_lgb_err)

# Phase 8 code-review fix (2026-04-15): module-scope initializers for the
# one-time-log guards used by T4.6 (Solcast reliability dimension fallback)
# and T4.8 (legacy-model truncation).  Previously initialised lazily inside
# each function via `global X; try: X except NameError: X = ...`, which has
# a tiny race where two concurrent first-time calls both hit NameError,
# both enter the init branch, and one STORE_GLOBAL overwrites the other's
# just-added entry.  Pre-initialising here closes the window — subsequent
# `add()` / assignment always lands in the already-existing container.
_reliability_fallback_notified: set = set()
_legacy_model_truncate_notified: bool = False

class IdentityFeatureScaler:
    """Legacy-compatible no-op transformer for standalone scaler artifacts."""

    def __init__(self, n_features: int):
        self.n_features_in_ = int(n_features)

    def transform(self, X):
        return np.asarray(X, dtype=float)

# ============================================================================
# PATHS
# ============================================================================
PORTABLE_ROOT_RAW = str(
    os.getenv("INVERTER_PORTABLE_DATA_DIR")
    or os.getenv("IM_PORTABLE_DATA_DIR")
    or os.getenv("ADSI_PORTABLE_DATA_DIR")
    or ""
).strip()
if not PORTABLE_ROOT_RAW:
    _auto_storage = Path(__file__).resolve().parent.parent.parent.parent / "storage"
    if _auto_storage.exists():
        PORTABLE_ROOT_RAW = str(_auto_storage)
    elif sys.platform.startswith("linux") and Path("/var/lib/inverter-dashboard").exists():
        PORTABLE_ROOT_RAW = "/var/lib/inverter-dashboard"

PORTABLE_ROOT = Path(PORTABLE_ROOT_RAW) if PORTABLE_ROOT_RAW else None
EXPLICIT_DATA_DIR = str(
    os.getenv("INVERTER_DATA_DIR")
    or os.getenv("IM_DATA_DIR")
    or os.getenv("ADSI_DATA_DIR")
    or ""
).strip()
if not EXPLICIT_DATA_DIR and sys.platform.startswith("linux") and Path("/var/lib/inverter-dashboard/db").exists():
    EXPLICIT_DATA_DIR = "/var/lib/inverter-dashboard/db"

if PORTABLE_ROOT is not None:
    BASE = PORTABLE_ROOT / "programdata"
else:
    BASE = Path(os.getenv("PROGRAMDATA") or os.getenv("ALLUSERSPROFILE") or r"C:\ProgramData") / "InverterDashboard-2.0"

HISTORY_CTX   = BASE / "history/context/global/global.json"
FORECAST_CTX  = BASE / "forecast/context/global/global.json"
MODEL_FILE    = BASE / "forecast/pv_dayahead_model.joblib"
SCALER_FILE   = BASE / "forecast/pv_dayahead_scaler.joblib"
MODEL_BUNDLE_FILE = BASE / "forecast/pv_dayahead_model_bundle.joblib"
ARTIFACT_FILE = BASE / "forecast/pv_dayahead_artifacts.joblib"
WEATHER_BIAS_FILE = BASE / "forecast/pv_weather_bias.joblib"
SOLCAST_RELIABILITY_FILE = BASE / "forecast/pv_solcast_reliability.joblib"
FORECAST_SNAPSHOT_DIR = BASE / "forecast/snapshots"
FORECAST_BASELINE_SNAPSHOT_FILE = BASE / "forecast/baseline_snapshot.json"
FORECAST_REPLAY_RESULTS_DIR = BASE / "forecast/replay_results"
ML_TRAIN_STATE_FILE   = BASE / "forecast/ml_train_state.json"
WEATHER_DIR   = BASE / "weather"
LOG_FILE      = BASE / "logs/forecast_dayahead.log"
SERVICE_STOP_FILE_RAW = str(
    os.getenv("INVERTER_SERVICE_STOP_FILE")
    or os.getenv("IM_SERVICE_STOP_FILE")
    or os.getenv("ADSI_SERVICE_STOP_FILE")
    or ""
).strip()
SERVICE_STOP_FILE = Path(SERVICE_STOP_FILE_RAW) if SERVICE_STOP_FILE_RAW else None
SERVICE_STOP_POLL_SEC = 0.5

if EXPLICIT_DATA_DIR:
    _target_db = Path(EXPLICIT_DATA_DIR) / "inverter.db"
    APP_DB_FILE = _target_db if _target_db.exists() else Path(EXPLICIT_DATA_DIR) / "adsi.db"
elif PORTABLE_ROOT is not None:
    _target_db = PORTABLE_ROOT / "db" / "inverter.db"
    APP_DB_FILE = _target_db if _target_db.exists() else PORTABLE_ROOT / "db" / "adsi.db"
else:
    _target_db = BASE / "db" / "inverter.db"
    APP_DB_FILE = _target_db if _target_db.exists() else BASE / "db" / "adsi.db"

if PORTABLE_ROOT is not None:
    IPCONFIG_FILE = PORTABLE_ROOT / "config" / "ipconfig.json"
    LEGACY_IPCONFIG_FILES: list[Path] = []
else:
    IPCONFIG_FILE = APP_DB_FILE.parent / "ipconfig.json"
    LEGACY_IPCONFIG_FILES = []
    # Only include persistent user-data paths. Bundle-dir (__file__.parent)
    # and Path.cwd() are intentionally excluded — in a PyInstaller bundle
    # they resolve to the extracted _MEIxxxx dir or the installer's launch
    # directory, both of which are replaced on every update and could let
    # a stale shipped ipconfig silently shadow the user's real config.
    for candidate in [BASE / "config" / "ipconfig.json", BASE / "ipconfig.json"]:
        if candidate != IPCONFIG_FILE and candidate not in LEGACY_IPCONFIG_FILES:
            LEGACY_IPCONFIG_FILES.append(candidate)

if EXPLICIT_DATA_DIR or PORTABLE_ROOT is not None:
    ARCHIVE_DIR = APP_DB_FILE.parent / "archive"
else:
    _new_archive = BASE / "archive"
    if _migration_done or _new_archive.exists():
        ARCHIVE_DIR = _new_archive
    else:
        ARCHIVE_DIR = APP_DB_FILE.parent / "archive"
SQLITE_READ_TIMEOUT_SEC = 8.0
SQLITE_WRITE_TIMEOUT_SEC = 20.0
SQLITE_RETRY_ATTEMPTS = 3
SQLITE_RETRY_BACKOFF_SEC = 0.35

# T4.4 fix: cross-process advisory lock for day-ahead generation.
# Prevents Python-side double-runs (auto-scheduler + CLI + delegation-fallback)
# from writing duplicate forecast_run_audit rows for the same target date.
# The lock lives under APP_DB_FILE.parent so it survives restarts but has a
# max age guard (DAYAHEAD_GEN_LOCK_MAX_AGE_SEC) after which it's considered
# stale and can be force-acquired.  Node-side coordination is deferred and
# tracked as follow-up work (see audits/2026-04-14/BUG_SWEEP.md §T4.4).
DAYAHEAD_GEN_LOCK_DIR = APP_DB_FILE.parent / "locks"
DAYAHEAD_GEN_LOCK_MAX_AGE_SEC = 300  # 5 min — covers Node's 180 s timeout + slack

for _d in [WEATHER_DIR, MODEL_FILE.parent, FORECAST_SNAPSHOT_DIR, FORECAST_REPLAY_RESULTS_DIR, LOG_FILE.parent, APP_DB_FILE.parent, IPCONFIG_FILE.parent, DAYAHEAD_GEN_LOCK_DIR]:
    _d.mkdir(parents=True, exist_ok=True)

def _service_stop_requested() -> bool:
    try:
        return bool(SERVICE_STOP_FILE and SERVICE_STOP_FILE.exists())
    except Exception:
        return False

def _clear_service_stop_file() -> None:
    if SERVICE_STOP_FILE is None:
        return
    try:
        SERVICE_STOP_FILE.unlink(missing_ok=True)
    except TypeError:
        try:
            if SERVICE_STOP_FILE.exists():
                SERVICE_STOP_FILE.unlink()
        except Exception:
            pass
    except Exception:
        pass

def _sleep_with_service_stop(total_sec: float) -> None:
    deadline = time.monotonic() + max(0.0, float(total_sec or 0.0))
    while True:
        if _service_stop_requested():
            raise KeyboardInterrupt
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return
        time.sleep(min(SERVICE_STOP_POLL_SEC, remaining))

# ============================================================================
# LOGGING
# ============================================================================
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        RotatingFileHandler(LOG_FILE, maxBytes=10 * 1024 * 1024, backupCount=7),
        logging.StreamHandler(),
    ],
)
log = logging.getLogger("adsi.dayahead")

# Module-level cache for last error_memory metadata (written by compute_error_memory, read by run_dayahead)
_ERROR_MEMORY_LOCK = threading.Lock()
_LAST_ERROR_MEMORY_META: dict = {}

# ============================================================================
# SITE & PLANT CONSTANTS
# ============================================================================
LAT_DEG  =  6.772269   # Site latitude (Philippines)
LON_DEG  = 125.284455
TZ_NAME  = "Asia/Manila"
TZ_OFFSET = 8         # UTC+8

SLOT_MIN      = 5           # minutes per slot
SLOTS_DAY     = 288         # 24 - 60 / 5
SOLAR_START_H = 5           # 05:00 - first forecast slot
SOLAR_END_H   = 18          # end boundary (exclusive), last slot = 17:55
SOLAR_SLOTS   = (SOLAR_END_H - SOLAR_START_H) * 60 // SLOT_MIN   # 156 slots
SLOT_HOURS    = SLOT_MIN / 60.0
SOLCAST_KWH_PER_MW_SLOT = 1000.0 * SLOT_HOURS

SOLAR_START_SLOT = SOLAR_START_H * 60 // SLOT_MIN
SOLAR_END_SLOT   = SOLAR_END_H   * 60 // SLOT_MIN

# Plant
EXPORT_MW          = 24.0   # fallback export ceiling when no explicit setting exists
FORECAST_EXPORT_LIMIT_SETTING_KEY = "forecastExportLimitMw"
IPCONFIG_SETTING_KEY = "ipConfigJson"
DEFAULT_INVERTER_LOSS_PCT = 3.0   # midpoint of observed 2.5%-3.6% range
# Official Ingeteam "Plantilla Parámetros" template (DIGOS/ADSI):
#   Per-stage Pmax = 249.41 kW → 4 stages × 249.41 = 997.64 kW per inverter
#   Per-stage Pnom = 226.73 kW → 4 stages × 226.73 = 906.92 kW per inverter
# "Dependable" maps to template "Nominal" (continuous nameplate, not boost peak).
UNIT_KW_MAX        = 997.64  # kW peak per inverter (4-node complete) — Ingeteam Pmax
UNIT_KW_DEPENDABLE = 906.92  # kW nominal/dependable per inverter — Ingeteam Pnom
PLANT_MW_FALLBACK  = 26.94   # used when ipconfig absent (108 nodes × NODE_KW_MAX = 26.94 MW)

# Physics thresholds
RAD_MIN_WM2   = 8.0    # W/m " ignore radiation below this
TEMP_REF_C    = 25.0   # STC temperature
GAMMA_TC      = -0.004 # power temp coeff (/C) " typical Si module

# ============================================================================
# ML & TRAINING
# ============================================================================
N_TRAIN_DAYS   = 45    # rolling training window (days)
MIN_TRAIN_DAYS = 5     # minimum days before ML is used
MIN_SAMPLES    = 60    # minimum usable slots per training day
RECENCY_BASE = 1.0     # legacy compatibility; hardened path uses sample weights
MIN_HISTORY_SOLAR_SLOTS = MIN_SAMPLES
MIN_DAYAHEAD_SOLAR_SLOTS = max(24, MIN_SAMPLES // 2)
# v2.8 H3 fix: eligibility floor for error_memory inclusion at the QA persist
# layer. `_persist_qa_comparison` requires a day to have at least this many
# usable slots (and this many present actual/forecast slots) before marking
# `include_in_error_memory=1`. The value is derived from SOLAR_SLOTS so that
# any future change to SOLAR_START_H / SOLAR_END_H automatically adjusts the
# threshold. 85% coverage = reject days with more than ~2h of missing data.
MIN_USABLE_SLOTS_FOR_ELIGIBILITY = int(SOLAR_SLOTS * 0.85)  # 132 for 13h solar window
TRAIN_WEIGHT_HALF_LIFE_DAYS = 14.0
TRAIN_WEIGHT_FLOOR = 0.18
SHAPE_LOOKBACK_DAYS = 45  # history-window constant — also used by activity_records & training
SHAPE_TOP_K = 6           # used by _activity_similarity_score top-K analog selection
ACTIVITY_SUSTAIN_SLOTS = 2
STARTUP_RAD_WM2 = 80.0
STOPPING_RAD_WM2 = 28.0
ACTIVITY_MIN_FRACTION = 0.0022
LOW_POWER_STAGE_FRACTION = 0.16
STAGING_BLEND_MAX = 0.72
MODULES_PER_INVERTER = 4
# Per-stage values from Ingeteam "Plantilla Parámetros" template (DIGOS/ADSI):
#   Nominal Power (Pnom) = 226,730 W = 226.73 kW per stage
#   Maximum Power (Pmax) = 249,410 W = 249.41 kW per stage
# Pnom < Pmax as expected (continuous nameplate vs boost peak). Previous
# `NODE_KW_MAX = NODE_KW_NOMINAL × 0.977` formula and `NODE_KW_DEPENDABLE = 91.75`
# were placeholders/typos that pre-dated the official template.
NODE_KW_NOMINAL    = 226.73                                  # per-stage Pnom (kW) — Ingeteam template
NODE_KW_MAX        = 249.41                                  # per-stage Pmax (kW) — Ingeteam template
NODE_KW_DEPENDABLE = 226.73                                  # per-stage dependable = Pnom (kW)
REGIME_MODEL_MIN_DAYS = 6  # Minimum training days to build a regime-specific model
"""Strict minimum for regime model formation. Raised to REGIME_MODEL_MIN_DAYS_TRANSITION
during detected weather transitions (clear → overcast, dry → monsoon, etc.) to allow
sparse regimes to be learned with reduced confidence."""

REGIME_MODEL_MIN_DAYS_TRANSITION = 3  # Relaxed minimum during regime transitions
"""Transition mode: allows regime models with fewer samples when forming regimes
during weather pattern shifts. Used when the target regime is rare but emerging.
Lower threshold prevents training gaps during seasonal transitions."""

REGIME_MODEL_MIN_SAMPLES = 320
REGIME_BLEND_BASE = 0.52
REGIME_BLEND_MAX = 0.82
WEATHER_BUCKET_RAIN_MM = 0.05
WEATHER_BUCKET_RAIN_CLOUD = 82.0
WEATHER_BUCKET_RAIN_CAPE = 650.0
WEATHER_BUCKET_CLEAR_CLOUD = 25.0
WEATHER_BUCKET_CLEAR_EDGE_CLOUD = 40.0
WEATHER_BUCKET_CLEAR_KT = 0.70
WEATHER_BUCKET_CLEAR_EDGE_KT = 0.55
WEATHER_BUCKET_MIXED_KT = 0.40
WEATHER_BUCKET_MIXED_CLOUD = 70.0
WEATHER_BUCKET_MIXED_VOL_CLOUD = 80.0
WEATHER_BUCKET_CLEAR_DRAD = 90.0
WEATHER_BUCKET_MIXED_VOL_DRAD = 120.0
WEATHER_BUCKETS = (
    "clear_stable",
    "clear_edge",
    "mixed_stable",
    "mixed_volatile",
    "overcast",
    "rainy",
)
WEATHER_BIAS_LOOKBACK_DAYS = 21
WEATHER_BIAS_MIN_MATCHES = 4
WEATHER_BIAS_TOP_K = 6
WEATHER_BIAS_RAD_BLEND = 0.38
WEATHER_BIAS_CLOUD_BLEND = 0.26
WEATHER_BIAS_SHIFT_BLEND = 0.35
WEATHER_BIAS_FACTOR_CLIP = (0.84, 1.18)
WEATHER_BIAS_CLOUD_DELTA_CLIP = (-16.0, 16.0)
INTRADAY_MIN_OBS_SLOTS = 6
INTRADAY_MAX_OBS_SLOTS = 36
INTRADAY_RATIO_CLIP = (0.65, 1.35)
INTRADAY_RECENT_RATIO_CLIP = (0.55, 1.35)  # upper bound tightened from 1.45 → 1.35 to match global clip
INTRADAY_BLEND_MAX = 0.72
# Robust, lead-time-decaying nowcast. The production selector defaults to off;
# these values are challenger defaults until replay + shadow promotion passes.
NOWCAST_ALGORITHM_VERSION = "robust_decay_v1"
NOWCAST_CURRENT_ALGORITHM_VERSION = "current_ratio_v1"
NOWCAST_MIN_BASELINE_ENERGY = 5.0
NOWCAST_LOG_RATIO_EPSILON = 0.1
NOWCAST_HALF_LIFE_MINUTES = 45.0
NOWCAST_RECENT_MIX = 0.55
NOWCAST_RATIO_FLOOR = 0.55
NOWCAST_RATIO_CEILING = 1.50
NOWCAST_MIN_CAPACITY_COVERAGE = 0.70
NOWCAST_VOLATILITY_DAMP = 0.85
NOWCAST_RECENT_SLOTS = 12
NOWCAST_AUDIT_RETENTION_DAYS = 30
NOWCAST_VALID_MODES = frozenset({"off", "shadow", "active"})
NOWCAST_REPLAY_HORIZONS_MIN = (5, 15, 30, 60, 120)
NOWCAST_EXECUTION_BUDGET_SEC = 30.0
_nowcast_worker_guard = threading.Lock()
_nowcast_timed_out_worker: threading.Thread | None = None

class NowcastWorkerQuarantinedError(RuntimeError):
    """A prior timed-out read-only builder is still draining."""

# Activity artifact v2. Stored for offline ablation; production activity
# gating continues to use activity_records until the promotion gates pass.
ACTIVITY_V2_ACTIVATION_FRACTION = 0.0022
ACTIVITY_V2_DEACTIVATION_FRACTION = 0.0012
ACTIVITY_V2_SUSTAIN_SLOTS = 3
ACTIVITY_V2_MIN_DAY_COVERAGE = 0.70
SOLCAST_MIN_USABLE_SLOTS = 48
SOLCAST_RELIABILITY_LOOKBACK_DAYS = 30
SOLCAST_RELIABILITY_MIN_DAYS = 5
SOLCAST_PRIOR_BLEND_MIN = 0.28
SOLCAST_PRIOR_BLEND_MAX = 0.92
SOLCAST_PRIMARY_COVERAGE_MIN = 0.80
SOLCAST_PRIMARY_RELIABILITY_MIN = 0.50
SOLCAST_PRIMARY_BLEND_FLOOR_MIN = 0.76
SOLCAST_PRIMARY_BLEND_FLOOR_MAX = 0.90
SOLCAST_PRIOR_TOTAL_RATIO_CLIP = (0.65, 1.70)
SOLCAST_PRIOR_SPREAD_FRAC_CLIP = 1.25
SOLCAST_BIAS_RATIO_CLIP = (0.82, 1.18)
SOLCAST_RESIDUAL_DAMP_MIN = 0.18
SOLCAST_RESIDUAL_DAMP_MAX = 0.72
SOLCAST_RESIDUAL_PRIMARY_CAP = 0.30
SOLCAST_RESOLUTION_WEIGHT_FALLBACK = 0.50
SOLCAST_RESOLUTION_BLEND_SCALE_MIN = 0.88
SOLCAST_RESOLUTION_BLEND_SCALE_MAX = 1.12
SOLCAST_RESOLUTION_PRIMARY_SCALE_MIN = 0.94
SOLCAST_RESOLUTION_PRIMARY_SCALE_MAX = 1.06
SOLCAST_RESOLUTION_AUTHORITY_MIN = 0.72
SOLCAST_RESOLUTION_AUTHORITY_MAX = 1.00
SOLCAST_FORECAST_FLOOR_RATIO_FRESH  = 0.95  # fresh Solcast (coverage >= SOLCAST_COVERAGE_FRESH_THRESHOLD): floor at 95% of Solcast (actual often exceeds Solcast by ~3%)
SOLCAST_FORECAST_FLOOR_RATIO_USABLE = 0.88  # stale_usable (coverage >= SOLCAST_COVERAGE_USABLE_THRESHOLD): floor at 88% of Solcast total
# v2.8 audit (C1): named coverage thresholds. Used in many places throughout
# the prediction + freshness pipeline. Centralized so future tuning is one
# place, not 15+ literal callsites.
SOLCAST_COVERAGE_FRESH_THRESHOLD  = 0.95   # at or above: snapshot is "fresh"
SOLCAST_COVERAGE_USABLE_THRESHOLD = 0.80   # at or above: "stale_usable"; below: "stale_reject"
# NOTE (v2.8 cleanup): SOLCAST_WEATHER_DIVERGENCE_RATIO was removed alongside
# the Open-Meteo divergence override — Open-Meteo is unreliable for this site,
# so letting it veto the Solcast clamp was using a low-trust source to overrule
# a high-trust one.

# Time-of-day zone definitions (slot indices, 5-min resolution)
# morning: 05:00-08:55 = slots 60-107, midday: 09:00-14:55 = slots 108-179, afternoon: 15:00-17:55 = slots 180-215
TOD_ZONES = {
    "morning":   (SOLAR_START_SLOT, 108),
    "midday":    (108, 180),
    "afternoon": (180, SOLAR_END_SLOT),
}
TOD_ZONE_LABELS = ("morning", "midday", "afternoon")

# Trend detection
SOLCAST_TREND_MIN_DAYS_PER_HALF = 5
SOLCAST_TREND_IMPROVING_THRESHOLD = 0.05
SOLCAST_TREND_DEGRADING_THRESHOLD = -0.05
SOLCAST_TREND_BOOST_MAX = 0.06
SOLCAST_TREND_PENALTY_MAX = 0.08

# Extreme weather event detection (typhoon, severe monsoon)
EXTREME_WEATHER_SLOT_THRESHOLD = 30        # min sustained-severe slots to flag a day as extreme
EXTREME_WEATHER_RATIO_THRESHOLD = 0.45     # actual/solcast ratio below which a slot is "severe"

# Time-of-day reliability modifiers
TOD_RELIABILITY_WEIGHT_MIN = 0.85
TOD_RELIABILITY_WEIGHT_MAX = 1.08

# Adaptive ML residual blending (higher uncertainty -> lower ML influence)
ML_BLEND_MIN = 0.35
ML_BLEND_MAX = 1.00
ML_BLEND_ALPHA = 0.45

# Ramp slot detection and weighting (Phase 2.1)
RAMP_DETECTION_DRAD_THRESHOLD = 200.0   # W/m² per 5min change that flags a ramp slot
RAMP_SLOT_BLEND_SCALE = 0.62            # reduce ML blend at ramp slots (38% reduction)
RAMP_ONSET_SLOTS = 6                     # within ~30 min of sunrise/sunset edge

# Error memory
ERR_MEMORY_DAYS   = 7      # days used for bias correction (default / clear regime)
ERR_MEMORY_DECAY  = 0.72   # older day weight decay (geometric series)
ERR_MEMORY_REGIME_MISMATCH_PENALTY = 0.25  # penalty for regime mismatch (flat fallback)
ERROR_ALPHA       = 0.28   # fraction of error correction to apply

# Regime-aware lookback: rainy/overcast need more history because they occur less frequently.
# Clear/mixed keep the original 7-day window.
ERR_MEMORY_DAYS_BY_REGIME = {
    "clear":    7,
    "mixed":    10,
    "overcast": 14,
    "rainy":    21,
}

# Graduated regime mismatch penalty matrix.
# Neighboring regimes (overcast<->rainy) share more error structure than
# distant regimes (clear<->rainy). Values: 1.0 = same regime, lower = more different.
ERR_MEMORY_REGIME_PENALTY_MATRIX = {
    ("clear",    "mixed"):    0.50,
    ("clear",    "overcast"): 0.25,
    ("clear",    "rainy"):    0.20,
    ("mixed",    "clear"):    0.50,
    ("mixed",    "overcast"): 0.60,
    ("mixed",    "rainy"):    0.35,
    ("overcast", "clear"):    0.25,
    ("overcast", "mixed"):    0.60,
    ("overcast", "rainy"):    0.70,   # neighboring regimes
    ("rainy",    "clear"):    0.20,
    ("rainy",    "mixed"):    0.35,
    ("rainy",    "overcast"): 0.70,   # neighboring regimes
}
ERROR_CLASS_NAMES = (
    "strong_over",
    "mild_over",
    "neutral",
    "mild_under",
    "strong_under",
)
ERROR_CLASS_NEUTRAL_IDX = 2
ERROR_CLASS_MILD_THRESHOLD = 0.04
ERROR_CLASS_STRONG_THRESHOLD = 0.14
ERROR_CLASS_OPPORTUNITY_FLOOR_FRAC = 0.12
ERROR_CLASS_BLEND_MIN = 0.10
ERROR_CLASS_BLEND_MAX = 0.35
ERROR_CLASS_BLEND_CONFIDENCE_FLOOR = 0.40
ERROR_CLASS_CONFIDENCE_GATE = 0.35  # zero error class term below this confidence
ERROR_CLASS_BIAS_CAP_FRAC = 0.18
ERROR_CLASS_CONF_BAND_ADD_MAX = 0.14
ERROR_CLASS_SEVERE_BAND_ADD_MAX = 0.08
ERROR_CLASS_CENTROID_SHRINKAGE_SAMPLES = 36.0
ERROR_CLASS_CALIBRATION_MIN_DAYS = 8
ERROR_CLASS_CALIBRATION_HOLDOUT_MAX_DAYS = 6
ERROR_CLASS_CALIBRATION_HOLDOUT_MIN_SAMPLES = 144
ERROR_CLASS_CALIBRATION_TEMP_MIN = 0.70
ERROR_CLASS_CALIBRATION_TEMP_MAX = 2.40
ERROR_CLASS_CALIBRATION_TEMP_STEPS = 18
ERROR_CLASS_SUPPORT_MILD_FULL_COUNT = 24.0
ERROR_CLASS_SUPPORT_STRONG_FULL_COUNT = 36.0
ERROR_CLASS_PROFILE_MIN_RELIABILITY = 0.55
ERROR_CLASS_PROFILE_DEFAULT_RELIABILITY = 0.62
ERROR_CLASS_PROFILE_PAIR_FULL_COUNT = 30.0
ERROR_CLASS_PROFILE_BUCKET_FULL_COUNT = 42.0
ERROR_CLASS_PROFILE_REGIME_FULL_COUNT = 60.0
ERROR_CLASS_PROFILE_MAE_REF_FRAC = 0.18
ERROR_CLASS_PROFILE_STD_REF_FRAC = 0.24
MODEL_STAGE_HOLDOUT_MIN_SAMPLES = 144

# Anomaly rejection thresholds
ANOM_MIN_CF    = 0.02   # capacity factor " days below this are bad
ANOM_MAX_CF    = 1.05   # capacity factor " days above this are bad
ANOM_RAD_CORR  = 0.55   # min Pearson r between radiation & generation

# Availability / outage detection thresholds (Phase 2)
AVAIL_OUTAGE_THRESHOLD   = 0.95   # ratio below which a slot is outage-tainted
AVAIL_DAY_MINOR_PCT      = 0.05   # ≥5% of solar slots tainted → minor
AVAIL_DAY_MODERATE_PCT   = 0.15   # ≥15% → moderate
AVAIL_DAY_SEVERE_PCT     = 0.30   # ≥30% → severe
EST_ACTUAL_RECOVER_MIN   = 0.80   # need ≥80% est_actual coverage to recover severe outage day
EST_ACTUAL_WEIGHT_FACTOR = 0.93   # satellite-derived, nearly accurate per operator validation (7% discount)
EST_ACTUAL_WEIGHT_EFFECTIVE = 0.93  # dynamic override based on metered accuracy; set during training

# Confidence bands
CONF_CLEAR_BASE = 0.08   # 8% on clear days
CONF_CLOUD_ADD  = 0.20   # additional 20% on overcast / volatile days
CLOUD_VOLATILE  = 60.0   # cloud cover % threshold for "volatile"

# Forecast re-run schedule (hours UTC+8 when a new day-ahead is computed)
DA_RUN_HOURS_PRIMARY = {6, 18}   # always run (retrain + generate)
MIN_HOURLY_POINTS = 20
MIN_5MIN_POINTS = 240
OPERATIONAL_CONSTRAINT_LOOKBACK_DAYS = 90

# Step 3 — LightGBM Optional Model Backend
# Default: enabled when LightGBM is installed. Override with FORECAST_USE_LIGHTGBM=0 to force sklearn GBR.
FORECAST_USE_LIGHTGBM = os.environ.get("FORECAST_USE_LIGHTGBM", "1").lower() in ("1", "true", "yes")

# NOTE (v2.8 cleanup): Analog Ensemble (AnEn) post-correction was removed.
# It was a recency-only scalar bias correction (actual/forecast ratio over the
# last 5 days, clipped ±15%) applied AFTER compute_error_memory had already
# corrected per-slot bias with regime-aware weighting. The two corrections
# partially cancelled — error_memory subsumes AnEn entirely with finer signal.

# Step 6 — EMOS-B Spread Calibration
# Forecast band totals (total_forecast_lo_kwh, total_forecast_hi_kwh) are now persisted in
# forecast_error_compare_daily by _persist_qa_comparison via _load_dayahead_bands_from_db.
# EMOS-B implementation can query those columns from eligible rows for spread calibration.
EMOS_LOOKBACK_DAYS    = 30
EMOS_MIN_DAYS         = 7
EMOS_SPREAD_SCALE_MIN = 0.70
EMOS_SPREAD_SCALE_MAX = 1.30

# ============================================================================
# I/O HELPERS
# ============================================================================

def _load_json(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        log.error("JSON load failed %s: %s", path, e)
        return {}

def _save_json(path: Path, data: dict) -> bool:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
        tmp.replace(path)
        return True
    except Exception as e:
        log.error("JSON save failed %s: %s", path, e)
        return False

_TRAIN_REJECTION_ALERT_THRESHOLD = 3  # consecutive skipped runs before a prominent warning

def _increment_train_rejection_streak() -> int:
    """Increment the consecutive ML training rejection counter and return the new value.

    Emits a prominent WARNING once the streak reaches _TRAIN_REJECTION_ALERT_THRESHOLD so
    that operators are alerted when valid_days < MIN_TRAIN_DAYS persists across runs.
    """
    state = _load_json(ML_TRAIN_STATE_FILE)
    streak = int(state.get("consecutive_train_rejection_count", 0)) + 1
    state["consecutive_train_rejection_count"] = streak
    state["last_rejection_ts"] = int(time.time() * 1000)
    _save_json(ML_TRAIN_STATE_FILE, state)
    if streak >= _TRAIN_REJECTION_ALERT_THRESHOLD:
        log.warning(
            "ML TRAINING SKIPPED %d CONSECUTIVE RUN(S): insufficient valid training days. "
            "Forecast quality is degrading. Investigate weather data availability, Solcast "
            "snapshots, and historical actuals coverage.",
            streak,
        )
    return streak

def _reset_train_rejection_streak(bundle: dict | None = None) -> None:
    """Reset the consecutive ML training rejection counter after a successful training run."""
    state = _load_json(ML_TRAIN_STATE_FILE)
    prev = int(state.get("consecutive_train_rejection_count", 0))
    if prev > 0:
        log.info("ML training rejection streak cleared (was %d consecutive skips).", prev)
    state["consecutive_train_rejection_count"] = 0
    state["last_successful_train_ts"] = int(time.time() * 1000)

    # Add training metadata if bundle is provided
    if isinstance(bundle, dict):
        state["ml_backend_type"] = _detect_ml_backend()
        # T4.9 fix (Phase 7): surface WHY LightGBM isn't active to /engine-health.
        state["ml_backend_detail"] = _detect_ml_backend_detail()
        state["model_file_path"] = str(MODEL_FILE)
        state["model_file_mtime_ms"] = int(MODEL_FILE.stat().st_mtime * 1000) if MODEL_FILE.exists() else None
        state["training_samples_count"] = bundle.get("model_bundle", {}).get("global", {}).get("meta", {}).get("sample_count")
        state["training_features_count"] = bundle.get("model_bundle", {}).get("global", {}).get("meta", {}).get("feature_count")
        state["training_regimes_count"] = len(bundle.get("model_bundle", {}).get("regimes", {}))
        state["training_result"] = "accepted"
        state["last_training_date"] = bundle.get("training_date")
        state["data_warnings"] = _collect_data_quality_warnings(bundle.get("model_bundle", {}))
        state["outage_summary"] = bundle.get("model_bundle", {}).get("outage_summary", {})

        # ML-FA3 fix: move backend status to status_flags (not data_warnings)
        state["status_flags"] = {}
        if FORECAST_USE_LIGHTGBM and not _LIGHTGBM_AVAILABLE:
            state["status_flags"]["backend_fallback"] = True

    _save_json(ML_TRAIN_STATE_FILE, state)

def _has_forecast_dayahead_in_db(day: str) -> bool:
    """Check if forecast_dayahead has a complete solar-window rowset for the day."""
    try:
        with _open_sqlite(APP_DB_FILE, SQLITE_READ_TIMEOUT_SEC, readonly=True) as conn:
            row = conn.execute(
                """
                SELECT COUNT(DISTINCT slot)
                  FROM forecast_dayahead
                 WHERE date = ?
                   AND slot >= ?
                   AND slot < ?
                """,
                (str(day), int(SOLAR_START_SLOT), int(SOLAR_END_SLOT)),
            ).fetchone()
            return int(row[0] or 0) >= int(SOLAR_SLOTS)
    except Exception:
        return False

def _is_retryable_sqlite_error(exc: Exception) -> bool:
    """
    Classify SQLite errors as retryable transient vs permanent.

    v2.8 S4 expansion: recognizes additional transient error substrings
    common on Windows NUC deployments where brief filesystem / file-handle
    hiccups produce `unable to open database file` and `disk i/o error`
    despite the underlying file being healthy. These errors usually
    resolve within one retry backoff window.

    Non-transient errors (syntax, integrity, schema mismatch) are NOT
    retried — re-running them would produce the same failure and only
    waste the retry budget.
    """
    if not isinstance(exc, sqlite3.OperationalError):
        return False
    msg = str(exc).lower().strip()
    # Bare single-word matches (SQLite sometimes surfaces just "locked" or "busy")
    if msg in {"locked", "busy"}:
        return True
    # Substring matches for longer error messages
    retryable_substrings = (
        "database is locked",
        "database is busy",
        "unable to open database file",  # transient Windows file-handle contention
        "disk i/o error",                 # transient filesystem hiccup
    )
    return any(s in msg for s in retryable_substrings)

# v2.8 SQLite audit (M3): once-per-process WAL mode verification. If the
# DB file is not in WAL mode, Python's synchronous=NORMAL + busy_timeout
# assumptions are weaker than expected (DELETE journal doesn't give
# reader/writer concurrency). Log a one-time warning so drift from a
# fresh Python-created DB (test fixtures, backups restored into a fresh
# install) is visible early instead of surfacing as mysterious lock
# contention later.
_WAL_MODE_VERIFIED: dict[str, bool] = {}

def _verify_wal_mode_once(db_path: Path) -> None:
    key = str(db_path)
    if key in _WAL_MODE_VERIFIED:
        return
    # Mark as checked regardless of outcome — one-shot log only.
    _WAL_MODE_VERIFIED[key] = True
    try:
        if not db_path.exists():
            return
        uri = f"file:{db_path.as_posix()}?mode=ro"
        conn = sqlite3.connect(uri, timeout=2.0, uri=True)
        try:
            row = conn.execute("PRAGMA journal_mode").fetchone()
            mode = str(row[0] if row else "").lower()
            if mode and mode != "wal":
                log.warning(
                    "DB %s journal_mode=%r (expected 'wal'). "
                    "Python write retry / synchronous=NORMAL assumptions may not hold. "
                    "Check that Node initialized the DB with WAL mode.",
                    db_path.name, mode,
                )
        finally:
            conn.close()
    except Exception as e:
        log.debug("WAL mode verification skipped for %s: %s", db_path.name, e)

def _open_sqlite(db_path: Path, timeout_sec: float, readonly: bool = False) -> sqlite3.Connection:
    # v2.8 M3: one-shot WAL mode check on first open per-path.
    _verify_wal_mode_once(db_path)
    if readonly:
        uri = f"file:{db_path.as_posix()}?mode=ro"
        conn = sqlite3.connect(uri, timeout=timeout_sec, uri=True)
    else:
        conn = sqlite3.connect(str(db_path), timeout=timeout_sec)
    conn.execute(f"PRAGMA busy_timeout = {int(max(0.1, float(timeout_sec)) * 1000)}")
    # v2.8 efficiency audit (E7): lift page cache + enable mmap for read scans.
    # cache_size negative value = KB (16 MB here). temp_store=MEMORY keeps
    # ORDER BY / GROUP BY scratch in RAM. mmap_size is a ceiling hint, not
    # a pre-allocation. All three are connection-scoped and touch no disk state.
    if readonly:
        try:
            conn.execute("PRAGMA cache_size = -16384")
            conn.execute("PRAGMA temp_store = MEMORY")
            conn.execute("PRAGMA mmap_size = 67108864")
        except sqlite3.Error:
            pass  # tuning is best-effort; never fail open over pragma failure
    else:
        # v2.8 SQLite audit (M2): Python writers run with synchronous=FULL
        # by default (per-page fsync). Node's main writer already uses
        # synchronous=NORMAL in WAL mode, which is crash-safe and ~5-10x
        # faster for bulk inserts. Matching it here means Python's
        # occasional QA / audit / forecast writes don't pay the FULL
        # fsync cost. Safe because Node has already set journal_mode=WAL
        # at DB creation; synchronous is per-connection, not persistent.
        try:
            conn.execute("PRAGMA synchronous = NORMAL")
        except sqlite3.Error:
            pass  # best-effort; never fail open over pragma failure
    return conn

def _sleep_sqlite_retry(attempt: int) -> None:
    # v2.8 SQLite audit O1: exponential backoff. Previously linear
    # (0.35 × attempt → 0.35, 0.70, 1.05 s). Exponential (0.35 × 2^(n-1)
    # → 0.35, 0.70, 1.40 s) gives a contending writer slightly more
    # breathing room on the third attempt without significantly
    # extending the total retry budget. Capped at 2.0 s so retries
    # don't blow the overall 20 s write timeout.
    n = max(1, int(attempt))
    delay = SQLITE_RETRY_BACKOFF_SEC * (2 ** (n - 1))
    time.sleep(min(delay, 2.0))

def _coerce_non_negative_float(value, default: float = 0.0) -> float:
    try:
        f = float(value)
    except Exception:
        return float(default)
    if not math.isfinite(f):
        return float(default)
    return max(0.0, f)

def _coerce_optional_non_negative_float(value) -> float | None:
    try:
        f = float(value)
    except Exception:
        return None
    if not math.isfinite(f):
        return None
    return max(0.0, f)

def _normalize_solcast_slot_pair(
    energy_kwh_value,
    power_mw_value,
) -> tuple[float | None, float | None]:
    energy_kwh = _coerce_optional_non_negative_float(energy_kwh_value)
    power_mw = _coerce_optional_non_negative_float(power_mw_value)
    # Solcast arrives as MW. Forecast scoring inside the engine is done on a
    # per-slot energy basis, so derive the missing side when only one form is
    # stored in the snapshot row.
    if energy_kwh is None and power_mw is not None:
        energy_kwh = power_mw * SOLCAST_KWH_PER_MW_SLOT
    if power_mw is None and energy_kwh is not None:
        power_mw = energy_kwh / max(SOLCAST_KWH_PER_MW_SLOT, 1e-9)
    return energy_kwh, power_mw

def _empty_slot_values() -> np.ndarray:
    return np.zeros(SLOTS_DAY, dtype=float)

def _empty_slot_presence() -> np.ndarray:
    return np.zeros(SLOTS_DAY, dtype=bool)

def _count_solar_present_slots(present: np.ndarray | None) -> int:
    if present is None:
        return 0
    arr = np.asarray(present, dtype=bool)
    if arr.size < SLOTS_DAY:
        return 0
    return int(np.count_nonzero(arr[SOLAR_START_SLOT:SOLAR_END_SLOT]))

def _parse_slot_from_time_text(day: str, time_text: str | None) -> int | None:
    try:
        raw = str(time_text or "").strip()
        if not raw:
            return None
        parts = [int(p) for p in raw.split(":")]
        if len(parts) < 2:
            return None
        hh = parts[0]
        mm = parts[1]
        if hh < 0 or hh > 23 or mm < 0 or mm > 59:
            return None
        slot = (hh * 60 + mm) // SLOT_MIN
        return slot if 0 <= slot < SLOTS_DAY else None
    except Exception:
        return None

def _default_legacy_slot(index: int, total_rows: int) -> int:
    if total_rows <= SOLAR_SLOTS:
        return SOLAR_START_SLOT + int(index)
    return int(index)

def _merge_slot_series(
    label: str,
    day: str,
    primary_values: np.ndarray | None,
    primary_present: np.ndarray | None,
    fallback_values: np.ndarray | None,
    fallback_present: np.ndarray | None,
    min_solar_slots: int,
) -> np.ndarray | None:
    if primary_values is None and fallback_values is None:
        return None

    if primary_values is None:
        merged_values = np.array(fallback_values, dtype=float, copy=True)
        merged_present = np.array(fallback_present, dtype=bool, copy=True)
    else:
        merged_values = np.array(primary_values, dtype=float, copy=True)
        merged_present = np.array(primary_present, dtype=bool, copy=True)
        if fallback_values is not None and fallback_present is not None:
            fill_mask = (~merged_present) & np.asarray(fallback_present, dtype=bool)
            if np.any(fill_mask):
                merged_values[fill_mask] = np.asarray(fallback_values, dtype=float)[fill_mask]
                merged_present[fill_mask] = True
                log.info(
                    "%s source gap fill [%s]: filled %d slots from legacy fallback",
                    label,
                    day,
                    int(np.count_nonzero(fill_mask)),
                )

    solar_slots = _count_solar_present_slots(merged_present)
    if solar_slots <= 0:
        return None
    if solar_slots < min_solar_slots:
        log.warning(
            "%s coverage is sparse [%s]: %d solar slots available (min=%d). Skipping this day.",
            label,
            day,
            solar_slots,
            min_solar_slots,
        )
        return None

    merged_values = np.nan_to_num(merged_values, nan=0.0, posinf=0.0, neginf=0.0)
    merged_values[merged_values < 0] = 0.0
    return merged_values

def _merge_slot_series_with_presence(
    label: str,
    day: str,
    primary_values: np.ndarray | None,
    primary_present: np.ndarray | None,
    fallback_values: np.ndarray | None,
    fallback_present: np.ndarray | None,
    min_solar_slots: int,
) -> tuple[np.ndarray | None, np.ndarray | None]:
    if primary_values is None and fallback_values is None:
        return None, None

    def _sanitise_source(values, present):
        if values is None or present is None:
            return None, None
        vals = np.asarray(values, dtype=float).copy()
        seen = np.asarray(present, dtype=bool).copy()
        if vals.size != SLOTS_DAY or seen.size != SLOTS_DAY:
            return None, None
        seen &= np.isfinite(vals) & (vals >= 0.0)
        vals = np.where(seen, vals, 0.0)
        return vals, seen

    primary_values, primary_present = _sanitise_source(primary_values, primary_present)
    fallback_values, fallback_present = _sanitise_source(fallback_values, fallback_present)

    if primary_values is None:
        merged_values = np.array(fallback_values, dtype=float, copy=True)
        merged_present = np.array(fallback_present, dtype=bool, copy=True)
    else:
        merged_values = np.array(primary_values, dtype=float, copy=True)
        merged_present = np.array(primary_present, dtype=bool, copy=True)
        if fallback_values is not None and fallback_present is not None:
            fill_mask = (~merged_present) & np.asarray(fallback_present, dtype=bool)
            if np.any(fill_mask):
                merged_values[fill_mask] = np.asarray(fallback_values, dtype=float)[fill_mask]
                merged_present[fill_mask] = True
                log.info(
                    "%s source gap fill [%s]: filled %d slots from legacy fallback",
                    label,
                    day,
                    int(np.count_nonzero(fill_mask)),
                )

    solar_slots = _count_solar_present_slots(merged_present)
    if solar_slots <= 0:
        return None, None
    if solar_slots < min_solar_slots:
        log.warning(
            "%s coverage is sparse [%s]: %d solar slots available (min=%d). Skipping this day.",
            label,
            day,
            solar_slots,
            min_solar_slots,
        )
        return None, None

    return merged_values, merged_present

def clear_forecast_data_cache() -> None:
    global _cached_loss_factors
    _cached_loss_factors = None
    _read_setting_value.cache_clear()
    load_forecast_export_limit_mw.cache_clear()
    load_ipconfig_authoritative.cache_clear()
    load_actual.cache_clear()
    load_actual_with_presence.cache_clear()
    load_actual_loss_adjusted.cache_clear()
    load_actual_loss_adjusted_with_presence.cache_clear()
    load_dayahead.cache_clear()
    load_dayahead_with_presence.cache_clear()
    load_intraday_adjusted.cache_clear()
    load_intraday_adjusted_with_presence.cache_clear()
    load_operational_constraint_profile.cache_clear()
    completed_outage_cache = globals().get("_build_completed_1000h_inverter_outage_mask")
    if completed_outage_cache is not None and hasattr(completed_outage_cache, "cache_clear"):
        completed_outage_cache.cache_clear()

def _slice_weather_day(df: pd.DataFrame, day: str) -> pd.DataFrame:
    """Return rows belonging only to YYYY-MM-DD (local naive timestamps)."""
    if df is None or df.empty or "time" not in df.columns:
        return pd.DataFrame()
    out = df.copy()
    out["time"] = pd.to_datetime(out["time"], errors="coerce")
    out = out.dropna(subset=["time"])
    if out.empty:
        return pd.DataFrame()
    day_start = pd.Timestamp(f"{day} 00:00:00")
    day_end = day_start + pd.Timedelta(days=1)
    out = out[(out["time"] >= day_start) & (out["time"] < day_end)].copy()
    out = out.sort_values("time").reset_index(drop=True)
    return out

def _is_past_day(day: str) -> bool:
    try:
        req = datetime.strptime(day, "%Y-%m-%d").date()
    except Exception:
        return False
    return req < datetime.now().date()

def validate_weather_hourly(day: str, wdf: pd.DataFrame) -> tuple[bool, str]:
    req_cols = {
        "time", "rad", "rad_direct", "rad_diffuse", "cloud", "cloud_low",
        "cloud_mid", "cloud_high", "temp", "rh", "wind", "precip", "cape"
    }
    if wdf is None or wdf.empty:
        return False, "weather dataframe is empty"
    missing = [c for c in req_cols if c not in wdf.columns]
    if missing:
        return False, f"missing weather columns: {', '.join(missing)}"
    if len(wdf) < MIN_HOURLY_POINTS:
        return False, f"insufficient hourly rows ({len(wdf)})"
    return True, ""

def validate_weather_5min(day: str, w5: pd.DataFrame) -> tuple[bool, str]:
    req_cols = [
        "rad", "rad_direct", "rad_diffuse", "cloud", "cloud_low", "cloud_mid",
        "temp", "rh", "wind"
    ]
    if w5 is None or w5.empty:
        return False, "interpolated weather is empty"
    missing = [c for c in req_cols if c not in w5.columns]
    if missing:
        return False, f"missing interpolated weather columns: {', '.join(missing)}"
    if len(w5) < MIN_5MIN_POINTS:
        return False, f"insufficient 5-min slots ({len(w5)})"
    for c in req_cols:
        arr = pd.to_numeric(w5[c], errors="coerce").values
        if not np.isfinite(arr).any():
            return False, f"column {c} has no finite values"
    return True, ""

# ============================================================================
# IPCONFIG RESOLUTION
# ============================================================================

def _default_ipconfig() -> dict:
    cfg = {"inverters": {}, "poll_interval": {}, "units": {}, "losses": {}}
    for i in range(1, 28):
        key = str(i)
        cfg["inverters"][key] = ""
        cfg["poll_interval"][key] = 0.05
        cfg["units"][key] = [1, 2, 3, 4]
        cfg["losses"][key] = float(DEFAULT_INVERTER_LOSS_PCT)
    return cfg

def _sanitize_ipconfig(data) -> dict:
    out = _default_ipconfig()
    src = data if isinstance(data, dict) else {}
    src_inv = src.get("inverters", {}) if isinstance(src.get("inverters"), dict) else {}
    src_poll = src.get("poll_interval", {}) if isinstance(src.get("poll_interval"), dict) else {}
    src_units = src.get("units", {}) if isinstance(src.get("units"), dict) else {}
    src_losses = src.get("losses", {}) if isinstance(src.get("losses"), dict) else {}

    for i in range(1, 28):
        key = str(i)
        ip_raw = src_inv.get(key, src_inv.get(i, out["inverters"][key]))
        poll_raw = src_poll.get(key, src_poll.get(i, out["poll_interval"][key]))
        units_raw = src_units.get(key, src_units.get(i, out["units"][key]))
        loss_raw = src_losses.get(key, src_losses.get(i, out["losses"][key]))

        ip = str(ip_raw or "").strip()

        try:
            poll = float(poll_raw)
        except Exception:
            poll = float(out["poll_interval"][key])
        if not math.isfinite(poll) or poll < 0.01:
            poll = float(out["poll_interval"][key])

        if isinstance(units_raw, list):
            units = []
            for unit in units_raw:
                try:
                    unit_i = int(unit)
                except Exception:
                    continue
                if 1 <= unit_i <= 4 and unit_i not in units:
                    units.append(unit_i)
        else:
            units = list(out["units"][key])

        try:
            loss_pct = float(loss_raw)
        except Exception:
            loss_pct = float(out["losses"][key])
        if not math.isfinite(loss_pct) or loss_pct < 0.0 or loss_pct > 100.0:
            loss_pct = float(out["losses"][key])

        out["inverters"][key] = ip
        out["poll_interval"][key] = poll
        out["units"][key] = units
        out["losses"][key] = loss_pct

    return out

@lru_cache(maxsize=1)
def load_ipconfig_authoritative() -> dict:
    raw = _read_setting_value(IPCONFIG_SETTING_KEY)
    if raw:
        try:
            return {
                "config": _sanitize_ipconfig(json.loads(raw)),
                "source": f"settings:{IPCONFIG_SETTING_KEY}",
                "path": str(APP_DB_FILE),
            }
        except Exception as e:
            log.warning("Invalid %s setting - falling back to file ipconfig: %s", IPCONFIG_SETTING_KEY, e)

    for path in [IPCONFIG_FILE, *LEGACY_IPCONFIG_FILES]:
        cfg = _load_json(path)
        if isinstance(cfg, dict) and cfg:
            return {
                "config": _sanitize_ipconfig(cfg),
                "source": "file",
                "path": str(path),
            }

    return {
        "config": _default_ipconfig(),
        "source": "default",
        "path": str(IPCONFIG_FILE),
    }

# ============================================================================
# PLANT CAPACITY
# ============================================================================

def _sanitize_units(raw) -> list[int]:
    """Return unique unit IDs in [1..4]."""
    out = []
    seen = set()
    if not isinstance(raw, list):
        return out
    for v in raw:
        try:
            u = int(v)
        except Exception:
            continue
        if 1 <= u <= 4 and u not in seen:
            out.append(u)
            seen.add(u)
    return out

def plant_capacity_profile() -> dict:
    """
    Capacity model from ipconfig — **node-based** (v2.4.44+).
      - Each enabled node contributes NODE_KW_DEPENDABLE / NODE_KW_MAX directly.
      - Per-inverter transmission loss is applied to that inverter's node count.
      - if units entry is missing for a configured inverter, assume 4 nodes
      - if units entry is [], inverter contributes 0 nodes
    """
    ipconfig_meta = load_ipconfig_authoritative()
    cfg = ipconfig_meta.get("config", {}) if isinstance(ipconfig_meta, dict) else {}
    inv_map = cfg.get("inverters", {}) or {}
    unit_map = cfg.get("units", {}) or {}

    inv_map = {str(k): v for k, v in inv_map.items()}
    unit_map = {str(k): v for k, v in unit_map.items()}

    all_ids = set(inv_map.keys()) | set(unit_map.keys())
    if not all_ids:
        fb_kw = PLANT_MW_FALLBACK * 1000.0
        return {
            "configured_inverters": 0,
            "enabled_nodes": 0,
            "loss_adjusted_nodes": fb_kw / max(NODE_KW_DEPENDABLE, 1.0),
            "dependable_kw": fb_kw,
            "max_kw": fb_kw,
            "source": "fallback",
            "ipconfig_source": str(ipconfig_meta.get("source", "missing")),
            "ipconfig_path": str(ipconfig_meta.get("path", IPCONFIG_FILE)),
        }

    def _sort_key(k: str):
        try:
            return (0, int(k))
        except Exception:
            return (1, k)

    loss_map = cfg.get("losses", {}) or {}
    loss_map = {str(k): v for k, v in loss_map.items()}

    configured = 0
    enabled_nodes = 0
    loss_adjusted_nodes = 0.0
    for inv_id in sorted(all_ids, key=_sort_key):
        ip = str(inv_map.get(inv_id, "") or "").strip()

        # If inverter exists in ip map but IP is blank, skip it.
        if inv_map and inv_id in inv_map and not ip:
            continue

        configured += 1
        raw_units = unit_map.get(inv_id, None)
        if raw_units is None:
            # Backward compatibility: no units config means full inverter.
            n_nodes = 4
        else:
            n_nodes = len(_sanitize_units(raw_units))
        enabled_nodes += n_nodes

        # Per-inverter transmission loss (cable degradation / distance)
        loss_pct = 0.0
        try:
            loss_pct = float(loss_map.get(inv_id, 0))
        except (TypeError, ValueError):
            pass
        if loss_pct < 0 or loss_pct > 100:
            loss_pct = 0.0
        loss_adjusted_nodes += n_nodes * (1.0 - loss_pct / 100.0)

    if configured == 0:
        fb_kw = PLANT_MW_FALLBACK * 1000.0
        return {
            "configured_inverters": 0,
            "enabled_nodes": 0,
            "loss_adjusted_nodes": fb_kw / max(NODE_KW_DEPENDABLE, 1.0),
            "dependable_kw": fb_kw,
            "max_kw": fb_kw,
            "source": "fallback",
            "ipconfig_source": str(ipconfig_meta.get("source", "missing")),
            "ipconfig_path": str(ipconfig_meta.get("path", IPCONFIG_FILE)),
        }

    dependable_kw = loss_adjusted_nodes * NODE_KW_DEPENDABLE
    max_kw = loss_adjusted_nodes * NODE_KW_MAX

    return {
        "configured_inverters": configured,
        "enabled_nodes": enabled_nodes,
        "loss_adjusted_nodes": loss_adjusted_nodes,
        "dependable_kw": dependable_kw,
        "max_kw": max_kw,
        "source": "ipconfig",
        "ipconfig_source": str(ipconfig_meta.get("source", "file")),
        "ipconfig_path": str(ipconfig_meta.get("path", IPCONFIG_FILE)),
    }

def plant_capacity_kw(dependable: bool = True) -> float:
    """Return plant capacity in kW from ipconfig or fallback."""
    p = plant_capacity_profile()
    cap = float(p["dependable_kw"] if dependable else p["max_kw"])
    log.debug(
        "Plant capacity [%s]: cfg_inv=%d enabled_nodes=%d loss_adj_nodes=%.3f dep=%.1f kW max=%.1f kW",
        p["source"],
        p["configured_inverters"],
        p["enabled_nodes"],
        p["loss_adjusted_nodes"],
        p["dependable_kw"],
        p["max_kw"],
    )
    return cap

def slot_cap_kwh(dependable: bool = True) -> float:
    """Maximum kWh in a single 5-min slot based on plant capacity only.

    NOTE: The configured forecast export cap is intentionally NOT applied here.
    Applying it to the forecast curve creates an artificial flat plateau
    that hides the true shape " cloud dips, afternoon shoulders, etc.
    Export limiting is a dispatch/curtailment action, not a forecast property.
    """
    cap_kw = plant_capacity_kw(dependable)
    return cap_kw * SLOT_MIN / 60.0

def plant_node_count() -> int:
    """Return enabled power-module count across the plant."""
    profile = plant_capacity_profile()
    enabled_nodes = int(profile.get("enabled_nodes") or 0)
    if enabled_nodes > 0:
        return enabled_nodes
    fallback = int(round(max(profile.get("max_kw", 0.0), plant_capacity_kw(False)) / max(NODE_KW_NOMINAL, 1.0)))
    return max(1, fallback)

def node_slot_kwh() -> float:
    """Approximate per-node 5-minute energy step used for low-power staging."""
    node_count = max(1, plant_node_count())
    return plant_capacity_kw(True) * SLOT_MIN / 60.0 / node_count

def activity_threshold_kwh() -> float:
    """
    Minimum meaningful slot energy used for activity detection.

    This stays small enough for dawn pickup but large enough to suppress
    tiny non-zero artifacts created by interpolated weather.
    """
    return max(1.0, min(node_slot_kwh() * 0.18, slot_cap_kwh(True) * ACTIVITY_MIN_FRACTION))

def _solar_hour_bounds(hour: int) -> tuple[int, int]:
    start = int(hour) * 60 // SLOT_MIN
    end = start + (60 // SLOT_MIN)
    return max(0, start), min(SLOTS_DAY, end)

def _season_bucket_from_day(day: str) -> str:
    try:
        month = datetime.strptime(day, "%Y-%m-%d").month
    except Exception:
        month = datetime.now().month
    return "dry" if month in (12, 1, 2, 3, 4, 5) else "wet"

def _is_extreme_weather_day(
    actual_solar: np.ndarray,
    solcast_solar: np.ndarray,
) -> bool:
    """
    Detect typhoon / severe monsoon days where generation fell far below Solcast
    for a sustained period. These days are excluded from ML training to prevent
    the model from learning a systematic downward bias on rainy days.
    """
    if actual_solar.size == 0 or solcast_solar.size == 0:
        return False
    usable = solcast_solar > 0.5  # only where Solcast expects meaningful generation
    if int(np.count_nonzero(usable)) < EXTREME_WEATHER_SLOT_THRESHOLD:
        return False
    ratio = np.where(usable, actual_solar / np.maximum(solcast_solar, 0.01), 1.0)
    severe_slots = int(np.count_nonzero((ratio < EXTREME_WEATHER_RATIO_THRESHOLD) & usable))
    return severe_slots >= EXTREME_WEATHER_SLOT_THRESHOLD

def _tod_zone_for_slot(slot_idx: int):
    """Return 'morning', 'midday', 'afternoon', or None if outside solar window."""
    for zone, (zs, ze) in TOD_ZONES.items():
        if zs <= slot_idx < ze:
            return zone
    return None

def _compute_tod_slot_metrics(actual: np.ndarray, forecast: np.ndarray, present_mask: np.ndarray, exclude_mask: np.ndarray | None = None) -> dict:
    """Per-zone slot-level metrics (bias_ratio, mape, slot_count) from 288-slot arrays."""
    result = {}
    for zone, (zs, ze) in TOD_ZONES.items():
        _exclude_zone = exclude_mask[zs:ze] if exclude_mask is not None else np.zeros(ze - zs, dtype=bool)
        z_mask = (
            present_mask[zs:ze]
            & (forecast[zs:ze] > 0.0)
            & (~_exclude_zone)
        )
        usable = int(np.count_nonzero(z_mask))
        if usable < 4:
            continue
        z_actual = np.clip(actual[zs:ze][z_mask], 0.0, None)
        z_forecast = forecast[zs:ze][z_mask]
        bias_ratio = float(np.clip(
            z_actual.sum() / max(float(z_forecast.sum()), 1e-6),
            *SOLCAST_BIAS_RATIO_CLIP,
        ))
        mape = float(np.mean(np.abs(z_actual - z_forecast) / np.maximum(z_actual, 1e-6)))
        result[zone] = {
            "bias_ratio": bias_ratio,
            "mape": mape,
            "slot_count": usable,
        }
    return result

def _compute_solcast_trend(records: list) -> dict:
    """Compute trend signal from daily reliability records (most-recent-first)."""
    stable_fallback = {
        "signal": "stable",
        "magnitude": 0.0,
        "first_half_reliability": 0.0,
        "second_half_reliability": 0.0,
        "first_half_days": 0,
        "second_half_days": 0,
    }
    if not records:
        return stable_fallback
    mid = len(records) // 2
    first_half = records[:mid]   # more recent
    second_half = records[mid:]  # older
    if len(first_half) < SOLCAST_TREND_MIN_DAYS_PER_HALF or len(second_half) < SOLCAST_TREND_MIN_DAYS_PER_HALF:
        return stable_fallback
    first_mean_mape = float(np.mean([r["mape"] for r in first_half]))
    second_mean_mape = float(np.mean([r["mape"] for r in second_half]))
    first_rel = float(1.0 - min(first_mean_mape, 0.55) / 0.55)
    second_rel = float(1.0 - min(second_mean_mape, 0.55) / 0.55)
    magnitude = first_rel - second_rel  # positive = recent half is better = improving
    if magnitude > SOLCAST_TREND_IMPROVING_THRESHOLD:
        signal = "improving"
    elif magnitude < SOLCAST_TREND_DEGRADING_THRESHOLD:
        signal = "degrading"
    else:
        signal = "stable"
    return {
        "signal": signal,
        "magnitude": float(magnitude),
        "first_half_reliability": float(first_rel),
        "second_half_reliability": float(second_rel),
        "first_half_days": len(first_half),
        "second_half_days": len(second_half),
    }

def lookup_solcast_tod_reliability(artifact, regime: str, zone: str) -> dict:
    """Lookup ToD reliability: time_of_day_by_regime[regime][zone] -> time_of_day[zone] -> fallback."""
    fallback = {"bias_ratio": 1.0, "mape": 0.24, "reliability": 0.62, "slot_count": 0}
    if not artifact or not isinstance(artifact, dict):
        log.warning("Solcast reliability artifact unavailable - using hardcoded defaults (reliability=0.62, bias_ratio=1.0). Forecast quality may be degraded.")
        return fallback
    by_regime = artifact.get("time_of_day_by_regime")
    if isinstance(by_regime, dict):
        regime_zones = by_regime.get(regime)
        if isinstance(regime_zones, dict) and zone in regime_zones:
            out = dict(fallback)
            out.update(regime_zones[zone])
            return out
    tod = artifact.get("time_of_day")
    if isinstance(tod, dict) and zone in tod:
        out = dict(fallback)
        out.update(tod[zone])
        return out
    return fallback

def lookup_solcast_trend(artifact) -> dict:
    """Return trend dict from artifact, or stable fallback."""
    if artifact and isinstance(artifact, dict) and "trend" in artifact:
        return artifact["trend"]
    return {"signal": "stable", "magnitude": 0.0, "first_half_reliability": 0.0, "second_half_reliability": 0.0, "first_half_days": 0, "second_half_days": 0}

def _rolling_window_bounds(length: int, window: int, center: bool = False) -> tuple[np.ndarray, np.ndarray]:
    size = max(int(length), 0)
    win = max(int(window), 1)
    idx = np.arange(size, dtype=int)
    if center:
        left = (win - 1) // 2
        right = win // 2
        start = np.clip(idx - left, 0, size)
        end = np.clip(idx + right + 1, 0, size)
    else:
        start = np.clip(idx - win + 1, 0, size)
        end = idx + 1
    return start, end

def _rolling_sum(values: np.ndarray, window: int, center: bool = False) -> np.ndarray:
    arr = np.asarray(values, dtype=float).reshape(-1)
    if arr.size <= 0:
        return np.zeros(0, dtype=float)
    start, end = _rolling_window_bounds(arr.size, window, center=center)
    valid = np.isfinite(arr)
    arr_valid = np.where(valid, arr, 0.0)
    csum = np.concatenate(([0.0], np.cumsum(arr_valid, dtype=float)))
    count = np.concatenate(([0], np.cumsum(valid.astype(np.int64), dtype=np.int64)))
    out = csum[end] - csum[start]
    out[(count[end] - count[start]) <= 0] = np.nan
    return out

def _rolling_mean(values: np.ndarray, window: int, center: bool = False) -> np.ndarray:
    arr = np.asarray(values, dtype=float).reshape(-1)
    if arr.size <= 0:
        return np.zeros(0, dtype=float)
    start, end = _rolling_window_bounds(arr.size, window, center=center)
    valid = np.isfinite(arr)
    arr_valid = np.where(valid, arr, 0.0)
    csum = np.concatenate(([0.0], np.cumsum(arr_valid, dtype=float)))
    count = np.concatenate(([0], np.cumsum(valid.astype(np.int64), dtype=np.int64)))
    numer = csum[end] - csum[start]
    denom = count[end] - count[start]
    return np.divide(numer, denom, out=np.full(arr.size, np.nan, dtype=float), where=denom > 0)

def _rolling_std(values: np.ndarray, window: int, center: bool = False, ddof: int = 1) -> np.ndarray:
    arr = np.asarray(values, dtype=float).reshape(-1)
    if arr.size <= 0:
        return np.zeros(0, dtype=float)
    start, end = _rolling_window_bounds(arr.size, window, center=center)
    valid = np.isfinite(arr)
    arr_valid = np.where(valid, arr, 0.0)
    csum = np.concatenate(([0.0], np.cumsum(arr_valid, dtype=float)))
    csum_sq = np.concatenate(([0.0], np.cumsum(arr_valid * arr_valid, dtype=float)))
    count = np.concatenate(([0], np.cumsum(valid.astype(np.int64), dtype=np.int64)))
    numer = csum[end] - csum[start]
    numer_sq = csum_sq[end] - csum_sq[start]
    denom_count = count[end] - count[start]
    mean = np.divide(numer, denom_count, out=np.zeros(arr.size, dtype=float), where=denom_count > 0)
    var_numer = np.clip(numer_sq - (numer * mean), 0.0, None)
    denom = denom_count - max(int(ddof), 0)
    var = np.divide(var_numer, denom, out=np.full(arr.size, np.nan, dtype=float), where=denom > 0)
    return np.sqrt(np.clip(var, 0.0, None))

def _normalize_profile(values: np.ndarray) -> np.ndarray:
    arr = np.clip(np.asarray(values, dtype=float), 0.0, None)
    if arr.size == 0:
        return np.array([], dtype=float)
    arr = _rolling_mean(arr, 3, center=True)
    total = float(arr.sum())
    if total <= 0:
        return np.full(arr.size, 1.0 / arr.size, dtype=float)
    return arr / total

# NOTE (v2.8 cleanup): `_anen_find_analogs` and `_anen_correction_ratio` were
# removed. The Analog Ensemble post-correction was a recency-only scalar
# `actual/forecast` ratio (clipped ±15%) that ran AFTER `compute_error_memory`
# had already corrected per-slot bias. Both layers were solving the same
# problem; error_memory does it with regime-aware decay + spread weighting.

def _find_first_active_slot(values: np.ndarray, threshold: float | None = None, sustain_slots: int = ACTIVITY_SUSTAIN_SLOTS) -> int | None:
    arr = np.clip(np.asarray(values, dtype=float), 0.0, None)
    threshold = activity_threshold_kwh() if threshold is None else float(threshold)
    sustain = max(1, int(sustain_slots))
    for slot in range(SOLAR_START_SLOT, SOLAR_END_SLOT - sustain + 1):
        window = arr[slot:slot + sustain]
        if window.size and float(window.mean()) >= threshold and np.all(window >= threshold * 0.55):
            return slot
    return None

def _find_last_active_slot(values: np.ndarray, threshold: float | None = None, sustain_slots: int = ACTIVITY_SUSTAIN_SLOTS) -> int | None:
    arr = np.clip(np.asarray(values, dtype=float), 0.0, None)
    threshold = activity_threshold_kwh() if threshold is None else float(threshold)
    sustain = max(1, int(sustain_slots))
    for slot in range(SOLAR_END_SLOT - sustain, SOLAR_START_SLOT - 1, -1):
        window = arr[slot:slot + sustain]
        if window.size and float(window.mean()) >= threshold and np.all(window >= threshold * 0.45):
            return slot + window.size - 1
    return None

def _sample_weight_for_days_ago(days_ago: int) -> float:
    days = max(0.0, float(days_ago) - 1.0)
    weight = 0.5 ** (days / max(TRAIN_WEIGHT_HALF_LIFE_DAYS, 1e-6))
    return float(np.clip(weight, TRAIN_WEIGHT_FLOOR, 1.0))

def _weather_cache_path(day: str, source_kind: str) -> Path:
    loc_tag = f"{LAT_DEG:.6f}_{LON_DEG:.6f}".replace("-", "m")
    tag = "archive" if str(source_kind or "").strip().lower() == "archive" else "forecast"
    return WEATHER_DIR / f"om_{tag}_{day}_{loc_tag}.csv"

# ============================================================================
# WEATHER FETCH & CACHE
# ============================================================================

# v2.8 efficiency audit (E3): in-memory cache on top of disk CSV cache.
# Keyed by (day, source_kind). Value is (cache_mtime_ns, day_df_copy).
# Archive weather for past days is immutable, so cache hits skip the
# CSV parse + validate entirely. Invalidated by cache-file mtime change.
_WEATHER_MEM_CACHE: dict[tuple[str, str], tuple[int, pd.DataFrame]] = {}
_WEATHER_MEM_CACHE_MAX = 256

# v2.8 efficiency audit (E1a/P2): per-cycle day-keyed read cache for the
# load_solcast_snapshot helper (the only hot-path DB reader that did NOT
# already have an lru_cache — load_dayahead_with_presence and
# load_actual_loss_adjusted_with_presence are already cached at
# subprocess lifetime). Lives only for the duration of a forecast pass;
# cleared by _reset_forecast_cycle_cache() at the top of run_dayahead so
# downstream writes (QA, error memory) never leak through. Invalidation
# is tied to our own control flow, not filesystem timestamps, so it is
# robust against Node-side concurrent writes to the SQLite file.
#
# Soft-capped to bound memory in long-running / daemon entry points that
# don't explicitly reset (e.g. backtest loops). Oldest ~25% evicted when
# full — insertion order is preserved by dict since Python 3.7.
_FORECAST_CYCLE_CACHE: dict[tuple[str, str], object] = {}
_FORECAST_CYCLE_CACHE_MAX = 512
_CYCLE_CACHE_MISS = object()

def _cycle_cache_get(name: str, day: str):
    """Return cached value or _CYCLE_CACHE_MISS sentinel if absent."""
    return _FORECAST_CYCLE_CACHE.get((name, day), _CYCLE_CACHE_MISS)

def _cycle_cache_put(name: str, day: str, value) -> None:
    if len(_FORECAST_CYCLE_CACHE) >= _FORECAST_CYCLE_CACHE_MAX:
        victims = list(_FORECAST_CYCLE_CACHE.keys())[: _FORECAST_CYCLE_CACHE_MAX // 4]
        for k in victims:
            _FORECAST_CYCLE_CACHE.pop(k, None)
    _FORECAST_CYCLE_CACHE[(name, day)] = value

def _reset_forecast_cycle_cache() -> None:
    """
    Clear all day-keyed read caches at the start of a forecast pass.

    Also clears the lru_caches on `load_dayahead_with_presence`,
    `load_dayahead`, `load_actual_loss_adjusted_with_presence`, and
    `load_actual_loss_adjusted`. Those helpers carry subprocess-lifetime
    caches whose comments flag daemon-mode staleness as a latent risk;
    routing the reset through a single chokepoint closes that gap for
    any caller that opts into the cycle boundary.
    """
    _FORECAST_CYCLE_CACHE.clear()
    for fn_name in (
        "load_dayahead_with_presence",
        "load_dayahead",
        "load_actual_loss_adjusted_with_presence",
        "load_actual_loss_adjusted",
        "_build_completed_1000h_inverter_outage_mask",
    ):
        fn = globals().get(fn_name)
        if fn is not None and hasattr(fn, "cache_clear"):
            try:
                fn.cache_clear()
            except Exception:
                pass

def _weather_mem_cache_get(day: str, source_kind: str, cache_path: Path) -> pd.DataFrame | None:
    try:
        mtime_ns = cache_path.stat().st_mtime_ns
    except OSError:
        return None
    entry = _WEATHER_MEM_CACHE.get((day, source_kind))
    if entry is None or entry[0] != mtime_ns:
        return None
    return entry[1].copy()

def _weather_mem_cache_put(day: str, source_kind: str, cache_path: Path, day_df: pd.DataFrame) -> None:
    try:
        mtime_ns = cache_path.stat().st_mtime_ns
    except OSError:
        return
    # Cheap LRU-ish: when full, drop ~1/4 oldest entries by insertion order.
    if len(_WEATHER_MEM_CACHE) >= _WEATHER_MEM_CACHE_MAX:
        victims = list(_WEATHER_MEM_CACHE.keys())[: _WEATHER_MEM_CACHE_MAX // 4]
        for k in victims:
            _WEATHER_MEM_CACHE.pop(k, None)
    _WEATHER_MEM_CACHE[(day, source_kind)] = (mtime_ns, day_df.copy())

def fetch_weather(day: str, source: str = "auto") -> pd.DataFrame | None:
    """
    Fetch hourly weather from Open-Meteo for *day* (YYYY-MM-DD).

    `source="archive"` always means observed archive weather for historical
    training and bias evaluation. `source="forecast"` means the provider
    forecast used for day-ahead generation. `source="auto"` uses archive for
    past days and forecast for today/future days.
    """
    src_raw = str(source or "auto").strip().lower()
    if src_raw not in {"auto", "archive", "forecast"}:
        src_raw = "auto"
    source_kind = "archive" if src_raw == "archive" or (src_raw == "auto" and _is_past_day(day)) else "forecast"
    cache = _weather_cache_path(day, source_kind)
    today = datetime.now().strftime("%Y-%m-%d")

    def _load_cached_weather() -> pd.DataFrame | None:
        try:
            if not cache.exists():
                return None
            # v2.8 efficiency audit (E3): in-memory tier before CSV parse.
            mem_hit = _weather_mem_cache_get(day, source_kind, cache)
            if mem_hit is not None:
                return mem_hit
            df = pd.read_csv(cache, parse_dates=["time"])
            day_df = _slice_weather_day(df, day)
            ok, reason = validate_weather_hourly(day, day_df)
            if ok:
                log.debug("Weather cache hit [%s]: %s (%d rows)", source_kind, day, len(day_df))
                _weather_mem_cache_put(day, source_kind, cache, day_df)
                return day_df
            log.warning("Weather cache invalid [%s] for %s: %s", source_kind, day, reason)
        except Exception:
            return None
        return None

    def _fallback_cached_weather(reason: str) -> pd.DataFrame | None:
        if source_kind != "forecast":
            return None
        cached = _load_cached_weather()
        if cached is not None:
            log.warning(
                "Weather fetch fallback [%s] for %s: %s; using cached forecast weather.",
                source_kind,
                day,
                reason,
            )
            return cached
        return None

    use_cache = not (source_kind == "forecast" and day == today)
    if use_cache:
        cached = _load_cached_weather()
        if cached is not None:
            return cached

    hourly_fields = (
        "shortwave_radiation,direct_radiation,diffuse_radiation,"
        "cloudcover,cloudcover_low,cloudcover_mid,cloudcover_high,"
        "temperature_2m,relativehumidity_2m,windspeed_10m,precipitation,cape"
    )
    if source_kind == "archive":
        # Backfill training weather when cache is missing.
        url = (
            "https://archive-api.open-meteo.com/v1/archive"
            f"?latitude={LAT_DEG}&longitude={LON_DEG}"
            f"&start_date={day}&end_date={day}"
            f"&hourly={hourly_fields}"
            f"&timezone={TZ_NAME}"
        )
    else:
        # Today / tomorrow / near-future day-ahead source.
        url = (
            "https://api.open-meteo.com/v1/forecast"
            f"?latitude={LAT_DEG}&longitude={LON_DEG}"
            f"&hourly={hourly_fields}"
            f"&timezone={TZ_NAME}"
            "&forecast_days=16"
        )
    try:
        r = requests.get(url, timeout=15)
        r.raise_for_status()
        j = r.json().get("hourly", {})
        if not j or "time" not in j:
            log.error("Weather API payload missing hourly data for %s", day)
            cached = _fallback_cached_weather("provider payload missing hourly data")
            if cached is not None:
                return cached
            return None
        full_df = pd.DataFrame({
            "time":       pd.to_datetime(j["time"]),
            "rad":        j["shortwave_radiation"],
            "rad_direct": j["direct_radiation"],
            "rad_diffuse":j["diffuse_radiation"],
            "cloud":      j["cloudcover"],
            "cloud_low":  j["cloudcover_low"],
            "cloud_mid":  j["cloudcover_mid"],
            "cloud_high": j["cloudcover_high"],
            "temp":       j["temperature_2m"],
            "rh":         j["relativehumidity_2m"],
            "wind":       j["windspeed_10m"],
            "precip":     j["precipitation"],
            "cape":       j["cape"],
        })
        day_df = _slice_weather_day(full_df, day)
        ok, reason = validate_weather_hourly(day, day_df)
        if not ok:
            log.error("Weather fetched but invalid [%s] for %s: %s", source_kind, day, reason)
            cached = _fallback_cached_weather(f"provider payload invalid ({reason})")
            if cached is not None:
                return cached
            return None
        day_df.to_csv(cache, index=False)
        log.info("Weather fetched & cached [%s]: %s (%d rows)", source_kind, day, len(day_df))
        # v2.8 efficiency audit (E3): prime in-memory cache with the freshly
        # fetched frame so immediately-following loop iterations skip disk.
        _weather_mem_cache_put(day, source_kind, cache, day_df)
        return day_df
    except Exception as e:
        log.error("Weather fetch failed [%s] for %s: %s", source_kind, day, e)
        cached = _fallback_cached_weather(f"provider fetch failed ({e})")
        if cached is not None:
            return cached
        return None

def interpolate_5min(df: pd.DataFrame, day: str | None = None) -> pd.DataFrame:
    """
    Resample hourly weather to 5-min with shape-preserving interpolation.
    Radiation uses PCHIP (monotone cubic) " avoids unphysical negative dips.
    Other variables use linear.
    """
    df = df.copy()
    df["time"] = pd.to_datetime(df["time"], errors="coerce")
    df = df.dropna(subset=["time"]).sort_values("time")
    if df.empty:
        return pd.DataFrame()
    if day:
        day_df = _slice_weather_day(df, day)
        if not day_df.empty:
            df = day_df
    df = df.set_index("time")

    # separate radiation cols (need pchip) from rest
    rad_cols  = ["rad", "rad_direct", "rad_diffuse"]
    rest_cols = [c for c in df.columns if c not in rad_cols]
    numeric_cols = [c for c in df.columns if c != "time"]
    for col in numeric_cols:
        df[col] = pd.to_numeric(df[col], errors="coerce")

    if day:
        idx5 = pd.date_range(f"{day} 00:00:00", periods=SLOTS_DAY, freq="5min")
    elif df.empty:
        log.warning("interpolate_5min called with empty DataFrame and no day — returning empty")
        return pd.DataFrame()
    else:
        idx5 = pd.date_range(df.index[0], df.index[-1], freq="5min")

    rad_interp = (
        df[rad_cols]
        .reindex(df.index.union(idx5))
        .interpolate(method="pchip")
        .reindex(idx5)
        .clip(lower=0)
    )
    rest_interp = (
        df[rest_cols]
        .reindex(df.index.union(idx5))
        .interpolate(method="linear")
        .reindex(idx5)
    )
    # Keep interpolation numeric-only so sparse Open-Meteo nulls do not leave
    # object dtypes behind and crash downstream comparisons/clipping.
    rest_interp = rest_interp.apply(pd.to_numeric, errors="coerce")
    for col in ["cloud", "cloud_low", "cloud_mid", "cloud_high", "rh", "wind", "precip", "cape"]:
        if col in rest_interp.columns:
            rest_interp[col] = rest_interp[col].clip(lower=0)

    out = pd.concat([rad_interp, rest_interp], axis=1).reset_index()
    if "index" in out.columns and "time" not in out.columns:
        out = out.rename(columns={"index": "time"})

    # Gentle smoothing for cloud (meteorological, not sub-minute noise)
    for col in ["cloud", "cloud_low", "cloud_mid", "cloud_high"]:
        if col in out.columns:
            out[col] = _rolling_mean(pd.to_numeric(out[col], errors="coerce").values, 5, center=True)

    return out.iloc[:SLOTS_DAY].reset_index(drop=True)

def build_weather_derivative_candidates(w5: pd.DataFrame) -> pd.DataFrame:
    """Return causal derivative candidates without altering FEATURE_COLS.

    These columns remain experimental until issue-time snapshot coverage and
    rolling-origin ablation pass. Windows are trailing only; no centered or
    future weather values are used.
    """
    frame = w5.copy() if isinstance(w5, pd.DataFrame) else pd.DataFrame()
    out = pd.DataFrame(index=range(SLOTS_DAY))
    cloud = pd.to_numeric(frame.get("cloud", pd.Series(dtype=float)), errors="coerce").reindex(range(SLOTS_DAY)).ffill().fillna(50.0)
    temp = pd.to_numeric(frame.get("temp", pd.Series(dtype=float)), errors="coerce").reindex(range(SLOTS_DAY)).ffill().fillna(25.0)
    rad = pd.to_numeric(frame.get("rad", pd.Series(dtype=float)), errors="coerce").reindex(range(SLOTS_DAY)).ffill().fillna(0.0)
    out["cloud_delta_1h"] = cloud - cloud.shift(12)
    out["temp_delta_1h"] = temp - temp.shift(12)
    out["rad_std_30m"] = rad.rolling(window=6, min_periods=1).std(ddof=0)
    return out.fillna(0.0)

# ============================================================================
# SOLAR GEOMETRY (precise)
# ============================================================================

@lru_cache(maxsize=128)
def _solar_geometry_cached(day: str) -> dict:
    """
    Cached inner implementation of solar_geometry.

    v2.8 efficiency audit (E2): this function is a pure function of
    day-of-year (via `day`). It runs a 288-slot python loop and was being
    recomputed ~200x per full forecast cycle. Cache on `day` — forecast
    loops reuse the same 45-day window across reliability + training, so
    the cache hit rate is near 100%.

    Callers MUST go through `solar_geometry()` (non-cached wrapper) which
    returns a shallow copy of the cached arrays to prevent accidental
    in-place mutation from bleeding across callers.
    """
    lat  = math.radians(LAT_DEG)
    doy  = datetime.strptime(day, "%Y-%m-%d").timetuple().tm_yday

    # Solar declination (Spencer 1971)
    B      = math.radians((360 / 365) * (doy - 81))
    decl   = math.radians(23.45 * math.sin(B))

    # Equation of time (minutes)
    eot    = 9.87 * math.sin(2 * B) - 7.53 * math.cos(B) - 1.5 * math.sin(B)

    # Extraterrestrial radiation
    E0     = 1 + 0.033 * math.cos(math.radians(360 * doy / 365))
    I0     = 1367.0 * E0   # W/m

    zenith_arr   = np.zeros(SLOTS_DAY)
    air_mass_arr = np.zeros(SLOTS_DAY)
    extra_arr    = np.zeros(SLOTS_DAY)

    for slot in range(SLOTS_DAY):
        hour_frac = slot * SLOT_MIN / 60.0                   # local clock hours
        solar_time = hour_frac + (eot / 60.0) + (LON_DEG - 15 * TZ_OFFSET) / 15.0
        hour_angle = math.radians(15.0 * (solar_time - 12.0))

        cos_z = (math.sin(lat) * math.sin(decl)
                 + math.cos(lat) * math.cos(decl) * math.cos(hour_angle))
        cos_z = max(cos_z, 0.0)

        zenith_deg = math.degrees(math.acos(min(cos_z, 1.0)))
        zenith_arr[slot] = zenith_deg

        if cos_z > 0.01:
            # Kasten & Young 1989
            am = 1.0 / (cos_z + 0.50572 * (96.07995 - zenith_deg) ** -1.6364)
            air_mass_arr[slot] = min(am, 38.0)
        else:
            air_mass_arr[slot] = 0.0

        extra_arr[slot] = I0 * cos_z

    return {
        "cos_z":    np.cos(np.radians(zenith_arr)),
        "zenith":   zenith_arr,
        "air_mass": air_mass_arr,
        "extra":    extra_arr,
    }

def solar_geometry(day: str) -> dict:
    """
    Return per-slot solar geometry arrays for *day*.

    Returns dict with keys:
        zenith_deg  - solar zenith angle (degrees)
        elevation   - solar elevation (radians)
        air_mass    - Kasten & Young (1989) air mass
        cos_aoi     - cosine of angle-of-incidence on horizontal plane (= cos z)
        extra_rad   - extraterrestrial radiation W/m

    v2.8 efficiency audit (E2): delegates to `_solar_geometry_cached` and
    returns a shallow-copy dict with copied numpy arrays so callers cannot
    mutate the cached reference.
    """
    cached = _solar_geometry_cached(day)
    return {k: (v.copy() if isinstance(v, np.ndarray) else v) for k, v in cached.items()}

# ============================================================================
# CLEAR-SKY MODEL  (Ineichen simplified + humidity correction)
# ============================================================================

def _clear_sky_radiation_impl(day: str, rh_mean: float) -> np.ndarray:
    """Inner Ineichen computation shared between cached/uncached entry points."""
    geo = _solar_geometry_cached(day)  # direct cached ref; we only read it
    cos_z = geo["cos_z"]
    am    = geo["air_mass"]
    extra = geo["extra"]

    TL = 2.4 + 0.018 * rh_mean   #  3.8"4.1 for Cotabato wet season

    csi = np.zeros(SLOTS_DAY)
    for i in range(SLOTS_DAY):
        if cos_z[i] < 0.01 or am[i] < 0.1:
            continue
        # Ineichen & Perez (2002) simplified
        fh1  = math.exp(-0.0148 * am[i])
        fh2  = math.exp(-0.1202 * am[i])
        Gh   = extra[i] * cos_z[i] * math.exp(
                   -0.0903 * am[i] ** 0.7241 * (TL - 1.0)
               ) * (0.9734 * fh1 + 0.0266 * fh2)
        csi[i] = max(Gh, 0.0)

    return csi

@lru_cache(maxsize=128)
def _clear_sky_radiation_climatological(day: str) -> np.ndarray:
    """
    v2.8 efficiency audit (E2): cached clear-sky GHI for the climatological
    RH branch (rh_hourly=None → rh_mean=78.0). This is the branch most
    commonly hit by day-keyed callers that don't have 5-min RH data on hand.
    Returns a fresh copy to every public caller via clear_sky_radiation().
    """
    return _clear_sky_radiation_impl(day, 78.0)

def clear_sky_radiation(day: str, rh_hourly: np.ndarray | None = None) -> np.ndarray:
    """
    Estimate per-slot clear-sky GHI (W/m) using simplified Ineichen model
    with Linke turbidity estimated from relative humidity.

    Args:
        day        - YYYY-MM-DD
        rh_hourly  - 5-min RH array (0-100); if None uses climatological value

    Returns:
        csi  - clear-sky GHI array, shape (SLOTS_DAY,)
    """
    if rh_hourly is None:
        # Cached climatological branch — return a copy to prevent mutation.
        return _clear_sky_radiation_climatological(day).copy()
    rh_mean = float(np.clip(np.asarray(rh_hourly).mean(), 30, 95))
    return _clear_sky_radiation_impl(day, rh_mean)

# ============================================================================
# CLOUD TRANSMITTANCE  (non-linear, PH-calibrated)
# ============================================================================

def cloud_transmittance(cloud_pct: np.ndarray,
                        cloud_low: np.ndarray,
                        cloud_mid: np.ndarray) -> np.ndarray:
    """
    Convert fractional cloud cover to GHI transmittance factor.

    Uses layer-weighted model:
      - Low cloud (Cu/Sc) is most opaque
      - Mid cloud moderately so
      - High cloud (Ci) mostly transparent

    PH tropical calibration:
      High cloud cover (frequent): transmittance  0.85
      Dense low cloud / rain:      transmittance  0.15"0.25
    """
    c  = np.clip(cloud_pct  / 100.0, 0, 1)
    cl = np.clip(cloud_low  / 100.0, 0, 1)
    cm = np.clip(cloud_mid  / 100.0, 0, 1)
    ch = np.clip((c - cl - cm), 0, 1)   # approximate high cloud

    # Layer opacities (empirical for PH tropical)
    tau_low  = 0.78
    tau_mid  = 0.52
    tau_high = 0.14

    trans = (1.0
             - tau_low  * cl
             - tau_mid  * cm
             - tau_high * ch)

    # Non-linear enhancement at partial cloud (broken cumulus ' brightening)
    brightening = 0.06 * np.sin(np.pi * c) * (1 - cl)
    trans = np.clip(trans + brightening, 0.10, 1.05)

    return trans

# ============================================================================
# PHYSICS BASELINE  (clear-sky - cloud - temperature derating)
# ============================================================================

def physics_baseline(day: str, w5: pd.DataFrame) -> np.ndarray:
    """
    Compute per-slot kWh_inc from pure physics.

    Steps:
        1. Clear-sky GHI (W/m)
        2. - cloud transmittance
        3. ' effective irradiance ' normalised vs STC
        4. - temperature derating (NOCT model)
        5. - plant capacity (dependable kW)
        6. - slot duration ' kWh

    Args:
        day  " YYYY-MM-DD
        w5   " 5-min weather DataFrame (from interpolate_5min)

    Returns:
        baseline kWh_inc array (SLOTS_DAY,)
    """
    cap_kw = plant_capacity_kw(dependable=False)

    csi  = clear_sky_radiation(day, w5["rh"].values)
    ctrans = cloud_transmittance(
        w5["cloud"].values,
        w5["cloud_low"].values,
        w5["cloud_mid"].values,
    )
    ghi_eff = csi * ctrans

    # Temperature derating: Tc = T_amb + (NOCT-20)/800 - Geff
    noct    = 47.0   # C (typical mono-Si module)
    temp_c  = w5["temp"].values
    tc      = temp_c + ((noct - 20.0) / 800.0) * np.clip(ghi_eff, 0, 1200)
    temp_factor = 1.0 + GAMMA_TC * (tc - TEMP_REF_C)
    temp_factor = np.clip(temp_factor, 0.7, 1.05)

    # STC irradiance reference
    G_stc = 1000.0

    # Power output
    power_kw = cap_kw * (ghi_eff / G_stc) * temp_factor
    power_kw = np.clip(power_kw, 0, cap_kw)

    # Zero below radiation threshold
    power_kw[ghi_eff < RAD_MIN_WM2] = 0.0

    # Sunrise/sunset ramp guard (avoid instantaneous step from 0)
    ramp_slots = 4
    for i in range(SOLAR_START_SLOT, min(SOLAR_START_SLOT + ramp_slots, SLOTS_DAY)):
        frac = (i - SOLAR_START_SLOT + 1) / ramp_slots
        power_kw[i] = min(power_kw[i], power_kw[i] * frac)

    # kWh per 5-min slot
    kwh = power_kw * SLOT_MIN / 60.0

    # Zero outside solar window
    kwh[:SOLAR_START_SLOT]  = 0.0
    kwh[SOLAR_END_SLOT:]    = 0.0

    return kwh

# ============================================================================
# WEATHER ANALYSIS  (for training quality & diagnostics)
# ============================================================================

def analyse_weather_day(day: str, w5: pd.DataFrame, actual: np.ndarray | None = None) -> dict:
    """
    Compute meteorological statistics for a given day.

    Returns a rich dict used for:
      - Anomaly rejection
      - Feature engineering
      - Diagnostic logging
    """
    solar_rad  = w5["rad"].values[SOLAR_START_SLOT:SOLAR_END_SLOT]
    solar_cld  = w5["cloud"].values[SOLAR_START_SLOT:SOLAR_END_SLOT]
    solar_rh   = w5["rh"].values[SOLAR_START_SLOT:SOLAR_END_SLOT]
    solar_temp = w5["temp"].values[SOLAR_START_SLOT:SOLAR_END_SLOT]

    rad_mean    = float(solar_rad.mean())
    rad_peak    = float(solar_rad.max())
    cloud_mean  = float(solar_cld.mean())
    cloud_std   = float(solar_cld.std())
    rh_mean     = float(solar_rh.mean())

    # Volatility index: fraction of slots where |"rad| > threshold
    drad        = np.abs(np.diff(solar_rad, prepend=solar_rad[0]))
    vol_index   = float((drad > 120).mean())   # fraction of "cloud edge" slots

    # Sky condition classification
    if cloud_mean < 20:
        sky_class = "clear"
    elif cloud_mean < 45:
        sky_class = "partly_cloudy"
    elif cloud_mean < 70:
        sky_class = "mostly_cloudy"
    else:
        sky_class = "overcast"

    # Convective instability (CAPE-based)
    cape_max = float(w5["cape"].values.max()) if "cape" in w5.columns else 0.0
    convective = cape_max > 500

    # Rain flag
    precip_total = float(w5["precip"].values.sum()) if "precip" in w5.columns else 0.0
    rainy = precip_total > 2.0

    stats = {
        "day":          day,
        "rad_mean":     rad_mean,
        "rad_peak":     rad_peak,
        "cloud_mean":   cloud_mean,
        "cloud_std":    cloud_std,
        "rh_mean":      rh_mean,
        "vol_index":    vol_index,
        "sky_class":    sky_class,
        "convective":   convective,
        "rainy":        rainy,
        "cape_max":     cape_max,
        "precip_total": precip_total,
        "temp_mean":    float(solar_temp.mean()),
    }

    # Generation metrics if actual provided
    if actual is not None:
        cap_kwh_day = plant_capacity_kw(False) * (SOLAR_END_H - SOLAR_START_H) / 1.0
        cf = float(actual.sum()) / max(cap_kwh_day, 1.0)
        stats["capacity_factor"] = cf
        stats["total_kwh"]       = float(actual.sum())

        # Pearson r between radiation & generation (solar hours only)
        act_solar = actual[SOLAR_START_SLOT:SOLAR_END_SLOT]
        if solar_rad.std() > 1 and act_solar.std() > 1:
            stats["rad_gen_corr"] = float(np.corrcoef(solar_rad, act_solar)[0, 1])
        else:
            stats["rad_gen_corr"] = 0.0

    return stats

def classify_day_regime(stats: dict) -> str:
    cloud_mean = float(stats.get("cloud_mean", 0.0))
    vol_index = float(stats.get("vol_index", 0.0))
    rad_peak = float(stats.get("rad_peak", 0.0))
    rainy = bool(stats.get("rainy", False))
    convective = bool(stats.get("convective", False))
    if rainy or (convective and cloud_mean >= 75.0):
        return "rainy"
    if cloud_mean < 26.0 and vol_index < 0.18 and rad_peak >= 650.0:
        return "clear"
    if cloud_mean < 72.0:
        return "mixed"
    return "overcast"

# NOTE (v2.8 cleanup): `classify_hour_regime` was removed — only consumer
# was `hour_weather_signature` (also removed). Day-level regime classification
# is still done by `classify_day_regime` above.

def classify_slot_weather_buckets(w5: pd.DataFrame, day: str) -> np.ndarray:
    """Classify each 5-minute slot into a weather bucket for error analysis."""
    def col(name: str, default: float = 0.0) -> np.ndarray:
        if name not in w5.columns:
            return np.full(SLOTS_DAY, default, dtype=float)
        arr = pd.to_numeric(w5[name], errors="coerce").fillna(default).values
        if len(arr) < SLOTS_DAY:
            arr = np.concatenate([arr, np.full(SLOTS_DAY - len(arr), default, dtype=float)])
        return arr[:SLOTS_DAY].astype(float)

    rad = np.clip(col("rad", 0.0), 0.0, None)
    cloud = np.clip(col("cloud", 0.0), 0.0, 100.0)
    precip = np.clip(col("precip", 0.0), 0.0, None)
    cape = np.clip(col("cape", 0.0), 0.0, None)
    rh = np.clip(col("rh", 0.0), 0.0, 100.0)
    csi = clear_sky_radiation(day, rh)
    kt = np.where(csi > 10.0, rad / np.maximum(csi, 1.0), 0.0)
    kt = np.clip(kt, 0.0, 1.2)
    drad = np.abs(np.diff(rad, prepend=rad[0]))

    out = np.full(SLOTS_DAY, "offsolar", dtype=object)
    solar_mask = np.zeros(SLOTS_DAY, dtype=bool)
    solar_mask[SOLAR_START_SLOT:SOLAR_END_SLOT] = True
    active = solar_mask.copy()

    rainy_mask = active & (
        (precip > WEATHER_BUCKET_RAIN_MM)
        | ((cape >= WEATHER_BUCKET_RAIN_CAPE) & (cloud >= WEATHER_BUCKET_RAIN_CLOUD))
    )
    out[rainy_mask] = "rainy"
    active &= ~rainy_mask

    clear_stable_mask = active & (
        (cloud < WEATHER_BUCKET_CLEAR_CLOUD)
        & (kt >= WEATHER_BUCKET_CLEAR_KT)
        & (drad < WEATHER_BUCKET_CLEAR_DRAD)
    )
    out[clear_stable_mask] = "clear_stable"
    active &= ~clear_stable_mask

    clear_edge_mask = active & (
        (cloud < WEATHER_BUCKET_CLEAR_EDGE_CLOUD)
        & (kt >= WEATHER_BUCKET_CLEAR_EDGE_KT)
        & (drad >= WEATHER_BUCKET_CLEAR_DRAD)
    )
    out[clear_edge_mask] = "clear_edge"
    active &= ~clear_edge_mask

    mixed_stable_mask = active & (
        (cloud >= WEATHER_BUCKET_CLEAR_CLOUD)
        & (cloud < WEATHER_BUCKET_MIXED_CLOUD)
        & (kt >= WEATHER_BUCKET_MIXED_KT)
        & (drad < WEATHER_BUCKET_MIXED_VOL_DRAD)
        & (precip <= WEATHER_BUCKET_RAIN_MM)
    )
    out[mixed_stable_mask] = "mixed_stable"
    active &= ~mixed_stable_mask

    mixed_volatile_mask = active & (
        (cloud >= WEATHER_BUCKET_CLEAR_CLOUD)
        & (cloud < WEATHER_BUCKET_MIXED_VOL_CLOUD)
        & (drad >= WEATHER_BUCKET_MIXED_VOL_DRAD)
        & (precip <= WEATHER_BUCKET_RAIN_MM)
    )
    out[mixed_volatile_mask] = "mixed_volatile"
    active &= ~mixed_volatile_mask

    out[active] = "overcast"
    return out

def _error_class_normalizer(
    residual: np.ndarray,
    opportunity_kwh: np.ndarray | float | None = None,
    baseline_kwh: np.ndarray | float | None = None,
    cap_slot: float | None = None,
) -> np.ndarray:
    residual_arr = np.asarray(residual, dtype=float)
    cap = max(float(cap_slot if cap_slot is not None else slot_cap_kwh(False)), 1.0)
    floor = cap * ERROR_CLASS_OPPORTUNITY_FLOOR_FRAC
    if opportunity_kwh is not None:
        scale = np.asarray(opportunity_kwh, dtype=float)
    elif baseline_kwh is not None:
        scale = np.maximum(np.clip(np.asarray(baseline_kwh, dtype=float), 0.0, None), floor)
    else:
        scale = np.full(residual_arr.shape, cap, dtype=float)
    if scale.shape != residual_arr.shape:
        if scale.size == 1:
            scale = np.full(residual_arr.shape, float(scale.reshape(-1)[0]), dtype=float)
        else:
            raise ValueError("Residual normalization scale shape mismatch")
    scale = np.where(np.isfinite(scale), scale, floor)
    scale = np.maximum(scale, floor)
    return scale

def classify_residual_error_classes(
    residual: np.ndarray,
    cap_slot: float | None = None,
    opportunity_kwh: np.ndarray | float | None = None,
    baseline_kwh: np.ndarray | float | None = None,
) -> np.ndarray:
    rn = np.asarray(residual, dtype=float) / _error_class_normalizer(
        residual,
        opportunity_kwh=opportunity_kwh,
        baseline_kwh=baseline_kwh,
        cap_slot=cap_slot,
    )
    out = np.full(rn.shape, ERROR_CLASS_NEUTRAL_IDX, dtype=int)
    out[rn <= -ERROR_CLASS_STRONG_THRESHOLD] = 0
    out[(rn > -ERROR_CLASS_STRONG_THRESHOLD) & (rn <= -ERROR_CLASS_MILD_THRESHOLD)] = 1
    out[(rn >= ERROR_CLASS_MILD_THRESHOLD) & (rn < ERROR_CLASS_STRONG_THRESHOLD)] = 3
    out[rn >= ERROR_CLASS_STRONG_THRESHOLD] = 4
    return out

def _apply_probability_temperature(prob_matrix: np.ndarray, temperature: float | None) -> np.ndarray:
    probs = np.asarray(prob_matrix, dtype=float)
    if probs.ndim != 2 or probs.size <= 0:
        return probs.copy()
    temp = float(temperature if temperature is not None else 1.0)
    if not math.isfinite(temp) or temp <= 0:
        temp = 1.0
    row_sum = probs.sum(axis=1, keepdims=True)
    probs = np.divide(probs, np.maximum(row_sum, 1e-9), out=np.zeros_like(probs), where=row_sum > 0)
    if abs(temp - 1.0) < 1e-6:
        return probs
    scaled = np.power(np.clip(probs, 1e-9, 1.0), 1.0 / temp)
    scaled_sum = scaled.sum(axis=1, keepdims=True)
    return np.divide(scaled, np.maximum(scaled_sum, 1e-9), out=np.zeros_like(scaled), where=scaled_sum > 0)

def _weighted_neg_log_loss(
    prob_matrix: np.ndarray,
    labels: np.ndarray,
    sample_weight: np.ndarray | None = None,
) -> float:
    probs = np.asarray(prob_matrix, dtype=float)
    y = np.asarray(labels, dtype=int).reshape(-1)
    if probs.ndim != 2 or probs.shape[0] != y.shape[0] or probs.shape[0] <= 0:
        return float("inf")
    y = np.clip(y, 0, probs.shape[1] - 1)
    losses = -np.log(np.clip(probs[np.arange(probs.shape[0]), y], 1e-9, 1.0))
    if sample_weight is None:
        return float(np.mean(losses))
    w = np.asarray(sample_weight, dtype=float).reshape(-1)
    if w.shape[0] != losses.shape[0]:
        return float(np.mean(losses))
    return float(np.average(losses, weights=np.maximum(w, 1e-9)))

def _weighted_mae_loss(
    pred: np.ndarray,
    actual: np.ndarray,
    sample_weight: np.ndarray | None = None,
) -> float:
    err = np.abs(np.asarray(pred, dtype=float).reshape(-1) - np.asarray(actual, dtype=float).reshape(-1))
    if sample_weight is None:
        return float(np.mean(err)) if err.size else float("inf")
    w = np.asarray(sample_weight, dtype=float).reshape(-1)
    if w.shape[0] != err.shape[0]:
        return float(np.mean(err)) if err.size else float("inf")
    return float(np.average(err, weights=np.maximum(w, 1e-9))) if err.size else float("inf")

def _blocked_day_holdout_mask(day_keys: np.ndarray | list[str] | None) -> np.ndarray:
    if day_keys is None:
        return np.zeros(0, dtype=bool)
    days = [str(v) for v in np.asarray(day_keys, dtype=object).reshape(-1)]
    if not days:
        return np.zeros(0, dtype=bool)
    ordered_unique = []
    seen = set()
    for day in days:
        if day not in seen:
            seen.add(day)
            ordered_unique.append(day)
    if len(ordered_unique) < ERROR_CLASS_CALIBRATION_MIN_DAYS:
        return np.zeros(len(days), dtype=bool)
    holdout_days = int(np.clip(round(len(ordered_unique) * 0.20), 2, ERROR_CLASS_CALIBRATION_HOLDOUT_MAX_DAYS))
    min_train_days = max(MIN_TRAIN_DAYS, 4)
    if (len(ordered_unique) - holdout_days) < min_train_days:
        holdout_days = max(0, len(ordered_unique) - min_train_days)
    if holdout_days < 2:
        return np.zeros(len(days), dtype=bool)
    holdout_set = set(ordered_unique[:holdout_days])
    return np.asarray([day in holdout_set for day in days], dtype=bool)

def _blocked_classifier_holdout_mask(day_keys: np.ndarray | list[str] | None) -> np.ndarray:
    return _blocked_day_holdout_mask(day_keys)

def _fit_error_classifier_temperature(
    X: pd.DataFrame,
    labels: np.ndarray,
    sample_weight: np.ndarray,
    day_keys: np.ndarray | list[str] | None,
) -> dict:
    meta = {
        "calibrated": False,
        "temperature": 1.0,
        "holdout_days": 0,
        "holdout_samples": 0,
        "nll_before": None,
        "nll_after": None,
        "accuracy_before": None,
        "accuracy_after": None,
    }
    holdout_mask = _blocked_day_holdout_mask(day_keys)
    if holdout_mask.size != len(labels) or not np.any(holdout_mask):
        return meta
    train_mask = ~holdout_mask
    if int(np.count_nonzero(holdout_mask)) < ERROR_CLASS_CALIBRATION_HOLDOUT_MIN_SAMPLES:
        return meta
    y_train = np.asarray(labels, dtype=int)[train_mask]
    y_holdout = np.asarray(labels, dtype=int)[holdout_mask]
    if len({int(v) for v in y_train}) < 2 or len({int(v) for v in y_holdout}) < 2:
        return meta

    X_train = X.iloc[train_mask].reset_index(drop=True)
    X_holdout = X.iloc[holdout_mask].reset_index(drop=True)
    w_train = np.asarray(sample_weight, dtype=float)[train_mask]
    w_holdout = np.asarray(sample_weight, dtype=float)[holdout_mask]
    model = _make_error_classifier()
    # C4: Handle LightGBM early stopping (needs eval_set)
    if hasattr(model, 'early_stopping_rounds') and model.early_stopping_rounds:
        model.fit(X_train, y_train, sample_weight=w_train, eval_set=[(X_holdout, y_holdout)])
    else:
        model.fit(X_train, y_train, sample_weight=w_train)

    raw_probs = _classifier_probabilities_to_full_vector(
        np.asarray(model.predict_proba(X_holdout), dtype=float),
        list(map(int, getattr(model, "classes_", []))),
    )
    base_nll = _weighted_neg_log_loss(raw_probs, y_holdout, w_holdout)
    base_acc = float(np.average((np.argmax(raw_probs, axis=1) == y_holdout).astype(float), weights=np.maximum(w_holdout, 1e-9)))
    best_temp = 1.0
    best_nll = base_nll
    best_probs = raw_probs
    for temp in np.linspace(
        ERROR_CLASS_CALIBRATION_TEMP_MIN,
        ERROR_CLASS_CALIBRATION_TEMP_MAX,
        ERROR_CLASS_CALIBRATION_TEMP_STEPS,
    ):
        cand_probs = _apply_probability_temperature(raw_probs, float(temp))
        cand_nll = _weighted_neg_log_loss(cand_probs, y_holdout, w_holdout)
        if cand_nll + 1e-6 < best_nll:
            best_nll = cand_nll
            best_temp = float(temp)
            best_probs = cand_probs
    meta.update({
        "calibrated": bool(best_temp != 1.0),
        "temperature": float(best_temp),
        "holdout_days": int(len({str(v) for v in np.asarray(day_keys, dtype=object).reshape(-1)[holdout_mask]})),
        "holdout_samples": int(np.count_nonzero(holdout_mask)),
        "nll_before": float(base_nll),
        "nll_after": float(best_nll),
        "accuracy_before": base_acc,
        "accuracy_after": float(np.average((np.argmax(best_probs, axis=1) == y_holdout).astype(float), weights=np.maximum(w_holdout, 1e-9))),
    })
    return meta

def _error_class_name(label: int) -> str:
    idx = int(np.clip(int(label), 0, len(ERROR_CLASS_NAMES) - 1))
    return ERROR_CLASS_NAMES[idx]

def _error_class_sign(label: np.ndarray | int) -> np.ndarray:
    arr = np.asarray(label, dtype=int)
    out = np.zeros(arr.shape, dtype=int)
    out[arr < ERROR_CLASS_NEUTRAL_IDX] = -1
    out[arr > ERROR_CLASS_NEUTRAL_IDX] = 1
    return out

def _aggregate_scalar_series(values: list[float]) -> dict:
    if not values:
        return {"count": 0, "mean": 0.0, "std": 0.0, "mae": 0.0}
    arr = np.asarray(values, dtype=float)
    return {
        "count": int(arr.size),
        "mean": float(arr.mean()),
        "std": float(arr.std()),
        "mae": float(np.mean(np.abs(arr))),
    }

# NOTE (v2.8 cleanup): `hour_weather_signature` was removed alongside the
# shape-correction stack — it was only consumed by the dead `shape_records`
# pipeline and `apply_hour_shape_correction`.

def is_anomalous_day(
    stats: dict,
    solcast_mid: np.ndarray | None = None,
    actual: np.ndarray | None = None,
) -> tuple[bool, str]:
    """
    Return (True, reason) if the day looks like bad training data.
    Reasons: inverter outage, data gaps, irradiance inconsistency.

    PHASE 2: If solcast_mid and actual provided, compute CF relative to Solcast
    instead of using pre-computed stats CF (which was physics-based).
    """
    # PHASE 2: Prefer Solcast-based CF if available
    if solcast_mid is not None and actual is not None and solcast_mid.size == SLOTS_DAY:
        solar_actual = np.clip(np.asarray(actual, dtype=float)[SOLAR_START_SLOT:SOLAR_END_SLOT], 0.0, None)
        solar_solcast = np.clip(np.asarray(solcast_mid, dtype=float)[SOLAR_START_SLOT:SOLAR_END_SLOT], 0.0, None)
        solcast_total = float(solar_solcast.sum())
        if solcast_total > 1.0:
            cf = float(solar_actual.sum() / solcast_total)
        else:
            cf = stats.get("capacity_factor", 0.5)
    else:
        cf = stats.get("capacity_factor", 0.5)

    if cf < ANOM_MIN_CF:
        return True, f"CF too low ({cf:.3f}) - likely outage or data gap"
    if cf > ANOM_MAX_CF:
        return True, f"CF too high ({cf:.3f}) - sensor or data error"

    corr = stats.get("rad_gen_corr", 1.0)
    if stats.get("rad_mean", 0) > 100 and corr < ANOM_RAD_CORR:
        return True, f"Rad-gen correlation too low ({corr:.2f}) - inconsistent data"

    return False, ""

def training_day_rejection(
    stats: dict,
    actual: np.ndarray,
    solcast_mid: np.ndarray | None = None,
) -> tuple[bool, str]:
    """
    Stricter training-day filter used by the hardened residual model.

    PHASE 2: Uses Solcast mid as reference instead of physics baseline.
    """
    # PHASE 2: Pass solcast_mid and actual to is_anomalous_day for CF computation
    bad, reason = is_anomalous_day(stats, solcast_mid=solcast_mid, actual=actual)
    if bad:
        return bad, reason

    solar_actual = np.clip(np.asarray(actual, dtype=float)[SOLAR_START_SLOT:SOLAR_END_SLOT], 0.0, None)

    # PHASE 2: Reference Solcast mid instead of physics baseline
    if solcast_mid is None or solcast_mid.size != SLOTS_DAY:
        log.warning("training_day_rejection called without valid Solcast reference")
        return True, "No Solcast reference available"

    solar_ref = np.clip(np.asarray(solcast_mid, dtype=float)[SOLAR_START_SLOT:SOLAR_END_SLOT], 0.0, None)

    cap_slot = max(slot_cap_kwh(False), 1.0)
    peak_ratio = float(solar_actual.max() / cap_slot) if solar_actual.size else 0.0
    if peak_ratio > 1.10:
        return True, f"Peak slot exceeds physical max ({peak_ratio:.2f}x)"

    threshold = activity_threshold_kwh()
    active = solar_actual[solar_actual >= threshold]
    if active.size >= 18:
        diff = np.abs(np.diff(active))
        flat_tol = max(0.30, float(np.nanmedian(active)) * 0.015)
        flatline_ratio = float(np.mean(diff <= flat_tol)) if diff.size else 0.0
        if flatline_ratio > 0.96 and stats.get("rad_gen_corr", 1.0) < 0.80:
            return True, f"Active period is implausibly flat ({flatline_ratio:.2f})"

    ref_total = float(solar_ref.sum())
    if ref_total > 0 and stats.get("rad_mean", 0) > 180 and not stats.get("rainy", False):
        energy_ratio = float(solar_actual.sum() / ref_total)
        if energy_ratio < 0.08:
            return True, f"Generation far below Solcast baseline ({energy_ratio:.2f})"

    return False, ""

# ============================================================================
# FEATURE ENGINEERING  (rich, physics-informed)
# ============================================================================

def build_features(
    w5: pd.DataFrame,
    day: str,
    solcast_prior: dict | None = None,
) -> pd.DataFrame:
    """
    Build a feature matrix from 5-min weather for ML training/prediction.

    Features:
        rad/rad_direct/rad_diffuse         " spectral decomposition
        cloud layers + gradients            " cloud dynamics
        precip/cape                         " convective/rain context
        temp/rh/wind (+ non-linear terms)   " atmospheric
        cos_z/air_mass                      " geometry
        solar progression + cyclic encodings" time context
        cloud_trans, kt, dni_proxy, csi     " derived irradiance physics
        lag/rolling weather terms           " short-memory trend terms
        cap_kw                              " plant scale normalizer
    """
    geo  = solar_geometry(day)
    day_stats = analyse_weather_day(day, w5)
    day_regime = classify_day_regime(day_stats)

    def col(name: str, default: float = 0.0) -> np.ndarray:
        if name not in w5.columns:
            return np.full(SLOTS_DAY, default, dtype=float)
        arr = pd.to_numeric(w5[name], errors="coerce").fillna(default).values
        if len(arr) < SLOTS_DAY:
            pad = np.full(SLOTS_DAY - len(arr), default, dtype=float)
            arr = np.concatenate([arr, pad])
        return arr[:SLOTS_DAY].astype(float)

    rad = col("rad", 0.0)
    rad_direct = col("rad_direct", 0.0)
    rad_diffuse = col("rad_diffuse", 0.0)
    cloud = np.clip(col("cloud", 0.0), 0.0, 100.0)
    cloud_low = np.clip(col("cloud_low", 0.0), 0.0, 100.0)
    cloud_mid = np.clip(col("cloud_mid", 0.0), 0.0, 100.0)
    cloud_high = np.clip(col("cloud_high", 0.0), 0.0, 100.0)
    temp = col("temp", 0.0)
    rh = np.clip(col("rh", 0.0), 0.0, 100.0)
    wind = np.clip(col("wind", 0.0), 0.0, None)
    precip = np.clip(col("precip", 0.0), 0.0, None)
    cape = np.clip(col("cape", 0.0), 0.0, None)

    ctrans = cloud_transmittance(
        cloud,
        cloud_low,
        cloud_mid,
    )

    idx       = np.arange(SLOTS_DAY)
    solar_rel = (idx - SOLAR_START_SLOT) / max(SOLAR_SLOTS - 1, 1)
    solar_rel = np.clip(solar_rel, 0, 1)
    solar_rel_sin = np.sin(np.pi * solar_rel)
    solar_rel_sin = np.clip(solar_rel_sin, 0, 1)

    slot_angle = 2 * np.pi * (idx / SLOTS_DAY)
    tod_sin = np.sin(slot_angle)
    tod_cos = np.cos(slot_angle)
    slot_in_hour = (idx % (60 // SLOT_MIN)) / max((60 // SLOT_MIN) - 1, 1)
    slot_in_hour_angle = 2 * np.pi * slot_in_hour
    slot_in_hour_sin = np.sin(slot_in_hour_angle)
    slot_in_hour_cos = np.cos(slot_in_hour_angle)

    try:
        doy = datetime.strptime(day, "%Y-%m-%d").timetuple().tm_yday
    except Exception:
        doy = datetime.now().timetuple().tm_yday
    doy_angle = 2 * np.pi * (doy / 365.25)
    doy_sin = np.full(SLOTS_DAY, np.sin(doy_angle), dtype=float)
    doy_cos = np.full(SLOTS_DAY, np.cos(doy_angle), dtype=float)

    csi_arr = clear_sky_radiation(day, rh)

    # Clearness index (actual / theoretical clear-sky)
    kt = np.where(csi_arr > 10, rad / np.maximum(csi_arr, 1), 0.0)
    kt = np.clip(kt, 0, 1.2)

    # DNI proxy: direct fraction relative to GHI
    dni_proxy = np.clip(rad_direct / np.maximum(rad, 1), 0, 1)

    # 1-hour lagged radiation (12 slots)
    rad_lag = np.roll(rad, 12)
    rad_lag[:12] = rad[:12]
    # Thermal lag features (Phase 2.2): inverter output lags irradiance by 1-2 slots
    rad_lag_1slot = np.roll(rad, 1)
    rad_lag_1slot[0] = rad[0]
    rad_lag_2slots = np.roll(rad, 2)
    rad_lag_2slots[:2] = rad[:2]
    rad_grad_15m = np.diff(rad, prepend=rad[0])
    cloud_grad_15m = np.diff(cloud, prepend=cloud[0])
    precip_1h = np.nan_to_num(_rolling_sum(precip, 12), nan=0.0)
    cloud_std_1h = np.nan_to_num(_rolling_std(cloud, 12), nan=0.0)

    cap_kw = plant_capacity_kw(True)
    sunrise_slots = np.clip(idx - SOLAR_START_SLOT, 0, SOLAR_SLOTS)
    sunset_slots = np.clip((SOLAR_END_SLOT - 1) - idx, 0, SOLAR_SLOTS)
    sunrise_rel = sunrise_slots / max(SOLAR_SLOTS, 1)
    sunset_rel = sunset_slots / max(SOLAR_SLOTS, 1)
    shoulder_flag = ((sunrise_slots < 18) | (sunset_slots < 18)).astype(float)
    node_count = max(1, plant_node_count())
    expected_nodes = np.clip((cap_kw * np.clip(kt, 0.0, 1.0)) / max(NODE_KW_NOMINAL, 1.0), 0.0, float(node_count))
    season_bucket = _season_bucket_from_day(day)
    wet_season_flag = 1.0 if season_bucket == "wet" else 0.0
    dry_season_flag = 1.0 - wet_season_flag
    day_regime_clear = 1.0 if day_regime == "clear" else 0.0
    day_regime_mixed = 1.0 if day_regime == "mixed" else 0.0
    day_regime_overcast = 1.0 if day_regime == "overcast" else 0.0
    day_regime_rainy = 1.0 if day_regime == "rainy" else 0.0
    if solcast_prior:
        solcast_kwh = np.clip(np.asarray(solcast_prior.get("prior_kwh"), dtype=float), 0.0, None)[:SLOTS_DAY]
        solcast_mw = np.clip(np.asarray(solcast_prior.get("prior_mw"), dtype=float), 0.0, None)[:SLOTS_DAY]
        solcast_spread = np.clip(
            np.asarray(solcast_prior.get("spread_frac"), dtype=float),
            0.0,
            SOLCAST_PRIOR_SPREAD_FRAC_CLIP,
        )[:SLOTS_DAY]
        solcast_available = np.clip(np.asarray(solcast_prior.get("available"), dtype=float), 0.0, 1.0)[:SLOTS_DAY]
        solcast_blend = np.clip(np.asarray(solcast_prior.get("blend"), dtype=float), 0.0, 1.0)[:SLOTS_DAY]
        solcast_cov = float(np.clip(solcast_prior.get("coverage_ratio", 0.0), 0.0, 1.0))
        solcast_rel = float(np.clip(solcast_prior.get("reliability", 0.0), 0.0, 1.0))
        solcast_bias_ratio = float(np.clip(solcast_prior.get("bias_ratio", 1.0), *SOLCAST_BIAS_RATIO_CLIP))
        solcast_resolution_weight = np.clip(
            np.asarray(
                solcast_prior.get(
                    "resolution_weight",
                    np.full(SLOTS_DAY, SOLCAST_RESOLUTION_WEIGHT_FALLBACK, dtype=float),
                ),
                dtype=float,
            ),
            0.0,
            1.0,
        )[:SLOTS_DAY]
        solcast_resolution_support = np.clip(
            np.asarray(
                solcast_prior.get("resolution_support", np.zeros(SLOTS_DAY, dtype=float)),
                dtype=float,
            ),
            0.0,
            1.0,
        )[:SLOTS_DAY]
    else:
        solcast_kwh = np.zeros(SLOTS_DAY, dtype=float)
        solcast_mw = np.zeros(SLOTS_DAY, dtype=float)
        solcast_spread = np.zeros(SLOTS_DAY, dtype=float)
        solcast_available = np.zeros(SLOTS_DAY, dtype=float)
        solcast_blend = np.zeros(SLOTS_DAY, dtype=float)
        solcast_cov = 0.0
        solcast_rel = 0.0
        solcast_bias_ratio = 1.0
        solcast_resolution_weight = np.full(SLOTS_DAY, SOLCAST_RESOLUTION_WEIGHT_FALLBACK, dtype=float)
        solcast_resolution_support = np.zeros(SLOTS_DAY, dtype=float)

    # TRI-BAND SOLCAST FEATURES
    # T4.1 / T4.2 fix: prefer the stricter has_real_triband signal (past
    # dates / estimated-actuals fall back to zero-spread) so the learned
    # feature distribution isn't polluted.  Legacy "has_triband" kept for
    # back-compat with callers that only need numerical presence.
    _triband_ok = bool(
        solcast_prior and (
            solcast_prior.get("has_real_triband", False)
            or solcast_prior.get("has_triband", False)
            and not solcast_prior.get("is_past_date", False)
        )
    )
    if _triband_ok:
        solcast_lo_kwh = np.clip(
            np.asarray(solcast_prior.get("prior_lo_kwh"), dtype=float),
            0.0,
            None
        )[:SLOTS_DAY]
        solcast_hi_kwh = np.clip(
            np.asarray(solcast_prior.get("prior_hi_kwh"), dtype=float),
            0.0,
            None
        )[:SLOTS_DAY]
        # Enforce constraint: lo <= forecast <= hi
        solcast_lo_kwh = np.minimum(solcast_lo_kwh, solcast_kwh)
        solcast_hi_kwh = np.maximum(solcast_hi_kwh, solcast_kwh)
    else:
        # No real tri-band data: fallback to forecast value (zero spread).
        # Downstream training code should filter rows by
        # solcast_prior["triband_data_quality_flag"] != "real" when present.
        solcast_lo_kwh = solcast_kwh.copy()
        solcast_hi_kwh = solcast_kwh.copy()

    # Per-slot capacity for normalization
    slot_cap_arr = np.full(SLOTS_DAY, max(cap_kw * SLOT_MIN / 60.0, 0.05), dtype=float)

    # Lo/Hi as fraction of slot capacity
    solcast_lo_vs_physics = np.clip(solcast_lo_kwh / slot_cap_arr, 0.0, 1.5)
    solcast_hi_vs_physics = np.clip(solcast_hi_kwh / slot_cap_arr, 0.0, 1.5)

    # Spread as percentage of forecast (avoid division by zero)
    solcast_spread_pct = np.zeros(SLOTS_DAY, dtype=float)
    with np.errstate(divide="ignore", invalid="ignore"):
        valid_spread = solcast_kwh > 0.05
        solcast_spread_pct[valid_spread] = np.clip(
            100.0 * (
                solcast_hi_kwh[valid_spread] - solcast_lo_kwh[valid_spread]
            ) / solcast_kwh[valid_spread],
            0.0,
            200.0,  # Cap at 200% to avoid extreme outliers
        )

    # Spread ratio: (Hi - Lo) / (Hi + Lo) — symmetric, robust to scale.
    # T4.3 fix: raise the denominator guard from 0.1 to 0.5 kWh so that
    # early-morning slots (0.1–0.5 kWh forecasts) can't produce numerically
    # huge ratios that saturate the clip, and apply a final nan_to_num to
    # defend against any residual inf/nan leaking into training.
    solcast_spread_ratio = np.zeros(SLOTS_DAY, dtype=float)
    with np.errstate(divide="ignore", invalid="ignore"):
        sum_bands = solcast_hi_kwh + solcast_lo_kwh
        valid_ratio = sum_bands > 0.5
        solcast_spread_ratio[valid_ratio] = np.clip(
            (solcast_hi_kwh[valid_ratio] - solcast_lo_kwh[valid_ratio])
            / sum_bands[valid_ratio],
            -1.0,
            1.0,
        )
    solcast_spread_ratio = np.nan_to_num(
        solcast_spread_ratio, nan=0.0, posinf=0.0, neginf=0.0
    )
    # Also defensively sanitize spread_pct computed just above.
    solcast_spread_pct = np.nan_to_num(
        solcast_spread_pct, nan=0.0, posinf=0.0, neginf=0.0
    )
    solcast_vs_physics = np.clip(solcast_kwh / slot_cap_arr, 0.0, 1.5)
    irr_proxy = np.maximum((np.clip(rad, 0.0, None) / 1000.0) * slot_cap_arr, 0.05)
    solcast_vs_irradiance = np.clip(solcast_kwh / irr_proxy, 0.0, 4.0)

    # Step 12: Locked snapshot features
    spread_pct_cap_locked = np.zeros(SLOTS_DAY, dtype=float)
    hours_since_lock = np.zeros(SLOTS_DAY, dtype=float)
    if solcast_prior and solcast_prior.get("has_locked_snapshot", False):
        try:
            locked_spread = np.asarray(solcast_prior.get("locked_spread_pct_cap", np.zeros(SLOTS_DAY)), dtype=float)
            locked_ts = solcast_prior.get("locked_captured_ts")
            slot_ts_local = solcast_prior.get("slot_ts_local_ms")  # milliseconds since epoch, local
            if locked_spread is not None and len(locked_spread) >= SLOTS_DAY:
                spread_pct_cap_locked = np.clip(locked_spread[:SLOTS_DAY], 0.0, None)
            if locked_ts is not None and slot_ts_local is not None:
                # Compute hours since lock for each slot
                slot_ts_arr = np.asarray(slot_ts_local, dtype=float)
                time_diff_ms = slot_ts_arr - float(locked_ts)
                hours_since_lock = np.clip(time_diff_ms / (1000.0 * 3600.0), 0.0, 48.0)
        except Exception as e:
            log.debug("Could not compute locked snapshot features: %s", e)

    df = pd.DataFrame({
        # Radiation
        "rad":           rad,
        "rad_direct":    rad_direct,
        "rad_diffuse":   rad_diffuse,
        "rad_lag_1h":    rad_lag,
        "rad_lag_1slot": rad_lag_1slot,
        "rad_lag_2slots": rad_lag_2slots,
        "rad_grad_15m":  rad_grad_15m,
        # Cloud
        "cloud":         cloud,
        "cloud_low":     cloud_low,
        "cloud_mid":     cloud_mid,
        "cloud_high":    cloud_high,
        "cloud_std_1h":  cloud_std_1h,
        "cloud_grad_15m": cloud_grad_15m,
        "cloud_trans":   ctrans,
        # Derived radiation
        "csi":           csi_arr,
        "kt":            kt,
        "dni_proxy":     dni_proxy,
        # Rain / convective context
        "precip":        precip,
        "precip_1h":     precip_1h,
        "cape":          cape,
        "cape_sqrt":     np.sqrt(cape),
        # Atmosphere
        "temp":          temp,
        "temp_hot":      np.clip(temp - 35.0, 0, None),   # severe heat
        "temp_delta":    temp - TEMP_REF_C,
        "rh":            rh,
        "rh_sq":         (rh / 100.0) ** 2,
        "wind":          wind,
        "wind_sq":       wind ** 2,
        # Geometry
        "cos_z":         geo["cos_z"],
        "air_mass":      geo["air_mass"],
        # Time
        "solar_prog":    solar_rel,
        "solar_prog_sq": solar_rel ** 2,
        "solar_prog_sin": solar_rel_sin,
        "tod_sin":       tod_sin,
        "tod_cos":       tod_cos,
        "slot_in_hour_sin": slot_in_hour_sin,
        "slot_in_hour_cos": slot_in_hour_cos,
        "sunrise_rel":   sunrise_rel,
        "sunset_rel":    sunset_rel,
        "shoulder_flag": shoulder_flag,
        "doy_sin":       doy_sin,
        "doy_cos":       doy_cos,
        "day_cloud_mean": np.full(SLOTS_DAY, float(day_stats.get("cloud_mean", 0.0))),
        "day_vol_index": np.full(SLOTS_DAY, float(day_stats.get("vol_index", 0.0))),
        "wet_season_flag": np.full(SLOTS_DAY, wet_season_flag),
        "dry_season_flag": np.full(SLOTS_DAY, dry_season_flag),
        "day_regime_clear": np.full(SLOTS_DAY, day_regime_clear),
        "day_regime_mixed": np.full(SLOTS_DAY, day_regime_mixed),
        "day_regime_overcast": np.full(SLOTS_DAY, day_regime_overcast),
        "day_regime_rainy": np.full(SLOTS_DAY, day_regime_rainy),
        # Solcast prior
        "solcast_prior_kwh": solcast_kwh,
        "solcast_prior_mw": solcast_mw,
        "solcast_prior_spread": solcast_spread,
        "solcast_prior_available": solcast_available,
        "solcast_prior_blend": solcast_blend,
        "solcast_prior_vs_physics": solcast_vs_physics,
        "solcast_prior_vs_irradiance": solcast_vs_irradiance,
        "solcast_day_coverage": np.full(SLOTS_DAY, solcast_cov),
        "solcast_day_reliability": np.full(SLOTS_DAY, solcast_rel),
        "solcast_bias_ratio": np.full(SLOTS_DAY, solcast_bias_ratio),
        "solcast_resolution_weight": solcast_resolution_weight,
        "solcast_resolution_support": solcast_resolution_support,
        # Solcast tri-band (NEW)
        "solcast_lo_kwh": solcast_lo_kwh,
        "solcast_hi_kwh": solcast_hi_kwh,
        "solcast_lo_vs_physics": solcast_lo_vs_physics,
        "solcast_hi_vs_physics": solcast_hi_vs_physics,
        "solcast_spread_pct": solcast_spread_pct,
        "solcast_spread_ratio": solcast_spread_ratio,
        # Locked snapshot (NEW v2.8)
        "spread_pct_cap_locked": spread_pct_cap_locked,
        "hours_since_lock": hours_since_lock,
        # Plant
        "expected_nodes": expected_nodes,
        "cap_kw":        np.full(SLOTS_DAY, cap_kw),
    })

    # FIX-07: Assert feature column count matches FEATURE_COLS
    if len(df.columns) != len(FEATURE_COLS):
        log.error(
            "build_features column count mismatch: got %d, expected %d. Extra: %s, Missing: %s",
            len(df.columns), len(FEATURE_COLS),
            sorted(set(df.columns) - set(FEATURE_COLS)),
            sorted(set(FEATURE_COLS) - set(df.columns)),
        )
    assert len(df.columns) == len(FEATURE_COLS), (
        f"build_features returned {len(df.columns)} columns, expected {len(FEATURE_COLS)}"
    )
    return df

FEATURE_COLS = [
    "rad", "rad_direct", "rad_diffuse", "rad_lag_1h", "rad_lag_1slot", "rad_lag_2slots", "rad_grad_15m",
    "cloud", "cloud_low", "cloud_mid", "cloud_high", "cloud_std_1h", "cloud_grad_15m", "cloud_trans",
    "csi", "kt", "dni_proxy",
    "precip", "precip_1h", "cape", "cape_sqrt",
    "temp", "temp_hot", "temp_delta", "rh", "rh_sq", "wind", "wind_sq",
    "cos_z", "air_mass",
    "solar_prog", "solar_prog_sq", "solar_prog_sin", "tod_sin", "tod_cos",
    "slot_in_hour_sin", "slot_in_hour_cos", "sunrise_rel", "sunset_rel", "shoulder_flag",
    "doy_sin", "doy_cos",
    "day_cloud_mean", "day_vol_index", "wet_season_flag", "dry_season_flag",
    "day_regime_clear", "day_regime_mixed", "day_regime_overcast", "day_regime_rainy",
    "solcast_prior_kwh", "solcast_prior_mw", "solcast_prior_spread", "solcast_prior_available",
    "solcast_prior_blend", "solcast_prior_vs_physics", "solcast_prior_vs_irradiance",
    "solcast_day_coverage", "solcast_day_reliability", "solcast_bias_ratio",
    "solcast_resolution_weight", "solcast_resolution_support",
    # Solcast tri-band (NEW)
    "solcast_lo_kwh", "solcast_hi_kwh",
    "solcast_lo_vs_physics", "solcast_hi_vs_physics",
    "solcast_spread_pct", "solcast_spread_ratio",
    # Locked snapshot (NEW v2.8)
    "spread_pct_cap_locked", "hours_since_lock",
    # Plant
    "expected_nodes", "cap_kw",
]

# ============================================================================
# CURTAILMENT DETECTION
# ============================================================================

CAP_DISPATCH_TOLERANCE = 0.97  # Detect cap-dispatch where actual >= tol * cap_slot
"""Threshold for export-cap detection. A slot is considered capped when actual
power >= this fraction of the export limit AND physics baseline > cap limit.
Typical 97% catches soft-clamping behavior while avoiding false positives on
high-efficiency slots near 100% of rated capacity."""

def _curtailed_mask_from_recorded_basis(
    actual: np.ndarray,
    baseline: np.ndarray,
    *,
    tolerance: float,
    export_cap_slot_kwh: float,
    baseline_multiplier: float = 1.05,
) -> np.ndarray:
    """Pure export-curtailment classifier using an issue-time recorded basis."""
    actual_arr = np.asarray(actual, dtype=float).reshape(-1)
    baseline_arr = np.asarray(baseline, dtype=float).reshape(-1)
    tol = float(tolerance)
    cap_slot = float(export_cap_slot_kwh)
    multiplier = float(baseline_multiplier)
    if (
        actual_arr.size != SLOTS_DAY or baseline_arr.size != SLOTS_DAY
        or not all(math.isfinite(v) for v in (tol, cap_slot, multiplier))
        or not 0.0 < tol <= 1.0 or cap_slot <= 0.0 or multiplier <= 1.0
    ):
        raise ValueError("invalid recorded export-curtailment basis")
    return (actual_arr >= tol * cap_slot) & (baseline_arr > cap_slot * multiplier)


def curtailed_mask(actual: np.ndarray, baseline: np.ndarray, tol: float = CAP_DISPATCH_TOLERANCE) -> np.ndarray:
    """
    Boolean mask: True where generation was export-capped.
    These slots must be excluded from ML training or the model
    learns a falsely-depressed response at high irradiance.

    Args:
        actual: actual power (kWh per slot)
        baseline: physics baseline power (kWh per slot)
        tol: cap-dispatch tolerance threshold (default CAP_DISPATCH_TOLERANCE=0.97)

    Returns:
        Boolean mask where (actual >= tol * cap_slot) AND (baseline > 1.05 * cap_slot)
    """
    cap_slot = load_forecast_export_limit_mw() * 1000.0 * SLOT_MIN / 60.0
    return _curtailed_mask_from_recorded_basis(
        actual,
        baseline,
        tolerance=tol,
        export_cap_slot_kwh=cap_slot,
    )

# ============================================================================
# 1000H ALARM-BASED INVERTER OUTAGE MASK (for QA)
# ============================================================================

def _get_inverter_node_map() -> dict[int, list[int]]:
    """Return {inverter_id: [node1, node2, ...]} from ipconfig."""
    ipconfig_meta = load_ipconfig_authoritative()
    cfg = ipconfig_meta.get("config", {}) if isinstance(ipconfig_meta, dict) else {}
    inv_map = cfg.get("inverters", {}) or {}
    unit_map = cfg.get("units", {}) or {}
    inv_map = {str(k): v for k, v in inv_map.items()}
    unit_map = {str(k): v for k, v in unit_map.items()}
    all_ids = set(inv_map.keys()) | set(unit_map.keys())
    result: dict[int, list[int]] = {}
    for inv_id in all_ids:
        ip = str(inv_map.get(inv_id, "") or "").strip()
        if inv_map and inv_id in inv_map and not ip:
            continue
        raw_units = unit_map.get(inv_id, None)
        nodes = _sanitize_units(raw_units) if raw_units is not None else [1, 2, 3, 4]
        if nodes:
            try:
                result[int(inv_id)] = nodes
            except (ValueError, TypeError):
                pass
    return result

def _query_1000h_inverter_outage_mask(
    day: str,
    inverter_node_map: dict[int, list[int]],
    *,
    strict: bool = False,
) -> np.ndarray:
    """Build a per-slot boolean mask: True where at least one *entire* inverter
    is down with alarm 1000H (0x1000 = 4096).

    Only marks a slot as excluded when ALL configured nodes of an inverter
    show the 1000H manual-stop alarm in their readings for that slot.
    Individual node stops or 0-Pac from MPPT clipping do NOT trigger exclusion.
    """
    mask = np.zeros(SLOTS_DAY, dtype=bool)
    day_start_ms, day_end_ms = _day_bounds_ms(day)
    if day_start_ms is None or day_end_ms is None:
        return mask
    inv_node_map = {
        int(inv): [int(node) for node in nodes]
        for inv, nodes in (inverter_node_map or {}).items()
        if nodes
    }
    if not inv_node_map:
        log.warning("1000H mask: no inverter node mapping from ipconfig — skipping outage detection")
        return mask

    slot_ms = SLOT_MIN * 60 * 1000
    # Query readings for alarm & 0x1000 per slot/inverter/node
    sql = """
        SELECT CAST((ts - ?) / ? AS INT) AS slot_idx,
               inverter,
               unit,
               MAX(CASE WHEN (alarm & 4096) != 0 THEN 1 ELSE 0 END) AS has_1000h
          FROM readings
         WHERE ts >= ? AND ts < ?
         GROUP BY slot_idx, inverter, unit
    """
    # Collect results: {(slot, inverter, node): has_1000h}
    slot_alarm: dict[tuple[int, int, int], bool] = {}
    db_paths = list(_iter_history_db_paths(int(day_start_ms), int(day_end_ms)))
    query_ok = 0
    for db_path in db_paths:
        try:
            with _open_sqlite(db_path, SQLITE_READ_TIMEOUT_SEC, readonly=True) as conn:
                conn.execute("PRAGMA query_only = ON")
                rows = conn.execute(sql, (
                    int(day_start_ms), int(slot_ms),
                    int(day_start_ms), int(day_end_ms),
                )).fetchall()
            query_ok += 1
            for row in rows:
                s_idx = int(row[0]) if row[0] is not None else -1
                inv = int(row[1] or 0)
                unit = int(row[2] or 0)
                if not (0 <= s_idx < SLOTS_DAY) or inv <= 0 or unit <= 0:
                    continue
                has = bool(row[3])
                key = (s_idx, inv, unit)
                slot_alarm[key] = slot_alarm.get(key, False) or has
        except Exception as e:
            if "no such table" in str(e).lower() or "no such column" in str(e).lower():
                continue  # Expected for old archive DBs without readings table
            log.warning("1000H mask: readings query failed [%s]: %s", db_path, e)

    if query_ok == 0 and db_paths:
        if strict:
            raise RuntimeError(f"1000H alarm basis unavailable for {day}")
        log.error("1000H mask: ALL %d db paths failed for %s — returning empty mask (no outage assumed)", len(db_paths), day)

    if not slot_alarm:
        return mask

    # For each slot, check if ALL nodes of any inverter have 1000H
    for slot_idx in range(SLOTS_DAY):
        for inv_id, expected_nodes in inv_node_map.items():
            if not expected_nodes:
                continue
            all_down = True
            for node in expected_nodes:
                if not slot_alarm.get((slot_idx, inv_id, node), False):
                    all_down = False
                    break
            if all_down:
                mask[slot_idx] = True
                break  # one full inverter down is enough to mark slot

    down_count = int(np.count_nonzero(mask))
    if down_count > 0:
        log.info("1000H outage mask for %s: %d/%d slots with full-inverter outage", day, down_count, SLOTS_DAY)
    return mask


@lru_cache(maxsize=256)
def _build_completed_1000h_inverter_outage_mask(day: str) -> np.ndarray:
    """Cache only completed dates; their alarm rows are immutable in normal use."""
    return _query_1000h_inverter_outage_mask(day, _get_inverter_node_map())


def _build_1000h_inverter_outage_mask(
    day: str,
    inverter_node_map: dict[int, list[int]] | None = None,
) -> np.ndarray:
    """Return a fresh live/future mask or a cached completed-day mask.

    Current and future dates are deliberately never cached: a day-ahead
    issuance can inspect tomorrow before any alarms exist, and current-day
    readings arrive between every intraday cycle.  An explicitly supplied
    topology is an immutable replay/scoring basis and is always queried fresh.
    """
    day_s = str(day)
    if inverter_node_map is not None:
        return _query_1000h_inverter_outage_mask(day_s, inverter_node_map)
    try:
        target = datetime.strptime(day_s, "%Y-%m-%d").date()
    except Exception:
        return np.zeros(SLOTS_DAY, dtype=bool)
    if target < datetime.now(_TZ_UTC8).date():
        return _build_completed_1000h_inverter_outage_mask(day_s).copy()
    return _query_1000h_inverter_outage_mask(day_s, _get_inverter_node_map())

# ============================================================================
# OPERATIONAL CONSTRAINTS (manual stops vs plant-cap curtailment)
# ============================================================================

def _iter_history_db_paths(start_ms: int, end_ms_exclusive: int) -> list[Path]:
    paths: list[Path] = []
    archive_paths = [ARCHIVE_DIR / f"{month_key}.db" for month_key in _archive_month_keys_for_range(start_ms, end_ms_exclusive)]
    for path in [APP_DB_FILE, *archive_paths]:
        if path.exists() and path not in paths:
            paths.append(path)
    return paths

def _normalize_audit_scope(value) -> str:
    return str(value or "single").strip().lower() or "single"

def _audit_result_ok(value) -> bool:
    result = str(value or "ok").strip().lower()
    return bool(result) and not result.startswith("error")

def _query_audit_log_latest_before(db_path: Path, before_ms: int) -> list[dict]:
    if not db_path.exists():
        return []
    sql = """
        SELECT a.ts,
               a.inverter,
               a.node,
               UPPER(COALESCE(a.action, '')) AS action,
               LOWER(COALESCE(a.scope, 'single')) AS scope,
               LOWER(COALESCE(a.result, 'ok')) AS result
          FROM audit_log a
          JOIN (
                SELECT inverter, node, MAX(ts) AS max_ts
                  FROM audit_log
                 WHERE ts < ?
                   AND inverter > 0
                   AND node > 0
                   AND UPPER(COALESCE(action, '')) IN ('STOP', 'START')
                   AND LOWER(COALESCE(result, 'ok')) NOT LIKE 'error%'
                 GROUP BY inverter, node
          ) last
            ON last.inverter = a.inverter
           AND last.node = a.node
           AND last.max_ts = a.ts
         WHERE a.inverter > 0
           AND a.node > 0
           AND UPPER(COALESCE(a.action, '')) IN ('STOP', 'START')
         ORDER BY a.ts ASC
    """
    try:
        with _open_sqlite(db_path, SQLITE_READ_TIMEOUT_SEC, readonly=True) as conn:
            conn.execute("PRAGMA query_only = ON")
            rows = conn.execute(sql, (int(before_ms),)).fetchall()
        return [
            {
                "ts": int(row[0] or 0),
                "inverter": int(row[1] or 0),
                "node": int(row[2] or 0),
                "action": str(row[3] or "").upper(),
                "scope": _normalize_audit_scope(row[4]),
                "result": str(row[5] or "").lower(),
            }
            for row in rows
            if int(row[0] or 0) > 0 and int(row[1] or 0) > 0 and int(row[2] or 0) > 0
        ]
    except Exception as e:
        if "no such table" in str(e).lower():
            return []
        log.warning("Audit-log latest-before query failed [%s]: %s", db_path, e)
        return []

def _query_audit_log_events(db_path: Path, start_ms: int, end_ms_exclusive: int) -> list[dict]:
    if not db_path.exists():
        return []
    sql = """
        SELECT ts,
               inverter,
               node,
               UPPER(COALESCE(action, '')) AS action,
               LOWER(COALESCE(scope, 'single')) AS scope,
               LOWER(COALESCE(result, 'ok')) AS result,
               id
          FROM audit_log
         WHERE ts >= ?
           AND ts < ?
           AND inverter > 0
           AND node > 0
           AND UPPER(COALESCE(action, '')) IN ('STOP', 'START')
           AND LOWER(COALESCE(result, 'ok')) NOT LIKE 'error%'
         ORDER BY ts ASC, id ASC
    """
    try:
        with _open_sqlite(db_path, SQLITE_READ_TIMEOUT_SEC, readonly=True) as conn:
            conn.execute("PRAGMA query_only = ON")
            rows = conn.execute(sql, (int(start_ms), int(end_ms_exclusive))).fetchall()
        return [
            {
                "ts": int(row[0] or 0),
                "inverter": int(row[1] or 0),
                "node": int(row[2] or 0),
                "action": str(row[3] or "").upper(),
                "scope": _normalize_audit_scope(row[4]),
                "result": str(row[5] or "").lower(),
                "order": int(row[6] or 0),
            }
            for row in rows
            if int(row[0] or 0) > 0 and int(row[1] or 0) > 0 and int(row[2] or 0) > 0
        ]
    except Exception as e:
        if "no such table" in str(e).lower():
            return []
        log.warning("Audit-log range query failed [%s]: %s", db_path, e)
        return []

@lru_cache(maxsize=256)
def load_operational_constraint_profile(day: str) -> dict:
    day_start_ms, day_end_ms = _day_bounds_ms(day)
    zero_counts = np.zeros(SLOTS_DAY, dtype=np.int16)
    empty = {
        "day": str(day),
        "commanded_off_nodes": zero_counts.copy(),
        "cap_dispatched_off_nodes": zero_counts.copy(),
        "manual_off_nodes": zero_counts.copy(),
        "event_count": 0,
    }
    if day_start_ms is None or day_end_ms is None:
        return empty

    lookback_start_ms = max(
        0,
        int(day_start_ms) - int(OPERATIONAL_CONSTRAINT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000),
    )
    db_paths = _iter_history_db_paths(lookback_start_ms, day_end_ms)
    if not db_paths:
        return empty

    latest_by_node: dict[tuple[int, int], dict] = {}
    events: list[dict] = []
    for db_path in db_paths:
        for rec in _query_audit_log_latest_before(db_path, day_start_ms):
            key = (int(rec["inverter"]), int(rec["node"]))
            prev = latest_by_node.get(key)
            if prev is None or int(rec["ts"]) >= int(prev.get("ts", 0)):
                latest_by_node[key] = rec
        events.extend(_query_audit_log_events(db_path, day_start_ms, day_end_ms))

    active_stops: dict[tuple[int, int], str] = {}
    for rec in latest_by_node.values():
        if not _audit_result_ok(rec.get("result")):
            continue
        key = (int(rec["inverter"]), int(rec["node"]))
        if str(rec.get("action")) == "STOP":
            active_stops[key] = _normalize_audit_scope(rec.get("scope"))
        elif str(rec.get("action")) == "START":
            active_stops.pop(key, None)

    events.sort(
        key=lambda rec: (
            int(rec.get("ts", 0)),
            int(rec.get("order", 0)),
            int(rec.get("inverter", 0)),
            int(rec.get("node", 0)),
            0 if str(rec.get("action")) == "STOP" else 1,
        )
    )

    slot_ms = SLOT_MIN * 60 * 1000
    commanded_off_nodes = np.zeros(SLOTS_DAY, dtype=np.int16)
    cap_dispatched_off_nodes = np.zeros(SLOTS_DAY, dtype=np.int16)
    cursor_slot = 0

    def fill_until(slot_exclusive: int) -> None:
        nonlocal cursor_slot
        slot_exclusive = int(np.clip(slot_exclusive, 0, SLOTS_DAY))
        if slot_exclusive <= cursor_slot:
            return
        commanded_count = len(active_stops)
        cap_count = sum(1 for scope in active_stops.values() if scope == "plant-cap")
        commanded_off_nodes[cursor_slot:slot_exclusive] = np.int16(commanded_count)
        cap_dispatched_off_nodes[cursor_slot:slot_exclusive] = np.int16(cap_count)
        cursor_slot = slot_exclusive

    for rec in events:
        slot = int((int(rec["ts"]) - int(day_start_ms)) // slot_ms)
        slot = int(np.clip(slot, 0, SLOTS_DAY - 1))
        fill_until(slot)
        key = (int(rec["inverter"]), int(rec["node"]))
        action = str(rec.get("action") or "").upper()
        if action == "STOP":
            active_stops[key] = _normalize_audit_scope(rec.get("scope"))
        elif action == "START":
            active_stops.pop(key, None)

    fill_until(SLOTS_DAY)
    manual_off_nodes = np.clip(
        commanded_off_nodes.astype(int) - cap_dispatched_off_nodes.astype(int),
        0,
        None,
    ).astype(np.int16)
    return {
        "day": str(day),
        "commanded_off_nodes": commanded_off_nodes,
        "cap_dispatched_off_nodes": cap_dispatched_off_nodes,
        "manual_off_nodes": manual_off_nodes,
        "event_count": int(len(events)),
    }

def build_operational_constraint_mask(day: str) -> tuple[np.ndarray, dict]:
    profile = load_operational_constraint_profile(day)
    commanded_off_nodes = np.asarray(
        profile.get("commanded_off_nodes", np.zeros(SLOTS_DAY, dtype=np.int16)),
        dtype=int,
    ).copy()
    cap_dispatched_off_nodes = np.asarray(
        profile.get("cap_dispatched_off_nodes", np.zeros(SLOTS_DAY, dtype=np.int16)),
        dtype=int,
    ).copy()
    manual_off_nodes = np.asarray(
        profile.get("manual_off_nodes", np.zeros(SLOTS_DAY, dtype=np.int16)),
        dtype=int,
    ).copy()
    cap_dispatched_off_nodes = np.clip(cap_dispatched_off_nodes, 0, commanded_off_nodes)
    manual_off_nodes = np.clip(manual_off_nodes, 0, commanded_off_nodes)

    operational_mask = commanded_off_nodes > 0
    cap_dispatch_mask = (cap_dispatched_off_nodes > 0) & (manual_off_nodes <= 0)
    manual_constraint_mask = manual_off_nodes > 0
    return operational_mask, {
        "day": str(day),
        "operational_mask": operational_mask,
        "cap_dispatch_mask": cap_dispatch_mask,
        "manual_constraint_mask": manual_constraint_mask,
        "commanded_off_nodes": commanded_off_nodes,
        "cap_dispatched_off_nodes": cap_dispatched_off_nodes,
        "manual_off_nodes": manual_off_nodes,
        "operational_slot_count": int(np.count_nonzero(operational_mask)),
        "cap_dispatch_slot_count": int(np.count_nonzero(cap_dispatch_mask)),
        "manual_constraint_slot_count": int(np.count_nonzero(manual_constraint_mask)),
        "event_count": int(profile.get("event_count", 0)),
    }

# ============================================================================
# ENERGY DATA LOADERS
# ============================================================================

_TZ_UTC8 = timezone(timedelta(hours=TZ_OFFSET))

def _day_bounds_ms(day: str) -> tuple[int, int] | tuple[None, None]:
    """Return (start_ms, end_ms) for a day string, explicitly in UTC+8."""
    try:
        start_naive = datetime.strptime(str(day).strip(), "%Y-%m-%d")
    except Exception:
        return None, None
    start = start_naive.replace(tzinfo=_TZ_UTC8)
    end = (start_naive + timedelta(days=1)).replace(tzinfo=_TZ_UTC8)
    return int(start.timestamp() * 1000), int(end.timestamp() * 1000)

def _archive_month_keys_for_range(start_ms: int, end_ms_exclusive: int) -> list[str]:
    try:
        start_dt = datetime.fromtimestamp(max(0, int(start_ms)) / 1000.0, tz=_TZ_UTC8)
        end_dt = datetime.fromtimestamp(max(0, int(end_ms_exclusive - 1)) / 1000.0, tz=_TZ_UTC8)
    except Exception:
        return []
    keys = []
    cur = datetime(start_dt.year, start_dt.month, 1)
    stop = datetime(end_dt.year, end_dt.month, 1)
    while cur <= stop:
        keys.append(f"{cur.year:04d}-{cur.month:02d}")
        if cur.month == 12:
            cur = datetime(cur.year + 1, 1, 1)
        else:
            cur = datetime(cur.year, cur.month + 1, 1)
    return keys

def _load_inverter_loss_factors() -> dict[str, float]:
    """Load per-inverter transmission loss factors (0.0-1.0) from ipconfig.

    Used exclusively by forecast-engine paths that compare or learn against
    substation-delivered energy. Dashboard telemetry and exports stay on raw
    actual inverter output.
    """
    ipconfig_meta = load_ipconfig_authoritative()
    cfg = ipconfig_meta.get("config", {}) if isinstance(ipconfig_meta, dict) else {}
    raw = cfg.get("losses", {}) or {}
    factors: dict[str, float] = {}
    for k, v in raw.items():
        pct = 0.0
        try:
            pct = float(v)
        except (TypeError, ValueError):
            pass
        if pct < 0 or pct > 100:
            pct = 0.0
        factors[str(k)] = pct / 100.0
    return factors

def _query_energy_5min_loss_adjusted(
    db_path: Path,
    day_start_ms: int,
    day_end_ms: int,
    loss_factors: dict[str, float],
) -> dict[int, float]:
    """Per-inverter loss-adjusted 5-min energy totals for forecast training.

    Each inverter kWh contribution is reduced by its configured transmission
    loss percentage so the forecast trains on substation-level output.
    """
    if not db_path.exists():
        return {}
    sql = """
        SELECT ts, inverter, kwh_inc
          FROM energy_5min
         WHERE ts >= ? AND ts < ?
         ORDER BY ts ASC
    """
    out: dict[int, float] = {}
    for attempt in range(1, SQLITE_RETRY_ATTEMPTS + 1):
        try:
            with _open_sqlite(db_path, SQLITE_READ_TIMEOUT_SEC, readonly=True) as conn:
                conn.execute("PRAGMA query_only = ON")
                cur = conn.execute(sql, (int(day_start_ms), int(day_end_ms)))
                for ts, inverter, kwh_inc in cur.fetchall():
                    ts_i = int(ts or 0)
                    if ts_i <= 0:
                        continue
                    inv_key = str(inverter)
                    loss_frac = loss_factors.get(inv_key, 0.0)
                    value = _coerce_optional_non_negative_float(kwh_inc)
                    if value is None:
                        # Retain invalidity until the presence merge so the
                        # slot cannot masquerade as a measured zero.
                        out[ts_i] = float("nan")
                        continue
                    if not math.isfinite(out.get(ts_i, 0.0)):
                        continue
                    adjusted = value * (1.0 - loss_frac)
                    out[ts_i] = out.get(ts_i, 0.0) + adjusted
            return out
        except Exception as e:
            if attempt < SQLITE_RETRY_ATTEMPTS and _is_retryable_sqlite_error(e):
                log.warning(
                    "DB loss-adjusted load retry %d/%d [%s]: %s",
                    attempt,
                    SQLITE_RETRY_ATTEMPTS,
                    db_path.name,
                    e,
                )
                _sleep_sqlite_retry(attempt)
                continue
            log.warning("DB loss-adjusted load failed [%s]: %s", db_path, e)
            break
    return out

def _query_energy_5min_by_inverter(
    db_path: Path,
    day_start_ms: int,
    day_end_ms: int,
) -> dict[tuple[int, int], float]:
    """Return {(timestamp_ms, inverter_id): kWh} from PAC-integrated energy.

    Rows are presence evidence even when kWh is zero. No communication-status
    fields or device kWh registers participate in this query.
    """
    if not db_path.exists():
        return {}
    sql = """
        SELECT ts, inverter, SUM(COALESCE(kwh_inc, 0))
          FROM energy_5min
         WHERE ts >= ? AND ts < ?
         GROUP BY ts, inverter
         ORDER BY ts ASC, inverter ASC
    """
    out: dict[tuple[int, int], float] = {}
    for attempt in range(1, SQLITE_RETRY_ATTEMPTS + 1):
        try:
            with _open_sqlite(db_path, SQLITE_READ_TIMEOUT_SEC, readonly=True) as conn:
                conn.execute("PRAGMA query_only = ON")
                for ts, inverter, kwh_inc in conn.execute(
                    sql, (int(day_start_ms), int(day_end_ms))
                ).fetchall():
                    ts_i = int(ts or 0)
                    inv_i = int(inverter or 0)
                    if ts_i > 0 and inv_i > 0:
                        out[(ts_i, inv_i)] = _coerce_non_negative_float(kwh_inc)
            return out
        except Exception as e:
            if attempt < SQLITE_RETRY_ATTEMPTS and _is_retryable_sqlite_error(e):
                _sleep_sqlite_retry(attempt)
                continue
            if "no such table" not in str(e).lower():
                log.warning("Per-inverter energy load failed [%s]: %s", db_path, e)
            return {}
    return out

def _load_inverter_energy_for_day(day: str) -> dict[int, np.ndarray]:
    """Merge hot/archive PAC-integrated energy into per-inverter slot arrays."""
    day_start_ms, day_end_ms = _day_bounds_ms(day)
    if day_start_ms is None or day_end_ms is None:
        return {}
    merged = _query_energy_5min_by_inverter(APP_DB_FILE, day_start_ms, day_end_ms)
    for month_key in _archive_month_keys_for_range(day_start_ms, day_end_ms):
        archive_path = ARCHIVE_DIR / f"{month_key}.db"
        for key, value in _query_energy_5min_by_inverter(
            archive_path, day_start_ms, day_end_ms
        ).items():
            if key not in merged or (merged[key] <= 0 < value):
                merged[key] = value
    slot_ms = SLOT_MIN * 60 * 1000
    out: dict[int, np.ndarray] = {}
    for (ts, inverter), value in merged.items():
        slot = int((int(ts) - int(day_start_ms)) // slot_ms)
        if 0 <= slot < SLOTS_DAY:
            out.setdefault(int(inverter), np.zeros(SLOTS_DAY, dtype=float))[slot] += float(value)
    return out

def _load_energy_reporting_coverage(
    day: str,
    capacity_by_inverter_kw: dict[int, float] | None = None,
) -> np.ndarray:
    """Fraction of configured inverter capacity represented per 5-min slot.

    Capacity representation is inferred from PAC-integration rows, not the
    `online` communication flag. Inverters are weighted by configured node
    count so a partially configured unit cannot have disproportionate weight.
    """
    if capacity_by_inverter_kw is None:
        inv_map = _get_inverter_node_map()
        if not inv_map:
            return np.zeros(SLOTS_DAY, dtype=float)
        capacities = {
            int(inv): max(1, len(nodes)) * float(NODE_KW_DEPENDABLE)
            for inv, nodes in inv_map.items()
        }
    else:
        capacities = {}
        for inverter, capacity in capacity_by_inverter_kw.items():
            inv = int(inverter)
            cap = float(capacity)
            if inv <= 0 or not math.isfinite(cap) or cap <= 0.0:
                raise ValueError("invalid issue-time reporting-capacity basis")
            capacities[inv] = cap
        if not capacities:
            raise ValueError("empty issue-time reporting-capacity basis")
    total_capacity = float(sum(capacities.values()))
    if total_capacity <= 0:
        return np.zeros(SLOTS_DAY, dtype=float)
    coverage = np.zeros(SLOTS_DAY, dtype=float)
    # Derive slot-specific presence directly from rows so zero-energy readings
    # count as reported without treating an inverter's entire day as present.
    day_start_ms, day_end_ms = _day_bounds_ms(day)
    if day_start_ms is None or day_end_ms is None:
        return np.zeros(SLOTS_DAY, dtype=float)
    raw = _query_energy_5min_by_inverter(APP_DB_FILE, day_start_ms, day_end_ms)
    for month_key in _archive_month_keys_for_range(day_start_ms, day_end_ms):
        raw.update(_query_energy_5min_by_inverter(
            ARCHIVE_DIR / f"{month_key}.db", day_start_ms, day_end_ms
        ))
    coverage[:] = 0.0
    slot_ms = SLOT_MIN * 60 * 1000
    represented: dict[int, set[int]] = {}
    for ts, inv in raw.keys():
        slot = int((int(ts) - int(day_start_ms)) // slot_ms)
        if 0 <= slot < SLOTS_DAY and int(inv) in capacities:
            represented.setdefault(slot, set()).add(int(inv))
    for slot, inverters in represented.items():
        coverage[slot] = sum(capacities[i] for i in inverters) / total_capacity
    return np.clip(coverage, 0.0, 1.0)

def _query_energy_5min_totals(db_path: Path, day_start_ms: int, day_end_ms: int) -> dict[int, float]:
    """Raw plant-level 5-min energy totals -- no loss adjustment."""
    if not db_path.exists():
        return {}
    sql = """
        SELECT ts, SUM(kwh_inc) AS kwh_inc, COUNT(*) AS row_count,
               COUNT(kwh_inc) AS value_count
          FROM energy_5min
         WHERE ts >= ? AND ts < ?
         GROUP BY ts
         ORDER BY ts ASC
    """
    out: dict[int, float] = {}
    for attempt in range(1, SQLITE_RETRY_ATTEMPTS + 1):
        try:
            with _open_sqlite(db_path, SQLITE_READ_TIMEOUT_SEC, readonly=True) as conn:
                conn.execute("PRAGMA query_only = ON")
                cur = conn.execute(sql, (int(day_start_ms), int(day_end_ms)))
                for ts, kwh_inc, row_count, value_count in cur.fetchall():
                    ts_i = int(ts or 0)
                    if ts_i <= 0:
                        continue
                    value = _coerce_optional_non_negative_float(kwh_inc)
                    out[ts_i] = (
                        float(value)
                        if value is not None and int(row_count or 0) == int(value_count or 0)
                        else float("nan")
                    )
            return out
        except Exception as e:
            if attempt < SQLITE_RETRY_ATTEMPTS and _is_retryable_sqlite_error(e):
                log.warning(
                    "DB actual load retry %d/%d [%s]: %s",
                    attempt,
                    SQLITE_RETRY_ATTEMPTS,
                    db_path.name,
                    e,
                )
                _sleep_sqlite_retry(attempt)
                continue
            log.warning("DB actual load failed [%s]: %s", db_path, e)
            break
    return out

# ── Substation Metered Energy (E3) ────────────────────────────────────────────

def _query_substation_metered_15min(day: str) -> dict[int, float]:
    """Query substation_metered_energy for a date.

    Returns dict {ts_epoch_ms: mwh_15min}. Silently returns empty dict if the
    DB file or the substation_metered_energy table do not exist — this is the
    expected state on fresh installs and in the test harness.
    """
    out: dict[int, float] = {}
    if not APP_DB_FILE.exists():
        return out
    sql = "SELECT ts, mwh FROM substation_metered_energy WHERE date = ? ORDER BY ts"
    for attempt in range(1, SQLITE_RETRY_ATTEMPTS + 1):
        try:
            with _open_sqlite(APP_DB_FILE, SQLITE_READ_TIMEOUT_SEC, readonly=True) as conn:
                conn.execute("PRAGMA query_only = ON")
                for ts, mwh in conn.execute(sql, (day,)).fetchall():
                    ts_i = int(ts or 0)
                    if ts_i > 0 and mwh is not None:
                        out[ts_i] = float(mwh)
            return out
        except sqlite3.OperationalError as e:
            msg = str(e).lower()
            if "no such table" in msg:
                return out
            if attempt < SQLITE_RETRY_ATTEMPTS and _is_retryable_sqlite_error(e):
                _sleep_sqlite_retry(attempt)
                continue
            log.warning("DB substation metered load failed: %s", e)
            break
        except Exception as e:
            if attempt < SQLITE_RETRY_ATTEMPTS and _is_retryable_sqlite_error(e):
                _sleep_sqlite_retry(attempt)
                continue
            log.warning("DB substation metered load failed: %s", e)
            break
    return out

def interpolate_15min_to_5min(
    metered_15min: dict[int, float],
    inverter_5min: dict[int, float],
) -> np.ndarray:
    """Shape-preserving interpolation of 15-min metered MWh to 5-min resolution.

    For each 15-min window with metered data, distributes the 15-min MWh across
    its three 5-min sub-slots proportionally to the inverter energy profile.
    Falls back to flat (mwh/3) if inverter data is unavailable for the window.

    Returns: np.ndarray of shape (SLOTS_DAY,) with kWh values (MWh×1000).
    Slots without metered data remain 0.0.
    """
    result = np.zeros(SLOTS_DAY, dtype=float)
    ms_5min = SLOT_MIN * 60 * 1000  # 300000

    for ts_15, mwh_15 in metered_15min.items():
        if mwh_15 <= 0:
            continue
        kwh_15 = mwh_15 * 1000.0  # convert MWh to kWh
        # Three 5-min sub-slots within this 15-min window
        sub_ts = [ts_15, ts_15 + ms_5min, ts_15 + 2 * ms_5min]
        sub_kwh = [inverter_5min.get(t, 0.0) for t in sub_ts]
        total_inv = sum(sub_kwh)

        for i, t in enumerate(sub_ts):
            # Slot index from epoch ms
            # Use local time offset: UTC+8
            local_ms = t + 8 * 3600 * 1000
            day_ms = local_ms % (86400 * 1000)
            slot_idx = int(day_ms // (ms_5min))
            if 0 <= slot_idx < SLOTS_DAY:
                if total_inv > 0:
                    result[slot_idx] = kwh_15 * (sub_kwh[i] / total_inv)
                else:
                    log.debug("interpolate_15min_to_5min: no inverter data at slot %d (ts=%d), flat fallback", slot_idx, t)
                    result[slot_idx] = kwh_15 / 3.0

    return result

def resolve_actual_5min_for_date(day: str) -> tuple[np.ndarray, np.ndarray, str]:
    """E4 fallback chain: resolve best-available actual energy for a date.

    Priority: metered substation → loss-adjusted inverter → Solcast est_actual.
    Per-slot: if metered covers partial solar window, remaining slots fall back.

    Returns (actual_kwh[288], present_mask[288], source_label)
    where source_label is 'metered', 'estimated', or 'mixed'.

    Routes loss-adjusted loading through ``load_actual_loss_adjusted_with_presence``
    so tests and alternate DB layouts (legacy context, archived history) resolve
    through the same path as the rest of the engine.
    """
    actual = np.zeros(SLOTS_DAY, dtype=float)
    present = np.zeros(SLOTS_DAY, dtype=bool)
    source = "estimated"

    # Step 1: Check for metered substation data (graceful if table/DB absent).
    metered_15min = _query_substation_metered_15min(day)
    if metered_15min:
        # Shape-preserving interpolation needs the raw loss-adjusted 5-min
        # profile. Build it from the loss-adjusted loader output, keyed on
        # epoch-ms to match interpolate_15min_to_5min's contract.
        inv_vals, inv_present = load_actual_loss_adjusted_with_presence(day)
        inv_5min_ts: dict[int, float] = {}
        if inv_vals is not None and inv_present is not None:
            d_dt = datetime.strptime(day, "%Y-%m-%d")
            day_start_ms = int(
                d_dt.replace(hour=0, minute=0, second=0, microsecond=0).timestamp() * 1000
            )
            # Convert from local-slot array back to epoch-ms keyed dict
            # (inverse of the slot_idx computation).
            for slot_idx in range(SLOTS_DAY):
                if bool(inv_present[slot_idx]) and float(inv_vals[slot_idx]) > 0:
                    # local_ms = day_start_ms + 8h offset back to UTC; since
                    # load_actual_loss_adjusted_with_presence already emits in
                    # plant-local slot order, we recover the original UTC ts:
                    local_ms = slot_idx * SLOT_MIN * 60 * 1000
                    utc_ms = day_start_ms + local_ms
                    inv_5min_ts[utc_ms] = float(inv_vals[slot_idx])

        metered_5min = interpolate_15min_to_5min(metered_15min, inv_5min_ts)
        metered_present = metered_5min > 0
        if np.any(metered_present):
            actual[metered_present] = metered_5min[metered_present]
            present[metered_present] = True
            source = "metered"

    # Step 2: Fill remaining slots from loss-adjusted inverter (uses the
    # canonical loader so tests and legacy-context fallbacks keep working).
    if not np.all(present[SOLAR_START_SLOT:SOLAR_END_SLOT]):
        inv_vals, inv_present = load_actual_loss_adjusted_with_presence(day)
        if inv_vals is not None and inv_present is not None:
            fill_mask = (~present) & np.asarray(inv_present, dtype=bool) & (np.asarray(inv_vals, dtype=float) > 0)
            if np.any(fill_mask):
                actual[fill_mask] = np.asarray(inv_vals, dtype=float)[fill_mask]
                present[fill_mask] = True
                if source == "metered":
                    source = "mixed"

    # Step 3: Fill remaining from Solcast est_actual
    if not np.all(present[SOLAR_START_SLOT:SOLAR_END_SLOT]):
        snap = load_solcast_snapshot(day)
        if snap:
            est_kwh = np.asarray(
                snap.get("est_actual_kwh", np.zeros(SLOTS_DAY)), dtype=float
            )
            solar_mask = np.zeros(SLOTS_DAY, dtype=bool)
            solar_mask[SOLAR_START_SLOT:SOLAR_END_SLOT] = True
            fill_mask = (~present) & solar_mask & (est_kwh > 0) & np.isfinite(est_kwh)
            if np.any(fill_mask):
                actual[fill_mask] = est_kwh[fill_mask]
                present[fill_mask] = True
                if source != "estimated":
                    source = "mixed"

    return actual, present, source

def audit_loss_factors(lookback_days: int = 30) -> dict:
    """P3: Audit loss factors against metered data.

    For each day with metered data in lookback, compare:
      - metered total kWh (from substation_metered_energy)
      - loss-adjusted plant total (from energy_5min with loss factors)

    Returns {days_analyzed, avg_deviation_pct, max_deviation_pct, status, per_day: [...]}
    """
    today = date.today()
    per_day_results = []

    for days_ago in range(1, lookback_days + 1):
        day = (today - timedelta(days=days_ago)).isoformat()

        # Load metered data
        metered_15min = _query_substation_metered_15min(day)
        if not metered_15min:
            continue

        metered_kwh_total = sum(mwh * 1000.0 for mwh in metered_15min.values())
        if metered_kwh_total <= 0:
            continue

        # Load loss-adjusted inverter data. Use the hot-DB + month-archive
        # merge loader so the audit still sees days that have been rotated
        # out of the hot DB (a hot-only read silently skipped archived days,
        # degrading loss-factor calibration when retainDays is small).
        loss_factors = _load_inverter_loss_factors()
        loss_adj_slots, _present = _load_actual_loss_adjusted_from_appdata(day, loss_factors)
        loss_adj_kwh_total = (
            float(np.sum(loss_adj_slots)) if loss_adj_slots is not None else 0.0
        )

        if loss_adj_kwh_total <= 0:
            continue

        # Compute deviation
        deviation_pct = abs(metered_kwh_total - loss_adj_kwh_total) / max(metered_kwh_total, 1.0) * 100.0
        per_day_results.append({
            "day": day,
            "metered_kwh": round(metered_kwh_total, 1),
            "loss_adjusted_kwh": round(loss_adj_kwh_total, 1),
            "deviation_pct": round(deviation_pct, 2),
        })

    if not per_day_results:
        return {
            "days_analyzed": 0,
            "avg_deviation_pct": 0.0,
            "max_deviation_pct": 0.0,
            "status": "no_metered_data",
            "per_day": [],
        }

    deviations = [d["deviation_pct"] for d in per_day_results]
    avg_dev = float(np.mean(deviations))
    max_dev = float(np.max(deviations))

    status = "well_calibrated" if avg_dev < 0.5 else ("review_recommended" if avg_dev < 1.0 else "flagged")

    return {
        "days_analyzed": len(per_day_results),
        "avg_deviation_pct": round(avg_dev, 2),
        "max_deviation_pct": round(max_dev, 2),
        "status": status,
        "per_day": per_day_results[-10:],  # last 10 days
    }

def compute_solcast_accuracy_vs_metered(lookback_days: int = 30) -> float:
    """P4: Compute dynamic EST_ACTUAL_WEIGHT_FACTOR based on Solcast accuracy vs metered.

    Query forecast_error_compare_slot for metered days, compute Solcast MAPE.
    Map MAPE → weight: <5% → 0.95; 5-12% → 0.93; >12% → 0.85.

    Returns effective weight, or default EST_ACTUAL_WEIGHT_FACTOR if insufficient data.
    """
    today = date.today()
    start_date = (today - timedelta(days=lookback_days)).isoformat()
    end_date = (today - timedelta(days=1)).isoformat()

    if not APP_DB_FILE.exists():
        return EST_ACTUAL_WEIGHT_FACTOR
    try:
        with _open_sqlite(APP_DB_FILE, SQLITE_READ_TIMEOUT_SEC, readonly=True) as conn:
            conn.execute("PRAGMA query_only = ON")
            # actual_source column is optional on pre-v2.7.6 schemas — bail out
            # early if the column is missing (no metered-era data yet).
            slot_cols = {row[1] for row in conn.execute(
                "PRAGMA table_info(forecast_error_compare_slot)"
            ).fetchall()}
            if "actual_source" not in slot_cols:
                return EST_ACTUAL_WEIGHT_FACTOR
            rows = conn.execute(
                """
                SELECT forecast_kwh, actual_kwh
                  FROM forecast_error_compare_slot
                 WHERE target_date >= ? AND target_date <= ?
                   AND actual_source = 'metered'
                   AND actual_kwh > 0.0
                   AND forecast_kwh IS NOT NULL
                """,
                (start_date, end_date)
            ).fetchall()
    except Exception as e:
        log.warning("Failed to query metered accuracy: %s", e)
        return EST_ACTUAL_WEIGHT_FACTOR

    if not rows or len(rows) < 100:  # need at least ~3 days of data
        log.info("Insufficient metered error data for dynamic weight (%d slots); using default", len(rows))
        return EST_ACTUAL_WEIGHT_FACTOR

    # Compute MAPE vs metered actuals
    errors = []
    for fc_kwh, act_kwh in rows:
        if fc_kwh is not None and act_kwh is not None and act_kwh > 0:
            ape = abs(float(fc_kwh) - float(act_kwh)) / float(act_kwh)
            errors.append(ape)

    if not errors:
        return EST_ACTUAL_WEIGHT_FACTOR

    mape = float(np.mean(errors)) * 100.0
    log.info("Solcast vs metered MAPE = %.2f%% (slots=%d)", mape, len(errors))

    # Map MAPE → weight
    if mape < 5.0:
        weight = 0.95
    elif mape < 12.0:
        weight = 0.93
    else:
        weight = 0.85

    log.info("Dynamic EST_ACTUAL_WEIGHT = %.3f (based on metered accuracy)", weight)
    return weight

def get_plant_avg_loss_pct() -> float:
    """P5: Compute plant-average loss factor percentage."""
    try:
        profile = plant_capacity_profile()
        enabled_nodes = float(profile.get("enabled_nodes", 1.0))
        loss_adjusted_nodes = float(profile.get("loss_adjusted_nodes", 1.0))
        if enabled_nodes <= 0:
            return 0.0
        loss_pct = (1.0 - loss_adjusted_nodes / enabled_nodes) * 100.0
        return float(np.clip(loss_pct, 0.0, 10.0))
    except Exception as e:
        log.warning("Failed to compute plant avg loss: %s", e)
        return 0.0

# ── Availability / Outage Detection (Phase 2) ──────────────────────────────

def _query_availability_5min(db_path: Path, day_start_ms: int, day_end_ms: int) -> dict[int, tuple[int, int]]:
    """Query availability_5min table for a day range.

    Returns dict {ts_ms: (online_count, expected_count)}.
    Silently returns empty dict if table doesn't exist (old DB).
    """
    if not db_path.exists():
        return {}
    sql = """
        SELECT ts, online_count, expected_count
          FROM availability_5min
         WHERE ts >= ? AND ts < ?
         ORDER BY ts ASC
    """
    out: dict[int, tuple[int, int]] = {}
    for attempt in range(1, SQLITE_RETRY_ATTEMPTS + 1):
        try:
            with _open_sqlite(db_path, SQLITE_READ_TIMEOUT_SEC, readonly=True) as conn:
                conn.execute("PRAGMA query_only = ON")
                cur = conn.execute(sql, (int(day_start_ms), int(day_end_ms)))
                for ts, online, expected in cur.fetchall():
                    ts_i = int(ts or 0)
                    if ts_i <= 0:
                        continue
                    out[ts_i] = (int(online or 0), int(expected or 0))
            return out
        except Exception as e:
            msg = str(e).lower()
            if "no such table" in msg:
                return {}
            if attempt < SQLITE_RETRY_ATTEMPTS and _is_retryable_sqlite_error(e):
                log.warning(
                    "DB availability load retry %d/%d [%s]: %s",
                    attempt, SQLITE_RETRY_ATTEMPTS, db_path.name, e,
                )
                _sleep_sqlite_retry(attempt)
                continue
            log.warning("DB availability load failed [%s]: %s", db_path, e)
            break
    return out

def _load_availability_for_day(day: str) -> dict[int, tuple[int, int]]:
    """Load availability data for a day from hot DB + archives (merge)."""
    day_start_ms, day_end_ms = _day_bounds_ms(day)
    if day_start_ms is None or day_end_ms is None:
        return {}

    merged = _query_availability_5min(APP_DB_FILE, day_start_ms, day_end_ms)
    for month_key in _archive_month_keys_for_range(day_start_ms, day_end_ms):
        archive_path = ARCHIVE_DIR / f"{month_key}.db"
        archive_rows = _query_availability_5min(archive_path, day_start_ms, day_end_ms)
        for ts, counts in archive_rows.items():
            if ts not in merged:
                merged[ts] = counts
    return merged

def _detect_outage_slots(day: str) -> np.ndarray:
    """Build a boolean mask (288 slots) where True = outage-tainted slot.

    A slot is outage-tainted when online_count / expected_count < AVAIL_OUTAGE_THRESHOLD.
    Returns all-False if no availability data exists (backward compatible).
    """
    avail = _load_availability_for_day(day)
    mask = np.zeros(SLOTS_DAY, dtype=bool)
    if not avail:
        return mask

    day_start_ms, _ = _day_bounds_ms(day)
    if day_start_ms is None:
        return mask

    slot_ms = SLOT_MIN * 60 * 1000
    for ts, (online, expected) in avail.items():
        slot = int((int(ts) - day_start_ms) // slot_ms)
        if 0 <= slot < SLOTS_DAY and expected > 0:
            ratio = online / expected
            if ratio < AVAIL_OUTAGE_THRESHOLD:
                mask[slot] = True
    return mask

def _classify_day_outage_severity(day: str, outage_mask: np.ndarray | None = None) -> str:
    """Classify a day's outage severity based on the fraction of solar slots affected.

    Returns one of: 'no_outage', 'minor', 'moderate', 'severe'.
    """
    if outage_mask is None:
        outage_mask = _detect_outage_slots(day)

    solar_slots = SOLAR_END_SLOT - SOLAR_START_SLOT
    if solar_slots <= 0:
        return "no_outage"

    solar_outage_count = int(np.count_nonzero(outage_mask[SOLAR_START_SLOT:SOLAR_END_SLOT]))
    frac = solar_outage_count / solar_slots

    if frac >= AVAIL_DAY_SEVERE_PCT:
        return "severe"
    if frac >= AVAIL_DAY_MODERATE_PCT:
        return "moderate"
    if frac >= AVAIL_DAY_MINOR_PCT:
        return "minor"
    return "no_outage"

def _outage_slot_summary(day: str, outage_mask: np.ndarray | None = None) -> dict[str, int | str | bool]:
    """Return a summary dict of outage metrics for a given day.

    Keys: outage_slot_count, solar_outage_slot_count, severity, has_availability_data.
    """
    if outage_mask is None:
        outage_mask = _detect_outage_slots(day)

    solar_outage = int(np.count_nonzero(outage_mask[SOLAR_START_SLOT:SOLAR_END_SLOT]))
    return {
        "outage_slot_count": int(np.count_nonzero(outage_mask)),
        "solar_outage_slot_count": solar_outage,
        "severity": _classify_day_outage_severity(day, outage_mask),
        "has_availability_data": bool(np.any(outage_mask)) or bool(_load_availability_for_day(day)),
    }

def _load_actual_from_appdata(day: str) -> tuple[np.ndarray | None, np.ndarray | None]:
    day_start_ms, day_end_ms = _day_bounds_ms(day)
    if day_start_ms is None or day_end_ms is None:
        return None, None

    merged = _query_energy_5min_totals(APP_DB_FILE, day_start_ms, day_end_ms)
    for month_key in _archive_month_keys_for_range(day_start_ms, day_end_ms):
        archive_path = ARCHIVE_DIR / f"{month_key}.db"
        archive_rows = _query_energy_5min_totals(archive_path, day_start_ms, day_end_ms)
        for ts, kwh_inc in archive_rows.items():
            prev = merged.get(ts, None)
            if prev is None:
                merged[ts] = kwh_inc
            elif (not math.isfinite(float(prev))) or prev <= 0 < kwh_inc:
                merged[ts] = kwh_inc

    if not merged:
        return None, None

    out = _empty_slot_values()
    present = _empty_slot_presence()
    slot_ms = SLOT_MIN * 60 * 1000
    for ts in sorted(merged.keys()):
        slot = int((int(ts) - day_start_ms) // slot_ms)
        if 0 <= slot < SLOTS_DAY:
            value = _coerce_optional_non_negative_float(merged[ts])
            if value is not None:
                out[slot] += value
                present[slot] = True
    return out, present

def _load_actual_from_legacy_context(day: str) -> tuple[np.ndarray | None, np.ndarray | None]:
    ctx = _load_json(HISTORY_CTX)
    rows = ctx.get("PacEnergy_5min", {}).get("0", {}).get(day)
    if not isinstance(rows, list):
        return None, None
    out = _empty_slot_values()
    present = _empty_slot_presence()
    total_rows = len(rows)
    for i, r in enumerate(rows[:SLOTS_DAY]):
        if not isinstance(r, dict):
            continue
        slot = _parse_slot_from_time_text(day, r.get("time") or r.get("time_hms"))
        if slot is None:
            slot = _default_legacy_slot(i, total_rows)
        if 0 <= slot < SLOTS_DAY:
            value = _coerce_optional_non_negative_float(r.get("kWh_inc", r.get("kwh_inc")))
            if value is not None:
                out[slot] = value
                present[slot] = True
    return (out, present) if present.any() else (None, None)

@lru_cache(maxsize=256)
def load_actual_with_presence(day: str, min_solar_slots: int = MIN_HISTORY_SOLAR_SLOTS) -> tuple[np.ndarray | None, np.ndarray | None]:
    db_actual, db_present = _load_actual_from_appdata(day)
    legacy_actual, legacy_present = _load_actual_from_legacy_context(day)
    return _merge_slot_series_with_presence(
        "Actual history",
        day,
        db_actual,
        db_present,
        legacy_actual,
        legacy_present,
        min_solar_slots,
    )

@lru_cache(maxsize=256)
def load_actual(day: str, min_solar_slots: int = MIN_HISTORY_SOLAR_SLOTS) -> np.ndarray | None:
    values, _ = load_actual_with_presence(day, min_solar_slots)
    return values

# ---------------------------------------------------------------------------
# Loss-adjusted actual loaders (forecast engine only)
# ---------------------------------------------------------------------------
# These apply per-inverter transmission loss factors so the ML model, error
# memory, intraday adjustment, QA, and backtest all operate on consistent
# substation-level actuals.  Solcast reliability uses the same basis because
# Solcast snapshots are already substation-level.  Non-forecast consumers
# (inverter health display, exports, reports) use the raw load_actual() above.
# ---------------------------------------------------------------------------

# Module-level loss-factor snapshot refreshed each forecast cycle via
# clear_forecast_data_cache().  Avoids re-reading ipconfig.json on every
# per-day call inside training / error-memory loops.
_cached_loss_factors: dict[str, float] | None = None

def _get_loss_factors() -> dict[str, float]:
    """Return cached loss factors, loading from ipconfig on first call."""
    global _cached_loss_factors
    if _cached_loss_factors is None:
        _cached_loss_factors = _load_inverter_loss_factors()
    return _cached_loss_factors

def _has_nonzero_losses() -> bool:
    return any(v > 0 for v in _get_loss_factors().values())

def _load_actual_loss_adjusted_from_appdata(
    day: str,
    loss_factors: dict[str, float],
) -> tuple[np.ndarray | None, np.ndarray | None]:
    day_start_ms, day_end_ms = _day_bounds_ms(day)
    if day_start_ms is None or day_end_ms is None:
        return None, None

    merged = _query_energy_5min_loss_adjusted(APP_DB_FILE, day_start_ms, day_end_ms, loss_factors)
    for month_key in _archive_month_keys_for_range(day_start_ms, day_end_ms):
        archive_path = ARCHIVE_DIR / f"{month_key}.db"
        archive_rows = _query_energy_5min_loss_adjusted(archive_path, day_start_ms, day_end_ms, loss_factors)
        for ts, kwh_inc in archive_rows.items():
            prev = merged.get(ts, None)
            if prev is None:
                merged[ts] = kwh_inc
            elif (not math.isfinite(float(prev))) or prev <= 0 < kwh_inc:
                merged[ts] = kwh_inc

    if not merged:
        return None, None

    out = _empty_slot_values()
    present = _empty_slot_presence()
    slot_ms = SLOT_MIN * 60 * 1000
    for ts in sorted(merged.keys()):
        slot = int((int(ts) - day_start_ms) // slot_ms)
        if 0 <= slot < SLOTS_DAY:
            value = _coerce_optional_non_negative_float(merged[ts])
            if value is not None:
                out[slot] += value
                present[slot] = True
    return out, present

# Cache lifetime equals subprocess lifetime — safe in the current spawn model.
# If the engine is ever converted to a long-running daemon this cache must be
# time-bounded or invalidated on each generation run to avoid stale actuals.
@lru_cache(maxsize=256)
def load_actual_loss_adjusted_with_presence(day: str, min_solar_slots: int = MIN_HISTORY_SOLAR_SLOTS) -> tuple[np.ndarray | None, np.ndarray | None]:
    """Loss-adjusted (values, presence) pair for forecast-engine consumers."""
    if not _has_nonzero_losses():
        return load_actual_with_presence(day, min_solar_slots)

    loss_factors = _get_loss_factors()
    db_actual, db_present = _load_actual_loss_adjusted_from_appdata(day, loss_factors)
    legacy_actual, legacy_present = _load_actual_from_legacy_context(day)
    return _merge_slot_series_with_presence(
        "Actual history (loss-adjusted)",
        day,
        db_actual,
        db_present,
        legacy_actual,
        legacy_present,
        min_solar_slots,
    )

# See note on load_actual_loss_adjusted_with_presence regarding daemon-mode staleness.
@lru_cache(maxsize=256)
def load_actual_loss_adjusted(day: str, min_solar_slots: int = MIN_HISTORY_SOLAR_SLOTS) -> np.ndarray | None:
    """Loss-adjusted 5-min actual for forecast training / day-ahead / QA.

    Falls back to raw load_actual() when configured losses are all zero.
    """
    values, _ = load_actual_loss_adjusted_with_presence(day, min_solar_slots)
    return values

def _load_dayahead_from_db(day: str) -> tuple[np.ndarray | None, np.ndarray | None]:
    if not APP_DB_FILE.exists():
        return None, None
    out = _empty_slot_values()
    present = _empty_slot_presence()
    for attempt in range(1, SQLITE_RETRY_ATTEMPTS + 1):
        try:
            with _open_sqlite(APP_DB_FILE, SQLITE_READ_TIMEOUT_SEC, readonly=True) as conn:
                conn.execute("PRAGMA query_only = ON")
                cur = conn.execute(
                    """
                    SELECT slot, kwh_inc
                      FROM forecast_dayahead
                     WHERE date=?
                     ORDER BY slot ASC
                    """,
                    (str(day),),
                )
                for slot, kwh_inc in cur.fetchall():
                    slot_i = int(slot or 0)
                    if 0 <= slot_i < SLOTS_DAY:
                        value = _coerce_optional_non_negative_float(kwh_inc)
                        if value is not None:
                            out[slot_i] = value
                            present[slot_i] = True
            return (out, present) if present.any() else (None, None)
        except Exception as e:
            if attempt < SQLITE_RETRY_ATTEMPTS and _is_retryable_sqlite_error(e):
                log.warning(
                    "DB day-ahead load retry %d/%d [%s]: %s",
                    attempt,
                    SQLITE_RETRY_ATTEMPTS,
                    day,
                    e,
                )
                _sleep_sqlite_retry(attempt)
                continue
            log.warning("DB day-ahead load failed [%s]: %s", day, e)
            return None, None

_IMMUTABLE_ISSUANCE_COLUMNS = {
    "issuance_id", "date", "generated_ts", "source", "expected_slot_count",
    "basis_checksum", "weather_snapshot_json", "weather_snapshot_sha256",
    "constraint_snapshot_json", "constraint_snapshot_sha256", "model_sha256",
    "artifact_sha256", "base_run_audit_id", "created_by",
}
_IMMUTABLE_SLOT_COLUMNS = {
    "date", "issuance_id", "generated_ts", "slot", "time_hms",
    "kwh_inc", "kwh_lo", "kwh_hi", "source",
}

def _sqlite_table_columns(conn: sqlite3.Connection, table_name: str) -> set[str]:
    return {str(row[1]) for row in conn.execute(f"PRAGMA table_info({table_name})").fetchall()}

def _ensure_immutable_dayahead_tables(conn: sqlite3.Connection) -> None:
    """Create the append-only, issuance-grouped replay basis.

    The former table was populated by generic context synchronisation and had
    neither bands nor provenance.  Such rows cannot be made causal after the
    fact, so an incompatible legacy table is moved to a recoverable quarantine
    table rather than assigning it synthetic identity.
    """
    old_columns = _sqlite_table_columns(conn, "forecast_dayahead_immutable")
    if old_columns and not _IMMUTABLE_SLOT_COLUMNS.issubset(old_columns):
        legacy_name = "forecast_dayahead_immutable_legacy_quarantine"
        if _sqlite_table_columns(conn, legacy_name):
            legacy_name = f"{legacy_name}_{int(time.time() * 1000)}"
        conn.execute(f"ALTER TABLE forecast_dayahead_immutable RENAME TO {legacy_name}")
        log.warning(
            "Quarantined non-causal legacy immutable rows in table %s; no provenance was fabricated",
            legacy_name,
        )

    conn.executescript("""
        CREATE TABLE IF NOT EXISTS forecast_dayahead_issuance (
            issuance_id TEXT PRIMARY KEY,
            date TEXT NOT NULL,
            generated_ts INTEGER NOT NULL,
            source TEXT NOT NULL DEFAULT 'service',
            expected_slot_count INTEGER NOT NULL,
            basis_checksum TEXT NOT NULL,
            weather_snapshot_json TEXT,
            weather_snapshot_sha256 TEXT,
            constraint_snapshot_json TEXT,
            constraint_snapshot_sha256 TEXT,
            model_sha256 TEXT,
            artifact_sha256 TEXT,
            base_run_audit_id INTEGER,
            created_by TEXT NOT NULL DEFAULT 'forecast_engine'
        );
        CREATE INDEX IF NOT EXISTS idx_fdi_date_generated
            ON forecast_dayahead_issuance(date, generated_ts DESC);
        CREATE TABLE IF NOT EXISTS forecast_dayahead_immutable (
            date TEXT NOT NULL,
            issuance_id TEXT NOT NULL,
            generated_ts INTEGER NOT NULL,
            slot INTEGER NOT NULL,
            time_hms TEXT NOT NULL,
            kwh_inc REAL NOT NULL,
            kwh_lo REAL NOT NULL,
            kwh_hi REAL NOT NULL,
            source TEXT NOT NULL DEFAULT 'service',
            PRIMARY KEY(date, issuance_id, slot),
            FOREIGN KEY(issuance_id) REFERENCES forecast_dayahead_issuance(issuance_id)
        );
        CREATE INDEX IF NOT EXISTS idx_fdii_date_generated
            ON forecast_dayahead_immutable(date, generated_ts DESC);
    """)
    issuance_columns = _sqlite_table_columns(conn, "forecast_dayahead_issuance")
    for definition in (
        "weather_snapshot_json TEXT", "weather_snapshot_sha256 TEXT",
        "constraint_snapshot_json TEXT", "constraint_snapshot_sha256 TEXT",
        "model_sha256 TEXT", "artifact_sha256 TEXT", "base_run_audit_id INTEGER",
        "created_by TEXT NOT NULL DEFAULT 'forecast_engine'",
    ):
        if definition.split()[0] not in issuance_columns:
            conn.execute(f"ALTER TABLE forecast_dayahead_issuance ADD COLUMN {definition}")

def _canonical_json_sha256(payload) -> tuple[str, str]:
    encoded = json.dumps(payload, separators=(",", ":"), sort_keys=True, ensure_ascii=True)
    return encoded, hashlib.sha256(encoded.encode("utf-8")).hexdigest()

def _immutable_basis_checksum(rows: list[tuple]) -> str:
    canonical = "\n".join(
        f"{int(row[0])}|{str(row[1])}|{float(row[2]):.9f}|{float(row[3]):.9f}|{float(row[4]):.9f}"
        for row in sorted(rows, key=lambda value: int(value[0]))
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

def _load_immutable_dayahead_bundle_from_db(day: str, max_generated_ts: int) -> dict | None:
    """Load one complete, checksummed issuance at or before an issue time."""
    if not APP_DB_FILE.exists():
        return None
    for attempt in range(1, SQLITE_RETRY_ATTEMPTS + 1):
        try:
            with _open_sqlite(APP_DB_FILE, SQLITE_READ_TIMEOUT_SEC, readonly=True) as conn:
                conn.execute("PRAGMA query_only = ON")
                if not _IMMUTABLE_ISSUANCE_COLUMNS.issubset(_sqlite_table_columns(conn, "forecast_dayahead_issuance")):
                    return None
                if not _IMMUTABLE_SLOT_COLUMNS.issubset(_sqlite_table_columns(conn, "forecast_dayahead_immutable")):
                    return None
                issuance = conn.execute(
                    """
                    SELECT issuance_id, generated_ts, source, expected_slot_count,
                           basis_checksum, weather_snapshot_json, weather_snapshot_sha256,
                           constraint_snapshot_json, constraint_snapshot_sha256,
                           model_sha256, artifact_sha256, base_run_audit_id, created_by
                      FROM forecast_dayahead_issuance
                     WHERE date=? AND generated_ts <= ?
                     ORDER BY generated_ts DESC, issuance_id DESC LIMIT 1
                    """,
                    (str(day), int(max_generated_ts)),
                ).fetchone()
                if not issuance:
                    return None
                issuance_id = str(issuance[0])
                rows = conn.execute(
                    """
                    SELECT slot, time_hms, kwh_inc, kwh_lo, kwh_hi
                      FROM forecast_dayahead_immutable
                     WHERE date=? AND issuance_id=?
                     ORDER BY slot ASC
                    """,
                    (str(day), issuance_id),
                ).fetchall()

            expected_count = int(issuance[3] or 0)
            expected_slots = list(range(SOLAR_START_SLOT, SOLAR_END_SLOT))
            actual_slots = [int(row[0]) for row in rows]
            if expected_count != SOLAR_SLOTS or len(rows) != expected_count or actual_slots != expected_slots:
                log.warning("Immutable day-ahead issuance rejected [%s:%s]: incomplete slot coverage", day, issuance_id)
                return None
            numeric = np.asarray([[row[2], row[3], row[4]] for row in rows], dtype=float)
            if (
                not np.all(np.isfinite(numeric)) or np.any(numeric < 0.0)
                or np.any(numeric[:, 1] > numeric[:, 0] + 1e-9)
                or np.any(numeric[:, 0] > numeric[:, 2] + 1e-9)
                or _immutable_basis_checksum(rows) != str(issuance[4] or "")
            ):
                log.warning("Immutable day-ahead issuance rejected [%s:%s]: checksum or bounds invalid", day, issuance_id)
                return None

            weather_json = str(issuance[5] or "")
            constraints_json = str(issuance[7] or "")
            if not weather_json or hashlib.sha256(weather_json.encode("utf-8")).hexdigest() != str(issuance[6] or ""):
                log.warning("Immutable day-ahead issuance rejected [%s:%s]: weather identity invalid", day, issuance_id)
                return None
            if (
                not constraints_json
                or hashlib.sha256(constraints_json.encode("utf-8")).hexdigest() != str(issuance[8] or "")
            ):
                log.warning("Immutable day-ahead issuance rejected [%s:%s]: constraint identity invalid", day, issuance_id)
                return None
            try:
                weather_snapshot = json.loads(weather_json)
                constraint_snapshot = json.loads(constraints_json)
                parsed_constraints = _parse_replay_constraint_snapshot(constraint_snapshot)
            except Exception:
                return None
            recorded_cap = parsed_constraints["slot_cap_kwh"]
            recorded_blend = parsed_constraints["blend_max"]
            if (
                recorded_cap is None or recorded_cap <= 0.0
                or recorded_blend is None or recorded_blend > 1.0
                or np.any(numeric > recorded_cap + 1e-9)
            ):
                log.warning("Immutable day-ahead issuance rejected [%s:%s]: issue-time cap missing or violated", day, issuance_id)
                return None

            p50 = _empty_slot_values()
            lo = _empty_slot_values()
            hi = _empty_slot_values()
            present = _empty_slot_presence()
            for slot, _time_hms, mid, low, high in rows:
                slot_i = int(slot)
                p50[slot_i], lo[slot_i], hi[slot_i] = float(mid), float(low), float(high)
                present[slot_i] = True
            return {
                "dayahead": p50, "dayahead_lo": lo, "dayahead_hi": hi,
                "dayahead_present": present, "weather_snapshot": weather_snapshot,
                "constraint_snapshot": constraint_snapshot,
                "issuance_id": issuance_id, "generated_ts": int(issuance[1]),
                "source": str(issuance[2]), "basis_checksum": str(issuance[4]),
                "weather_snapshot_sha256": str(issuance[6]),
                "constraint_snapshot_sha256": str(issuance[8] or "") or None,
                "model_sha256": issuance[9], "artifact_sha256": issuance[10],
                "base_run_audit_id": issuance[11], "created_by": issuance[12],
            }
        except Exception as e:
            if attempt < SQLITE_RETRY_ATTEMPTS and _is_retryable_sqlite_error(e):
                _sleep_sqlite_retry(attempt)
                continue
            log.warning("Immutable day-ahead load failed [%s]: %s", day, e)
            return None
    return None

def _load_immutable_dayahead_from_db(day: str, max_generated_ts: int) -> tuple[np.ndarray | None, np.ndarray | None]:
    """Backward-compatible value/presence wrapper around the strict loader."""
    bundle = _load_immutable_dayahead_bundle_from_db(day, max_generated_ts)
    if not bundle:
        return None, None
    return bundle["dayahead"], bundle["dayahead_present"]

def _load_dayahead_bands_from_db(day: str) -> tuple[np.ndarray, np.ndarray]:
    """Return (kwh_lo, kwh_hi) slot arrays for a stored day-ahead forecast.

    Both arrays default to zero if the table has no rows for the day or if
    the lo/hi columns are missing (older schema).  Never raises.
    """
    lo = _empty_slot_values()
    hi = _empty_slot_values()
    if not APP_DB_FILE.exists():
        return lo, hi
    try:
        with _open_sqlite(APP_DB_FILE, SQLITE_READ_TIMEOUT_SEC, readonly=True) as conn:
            conn.execute("PRAGMA query_only = ON")
            cur = conn.execute(
                """
                SELECT slot, kwh_lo, kwh_hi
                  FROM forecast_dayahead
                 WHERE date=?
                 ORDER BY slot ASC
                """,
                (str(day),),
            )
            for slot, kwh_lo_val, kwh_hi_val in cur.fetchall():
                slot_i = int(slot or 0)
                if 0 <= slot_i < SLOTS_DAY:
                    lo[slot_i] = _coerce_non_negative_float(kwh_lo_val)
                    hi[slot_i] = _coerce_non_negative_float(kwh_hi_val)
    except Exception as e:
        log.warning("DB day-ahead bands load failed [%s]: %s", day, e)
    return lo, hi

def _load_dayahead_from_legacy(day: str) -> tuple[np.ndarray | None, np.ndarray | None]:
    ctx = _load_json(FORECAST_CTX)
    da  = ctx.get("PacEnergy_DayAhead", {}).get(day)
    if not isinstance(da, list) or not da:
        return None, None
    out = _empty_slot_values()
    present = _empty_slot_presence()
    total_rows = len(da)
    for i, p in enumerate(da):
        if not isinstance(p, dict):
            continue
        slot = _parse_slot_from_time_text(day, p.get("time") or p.get("time_hms"))
        if slot is None:
            slot = _default_legacy_slot(i, total_rows)
        if 0 <= slot < SLOTS_DAY:
            value = _coerce_optional_non_negative_float(p.get("kWh_inc", p.get("kwh_inc")))
            if value is not None:
                out[slot] = value
                present[slot] = True
    return (out, present) if present.any() else (None, None)

# See note on load_actual_loss_adjusted_with_presence regarding daemon-mode staleness.
@lru_cache(maxsize=256)
def load_dayahead_with_presence(day: str) -> tuple[np.ndarray | None, np.ndarray | None]:
    db_rows, db_present = _load_dayahead_from_db(day)
    legacy_rows, legacy_present = _load_dayahead_from_legacy(day)
    return _merge_slot_series_with_presence(
        "Day-ahead history",
        day,
        db_rows,
        db_present,
        legacy_rows,
        legacy_present,
        MIN_DAYAHEAD_SOLAR_SLOTS,
    )

@lru_cache(maxsize=256)
def load_dayahead(day: str) -> np.ndarray | None:
    values, _ = load_dayahead_with_presence(day)
    return values

def load_solcast_snapshot(day: str) -> dict | None:
    """
    Public entry point with per-cycle cache (v2.8 E1a).

    Returns a deep copy on cache hit so downstream callers cannot mutate
    the cached snapshot. None entries are also cached to avoid re-querying
    days with no snapshot.
    """
    cached = _cycle_cache_get("solcast_snapshot", day)
    if cached is not _CYCLE_CACHE_MISS:
        if cached is None:
            return None
        return _deepcopy_snapshot(cached)
    fresh = _load_solcast_snapshot_uncached(day)
    _cycle_cache_put("solcast_snapshot", day, fresh)
    return _deepcopy_snapshot(fresh) if fresh is not None else None

def _deepcopy_snapshot(snap: dict) -> dict:
    """Return a shallow-dict copy with numpy arrays copied."""
    out = {}
    for k, v in snap.items():
        if isinstance(v, np.ndarray):
            out[k] = v.copy()
        else:
            out[k] = v
    return out

def _finalize_snapshot_from_rows(day: str, rows: list) -> dict | None:
    """
    Build a snapshot dict from raw `solcast_snapshots` rows for *day*.

    Shared by `_load_solcast_snapshot_uncached` (single-day path) and
    `_load_solcast_snapshots_range_uncached` (E1b batch path) so the
    est_actual fallback + spread_frac math + return shape stay in one
    place. Each row is the 11-tuple
    `(slot, forecast_kwh, forecast_lo_kwh, forecast_hi_kwh, est_actual_kwh,
       forecast_mw, forecast_lo_mw, forecast_hi_mw, est_actual_mw,
       pulled_ts, source)`.
    """
    if not rows:
        return None

    forecast_kwh = _empty_slot_values()
    forecast_lo_kwh = _empty_slot_values()
    forecast_hi_kwh = _empty_slot_values()
    est_actual_kwh = _empty_slot_values()
    forecast_mw = _empty_slot_values()
    forecast_lo_mw = _empty_slot_values()
    forecast_hi_mw = _empty_slot_values()
    est_actual_mw = _empty_slot_values()
    present = _empty_slot_presence()
    pulled_ts = 0
    source = ""

    for row in rows:
        slot_i = int(row[0] or 0)
        if not (0 <= slot_i < SLOTS_DAY):
            continue
        has_prior = any(value is not None for value in (row[1], row[5], row[2], row[3]))
        row_forecast_kwh, row_forecast_mw = _normalize_solcast_slot_pair(row[1], row[5])
        row_forecast_lo_kwh, row_forecast_lo_mw = _normalize_solcast_slot_pair(row[2], row[6])
        row_forecast_hi_kwh, row_forecast_hi_mw = _normalize_solcast_slot_pair(row[3], row[7])
        row_est_actual_kwh, row_est_actual_mw = _normalize_solcast_slot_pair(row[4], row[8])
        forecast_kwh[slot_i] = float(row_forecast_kwh or 0.0)
        forecast_mw[slot_i] = float(row_forecast_mw or 0.0)
        forecast_lo_kwh[slot_i] = float(
            forecast_kwh[slot_i] if row_forecast_lo_kwh is None else row_forecast_lo_kwh
        )
        forecast_hi_kwh[slot_i] = float(
            forecast_kwh[slot_i] if row_forecast_hi_kwh is None else row_forecast_hi_kwh
        )
        est_actual_kwh[slot_i] = float(row_est_actual_kwh or 0.0)
        forecast_lo_mw[slot_i] = float(
            forecast_mw[slot_i] if row_forecast_lo_mw is None else row_forecast_lo_mw
        )
        forecast_hi_mw[slot_i] = float(
            forecast_mw[slot_i] if row_forecast_hi_mw is None else row_forecast_hi_mw
        )
        est_actual_mw[slot_i] = float(row_est_actual_mw or 0.0)
        present[slot_i] = bool(has_prior)
        if row[9] is not None:
            pulled_ts = max(pulled_ts, int(float(row[9] or 0)))
        if row[10]:
            source = str(row[10])

    # ── Est-actual fallback for past dates with sparse forecast_kwh ──
    est_actual_backfill_count = 0
    try:
        day_date = date.fromisoformat(str(day))
        today_local = datetime.now(_TZ_UTC8).date()
        is_past = day_date < today_local
    except (ValueError, TypeError):
        is_past = False

    if is_past:
        for si in range(SLOTS_DAY):
            if (forecast_kwh[si] <= 0.0
                    and est_actual_kwh[si] > 0.0
                    and np.isfinite(est_actual_kwh[si])
                    and np.isfinite(est_actual_mw[si])):
                forecast_kwh[si] = est_actual_kwh[si]
                forecast_mw[si] = est_actual_mw[si]
                forecast_lo_kwh[si] = est_actual_kwh[si]
                forecast_hi_kwh[si] = est_actual_kwh[si]
                forecast_lo_mw[si] = est_actual_mw[si]
                forecast_hi_mw[si] = est_actual_mw[si]
                present[si] = True
                est_actual_backfill_count += 1

        if est_actual_backfill_count > 0:
            log.info(
                "Solcast snapshot %s: backfilled %d sparse forecast slots from est_actual",
                day, est_actual_backfill_count,
            )

    solar_present = present[SOLAR_START_SLOT:SOLAR_END_SLOT]
    coverage_slots = int(np.count_nonzero(solar_present))
    if coverage_slots <= 0:
        return None

    solar_forecast = np.clip(forecast_kwh[SOLAR_START_SLOT:SOLAR_END_SLOT], 0.0, None)
    solar_lo = np.clip(forecast_lo_kwh[SOLAR_START_SLOT:SOLAR_END_SLOT], 0.0, None)
    solar_hi = np.clip(forecast_hi_kwh[SOLAR_START_SLOT:SOLAR_END_SLOT], 0.0, None)
    spread_frac = np.zeros(SLOTS_DAY, dtype=float)
    with np.errstate(divide="ignore", invalid="ignore"):
        solar_spread = np.clip(
            (solar_hi - solar_lo) / np.maximum(solar_forecast, 0.05),
            0.0,
            SOLCAST_PRIOR_SPREAD_FRAC_CLIP,
        )
    spread_frac[SOLAR_START_SLOT:SOLAR_END_SLOT] = np.where(solar_present, solar_spread, 0.0)

    return {
        "day": str(day),
        "present": present,
        "forecast_kwh": forecast_kwh,
        "forecast_lo_kwh": forecast_lo_kwh,
        "forecast_hi_kwh": forecast_hi_kwh,
        "est_actual_kwh": est_actual_kwh,
        "forecast_mw": forecast_mw,
        "forecast_lo_mw": forecast_lo_mw,
        "forecast_hi_mw": forecast_hi_mw,
        "est_actual_mw": est_actual_mw,
        "spread_frac": spread_frac,
        "coverage_slots": coverage_slots,
        "coverage_ratio": float(coverage_slots / max(SOLAR_SLOTS, 1)),
        "power_unit": "mw",
        "energy_unit": "kwh_per_slot",
        "pulled_ts": int(pulled_ts),
        "source": source or "solcast",
        "est_actual_backfill_slots": est_actual_backfill_count,
    }

def _load_solcast_snapshot_uncached(day: str) -> dict | None:
    if not APP_DB_FILE.exists():
        return None

    for attempt in range(1, SQLITE_RETRY_ATTEMPTS + 1):
        try:
            with _open_sqlite(APP_DB_FILE, SQLITE_READ_TIMEOUT_SEC, readonly=True) as conn:
                conn.execute("PRAGMA query_only = ON")
                cur = conn.execute(
                    """
                    SELECT slot,
                           forecast_kwh,
                           forecast_lo_kwh,
                           forecast_hi_kwh,
                           est_actual_kwh,
                           forecast_mw,
                           forecast_lo_mw,
                           forecast_hi_mw,
                           est_actual_mw,
                           pulled_ts,
                           source
                      FROM solcast_snapshots
                     WHERE forecast_day=?
                     ORDER BY slot ASC
                    """,
                    (str(day),),
                )
                rows = cur.fetchall()
            return _finalize_snapshot_from_rows(day, rows)
        except Exception as e:
            if attempt < SQLITE_RETRY_ATTEMPTS and _is_retryable_sqlite_error(e):
                log.warning(
                    "DB Solcast snapshot load retry %d/%d [%s]: %s",
                    attempt,
                    SQLITE_RETRY_ATTEMPTS,
                    day,
                    e,
                )
                _sleep_sqlite_retry(attempt)
                continue
            log.warning("DB Solcast snapshot load failed [%s]: %s", day, e)
            return None
    return None

def _load_solcast_snapshots_range_uncached(days: list[str]) -> dict[str, dict | None]:
    """
    v2.8 efficiency audit (E1b): batch-load multiple solcast snapshots in a
    single SQLite read connection.

    Returns `{day: snapshot_or_None}` for every day in *days*. Days with no
    rows in solcast_snapshots get an explicit `None` entry so callers can
    cache the negative result without re-querying.
    """
    out: dict[str, dict | None] = {day: None for day in days}
    if not APP_DB_FILE.exists() or not days:
        return out

    # Bucket raw rows by day in one pass through the cursor.
    rows_by_day: dict[str, list] = {day: [] for day in days}
    placeholders = ",".join("?" for _ in days)
    sql = f"""
        SELECT forecast_day,
               slot,
               forecast_kwh,
               forecast_lo_kwh,
               forecast_hi_kwh,
               est_actual_kwh,
               forecast_mw,
               forecast_lo_mw,
               forecast_hi_mw,
               est_actual_mw,
               pulled_ts,
               source
          FROM solcast_snapshots
         WHERE forecast_day IN ({placeholders})
         ORDER BY forecast_day ASC, slot ASC
    """

    for attempt in range(1, SQLITE_RETRY_ATTEMPTS + 1):
        try:
            with _open_sqlite(APP_DB_FILE, SQLITE_READ_TIMEOUT_SEC, readonly=True) as conn:
                conn.execute("PRAGMA query_only = ON")
                for raw in conn.execute(sql, tuple(days)):
                    day_key = str(raw[0] or "")
                    if day_key in rows_by_day:
                        # Drop the leading forecast_day column to match the
                        # 11-tuple shape expected by _finalize_snapshot_from_rows.
                        rows_by_day[day_key].append(raw[1:])
            break
        except Exception as e:
            if attempt < SQLITE_RETRY_ATTEMPTS and _is_retryable_sqlite_error(e):
                log.warning(
                    "DB Solcast snapshot batch load retry %d/%d (%d days): %s",
                    attempt,
                    SQLITE_RETRY_ATTEMPTS,
                    len(days),
                    e,
                )
                _sleep_sqlite_retry(attempt)
                continue
            log.warning("DB Solcast snapshot batch load failed: %s", e)
            return out

    # Finalize each day. Empty buckets stay as None.
    for day in days:
        rows = rows_by_day.get(day) or []
        if rows:
            out[day] = _finalize_snapshot_from_rows(day, rows)
        # else: leave as None (already in out)

    return out

def prime_solcast_snapshot_cache(days: list[str]) -> int:
    """
    Pre-populate the cycle cache with snapshots for *days*.

    Subsequent `load_solcast_snapshot(day)` calls for any day in the list
    will be cache hits — no DB read, no connection open.

    Returns the number of days that produced a non-None snapshot. Skips
    days that are already cached so this is safe to call repeatedly.
    """
    pending = [d for d in days if _cycle_cache_get("solcast_snapshot", d) is _CYCLE_CACHE_MISS]
    if not pending:
        return 0
    batch = _load_solcast_snapshots_range_uncached(pending)
    real = 0
    for day, snap in batch.items():
        _cycle_cache_put("solcast_snapshot", day, snap)
        if snap is not None:
            real += 1
    return real

def build_solcast_reliability_artifact(today: date) -> dict | None:
    records = []
    resolution_days: list[dict] = []
    resolution_overall_solcast: list[dict] = []
    resolution_overall_dayahead: list[dict] = []
    resolution_regime_solcast: dict[str, list[dict]] = {}
    resolution_regime_dayahead: dict[str, list[dict]] = {}
    resolution_bucket_solcast: dict[str, list[dict]] = {}
    resolution_bucket_dayahead: dict[str, list[dict]] = {}
    resolution_pair_solcast: dict[tuple[str, str], list[dict]] = {}
    resolution_pair_dayahead: dict[tuple[str, str], list[dict]] = {}
    by_season: dict[str, list[dict]] = {}
    by_season_regime: dict[str, list[dict]] = {}
    tod_accum: dict[str, list[dict]] = {}
    tod_regime_accum: dict[tuple, list[dict]] = {}
    lookback = max(SOLCAST_RELIABILITY_LOOKBACK_DAYS, N_TRAIN_DAYS)

    # v2.8 efficiency audit (E1b/P3): batch-load all lookback snapshots in
    # a single SQLite query and prime the per-cycle cache. Subsequent
    # load_solcast_snapshot() calls in this loop — and in collect_history_days
    # which replays the same date window — become O(dict) cache hits.
    _prime_days = [(today - timedelta(days=d)).isoformat() for d in range(1, lookback + 1)]
    try:
        prime_solcast_snapshot_cache(_prime_days)
    except Exception as prime_err:
        log.debug("prime_solcast_snapshot_cache failed (non-fatal): %s", prime_err)

    for days_ago in range(1, lookback + 1):
        day = (today - timedelta(days=days_ago)).isoformat()
        # E5 priority chain: metered substation → loss-adjusted inverter → Solcast est_actual
        actual, actual_present, _ = resolve_actual_5min_for_date(day)
        snapshot = load_solcast_snapshot(day)
        dayahead, dayahead_present = load_dayahead_with_presence(day)
        if not np.any(actual_present):
            continue
        wdata = fetch_weather(day, source="archive")
        if wdata is None:
            continue
        w5 = interpolate_5min(wdata, day)
        stats = analyse_weather_day(day, w5, actual)
        regime = classify_day_regime(stats)
        season = _season_bucket_from_day(day)
        bucket_labels = classify_slot_weather_buckets(w5, day)
        _, constraint_meta = build_operational_constraint_mask(day)
        # Use 1000H alarm-based outage mask instead of stale audit_log operational_mask
        inverter_outage = _build_1000h_inverter_outage_mask(day)
        cap_dispatch = np.asarray(constraint_meta.get("cap_dispatch_mask"), dtype=bool)
        exclude_mask = inverter_outage | cap_dispatch
        # Build export-curtailed exclusion using actual generation and Solcast forecast as baseline proxy
        try:
            _actual_f = np.asarray(actual, dtype=float)
            _prior_f = np.asarray(np.clip(np.asarray(snapshot["forecast_kwh"], dtype=float), 0.0, None), dtype=float) if snapshot else np.zeros(SLOTS_DAY, dtype=float)
            _curtailed = curtailed_mask(_actual_f, _prior_f)
            exclude_mask = exclude_mask | _curtailed
        except Exception as _curt_err:
            log.debug("curtailed_mask failed for %s (non-fatal): %s", day, _curt_err)
        solcast_metrics = None
        solcast_bucket_metrics: dict[str, dict] = {}
        if snapshot:
            present = np.asarray(snapshot["present"], dtype=bool)
            mask = (
                present
                & (np.arange(SLOTS_DAY) >= SOLAR_START_SLOT)
                & (np.arange(SLOTS_DAY) < SOLAR_END_SLOT)
                & (np.asarray(snapshot["forecast_kwh"], dtype=float) > 0.0)
                & (~exclude_mask)
            )
            usable = int(np.count_nonzero(mask))
            if usable >= SOLCAST_MIN_USABLE_SLOTS:
                prior = np.clip(np.asarray(snapshot["forecast_kwh"], dtype=float)[mask], 0.0, None)
                actual_slots = np.clip(np.asarray(actual, dtype=float)[mask], 0.0, None)
                spread = np.asarray(snapshot["spread_frac"], dtype=float)[mask]
                if np.any(prior > 0):
                    ratio = float(np.clip(actual_slots.sum() / max(prior.sum(), 1.0), *SOLCAST_BIAS_RATIO_CLIP))
                    mape = float(np.mean(np.abs(actual_slots - prior) / np.maximum(actual_slots, 1.0)))
                    records.append({
                        "day": day,
                        "regime": regime,
                        "coverage_ratio": float(snapshot.get("coverage_ratio", 0.0)),
                        "bias_ratio": ratio,
                        "mape": mape,
                        "spread_mean": float(np.mean(spread)) if spread.size else 0.0,
                    })
                    solcast_forecast = np.clip(np.asarray(snapshot["forecast_kwh"], dtype=float), 0.0, None)
                    solcast_metrics = compute_forecast_metrics(
                        actual,
                        solcast_forecast,
                        actual_present=actual_present,
                        forecast_present=present,
                        exclude_mask=exclude_mask,
                    )
                    solcast_bucket_metrics = compute_bucketed_forecast_metrics(
                        actual,
                        solcast_forecast,
                        bucket_labels,
                        actual_present=actual_present,
                        forecast_present=present,
                        exclude_mask=exclude_mask,
                    )
                    # Seasonal accumulation
                    record_copy = dict(records[-1])
                    by_season.setdefault(season, []).append(record_copy)
                    by_season_regime.setdefault(f"{season}:{regime}", []).append(record_copy)
                    # Time-of-day accumulation
                    tod_metrics = _compute_tod_slot_metrics(
                        actual,
                        np.clip(np.asarray(snapshot["forecast_kwh"], dtype=float), 0.0, None),
                        actual_present,
                        exclude_mask=exclude_mask,
                    )
                    for _tz, _tz_m in tod_metrics.items():
                        tod_accum.setdefault(_tz, []).append(_tz_m)
                        tod_regime_accum.setdefault((regime, _tz), []).append(_tz_m)
        dayahead_metrics = (
            compute_forecast_metrics(
                actual,
                dayahead,
                actual_present=actual_present,
                forecast_present=dayahead_present,
                exclude_mask=exclude_mask,
            )
            if dayahead is not None and dayahead_present is not None
            else None
        )
        dayahead_bucket_metrics = (
            compute_bucketed_forecast_metrics(
                actual,
                dayahead,
                bucket_labels,
                actual_present=actual_present,
                forecast_present=dayahead_present,
                exclude_mask=exclude_mask,
            )
            if dayahead is not None and dayahead_present is not None
            else {}
        )
        daily_record = _build_resolution_daily_record(
            day,
            regime,
            solcast_metrics,
            dayahead_metrics,
            solcast_bucket_metrics,
            dayahead_bucket_metrics,
        )
        overall_profile = daily_record.get("overall") if isinstance(daily_record.get("overall"), dict) else {}
        if overall_profile.get("solcast") or overall_profile.get("dayahead"):
            resolution_days.append(daily_record)
        if overall_profile.get("solcast"):
            resolution_overall_solcast.append(dict(overall_profile["solcast"]))
            resolution_regime_solcast.setdefault(regime, []).append(dict(overall_profile["solcast"]))
        if overall_profile.get("dayahead"):
            resolution_overall_dayahead.append(dict(overall_profile["dayahead"]))
            resolution_regime_dayahead.setdefault(regime, []).append(dict(overall_profile["dayahead"]))
        for bucket, profile in (daily_record.get("buckets") or {}).items():
            if not isinstance(profile, dict):
                continue
            if profile.get("solcast"):
                resolution_bucket_solcast.setdefault(bucket, []).append(dict(profile["solcast"]))
                resolution_pair_solcast.setdefault((regime, bucket), []).append(dict(profile["solcast"]))
            if profile.get("dayahead"):
                resolution_bucket_dayahead.setdefault(bucket, []).append(dict(profile["dayahead"]))
                resolution_pair_dayahead.setdefault((regime, bucket), []).append(dict(profile["dayahead"]))

    if len(records) < SOLCAST_RELIABILITY_MIN_DAYS:
        log.warning("Solcast reliability artifact build failed: only %d usable days (min %d) - callers will use defaults", len(records), SOLCAST_RELIABILITY_MIN_DAYS)
        return None

    def aggregate(rows: list[dict]) -> dict:
        mape = float(np.mean([row["mape"] for row in rows]))
        bias_ratio = float(np.clip(np.mean([row["bias_ratio"] for row in rows]), *SOLCAST_BIAS_RATIO_CLIP))
        coverage_ratio = float(np.mean([row["coverage_ratio"] for row in rows]))
        spread_mean = float(np.mean([row["spread_mean"] for row in rows]))
        reliability = float(np.clip(1.0 - min(0.55, mape) / 0.55, 0.25, 1.0))
        return {
            "day_count": int(len(rows)),
            "mean_mape": mape,
            "bias_ratio": bias_ratio,
            "coverage_ratio": coverage_ratio,
            "spread_mean": spread_mean,
            "reliability": reliability,
        }

    by_regime: dict[str, list[dict]] = {}
    for row in records:
        by_regime.setdefault(str(row["regime"]), []).append(row)

    # Seasonal aggregation
    seasons_out = {s: aggregate(rows) for s, rows in by_season.items() if len(rows) >= SOLCAST_RELIABILITY_MIN_DAYS}
    season_regimes_out = {}
    for k, rows in by_season_regime.items():
        if len(rows) >= 5:
            season_regimes_out[k] = aggregate(rows)
        else:
            log.debug("Season-regime combination %s excluded: only %d days (min 5)", k, len(rows))

    # Time-of-day aggregation
    time_of_day_out: dict[str, dict] = {}
    for _zone, _entries in tod_accum.items():
        _total_slots = sum(e["slot_count"] for e in _entries)
        _zone_days = len(_entries)
        if _total_slots < 20 or _zone_days < 5:
            if _zone_days < 5:
                log.debug("ToD zone %s excluded: only %d days (min 5)", _zone, _zone_days)
            continue
        _wmape = sum(e["mape"] * e["slot_count"] for e in _entries) / _total_slots
        _wbias = sum(e["bias_ratio"] * e["slot_count"] for e in _entries) / _total_slots
        time_of_day_out[_zone] = {
            "bias_ratio": float(np.clip(_wbias, *SOLCAST_BIAS_RATIO_CLIP)),
            "mape": float(_wmape),
            "reliability": float(1.0 - min(_wmape, 0.55) / 0.55),
            "slot_count": int(_total_slots),
            "day_count": int(_zone_days),
        }
    time_of_day_by_regime_out: dict[str, dict] = {}
    for (_r, _z), _entries in tod_regime_accum.items():
        _total_slots = sum(e["slot_count"] for e in _entries)
        _zone_days = len(_entries)
        if _total_slots < 20 or _zone_days < 5:
            if _zone_days < 5:
                log.debug("ToD zone %s (regime %s) excluded: only %d days (min 5)", _z, _r, _zone_days)
            continue
        _wmape = sum(e["mape"] * e["slot_count"] for e in _entries) / _total_slots
        _wbias = sum(e["bias_ratio"] * e["slot_count"] for e in _entries) / _total_slots
        time_of_day_by_regime_out.setdefault(_r, {})[_z] = {
            "bias_ratio": float(np.clip(_wbias, *SOLCAST_BIAS_RATIO_CLIP)),
            "mape": float(_wmape),
            "reliability": float(1.0 - min(_wmape, 0.55) / 0.55),
            "slot_count": int(_total_slots),
            "day_count": int(_zone_days),
        }

    # Trend detection
    trend_out = _compute_solcast_trend(records)

    return {
        "created_ts": int(time.time()),
        "day_count": int(len(records)),
        "overall": aggregate(records),
        "regimes": {
            regime: aggregate(rows)
            for regime, rows in sorted(by_regime.items())
            if rows
        },
        "seasons": seasons_out,
        "season_regimes": season_regimes_out,
        "time_of_day": time_of_day_out,
        "time_of_day_by_regime": time_of_day_by_regime_out,
        "trend": trend_out,
        "resolution_profiles": {
            "created_ts": int(time.time()),
            "day_count": int(len(resolution_days)),
            "resolution_minutes": int(SLOT_MIN),
            "source_power_unit": "mw",
            "energy_unit": "kwh_per_slot",
            "actual_basis": "loss_adjusted_actual",
            "days": resolution_days,
            "overall": _build_resolution_profile(
                resolution_overall_solcast,
                resolution_overall_dayahead,
            ),
            "regimes": {
                regime: _build_resolution_profile(
                    resolution_regime_solcast.get(regime),
                    resolution_regime_dayahead.get(regime),
                )
                for regime in sorted(set(resolution_regime_solcast.keys()) | set(resolution_regime_dayahead.keys()))
            },
            "buckets": {
                bucket: _build_resolution_profile(
                    resolution_bucket_solcast.get(bucket),
                    resolution_bucket_dayahead.get(bucket),
                )
                for bucket in sorted(set(resolution_bucket_solcast.keys()) | set(resolution_bucket_dayahead.keys()))
            },
            "pairs": {
                f"{regime}:{bucket}": _build_resolution_profile(
                    resolution_pair_solcast.get((regime, bucket)),
                    resolution_pair_dayahead.get((regime, bucket)),
                )
                for regime, bucket in sorted(set(resolution_pair_solcast.keys()) | set(resolution_pair_dayahead.keys()))
            },
        },
    }

def save_solcast_reliability_artifact(artifact: dict | None) -> bool:
    if artifact is None:
        try:
            if SOLCAST_RELIABILITY_FILE.exists():
                SOLCAST_RELIABILITY_FILE.unlink()
        except Exception:
            return False
        return True
    try:
        SOLCAST_RELIABILITY_FILE.parent.mkdir(parents=True, exist_ok=True)
        dump(artifact, SOLCAST_RELIABILITY_FILE)
        return True
    except Exception as e:
        log.error("Solcast reliability save failed %s: %s", SOLCAST_RELIABILITY_FILE, e)
        return False

def load_solcast_reliability_artifact(today: date | None = None, allow_build: bool = False) -> dict | None:
    if SOLCAST_RELIABILITY_FILE.exists():
        try:
            data = load(SOLCAST_RELIABILITY_FILE)
            if isinstance(data, dict):
                return data
        except Exception as e:
            log.warning("Solcast reliability load failed %s: %s", SOLCAST_RELIABILITY_FILE, e)
    if allow_build and today is not None:
        artifact = build_solcast_reliability_artifact(today)
        if artifact:
            save_solcast_reliability_artifact(artifact)
        return artifact
    return None

def _metric_reliability_from_mape_pct(mape_pct: float) -> float:
    mape_frac = max(float(mape_pct or 0.0), 0.0) / 100.0
    return float(np.clip(1.0 - min(0.55, mape_frac) / 0.55, 0.25, 1.0))

def _forecast_metric_summary(metrics: dict | None) -> dict | None:
    if not metrics or int(metrics.get("usable_slot_count", 0)) <= 0:
        return None
    usable = int(metrics.get("usable_slot_count", 0))
    rmse = float(metrics.get("rmse_kwh", 0.0))
    return {
        "usable_slot_count": usable,
        "actual_total_kwh": float(metrics.get("actual_total_kwh", 0.0)),
        "forecast_total_kwh": float(metrics.get("forecast_total_kwh", 0.0)),
        "abs_error_sum_kwh": float(metrics.get("abs_error_sum_kwh", 0.0)),
        "mae_kwh": float(metrics.get("mae_kwh", 0.0)),
        "mbe_kwh": float(metrics.get("mbe_kwh", 0.0)),
        "rmse_kwh": rmse,
        "mape_pct": float(metrics.get("mape_pct", 0.0)),
        "wape_pct": float(metrics.get("wape_pct", 0.0)),
        "total_ape_pct": float(metrics.get("total_ape_pct", 0.0)),
        "sse_kwh2": float((rmse ** 2) * usable),
        "reliability": _metric_reliability_from_mape_pct(float(metrics.get("mape_pct", 0.0))),
    }

def _aggregate_forecast_metric_rows(rows: list[dict] | None) -> dict | None:
    valid = [
        dict(row)
        for row in (rows or [])
        if isinstance(row, dict) and int(row.get("usable_slot_count", 0)) > 0
    ]
    if not valid:
        return None
    usable_total = int(sum(int(row.get("usable_slot_count", 0)) for row in valid))
    actual_total = float(sum(float(row.get("actual_total_kwh", 0.0)) for row in valid))
    forecast_total = float(sum(float(row.get("forecast_total_kwh", 0.0)) for row in valid))
    abs_error_sum = float(sum(float(row.get("abs_error_sum_kwh", 0.0)) for row in valid))
    sse = float(sum(float(row.get("sse_kwh2", 0.0)) for row in valid))
    mae = float(
        np.average(
            [float(row.get("mae_kwh", 0.0)) for row in valid],
            weights=[max(int(row.get("usable_slot_count", 0)), 1) for row in valid],
        )
    )
    mbe = float(
        np.average(
            [float(row.get("mbe_kwh", 0.0)) for row in valid],
            weights=[max(int(row.get("usable_slot_count", 0)), 1) for row in valid],
        )
    )
    mape = float(
        np.average(
            [float(row.get("mape_pct", 0.0)) for row in valid],
            weights=[max(int(row.get("usable_slot_count", 0)), 1) for row in valid],
        )
    )
    total_ape = float(
        np.average(
            [float(row.get("total_ape_pct", 0.0)) for row in valid],
            weights=[max(float(row.get("actual_total_kwh", 0.0)), 1.0) for row in valid],
        )
    )
    return {
        "day_count": int(len(valid)),
        "usable_slot_count": usable_total,
        "actual_total_kwh": actual_total,
        "forecast_total_kwh": forecast_total,
        "abs_error_sum_kwh": abs_error_sum,
        "mae_kwh": mae,
        "mbe_kwh": mbe,
        "rmse_kwh": float(np.sqrt(sse / max(usable_total, 1))),
        "mape_pct": mape,
        "wape_pct": float((abs_error_sum / max(actual_total, 1.0)) * 100.0),
        "total_ape_pct": total_ape,
        "reliability": _metric_reliability_from_mape_pct(mape),
    }

def _build_resolution_profile(solcast_rows: list[dict] | None, dayahead_rows: list[dict] | None) -> dict:
    solcast_stats = _aggregate_forecast_metric_rows(solcast_rows)
    dayahead_stats = _aggregate_forecast_metric_rows(dayahead_rows)
    common_days = int(
        min(
            int((solcast_stats or {}).get("day_count", 0)),
            int((dayahead_stats or {}).get("day_count", 0)),
        )
    ) if solcast_stats and dayahead_stats else 0
    solcast_weight = SOLCAST_RESOLUTION_WEIGHT_FALLBACK
    preferred_source = "blend"
    wape_gap = None
    if solcast_stats and dayahead_stats:
        solcast_wape = max(float(solcast_stats.get("wape_pct", 0.0)), 0.0)
        dayahead_wape = max(float(dayahead_stats.get("wape_pct", 0.0)), 0.0)
        if solcast_wape > 0.0 or dayahead_wape > 0.0:
            solcast_weight = float(
                np.clip(
                    dayahead_wape / max(solcast_wape + dayahead_wape, 1e-6),
                    0.0,
                    1.0,
                )
            )
        wape_gap = float(dayahead_wape - solcast_wape)
        if solcast_weight >= 0.55:
            preferred_source = "solcast"
        elif solcast_weight <= 0.45:
            preferred_source = "dayahead"
    return {
        "solcast": solcast_stats,
        "dayahead": dayahead_stats,
        "solcast_weight": float(solcast_weight),
        "preferred_source": preferred_source,
        "support_days": common_days,
        "wape_gap_pct": wape_gap,
    }

def _build_resolution_daily_record(
    day: str,
    regime: str,
    solcast_metrics: dict | None,
    dayahead_metrics: dict | None,
    solcast_bucket_metrics: dict[str, dict] | None,
    dayahead_bucket_metrics: dict[str, dict] | None,
) -> dict:
    solcast_summary = _forecast_metric_summary(solcast_metrics)
    dayahead_summary = _forecast_metric_summary(dayahead_metrics)
    bucket_profiles: dict[str, dict] = {}
    bucket_names = sorted(
        set((solcast_bucket_metrics or {}).keys()) | set((dayahead_bucket_metrics or {}).keys())
    )
    for bucket in bucket_names:
        profile = _build_resolution_profile(
            [_forecast_metric_summary((solcast_bucket_metrics or {}).get(bucket))]
            if (solcast_bucket_metrics or {}).get(bucket)
            else [],
            [_forecast_metric_summary((dayahead_bucket_metrics or {}).get(bucket))]
            if (dayahead_bucket_metrics or {}).get(bucket)
            else [],
        )
        if profile.get("solcast") or profile.get("dayahead"):
            bucket_profiles[str(bucket)] = profile
    return {
        "day": str(day),
        "day_regime": str(regime or ""),
        "resolution_minutes": int(SLOT_MIN),
        "source_power_unit": "mw",
        "energy_unit": "kwh_per_slot",
        "actual_basis": "loss_adjusted_actual",
        "overall": _build_resolution_profile(
            [solcast_summary] if solcast_summary else [],
            [dayahead_summary] if dayahead_summary else [],
        ),
        "buckets": bucket_profiles,
    }

def lookup_solcast_resolution_profile(
    artifact: dict | None,
    regime: str,
    bucket: str | None = None,
) -> dict:
    fallback = {
        "solcast_weight": SOLCAST_RESOLUTION_WEIGHT_FALLBACK,
        "preferred_source": "blend",
        "support_days": 0,
        "wape_gap_pct": None,
        "profile_key": "fallback",
    }
    if not artifact or not isinstance(artifact, dict):
        return fallback
    profiles = artifact.get("resolution_profiles")
    if not isinstance(profiles, dict):
        return fallback
    pair_key = f"{str(regime or '')}:{str(bucket or '')}"
    pairs = profiles.get("pairs") if isinstance(profiles.get("pairs"), dict) else {}
    if bucket and pair_key in pairs and isinstance(pairs[pair_key], dict):
        out = dict(fallback)
        out.update(pairs[pair_key])
        out["profile_key"] = pair_key
        return out
    buckets = profiles.get("buckets") if isinstance(profiles.get("buckets"), dict) else {}
    if bucket and str(bucket) in buckets and isinstance(buckets[str(bucket)], dict):
        out = dict(fallback)
        out.update(buckets[str(bucket)])
        out["profile_key"] = str(bucket)
        return out
    regimes = profiles.get("regimes") if isinstance(profiles.get("regimes"), dict) else {}
    if regime in regimes and isinstance(regimes[regime], dict):
        out = dict(fallback)
        out.update(regimes[regime])
        out["profile_key"] = str(regime)
        return out
    overall = profiles.get("overall") if isinstance(profiles.get("overall"), dict) else {}
    out = dict(fallback)
    out.update(overall)
    out["profile_key"] = "overall"
    return out

def lookup_solcast_resolution_weight_vector(
    artifact: dict | None,
    regime: str,
    bucket_labels: np.ndarray | list[str] | None,
) -> tuple[np.ndarray, np.ndarray]:
    weights = np.full(SLOTS_DAY, SOLCAST_RESOLUTION_WEIGHT_FALLBACK, dtype=float)
    support = np.zeros(SLOTS_DAY, dtype=float)
    if bucket_labels is None:
        return weights, support
    labels = np.asarray(bucket_labels, dtype=object).reshape(-1)
    if labels.size < SLOTS_DAY:
        return weights, support
    support_norm = float(max(max(SOLCAST_RELIABILITY_LOOKBACK_DAYS, N_TRAIN_DAYS), 1))
    for bucket in sorted({
        str(label)
        for label in labels[:SLOTS_DAY]
        if str(label) and str(label) != "offsolar"
    }):
        profile = lookup_solcast_resolution_profile(artifact, regime, bucket)
        mask = labels[:SLOTS_DAY] == bucket
        weights[mask] = float(
            np.clip(
                profile.get("solcast_weight", SOLCAST_RESOLUTION_WEIGHT_FALLBACK),
                0.0,
                1.0,
            )
        )
        support[mask] = float(
            np.clip(float(profile.get("support_days", 0)) / support_norm, 0.0, 1.0)
        )
    return weights, support

def lookup_solcast_reliability(artifact: dict | None, regime: str, season: str | None = None) -> dict:
    _MIN_RELIABILITY_SAMPLES = 10  # FIX-18: Minimum day_count to trust regime-specific corrections
    _MIN_RELIABILITY_SAMPLES_ADVERSE = 5  # Rainy/overcast occur less frequently — lower threshold
    # T4.6 fix (Phase 7, 2026-04-14): when the artifact is present but a
    # specific dimension key (regimes / seasons / season_regimes) is absent,
    # the function silently returned the overall fallback without any log
    # signal — the operator could not tell whether the artifact was rich or
    # structurally degraded.  We now emit a one-time INFO per missing
    # dimension-per-process so repeated lookups don't spam the log.
    fallback = {
        "day_count": 0,
        "mean_mape": 0.24,
        "bias_ratio": 1.0,
        "coverage_ratio": 0.0,
        "spread_mean": 0.0,
        "reliability": 0.62,
    }
    if not artifact or not isinstance(artifact, dict):
        log.warning("Solcast reliability artifact unavailable - using hardcoded defaults (reliability=0.62, bias_ratio=1.0). Forecast quality may be degraded.")
        return fallback
    # Detect missing dimensions once (guard `_reliability_fallback_notified`
    # is initialised at module scope — Phase 8 code-review fix).
    for dim in ("regimes", "seasons", "season_regimes", "time_of_day"):
        if dim not in artifact and dim not in _reliability_fallback_notified:
            log.info(
                "Solcast reliability artifact missing dimension '%s' — lookups will fall through to overall/fallback. "
                "This is expected for older artifacts pre-v2.4.33; regenerate via build_solcast_reliability_artifact().",
                dim,
            )
            _reliability_fallback_notified.add(dim)
    # Season+regime cross-lookup (most specific)
    if season:
        key = f"{season}:{regime}"
        season_regimes = artifact.get("season_regimes") or {}
        if key in season_regimes and isinstance(season_regimes[key], dict):
            cell = season_regimes[key]
            # FIX-18: Skip low-sample cells (lower threshold for rainy/overcast)
            _min_samples = _MIN_RELIABILITY_SAMPLES_ADVERSE if regime in ("rainy", "overcast") else _MIN_RELIABILITY_SAMPLES
            if int(cell.get("day_count", 0)) < _min_samples:
                log.debug("Reliability cell '%s' has only %d samples (min %d) — falling through", key, int(cell.get("day_count", 0)), _min_samples)
            else:
                out = dict(fallback)
                out.update(cell)
                return out
    # Regime-only lookup
    regimes = artifact.get("regimes") or {}
    if regime in regimes and isinstance(regimes[regime], dict):
        cell = regimes[regime]
        # FIX-18: Skip low-sample cells (lower threshold for rainy/overcast)
        _min_samples = _MIN_RELIABILITY_SAMPLES_ADVERSE if regime in ("rainy", "overcast") else _MIN_RELIABILITY_SAMPLES
        if int(cell.get("day_count", 0)) < _min_samples:
            log.debug("Reliability cell '%s' has only %d samples (min %d) — falling through to overall", regime, int(cell.get("day_count", 0)), _min_samples)
        else:
            out = dict(fallback)
            out.update(cell)
            return out
    # Season-only fallback
    if season:
        seasons = artifact.get("seasons") or {}
        if season in seasons and isinstance(seasons[season], dict):
            out = dict(fallback)
            out.update(seasons[season])
            return out
    # Overall fallback
    overall = artifact.get("overall") if isinstance(artifact.get("overall"), dict) else {}
    out = dict(fallback)
    out.update(overall)
    return out

def solcast_prior_from_snapshot(
    day: str,
    w5: pd.DataFrame,
    snapshot: dict | None,
    reliability_artifact: dict | None = None,
) -> dict | None:
    if not snapshot or int(snapshot.get("coverage_slots", 0)) < SOLCAST_MIN_USABLE_SLOTS:
        return None

    stats = analyse_weather_day(day, w5)
    regime = classify_day_regime(stats)
    season = _season_bucket_from_day(day)
    reliability = lookup_solcast_reliability(reliability_artifact, regime, season=season)
    bucket_labels = classify_slot_weather_buckets(w5, day)
    resolution_weight, resolution_support = lookup_solcast_resolution_weight_vector(
        reliability_artifact,
        regime,
        bucket_labels,
    )

    prior_kwh = np.clip(np.asarray(snapshot["forecast_kwh"], dtype=float), 0.0, None).copy()
    prior_lo = np.clip(np.asarray(snapshot["forecast_lo_kwh"], dtype=float), 0.0, None).copy()
    prior_hi = np.clip(np.asarray(snapshot["forecast_hi_kwh"], dtype=float), 0.0, None).copy()
    prior_mw = np.clip(np.asarray(snapshot["forecast_mw"], dtype=float), 0.0, None).copy()
    spread_frac = np.clip(np.asarray(snapshot["spread_frac"], dtype=float), 0.0, SOLCAST_PRIOR_SPREAD_FRAC_CLIP)
    present = np.asarray(snapshot["present"], dtype=bool).copy()

    # CRITICAL: Validate array sizes to prevent silent data corruption
    for array_name, array_obj in [
        ("prior_kwh", prior_kwh),
        ("prior_lo", prior_lo),
        ("prior_hi", prior_hi),
        ("prior_mw", prior_mw),
        ("spread_frac", spread_frac),
        ("present", present),
    ]:
        if array_obj.size != SLOTS_DAY:
            log.error(
                "Solcast snapshot array size mismatch for %s (%s): got %d slots, expected %d — rejecting snapshot",
                day, array_name, array_obj.size, SLOTS_DAY,
            )
            return None

    bias_ratio = float(np.clip(reliability.get("bias_ratio", 1.0), *SOLCAST_BIAS_RATIO_CLIP))
    reliability_score = float(np.clip(reliability.get("reliability", 0.62), 0.25, 1.0))
    coverage_ratio = float(np.clip(snapshot.get("coverage_ratio", 0.0), 0.0, 1.0))

    prior_kwh *= bias_ratio
    prior_lo *= bias_ratio
    prior_hi *= bias_ratio
    prior_mw *= bias_ratio

    # Enforce P10 <= forecast <= P90 ordering constraint
    violated = int(np.sum((prior_lo > prior_kwh) | (prior_hi < prior_kwh)))
    if violated > 0:
        log.warning(
            "Solcast P10/P90 ordering violated in %d slots for %s — clamping",
            violated, day,
        )
    prior_lo = np.minimum(prior_lo, prior_kwh)
    prior_hi = np.maximum(prior_hi, prior_kwh)

    prior_kwh[:SOLAR_START_SLOT] = 0.0
    prior_kwh[SOLAR_END_SLOT:] = 0.0

    idx = np.arange(SLOTS_DAY)
    solar_rel = (idx - SOLAR_START_SLOT) / max(SOLAR_SLOTS - 1, 1)
    solar_rel = np.clip(solar_rel, 0.0, 1.0)
    solar_weight = 0.58 + 0.42 * np.sin(np.pi * solar_rel)
    solar_weight = np.clip(solar_weight, 0.45, 1.0)
    # Trend lookup for primary mode check
    trend_info = lookup_solcast_trend(reliability_artifact)
    _trend_signal = str(trend_info.get("signal", "stable"))

    base_by_regime = {
        "clear": 0.54,
        "mixed": 0.50,
        "overcast": 0.56,
        "rainy": 0.44,
    }.get(regime, 0.46)
    if regime == "clear":
        clear_rel = np.clip((reliability_score - 0.60) / 0.30, 0.0, 1.0)
        clear_cov = np.clip((coverage_ratio - 0.72) / 0.28, 0.0, 1.0)
        base_by_regime = max(base_by_regime, 0.58 + 0.16 * clear_rel + 0.08 * clear_cov)
    primary_mode = bool(
        coverage_ratio >= SOLCAST_PRIMARY_COVERAGE_MIN
        and reliability_score >= SOLCAST_PRIMARY_RELIABILITY_MIN
    )
    # Check trend signal before activating primary mode
    if primary_mode and _trend_signal == "degrading":
        log.info("Solcast primary mode suppressed: trend signal is degrading")
        primary_mode = False
    # Solcast-primary: when coverage is high and reliability is reasonable,
    # elevate base blend so Solcast becomes the primary forecast baseline.
    if primary_mode:
        base_by_regime = max(base_by_regime, 0.82)
        log.info(
            "Solcast-primary mode activated: coverage=%.2f reliability=%.2f base_blend=%.2f",
            coverage_ratio, reliability_score, base_by_regime,
        )
    spread_weight = 1.0 - 0.42 * np.clip(spread_frac / max(SOLCAST_PRIOR_SPREAD_FRAC_CLIP, 0.1), 0.0, 1.0)
    blend = base_by_regime * reliability_score * (0.55 + 0.45 * coverage_ratio) * spread_weight * solar_weight

    # Per-slot weather-bucket blend modulation (Phase 1.1)
    _bucket_multiplier = np.ones(SLOTS_DAY, dtype=float)
    _bucket_map = {
        "clear_stable": 1.12,
        "clear_edge": 1.08,
        "mixed_stable": 1.00,
        "mixed_volatile": 0.88,
        "overcast": 0.78,
        "rainy": 0.65,
    }
    for _bname, _bmul in _bucket_map.items():
        _bucket_multiplier[bucket_labels == _bname] = _bmul
    blend = blend * _bucket_multiplier

    resolution_scale = (
        SOLCAST_RESOLUTION_BLEND_SCALE_MIN
        + (SOLCAST_RESOLUTION_BLEND_SCALE_MAX - SOLCAST_RESOLUTION_BLEND_SCALE_MIN) * resolution_weight
    )
    blend = blend * resolution_scale
    if primary_mode:
        rel_norm = np.clip(
            (reliability_score - SOLCAST_PRIMARY_RELIABILITY_MIN)
            / max(1.0 - SOLCAST_PRIMARY_RELIABILITY_MIN, 1e-6),
            0.0,
            1.0,
        )
        cov_norm = np.clip(
            (coverage_ratio - SOLCAST_PRIMARY_COVERAGE_MIN)
            / max(1.0 - SOLCAST_PRIMARY_COVERAGE_MIN, 1e-6),
            0.0,
            1.0,
        )
        primary_floor = (
            SOLCAST_PRIMARY_BLEND_FLOOR_MIN
            + 0.08 * rel_norm
            + 0.06 * cov_norm
        )
        primary_floor = np.clip(
            primary_floor * (0.92 + 0.08 * spread_weight) * (0.96 + 0.04 * solar_weight),
            SOLCAST_PRIMARY_BLEND_FLOOR_MIN,
            SOLCAST_PRIMARY_BLEND_FLOOR_MAX,
        )
        primary_floor = primary_floor * (
            SOLCAST_RESOLUTION_PRIMARY_SCALE_MIN
            + (SOLCAST_RESOLUTION_PRIMARY_SCALE_MAX - SOLCAST_RESOLUTION_PRIMARY_SCALE_MIN) * resolution_weight
        )
        blend = np.maximum(blend, primary_floor)

    # Time-of-day reliability modulation
    _overall_rel = float(np.clip(reliability.get("reliability", 0.62), 0.25, 1.0))
    if reliability_artifact and reliability_artifact.get("time_of_day"):
        for _zone, (_zs, _ze) in TOD_ZONES.items():
            tod_info = lookup_solcast_tod_reliability(reliability_artifact, regime, _zone)
            zone_rel = float(np.clip(tod_info.get("reliability", _overall_rel), 0.25, 1.0))
            tod_factor = float(np.clip(zone_rel / max(_overall_rel, 0.30), TOD_RELIABILITY_WEIGHT_MIN, TOD_RELIABILITY_WEIGHT_MAX))
            blend[_zs:_ze] *= tod_factor

    # Trend adjustment
    _trend_mag = float(trend_info.get("magnitude", 0.0))
    if _trend_signal == "improving":
        blend *= (1.0 + min(abs(_trend_mag), SOLCAST_TREND_BOOST_MAX))
    elif _trend_signal == "degrading":
        blend *= (1.0 - min(abs(_trend_mag), SOLCAST_TREND_PENALTY_MAX))

    blend = np.clip(blend, SOLCAST_PRIOR_BLEND_MIN, SOLCAST_PRIOR_BLEND_MAX)
    blend[~present] = 0.0
    blend[:SOLAR_START_SLOT] = 0.0
    blend[SOLAR_END_SLOT:] = 0.0

    # Scalar confidence from spread: mean spread_weight over solar slots where Solcast is present
    _solar_present_mask = present[SOLAR_START_SLOT:SOLAR_END_SLOT]
    _solar_sw = np.asarray(spread_weight, dtype=float)[SOLAR_START_SLOT:SOLAR_END_SLOT]
    _sc_spread_conf = float(np.clip(np.mean(_solar_sw[_solar_present_mask]), 0.50, 1.00)) if np.any(_solar_present_mask) else 0.70

    # NEW: Detect if tri-band data is present
    has_triband = bool(
        np.any(prior_lo < prior_kwh - 0.01)
        and np.any(prior_hi > prior_kwh + 0.01)
    )

    # T4.1 / T4.2 fix: Solcast P10/P90 confidence bands are only meaningful
    # for true day-ahead (future) slots.  Past-date snapshots often contain
    # estimated-actuals where lo==forecast==hi (zero-spread) — feeding those
    # into training as if they were real tri-band inputs distorts the learned
    # distribution.  We expose:
    #   * is_past_date           — day already completed
    #   * has_real_triband       — stricter flag gating feature construction
    #   * triband_data_quality_flag — audit label for training-time filtering
    try:
        from datetime import date as _date_cls
        _today_iso = _date_cls.today().isoformat()
    except Exception:
        _today_iso = day
    is_past_date = bool(day < _today_iso) if isinstance(day, str) else False
    has_real_triband = bool(has_triband and not is_past_date)
    if has_real_triband:
        triband_data_quality_flag = "real"
    elif is_past_date:
        triband_data_quality_flag = "past_date"
    elif has_triband:
        # Live day but bands numerically present — treat as real.
        triband_data_quality_flag = "real"
    else:
        triband_data_quality_flag = "zero_spread"

    # Step 12 (v2.8): Locked day-ahead snapshot enrichment. Read the frozen
    # 10 AM snapshot for this day (if any) and expose per-slot spread_pct_cap
    # plus captured_ts, so build_features can populate the two new ML features
    # (spread_pct_cap_locked, hours_since_lock).
    #
    # v2.8 audit (R6): if EVERY row for the day is `capture_reason='backfill_approx'`,
    # treat the day as having no real locked snapshot for ML feature purposes.
    # The backfill rows have stale captured_ts (e.g. matching an old DB backup
    # mtime, weeks in the past) which would feed garbage `hours_since_lock`
    # values. Backfill rows still get used by error_memory via _spread_weight
    # (with the 0.3x discount), just not by build_features.
    has_locked_snapshot = False
    locked_spread_pct_cap = np.zeros(SLOTS_DAY, dtype=float)
    locked_captured_ts = None
    slot_ts_local_ms = None
    try:
        # Per-slot local-midnight timestamps in Unix ms (for hours_since_lock calc)
        day_dt = datetime.fromisoformat(day)
        _midnight_ms = int(day_dt.timestamp() * 1000)
        slot_ts_local_ms = np.asarray(
            [_midnight_ms + i * SLOT_MIN * 60 * 1000 for i in range(SLOTS_DAY)],
            dtype=float,
        )
        with _open_sqlite(APP_DB_FILE, SQLITE_READ_TIMEOUT_SEC, readonly=True) as _conn:
            _conn.execute("PRAGMA query_only = ON")
            _rows = _conn.execute(
                "SELECT slot, spread_pct_cap, captured_ts, capture_reason "
                "FROM solcast_dayahead_locked WHERE forecast_day = ?",
                (day,),
            ).fetchall()
            if _rows:
                _min_ts = None
                _has_real_capture = False  # any non-backfill_approx row
                for _r in _rows:
                    _slot = int(_r[0] or -1)
                    if 0 <= _slot < SLOTS_DAY and _r[1] is not None:
                        locked_spread_pct_cap[_slot] = float(_r[1])
                    if _r[2] is not None:
                        _ts = int(_r[2])
                        _min_ts = _ts if _min_ts is None else min(_min_ts, _ts)
                    if _r[3] is not None and str(_r[3]) != "backfill_approx":
                        _has_real_capture = True
                # R6: only treat as "has locked snapshot" for build_features
                # purposes if at least one row is from a real capture
                # (scheduled_0600/0955/1100_catchup/manual). Backfill-only days
                # would feed stale captured_ts into hours_since_lock.
                if _min_ts is not None and _has_real_capture:
                    locked_captured_ts = _min_ts
                    has_locked_snapshot = True
                elif _min_ts is not None:
                    log.debug(
                        "Locked snapshot for %s is backfill_approx only (%d rows) — "
                        "skipping locked features in build_features (still used by error_memory)",
                        day, len(_rows),
                    )
                    # Reset spread array so build_features doesn't see stale values
                    locked_spread_pct_cap = np.zeros(SLOTS_DAY, dtype=float)
    except Exception as _e:
        log.debug("Could not load locked snapshot features for %s: %s", day, _e)

    return {
        "available": present.astype(float),
        "present": present,
        "prior_kwh": prior_kwh,
        "prior_lo_kwh": prior_lo,
        "prior_hi_kwh": prior_hi,
        "prior_mw": prior_mw,
        "spread_frac": spread_frac,
        "blend": blend,
        "coverage_ratio": coverage_ratio,
        "bias_ratio": bias_ratio,
        "reliability": reliability_score,
        "resolution_weight": resolution_weight,
        "resolution_support": resolution_support,
        "primary_mode": primary_mode,
        "regime": regime,
        "season": season,
        "trend_signal": _trend_signal,
        "trend_magnitude": _trend_mag,
        "spread_confidence": _sc_spread_conf,
        "has_triband": has_triband,
        # T4.1 / T4.2: stricter tri-band validity signals for training & features.
        "has_real_triband": has_real_triband,
        "triband_data_quality_flag": triband_data_quality_flag,
        "is_past_date": is_past_date,
        "source": str(snapshot.get("source") or "solcast"),
        "pulled_ts": int(snapshot.get("pulled_ts", 0) or 0),
        # Step 12 (v2.8): Locked snapshot features for build_features
        "has_locked_snapshot": has_locked_snapshot,
        "locked_spread_pct_cap": locked_spread_pct_cap,
        "locked_captured_ts": locked_captured_ts,
        "slot_ts_local_ms": slot_ts_local_ms,
    }

def blend_physics_with_solcast(
    baseline: np.ndarray,
    solcast_prior: dict | None,
) -> tuple[np.ndarray, dict]:
    base = np.clip(np.asarray(baseline, dtype=float), 0.0, None)
    if not solcast_prior:
        return base.copy(), {
            "used_solcast": False,
            "coverage_ratio": 0.0,
            "mean_blend": 0.0,
            "bias_ratio": 1.0,
            "reliability": 0.0,
            "regime": "",
            "season": "",
            "trend_signal": "stable",
            "trend_magnitude": 0.0,
            "source": "",
            "pulled_ts": 0,
            "resolution_weight_mean": SOLCAST_RESOLUTION_WEIGHT_FALLBACK,
            "resolution_support_mean": 0.0,
            "primary_mode": False,
            "raw_prior_total_kwh": 0.0,
            "applied_prior_total_kwh": 0.0,
            "raw_prior_ratio": 1.0,
            "applied_prior_ratio": 1.0,
            "spread_frac_mean": 0.0,
        }

    prior = np.clip(np.asarray(solcast_prior["prior_kwh"], dtype=float), 0.0, None)

    # CRITICAL: Validate prior array size to prevent silent data corruption from truncated Solcast snapshots
    if prior.size != SLOTS_DAY:
        log.error(
            "Solcast prior array size mismatch: got %d slots, expected %d — cannot blend, falling back to baseline",
            prior.size, SLOTS_DAY,
        )
        return base.copy(), {
            "used_solcast": False,
            "coverage_ratio": 0.0,
            "mean_blend": 0.0,
            "bias_ratio": 1.0,
            "reliability": 0.0,
            "regime": "",
            "season": "",
            "trend_signal": "stable",
            "trend_magnitude": 0.0,
            "source": "",
            "pulled_ts": 0,
            "resolution_weight_mean": SOLCAST_RESOLUTION_WEIGHT_FALLBACK,
            "resolution_support_mean": 0.0,
            "primary_mode": False,
            "raw_prior_total_kwh": 0.0,
            "applied_prior_total_kwh": 0.0,
            "raw_prior_ratio": 1.0,
            "applied_prior_ratio": 1.0,
            "spread_frac_mean": 0.0,
        }

    blend = np.clip(np.asarray(solcast_prior["blend"], dtype=float), 0.0, 1.0)
    present = np.asarray(solcast_prior["present"], dtype=bool)
    resolution_weight = np.clip(
        np.asarray(
            solcast_prior.get(
                "resolution_weight",
                np.full(SLOTS_DAY, SOLCAST_RESOLUTION_WEIGHT_FALLBACK, dtype=float),
            ),
            dtype=float,
        ),
        0.0,
        1.0,
    )
    resolution_support = np.clip(
        np.asarray(solcast_prior.get("resolution_support", np.zeros(SLOTS_DAY, dtype=float)), dtype=float),
        0.0,
        1.0,
    )
    adjusted_prior = prior.copy()
    solar_present = present[SOLAR_START_SLOT:SOLAR_END_SLOT]
    base_solar = base[SOLAR_START_SLOT:SOLAR_END_SLOT]
    prior_solar = prior[SOLAR_START_SLOT:SOLAR_END_SLOT]
    base_total = float(base_solar.sum())
    prior_total = float(prior_solar[solar_present].sum()) if np.any(solar_present) else 0.0
    raw_ratio = float(prior_total / max(base_total, 1.0)) if base_total > 0 else 1.0
    applied_ratio = float(np.clip(raw_ratio, *SOLCAST_PRIOR_TOTAL_RATIO_CLIP))
    _ratio_was_clipped = abs(applied_ratio - raw_ratio) > 0.001
    if _ratio_was_clipped:
        log.warning("Solcast total ratio clipped: raw=%.3f  applied=%.3f (bounds: %.2f-%.2f)",
                    raw_ratio, applied_ratio, SOLCAST_PRIOR_TOTAL_RATIO_CLIP[0], SOLCAST_PRIOR_TOTAL_RATIO_CLIP[1])
    if base_total > 0.0 and prior_total > 0.0 and np.any(solar_present):
        # Keep Solcast's intra-day shape, but constrain its daily energy against
        # the plant-aware physics baseline so raw provider totals do not dominate.
        solar_profile = np.zeros_like(prior_solar)
        solar_profile[solar_present] = prior_solar[solar_present] / max(prior_total, 1.0)
        adjusted_total = base_total * applied_ratio
        adjusted_prior[SOLAR_START_SLOT:SOLAR_END_SLOT] = solar_profile * adjusted_total
        adjusted_prior[:SOLAR_START_SLOT] = 0.0
        adjusted_prior[SOLAR_END_SLOT:] = 0.0
    out = base.copy()
    out[present] = (1.0 - blend[present]) * base[present] + blend[present] * adjusted_prior[present]
    out[:SOLAR_START_SLOT] = 0.0
    out[SOLAR_END_SLOT:] = 0.0
    return out, {
        "used_solcast": True,
        "coverage_ratio": float(solcast_prior.get("coverage_ratio", 0.0)),
        "mean_blend": float(np.mean(blend[SOLAR_START_SLOT:SOLAR_END_SLOT][present[SOLAR_START_SLOT:SOLAR_END_SLOT]])) if np.any(present[SOLAR_START_SLOT:SOLAR_END_SLOT]) else 0.0,
        "bias_ratio": float(solcast_prior.get("bias_ratio", 1.0)),
        "reliability": float(solcast_prior.get("reliability", 0.0)),
        "resolution_weight_mean": float(
            np.mean(
                resolution_weight[SOLAR_START_SLOT:SOLAR_END_SLOT][present[SOLAR_START_SLOT:SOLAR_END_SLOT]]
            )
        ) if np.any(present[SOLAR_START_SLOT:SOLAR_END_SLOT]) else SOLCAST_RESOLUTION_WEIGHT_FALLBACK,
        "resolution_support_mean": float(
            np.mean(
                resolution_support[SOLAR_START_SLOT:SOLAR_END_SLOT][present[SOLAR_START_SLOT:SOLAR_END_SLOT]]
            )
        ) if np.any(present[SOLAR_START_SLOT:SOLAR_END_SLOT]) else 0.0,
        "primary_mode": bool(solcast_prior.get("primary_mode", False)),
        "raw_prior_total_kwh": prior_total,
        "applied_prior_total_kwh": float(adjusted_prior[SOLAR_START_SLOT:SOLAR_END_SLOT].sum()),
        "raw_prior_ratio": raw_ratio,
        "applied_prior_ratio": applied_ratio,
        "solcast_ratio_clipped": _ratio_was_clipped,
        "solcast_raw_ratio": round(raw_ratio, 4),
        "regime": str(solcast_prior.get("regime") or ""),
        "season": str(solcast_prior.get("season") or ""),
        "trend_signal": str(solcast_prior.get("trend_signal") or "stable"),
        "trend_magnitude": float(solcast_prior.get("trend_magnitude", 0.0)),
        "source": str(solcast_prior.get("source") or "solcast"),
        "pulled_ts": int(solcast_prior.get("pulled_ts", 0) or 0),
        "spread_frac_mean": float(
            np.mean(_spread_solar)
            if (_spread_solar := np.asarray(solcast_prior.get("spread_frac", np.zeros(SLOTS_DAY)), dtype=float)[SOLAR_START_SLOT:SOLAR_END_SLOT][present[SOLAR_START_SLOT:SOLAR_END_SLOT]]).size > 0
            else 0.0
        ),
    }

def _load_intraday_adjusted_from_db(day: str) -> tuple[np.ndarray | None, np.ndarray | None]:
    if not APP_DB_FILE.exists():
        return None, None
    out = _empty_slot_values()
    present = _empty_slot_presence()
    for attempt in range(1, SQLITE_RETRY_ATTEMPTS + 1):
        try:
            with _open_sqlite(APP_DB_FILE, SQLITE_READ_TIMEOUT_SEC, readonly=True) as conn:
                conn.execute("PRAGMA query_only = ON")
                cur = conn.execute(
                    """
                    SELECT slot, kwh_inc
                      FROM forecast_intraday_adjusted
                     WHERE date=?
                     ORDER BY slot ASC
                    """,
                    (str(day),),
                )
                for slot, kwh_inc in cur.fetchall():
                    slot_i = int(slot or 0)
                    if 0 <= slot_i < SLOTS_DAY:
                        out[slot_i] = _coerce_non_negative_float(kwh_inc)
                        present[slot_i] = True
            return (out, present) if present.any() else (None, None)
        except Exception as e:
            if attempt < SQLITE_RETRY_ATTEMPTS and _is_retryable_sqlite_error(e):
                log.warning(
                    "DB intraday load retry %d/%d [%s]: %s",
                    attempt,
                    SQLITE_RETRY_ATTEMPTS,
                    day,
                    e,
                )
                _sleep_sqlite_retry(attempt)
                continue
            log.warning("DB intraday load failed [%s]: %s", day, e)
            return None, None

def _load_intraday_adjusted_from_legacy(day: str) -> tuple[np.ndarray | None, np.ndarray | None]:
    ctx = _load_json(FORECAST_CTX)
    da = ctx.get("PacEnergy_IntradayAdjusted", {}).get(day)
    if not isinstance(da, list) or not da:
        return None, None
    out = _empty_slot_values()
    present = _empty_slot_presence()
    total_rows = len(da)
    for i, p in enumerate(da):
        if not isinstance(p, dict):
            continue
        slot = _parse_slot_from_time_text(day, p.get("time") or p.get("time_hms"))
        if slot is None:
            slot = _default_legacy_slot(i, total_rows)
        if 0 <= slot < SLOTS_DAY:
            out[slot] = _coerce_non_negative_float(p.get("kWh_inc", p.get("kwh_inc", 0)))
            present[slot] = True
    return (out, present) if present.any() else (None, None)

@lru_cache(maxsize=256)
def load_intraday_adjusted_with_presence(day: str) -> tuple[np.ndarray | None, np.ndarray | None]:
    db_rows, db_present = _load_intraday_adjusted_from_db(day)
    legacy_rows, legacy_present = _load_intraday_adjusted_from_legacy(day)
    return _merge_slot_series_with_presence(
        "Intraday adjusted",
        day,
        db_rows,
        db_present,
        legacy_rows,
        legacy_present,
        MIN_DAYAHEAD_SOLAR_SLOTS,
    )

@lru_cache(maxsize=256)
def load_intraday_adjusted(day: str) -> np.ndarray | None:
    values, _ = load_intraday_adjusted_with_presence(day)
    return values

# ============================================================================
# ERROR MEMORY  (rolling bias correction)
# ============================================================================

def _compute_error_memory_legacy(today: date, target_regime: str = "") -> np.ndarray:
    """
    Fallback error memory computation for sparse-regime scenarios.

    Unlike the main path, this reads `forecast_error_compare_slot` directly
    and relies on the persisted `usable_for_error_memory=1` flag to filter
    trustworthy rows. That flag is set by `_persist_qa_comparison` only
    after the full daily-eligibility gate passes, so no additional
    source/provider weighting is needed here.

    v2.8 M1 fix: removed the stale-name provider penalty that was checking
    for provider names ("learning", "ml_local") which no longer exist in
    the codebase, causing every row to be silently discounted to 20% of
    its intended weight. The persisted `usable_for_error_memory` flag is
    now the single source of truth for row eligibility.

    Args:
        today: Reference date
        target_regime: Weather regime for lookback window expansion

    Returns:
        Weighted error memory array (SLOTS_DAY,)
    """
    _regime_days = ERR_MEMORY_DAYS_BY_REGIME.get(target_regime, ERR_MEMORY_DAYS)
    weight_vectors = []
    errors = []
    # v2.8 M1: schema-legacy fallback penalty (applied only when
    # `usable_for_error_memory` column is missing — effectively never in
    # production, but test fixtures may pre-date the column migration).
    _schema_legacy_penalty = 0.5
    _schema_legacy_mode = False
    try:
        start_date = (today - timedelta(days=_regime_days)).isoformat()
        end_date = (today - timedelta(days=1)).isoformat()
        with _open_sqlite(APP_DB_FILE, SQLITE_READ_TIMEOUT_SEC, readonly=True) as conn:
            conn.execute("PRAGMA query_only = ON")
            cols = {
                str(row[1] or "")
                for row in conn.execute("PRAGMA table_info(forecast_error_compare_slot)")
            }
            err_col = "signed_error_kwh" if "signed_error_kwh" in cols else ("error_kwh" if "error_kwh" in cols else "")
            if not err_col:
                return np.zeros(SLOTS_DAY, dtype=float)
            has_usable_col = "usable_for_error_memory" in cols
            has_regime_col = "day_regime" in cols
            has_spread_col = "spread_pct_cap_locked" in cols
            if not has_usable_col:
                _schema_legacy_mode = True
                log.info("error_memory_legacy: schema-legacy mode active (applying %.2f penalty to unfiltered rows)", _schema_legacy_penalty)

            # v2.8 M2/M3: Build query schema-defensively with optional
            # regime + spread columns. When present, the legacy path
            # now applies the same regime penalty matrix and _spread_weight
            # as the main path, matching its signal strength.
            select_cols = ["target_date", "slot", err_col + " AS error_val"]
            if has_regime_col:
                select_cols.append("day_regime")
            if has_spread_col:
                select_cols.append("spread_pct_cap_locked")
            if has_usable_col:
                select_cols.append("usable_for_error_memory")
            query = (
                "SELECT " + ", ".join(select_cols)
                + " FROM forecast_error_compare_slot"
                + " WHERE target_date >= ? AND target_date <= ?"
            )
            if has_usable_col:
                query += " AND usable_for_error_memory = 1"

            # Layout: each slot row → (regime_or_none, spread_or_none, err_val)
            history: dict[str, dict[int, tuple[str | None, float | None, float]]] = {}
            for row in conn.execute(query, (start_date, end_date)):
                day_str = str(row[0] or "")
                slot = int(row[1] or -1)
                if slot < 0 or slot >= SLOTS_DAY:
                    continue
                err_val = row[2]
                if err_val is None:
                    continue
                idx = 3
                hist_regime = None
                if has_regime_col:
                    hist_regime = str(row[idx] or "") or None
                    idx += 1
                spread_pct_cap = None
                if has_spread_col:
                    spread_pct_cap = row[idx]
                    idx += 1
                history.setdefault(day_str, {})[slot] = (
                    hist_regime,
                    spread_pct_cap,
                    float(err_val),
                )

            # v2.8 M2: also pre-fetch capture_reason per day for spread
            # weighting. One query for the whole window, keyed by day.
            capture_reason_by_day: dict[str, str | None] = {}
            if has_spread_col:
                try:
                    _day_list = list(history.keys())
                    if _day_list:
                        _ph = ",".join("?" for _ in _day_list)
                        for _r in conn.execute(
                            f"SELECT forecast_day, capture_reason FROM solcast_dayahead_locked "
                            f"WHERE forecast_day IN ({_ph})",
                            tuple(_day_list),
                        ):
                            capture_reason_by_day[str(_r[0] or "")] = _r[1]
                except Exception:
                    pass  # missing table or column — capture_reason stays None

        # FIX 1 H1: Compute clip bound once before loop, scaled to plant capacity
        _clip_kwh = plant_capacity_kw(False) * (5.0 / 60.0) * 2.0

        for d in range(1, _regime_days + 1):
            day = (today - timedelta(days=d)).isoformat()
            day_history = history.get(day)
            if not day_history:
                continue
            _, constraint_meta = build_operational_constraint_mask(day)
            # Use 1000H alarm-based outage mask instead of stale audit_log operational_mask
            inverter_outage = _build_1000h_inverter_outage_mask(day)
            cap_dispatch = np.asarray(constraint_meta.get("cap_dispatch_mask"), dtype=bool)
            exclude_arr = inverter_outage | cap_dispatch
            err = np.zeros(SLOTS_DAY, dtype=float)
            weight_vec = np.zeros(SLOTS_DAY, dtype=float)
            base_w = ERR_MEMORY_DECAY ** (d - 1)
            # v2.8 M1: schema-legacy mode applies a flat 0.5 penalty when
            # the persisted `usable_for_error_memory` flag is unavailable.
            if _schema_legacy_mode:
                base_w *= _schema_legacy_penalty
            # v2.8 M3: compute regime mismatch penalty once per day.
            # Use the first slot's regime as the day's regime (all slots
            # on a given day share the same QA-persisted day_regime).
            _sample_slot = next(iter(day_history.values()), None)
            _hist_regime = _sample_slot[0] if _sample_slot else None
            regime_factor = 1.0
            if target_regime and _hist_regime and target_regime != _hist_regime:
                regime_factor = ERR_MEMORY_REGIME_PENALTY_MATRIX.get(
                    (target_regime, _hist_regime),
                    ERR_MEMORY_REGIME_MISMATCH_PENALTY,
                )
            _day_capture_reason = capture_reason_by_day.get(day)
            for slot in range(SOLAR_START_SLOT, SOLAR_END_SLOT):
                if exclude_arr[slot] or slot not in day_history:
                    continue
                _, slot_spread, slot_err = day_history[slot]
                err[slot] = float(np.clip(slot_err, -_clip_kwh, _clip_kwh))
                # v2.8 M2: apply spread-weight multiplier when available.
                spread_w = _spread_weight(slot_spread, _day_capture_reason)
                weight_vec[slot] = base_w * regime_factor * spread_w
            if np.sum(weight_vec) <= 0:
                continue
            errors.append(err)
            weight_vectors.append(weight_vec)
    except Exception as e:
        log.warning("Legacy error-memory fallback failed: %s", e)

    if not errors:
        return np.zeros(SLOTS_DAY, dtype=float)

    weighted_sum = np.sum(np.stack([w * e for w, e in zip(weight_vectors, errors)]), axis=0)
    weight_sum = np.sum(np.stack(weight_vectors), axis=0)
    mem_err = np.divide(
        weighted_sum,
        np.maximum(weight_sum, 1e-9),
        out=np.zeros(SLOTS_DAY, dtype=float),
        where=weight_sum > 0,
    )
    mem_err = _rolling_mean(mem_err, 7, center=True)
    mem_err[weight_sum <= 0] = 0.0
    mem_err[:SOLAR_START_SLOT] = 0.0
    mem_err[SOLAR_END_SLOT:] = 0.0
    mem_err = np.clip(mem_err, -100.0, 100.0)
    return mem_err

def _has_sufficient_locked_history(conn, min_days: int = 30) -> bool:
    """
    Step 13: Feature flag checking if >=min_days distinct forecast_days exist in
    solcast_dayahead_locked with capture_reason != 'backfill_approx'.

    Returns True if sufficient real (non-approximation) locked history has accumulated.
    """
    try:
        row = conn.execute(
            "SELECT COUNT(DISTINCT forecast_day) AS n FROM solcast_dayahead_locked WHERE capture_reason != 'backfill_approx'"
        ).fetchone()
        return row and int(row[0] or 0) >= min_days
    except Exception:
        return False

def _spread_weight(spread_pct_cap_locked: float | None, capture_reason: str | None) -> float:
    """
    Narrow-spread misses are the strongest learning signal; wide-spread
    misses get discounted because the forecast was already hedged.

    v2.8 H1/H2 fix: correctness of edge cases.

    - Unknown spread (None or ≤ 0) no longer returns 1.0 (max trust).
      It now returns 0.5 — a neutral mid-trust value. The old code
      inverted the intent: a row with no v2.8 locked-snapshot spread
      (pre-migration rows or rows missing the lock capture) is an
      unknown-uncertainty signal, which deserves less trust than a
      row with a measured narrow spread, not more.

    - Backfill-approx rows compound with spread: a wide-spread
      backfill row is the weakest signal in the system and returns
      as low as 0.09. This is intentional — backfilled spread has no
      basis in a real capture event.

    Args:
        spread_pct_cap_locked: Spread as % of plant capacity, from
            solcast_dayahead_locked. None or ≤ 0 means unknown.
        capture_reason: Capture reason — one of
            'scheduled_0600', 'scheduled_0955', 'manual', 'backfill_approx',
            or None.

    Returns:
        Weight multiplier in range [0.09, 1.0]. Typical values:
            fresh narrow spread (≤ 5%):   0.95 - 1.00
            fresh wide spread (~ 30%):    0.70
            fresh very wide (~ 70%):      0.30 (soft floor)
            unknown spread (None/0):      0.50  ← H2 fix
            backfill narrow spread:       0.30 (= 1.0 * 0.3)
            backfill wide spread:         0.09 - 0.20 (compound)
    """
    if spread_pct_cap_locked is None or spread_pct_cap_locked <= 0:
        # Unknown or zero spread — neutral mid-trust, not max-trust.
        # Pre-v2.8 rows hit this branch until the migration fills in
        # locked snapshots for every training day.
        base = 0.5
    else:
        base = min(1.0, max(0.3, 1.0 - (spread_pct_cap_locked / 100.0)))
    if capture_reason == "backfill_approx":
        base *= 0.3
    elif capture_reason and capture_reason not in ("scheduled_0600", "scheduled_0955", "manual", None):
        # FIX 4 M9: Log unknown capture_reason values for debugging
        log.debug("_spread_weight: unexpected capture_reason '%s', using base weight %.2f", capture_reason, base)
    return base

def compute_error_memory(today: date, w_today_5: pd.DataFrame, target_regime: str = "") -> np.ndarray:
    """
    Compute weighted historical bias from saved comparison rows.

    Preferred source:
      - forecast_error_compare_daily (eligible rows only; `include_in_error_memory=1`)
      - forecast_error_compare_slot (usable_for_error_memory=1)
    Fallback source:
      - legacy slot-only table reading.

    Error memory is regime-aware: lookback window is selected per target_regime
    from ERR_MEMORY_DAYS_BY_REGIME. Regime-mismatched historical days receive
    a penalty multiplier from ERR_MEMORY_REGIME_PENALTY_MATRIX.

    Per-slot bias is clipped to ±100 kWh as a guard against correlated-bias
    weeks that would otherwise dominate the forecast.

    Metadata is written to module-level _LAST_ERROR_MEMORY_META for caller inspection.

    Args:
        today: Target date for error memory
        w_today_5: DataFrame with weather data (not used in current implementation)
        target_regime: Target day's weather regime; historical days with mismatched regime are penalized

    Returns:
        Weighted error memory array (SLOTS_DAY,). Magnitude bounded to ±100 kWh per slot.
    """
    global _LAST_ERROR_MEMORY_META

    del w_today_5  # explicit: current implementation uses persisted compare rows only.
    _regime_days = ERR_MEMORY_DAYS_BY_REGIME.get(target_regime, ERR_MEMORY_DAYS)
    weight_vectors = []
    errors = []
    all_daily_rows = []  # Track all rows for metadata
    last_eligible_date = None
    selected_days = 0
    fallback_to_legacy = False
    fallback_reason = None
    # Step 11 (v2.8): spread-weight telemetry counters (populated inside the
    # per-day loop so we can log a single summary line after the connection
    # closes — see end-of-function block).
    total_spread_weight_samples = 0
    sum_spread_weights = 0.0
    backfill_rows_with_spread = 0

    # v2.8 M4: per-day TOD zone signed means, collected inside the day loop
    # and consumed by the TOD-floor gate after the weighted average is built.
    # Entries are appended in the same order the outer loop visits days
    # (daily_rows is ORDER BY target_date DESC), so index 0 = newest.
    # Each entry: {"days_ago": int, "zone_signed_means": [morning, midday, afternoon]}.
    per_day_zone_stats: list[dict] = []

    try:
        start_date = (today - timedelta(days=max(_regime_days * 4, 60))).isoformat()
        end_date = (today - timedelta(days=1)).isoformat()
        # FIX-12: SQLite WAL mode + readonly=True provides snapshot isolation —
        # all reads within this connection see a consistent point-in-time view.
        with _open_sqlite(APP_DB_FILE, SQLITE_READ_TIMEOUT_SEC, readonly=True) as conn:
            conn.execute("PRAGMA query_only = ON")
            # Probe schema: actual_source column is optional (added in v2.7.6+;
            # legacy databases and test fixtures may not have run the Node
            # ensureColumn migration yet).
            daily_cols = {row[1] for row in conn.execute(
                "PRAGMA table_info(forecast_error_compare_daily)"
            ).fetchall()}
            actual_source_expr = (
                "COALESCE(actual_source, 'estimated')"
                if "actual_source" in daily_cols
                else "'estimated'"
            )
            daily_rows = conn.execute(
                f"""
                SELECT target_date, COALESCE(run_audit_id, 0), COALESCE(forecast_variant, ''), COALESCE(provider_expected, ''), COALESCE(notes_json, ''), {actual_source_expr}
                  FROM forecast_error_compare_daily
                 WHERE target_date >= ? AND target_date <= ?
                   AND include_in_error_memory = 1
                   AND comparison_quality = 'eligible'
                 ORDER BY target_date DESC
                 LIMIT ?
                """,
                (start_date, end_date, max(_regime_days * 4, 60))
            ).fetchall()

            if not daily_rows:
                # No eligible rows found at all
                fallback_to_legacy = True
                fallback_reason = "no_eligible_rows"
                log.info("Error memory: no eligible rows in daily table, using legacy fallback")
            else:
                all_daily_rows = list(daily_rows)

                # v2.8 efficiency audit (E6/P3): batch-fetch capture_reason and
                # slot rows for ALL candidate days in one query each. Replaces
                # the N+1 per-day queries that previously ran inside the loop.
                _target_dates = [str(r[0] or "") for r in daily_rows if r[0]]
                _capture_reason_by_day: dict[str, str | None] = {}
                _slot_rows_by_pair: dict[tuple[str, int], list] = {}
                if _target_dates:
                    _placeholders = ",".join("?" for _ in _target_dates)
                    # Batch 1: capture_reason lookup (one row per forecast_day)
                    try:
                        for _r in conn.execute(
                            f"SELECT forecast_day, capture_reason FROM solcast_dayahead_locked "
                            f"WHERE forecast_day IN ({_placeholders})",
                            tuple(_target_dates),
                        ):
                            _capture_reason_by_day[str(_r[0] or "")] = _r[1]
                    except Exception as _cr_err:
                        log.debug("Batch capture_reason fetch failed: %s", _cr_err)
                    # Batch 2: slot rows — bucket by (target_date, run_audit_id)
                    try:
                        for _sr in conn.execute(
                            f"""
                            SELECT target_date, COALESCE(run_audit_id, 0), slot,
                                   signed_error_kwh, support_weight,
                                   usable_for_error_memory, spread_pct_cap_locked
                              FROM forecast_error_compare_slot
                             WHERE target_date IN ({_placeholders})
                            """,
                            tuple(_target_dates),
                        ):
                            _key = (str(_sr[0] or ""), int(_sr[1] or 0))
                            _slot_rows_by_pair.setdefault(_key, []).append(_sr[2:])
                    except Exception as _sr_err:
                        log.debug("Batch slot-row fetch failed: %s", _sr_err)

                # FIX 1 H1: Compute clip bound once before loop, scaled to plant capacity
                _clip_kwh = plant_capacity_kw(False) * (5.0 / 60.0) * 2.0

                for day_row in daily_rows:
                    day_s = str(day_row[0] or "")
                    if not day_s:
                        continue
                    try:
                        days_ago = (today - datetime.strptime(day_s, "%Y-%m-%d").date()).days
                    except Exception:
                        continue
                    if days_ago < 1:
                        continue

                    run_audit_id = int(day_row[1] or 0)
                    forecast_variant = str(day_row[2] or "")
                    provider_expected = str(day_row[3] or "")
                    notes_json_str = str(day_row[4] or "")
                    actual_src = str(day_row[5] or "estimated")
                    source_weight = _memory_source_weight(forecast_variant, provider_expected)
                    if source_weight <= 0:
                        continue
                    # Apply actual-source weight: metered gets full weight, mixed gets mid-weight, estimated gets discount
                    if actual_src == "metered":
                        source_weight = 1.0  # full trust for metered data
                    elif actual_src == "mixed":
                        source_weight = min(source_weight, 0.95)  # mid-trust for mixed
                    # else: estimated gets the forecast-variant-based weight (already computed)

                    # Extract regime from notes_json for regime-aware weighting
                    hist_regime = ""
                    try:
                        if notes_json_str:
                            notes_dict = json.loads(notes_json_str)
                            hist_regime = str(notes_dict.get("forecast_regime", ""))
                    except Exception as _notes_err:
                        log.debug("Failed to parse notes_json for error memory regime lookup: %s", _notes_err)

                    # Graduated regime mismatch penalty: neighboring regimes (overcast<->rainy)
                    # share more error structure than distant regimes (clear<->rainy).
                    regime_factor = 1.0
                    if target_regime and hist_regime and target_regime != hist_regime:
                        regime_factor = ERR_MEMORY_REGIME_PENALTY_MATRIX.get(
                            (target_regime, hist_regime),
                            ERR_MEMORY_REGIME_MISMATCH_PENALTY,  # flat fallback for unknown pairs
                        )

                    # Trust the persisted usable_for_error_memory flag from QA comparison.
                    # It already accounts for est_actual reconstruction (constrained slots
                    # replaced with Solcast estimated actuals have their flags cleared).
                    err = np.zeros(SLOTS_DAY, dtype=float)
                    weight_vec = np.zeros(SLOTS_DAY, dtype=float)

                    # v2.8 E6/P3: capture_reason + slot rows come from the
                    # pre-fetched batch dicts above. Zero extra DB queries
                    # inside this per-day loop.
                    day_capture_reason = _capture_reason_by_day.get(day_s)
                    _slot_rows_for_day = _slot_rows_by_pair.get((day_s, run_audit_id), [])

                    for slot_row in _slot_rows_for_day:
                        slot = int(slot_row[0] or -1)
                        if slot < SOLAR_START_SLOT or slot >= SOLAR_END_SLOT:
                            continue
                        if int(slot_row[3] or 0) != 1:
                            continue
                        signed_err = slot_row[1]
                        if signed_err is None:
                            continue
                        support_weight = float(slot_row[2] or 1.0)
                        support_weight = float(np.clip(support_weight, 0.0, 1.0))
                        spread_pct_cap_locked = slot_row[4]  # May be NULL for pre-feature days
                        # Step 11: Apply spread-weight multiplier if locked snapshot exists
                        spread_weight = _spread_weight(spread_pct_cap_locked, day_capture_reason)
                        base_w = ERR_MEMORY_DECAY ** (days_ago - 1)
                        weight_vec[slot] = base_w * source_weight * support_weight * regime_factor * spread_weight
                        err[slot] = float(np.clip(float(signed_err), -_clip_kwh, _clip_kwh))
                        # Track spread-weight stats for telemetry
                        if spread_pct_cap_locked is not None:
                            sum_spread_weights += spread_weight
                            total_spread_weight_samples += 1
                            if day_capture_reason == "backfill_approx":
                                backfill_rows_with_spread += 1

                    if np.sum(weight_vec) <= 0:
                        continue
                    errors.append(err)
                    weight_vectors.append(weight_vec)
                    selected_days += 1
                    if last_eligible_date is None:
                        last_eligible_date = day_s

                    # v2.8 M4: compute per-zone signed mean for this day so
                    # the TOD-floor gate can check newest-3-day consistency.
                    _solar_len_tmp = SOLAR_END_SLOT - SOLAR_START_SLOT
                    _third = _solar_len_tmp // 3
                    _zone_bounds = [
                        (SOLAR_START_SLOT,                   SOLAR_START_SLOT + _third),
                        (SOLAR_START_SLOT + _third,          SOLAR_START_SLOT + 2 * _third),
                        (SOLAR_START_SLOT + 2 * _third,      SOLAR_END_SLOT),
                    ]
                    _zone_means_today: list[float] = []
                    for _zs, _ze in _zone_bounds:
                        _zone_err = err[_zs:_ze]
                        _zone_wv = weight_vec[_zs:_ze]
                        _active = _zone_wv > 0
                        if int(np.count_nonzero(_active)) >= 3:
                            _zone_means_today.append(float(np.mean(_zone_err[_active])))
                        else:
                            _zone_means_today.append(0.0)
                    per_day_zone_stats.append({
                        "days_ago": int(days_ago),
                        "zone_signed_means": _zone_means_today,
                    })

                    if selected_days >= _regime_days:
                        break

                # Check if we accumulated enough data; if not, fallback
                if selected_days < max(_regime_days // 2, 3):
                    fallback_to_legacy = True
                    fallback_reason = "sparse_regime_data"
                    log.info("Error memory: only %d selected days (target=%d), using legacy fallback", selected_days, _regime_days)

    except Exception as e:
        log.warning("Failed to compute persisted error memory: %s", e)
        fallback_to_legacy = True
        fallback_reason = "exception"
        errors = []
        weight_vectors = []
        selected_days = 0

    # Fallback to legacy if necessary
    if fallback_to_legacy and fallback_reason:
        mem_err = _compute_error_memory_legacy(today, target_regime)
        # v2.8 H5: record the RAW bias magnitude here (pre-damping).
        # run_dayahead is responsible for computing the actual applied
        # bias after regime-aware Solcast damping and stuffing it into
        # the meta under `applied_bias_total_kwh`. This split preserves
        # both signals: raw = learning-loop strength, applied = actual.
        raw_bias = float((ERROR_ALPHA * mem_err).sum())
        with _ERROR_MEMORY_LOCK:
            _LAST_ERROR_MEMORY_META = {
                "last_eligible_date": last_eligible_date,
                "eligible_row_count": len(all_daily_rows),
                "selected_days": 0,
                "lookback_days_used": _regime_days,
                "regime_used": target_regime or "",
                "fallback_to_legacy": True,
                "fallback_reason": fallback_reason,
                "raw_bias_total_kwh": raw_bias,
                "applied_bias_total_kwh": raw_bias,  # placeholder; run_dayahead overwrites
                "success": False,
            }
        return mem_err

    if not errors:
        # Should not reach here if fallback_to_legacy is set, but handle it
        mem_err = _compute_error_memory_legacy(today, target_regime)
        raw_bias = float((ERROR_ALPHA * mem_err).sum())
        with _ERROR_MEMORY_LOCK:
            _LAST_ERROR_MEMORY_META = {
                "last_eligible_date": last_eligible_date,
                "eligible_row_count": len(all_daily_rows),
                "selected_days": 0,
                "lookback_days_used": _regime_days,
                "regime_used": target_regime or "",
                "fallback_to_legacy": True,
                "fallback_reason": "no_eligible_rows" if not fallback_reason else fallback_reason,
                "raw_bias_total_kwh": raw_bias,
                "applied_bias_total_kwh": raw_bias,  # placeholder; run_dayahead overwrites
                "success": False,
            }
        return mem_err

    if total_spread_weight_samples > 0:
        avg_spread_weight = sum_spread_weights / total_spread_weight_samples
        log.info(
            "[error-memory] spread-weighted %d rows used (avg_spread_weight=%.2f, backfill_rows=%d)",
            total_spread_weight_samples, avg_spread_weight, backfill_rows_with_spread
        )

    weighted_sum = np.sum(np.stack([w * e for w, e in zip(weight_vectors, errors)]), axis=0)
    weight_sum = np.sum(np.stack(weight_vectors), axis=0)
    mem_err = np.divide(
        weighted_sum,
        np.maximum(weight_sum, 1e-9),
        out=np.zeros(SLOTS_DAY, dtype=float),
        where=weight_sum > 0,
    )
    mem_err = _rolling_mean(mem_err, 7, center=True)
    mem_err[weight_sum <= 0] = 0.0
    mem_err[:SOLAR_START_SLOT] = 0.0
    mem_err[SOLAR_END_SLOT:] = 0.0

    # Per-TOD floor: ensure error memory doesn't vanish in zones with consistent bias.
    # Split solar window into 3 TOD zones: morning, midday, afternoon.
    #
    # v2.8 M4: the floor now also requires the newest 3 days of per-zone
    # signed bias to agree in sign before it fires. This prevents the
    # floor from locking in a stale bias after a plant-side change
    # (module cleaning, inverter swap, reconfigured string) where the
    # window-average still looks consistent but the most recent days
    # have already flipped. If the newest days disagree with the
    # window-average sign, error memory is allowed to taper to zero
    # naturally as the window rolls over.
    _solar_len = SOLAR_END_SLOT - SOLAR_START_SLOT
    _tod_thirds = _solar_len // 3
    _zone_defs = [
        (SOLAR_START_SLOT,                  SOLAR_START_SLOT + _tod_thirds,     0),
        (SOLAR_START_SLOT + _tod_thirds,    SOLAR_START_SLOT + 2 * _tod_thirds, 1),
        (SOLAR_START_SLOT + 2 * _tod_thirds, SOLAR_END_SLOT,                    2),
    ]
    # Pull the newest 3 entries (list is in days_ago ASC order per append).
    _recent_days = sorted(per_day_zone_stats, key=lambda e: e.get("days_ago", 999))[:3]
    for _tod_start, _tod_end, _zone_idx in _zone_defs:
        _zone = mem_err[_tod_start:_tod_end]
        _zone_weights = weight_sum[_tod_start:_tod_end]
        _zone_active = _zone_weights > 0
        if np.sum(_zone_active) < 3:
            continue
        _zone_mean = np.mean(_zone[_zone_active])
        _zone_abs_mean = np.abs(_zone_mean)
        # If zone has consistent bias direction (>80% same sign), apply floor
        if _zone_abs_mean > 1.0:  # At least 1 kWh/slot bias
            _same_sign = np.sum(np.sign(_zone[_zone_active]) == np.sign(_zone_mean))
            _consistency = _same_sign / max(np.sum(_zone_active), 1)
            if _consistency > 0.80:
                # v2.8 M4 recency gate: require the newest days that have
                # data for this zone to still point the same direction.
                # A zone with a brand-new flip releases the floor even
                # though the window-average is still consistent.
                _recent_zone_vals = [
                    float(e["zone_signed_means"][_zone_idx])
                    for e in _recent_days
                    if len(e.get("zone_signed_means") or []) > _zone_idx
                    and abs(float(e["zone_signed_means"][_zone_idx])) > 0.01
                ]
                _target_sign = np.sign(_zone_mean)
                if _recent_zone_vals:
                    _recent_same = sum(
                        1 for v in _recent_zone_vals if np.sign(v) == _target_sign
                    )
                    # Require >=2 of the newest (at least) 3 to agree.
                    # If the newest days outright disagree, skip the floor.
                    if _recent_same < max(2, len(_recent_zone_vals) - 1):
                        log.info(
                            "[error-memory] TOD zone %d floor released: newest days flipped "
                            "(recent_vals=%s, zone_mean=%.2f)",
                            _zone_idx,
                            [round(v, 2) for v in _recent_zone_vals],
                            float(_zone_mean),
                        )
                        continue
                # Floor: at least 40% of zone mean persists
                _floor = _zone_mean * 0.40
                if _zone_mean > 0:
                    mem_err[_tod_start:_tod_end] = np.maximum(mem_err[_tod_start:_tod_end], _floor)
                else:
                    mem_err[_tod_start:_tod_end] = np.minimum(mem_err[_tod_start:_tod_end], _floor)

    # Guard against correlated-bias weeks producing an outsized correction.
    # Persistent bias > ±100 kWh/slot suggests a model or hardware issue, not
    # something error memory should silently absorb.
    mem_err = np.clip(mem_err, -100.0, 100.0)

    # v2.8 H5: raw_bias_total_kwh is the pre-damping magnitude the
    # learning loop *wants* to apply. run_dayahead later overwrites
    # applied_bias_total_kwh with the actual post-damping value.
    # v2.8 L3 note: mem_err is zeroed outside [SOLAR_START_SLOT, SOLAR_END_SLOT)
    # so `raw_bias` is effectively a solar-window total (non-solar slots
    # contribute nothing to the sum). The telemetry label reflects the
    # applied forecast effect, not the raw signal range.
    raw_bias = float((ERROR_ALPHA * mem_err).sum())

    # Store metadata for later retrieval
    with _ERROR_MEMORY_LOCK:
        _LAST_ERROR_MEMORY_META = {
            "last_eligible_date": last_eligible_date,
            "eligible_row_count": len(all_daily_rows),
            "selected_days": selected_days,
            "lookback_days_used": _regime_days,
            "regime_used": target_regime or "",
            "fallback_to_legacy": False,
            "fallback_reason": None,
            "raw_bias_total_kwh": raw_bias,
            "applied_bias_total_kwh": raw_bias,  # placeholder; run_dayahead overwrites
            "success": True,
        }
    return mem_err

def collect_history_days(
    today: date,
    lookback_days: int,
    solcast_reliability: dict | None = None,
) -> list[dict]:
    """
    Build the historical basis for training and intra-hour hardening.

    Historical samples always pair actual generation with archive weather for
    that same day. This keeps plant-response learning separate from any
    forecast-provider bias.
    """
    history = []
    solar_slot_mask = (
        (np.arange(SLOTS_DAY) >= SOLAR_START_SLOT)
        & (np.arange(SLOTS_DAY) < SOLAR_END_SLOT)
    )
    log.info(
        "Collecting history basis from last %d days using actual archived weather + actual generation",
        lookback_days,
    )

    # v2.8 efficiency audit (E1b/P3): prime cycle cache with all lookback
    # snapshots in one query. Idempotent — skips days already cached by
    # build_solcast_reliability_artifact when it runs earlier in the cycle.
    _prime_days_hist = [(today - timedelta(days=d)).isoformat() for d in range(1, lookback_days + 1)]
    try:
        prime_solcast_snapshot_cache(_prime_days_hist)
    except Exception as prime_err:
        log.debug("prime_solcast_snapshot_cache (training) failed: %s", prime_err)

    for days_ago in range(1, lookback_days + 1):
        day = (today - timedelta(days=days_ago)).isoformat()
        # E5 priority chain: metered substation → loss-adjusted inverter → Solcast est_actual
        actual, actual_present, actual_source = resolve_actual_5min_for_date(day)
        wdata = fetch_weather(day, source="archive")
        snapshot = load_solcast_snapshot(day)
        if not np.any(actual_present) or wdata is None:
            log.debug("  Skip %s - missing history basis", day)
            continue

        # PHASE 1: Require Solcast snapshot for training — skip days without it
        if snapshot is None:
            log.debug("  Skip %s - no Solcast snapshot available for training", day)
            continue
        forecast_kwh = snapshot.get("forecast_kwh")
        if forecast_kwh is None or (isinstance(forecast_kwh, (list, np.ndarray)) and len(forecast_kwh) == 0):
            log.debug("  Skip %s - no Solcast forecast data available for training", day)
            continue

        w5 = interpolate_5min(wdata, day)
        ok_w5, reason_w5 = validate_weather_5min(day, w5)
        if not ok_w5:
            log.warning("  Reject %s - weather quality failed: %s", day, reason_w5)
            continue

        baseline = physics_baseline(day, w5)
        solcast_prior = solcast_prior_from_snapshot(day, w5, snapshot, solcast_reliability)

        # PHASE 1: Extract Solcast mid as the primary baseline reference
        if solcast_prior is None:
            log.warning("  Reject %s - Failed to build Solcast prior", day)
            continue

        prior_kwh = solcast_prior.get("prior_kwh")
        if prior_kwh is None:
            log.warning("  Reject %s - Solcast prior missing 'prior_kwh'", day)
            continue

        solcast_mid_kwh = np.asarray(prior_kwh, dtype=float)
        if solcast_mid_kwh.size != SLOTS_DAY:
            log.warning("  Reject %s - Solcast snapshot has invalid size: got %d, expected %d", day, solcast_mid_kwh.size, SLOTS_DAY)
            continue

        # Keep physics baseline and hybrid baseline for diagnostics only
        history_baseline, hybrid_meta = blend_physics_with_solcast(baseline, solcast_prior)
        feature_frame = build_features(w5, day, solcast_prior)
        slot_weather_buckets = classify_slot_weather_buckets(w5, day)
        _, constraint_meta = build_operational_constraint_mask(day)
        actual_present_arr = np.asarray(actual_present, dtype=bool).copy()
        # Use 1000H alarm-based outage detection instead of audit_log masks.
        # Audit_log STOP/START entries carry over from stale events (90-day lookback)
        # and falsely mask slots.  Only alarm 0x1000 on ALL nodes of an inverter
        # indicates a true inverter outage.
        inverter_outage_mask = _build_1000h_inverter_outage_mask(day).copy()
        cap_dispatch_mask = np.asarray(constraint_meta.get("cap_dispatch_mask"), dtype=bool).copy()
        rad_arr = pd.to_numeric(feature_frame["rad"], errors="coerce").fillna(0.0).values

        # ── Outage-aware slot masking with Solcast est_actual reconstruction ──
        # When inverters are offline (outage), actual generation is artificially low.
        # Solcast estimated actuals (satellite-derived) represent what the plant SHOULD
        # have generated under actual irradiance conditions — use these to reconstruct
        # outage slots instead of discarding them.
        outage_mask = _detect_outage_slots(day)
        outage_severity = _classify_day_outage_severity(day, outage_mask)
        outage_solar_count = int(np.count_nonzero(outage_mask[SOLAR_START_SLOT:SOLAR_END_SLOT]))

        # Extract Solcast estimated actuals for outage reconstruction
        est_actual_kwh = np.asarray(snapshot.get("est_actual_kwh", np.zeros(SLOTS_DAY)), dtype=float)
        est_actual_available = (est_actual_kwh > 0.0) & solar_slot_mask

        # Combined outage: both availability-based and 1000H alarm-based
        combined_outage = inverter_outage_mask | outage_mask
        outage_with_est = combined_outage & est_actual_available
        outage_reconstructed_count = int(np.count_nonzero(outage_with_est[SOLAR_START_SLOT:SOLAR_END_SLOT]))

        if outage_severity == "severe":
            if outage_solar_count > 0 and outage_reconstructed_count < int(outage_solar_count * EST_ACTUAL_RECOVER_MIN):
                log.warning(
                    "  Reject %s - severe outage (%d solar slots), insufficient est_actual coverage (%d/%d)",
                    day, outage_solar_count, outage_reconstructed_count, outage_solar_count,
                )
                continue
            log.info(
                "  Recover %s - severe outage (%d slots) compensated with Solcast est_actual (%d slots)",
                day, outage_solar_count, outage_reconstructed_count,
            )

        # PHASE 1: Use Solcast mid for cap_dispatch reconstruction instead of history_baseline
        actual_effective = np.asarray(actual, dtype=float).copy()
        actual_effective[cap_dispatch_mask] = solcast_mid_kwh[cap_dispatch_mask]

        # Reconstruct outage slots with Solcast estimated actuals
        actual_effective[outage_with_est] = est_actual_kwh[outage_with_est]
        if outage_reconstructed_count > 0:
            log.info(
                "  %s  est_actual reconstruction: %d outage slots filled (severity=%s)",
                day, outage_reconstructed_count, outage_severity,
            )

        actual_eval = actual_effective.copy()
        # Fill remaining gaps: prefer est_actual, fall back to solcast_mid
        gap_mask = (~actual_present_arr) | (combined_outage & ~outage_with_est)
        actual_eval[gap_mask] = solcast_mid_kwh[gap_mask]
        # PHASE 1: Training residual is now actual - solcast_mid instead of actual - physics
        residual = np.clip(actual_effective - solcast_mid_kwh, -500.0, 500.0)
        curtailed = curtailed_mask(actual_effective, history_baseline)

        stats = analyse_weather_day(day, w5, actual_eval)
        # PHASE 1: Pass solcast_mid_kwh to training_day_rejection instead of history_baseline
        bad, reason = training_day_rejection(stats, actual_eval, solcast_mid=solcast_mid_kwh)
        if bad:
            log.warning("  Reject %s - %s", day, reason)
            continue

        # PHASE 1: Reference solcast_mid in usable_mask instead of history_baseline
        # Allow outage slots that were reconstructed with Solcast est_actual
        effective_present = actual_present_arr | outage_with_est
        unreconstructed_outage = combined_outage & ~outage_with_est
        usable_mask = (
            solar_slot_mask
            & effective_present
            & (~unreconstructed_outage)
            & (solcast_mid_kwh > 0.0)
            & (rad_arr >= RAD_MIN_WM2)
        )
        usable_slots = int(np.count_nonzero(usable_mask))
        if usable_slots < MIN_SAMPLES:
            log.warning("  Reject %s - too few usable unconstrained slots (%d)", day, usable_slots)
            continue

        # Exclude extreme weather days (typhoon/severe monsoon) from training
        _actual_solar = np.asarray(actual, dtype=float)[SOLAR_START_SLOT:SOLAR_END_SLOT]
        _solcast_solar = np.zeros(SOLAR_END_SLOT - SOLAR_START_SLOT, dtype=float)
        if snapshot is not None:
            _sc_arr = np.asarray(snapshot.get("forecast_kwh", []), dtype=float)
            if _sc_arr.size == SLOTS_DAY:
                _solcast_solar = _sc_arr[SOLAR_START_SLOT:SOLAR_END_SLOT]
        if _is_extreme_weather_day(_actual_solar, _solcast_solar):
            log.info("  Reject %s - extreme weather event (typhoon/severe monsoon)", day)
            continue

        training_usable_mask = usable_mask & (~curtailed)
        training_feature_frame = feature_frame.loc[training_usable_mask, FEATURE_COLS].reset_index(drop=True)
        training_residual = residual[training_usable_mask]
        # PHASE 1: Normalize against solcast_mid baseline instead of hybrid_baseline
        training_class_scale = _error_class_normalizer(
            training_residual,
            baseline_kwh=np.asarray(solcast_mid_kwh, dtype=float)[training_usable_mask],
        )

        history.append({
            "day": day,
            "days_ago": days_ago,
            "actual": np.asarray(actual, dtype=float),
            "actual_present": actual_present_arr,
            "actual_effective": actual_effective,
            "weather": w5,
            "baseline": np.asarray(baseline, dtype=float),
            "hybrid_baseline": np.asarray(history_baseline, dtype=float),
            "solcast_mid_kwh": np.asarray(solcast_mid_kwh, dtype=float),  # PHASE 1: Store Solcast mid reference
            "residual": residual,
            "feature_frame": feature_frame,
            "slot_weather_buckets": slot_weather_buckets,
            "training_usable_mask": training_usable_mask,
            "training_feature_frame": training_feature_frame,
            "training_residual": training_residual,
            "training_class_scale": training_class_scale,
            "training_slot_count": int(np.count_nonzero(training_usable_mask)),
            "stats": stats,
            "season": _season_bucket_from_day(day),
            "day_regime": classify_day_regime(stats),
            "first_active_slot": _find_first_active_slot(actual_effective),
            "last_active_slot": _find_last_active_slot(actual_effective),
            "solcast_snapshot": snapshot,
            "solcast_prior": solcast_prior,
            "used_solcast": bool(hybrid_meta.get("used_solcast")),
            "operational_mask": np.asarray(constraint_meta.get("operational_mask"), dtype=bool).copy(),
            "cap_dispatch_mask": cap_dispatch_mask,
            "manual_constraint_mask": np.asarray(constraint_meta.get("manual_constraint_mask"), dtype=bool).copy(),
            "inverter_outage_mask": inverter_outage_mask,
            "commanded_off_nodes": np.asarray(constraint_meta.get("commanded_off_nodes"), dtype=int).copy(),
            "cap_dispatched_off_nodes": np.asarray(constraint_meta.get("cap_dispatched_off_nodes"), dtype=int).copy(),
            "manual_off_nodes": np.asarray(constraint_meta.get("manual_off_nodes"), dtype=int).copy(),
            "operational_slot_count": int(constraint_meta.get("operational_slot_count", 0)),
            "cap_dispatch_slot_count": int(constraint_meta.get("cap_dispatch_slot_count", 0)),
            "manual_constraint_slot_count": int(constraint_meta.get("manual_constraint_slot_count", 0)),
            "event_count": int(constraint_meta.get("event_count", 0)),
            "usable_slots": usable_slots,
            "outage_mask": outage_mask,
            "outage_severity": outage_severity,
            "outage_solar_slot_count": outage_solar_count,
            "est_actual_reconstructed_mask": outage_with_est.copy(),
            "est_actual_reconstructed_count": outage_reconstructed_count,
            "actual_source": actual_source,
        })
        log.info(
            "  History %s  sky=%-14s  usable=%d  manual_slots=%d  cap_slots=%d  outage=%s(%d)  est_recon=%d  solcast=%s",
            day,
            stats["sky_class"],
            usable_slots,
            int(constraint_meta.get("manual_constraint_slot_count", 0)),
            int(constraint_meta.get("cap_dispatch_slot_count", 0)),
            outage_severity,
            outage_solar_count,
            outage_reconstructed_count,
            "yes" if hybrid_meta.get("used_solcast") else "no",
        )

    log.info("History basis accepted: %d day(s)", len(history))
    return history

def _sustained_activity_mask(
    values: np.ndarray,
    capacity_slot_kwh: float,
    activation_fraction: float = ACTIVITY_V2_ACTIVATION_FRACTION,
    deactivation_fraction: float = ACTIVITY_V2_DEACTIVATION_FRACTION,
    sustain_slots: int = ACTIVITY_V2_SUSTAIN_SLOTS,
) -> np.ndarray:
    """Energy-derived activity with sustained activation/deactivation hysteresis."""
    arr = np.clip(np.asarray(values, dtype=float), 0.0, None)
    out = np.zeros(SLOTS_DAY, dtype=bool)
    if arr.size != SLOTS_DAY or capacity_slot_kwh <= 0:
        return out
    on_threshold = max(0.05, float(capacity_slot_kwh) * float(activation_fraction))
    off_threshold = max(0.02, float(capacity_slot_kwh) * float(deactivation_fraction))
    sustain = max(1, int(sustain_slots))
    active = False
    above_run = 0
    below_run = 0
    for slot in range(SOLAR_START_SLOT, SOLAR_END_SLOT):
        value = float(arr[slot])
        if not active:
            above_run = above_run + 1 if value >= on_threshold else 0
            if above_run >= sustain:
                active = True
                start = slot - sustain + 1
                out[start:slot + 1] = True
                below_run = 0
        else:
            out[slot] = True
            below_run = below_run + 1 if value < off_threshold else 0
            if below_run >= sustain:
                start = slot - sustain + 1
                out[start:slot + 1] = False
                active = False
                above_run = 0
    return out

def _build_capacity_weighted_activity_profiles(
    history_days: list[dict],
) -> tuple[dict, dict[str, int]]:
    """Build artifact-v2 activity profiles from per-inverter integrated energy.

    The profile is intentionally artifact-only until rolling-origin ablation
    promotes it. Every input date comes from the supplied historical basis and
    is therefore strictly earlier than the caller's forecast target.
    """
    inv_map = _get_inverter_node_map()
    capacities = {
        int(inv): max(1, len(nodes)) * float(NODE_KW_DEPENDABLE)
        for inv, nodes in inv_map.items()
    }
    total_capacity = float(sum(capacities.values()))
    rejection_reasons: dict[str, int] = {}
    accepted_profiles: list[np.ndarray] = []
    per_inverter_profiles: dict[int, list[np.ndarray]] = {}

    def reject(reason: str) -> None:
        rejection_reasons[reason] = int(rejection_reasons.get(reason, 0)) + 1

    if total_capacity <= 0:
        return {}, {"missing_ipconfig_capacity": max(1, len(history_days))}

    for sample in history_days:
        day = str(sample.get("day") or "")
        if not day:
            reject("missing_day")
            continue
        per_inv = _load_inverter_energy_for_day(day)
        represented = [inv for inv in capacities if inv in per_inv]
        coverage = _load_energy_reporting_coverage(day)
        if np.mean(coverage[SOLAR_START_SLOT:SOLAR_END_SLOT]) < ACTIVITY_V2_MIN_DAY_COVERAGE:
            reject("insufficient_capacity_coverage")
            continue
        cap_dispatch = np.asarray(sample.get("cap_dispatch_mask", np.zeros(SLOTS_DAY)), dtype=bool).copy()
        outage = np.asarray(sample.get("inverter_outage_mask", np.zeros(SLOTS_DAY)), dtype=bool).copy()
        if np.any(cap_dispatch[SOLAR_START_SLOT:SOLAR_END_SLOT]):
            reject("cap_dispatch_day")
            continue
        if np.any(outage[SOLAR_START_SLOT:SOLAR_END_SLOT]):
            reject("confirmed_outage_day")
            continue

        weighted = np.zeros(SLOTS_DAY, dtype=float)
        for inv in represented:
            capacity_kw = float(capacities[inv])
            activity = _sustained_activity_mask(
                per_inv[inv], capacity_kw * SLOT_HOURS
            )
            weighted += activity.astype(float) * capacity_kw
            per_inverter_profiles.setdefault(inv, []).append(activity.astype(float))

        valid_slots = coverage >= ACTIVITY_V2_MIN_DAY_COVERAGE
        day_profile = np.clip(weighted / total_capacity, 0.0, 1.0)
        day_profile = np.where(valid_slots, day_profile, np.nan)
        accepted_profiles.append(day_profile)

    if not accepted_profiles:
        return {}, rejection_reasons
    matrix = np.vstack(accepted_profiles)

    with warnings.catch_warnings():
        warnings.simplefilter("ignore", category=RuntimeWarning)
        default_profile = np.nanmedian(matrix, axis=0)
        uncertainty = float(np.nanmean(np.nanstd(matrix[:, SOLAR_START_SLOT:SOLAR_END_SLOT], axis=0)))

    if np.isnan(default_profile[SOLAR_START_SLOT:SOLAR_END_SLOT]).any():
        rejection_reasons["nan_cascaded_profile"] = 1
        return {}, rejection_reasons

    per_inverter = {}
    for inv, rows in per_inverter_profiles.items():
        inv_matrix = np.vstack(rows)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", category=RuntimeWarning)
            inv_profile = np.nanmedian(inv_matrix, axis=0)
            inv_uncertainty = float(np.nanmean(np.nanstd(inv_matrix, axis=0)))
        per_inverter[str(inv)] = {
            "active_capacity_fraction": inv_profile,
            "support_count": int(inv_matrix.shape[0]),
            "uncertainty": inv_uncertainty,
        }
    return {
        "default": {
            "active_capacity_fraction": default_profile,
            "support_count": int(matrix.shape[0]),
            "uncertainty": uncertainty,
        },
        "per_inverter": per_inverter,
    }, rejection_reasons

def build_forecast_artifacts(history_days: list[dict]) -> dict:
    """Build derived artifacts for activity gating.

    NOTE (v2.8 cleanup): Previously also built `shape_records` for hour-shape
    correction. Phase 4 (Solcast as 100% baseline) made hour-shape correction
    structurally unreachable, so the shape_records pipeline was removed.
    Older artifacts on disk may still contain a `shape_records` key — it is
    silently ignored by the loader.
    """
    activity_records = []

    for sample in history_days:
        day = str(sample["day"])
        # Use 1000H alarm-based outage mask instead of stale audit_log manual_constraint_mask
        inverter_outage_mask = np.asarray(sample.get("inverter_outage_mask"), dtype=bool) if sample.get("inverter_outage_mask") is not None else _build_1000h_inverter_outage_mask(str(sample["day"])).copy()
        stats = sample["stats"]
        first_slot = sample.get("first_active_slot")
        last_slot = sample.get("last_active_slot")

        if (
            first_slot is not None
            and last_slot is not None
            and not np.any(inverter_outage_mask[SOLAR_START_SLOT:SOLAR_END_SLOT])
        ):
            activity_records.append({
                "day": day,
                "days_ago": int(sample["days_ago"]),
                "season": sample.get("season") or _season_bucket_from_day(day),
                "sky_class": stats.get("sky_class"),
                "rainy": bool(stats.get("rainy")),
                "cloud_mean": float(stats.get("cloud_mean", 0.0)),
                "rh_mean": float(stats.get("rh_mean", 0.0)),
                "vol_index": float(stats.get("vol_index", 0.0)),
                "first_slot": int(first_slot),
                "last_slot": int(last_slot),
            })

    capacity_profiles, rejection_reasons = _build_capacity_weighted_activity_profiles(history_days)
    history_dates = sorted(str(s.get("day")) for s in history_days if s.get("day"))
    return {
        "schema_version": 2,
        "created_ts": int(time.time()),
        "training_cutoff_date": history_dates[-1] if history_dates else None,
        "training_basis": "actual archived weather + cleaned actual generation",
        "lookback_days": int(SHAPE_LOOKBACK_DAYS),
        "history_days": int(len(history_days)),
        "accepted_days": int((capacity_profiles.get("default") or {}).get("support_count", 0)),
        "rejected_days": int(sum(rejection_reasons.values())),
        "rejection_reasons": rejection_reasons,
        "activity_records": activity_records,
        "capacity_weighted_profiles": capacity_profiles,
    }

def _validate_forecast_artifact(artifact: dict, target_date: date | None = None) -> tuple[bool, str | None]:
    if not isinstance(artifact, dict):
        return False, "not_a_dict"
    schema_version = artifact.get("schema_version", 1)
    if type(schema_version) is not int:
        return False, "invalid_schema_version"
    if schema_version not in (1, 2):
        return False, "unsupported_schema_version"
    if schema_version == 1:
        records = artifact.get("activity_records", [])
        return (True, None) if isinstance(records, list) else (False, "invalid_activity_records")

    cutoff_raw = artifact.get("training_cutoff_date")
    try:
        cutoff = datetime.strptime(str(cutoff_raw), "%Y-%m-%d").date()
    except Exception:
        return False, "invalid_training_cutoff_date"
    if target_date is not None and cutoff >= target_date:
        return False, "training_cutoff_not_before_target"
    profiles = artifact.get("capacity_weighted_profiles")
    if not isinstance(profiles, dict) or not isinstance(profiles.get("default"), dict):
        return False, "missing_default_capacity_profile"

    def _validate_profile(profile: dict, label: str) -> tuple[bool, str | None]:
        try:
            support = int(profile.get("support_count", 0))
            values = np.asarray(profile.get("active_capacity_fraction"), dtype=float).reshape(-1)
            uncertainty = float(profile.get("uncertainty", 0.0))
        except Exception:
            return False, f"invalid_{label}_profile"
        if support <= 0:
            return False, f"invalid_{label}_support"
        if values.size != SLOTS_DAY or not np.all(np.isfinite(values)):
            return False, f"invalid_{label}_shape"
        if np.any(values < 0.0) or np.any(values > 1.0) or not math.isfinite(uncertainty) or uncertainty < 0.0:
            return False, f"invalid_{label}_bounds"
        return True, None

    valid, reason = _validate_profile(profiles["default"], "default")
    if not valid:
        return valid, reason
    per_inverter = profiles.get("per_inverter", {})
    if not isinstance(per_inverter, dict):
        return False, "invalid_per_inverter_profiles"
    for inverter, profile in per_inverter.items():
        if not isinstance(profile, dict):
            return False, f"invalid_inverter_{inverter}_profile"
        valid, reason = _validate_profile(profile, f"inverter_{inverter}")
        if not valid:
            return valid, reason
    if "activity_records" in artifact and not isinstance(artifact.get("activity_records"), list):
        return False, "invalid_activity_records"
    return True, None

def save_forecast_artifacts(artifact: dict) -> bool:
    temp_file: Path | None = None
    try:
        valid, reason = _validate_forecast_artifact(artifact, target_date=datetime.now(_TZ_UTC8).date())
        if not valid:
            raise ValueError(f"invalid artifact: {reason}")
        ARTIFACT_FILE.parent.mkdir(parents=True, exist_ok=True)
        temp_file = ARTIFACT_FILE.with_name(f".{ARTIFACT_FILE.name}.{uuid.uuid4().hex}.tmp")
        dump(artifact, temp_file)

        # Re-open and fully validate the serialised representation before an
        # atomic replacement.  A unique temp name makes concurrent rebuilds
        # independent and the finally block guarantees cleanup on any failure.
        test_load = load(temp_file)
        valid, reason = _validate_forecast_artifact(test_load, target_date=datetime.now(_TZ_UTC8).date())
        if not valid:
            raise ValueError(f"serialised artifact failed validation: {reason}")
        os.replace(temp_file, ARTIFACT_FILE)
        return True
    except Exception as e:
        log.error("Artifact save failed %s: %s", ARTIFACT_FILE, e)
        return False
    finally:
        if temp_file is not None:
            try:
                temp_file.unlink(missing_ok=True)
            except Exception:
                pass

def load_forecast_artifacts(today: date | None = None, allow_build: bool = False) -> dict | None:
    if ARTIFACT_FILE.exists():
        try:
            data = load(ARTIFACT_FILE)
            if isinstance(data, dict):
                valid, reason = _validate_forecast_artifact(data, target_date=today)
                if valid:
                    return data
                log.warning("Forecast artifact rejected [%s]: %s", ARTIFACT_FILE, reason)
        except Exception as e:
            log.warning("Artifact load failed %s: %s", ARTIFACT_FILE, e)

    if allow_build and today is not None:
        solcast_reliability = build_solcast_reliability_artifact(today)
        history_days = collect_history_days(
            today,
            SHAPE_LOOKBACK_DAYS,
            solcast_reliability=solcast_reliability,
        )
        if not history_days:
            return None
        artifact = build_forecast_artifacts(history_days)
        if not save_forecast_artifacts(artifact):
            return None
        try:
            persisted = load(ARTIFACT_FILE)
            valid, reason = _validate_forecast_artifact(persisted, target_date=today)
            if isinstance(persisted, dict) and valid:
                return persisted
            log.warning("Rebuilt forecast artifact failed persisted validation: %s", reason)
        except Exception as exc:
            log.warning("Rebuilt forecast artifact reload failed: %s", exc)
        return None

    return None

def _weather_frame_to_records(df: pd.DataFrame) -> list[dict]:
    if df is None or df.empty:
        return []
    cols = [
        "time",
        "rad",
        "rad_direct",
        "rad_diffuse",
        "cloud",
        "cloud_low",
        "cloud_mid",
        "cloud_high",
        "temp",
        "rh",
        "wind",
        "precip",
        "cape",
    ]
    frame = df.copy()
    if "time" in frame.columns:
        frame["time"] = pd.to_datetime(frame["time"], errors="coerce")
    def safe_num(value) -> float:
        try:
            num = float(pd.to_numeric(value, errors="coerce"))
        except Exception:
            return 0.0
        return num if math.isfinite(num) else 0.0
    out = []
    for _, row in frame.iterrows():
        time_value = row.get("time")
        if pd.isna(time_value):
            continue
        rec = {"time": pd.Timestamp(time_value).strftime("%Y-%m-%d %H:%M:%S")}
        for col in cols[1:]:
            rec[col] = round(safe_num(row.get(col)), 6)
        out.append(rec)
    return out

def _weather_records_to_frame(records: list[dict], day: str) -> pd.DataFrame:
    if not isinstance(records, list) or not records:
        return pd.DataFrame()
    rows = []
    for rec in records:
        if not isinstance(rec, dict):
            continue
        rows.append({
            "time": pd.to_datetime(rec.get("time"), errors="coerce"),
            "rad": pd.to_numeric(rec.get("rad"), errors="coerce"),
            "rad_direct": pd.to_numeric(rec.get("rad_direct"), errors="coerce"),
            "rad_diffuse": pd.to_numeric(rec.get("rad_diffuse"), errors="coerce"),
            "cloud": pd.to_numeric(rec.get("cloud"), errors="coerce"),
            "cloud_low": pd.to_numeric(rec.get("cloud_low"), errors="coerce"),
            "cloud_mid": pd.to_numeric(rec.get("cloud_mid"), errors="coerce"),
            "cloud_high": pd.to_numeric(rec.get("cloud_high"), errors="coerce"),
            "temp": pd.to_numeric(rec.get("temp"), errors="coerce"),
            "rh": pd.to_numeric(rec.get("rh"), errors="coerce"),
            "wind": pd.to_numeric(rec.get("wind"), errors="coerce"),
            "precip": pd.to_numeric(rec.get("precip"), errors="coerce"),
            "cape": pd.to_numeric(rec.get("cape"), errors="coerce"),
        })
    frame = pd.DataFrame(rows)
    if frame.empty:
        return frame
    return _slice_weather_day(frame, day)

def forecast_snapshot_path(day: str) -> Path:
    return FORECAST_SNAPSHOT_DIR / f"{str(day).strip()}.json"

def weather_day_signature(day: str, hourly_df: pd.DataFrame) -> dict:
    w5 = interpolate_5min(hourly_df, day)
    stats = analyse_weather_day(day, w5)
    return {
        "day": str(day),
        "season": _season_bucket_from_day(day),
        "day_regime": classify_day_regime(stats),
        "sky_class": stats.get("sky_class"),
        "cloud_mean": float(stats.get("cloud_mean", 0.0)),
        "rad_peak": float(stats.get("rad_peak", 0.0)),
        "vol_index": float(stats.get("vol_index", 0.0)),
        "rh_mean": float(stats.get("rh_mean", 0.0)),
        "rainy": bool(stats.get("rainy", False)),
        "convective": bool(stats.get("convective", False)),
    }

def save_forecast_weather_snapshot(
    day: str,
    raw_hourly: pd.DataFrame,
    applied_hourly: pd.DataFrame | None = None,
    provider: str = "open-meteo",
    meta: dict | None = None,
) -> bool:
    payload = {
        "day": str(day),
        "provider": str(provider or "open-meteo"),
        "saved_ts": int(time.time()),
        "raw_hourly": _weather_frame_to_records(raw_hourly),
        "applied_hourly": _weather_frame_to_records(applied_hourly if applied_hourly is not None else raw_hourly),
        "signature": weather_day_signature(day, raw_hourly),
        "applied_signature": weather_day_signature(day, applied_hourly if applied_hourly is not None else raw_hourly),
        "meta": dict(meta or {}),
    }
    return _save_json(forecast_snapshot_path(day), payload)

def load_forecast_weather_snapshot(day: str) -> dict | None:
    payload = _load_json(forecast_snapshot_path(day))
    return payload if isinstance(payload, dict) and payload else None

def update_forecast_weather_snapshot_meta(day: str, updates: dict | None) -> bool:
    if not updates:
        return False
    payload = load_forecast_weather_snapshot(day)
    if not payload or not isinstance(payload, dict):
        return False
    meta = payload.get("meta") if isinstance(payload.get("meta"), dict) else {}
    meta.update(dict(updates))
    payload["meta"] = meta
    return _save_json(forecast_snapshot_path(day), payload)

def _weather_bias_frame_5min(df: pd.DataFrame, day: str) -> pd.DataFrame:
    frame = _slice_weather_day(df, day)
    if frame.empty:
        return pd.DataFrame()
    w5 = interpolate_5min(frame, day)
    ok, reason = validate_weather_5min(day, w5)
    if not ok:
        log.warning("Weather-bias 5-minute frame invalid [%s]: %s", day, reason)
        return pd.DataFrame()
    return w5

def _weather_bias_slot_series_from_record(record: dict, key: str, default: float = 0.0) -> np.ndarray:
    raw = np.asarray(record.get(key, []), dtype=float).reshape(-1)
    if raw.size == SOLAR_SLOTS:
        return raw.astype(float)
    if raw.size == SLOTS_DAY:
        return raw[SOLAR_START_SLOT:SOLAR_END_SLOT].astype(float)

    legacy_hour_points = SOLAR_END_H - SOLAR_START_H
    if raw.size == legacy_hour_points:
        return np.repeat(raw.astype(float), 60 // SLOT_MIN)[:SOLAR_SLOTS]

    if raw.size <= 0:
        return np.full(SOLAR_SLOTS, default, dtype=float)

    src_idx = np.linspace(0.0, 1.0, num=raw.size)
    dst_idx = np.linspace(0.0, 1.0, num=SOLAR_SLOTS)
    return np.interp(dst_idx, src_idx, raw.astype(float)).astype(float)

def build_weather_bias_artifact(today: date, lookback_days: int = WEATHER_BIAS_LOOKBACK_DAYS) -> dict:
    records = []
    for days_ago in range(1, lookback_days + 1):
        day = (today - timedelta(days=days_ago)).isoformat()
        snap = load_forecast_weather_snapshot(day)
        if not snap:
            continue
        raw_hourly = _weather_records_to_frame(list(snap.get("raw_hourly") or []), day)
        if raw_hourly.empty:
            continue
        actual_hourly = fetch_weather(day, source="archive")
        if actual_hourly is None or actual_hourly.empty:
            continue
        raw_w5 = _weather_bias_frame_5min(raw_hourly, day)
        actual_w5 = _weather_bias_frame_5min(actual_hourly, day)
        if raw_w5.empty or actual_w5.empty:
            continue

        raw_sig = snap.get("signature") if isinstance(snap.get("signature"), dict) else weather_day_signature(day, raw_hourly)
        actual_sig = weather_day_signature(day, actual_hourly)
        solar_slice = slice(SOLAR_START_SLOT, SOLAR_END_SLOT)
        forecast_rad = np.clip(
            pd.to_numeric(raw_w5["rad"], errors="coerce").fillna(0.0).values[solar_slice],
            0.0,
            None,
        )
        actual_rad = np.clip(
            pd.to_numeric(actual_w5["rad"], errors="coerce").fillna(0.0).values[solar_slice],
            0.0,
            None,
        )
        forecast_cloud = np.clip(
            pd.to_numeric(raw_w5["cloud"], errors="coerce").fillna(0.0).values[solar_slice],
            0.0,
            100.0,
        )
        actual_cloud = np.clip(
            pd.to_numeric(actual_w5["cloud"], errors="coerce").fillna(0.0).values[solar_slice],
            0.0,
            100.0,
        )

        rad_ratio = np.ones_like(forecast_rad, dtype=float)
        for idx, (f_rad, a_rad) in enumerate(zip(forecast_rad, actual_rad)):
            if f_rad < 30.0 and a_rad < 30.0:
                rad_ratio[idx] = 1.0
            elif f_rad < 30.0:
                rad_ratio[idx] = float(np.clip(1.0 + ((a_rad - f_rad) / 180.0), 0.80, 1.35))
            else:
                rad_ratio[idx] = float(np.clip(a_rad / max(f_rad, 1.0), 0.55, 1.55))

        cloud_delta = np.clip(actual_cloud - forecast_cloud, -38.0, 38.0)
        mean_ratio_error = float(np.mean(np.abs(rad_ratio - 1.0))) if rad_ratio.size else 0.0
        mean_cloud_error = float(np.mean(np.abs(cloud_delta))) if cloud_delta.size else 0.0
        confidence = float(np.clip(1.0 - 0.55 * mean_ratio_error - 0.006 * mean_cloud_error, 0.55, 1.0))

        forecast_start = next((idx for idx, value in enumerate(forecast_rad) if value >= STARTUP_RAD_WM2), None)
        actual_start = next((idx for idx, value in enumerate(actual_rad) if value >= STARTUP_RAD_WM2), None)
        morning_shift_slots = 0.0
        if forecast_start is not None and actual_start is not None:
            morning_shift_slots = float(actual_start - forecast_start)

        records.append({
            "day": day,
            "days_ago": int(days_ago),
            "season": raw_sig.get("season") or _season_bucket_from_day(day),
            "forecast_regime": raw_sig.get("day_regime") or classify_day_regime(raw_sig),
            "actual_regime": actual_sig.get("day_regime") or classify_day_regime(actual_sig),
            "cloud_mean": float(raw_sig.get("cloud_mean", 0.0)),
            "rad_peak": float(raw_sig.get("rad_peak", 0.0)),
            "vol_index": float(raw_sig.get("vol_index", 0.0)),
            "rh_mean": float(raw_sig.get("rh_mean", 0.0)),
            "confidence": confidence,
            "morning_shift_slots": float(np.clip(morning_shift_slots, -24.0, 24.0)),
            "rad_ratio": rad_ratio.astype(np.float32),
            "cloud_delta": cloud_delta.astype(np.float32),
        })

    return {
        "created_ts": int(time.time()),
        "lookback_days": int(lookback_days),
        "resolution_minutes": int(SLOT_MIN),
        "slot_start": int(SOLAR_START_SLOT),
        "slot_end": int(SOLAR_END_SLOT),
        "slot_count": int(SOLAR_SLOTS),
        "record_count": int(len(records)),
        "records": records,
    }

def save_weather_bias_artifact(artifact: dict) -> bool:
    try:
        WEATHER_BIAS_FILE.parent.mkdir(parents=True, exist_ok=True)
        dump(artifact, WEATHER_BIAS_FILE)
        return True
    except Exception as e:
        log.error("Weather-bias artifact save failed %s: %s", WEATHER_BIAS_FILE, e)
        return False

def load_weather_bias_artifact(today: date | None = None, allow_build: bool = False) -> dict | None:
    if WEATHER_BIAS_FILE.exists():
        try:
            data = load(WEATHER_BIAS_FILE)
            if isinstance(data, dict):
                if _weather_bias_artifact_needs_upgrade(data):
                    if allow_build and today is not None:
                        log.info(
                            "Weather-bias artifact uses legacy resolution; rebuilding at %d-minute solar slots.",
                            SLOT_MIN,
                        )
                        artifact = build_weather_bias_artifact(today)
                        save_weather_bias_artifact(artifact)
                        return artifact
                    log.warning(
                        "Weather-bias artifact uses legacy hourly resolution; compatibility upsampling will be used until rebuilt."
                    )
                return data
        except Exception as e:
            log.warning("Weather-bias artifact load failed %s: %s", WEATHER_BIAS_FILE, e)

    if allow_build and today is not None:
        artifact = build_weather_bias_artifact(today)
        save_weather_bias_artifact(artifact)
        return artifact

    return None

def _weather_bias_artifact_needs_upgrade(artifact: dict | None) -> bool:
    if not isinstance(artifact, dict):
        return True
    if int(artifact.get("resolution_minutes", 0) or 0) != int(SLOT_MIN):
        return True
    if int(artifact.get("slot_count", 0) or 0) != int(SOLAR_SLOTS):
        return True

    for record in list(artifact.get("records") or []):
        rad_ratio = np.asarray(record.get("rad_ratio", []), dtype=float).reshape(-1)
        cloud_delta = np.asarray(record.get("cloud_delta", []), dtype=float).reshape(-1)
        if rad_ratio.size != SOLAR_SLOTS or cloud_delta.size != SOLAR_SLOTS:
            return True
    return False

def _weather_bias_similarity_score(record: dict, target: dict) -> float:
    score = 0.0
    if record.get("season") != target.get("season"):
        score += 0.55
    if record.get("forecast_regime") != target.get("day_regime"):
        score += 1.05
    score += abs(float(record.get("cloud_mean", 0.0)) - float(target.get("cloud_mean", 0.0))) / 26.0
    score += abs(float(record.get("rad_peak", 0.0)) - float(target.get("rad_peak", 0.0))) / 420.0
    score += abs(float(record.get("vol_index", 0.0)) - float(target.get("vol_index", 0.0))) / 0.18
    score += abs(float(record.get("rh_mean", 0.0)) - float(target.get("rh_mean", 0.0))) / 22.0
    score += min(float(record.get("days_ago", WEATHER_BIAS_LOOKBACK_DAYS)), float(WEATHER_BIAS_LOOKBACK_DAYS)) / max(float(WEATHER_BIAS_LOOKBACK_DAYS), 1.0) * 0.24
    return score

def apply_weather_bias_adjustment(
    hourly_df: pd.DataFrame,
    day: str,
    artifact: dict | None,
) -> tuple[pd.DataFrame, dict]:
    frame = _slice_weather_day(hourly_df, day)
    default_meta = {
        "matches": 0,
        "avg_score": None,
        "day_regime": None,
        "regime_confidence": 1.0,
        "morning_shift_slots": 0.0,
        "mean_rad_factor": 1.0,
    }
    records = list((artifact or {}).get("records") or [])
    if frame.empty or not records:
        if not frame.empty:
            sig = weather_day_signature(day, frame)
            default_meta["day_regime"] = sig.get("day_regime")
        return frame if not frame.empty else hourly_df.copy(), default_meta

    target = weather_day_signature(day, frame)
    exact = [
        record for record in records
        if record.get("season") == target.get("season") and record.get("forecast_regime") == target.get("day_regime")
    ]
    pool = exact if len(exact) >= WEATHER_BIAS_MIN_MATCHES else records
    scored = []
    for record in pool:
        score = _weather_bias_similarity_score(record, target)
        if math.isfinite(score):
            scored.append((score, record))
    if not scored:
        return frame.copy(), {
            **default_meta,
            "day_regime": target.get("day_regime"),
        }

    scored.sort(key=lambda item: item[0])
    top = scored[:WEATHER_BIAS_TOP_K]
    weights = np.array([1.0 / ((0.25 + score) ** 2) for score, _ in top], dtype=float)
    rad_ratio = np.average(
        np.array(
            [_weather_bias_slot_series_from_record(record, "rad_ratio", 1.0) for _, record in top],
            dtype=float,
        ),
        axis=0,
        weights=weights,
    )
    cloud_delta = np.average(
        np.array(
            [_weather_bias_slot_series_from_record(record, "cloud_delta", 0.0) for _, record in top],
            dtype=float,
        ),
        axis=0,
        weights=weights,
    )
    confidence = float(np.clip(np.average([float(record.get("confidence", 1.0)) for _, record in top], weights=weights), 0.55, 1.0))
    morning_shift = float(np.average([float(record.get("morning_shift_slots", 0.0)) for _, record in top], weights=weights))

    adjusted = _weather_bias_frame_5min(frame, day)
    if adjusted.empty:
        return frame.copy(), {
            **default_meta,
            "day_regime": target.get("day_regime"),
        }

    def safe_num(value) -> float:
        try:
            num = float(pd.to_numeric(value, errors="coerce"))
        except Exception:
            return 0.0
        return num if math.isfinite(num) else 0.0

    if "time" not in adjusted.columns:
        log.warning(
            "Weather-bias 5-minute frame missing time column [%s]; rebuilding synthetic 5-minute timestamps.",
            day,
        )
        adjusted = adjusted.copy()
        adjusted.insert(
            0,
            "time",
            pd.date_range(f"{day} 00:00:00", periods=len(adjusted), freq="5min"),
        )

    adjusted["time"] = pd.to_datetime(adjusted["time"], errors="coerce")
    rad_factors = []
    for idx, row in adjusted.iterrows():
        ts = pd.Timestamp(row["time"])
        slot = int((int(ts.hour) * 60 + int(ts.minute)) // SLOT_MIN)
        if slot < SOLAR_START_SLOT or slot >= SOLAR_END_SLOT:
            continue
        slot_idx = slot - SOLAR_START_SLOT
        raw_factor = 1.0 + WEATHER_BIAS_RAD_BLEND * float(rad_ratio[slot_idx] - 1.0)
        factor = float(np.clip(raw_factor, WEATHER_BIAS_FACTOR_CLIP[0], WEATHER_BIAS_FACTOR_CLIP[1]))
        rad_factors.append(factor)
        for col in ("rad", "rad_direct", "rad_diffuse"):
            adjusted.at[idx, col] = max(0.0, safe_num(row.get(col)) * factor)

        delta = float(
            np.clip(
                WEATHER_BIAS_CLOUD_BLEND * float(cloud_delta[slot_idx]),
                WEATHER_BIAS_CLOUD_DELTA_CLIP[0],
                WEATHER_BIAS_CLOUD_DELTA_CLIP[1],
            )
        )
        base_cloud = safe_num(row.get("cloud"))
        target_cloud = float(np.clip(base_cloud + delta, 0.0, 100.0))
        adjusted.at[idx, "cloud"] = target_cloud
        if base_cloud > 1.0:
            scale = target_cloud / max(base_cloud, 1.0)
            for col in ("cloud_low", "cloud_mid", "cloud_high"):
                adjusted.at[idx, col] = float(np.clip(safe_num(row.get(col)) * scale, 0.0, 100.0))
        else:
            adjusted.at[idx, "cloud_low"] = float(np.clip(safe_num(row.get("cloud_low")) + delta * 0.45, 0.0, 100.0))
            adjusted.at[idx, "cloud_mid"] = float(np.clip(safe_num(row.get("cloud_mid")) + delta * 0.35, 0.0, 100.0))
            adjusted.at[idx, "cloud_high"] = float(np.clip(safe_num(row.get("cloud_high")) + delta * 0.20, 0.0, 100.0))

    return adjusted, {
        "matches": int(len(top)),
        "avg_score": float(np.mean([score for score, _ in top])) if top else None,
        "day_regime": target.get("day_regime"),
        "regime_confidence": confidence,
        "morning_shift_slots": float(np.clip(morning_shift, -24.0, 24.0)),
        "mean_rad_factor": float(np.mean(rad_factors)) if rad_factors else 1.0,
    }

# NOTE (v2.8 cleanup):
# `_shape_similarity_score`, `select_shape_profile`, and `apply_hour_shape_correction`
# were removed in v2.8 because Phase 4 made Solcast the 100% baseline. The hour-shape
# correction branch in run_dayahead is structurally unreachable when used_solcast=True
# (which is now always true), so all three functions plus their backing
# `shape_records` artifact were dead code. The activity-records pipeline below
# (`_activity_similarity_score`, `apply_activity_hysteresis`) is unrelated and stays.

def _activity_similarity_score(record: dict, target: dict) -> float:
    score = 0.0
    if record.get("season") != target.get("season"):
        score += 0.55
    if record.get("sky_class") != target.get("sky_class"):
        score += 0.95
    if bool(record.get("rainy")) != bool(target.get("rainy")):
        score += 0.75
    score += abs(float(record.get("cloud_mean", 0.0)) - float(target.get("cloud_mean", 0.0))) / 30.0
    score += abs(float(record.get("rh_mean", 0.0)) - float(target.get("rh_mean", 0.0))) / 25.0
    score += abs(float(record.get("vol_index", 0.0)) - float(target.get("vol_index", 0.0))) / 0.20
    score += min(float(record.get("days_ago", SHAPE_LOOKBACK_DAYS)), float(SHAPE_LOOKBACK_DAYS)) / max(float(SHAPE_LOOKBACK_DAYS), 1.0) * 0.20
    return score

def estimate_activity_window(
    day: str,
    w5: pd.DataFrame,
    forecast: np.ndarray,
    artifacts: dict | None,
) -> dict:
    stats = analyse_weather_day(day, w5)
    target = {
        "season": _season_bucket_from_day(day),
        "sky_class": stats.get("sky_class"),
        "rainy": bool(stats.get("rainy")),
        "cloud_mean": float(stats.get("cloud_mean", 0.0)),
        "rh_mean": float(stats.get("rh_mean", 0.0)),
        "vol_index": float(stats.get("vol_index", 0.0)),
    }
    records = list((artifacts or {}).get("activity_records") or [])

    forecast_arr = np.clip(np.asarray(forecast, dtype=float), 0.0, None)
    forecast_smooth = _rolling_mean(forecast_arr, 3, center=True)
    rad_smooth = _rolling_mean(pd.to_numeric(w5["rad"], errors="coerce").fillna(0.0).values, 3, center=True)
    threshold = activity_threshold_kwh()

    weather_first = _find_first_active_slot(forecast_smooth, threshold * 0.80, sustain_slots=ACTIVITY_SUSTAIN_SLOTS)
    if weather_first is None:
        for slot in range(SOLAR_START_SLOT, SOLAR_END_SLOT - ACTIVITY_SUSTAIN_SLOTS + 1):
            if (
                float(np.mean(rad_smooth[slot:slot + ACTIVITY_SUSTAIN_SLOTS])) >= STARTUP_RAD_WM2
                and float(np.mean(forecast_smooth[slot:slot + ACTIVITY_SUSTAIN_SLOTS])) >= threshold * 0.55
            ):
                weather_first = slot
                break
    if weather_first is None:
        weather_first = SOLAR_START_SLOT

    weather_last = _find_last_active_slot(forecast_smooth, threshold * 0.70, sustain_slots=ACTIVITY_SUSTAIN_SLOTS)
    if weather_last is None:
        for slot in range(SOLAR_END_SLOT - ACTIVITY_SUSTAIN_SLOTS, SOLAR_START_SLOT - 1, -1):
            if (
                float(np.mean(rad_smooth[slot:slot + ACTIVITY_SUSTAIN_SLOTS])) >= STOPPING_RAD_WM2
                and float(np.mean(forecast_smooth[slot:slot + ACTIVITY_SUSTAIN_SLOTS])) >= threshold * 0.40
            ):
                weather_last = slot + ACTIVITY_SUSTAIN_SLOTS - 1
                break
    if weather_last is None:
        weather_last = SOLAR_END_SLOT - 1

    hist_first = None
    hist_last = None
    match_count = 0
    if records:
        scored = sorted(
            (
                (_activity_similarity_score(record, target), record)
                for record in records
            ),
            key=lambda item: item[0],
        )[:SHAPE_TOP_K]
        if scored:
            weights = np.array([1.0 / ((0.25 + score) ** 2) for score, _ in scored], dtype=float)
            hist_first = float(np.average([record["first_slot"] for _, record in scored], weights=weights))
            hist_last = float(np.average([record["last_slot"] for _, record in scored], weights=weights))
            match_count = len(scored)

    first_slot = int(weather_first)
    last_slot = int(weather_last)
    if hist_first is not None:
        first_slot = int(round(max(weather_first, 0.45 * weather_first + 0.55 * hist_first)))
    if hist_last is not None:
        last_slot = int(round(0.60 * weather_last + 0.40 * hist_last))

    first_slot = int(np.clip(first_slot, SOLAR_START_SLOT, SOLAR_END_SLOT - 1))
    last_slot = int(np.clip(last_slot, first_slot, SOLAR_END_SLOT - 1))
    return {
        "first_slot": first_slot,
        "last_slot": last_slot,
        "weather_first": int(weather_first),
        "weather_last": int(weather_last),
        "history_matches": match_count,
    }

def _redistribute_hour_energy(hour_values: np.ndarray, allowed_mask: np.ndarray, rising: bool) -> np.ndarray:
    values = np.clip(np.asarray(hour_values, dtype=float), 0.0, None)
    allowed = np.asarray(allowed_mask, dtype=bool)
    total = float(values.sum())
    if total <= 0 or not np.any(allowed):
        return np.zeros_like(values)

    weights = values.copy()
    ramp = np.linspace(0.60, 1.25, values.size) if rising else np.linspace(1.25, 0.60, values.size)
    weights = weights * ramp
    weights[~allowed] = 0.0
    if float(weights.sum()) <= 0:
        weights = ramp
        weights[~allowed] = 0.0
    weights = _normalize_profile(weights)
    return total * weights

def apply_activity_hysteresis(
    forecast: np.ndarray,
    day: str,
    w5: pd.DataFrame,
    artifacts: dict | None,
    bias_meta: dict | None = None,
) -> tuple[np.ndarray, dict]:
    out = np.clip(np.asarray(forecast, dtype=float), 0.0, None).copy()
    if float(out.sum()) <= 0:
        return out, {"first_slot": None, "last_slot": None, "history_matches": 0}

    window = estimate_activity_window(day, w5, out, artifacts)
    first_slot = int(window["first_slot"])
    last_slot = int(window["last_slot"])
    morning_shift = float((bias_meta or {}).get("morning_shift_slots", 0.0) or 0.0)
    if abs(morning_shift) > 0.01:
        shift = int(round(np.clip(morning_shift * WEATHER_BIAS_SHIFT_BLEND, -8.0, 8.0)))
        first_slot = int(np.clip(first_slot + shift, SOLAR_START_SLOT, SOLAR_END_SLOT - 1))
        last_slot = max(first_slot, last_slot)
        window["bias_shift_slots"] = shift
    else:
        window["bias_shift_slots"] = 0
    first_hour = first_slot // (60 // SLOT_MIN)
    last_hour = last_slot // (60 // SLOT_MIN)

    out[:first_hour * (60 // SLOT_MIN)] = 0.0
    out[(last_hour + 1) * (60 // SLOT_MIN):] = 0.0

    if first_hour == last_hour:
        start, end = _solar_hour_bounds(first_hour)
        slots = np.arange(start, end)
        allowed = (slots >= first_slot) & (slots <= last_slot)
        out[start:end] = _redistribute_hour_energy(out[start:end], allowed, rising=True)
    else:
        start, end = _solar_hour_bounds(first_hour)
        out[start:end] = _redistribute_hour_energy(out[start:end], np.arange(start, end) >= first_slot, rising=True)
        start, end = _solar_hour_bounds(last_hour)
        out[start:end] = _redistribute_hour_energy(out[start:end], np.arange(start, end) <= last_slot, rising=False)

    out[:first_slot] = 0.0
    out[last_slot + 1:] = 0.0
    return out, window

def apply_block_staging(forecast: np.ndarray, w5: pd.DataFrame) -> tuple[np.ndarray, dict]:
    """
    Add conservative modular pickup at low power while preserving hourly totals.

    This does not fully quantize the plant. It only nudges low-power periods
    toward node-like staging so dawn and dusk do not stay perfectly smooth.
    """
    out = np.clip(np.asarray(forecast, dtype=float), 0.0, None)
    staged = out.copy()
    node_count = max(1, plant_node_count())
    node_step = max(node_slot_kwh(), 0.1)
    stage_limit = slot_cap_kwh(True) * LOW_POWER_STAGE_FRACTION
    threshold = activity_threshold_kwh()
    if stage_limit <= 0:
        return out.copy(), {"node_step_kwh": node_step, "staged_slots": 0}

    rad = _rolling_mean(pd.to_numeric(w5["rad"], errors="coerce").fillna(0.0).values, 3, center=True)
    active_nodes = 0
    staged_slots = 0

    for slot in range(SOLAR_START_SLOT, SOLAR_END_SLOT):
        value = float(out[slot])
        if value <= 0:
            active_nodes = 0
            staged[slot] = 0.0
            continue
        if value > stage_limit:
            active_nodes = min(node_count, max(active_nodes, int(round(value / node_step))))
            staged[slot] = value
            continue

        desired_nodes = int(np.clip(round(value / node_step), 0, node_count))
        if value >= threshold and desired_nodes < 1:
            desired_nodes = 1

        if desired_nodes > active_nodes:
            active_nodes = desired_nodes
        elif desired_nodes < active_nodes - 1:
            active_nodes = desired_nodes
        elif desired_nodes == 0 and value < threshold * 0.85 and rad[slot] < STARTUP_RAD_WM2 * 0.60:
            active_nodes = 0

        staged_value = active_nodes * node_step
        blend = STAGING_BLEND_MAX * np.clip(1.0 - (value / max(stage_limit, 1e-6)), 0.0, 1.0)
        staged[slot] = (1.0 - blend) * value + blend * staged_value
        staged_slots += 1

    for hour in range(SOLAR_START_H, SOLAR_END_H):
        start, end = _solar_hour_bounds(hour)
        orig_total = float(out[start:end].sum())
        new_total = float(staged[start:end].sum())
        if orig_total > 0 and new_total > 0:
            staged[start:end] *= orig_total / new_total

    staged[:SOLAR_START_SLOT] = 0.0
    staged[SOLAR_END_SLOT:] = 0.0
    return staged, {
        "node_step_kwh": float(node_step),
        "staged_slots": int(staged_slots),
    }

# ============================================================================
# MODEL TRAINING
# ============================================================================

# Per-day training-sample quality weighting (ML-N1: named constants for the
# actual-vs-baseline correlation quality signal). quality_weight scales each
# day's training samples by how well actual generation tracked the hybrid
# baseline that day — high correlation -> full weight, low/negative -> floored.
# Values are behavior-identical to the prior inline literals (0.70/0.30/0.55/1.0).
TRAIN_QUALITY_WEIGHT_BASE = 0.70        # weight when correlation is zero/negative
TRAIN_QUALITY_WEIGHT_CORR_SCALE = 0.30  # additional weight scaled by max(corr, 0)
TRAIN_QUALITY_WEIGHT_FLOOR = 0.55       # lower clip — never fully discard a usable day
TRAIN_QUALITY_WEIGHT_CEIL = 1.00        # upper clip — never exceed full weight

def collect_training_data_hardened(
    today: date,
    history_days: list[dict] | None = None,
    day_regime: str | None = None,
    solcast_reliability: dict | None = None,
) -> tuple[pd.DataFrame, np.ndarray, np.ndarray, np.ndarray, np.ndarray] | tuple[None, None, None, None, None]:
    """
    Build the residual-training set from the hardened historical basis.

    The model learns residual plant response from actual archived weather and
    actual generation. Forecast weather is used only at inference time.
    """
    samples = list(history_days or collect_history_days(today, N_TRAIN_DAYS, solcast_reliability=solcast_reliability))
    samples = [sample for sample in samples if int(sample.get("days_ago", N_TRAIN_DAYS + 1)) <= N_TRAIN_DAYS]
    if day_regime:
        samples = [sample for sample in samples if str(sample.get("day_regime") or "") == str(day_regime)]

    X_parts = []
    y_parts = []
    weight_parts = []
    class_scale_parts = []
    day_parts = []
    solcast_days = 0

    if day_regime:
        log.info(
            "Collecting residual training samples from %d accepted history day(s) for regime=%s",
            len(samples),
            day_regime,
        )
    else:
        log.info("Collecting residual training samples from %d accepted history day(s)", len(samples))

    for sample in samples:
        day = str(sample["day"])
        stats = sample["stats"]
        # Use 1000H alarm-based outage mask instead of stale audit_log manual_constraint_mask
        inverter_outage_mask = np.asarray(sample.get("inverter_outage_mask"), dtype=bool) if sample.get("inverter_outage_mask") is not None else _build_1000h_inverter_outage_mask(day).copy()
        cap_dispatch_mask = np.asarray(sample.get("cap_dispatch_mask"), dtype=bool) if sample.get("cap_dispatch_mask") is not None else np.zeros(SLOTS_DAY, dtype=bool)
        X = sample.get("training_feature_frame")
        y = np.asarray(sample.get("training_residual"), dtype=float) if sample.get("training_residual") is not None else np.asarray([], dtype=float)
        class_scale = np.asarray(sample.get("training_class_scale"), dtype=float) if sample.get("training_class_scale") is not None else np.asarray([], dtype=float)
        usable = int(sample.get("training_slot_count", len(y)))
        hybrid_meta = {
            "used_solcast": bool(sample.get("used_solcast")),
            "coverage_ratio": float(((sample.get("solcast_prior") or {}).get("coverage_ratio", 0.0)) if isinstance(sample.get("solcast_prior"), dict) else 0.0),
            "mean_blend": float(
                np.mean(
                    np.asarray(
                        ((sample.get("solcast_prior") or {}).get("blend", np.zeros(SLOTS_DAY)))
                        if isinstance(sample.get("solcast_prior"), dict)
                        else np.zeros(SLOTS_DAY),
                        dtype=float,
                    )[SOLAR_START_SLOT:SOLAR_END_SLOT]
                )
            ),
        }
        if not isinstance(X, pd.DataFrame) or len(X) != len(y) or len(y) != len(class_scale):
            actual = np.asarray(sample.get("actual_effective", sample["actual"]), dtype=float).copy()
            actual_present = np.asarray(sample.get("actual_present"), dtype=bool) if sample.get("actual_present") is not None else np.ones(SLOTS_DAY, dtype=bool)
            w5 = sample["weather"]
            base = np.asarray(sample["baseline"], dtype=float)
            solcast_prior = sample.get("solcast_prior") if isinstance(sample.get("solcast_prior"), dict) else solcast_prior_from_snapshot(
                day,
                w5,
                sample.get("solcast_snapshot"),
                solcast_reliability,
            )
            stored_hybrid = sample.get("hybrid_baseline")
            if stored_hybrid is not None:
                hybrid_base = np.asarray(stored_hybrid, dtype=float).copy()
                hybrid_meta = {
                    "used_solcast": bool(sample.get("used_solcast")),
                    "coverage_ratio": float((solcast_prior or {}).get("coverage_ratio", 0.0)),
                    "mean_blend": float(np.mean(np.asarray((solcast_prior or {}).get("blend", np.zeros(SLOTS_DAY)), dtype=float)[SOLAR_START_SLOT:SOLAR_END_SLOT])) if solcast_prior else 0.0,
                }
            else:
                hybrid_base, hybrid_meta = blend_physics_with_solcast(base, solcast_prior)
            feat = build_features(w5, day, solcast_prior)
            actual[cap_dispatch_mask] = hybrid_base[cap_dispatch_mask]
            # Reconstruct outage slots with est_actual (fallback path)
            est_recon_mask = np.asarray(sample.get("est_actual_reconstructed_mask"), dtype=bool) if sample.get("est_actual_reconstructed_mask") is not None else np.zeros(SLOTS_DAY, dtype=bool)
            effective_present = actual_present | est_recon_mask

            # A3: Gap-fill — slots where metered actual is missing but est_actual
            # is available.  Individual gap-filled slots get full weight (no day-level
            # discount) because the satellite measurement for that slot is accurate.
            if solcast_prior and isinstance(solcast_prior, dict):
                est_actual_train = np.asarray(
                    solcast_prior.get("est_actual_kwh", np.zeros(SLOTS_DAY)), dtype=float
                )
                solar_mask_t = np.zeros(SLOTS_DAY, dtype=bool)
                solar_mask_t[SOLAR_START_SLOT:SOLAR_END_SLOT] = True
                est_avail_t = (est_actual_train > 0.0) & np.isfinite(est_actual_train) & solar_mask_t
                gap_fill_t = (~effective_present) & est_avail_t
                if np.any(gap_fill_t):
                    actual[gap_fill_t] = est_actual_train[gap_fill_t]
                    effective_present = effective_present | gap_fill_t
                    log.debug(
                        "  Train [%s] est_actual gap-fill: %d slots",
                        day, int(np.count_nonzero(gap_fill_t)),
                    )

            unreconstructed_outage = inverter_outage_mask & ~est_recon_mask
            curtailed = curtailed_mask(actual, hybrid_base)
            mask = (
                (hybrid_base > 0)
                & effective_present
                & (~unreconstructed_outage)
                & (~curtailed)
                & (feat["rad"].values >= RAD_MIN_WM2)
                & (np.arange(SLOTS_DAY) >= SOLAR_START_SLOT)
                & (np.arange(SLOTS_DAY) < SOLAR_END_SLOT)
            )
            usable = int(np.count_nonzero(mask))
            X = feat.loc[mask, FEATURE_COLS].reset_index(drop=True)
            y = np.clip(actual - hybrid_base, -500.0, 500.0)[mask]
            class_scale = _error_class_normalizer(y, baseline_kwh=hybrid_base[mask])
        if usable < MIN_SAMPLES:
            log.warning("  Reject %s - too few usable slots (%d)", day, usable)
            continue

        recency_weight = _sample_weight_for_days_ago(int(sample.get("days_ago", N_TRAIN_DAYS)))
        corr = float(stats.get("rad_gen_corr", 0.0))
        quality_weight = float(np.clip(
            TRAIN_QUALITY_WEIGHT_BASE + TRAIN_QUALITY_WEIGHT_CORR_SCALE * max(corr, 0.0),
            TRAIN_QUALITY_WEIGHT_FLOOR,
            TRAIN_QUALITY_WEIGHT_CEIL,
        ))
        # Discount weight for days with est_actual reconstruction
        # Metered substation data gets full weight (1.0) — no discount
        est_recon_count = int(sample.get("est_actual_reconstructed_count", 0))
        actual_src = sample.get("actual_source", "estimated")
        recon_discount = 1.0 if actual_src == "metered" else (EST_ACTUAL_WEIGHT_EFFECTIVE if est_recon_count > 0 else 1.0)
        sample_weight = np.full(len(y), recency_weight * quality_weight * recon_discount, dtype=float)

        X_parts.append(X.reset_index(drop=True))
        y_parts.append(y)
        weight_parts.append(sample_weight)
        class_scale_parts.append(class_scale)
        day_parts.append(np.full(len(y), day, dtype=object))
        if bool(hybrid_meta.get("used_solcast")):
            solcast_days += 1

        log.info(
            "  Train %s  sky=%-14s  CF=%.3f  corr=%.2f  weight=%.3f  usable=%d  1000h_slots=%d  cap_slots=%d  est_recon=%d  solcast=%s blend=%.2f cov=%.2f",
            day,
            stats["sky_class"],
            stats["capacity_factor"],
            corr,
            float(sample_weight[0]) if len(sample_weight) else 0.0,
            usable,
            int(np.count_nonzero(inverter_outage_mask[SOLAR_START_SLOT:SOLAR_END_SLOT])),
            int(np.count_nonzero(cap_dispatch_mask[SOLAR_START_SLOT:SOLAR_END_SLOT])),
            est_recon_count,
            "yes" if hybrid_meta.get("used_solcast") else "no",
            float(hybrid_meta.get("mean_blend", 0.0)),
            float(hybrid_meta.get("coverage_ratio", 0.0)),
        )

    valid_days = len(X_parts)
    if valid_days < MIN_TRAIN_DAYS:
        log.error(
            "ML model training SKIPPED: only %d valid training days available (minimum %d). "
            "Existing model will continue to be used. If this persists, forecast quality will degrade. "
            "Check weather data availability and Solcast snapshots.",
            valid_days, MIN_TRAIN_DAYS
        )
        return None, None, None, None, None

    X_train = pd.concat(X_parts, ignore_index=True)
    y_train = np.concatenate(y_parts)
    w_train = np.concatenate(weight_parts)
    class_scale_train = np.concatenate(class_scale_parts)
    day_train = np.concatenate(day_parts)
    log.info(
        "Training set: %d samples from %d days (mean sample weight=%.3f, solcast_days=%d)",
        len(y_train),
        valid_days,
        float(np.mean(w_train)),
        int(solcast_days),
    )
    return X_train, y_train, w_train, class_scale_train, day_train

def _lgbm_n_jobs():
    """Bounded LightGBM worker-thread count for the shared gateway box.

    n_jobs=-1 let LightGBM grab EVERY CPU core during the daily training run.
    Because the Node API server, the Modbus poller and the Electron renderer
    all run on this same machine, that saturated every core for the 0.5-6 min
    training window and froze the live dashboard via CPU contention (verified
    2026-06-01 freeze/crash audit). Leave 2 cores for the rest of the stack;
    overridable via ADSI_LGBM_N_JOBS for operators who tune by hand.
    """
    try:
        override = int(os.environ.get("ADSI_LGBM_N_JOBS", "0"))
        if override > 0:
            return override
    except Exception:
        pass
    try:
        cores = os.cpu_count() or 2
    except Exception:
        cores = 2
    return max(1, cores - 2)

def _make_residual_regressor_lgbm():
    if not _LIGHTGBM_AVAILABLE:
        raise RuntimeError("LightGBM is not installed")
    return lgb.LGBMRegressor(
        n_estimators=650, learning_rate=0.040, max_depth=8, num_leaves=71,
        subsample=0.78, colsample_bytree=0.75, min_child_samples=22,
        reg_alpha=0.08, reg_lambda=0.12, n_jobs=_lgbm_n_jobs(), random_state=42,
        verbose=-1, early_stopping_rounds=50,
    )

def _make_error_classifier_lgbm():
    if not _LIGHTGBM_AVAILABLE:
        raise RuntimeError("LightGBM is not installed")
    return lgb.LGBMClassifier(
        n_estimators=400, learning_rate=0.05, max_depth=6, num_leaves=47,
        subsample=0.80, colsample_bytree=0.80, min_child_samples=20,
        n_jobs=_lgbm_n_jobs(), random_state=42, verbose=-1, early_stopping_rounds=30,
    )

def _detect_ml_backend() -> str:
    """Return 'lightgbm' or 'sklearn_gbr' based on active config and availability."""
    if FORECAST_USE_LIGHTGBM and _LIGHTGBM_AVAILABLE:
        return "lightgbm"
    return "sklearn_gbr"

def _detect_ml_backend_detail() -> dict:
    """T4.9 fix (Phase 7, 2026-04-14): richer backend metadata for /engine-health.

    Previous consumers saw only a backend string and an opaque boolean
    "lgbm_unavailable_fallback" warning.  This returns the effective
    backend plus a human-readable REASON (from the captured ImportError,
    from the env-var override, etc.) so the operator can diagnose why
    LightGBM isn't active without grepping PyInstaller logs.
    """
    lgbm_active = bool(FORECAST_USE_LIGHTGBM and _LIGHTGBM_AVAILABLE)
    if lgbm_active:
        reason = "active"
    elif not FORECAST_USE_LIGHTGBM:
        reason = "disabled_by_env_FORECAST_USE_LIGHTGBM"
    elif _LIGHTGBM_IMPORT_ERROR:
        reason = f"import_failed: {_LIGHTGBM_IMPORT_ERROR}"
    else:
        reason = "unknown_unavailable"
    return {
        "backend": "lightgbm" if lgbm_active else "sklearn_gbr",
        "lightgbm_available": bool(_LIGHTGBM_AVAILABLE),
        "lightgbm_enabled_by_env": bool(FORECAST_USE_LIGHTGBM),
        "reason": reason,
    }

def _collect_data_quality_warnings(bundle: dict) -> list:
    """
    Check for known data quality issues and return a list of warning string codes.

    Returns:
        list: May include 'insufficient_training_days', 'high_rejection_streak',
              'no_regime_data', 'outage_days_detected', 'error_memory_sparse_regime',
              'error_memory_stale', 'est_actual_reconstruction_active'. May be empty (healthy).

    Note: Backend status (e.g., sklearn fallback) is NOT included here; it's
    expected behavior reported in status_flags, not a data quality warning.
    """
    warnings = []

    # Check for insufficient training days
    day_count = bundle.get("history_days", 0)
    if isinstance(day_count, int) and day_count < N_TRAIN_DAYS:
        warnings.append("insufficient_training_days")

    # Check for high rejection streak
    try:
        train_state = _load_json(ML_TRAIN_STATE_FILE)
        if int(train_state.get("consecutive_train_rejection_count", 0)) >= 3:
            warnings.append("high_rejection_streak")

        # Check for error_memory state warnings
        error_memory_block = train_state.get("error_memory", {})
        if error_memory_block:
            # Check for sparse regime fallback
            if bool(error_memory_block.get("fallback_to_legacy")):
                fallback_reason = str(error_memory_block.get("fallback_reason", ""))
                if fallback_reason == "sparse_regime_data":
                    warnings.append("error_memory_sparse_regime")

            # Check for stale error memory (last eligible date > 30 days old)
            last_eligible_str = error_memory_block.get("last_eligible_date")
            if last_eligible_str:
                try:
                    last_eligible_date = datetime.strptime(str(last_eligible_str), "%Y-%m-%d").date()
                    # T4.7 fix (Phase 7, 2026-04-14): clamp to >=0 so an NTP
                    # step or DST flip that moves date.today() backward cannot
                    # produce negative days_old, which silently skips the
                    # stale-warning branch.  The audit's concern was clock-
                    # drift false POSITIVES (triggering "stale" after a
                    # forward jump that looked like a big gap); the real risk
                    # is the opposite — backward jumps HIDE real staleness.
                    # max(0, ...) keeps the comparison monotonic either way.
                    days_old = max(0, (date.today() - last_eligible_date).days)
                    if days_old > 30:
                        warnings.append("error_memory_stale")
                except Exception:
                    pass
            elif error_memory_block.get("eligible_row_count", 0) == 0:
                # No eligible rows found at all
                warnings.append("error_memory_stale")

    except Exception:
        pass

    # Check for no regime data
    regimes = bundle.get("regimes", {})
    if not regimes:
        warnings.append("no_regime_data")

    # (Removed LightGBM fallback check — moved to status_flags in _persist_train_state)

    # Check for outage-affected days in training window
    outage_summary = bundle.get("outage_summary", {})
    if outage_summary.get("days_with_outages", 0) > 0:
        warnings.append("outage_days_detected")

    # Check for est_actual reconstruction activity
    est_recon = outage_summary.get("est_actual_reconstruction", {})
    if est_recon.get("days_reconstructed", 0) > 0:
        warnings.append("est_actual_reconstruction_active")

    # Check for missing Solcast tri-band data (new architecture dependency)
    # v2.8 S3: use readonly connection — this is a pure SELECT and should
    # not take a write-tier lock or miss the read-tuned pragmas.
    try:
        with _open_sqlite(APP_DB_FILE, SQLITE_READ_TIMEOUT_SEC, readonly=True) as conn:
            _tomorrow = (date.today() + timedelta(days=1)).isoformat()
            _row = conn.execute(
                "SELECT forecast_lo_kwh, forecast_hi_kwh FROM solcast_snapshots "
                "WHERE forecast_day = ? AND slot >= ? AND slot < ? LIMIT 1",
                (_tomorrow, SOLAR_START_SLOT, SOLAR_END_SLOT),
            ).fetchone()
            if _row is None:
                warnings.append("solcast_snapshot_missing")
            elif _row[0] is None or _row[1] is None:
                warnings.append("solcast_triband_missing")
    except Exception:
        pass  # non-fatal

    return warnings

def _make_residual_regressor(n_estimators: int | None = None):
    if FORECAST_USE_LIGHTGBM and _LIGHTGBM_AVAILABLE:
        return _make_residual_regressor_lgbm()
    # Sklearn GradientBoostingRegressor fallback (audit 2026-05-28 ML-M1 doc-fix).
    # Hyperparameters diverge from LightGBM intentionally: sklearn GBR has no
    # built-in early_stopping_rounds equivalent at the cost-function level, so
    # n_estimators is held to 500 (vs LightGBM's 650 with early stop) and
    # max_depth=4 (vs 8) compensates by reducing per-tree overfit risk. Huber
    # loss at alpha=0.85 mirrors LightGBM's "regression" objective robustness
    # against forecast-residual outliers. Backend selection + reason is
    # surfaced via /api/forecast/engine-health (`ml_backend_type`,
    # `ml_backend_detail`) — operators can verify which backend is active.
    return GradientBoostingRegressor(
        n_estimators=int(n_estimators or 500),
        learning_rate=0.025,
        max_depth=4,
        min_samples_split=15,
        min_samples_leaf=8,
        subsample=0.8,
        max_features=0.75,
        random_state=42,
        loss="huber",
        alpha=0.85,
        n_iter_no_change=None,
        tol=1e-4,
    )

def _make_error_classifier(n_estimators: int | None = None):
    if FORECAST_USE_LIGHTGBM and _LIGHTGBM_AVAILABLE:
        return _make_error_classifier_lgbm()
    return GradientBoostingClassifier(
        n_estimators=int(n_estimators or 320),
        learning_rate=0.04,
        max_depth=3,
        min_samples_split=18,
        min_samples_leaf=10,
        subsample=0.8,
        max_features=0.75,
        random_state=42,
        n_iter_no_change=None,
        tol=1e-4,
    )

def _select_residual_regressor_stage(
    X: pd.DataFrame,
    y: np.ndarray,
    sample_weight: np.ndarray,
    day_keys: np.ndarray | list[str] | None,
) -> dict:
    meta = {
        "used_blocked_validation": False,
        "holdout_days": 0,
        "holdout_samples": 0,
        "best_n_estimators": int(_make_residual_regressor().n_estimators),
        "mae_full": None,
        "mae_best": None,
    }
    # LightGBM uses native early-stopping during fit; staged_predict is not available.
    # Skip blocked-holdout selection — the factory hyperparameters are regularised enough.
    if FORECAST_USE_LIGHTGBM and _LIGHTGBM_AVAILABLE:
        return meta
    holdout_mask = _blocked_day_holdout_mask(day_keys)
    if holdout_mask.size != len(y) or not np.any(holdout_mask):
        return meta
    if int(np.count_nonzero(holdout_mask)) < MODEL_STAGE_HOLDOUT_MIN_SAMPLES:
        return meta
    train_mask = ~holdout_mask
    if len({str(v) for v in np.asarray(day_keys, dtype=object).reshape(-1)[train_mask]}) < max(MIN_TRAIN_DAYS, 4):
        return meta
    X_train = X.iloc[train_mask].reset_index(drop=True)
    X_holdout = X.iloc[holdout_mask].reset_index(drop=True)
    y_train = np.asarray(y, dtype=float)[train_mask]
    y_holdout = np.asarray(y, dtype=float)[holdout_mask]
    w_train = np.asarray(sample_weight, dtype=float)[train_mask]
    w_holdout = np.asarray(sample_weight, dtype=float)[holdout_mask]
    model = _make_residual_regressor()
    model.fit(X_train, y_train, sample_weight=w_train)
    best_n = int(getattr(model, "n_estimators_", model.n_estimators))
    best_mae = float("inf")
    full_mae = None
    for idx, pred in enumerate(model.staged_predict(X_holdout), start=1):
        mae = _weighted_mae_loss(pred, y_holdout, w_holdout)
        if idx == int(getattr(model, "n_estimators_", model.n_estimators)):
            full_mae = mae
        if mae + 1e-6 < best_mae:
            best_mae = mae
            best_n = idx
    meta.update({
        "used_blocked_validation": True,
        "holdout_days": int(len({str(v) for v in np.asarray(day_keys, dtype=object).reshape(-1)[holdout_mask]})),
        "holdout_samples": int(np.count_nonzero(holdout_mask)),
        "best_n_estimators": int(best_n),
        "mae_full": None if full_mae is None else float(full_mae),
        "mae_best": None if not math.isfinite(best_mae) else float(best_mae),
    })
    return meta

def _select_error_classifier_stage(
    X: pd.DataFrame,
    labels: np.ndarray,
    sample_weight: np.ndarray,
    day_keys: np.ndarray | list[str] | None,
) -> dict:
    meta = {
        "used_blocked_validation": False,
        "holdout_days": 0,
        "holdout_samples": 0,
        "best_n_estimators": int(_make_error_classifier().n_estimators),
        "nll_full": None,
        "nll_best": None,
    }
    # LightGBM does not expose staged_predict_proba; skip holdout stage selection.
    if FORECAST_USE_LIGHTGBM and _LIGHTGBM_AVAILABLE:
        return meta
    holdout_mask = _blocked_day_holdout_mask(day_keys)
    if holdout_mask.size != len(labels) or not np.any(holdout_mask):
        return meta
    if int(np.count_nonzero(holdout_mask)) < MODEL_STAGE_HOLDOUT_MIN_SAMPLES:
        return meta
    train_mask = ~holdout_mask
    y_train = np.asarray(labels, dtype=int)[train_mask]
    y_holdout = np.asarray(labels, dtype=int)[holdout_mask]
    if len({int(v) for v in y_train}) < 2 or len({int(v) for v in y_holdout}) < 2:
        return meta
    X_train = X.iloc[train_mask].reset_index(drop=True)
    X_holdout = X.iloc[holdout_mask].reset_index(drop=True)
    w_train = np.asarray(sample_weight, dtype=float)[train_mask]
    w_holdout = np.asarray(sample_weight, dtype=float)[holdout_mask]
    model = _make_error_classifier()
    model.fit(X_train, y_train, sample_weight=w_train)
    best_n = int(getattr(model, "n_estimators_", model.n_estimators))
    best_nll = float("inf")
    full_nll = None
    for idx, probs in enumerate(model.staged_predict_proba(X_holdout), start=1):
        full_probs = _classifier_probabilities_to_full_vector(
            np.asarray(probs, dtype=float),
            list(map(int, getattr(model, "classes_", []))),
        )
        nll = _weighted_neg_log_loss(full_probs, y_holdout, w_holdout)
        if idx == int(getattr(model, "n_estimators_", model.n_estimators)):
            full_nll = nll
        if nll + 1e-6 < best_nll:
            best_nll = nll
            best_n = idx
    meta.update({
        "used_blocked_validation": True,
        "holdout_days": int(len({str(v) for v in np.asarray(day_keys, dtype=object).reshape(-1)[holdout_mask]})),
        "holdout_samples": int(np.count_nonzero(holdout_mask)),
        "best_n_estimators": int(best_n),
        "nll_full": None if full_nll is None else float(full_nll),
        "nll_best": None if not math.isfinite(best_nll) else float(best_nll),
    })
    return meta

def fit_residual_model(
    X: pd.DataFrame,
    y: np.ndarray,
    sample_weight: np.ndarray,
    day_keys: np.ndarray | list[str] | None = None,
) -> tuple[GradientBoostingRegressor, object | None, dict]:
    stage_meta = _select_residual_regressor_stage(X, y, sample_weight, day_keys)
    model = _make_residual_regressor(stage_meta.get("best_n_estimators"))
    X_reset = X.reset_index(drop=True)
    # FIX 3 C4: Add LightGBM early stopping eval set
    if hasattr(model, 'early_stopping_rounds') and model.early_stopping_rounds:
        from sklearn.model_selection import train_test_split
        X_tr, X_val, y_tr, y_val = train_test_split(X_reset, y, test_size=0.15, random_state=42)
        if sample_weight is not None:
            sw_tr, sw_val = train_test_split(sample_weight, test_size=0.15, random_state=42)
        else:
            sw_tr, sw_val = None, None
        model.fit(X_tr, y_tr, sample_weight=sw_tr, eval_set=[(X_val, y_val)])
    else:
        model.fit(X_reset, y, sample_weight=sample_weight)
    # FIX-15: Feature importance logging
    _feat_imp_top10 = []
    if hasattr(model, "feature_importances_"):
        _importances = dict(zip(X.columns, model.feature_importances_))
        _sorted_imp = sorted(_importances.items(), key=lambda x: x[1], reverse=True)
        log.info("Top-10 features: %s", [(k, f"{v:.1f}") for k, v in _sorted_imp[:10]])
        log.info("Bottom-5 features: %s", [(k, f"{v:.1f}") for k, v in _sorted_imp[-5:]])
        _feat_imp_top10 = [{"name": k, "importance": float(v)} for k, v in _sorted_imp[:10]]
    meta = {
        "sample_count": int(len(y)),
        "feature_count": int(X.shape[1]),
        "feature_names": list(X.columns),
        "train_score": float(model.train_score_[-1]) if getattr(model, "train_score_", None) is not None and len(model.train_score_) else None,
        "estimators_used": int(getattr(model, "n_estimators_", model.n_estimators)),
        "stage_validation": stage_meta,
        "feature_importance_top10": _feat_imp_top10,
    }
    return model, None, meta

def fit_error_classifier(
    X: pd.DataFrame,
    residual: np.ndarray,
    sample_weight: np.ndarray,
    opportunity_kwh: np.ndarray | None = None,
    day_keys: np.ndarray | list[str] | None = None,
) -> tuple[GradientBoostingClassifier, object | None, dict] | tuple[None, None, None]:
    labels = classify_residual_error_classes(residual, opportunity_kwh=opportunity_kwh)
    present = sorted({int(v) for v in np.asarray(labels, dtype=int)})
    if len(present) < 2:
        return None, None, None

    stage_meta = _select_error_classifier_stage(X, labels, sample_weight, day_keys)
    model = _make_error_classifier(stage_meta.get("best_n_estimators"))
    X_reset = X.reset_index(drop=True)
    # C4: Add LightGBM early stopping eval set (same pattern as fit_residual_model)
    if hasattr(model, 'early_stopping_rounds') and model.early_stopping_rounds:
        from sklearn.model_selection import train_test_split
        X_tr, X_val, y_tr, y_val = train_test_split(X_reset, labels, test_size=0.15, random_state=42)
        if sample_weight is not None:
            sw_tr, _ = train_test_split(sample_weight, test_size=0.15, random_state=42)
        else:
            sw_tr = None
        model.fit(X_tr, y_tr, sample_weight=sw_tr, eval_set=[(X_val, y_val)])
    else:
        model.fit(X_reset, labels, sample_weight=sample_weight)
    centroids = {}
    raw_centroids = {}
    label_arr = np.asarray(labels, dtype=int)
    residual_arr = np.asarray(residual, dtype=float)
    weight_arr = np.asarray(sample_weight, dtype=float)
    class_counts = {}
    residual_prior = float(np.average(residual_arr, weights=np.maximum(weight_arr, 1e-9)))
    for label in present:
        mask = label_arr == label
        count = int(np.count_nonzero(mask))
        class_counts[_error_class_name(label)] = count
        if not np.any(mask):
            continue
        raw_mean = float(np.average(residual_arr[mask], weights=np.maximum(weight_arr[mask], 1e-9)))
        shrink = count / (count + ERROR_CLASS_CENTROID_SHRINKAGE_SAMPLES)
        raw_centroids[str(label)] = raw_mean
        centroids[str(label)] = float((shrink * raw_mean) + ((1.0 - shrink) * residual_prior))
    calibration = _fit_error_classifier_temperature(X, label_arr, weight_arr, day_keys)
    meta = {
        "sample_count": int(len(residual_arr)),
        "feature_count": int(X.shape[1]),
        "feature_names": list(X.columns),
        "estimators_used": int(getattr(model, "n_estimators_", model.n_estimators)),
        "classes": list(map(int, getattr(model, "classes_", []))),
        "class_counts": class_counts,
        "centroids_kwh": centroids,
        "raw_centroids_kwh": raw_centroids,
        "centroid_prior_kwh": residual_prior,
        "label_normalization": "slot_opportunity" if opportunity_kwh is not None else "slot_cap",
        "opportunity_floor_frac": float(ERROR_CLASS_OPPORTUNITY_FLOOR_FRAC),
        "prob_temperature": float(calibration.get("temperature", 1.0)),
        "calibration": calibration,
        "stage_validation": stage_meta,
        "class_support_weights": {
            ERROR_CLASS_NAMES[idx]: float(weight)
            for idx, weight in enumerate(_error_class_support_weights({
                "class_counts": class_counts,
                "sample_count": int(len(residual_arr)),
            }))
        },
        "train_score": float(model.train_score_[-1]) if getattr(model, "train_score_", None) is not None and len(model.train_score_) else None,
    }
    return model, None, meta

def build_weather_error_profiles(history_days: list[dict]) -> dict:
    """Aggregate residual behavior by day regime and slot weather bucket."""
    pair_values: dict[tuple[str, str], list[float]] = {}
    regime_values: dict[str, list[float]] = {}
    bucket_values: dict[str, list[float]] = {}
    cap_slot = max(slot_cap_kwh(False), 1.0)
    solar_mask = (
        (np.arange(SLOTS_DAY) >= SOLAR_START_SLOT)
        & (np.arange(SLOTS_DAY) < SOLAR_END_SLOT)
    )

    for sample in history_days:
        day = str(sample["day"])
        w5 = sample["weather"]
        residual = np.asarray(sample.get("residual"), dtype=float) if sample.get("residual") is not None else None
        usable_mask = np.asarray(sample.get("training_usable_mask"), dtype=bool) if sample.get("training_usable_mask") is not None else None
        bucket_labels = np.asarray(sample.get("slot_weather_buckets"), dtype=object) if sample.get("slot_weather_buckets") is not None else None
        if residual is None or residual.size < SLOTS_DAY or usable_mask is None or usable_mask.size < SLOTS_DAY:
            feat = sample.get("feature_frame")
            if not isinstance(feat, pd.DataFrame):
                feat = build_features(w5, day, sample.get("solcast_prior"))
            actual = np.asarray(sample.get("actual_effective", sample["actual"]), dtype=float).copy()
            hybrid = np.asarray(sample.get("hybrid_baseline", sample["baseline"]), dtype=float).copy()
            actual_present = np.asarray(sample.get("actual_present"), dtype=bool) if sample.get("actual_present") is not None else np.ones(SLOTS_DAY, dtype=bool)
            # Use 1000H alarm-based outage mask instead of stale audit_log manual_constraint_mask
            inverter_outage_mask = np.asarray(sample.get("inverter_outage_mask"), dtype=bool) if sample.get("inverter_outage_mask") is not None else _build_1000h_inverter_outage_mask(day).copy()
            cap_dispatch_mask = np.asarray(sample.get("cap_dispatch_mask"), dtype=bool) if sample.get("cap_dispatch_mask") is not None else np.zeros(SLOTS_DAY, dtype=bool)
            actual[cap_dispatch_mask] = hybrid[cap_dispatch_mask]
            _outage = np.asarray(sample.get("outage_mask"), dtype=bool) if sample.get("outage_mask") is not None else np.zeros(SLOTS_DAY, dtype=bool)
            usable_mask = (
                solar_mask
                & actual_present
                & (~inverter_outage_mask)
                & (~_outage)
                & (~curtailed_mask(actual, hybrid))
                & (feat["rad"].values >= RAD_MIN_WM2)
                & (hybrid > 0.0)
            )
            residual = np.clip(actual - hybrid, -500.0, 500.0)
        if not np.any(usable_mask):
            continue
        if bucket_labels is None or bucket_labels.size < SLOTS_DAY:
            bucket_labels = classify_slot_weather_buckets(w5, day)
        regime = str(sample.get("day_regime") or classify_day_regime(sample.get("stats") or analyse_weather_day(day, w5)))
        for slot in np.flatnonzero(usable_mask):
            bucket = str(bucket_labels[slot] or "")
            if not bucket or bucket == "offsolar":
                continue
            value = float(residual[slot])
            pair_values.setdefault((regime, bucket), []).append(value)
            regime_values.setdefault(regime, []).append(value)
            bucket_values.setdefault(bucket, []).append(value)

    return {
        "created_ts": int(time.time()),
        "class_names": list(ERROR_CLASS_NAMES),
        "cap_slot_kwh": float(cap_slot),
        "pairs": {
            f"{regime}:{bucket}": _aggregate_scalar_series(values)
            for (regime, bucket), values in sorted(pair_values.items())
        },
        "regimes": {
            regime: _aggregate_scalar_series(values)
            for regime, values in sorted(regime_values.items())
        },
        "buckets": {
            bucket: _aggregate_scalar_series(values)
            for bucket, values in sorted(bucket_values.items())
        },
    }

def _detect_regime_transition(history_days: list[dict], target_regime: str, lookback_days: int = 14) -> bool:
    """
    Detect if a weather regime transition is occurring (e.g., dry→monsoon, clear→overcast).

    A transition is detected when the target regime is present but sparse in recent
    history (below standard min_days) AND emerging (more recent than older), suggesting
    a regime change in progress rather than an established or absent pattern.

    Args:
        history_days: List of historical sample dicts with 'day_regime' field
        target_regime: The regime we're trying to train
        lookback_days: Days of history to examine for recent activity

    Returns:
        True if regime transition is likely (sparse + emerging target in recent history)
    """
    if not target_regime or not history_days:
        return False

    # Count recent occurrences (most recent N days)
    recent_samples = history_days[-lookback_days:] if len(history_days) > lookback_days else history_days
    older_samples = history_days[:-lookback_days] if len(history_days) > lookback_days else []

    recent_target_count = sum(1 for s in recent_samples if s and str(s.get("day_regime") or "") == str(target_regime))
    older_target_count = sum(1 for s in older_samples if s and str(s.get("day_regime") or "") == str(target_regime))

    # Transition is detected if:
    # 1. Target regime is sparse in recent history (below standard minimum)
    # 2. AND regime is emerging (more prevalent recently than historically)
    is_sparse = recent_target_count < REGIME_MODEL_MIN_DAYS
    is_emerging = recent_target_count > 0 and recent_target_count > older_target_count

    return is_sparse and is_emerging

def build_training_state(today: date) -> dict | None:
    """Build the in-memory model/artifact state for a given training cut-off date."""
    global EST_ACTUAL_WEIGHT_EFFECTIVE
    # P4: Compute dynamic EST_ACTUAL_WEIGHT based on Solcast accuracy vs metered
    # Operator override (option A): `forecastEstActualWeight`, when set, takes
    # manual precedence over the dynamic estimate; unset = unchanged dynamic path.
    _est_override = _setting_float_or_none("forecastEstActualWeight", 0.50, 1.00)
    if _est_override is not None:
        EST_ACTUAL_WEIGHT_EFFECTIVE = _est_override
        log.info("EST_ACTUAL_WEIGHT override active: %.3f (forecastEstActualWeight)", _est_override)
    else:
        EST_ACTUAL_WEIGHT_EFFECTIVE = compute_solcast_accuracy_vs_metered(lookback_days=30)

    solcast_reliability = build_solcast_reliability_artifact(today)
    history_days = collect_history_days(
        today,
        max(N_TRAIN_DAYS, SHAPE_LOOKBACK_DAYS),
        solcast_reliability=solcast_reliability,
    )
    X, y, sample_weight, class_scale, day_keys = collect_training_data_hardened(
        today,
        history_days,
        solcast_reliability=solcast_reliability,
    )
    if X is None:
        _increment_train_rejection_streak()
        return None

    global_model, global_scaler, global_meta = fit_residual_model(X, y, sample_weight, day_keys=day_keys)
    error_classifier_model, error_classifier_scaler, error_classifier_meta = fit_error_classifier(
        X,
        y,
        sample_weight,
        opportunity_kwh=class_scale,
        day_keys=day_keys,
    )
    if error_classifier_model is None:
        log.warning("fit_error_classifier returned None — insufficient error classes for global classifier")
    # Aggregate outage summary from history days
    _outage_days = [h for h in history_days if h.get("outage_severity", "no_outage") != "no_outage"]
    _recon_days = [h for h in history_days if h.get("est_actual_reconstructed_count", 0) > 0]
    # Aggregate actual_source distribution from training history
    _actual_source_dist = {"metered": 0, "mixed": 0, "estimated": 0}
    _metered_days = []
    for h in history_days:
        src = str(h.get("actual_source", "estimated"))
        _actual_source_dist[src] = _actual_source_dist.get(src, 0) + 1
        if src == "metered":
            _metered_days.append(str(h.get("day", "")))
    _outage_summary = {
        "days_with_outages": len(_outage_days),
        "total_outage_solar_slots": sum(h.get("outage_solar_slot_count", 0) for h in _outage_days),
        "severity_counts": {
            "minor": sum(1 for h in _outage_days if h.get("outage_severity") == "minor"),
            "moderate": sum(1 for h in _outage_days if h.get("outage_severity") == "moderate"),
            "severe": sum(1 for h in _outage_days if h.get("outage_severity") == "severe"),
        },
        "est_actual_reconstruction": {
            "days_reconstructed": len(_recon_days),
            "total_slots_reconstructed": sum(h.get("est_actual_reconstructed_count", 0) for h in _recon_days),
            "weight_discount": EST_ACTUAL_WEIGHT_FACTOR,
        },
    }
    # P5: Compute plant average loss percentage
    _plant_avg_loss_pct = get_plant_avg_loss_pct()
    _loss_calibration_audit = audit_loss_factors(lookback_days=30)

    bundle = {
        "created_ts": int(time.time()),
        "training_basis": "actual archived weather + cleaned actual generation (+ Solcast prior when available)",
        "history_days": int(len(history_days)),
        "feature_cols": list(X.columns),
        "outage_summary": _outage_summary,
        "training_actual_source_distribution": _actual_source_dist,
        "metered_training_days": _metered_days[-30:],  # bounded list of last 30 metered days
        "est_actual_weight_effective": float(EST_ACTUAL_WEIGHT_EFFECTIVE),
        "plant_avg_loss_pct": float(_plant_avg_loss_pct),
        "loss_calibration_audit": _loss_calibration_audit,
        "global": {
            "model": global_model,
            "scaler": global_scaler,
            "meta": dict(global_meta),
        },
        "regimes": {},
        "error_classifier": {
            "class_names": list(ERROR_CLASS_NAMES),
            "global": {},
            "regimes": {},
            "weather_profiles": build_weather_error_profiles(history_days),
        },
    }
    if error_classifier_model is not None:
        bundle["error_classifier"]["global"] = {
            "model": error_classifier_model,
            "scaler": error_classifier_scaler,
            "meta": dict(error_classifier_meta) if error_classifier_meta else {},
        }
    else:
        log.info("Skipping global error classifier in bundle — model is None")

    for regime in sorted({str(sample.get("day_regime") or "") for sample in history_days if sample.get("day_regime")}):
        regime_days = sum(1 for sample in history_days if str(sample.get("day_regime") or "") == regime)
        # ML-Me3 fix: detect regime transitions and allow relaxed threshold
        is_transition = _detect_regime_transition(history_days, regime, lookback_days=14)
        min_threshold = REGIME_MODEL_MIN_DAYS_TRANSITION if is_transition else REGIME_MODEL_MIN_DAYS
        if regime_days < min_threshold:
            log.debug(
                "Insufficient samples for regime=%s (%d/%d days) — rejecting regime model (transition=%s)",
                regime, regime_days, min_threshold, is_transition
            )
            continue
        if is_transition:
            log.info(
                "Regime transition detected for %s — using relaxed threshold (%d days instead of %d)",
                regime, REGIME_MODEL_MIN_DAYS_TRANSITION, REGIME_MODEL_MIN_DAYS
            )
        X_reg, y_reg, w_reg, reg_class_scale, reg_day_keys = collect_training_data_hardened(
            today,
            history_days,
            day_regime=regime,
            solcast_reliability=solcast_reliability,
        )
        if X_reg is None or len(y_reg) < REGIME_MODEL_MIN_SAMPLES:
            continue
        regime_model, regime_scaler, regime_meta = fit_residual_model(X_reg, y_reg, w_reg, day_keys=reg_day_keys)
        regime_meta["day_count"] = int(regime_days)
        bundle["regimes"][regime] = {
            "model": regime_model,
            "scaler": regime_scaler,
            "meta": regime_meta,
        }
        log.info(
            "Regime model trained [%s] - days=%d samples=%d train_score=%s",
            regime,
            regime_days,
            int(regime_meta.get("sample_count", 0)),
            f"{float(regime_meta['train_score']):.4f}" if regime_meta.get("train_score") is not None else "n/a",
        )
        cls_model, cls_scaler, cls_meta = fit_error_classifier(
            X_reg,
            y_reg,
            w_reg,
            opportunity_kwh=reg_class_scale,
            day_keys=reg_day_keys,
        )
        if cls_model is not None and cls_scaler is not None and cls_meta is not None:
            cls_meta["day_count"] = int(regime_days)
            bundle["error_classifier"]["regimes"][regime] = {
                "model": cls_model,
                "scaler": cls_scaler,
                "meta": cls_meta,
            }

    training_state = {
        "created_ts": int(time.time()),
        "training_date": today.isoformat(),
        "history_days": history_days,
        "model_bundle": bundle,
        "forecast_artifacts": build_forecast_artifacts(history_days),
        "weather_bias": build_weather_bias_artifact(today),
        "solcast_reliability": solcast_reliability,
    }
    _reset_train_rejection_streak(training_state)
    return training_state

def save_model_bundle(bundle: dict) -> bool:
    try:
        MODEL_BUNDLE_FILE.parent.mkdir(parents=True, exist_ok=True)
        # Keep last 3 checkpoints (FIX-17)
        # Delete oldest first, then shift: prev2→prev3, prev1→prev2
        oldest = MODEL_BUNDLE_FILE.with_suffix(".prev3.joblib")
        if oldest.exists():
            oldest.unlink()
        for i in range(2, 0, -1):
            src = MODEL_BUNDLE_FILE.with_suffix(f".prev{i}.joblib")
            dst = MODEL_BUNDLE_FILE.with_suffix(f".prev{i+1}.joblib")
            if src.exists():
                src.rename(dst)
        if MODEL_BUNDLE_FILE.exists():
            MODEL_BUNDLE_FILE.rename(MODEL_BUNDLE_FILE.with_suffix(".prev1.joblib"))
        # Atomic write: save to temp file, then rename
        tmp_path = MODEL_BUNDLE_FILE.with_suffix(".tmp")
        dump(bundle, tmp_path)
        # Compute SHA256 of the saved file
        sha256 = hashlib.sha256(tmp_path.read_bytes()).hexdigest()
        tmp_path.rename(MODEL_BUNDLE_FILE)
        # Persist checksum in ml_train_state.json
        state = _load_json(ML_TRAIN_STATE_FILE)
        state["model_file_sha256"] = sha256
        _save_json(ML_TRAIN_STATE_FILE, state)
        log.info("Model bundle saved: %s (sha256=%s)", MODEL_BUNDLE_FILE.name, sha256[:16])
        return True
    except Exception as e:
        log.error("Model bundle save failed %s: %s", MODEL_BUNDLE_FILE, e)
        return False

def load_model_bundle() -> dict | None:
    if MODEL_BUNDLE_FILE.exists():
        try:
            # Validate checksum if available (FIX-06 load-side)
            train_state = _load_json(ML_TRAIN_STATE_FILE)
            expected_sha = train_state.get("model_file_sha256")
            if expected_sha:
                actual_sha = hashlib.sha256(MODEL_BUNDLE_FILE.read_bytes()).hexdigest()
                if actual_sha != expected_sha:
                    log.error(
                        "Model bundle checksum mismatch! Expected %s, got %s. File may be corrupted.",
                        expected_sha[:16], actual_sha[:16],
                    )
                    return None  # Force physics-only fallback
            data = load(MODEL_BUNDLE_FILE)
            if isinstance(data, dict):
                return data
            else:
                # HIGH: Corrupted bundle file with wrong type
                log.error(
                    "Model bundle has invalid type %s (expected dict) — file may be corrupted, falling back to legacy or physics-only",
                    type(data).__name__,
                )
        except Exception as e:
            log.warning("Model bundle load failed %s: %s", MODEL_BUNDLE_FILE, e)

    if MODEL_FILE.exists():
        try:
            model = load(MODEL_FILE)
            scaler = load(SCALER_FILE) if SCALER_FILE.exists() else None
            return {
                "created_ts": int(time.time()),
                "training_basis": "legacy-single-model",
                "global": {
                    "model": model,
                    "scaler": scaler,
                    "meta": {
                        "sample_count": 0,
                        "feature_count": len(FEATURE_COLS),
                        "feature_names": list(FEATURE_COLS),
                        "train_score": None,
                        "estimators_used": int(getattr(model, "n_estimators_", getattr(model, "n_estimators", 0)) or 0),
                    },
                },
                "regimes": {},
                "error_classifier": {
                    "class_names": list(ERROR_CLASS_NAMES),
                    "global": {},
                    "regimes": {},
                    "weather_profiles": {},
                },
            }
        except Exception as e:
            log.warning("Legacy model load failed: %s", e)
    return None

def _align_bundle_features(
    block: dict,
    bundle_feature_cols: list[str] | None,
    X_pred: pd.DataFrame,
) -> pd.DataFrame:
    expected_cols = list((block.get("meta") or {}).get("feature_names") or bundle_feature_cols or [])
    if expected_cols:
        X_aligned = pd.DataFrame(index=X_pred.index)
        missing_cols = []
        for col in expected_cols:
            if col in X_pred.columns:
                X_aligned[col] = pd.to_numeric(X_pred[col], errors="coerce").fillna(0.0)
            else:
                X_aligned[col] = 0.0
                missing_cols.append(col)
        if missing_cols:
            # MEDIUM: Log missing features for audit trail (zero-fill masks data loss)
            log.debug(
                "Feature alignment: %d features missing from prediction data, using 0.0 fallback: %s",
                len(missing_cols), ", ".join(missing_cols[:5]) + ("..." if len(missing_cols) > 5 else ""),
            )
        return X_aligned
    scaler = block.get("scaler")
    model = block.get("model")
    expected_count = None
    if hasattr(scaler, "n_features_in_"):
        expected_count = int(scaler.n_features_in_)
    elif hasattr(model, "n_features_in_"):
        expected_count = int(model.n_features_in_)
    if expected_count is not None and expected_count != int(X_pred.shape[1]):
        if expected_count < int(X_pred.shape[1]):
            # Legacy model with fewer features — truncate to match (new cols are appended at end)
            # T4.8 fix (Phase 7, 2026-04-14): upgrade the log level from INFO
            # to WARNING so operators notice when predictions are running on
            # a pre-v2.5.0 (62-feature) model under v2.5.0+ (70-feature) code.
            # Truncation preserves mathematical alignment but drops the tri-
            # band features the legacy model was never trained on — output
            # quality is measurably worse than a freshly-trained model.  The
            # fallback stays functional so the upgrade path is not broken,
            # but the WARN surfaces the "retrain needed" signal clearly.
            #
            # ML-Mi5 fix: wrap truncation in try/except so mid-operation failure
            # leaves prior state intact (atomic operation).
            try:
                # Build truncated state in temp variable first
                X_truncated = X_pred.iloc[:, :expected_count]

                # Emit appropriate log message (guarded to prevent spam)
                global _legacy_model_truncate_notified  # guard init'd at module scope
                if not _legacy_model_truncate_notified:
                    log.warning(
                        "Legacy model detected: truncating features %d -> %d (dropping newest columns, "
                        "including tri-band Solcast signals if v2.5.0+).  Forecast quality is degraded "
                        "until the model is retrained on the current feature set.  "
                        "Run a full training cycle to regenerate.",
                        int(X_pred.shape[1]), expected_count,
                    )
                    _legacy_model_truncate_notified = True
                else:
                    log.info(
                        "Legacy model alignment: truncating %d -> %d features (dropping newest columns)",
                        int(X_pred.shape[1]), expected_count,
                    )

                # Commit the truncated state
                return X_truncated
            except Exception as e:
                log.error(
                    "Legacy model truncation failed: %s. Returning original feature set as fallback.",
                    e,
                )
                return X_pred
        else:
            raise ValueError(
                f"Feature count mismatch for model bundle (expected {expected_count}, "
                f"got {int(X_pred.shape[1])}). Model expects more features than available."
            )
    return X_pred

def _transform_bundle_features(block: dict, X_pred: pd.DataFrame):
    scaler = block.get("scaler")
    if scaler is not None and hasattr(scaler, "transform"):
        return np.asarray(scaler.transform(X_pred), dtype=float)
    return X_pred

def predict_residual_with_bundle(
    bundle: dict | None,
    X_pred: pd.DataFrame,
    target_regime: str,
    regime_confidence: float = 1.0,
) -> tuple[np.ndarray, dict]:
    if not bundle or not isinstance(bundle, dict):
        return np.zeros(len(X_pred), dtype=float), {"target_regime": target_regime, "used_regime_model": False, "blend": 0.0}

    global_block = bundle.get("global") or {}
    global_model = global_block.get("model")
    if global_model is None:
        return np.zeros(len(X_pred), dtype=float), {"target_regime": target_regime, "used_regime_model": False, "blend": 0.0}

    X_pred = _align_bundle_features(global_block, list(bundle.get("feature_cols") or []), X_pred)

    X_global = _transform_bundle_features(global_block, X_pred)
    try:
        global_pred = np.asarray(global_model.predict(X_global), dtype=float)
    except Exception as e:
        log.error(
            "Global model prediction failed: %s (X shape=%s, model type=%s)",
            e, X_global.shape, type(global_model).__name__,
        )
        return np.zeros(len(X_pred), dtype=float), {
            "target_regime": target_regime, "used_regime_model": False,
            "blend": 0.0, "prediction_error": str(e),
        }

    regime_block = ((bundle.get("regimes") or {}).get(target_regime) or {})
    regime_model = regime_block.get("model")
    if regime_model is None:
        return global_pred, {"target_regime": target_regime, "used_regime_model": False, "blend": 0.0}

    X_regime = _transform_bundle_features(regime_block, X_pred)
    try:
        regime_pred = np.asarray(regime_model.predict(X_regime), dtype=float)
    except Exception as e:
        log.warning(
            "Regime model prediction failed for '%s': %s (X shape=%s). Falling back to global.",
            target_regime, e, X_regime.shape,
        )
        return global_pred, {
            "target_regime": target_regime, "used_regime_model": False,
            "blend": 0.0, "regime_prediction_error": str(e),
        }
    regime_meta = regime_block.get("meta") or {}
    regime_days = int(regime_meta.get("day_count", 0))
    regime_samples = int(regime_meta.get("sample_count", 0))

    # T4.12 fix (Phase 7, 2026-04-14): enforce a sample-count floor at
    # prediction time, not just at training time.  A regime model can be
    # stored in the bundle but have come from a minimal training run
    # (e.g. a partially-rebuilt bundle, or a regime that barely cleared
    # REGIME_MODEL_MIN_DAYS=6 before being blended at 0.52 weight).  If
    # sample_count is missing or below REGIME_MODEL_MIN_SAMPLES, fall
    # through to the global prediction rather than blending a thin model.
    # sample_count==0 is treated as "metadata missing, trust training-time
    # filter" so older bundles without the key keep working.
    if regime_samples > 0 and regime_samples < REGIME_MODEL_MIN_SAMPLES:
        log.info(
            "Regime model '%s' has only %d samples (min %d) — falling through to global prediction.",
            target_regime, regime_samples, REGIME_MODEL_MIN_SAMPLES,
        )
        return global_pred, {
            "target_regime": target_regime,
            "used_regime_model": False,
            "blend": 0.0,
            "regime_sample_count": regime_samples,
            "regime_fallthrough_reason": "insufficient_samples",
        }

    blend = REGIME_BLEND_BASE + 0.05 * max(0, regime_days - REGIME_MODEL_MIN_DAYS)
    blend = min(blend, REGIME_BLEND_MAX)
    # v2.8 ML audit L2: allow low-confidence regime classifications to fall
    # through to the global model. Previous floor of 0.60 kept regime blend
    # above 60% even when the classifier was uncertain; now uncertainty
    # below 0.30 effectively disables regime influence, and 0.30-1.0 scales
    # linearly into the blend factor.
    # T4.18 fix (Phase 8, 2026-04-14): log when regime confidence is low so
    # operators can see when a forecast is falling back toward the global
    # model.  DEBUG level to avoid noise on healthy classifications.
    if regime_confidence < 0.6:
        log.debug(
            "Low regime confidence for '%s': confidence=%.3f (< 0.6) — regime blend reduced "
            "from %.3f to %.3f",
            target_regime, float(regime_confidence), float(blend / max(float(np.clip(regime_confidence, 0.0, 1.0)), 1e-6)),
            float(blend),
        )
    blend *= float(np.clip(regime_confidence, 0.0, 1.0))
    return ((1.0 - blend) * global_pred + blend * regime_pred), {
        "target_regime": target_regime,
        "used_regime_model": True,
        "blend": float(blend),
        "regime_days": regime_days,
        "regime_samples": int(regime_meta.get("sample_count", 0)),
    }

def _classifier_probabilities_to_full_vector(probs: np.ndarray, classes: list[int]) -> np.ndarray:
    out = np.zeros((len(probs), len(ERROR_CLASS_NAMES)), dtype=float)
    for idx, class_id in enumerate(classes):
        class_idx = int(class_id)
        if 0 <= class_idx < len(ERROR_CLASS_NAMES):
            out[:, class_idx] = np.asarray(probs[:, idx], dtype=float)
    row_sum = out.sum(axis=1, keepdims=True)
    with np.errstate(divide="ignore", invalid="ignore"):
        out = np.divide(out, np.maximum(row_sum, 1e-9), out=np.zeros_like(out), where=row_sum > 0)
    return out

def _expected_bias_from_classifier_probs(prob_matrix: np.ndarray, centroids: dict) -> np.ndarray:
    expected = np.zeros(prob_matrix.shape[0], dtype=float)
    for class_idx, class_name in enumerate(ERROR_CLASS_NAMES):
        centroid = float(centroids.get(str(class_idx), 0.0))
        if centroid == 0.0:
            continue
        expected += np.asarray(prob_matrix[:, class_idx], dtype=float) * centroid
    return expected

def _error_class_support_weights(meta: dict | None) -> np.ndarray:
    meta_dict = meta if isinstance(meta, dict) else {}
    class_counts = dict(meta_dict.get("class_counts") or {})
    if not class_counts:
        return np.ones(len(ERROR_CLASS_NAMES), dtype=float)
    weights = np.ones(len(ERROR_CLASS_NAMES), dtype=float)
    for idx, name in enumerate(ERROR_CLASS_NAMES):
        if idx == ERROR_CLASS_NEUTRAL_IDX:
            weights[idx] = 1.0
            continue
        full_count = ERROR_CLASS_SUPPORT_STRONG_FULL_COUNT if idx in (0, len(ERROR_CLASS_NAMES) - 1) else ERROR_CLASS_SUPPORT_MILD_FULL_COUNT
        count = max(float(class_counts.get(name, 0.0)), 0.0)
        weights[idx] = float(np.sqrt(np.clip(count / max(full_count, 1.0), 0.0, 1.0)))
    return weights

def _stabilize_classifier_probabilities(
    prob_matrix: np.ndarray,
    meta: dict | None,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    probs = np.asarray(prob_matrix, dtype=float)
    if probs.ndim != 2 or probs.size <= 0:
        support_weights = np.ones(len(ERROR_CLASS_NAMES), dtype=float)
        return probs.copy(), support_weights, np.ones(probs.shape[0] if probs.ndim == 2 else 0, dtype=float)
    support_weights = _error_class_support_weights(meta)
    adjusted = probs.copy()
    for idx in range(adjusted.shape[1]):
        if idx == ERROR_CLASS_NEUTRAL_IDX:
            continue
        adjusted[:, idx] *= float(support_weights[idx])
    row_sum = adjusted.sum(axis=1, keepdims=True)
    neutral_add = np.clip(1.0 - row_sum, 0.0, 1.0)
    adjusted[:, ERROR_CLASS_NEUTRAL_IDX] += neutral_add[:, 0]
    row_sum = adjusted.sum(axis=1, keepdims=True)
    adjusted = np.divide(adjusted, np.maximum(row_sum, 1e-9), out=np.zeros_like(adjusted), where=row_sum > 0)
    support_strength = np.clip(adjusted @ support_weights, 0.0, 1.0)
    return adjusted, support_weights, support_strength

def _weather_profile_stat_reliability(stat: dict | None, cap_slot_kwh: float, full_count: float) -> float | None:
    if not isinstance(stat, dict):
        return None
    count = int(stat.get("count", 0) or 0)
    if count <= 0:
        return None
    cap_slot = max(float(cap_slot_kwh), 1.0)
    count_score = float(np.clip(count / max(full_count, 1.0), 0.0, 1.0))
    mae_norm = float(np.clip(abs(float(stat.get("mae", 0.0))) / max(cap_slot * ERROR_CLASS_PROFILE_MAE_REF_FRAC, 1.0), 0.0, 1.0))
    std_norm = float(np.clip(abs(float(stat.get("std", 0.0))) / max(cap_slot * ERROR_CLASS_PROFILE_STD_REF_FRAC, 1.0), 0.0, 1.0))
    stability = float(np.clip(1.0 - 0.60 * mae_norm - 0.40 * std_norm, 0.0, 1.0))
    return float(
        np.clip(
            ERROR_CLASS_PROFILE_MIN_RELIABILITY
            + (1.0 - ERROR_CLASS_PROFILE_MIN_RELIABILITY) * count_score * stability,
            ERROR_CLASS_PROFILE_MIN_RELIABILITY,
            1.0,
        )
    )

def _weather_profile_reliability_vector(
    weather_profiles: dict | None,
    target_regime: str,
    slot_weather_buckets: np.ndarray | list[str] | None,
) -> np.ndarray:
    if slot_weather_buckets is None:
        return np.ones(0, dtype=float)
    labels = np.asarray(slot_weather_buckets, dtype=object).reshape(-1)
    out = np.full(labels.shape, ERROR_CLASS_PROFILE_DEFAULT_RELIABILITY, dtype=float)
    if labels.size <= 0:
        return out
    profiles = weather_profiles if isinstance(weather_profiles, dict) else {}
    pair_stats = dict(profiles.get("pairs") or {})
    bucket_stats = dict(profiles.get("buckets") or {})
    regime_stats = dict(profiles.get("regimes") or {})
    cap_slot = float(profiles.get("cap_slot_kwh", slot_cap_kwh(False)) or slot_cap_kwh(False))
    for idx, raw_label in enumerate(labels):
        bucket = str(raw_label or "")
        if not bucket or bucket == "offsolar":
            out[idx] = 0.0
            continue
        scored: list[tuple[float, float]] = []
        pair_rel = _weather_profile_stat_reliability(
            pair_stats.get(f"{target_regime}:{bucket}"),
            cap_slot,
            ERROR_CLASS_PROFILE_PAIR_FULL_COUNT,
        )
        if pair_rel is not None:
            scored.append((0.60, pair_rel))
        bucket_rel = _weather_profile_stat_reliability(
            bucket_stats.get(bucket),
            cap_slot,
            ERROR_CLASS_PROFILE_BUCKET_FULL_COUNT,
        )
        if bucket_rel is not None:
            scored.append((0.25, bucket_rel))
        regime_rel = _weather_profile_stat_reliability(
            regime_stats.get(target_regime),
            cap_slot,
            ERROR_CLASS_PROFILE_REGIME_FULL_COUNT,
        )
        if regime_rel is not None:
            scored.append((0.15, regime_rel))
        if scored:
            weights = np.asarray([w for w, _ in scored], dtype=float)
            values = np.asarray([v for _, v in scored], dtype=float)
            out[idx] = float(np.average(values, weights=weights))
        else:
            out[idx] = ERROR_CLASS_PROFILE_DEFAULT_RELIABILITY
    return np.clip(out, 0.0, 1.0)

def predict_error_classifier_with_bundle(
    bundle: dict | None,
    X_pred: pd.DataFrame,
    target_regime: str,
    regime_confidence: float = 1.0,
    slot_weather_buckets: np.ndarray | list[str] | None = None,
) -> tuple[np.ndarray, dict]:
    default_meta = {
        "available": False,
        "target_regime": target_regime,
        "used_regime_model": False,
        "blend": 0.0,
        "probabilities": np.zeros((len(X_pred), len(ERROR_CLASS_NAMES)), dtype=float),
        "predicted_labels": np.full(len(X_pred), ERROR_CLASS_NEUTRAL_IDX, dtype=int),
        "confidence": np.zeros(len(X_pred), dtype=float),
        "severe_probability": np.zeros(len(X_pred), dtype=float),
        "weather_profiles": {},
        "support_strength": np.zeros(len(X_pred), dtype=float),
        "profile_reliability": np.ones(len(X_pred), dtype=float),
        "trust_scale": np.zeros(len(X_pred), dtype=float),
        "cap_frac": np.full(len(X_pred), ERROR_CLASS_BIAS_CAP_FRAC, dtype=float),
        "class_support_weights": {name: 1.0 for name in ERROR_CLASS_NAMES},
    }
    if not bundle or not isinstance(bundle, dict):
        return np.zeros(len(X_pred), dtype=float), default_meta

    classifier_block = bundle.get("error_classifier") or {}
    global_block = classifier_block.get("global") or {}
    global_model = global_block.get("model")
    if global_model is None:
        return np.zeros(len(X_pred), dtype=float), default_meta

    X_pred = _align_bundle_features(global_block, list(bundle.get("feature_cols") or []), X_pred)
    X_global = _transform_bundle_features(global_block, X_pred)
    global_probs = _classifier_probabilities_to_full_vector(
        np.asarray(global_model.predict_proba(X_global), dtype=float),
        list(map(int, getattr(global_model, "classes_", []))),
    )
    global_probs = _apply_probability_temperature(
        global_probs,
        float((global_block.get("meta") or {}).get("prob_temperature", 1.0)),
    )
    global_probs, global_support_weights, global_support_strength = _stabilize_classifier_probabilities(
        global_probs,
        global_block.get("meta"),
    )
    global_centroids = dict((global_block.get("meta") or {}).get("centroids_kwh") or {})
    global_bias = _expected_bias_from_classifier_probs(global_probs, global_centroids)

    regime_block = ((classifier_block.get("regimes") or {}).get(target_regime) or {})
    regime_model = regime_block.get("model")
    if regime_model is None:
        probs = global_probs
        expected_bias = global_bias
        used_regime_model = False
        blend = 0.0
        regime_days = 0
        regime_samples = 0
        support_weights = global_support_weights
        support_strength = global_support_strength
    else:
        X_regime = _transform_bundle_features(regime_block, X_pred)
        regime_probs = _classifier_probabilities_to_full_vector(
            np.asarray(regime_model.predict_proba(X_regime), dtype=float),
            list(map(int, getattr(regime_model, "classes_", []))),
        )
        regime_probs = _apply_probability_temperature(
            regime_probs,
            float((regime_block.get("meta") or {}).get("prob_temperature", 1.0)),
        )
        regime_probs, regime_support_weights, regime_support_strength = _stabilize_classifier_probabilities(
            regime_probs,
            regime_block.get("meta"),
        )
        regime_centroids = dict((regime_block.get("meta") or {}).get("centroids_kwh") or {})
        regime_bias = _expected_bias_from_classifier_probs(regime_probs, regime_centroids)
        regime_meta = regime_block.get("meta") or {}
        regime_days = int(regime_meta.get("day_count", 0))
        regime_samples = int(regime_meta.get("sample_count", 0))
        blend = REGIME_BLEND_BASE + 0.05 * max(0, regime_days - REGIME_MODEL_MIN_DAYS)
        blend = min(blend, REGIME_BLEND_MAX)
        # v2.8 ML audit L2: allow low-confidence regime classifications to fall
        # through to the global model. Previous floor of 0.60 kept regime blend
        # above 60% even when the classifier was uncertain; now low confidence
        # naturally shrinks the blend factor toward zero.
        blend *= float(np.clip(regime_confidence, 0.0, 1.0))
        probs = ((1.0 - blend) * global_probs) + (blend * regime_probs)
        expected_bias = ((1.0 - blend) * global_bias) + (blend * regime_bias)
        used_regime_model = True
        support_weights = ((1.0 - blend) * global_support_weights) + (blend * regime_support_weights)
        support_strength = ((1.0 - blend) * global_support_strength) + (blend * regime_support_strength)

    profile_reliability = _weather_profile_reliability_vector(
        classifier_block.get("weather_profiles"),
        target_regime,
        slot_weather_buckets,
    )
    if profile_reliability.size != len(X_pred):
        profile_reliability = np.ones(len(X_pred), dtype=float)
    support_strength = np.clip(np.asarray(support_strength, dtype=float), 0.0, 1.0)
    trust_scale = np.clip(profile_reliability * support_strength, 0.0, 1.0)
    predicted_labels = np.argmax(probs, axis=1).astype(int)
    confidence = (np.max(probs, axis=1).astype(float) * np.sqrt(np.clip(trust_scale, 0.0, 1.0))).astype(float)
    severe_probability = (probs[:, 0] + probs[:, -1]).astype(float)
    cap_frac = (
        ERROR_CLASS_BIAS_CAP_FRAC
        * (0.45 + 0.55 * np.clip(profile_reliability, 0.0, 1.0))
        * (0.55 + 0.45 * np.clip(support_strength, 0.0, 1.0))
    )
    meta = {
        "available": True,
        "target_regime": target_regime,
        "used_regime_model": used_regime_model,
        "blend": float(blend),
        "regime_days": int(regime_days),
        "regime_samples": int(regime_samples),
        "probabilities": probs,
        "predicted_labels": predicted_labels,
        "confidence": confidence,
        "severe_probability": severe_probability,
        "weather_profiles": classifier_block.get("weather_profiles") or {},
        "support_strength": support_strength,
        "profile_reliability": profile_reliability,
        "trust_scale": trust_scale,
        "cap_frac": cap_frac.astype(float),
        "class_support_weights": {
            ERROR_CLASS_NAMES[idx]: float(support_weights[idx])
            for idx in range(min(len(ERROR_CLASS_NAMES), len(support_weights)))
        },
    }
    return expected_bias, meta

def train_model(today: date) -> bool:
    """Train (or retrain) the residual correction model."""
    state = build_training_state(today)
    if not state:
        return False

    bundle = state["model_bundle"]
    global_block = bundle.get("global") or {}
    global_model = global_block.get("model")
    global_scaler = global_block.get("scaler")
    global_meta = dict(global_block.get("meta") or {})
    dump(global_model, MODEL_FILE)
    if global_scaler is not None:
        dump(global_scaler, SCALER_FILE)
    else:
        dump(IdentityFeatureScaler(int(global_meta.get("feature_count", len(bundle.get("feature_cols") or FEATURE_COLS)))), SCALER_FILE)
    save_model_bundle(bundle)
    save_forecast_artifacts(state.get("forecast_artifacts") or {})
    save_weather_bias_artifact(state.get("weather_bias") or {})
    save_solcast_reliability_artifact(state.get("solcast_reliability"))
    classifier_block = bundle.get("error_classifier") or {}
    log.info(
        "Model trained - global_estimators=%d global_train_score=%s regime_models=%d classifier_regime_models=%d classifier_global=%s solcast_reliability_days=%d",
        int(global_meta.get("estimators_used", 0)),
        f"{float(global_meta['train_score']):.4f}" if global_meta.get("train_score") is not None else "n/a",
        int(len(bundle["regimes"])),
        int(len(classifier_block.get("regimes") or {})),
        bool((classifier_block.get("global") or {}).get("model")),
        int(((state.get("solcast_reliability") or {}).get("day_count", 0))),
    )
    return True

# ============================================================================
# RAMP RATE LIMITER
# ============================================================================

def apply_ramp_limit(arr: np.ndarray, max_step: float = 320.0) -> np.ndarray:
    """Enforce physical ramp-rate limit between consecutive slots."""
    arr = arr.copy()
    for i in range(1, len(arr)):
        diff = arr[i] - arr[i - 1]
        if diff > max_step:
            arr[i] = arr[i - 1] + max_step
        elif diff < -max_step:
            arr[i] = arr[i - 1] - max_step
    return arr

def identify_ramp_slots(rad: np.ndarray, sunrise_rel: np.ndarray, sunset_rel: np.ndarray) -> np.ndarray:
    """Identify sunrise/sunset ramp slots with high irradiance gradient near solar edges."""
    drad = np.abs(np.diff(rad, prepend=rad[0]))
    high_grad = drad > RAMP_DETECTION_DRAD_THRESHOLD
    near_edge = (sunrise_rel < RAMP_ONSET_SLOTS) | (sunset_rel < RAMP_ONSET_SLOTS)
    return high_grad & near_edge

def residual_blend_vector(w5: pd.DataFrame, day: str, regime_confidence: float = 1.0) -> np.ndarray:
    """
    Compute per-slot ML blending factor [ML_BLEND_MIN..ML_BLEND_MAX].
    Lower blending is applied under high weather uncertainty:
      - strong cloud volatility
      - rain/convective conditions
      - dawn/dusk low-sun slots
    """
    def col(name: str, default: float = 0.0) -> np.ndarray:
        if name not in w5.columns:
            return np.full(SLOTS_DAY, default, dtype=float)
        arr = pd.to_numeric(w5[name], errors="coerce").fillna(default).values
        if len(arr) < SLOTS_DAY:
            arr = np.concatenate([arr, np.full(SLOTS_DAY - len(arr), default)])
        return arr[:SLOTS_DAY].astype(float)

    cloud = np.clip(col("cloud", 0.0), 0.0, 100.0)
    precip = np.clip(col("precip", 0.0), 0.0, None)
    cape = np.clip(col("cape", 0.0), 0.0, None)
    rad = np.clip(col("rad", 0.0), 0.0, None)

    idx = np.arange(SLOTS_DAY)
    solar_rel = (idx - SOLAR_START_SLOT) / max(SOLAR_SLOTS - 1, 1)
    solar_rel = np.clip(solar_rel, 0, 1)
    # Dawn/dusk: trust ML less, noon: trust more.
    solar_conf = 0.68 + 0.32 * np.sin(np.pi * solar_rel)
    solar_conf = np.clip(solar_conf, 0.55, 1.0)

    cloud_std_1h = np.nan_to_num(_rolling_std(cloud, 12), nan=0.0) / 100.0
    precip_1h = np.nan_to_num(_rolling_sum(precip, 12), nan=0.0)

    cloud_unc = np.clip((cloud - 45.0) / 55.0, 0.0, 1.0)
    rain_unc = np.clip(precip_1h / 3.0, 0.0, 1.0)
    cape_unc = np.clip((cape - 400.0) / 1600.0, 0.0, 1.0)
    low_rad_unc = np.clip((RAD_MIN_WM2 * 8.0 - rad) / max(RAD_MIN_WM2 * 8.0, 1.0), 0.0, 1.0)

    uncertainty = (
        0.32 * cloud_std_1h +
        0.24 * cloud_unc +
        0.24 * rain_unc +
        0.12 * cape_unc +
        0.08 * low_rad_unc
    )
    uncertainty = np.clip(uncertainty, 0.0, 1.0)

    # v2.8 ML audit L2: drop the 0.60 floor on regime confidence. When
    # the classifier is genuinely uncertain, we want minimal blend
    # influence instead of forcing 60%.
    confidence_scale = float(np.clip(regime_confidence, 0.0, 1.0))
    blend = solar_conf * (1.0 - ML_BLEND_ALPHA * uncertainty) * confidence_scale

    # Ramp slot weighting (Phase 2.1): reduce ML trust at sunrise/sunset ramps
    sunrise_slots_rel = np.clip(idx - SOLAR_START_SLOT, 0, SOLAR_SLOTS)
    sunset_slots_rel = np.clip((SOLAR_END_SLOT - 1) - idx, 0, SOLAR_SLOTS)
    ramp_mask = identify_ramp_slots(rad, sunrise_slots_rel, sunset_slots_rel)
    blend[ramp_mask] *= RAMP_SLOT_BLEND_SCALE

    blend = np.clip(blend, ML_BLEND_MIN, ML_BLEND_MAX)
    blend[:SOLAR_START_SLOT] = 0.0
    blend[SOLAR_END_SLOT:] = 0.0
    return blend

def solcast_residual_damp_factor(solcast_meta: dict | None) -> float:
    if not solcast_meta or not bool(solcast_meta.get("used_solcast")):
        return 1.0

    mean_blend = float(np.clip(solcast_meta.get("mean_blend", 0.0), 0.0, 1.0))
    reliability = float(np.clip(solcast_meta.get("reliability", 0.0), 0.0, 1.0))
    coverage = float(np.clip(solcast_meta.get("coverage_ratio", 0.0), 0.0, 1.0))
    resolution_weight = float(
        np.clip(
            solcast_meta.get("resolution_weight_mean", SOLCAST_RESOLUTION_WEIGHT_FALLBACK),
            0.0,
            1.0,
        )
    )
    resolution_authority = (
        SOLCAST_RESOLUTION_AUTHORITY_MIN
        + (SOLCAST_RESOLUTION_AUTHORITY_MAX - SOLCAST_RESOLUTION_AUTHORITY_MIN) * resolution_weight
    )
    damp = 1.0 - 0.70 * mean_blend * (0.35 + 0.65 * reliability) * (0.55 + 0.45 * coverage) * resolution_authority
    damp = float(np.clip(damp, SOLCAST_RESIDUAL_DAMP_MIN, SOLCAST_RESIDUAL_DAMP_MAX))

    # Spread-aware dampening (Phase 1.2): high spread = less damp (trust ML more)
    _raw_spread = solcast_meta.get("spread_frac_mean", 0.0)
    spread_frac = float(np.clip(_raw_spread if np.isfinite(_raw_spread) else 0.0, 0.0, 1.0))
    if spread_frac > 0.05:
        # When spread is high, Solcast is uncertain → let ML residuals through more
        spread_relief = 0.18 * np.clip((spread_frac - 0.05) / 0.35, 0.0, 1.0)
        damp = damp + spread_relief * (1.0 - damp)  # move damp toward 1.0
        damp = float(np.clip(damp, SOLCAST_RESIDUAL_DAMP_MIN, SOLCAST_RESIDUAL_DAMP_MAX))

    if bool(solcast_meta.get("primary_mode")):
        damp = min(damp, SOLCAST_RESIDUAL_PRIMARY_CAP)
    # Trend integration: improving Solcast -> damp residuals more, degrading -> let residuals through
    _trend_sig = str(solcast_meta.get("trend_signal", "stable"))
    _trend_m = float(solcast_meta.get("trend_magnitude", 0.0))
    if _trend_sig == "improving":
        damp *= (1.0 - 0.5 * min(abs(_trend_m), SOLCAST_TREND_BOOST_MAX))
    elif _trend_sig == "degrading":
        damp *= (1.0 + 0.5 * min(abs(_trend_m), SOLCAST_TREND_PENALTY_MAX))
    damp = float(np.clip(damp, SOLCAST_RESIDUAL_DAMP_MIN, SOLCAST_RESIDUAL_DAMP_MAX))
    return float(damp)

# ============================================================================
# CONFIDENCE BANDS
# ============================================================================

def confidence_bands(
    values: np.ndarray,
    w5: pd.DataFrame,
    day: str,
    regime_confidence: float = 1.0,
    error_class_meta: dict | None = None,
    solcast_prior: dict | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    """
    Per-slot confidence bands based on:
      - base uncertainty (CONF_CLEAR_BASE on clear days)
      - cloud volatility index
      - cloud cover level
      - time-of-day (lower confidence at dawn/dusk)
    """
    stats = analyse_weather_day(day, w5)
    # FIX-11: Guard against w5 having fewer rows than SLOTS_DAY
    if len(w5) < SLOTS_DAY:
        log.warning("confidence_bands: w5 has %d rows, expected %d — padding with forward-fill", len(w5), SLOTS_DAY)
        # MEDIUM: Use conservative cloud cover (50%) instead of 0.0 for missing data
        # 0.0 is too optimistic; 50% is neutral baseline for uncertainty
        w5 = w5.reindex(range(SLOTS_DAY)).ffill()
        # For cloud cover, use 50.0 (mid-range); for other columns use 0.0
        w5["cloud"] = w5["cloud"].fillna(50.0)
        w5 = w5.fillna(0.0)
    lo    = np.zeros(SLOTS_DAY)
    hi    = np.zeros(SLOTS_DAY)
    confidence_penalty = float(np.clip(1.0 - float(regime_confidence), 0.0, 0.4))
    if error_class_meta:
        class_confidence = np.asarray(error_class_meta.get("confidence"), dtype=float).reshape(-1)
        severe_probability = np.asarray(error_class_meta.get("severe_probability"), dtype=float).reshape(-1)
    else:
        class_confidence = np.ones(SLOTS_DAY, dtype=float)
        severe_probability = np.zeros(SLOTS_DAY, dtype=float)
    if class_confidence.size < SLOTS_DAY:
        class_confidence = np.pad(class_confidence, (0, SLOTS_DAY - class_confidence.size), constant_values=1.0)
    class_confidence = class_confidence[:SLOTS_DAY]
    if severe_probability.size < SLOTS_DAY:
        severe_probability = np.pad(severe_probability, (0, SLOTS_DAY - severe_probability.size), constant_values=0.0)
    severe_probability = severe_probability[:SLOTS_DAY]

    geo   = solar_geometry(day)
    solar_prog = np.clip(
        (np.arange(SLOTS_DAY) - SOLAR_START_SLOT) / max(SOLAR_SLOTS - 1, 1), 0, 1
    )
    # Time-of-day uncertainty (dawn/dusk -1.6, noon -1.0)
    tod_factor = 1.0 + 0.6 * (1 - np.sin(np.pi * solar_prog))

    for i in range(SOLAR_START_SLOT, SOLAR_END_SLOT):
        v = values[i]
        if v <= 0:
            continue

        cloud_i  = w5["cloud"].values[i]
        # FIX-11: NaN safety for cloud value
        if not np.isfinite(cloud_i):
            cloud_i = 50.0  # conservative mid-range fallback
        # Additional uncertainty from cloud layer presence
        cloud_unc = CONF_CLOUD_ADD * np.clip((cloud_i - 30) / 70.0, 0, 1)
        classifier_unc = ERROR_CLASS_CONF_BAND_ADD_MAX * np.clip(1.0 - class_confidence[i], 0.0, 1.0)
        severe_unc = ERROR_CLASS_SEVERE_BAND_ADD_MAX * np.clip(severe_probability[i], 0.0, 1.0)
        conf      = (CONF_CLEAR_BASE + cloud_unc + confidence_penalty * 0.12 + classifier_unc + severe_unc) * tod_factor[i]
        conf      = min(conf, 0.40)   # cap at 40%

        lo[i] = v * (1.0 - conf)
        hi[i] = v * (1.0 + conf)

    # Blend Solcast P10/P90 bands if available and confidence is high enough
    if solcast_prior is not None:
        _sc_lo = np.asarray(solcast_prior.get("prior_lo_kwh", []), dtype=float)
        _sc_hi = np.asarray(solcast_prior.get("prior_hi_kwh", []), dtype=float)
        _sc_conf = float(solcast_prior.get("spread_confidence", 0.0))
        if _sc_lo.size != SLOTS_DAY or _sc_hi.size != SLOTS_DAY:
            log.debug("Solcast P10/P90 skipped: size mismatch (lo=%d hi=%d expected=%d)", _sc_lo.size, _sc_hi.size, SLOTS_DAY)
        elif _sc_conf < 0.65:
            log.debug("Solcast P10/P90 blend skipped: spread_confidence=%.2f < 0.65", _sc_conf)
        else:
            _sc_blend = float(np.clip((_sc_conf - 0.65) / 0.35, 0.0, 1.0))
            for _i in range(SOLAR_START_SLOT, SOLAR_END_SLOT):
                _v = values[_i]
                if _v <= 0 or _sc_lo[_i] <= 0 or _sc_hi[_i] <= _sc_lo[_i]:
                    continue
                # lo[i] and hi[i] are absolute kWh values (not deviations from v)
                # sc_lo and sc_hi are also absolute values from prior_lo_kwh and prior_hi_kwh
                _lo_new = (1 - _sc_blend) * lo[_i] + _sc_blend * _sc_lo[_i]
                _hi_new = (1 - _sc_blend) * hi[_i] + _sc_blend * _sc_hi[_i]
                lo[_i] = float(max(0.0, _lo_new))
                hi[_i] = float(max(lo[_i], _hi_new))

    return lo, hi

# ============================================================================
# FORECAST QUALITY METRICS  (logged after each run)
# ============================================================================

def compute_forecast_metrics(
    actual: np.ndarray | None,
    forecast: np.ndarray | None,
    actual_present: np.ndarray | None = None,
    forecast_present: np.ndarray | None = None,
    exclude_mask: np.ndarray | None = None,
) -> dict | None:
    """Compute solar-window forecast metrics on usable 5-minute slots only."""
    if actual is None or forecast is None:
        return None

    actual_arr = np.nan_to_num(np.asarray(actual, dtype=float), nan=0.0, posinf=0.0, neginf=0.0)
    forecast_arr = np.nan_to_num(np.asarray(forecast, dtype=float), nan=0.0, posinf=0.0, neginf=0.0)
    if actual_arr.size < SLOTS_DAY or forecast_arr.size < SLOTS_DAY:
        return None
    if actual_present is None:
        actual_present_arr = np.ones(SLOTS_DAY, dtype=bool)
    else:
        actual_present_arr = np.asarray(actual_present, dtype=bool)
        if actual_present_arr.size < SLOTS_DAY:
            return None
    if forecast_present is None:
        forecast_present_arr = np.ones(SLOTS_DAY, dtype=bool)
    else:
        forecast_present_arr = np.asarray(forecast_present, dtype=bool)
        if forecast_present_arr.size < SLOTS_DAY:
            return None
    if exclude_mask is None:
        exclude_arr = np.zeros(SLOTS_DAY, dtype=bool)
    else:
        exclude_arr = np.asarray(exclude_mask, dtype=bool)
        if exclude_arr.size < SLOTS_DAY:
            return None

    solar_mask = (
        (np.arange(SLOTS_DAY) >= SOLAR_START_SLOT) &
        (np.arange(SLOTS_DAY) < SOLAR_END_SLOT)
    )
    usable_mask = solar_mask & actual_present_arr & forecast_present_arr & (~exclude_arr)
    if not np.any(usable_mask):
        return None

    act_s = np.clip(actual_arr[usable_mask], 0.0, None)
    fc_s = np.clip(forecast_arr[usable_mask], 0.0, None)
    err = fc_s - act_s
    abs_err = np.abs(err)
    actual_total = float(act_s.sum())
    forecast_total = float(fc_s.sum())

    actual_eval = actual_arr.copy()
    forecast_eval = forecast_arr.copy()
    actual_eval[~usable_mask] = 0.0
    forecast_eval[~usable_mask] = 0.0
    first_actual = _find_first_active_slot(actual_eval)
    first_forecast = _find_first_active_slot(forecast_eval)
    last_actual = _find_last_active_slot(actual_eval)
    last_forecast = _find_last_active_slot(forecast_eval)

    return {
        "slot_count": int(np.count_nonzero(solar_mask)),
        "usable_slot_count": int(np.count_nonzero(usable_mask)),
        "masked_slot_count": int(np.count_nonzero(solar_mask & (~usable_mask))),
        "operational_masked_slot_count": int(np.count_nonzero(solar_mask & exclude_arr)),
        "missing_actual_slot_count": int(np.count_nonzero(solar_mask & (~actual_present_arr))),
        "missing_forecast_slot_count": int(np.count_nonzero(solar_mask & (~forecast_present_arr))),
        "actual_total_kwh": actual_total,
        "forecast_total_kwh": forecast_total,
        "abs_error_sum_kwh": float(abs_err.sum()),
        "mae_kwh": float(np.mean(abs_err)),
        "mbe_kwh": float(np.mean(err)),
        "rmse_kwh": float(np.sqrt(np.mean(err ** 2))),
        "mape_pct": float(np.mean(abs_err / np.maximum(act_s, 1.0)) * 100.0),
        "wape_pct": float((abs_err.sum() / max(actual_total, 1.0)) * 100.0),
        "total_ape_pct": float((abs(forecast_total - actual_total) / max(actual_total, 1.0)) * 100.0),
        "first_active_slot_actual": first_actual,
        "first_active_slot_forecast": first_forecast,
        "last_active_slot_actual": last_actual,
        "last_active_slot_forecast": last_forecast,
        "first_active_error_min": None if first_actual is None or first_forecast is None else int((first_forecast - first_actual) * SLOT_MIN),
        "last_active_error_min": None if last_actual is None or last_forecast is None else int((last_forecast - last_actual) * SLOT_MIN),
    }

def compute_bucketed_forecast_metrics(
    actual: np.ndarray | None,
    forecast: np.ndarray | None,
    bucket_labels: np.ndarray | list[str] | None,
    actual_present: np.ndarray | None = None,
    forecast_present: np.ndarray | None = None,
    exclude_mask: np.ndarray | None = None,
) -> dict[str, dict]:
    if bucket_labels is None:
        return {}
    labels = np.asarray(bucket_labels, dtype=object).reshape(-1)
    if labels.size < SLOTS_DAY:
        return {}
    if exclude_mask is None:
        base_exclude = np.zeros(SLOTS_DAY, dtype=bool)
    else:
        base_exclude = np.asarray(exclude_mask, dtype=bool)
        if base_exclude.size < SLOTS_DAY:
            return {}
    out = {}
    bucket_names = sorted({
        str(label)
        for label in labels[SOLAR_START_SLOT:SOLAR_END_SLOT]
        if str(label) and str(label) != "offsolar"
    })
    for bucket in bucket_names:
        bucket_exclude = np.asarray(base_exclude, dtype=bool).copy()
        bucket_exclude |= labels[:SLOTS_DAY] != bucket
        metrics = compute_forecast_metrics(
            actual,
            forecast,
            actual_present=actual_present,
            forecast_present=forecast_present,
            exclude_mask=bucket_exclude,
        )
        if metrics and int(metrics.get("usable_slot_count", 0)) > 0:
            out[bucket] = metrics
    return out

def compute_error_class_metrics(
    actual: np.ndarray | None,
    hybrid_baseline: np.ndarray | None,
    predicted_labels: np.ndarray | list[int] | None,
    class_confidence: np.ndarray | list[float] | None = None,
    actual_present: np.ndarray | None = None,
    exclude_mask: np.ndarray | None = None,
) -> dict | None:
    if actual is None or hybrid_baseline is None or predicted_labels is None:
        return None
    actual_arr = np.asarray(actual, dtype=float).reshape(-1)
    hybrid_arr = np.asarray(hybrid_baseline, dtype=float).reshape(-1)
    pred_arr = np.asarray(predicted_labels, dtype=int).reshape(-1)
    if actual_arr.size < SLOTS_DAY or hybrid_arr.size < SLOTS_DAY or pred_arr.size < SLOTS_DAY:
        return None
    if actual_present is None:
        actual_present_arr = np.ones(SLOTS_DAY, dtype=bool)
    else:
        actual_present_arr = np.asarray(actual_present, dtype=bool)
        if actual_present_arr.size < SLOTS_DAY:
            return None
    if exclude_mask is None:
        exclude_arr = np.zeros(SLOTS_DAY, dtype=bool)
    else:
        exclude_arr = np.asarray(exclude_mask, dtype=bool)
        if exclude_arr.size < SLOTS_DAY:
            return None
    if class_confidence is None:
        conf_arr = np.zeros(SLOTS_DAY, dtype=float)
    else:
        conf_arr = np.asarray(class_confidence, dtype=float).reshape(-1)
        if conf_arr.size < SLOTS_DAY:
            return None

    usable_mask = (
        (np.arange(SLOTS_DAY) >= SOLAR_START_SLOT)
        & (np.arange(SLOTS_DAY) < SOLAR_END_SLOT)
        & actual_present_arr
        & (~exclude_arr)
    )
    if not np.any(usable_mask):
        return None

    actual_labels = classify_residual_error_classes(
        actual_arr[:SLOTS_DAY] - hybrid_arr[:SLOTS_DAY],
        baseline_kwh=hybrid_arr[:SLOTS_DAY],
    )
    pred_sign = _error_class_sign(pred_arr[:SLOTS_DAY])
    actual_sign = _error_class_sign(actual_labels)
    sign_hit = float(np.mean(pred_sign[usable_mask] == actual_sign[usable_mask]))
    exact_hit = float(np.mean(pred_arr[:SLOTS_DAY][usable_mask] == actual_labels[usable_mask]))
    severe_actual_mask = usable_mask & ((actual_labels == 0) | (actual_labels == 4))
    severe_hit = None
    if np.any(severe_actual_mask):
        severe_hit = float(
            np.mean(
                (pred_arr[:SLOTS_DAY][severe_actual_mask] == actual_labels[severe_actual_mask])
                | (
                    (_error_class_sign(pred_arr[:SLOTS_DAY][severe_actual_mask]) == _error_class_sign(actual_labels[severe_actual_mask]))
                    & ((pred_arr[:SLOTS_DAY][severe_actual_mask] == 0) | (pred_arr[:SLOTS_DAY][severe_actual_mask] == 4))
                )
            )
        )
    return {
        "usable_slot_count": int(np.count_nonzero(usable_mask)),
        "sign_hit_rate": sign_hit,
        "exact_hit_rate": exact_hit,
        "severe_hit_rate": severe_hit,
        "mean_confidence": float(np.mean(conf_arr[:SLOTS_DAY][usable_mask])) if np.any(usable_mask) else 0.0,
    }

def summarize_value_by_bucket(values: np.ndarray | None, bucket_labels: np.ndarray | list[str] | None) -> dict[str, dict]:
    if values is None or bucket_labels is None:
        return {}
    value_arr = np.asarray(values, dtype=float).reshape(-1)
    labels = np.asarray(bucket_labels, dtype=object).reshape(-1)
    if value_arr.size < SLOTS_DAY or labels.size < SLOTS_DAY:
        return {}
    out = {}
    solar_mask = (
        (np.arange(SLOTS_DAY) >= SOLAR_START_SLOT)
        & (np.arange(SLOTS_DAY) < SOLAR_END_SLOT)
    )
    for bucket in sorted({
        str(label)
        for label in labels[SOLAR_START_SLOT:SOLAR_END_SLOT]
        if str(label) and str(label) != "offsolar"
    }):
        slot_mask = solar_mask & (labels[:SLOTS_DAY] == bucket)
        if not np.any(slot_mask):
            continue
        out[bucket] = {
            "slot_count": int(np.count_nonzero(slot_mask)),
            "total_kwh": float(np.sum(value_arr[slot_mask])),
            "mean_kwh": float(np.mean(value_arr[slot_mask])),
        }
    return out

def _format_bucket_metric_summary(bucket_metrics: dict[str, dict] | None) -> str:
    if not bucket_metrics:
        return "n/a"
    parts = []
    for bucket, metrics in sorted(bucket_metrics.items()):
        parts.append(f"{bucket}:WAPE={float(metrics.get('wape_pct', 0.0)):.1f}%")
    return ", ".join(parts) if parts else "n/a"

def _format_minutes(value: int | None) -> str:
    if value is None:
        return "n/a"
    return f"{int(value):+d}m"

def _fetch_run_audit_meta(target_date: str) -> dict:
    fallback = {
        "run_audit_id": 0,
        "generator_mode": "",
        "provider_used": "unknown",
        "provider_expected": "",
        "forecast_variant": "",
        "weather_source": "",
        "solcast_freshness_class": "",
    }
    try:
        with _open_sqlite(APP_DB_FILE, SQLITE_READ_TIMEOUT_SEC, readonly=True) as conn:
            conn.execute("PRAGMA query_only = ON")
            row = conn.execute(
                """
                SELECT id, generator_mode, provider_used, provider_expected,
                       forecast_variant, weather_source, solcast_freshness_class
                  FROM forecast_run_audit
                 WHERE target_date = ?
                   AND run_status = 'success'
                 ORDER BY is_authoritative_runtime DESC, generated_ts DESC
                 LIMIT 1
                """,
                (target_date,)
            ).fetchone()
            if not row:
                row = conn.execute(
                    """
                    SELECT id, generator_mode, provider_used, provider_expected,
                           forecast_variant, weather_source, solcast_freshness_class
                      FROM forecast_run_audit
                     WHERE target_date = ?
                     ORDER BY generated_ts DESC
                     LIMIT 1
                    """,
                    (target_date,)
                ).fetchone()
            if row:
                return {
                    "run_audit_id": int(row[0] or 0),
                    "generator_mode": str(row[1] or ""),
                    "provider_used": str(row[2] or "unknown"),
                    "provider_expected": str(row[3] or ""),
                    "forecast_variant": str(row[4] or ""),
                    "weather_source": str(row[5] or ""),
                    "solcast_freshness_class": str(row[6] or ""),
                }
    except Exception as e:
        log.warning("Failed to fetch run audit for %s: %s", target_date, e)
    return fallback

def _memory_source_weight(forecast_variant: str, provider_expected: str) -> float:
    variant = str(forecast_variant or "").strip().lower()
    expected = str(provider_expected or "").strip().lower()
    if variant == "solcast_direct":
        return 1.00
    if variant == "ml_solcast_hybrid_fresh":
        return 0.95
    if variant == "ml_solcast_hybrid_stale":
        return 0.35 if expected in {"solcast", "ml_local"} else 0.60
    if variant == "ml_without_solcast":
        return 0.20 if expected in {"solcast", "ml_local"} else 0.50
    return 0.50

def _persist_qa_comparison(
    target_date: str,
    run_audit_meta: dict,
    daily_metrics: dict,
    fc_slots: np.ndarray,
    actual_slots: np.ndarray,
    actual_source: str,
    usable_mask: np.ndarray,
    actual_present: np.ndarray,
    forecast_present: np.ndarray,
    operational_mask: np.ndarray,
    manual_constraint_mask: np.ndarray,
    cap_dispatch_mask: np.ndarray,
    slot_weather_buckets: np.ndarray | None = None,
    day_regime: str = "",
    solcast_slots: np.ndarray | None = None,
    solcast_present: np.ndarray | None = None,
    hybrid_baseline_slots: np.ndarray | None = None,
    rad_slots: np.ndarray | None = None,
    cloud_slots: np.ndarray | None = None,
    lo_slots: np.ndarray | None = None,
    hi_slots: np.ndarray | None = None,
    est_actual_recon_slots: int = 0,
) -> None:
    provider_used = str((run_audit_meta or {}).get("provider_used") or "unknown")
    provider_expected = str((run_audit_meta or {}).get("provider_expected") or "")
    forecast_variant = str((run_audit_meta or {}).get("forecast_variant") or "")
    if provider_used == "unknown":
        return

    run_audit_id = int((run_audit_meta or {}).get("run_audit_id") or 0)
    generator_mode = str((run_audit_meta or {}).get("generator_mode") or "")
    weather_source = str((run_audit_meta or {}).get("weather_source") or "")
    solcast_freshness_class = str((run_audit_meta or {}).get("solcast_freshness_class") or "")

    actual_present_arr = np.asarray(actual_present, dtype=bool)
    forecast_present_arr = np.asarray(forecast_present, dtype=bool)
    usable_arr = np.asarray(usable_mask, dtype=bool)
    manual_arr = np.asarray(manual_constraint_mask, dtype=bool)
    cap_arr = np.asarray(cap_dispatch_mask, dtype=bool)
    operational_arr = np.asarray(operational_mask, dtype=bool)

    solar_slice = slice(SOLAR_START_SLOT, SOLAR_END_SLOT)
    usable_slots = int(np.count_nonzero(usable_arr[solar_slice]))
    actual_slots_count = int(np.count_nonzero(actual_present_arr[solar_slice]))
    forecast_slots_count = int(np.count_nonzero(forecast_present_arr[solar_slice]))
    manual_slots_count = int(np.count_nonzero(manual_arr[solar_slice]))
    cap_slots_count = int(np.count_nonzero(cap_arr[solar_slice]))
    operational_slots_count = int(np.count_nonzero(operational_arr[solar_slice]))
    masked_slots_count = int(np.count_nonzero((~usable_arr)[solar_slice]))
    solar_slot_count = max(1, SOLAR_END_SLOT - SOLAR_START_SLOT)
    constrained_ratio = float((manual_slots_count + cap_slots_count) / solar_slot_count)
    degraded_variant = (
        forecast_variant in {"ml_without_solcast", "ml_solcast_hybrid_stale"}
        and solcast_freshness_class != "not_expected"
    )
    provider_mismatch = provider_expected == "solcast" and forecast_variant != "solcast_direct"

    include_in_source_scoring = (
        actual_slots_count >= MIN_USABLE_SLOTS_FOR_ELIGIBILITY
        and forecast_slots_count >= MIN_USABLE_SLOTS_FOR_ELIGIBILITY
    )
    include_in_error_memory = (
        include_in_source_scoring
        and usable_slots >= MIN_USABLE_SLOTS_FOR_ELIGIBILITY
        and constrained_ratio <= 0.30
        and not provider_mismatch
        and solcast_freshness_class not in {"missing", "stale_reject"}
        and not degraded_variant
    )
    comparison_quality = "eligible" if include_in_error_memory else ("review" if include_in_source_scoring else "insufficient")

    total_forecast_kwh = float((daily_metrics or {}).get("forecast_total_kwh", 0.0))
    total_actual_kwh = float((daily_metrics or {}).get("actual_total_kwh", 0.0))
    daily_wape_pct = float((daily_metrics or {}).get("wape_pct", 0.0))
    daily_mape_pct = float((daily_metrics or {}).get("mape_pct", 0.0))
    daily_total_ape_pct = float((daily_metrics or {}).get("total_ape_pct", 0.0)
                                if (daily_metrics or {}).get("total_ape_pct") is not None else 0.0)
    total_abs_error_kwh = float((daily_metrics or {}).get("abs_error_sum_kwh", 0.0))

    lo_arr = np.asarray(lo_slots, dtype=float) if lo_slots is not None else np.zeros(SLOTS_DAY, dtype=float)
    hi_arr = np.asarray(hi_slots, dtype=float) if hi_slots is not None else np.zeros(SLOTS_DAY, dtype=float)
    total_forecast_lo_kwh: float | None = float(np.sum(lo_arr[solar_slice])) if lo_slots is not None else None
    total_forecast_hi_kwh: float | None = float(np.sum(hi_arr[solar_slice])) if hi_slots is not None else None

    support_base = _memory_source_weight(forecast_variant, provider_expected)
    slot_bucket_arr = np.asarray(slot_weather_buckets, dtype=object) if slot_weather_buckets is not None else np.asarray([""] * SLOTS_DAY, dtype=object)
    solcast_arr = np.asarray(solcast_slots, dtype=float) if solcast_slots is not None else np.zeros(SLOTS_DAY, dtype=float)
    solcast_present_arr = np.asarray(solcast_present, dtype=bool) if solcast_present is not None else np.zeros(SLOTS_DAY, dtype=bool)
    hybrid_arr = np.asarray(hybrid_baseline_slots, dtype=float) if hybrid_baseline_slots is not None else np.full(SLOTS_DAY, np.nan, dtype=float)
    rad_arr = np.asarray(rad_slots, dtype=float) if rad_slots is not None else np.full(SLOTS_DAY, np.nan, dtype=float)
    cloud_arr = np.asarray(cloud_slots, dtype=float) if cloud_slots is not None else np.full(SLOTS_DAY, np.nan, dtype=float)

    # v2.8 S1: retry on transient lock. Without this, a single lock
    # contention with Node writers silently drops an entire day of QA
    # comparison data, starving the error-memory learning loop.
    for _qa_attempt in range(1, SQLITE_RETRY_ATTEMPTS + 1):
        try:
            with _open_sqlite(APP_DB_FILE, SQLITE_WRITE_TIMEOUT_SEC, readonly=False) as conn:
                daily_table_info = conn.execute("PRAGMA table_info(forecast_error_compare_daily)").fetchall()
                slot_table_info = conn.execute("PRAGMA table_info(forecast_error_compare_slot)").fetchall()
                daily_target_pk = any(str(row[1] or "") == "target_date" and int(row[5] or 0) == 1 for row in daily_table_info)
                slot_legacy_pk = (
                    any(str(row[1] or "") == "target_date" and int(row[5] or 0) == 1 for row in slot_table_info)
                    and any(str(row[1] or "") == "slot" and int(row[5] or 0) == 2 for row in slot_table_info)
                )
                daily_conflict_target = "target_date" if daily_target_pk else "target_date, run_audit_id"
                slot_conflict_target = "target_date, slot" if slot_legacy_pk else "target_date, run_audit_id, slot"

                if daily_target_pk:
                    conn.execute("DELETE FROM forecast_error_compare_daily WHERE target_date = ?", (target_date,))

                # Compute daily locked snapshot aggregates (Step 10)
                locked_daily_captured_ts = None
                locked_daily_capture_reason = None
                locked_daily_spread_avg = None
                locked_daily_p50_total = 0.0
                locked_daily_p10_total = 0.0
                locked_daily_p90_total = 0.0
                locked_daily_within_band_count = 0
                locked_daily_total_count = 0
                try:
                    for locked_row in conn.execute(
                        """
                        SELECT MIN(captured_ts), capture_reason, AVG(spread_pct_cap),
                               SUM(p50_kwh), SUM(p10_kwh), SUM(p90_kwh)
                          FROM solcast_dayahead_locked
                         WHERE forecast_day = ?
                        """,
                        (target_date,)
                    ):
                        locked_daily_captured_ts = locked_row[0]
                        locked_daily_capture_reason = locked_row[1]
                        locked_daily_spread_avg = locked_row[2]
                        locked_daily_p50_total = float(locked_row[3] or 0.0)
                        locked_daily_p10_total = float(locked_row[4] or 0.0)
                        locked_daily_p90_total = float(locked_row[5] or 0.0)
                except Exception as e:
                    log.debug("Could not compute daily locked aggregates for %s: %s", target_date, e)

                daily_row = conn.execute(
                    f"""
                    INSERT INTO forecast_error_compare_daily(
                        target_date, run_audit_id, generator_mode,
                        provider_used, provider_expected, forecast_variant, weather_source, solcast_freshness_class,
                        total_forecast_kwh, total_forecast_lo_kwh, total_forecast_hi_kwh,
                        total_actual_kwh, total_abs_error_kwh,
                        daily_wape_pct, daily_mape_pct, daily_total_ape_pct,
                        usable_slot_count, masked_slot_count,
                        available_actual_slots, available_forecast_slots,
                        manual_masked_slots, cap_masked_slots, operational_masked_slots,
                        include_in_error_memory, include_in_source_scoring, comparison_quality,
                        computed_ts, notes_json, actual_source,
                        locked_captured_ts, locked_capture_reason, locked_spread_pct_cap_avg,
                        locked_total_p50_kwh, locked_total_p10_kwh, locked_total_p90_kwh
                    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT({daily_conflict_target}) DO UPDATE SET
                        run_audit_id=excluded.run_audit_id,
                        generator_mode=excluded.generator_mode,
                        provider_used=excluded.provider_used,
                        provider_expected=excluded.provider_expected,
                        forecast_variant=excluded.forecast_variant,
                        weather_source=excluded.weather_source,
                        solcast_freshness_class=excluded.solcast_freshness_class,
                        total_forecast_kwh=excluded.total_forecast_kwh,
                        total_forecast_lo_kwh=excluded.total_forecast_lo_kwh,
                        total_forecast_hi_kwh=excluded.total_forecast_hi_kwh,
                        total_actual_kwh=excluded.total_actual_kwh,
                        total_abs_error_kwh=excluded.total_abs_error_kwh,
                        daily_wape_pct=excluded.daily_wape_pct,
                        daily_mape_pct=excluded.daily_mape_pct,
                        daily_total_ape_pct=excluded.daily_total_ape_pct,
                        usable_slot_count=excluded.usable_slot_count,
                        masked_slot_count=excluded.masked_slot_count,
                        available_actual_slots=excluded.available_actual_slots,
                        available_forecast_slots=excluded.available_forecast_slots,
                        manual_masked_slots=excluded.manual_masked_slots,
                        cap_masked_slots=excluded.cap_masked_slots,
                        operational_masked_slots=excluded.operational_masked_slots,
                        include_in_error_memory=excluded.include_in_error_memory,
                        include_in_source_scoring=excluded.include_in_source_scoring,
                        comparison_quality=excluded.comparison_quality,
                        computed_ts=excluded.computed_ts,
                        notes_json=excluded.notes_json,
                        actual_source=excluded.actual_source,
                        locked_captured_ts=excluded.locked_captured_ts,
                        locked_capture_reason=excluded.locked_capture_reason,
                        locked_spread_pct_cap_avg=excluded.locked_spread_pct_cap_avg,
                        locked_total_p50_kwh=excluded.locked_total_p50_kwh,
                        locked_total_p10_kwh=excluded.locked_total_p10_kwh,
                        locked_total_p90_kwh=excluded.locked_total_p90_kwh
                    """,
                    (
                        target_date, run_audit_id, generator_mode,
                        provider_used, provider_expected, forecast_variant, weather_source, solcast_freshness_class,
                        total_forecast_kwh, total_forecast_lo_kwh, total_forecast_hi_kwh,
                        total_actual_kwh, total_abs_error_kwh,
                        daily_wape_pct, daily_mape_pct, daily_total_ape_pct,
                        usable_slots, masked_slots_count,
                        actual_slots_count, forecast_slots_count,
                        manual_slots_count, cap_slots_count, operational_slots_count,
                        int(include_in_error_memory), int(include_in_source_scoring), comparison_quality,
                        int(time.time() * 1000),
                        json.dumps({
                            "degraded_variant": bool(degraded_variant),
                            "provider_mismatch": bool(provider_mismatch),
                            "support_base": float(support_base),
                            "forecast_regime": str(day_regime or ""),
                            "est_actual_recon_slots": int(est_actual_recon_slots),
                        }),
                        str(actual_source or "estimated"),
                        locked_daily_captured_ts, locked_daily_capture_reason, locked_daily_spread_avg,
                        locked_daily_p50_total, locked_daily_p10_total, locked_daily_p90_total,
                    )
                )
                daily_compare_id = int(daily_row.lastrowid or 0)

                if slot_legacy_pk:
                    conn.execute("DELETE FROM forecast_error_compare_slot WHERE target_date = ?", (target_date,))
                else:
                    conn.execute(
                        "DELETE FROM forecast_error_compare_slot WHERE target_date = ? AND run_audit_id = ?",
                        (target_date, run_audit_id),
                    )
                slot_rows = []
                # Pre-fetch locked snapshot data for this day
                locked_rows = {}
                try:
                    for locked_row in conn.execute(
                        "SELECT slot, p50_mw, p10_mw, p90_mw, spread_pct_cap, capture_reason FROM solcast_dayahead_locked WHERE forecast_day = ?",
                        (target_date,)
                    ):
                        locked_rows[int(locked_row[0])] = {
                            'p50_mw': locked_row[1],
                            'p10_mw': locked_row[2],
                            'p90_mw': locked_row[3],
                            'spread_pct_cap': locked_row[4],
                            'capture_reason': locked_row[5],
                        }
                except Exception as e:
                    log.debug("Could not fetch locked snapshots for day %s: %s", target_date, e)

                for slot in range(SOLAR_START_SLOT, SOLAR_END_SLOT):
                    ts_local = int((datetime.fromisoformat(target_date) + timedelta(minutes=slot * SLOT_MIN)).timestamp() * 1000)
                    hh = (slot * SLOT_MIN) // 60
                    mm = (slot * SLOT_MIN) % 60
                    time_hms = f"{int(hh):02d}:{int(mm):02d}:00"
                    fc_val = float(fc_slots[slot])
                    act_present = bool(actual_present_arr[slot])
                    fc_present = bool(forecast_present_arr[slot])
                    act_val = float(actual_slots[slot]) if act_present else None
                    signed_err = (float(act_val) - fc_val) if (act_present and fc_present) else None
                    abs_err = abs(signed_err) if signed_err is not None else None
                    ape = (abs_err / max(abs(float(act_val)), 1.0) * 100.0) if (abs_err is not None and act_present) else None
                    opportunity = float(max(fc_val, 1.0))
                    normalized = (signed_err / max(opportunity, 1.0)) if signed_err is not None else None
                    slot_bucket = str(slot_bucket_arr[slot] or "")
                    support_weight = support_base
                    if opportunity < 2.0:
                        # During rainy/overcast regimes, low-forecast slots ARE the regime — don't penalize them.
                        if day_regime in ("rainy", "overcast"):
                            support_weight *= 0.90   # mild discount only (measurement noise at low generation)
                        else:
                            support_weight *= 0.6    # original: anomalous low slots in clear/mixed
                    if slot_bucket in {"storm_risk", "rain_heavy"}:
                        if day_regime not in ("rainy", "overcast"):
                            support_weight *= 0.75   # original: anomalous storm slots in clear/mixed
                        # rainy/overcast: no penalty — these ARE the regime's characteristic slots

                    usable_metrics = bool(usable_arr[slot])
                    usable_mem = bool(
                        usable_metrics
                        and include_in_error_memory
                        and (not manual_arr[slot])
                        and (not cap_arr[slot])
                        and (not operational_arr[slot])
                        and fc_present
                        and act_present
                    )

                    # Locked snapshot columns: Step 10
                    p50_locked_mw = None
                    p10_locked_mw = None
                    p90_locked_mw = None
                    spread_pct_cap_locked = None
                    err_vs_p50_locked_mw = None
                    err_vs_p10_locked_mw = None
                    err_vs_p90_locked_mw = None
                    actual_within_band = None

                    if slot in locked_rows:
                        locked = locked_rows[slot]
                        p50_locked_mw = locked['p50_mw']
                        p10_locked_mw = locked['p10_mw']
                        p90_locked_mw = locked['p90_mw']
                        spread_pct_cap_locked = locked['spread_pct_cap']
                        if act_present and p50_locked_mw is not None:
                            # Convert actual_kwh to average MW for the 5-min slot
                            actual_mw_slot = (float(act_val) / (5.0 / 60.0)) / 1000.0
                            p50_locked_mw = float(p50_locked_mw) if p50_locked_mw is not None else None
                            p10_locked_mw = float(p10_locked_mw) if p10_locked_mw is not None else None
                            p90_locked_mw = float(p90_locked_mw) if p90_locked_mw is not None else None
                            if p50_locked_mw is not None:
                                err_vs_p50_locked_mw = actual_mw_slot - p50_locked_mw
                            if p10_locked_mw is not None:
                                err_vs_p10_locked_mw = actual_mw_slot - p10_locked_mw
                            if p90_locked_mw is not None:
                                err_vs_p90_locked_mw = actual_mw_slot - p90_locked_mw
                            if p10_locked_mw is not None and p90_locked_mw is not None:
                                actual_within_band = 1 if (p10_locked_mw <= actual_mw_slot <= p90_locked_mw) else 0

                    if actual_within_band is not None:
                        locked_daily_total_count += 1
                        if actual_within_band == 1:
                            locked_daily_within_band_count += 1

                    slot_rows.append((
                        target_date, run_audit_id, daily_compare_id, slot, ts_local, time_hms,
                        provider_used, fc_val, act_val,
                        float(solcast_arr[slot]) if bool(solcast_present_arr[slot]) else None,
                        None,
                        float(hybrid_arr[slot]) if np.isfinite(hybrid_arr[slot]) else None,
                        None, None, None,
                        signed_err, abs_err, ape, normalized, opportunity,
                        slot_bucket, str(day_regime or ""),
                        int(act_present), int(fc_present), int(bool(solcast_present_arr[slot])),
                        int(usable_metrics), int(usable_mem),
                        int(bool(manual_arr[slot])), int(bool(cap_arr[slot])), 0, int(bool(operational_arr[slot])), 1,
                        float(rad_arr[slot]) if np.isfinite(rad_arr[slot]) else None,
                        float(cloud_arr[slot]) if np.isfinite(cloud_arr[slot]) else None,
                        float(max(0.0, min(1.0, support_weight))),
                        str(actual_source or "estimated"),
                        p50_locked_mw, p10_locked_mw, p90_locked_mw, spread_pct_cap_locked,
                        err_vs_p50_locked_mw, err_vs_p10_locked_mw, err_vs_p90_locked_mw, actual_within_band,
                    ))

                if slot_rows:
                    conn.executemany(
                        f"""
                        INSERT INTO forecast_error_compare_slot(
                            target_date, run_audit_id, daily_compare_id, slot, ts_local, time_hms,
                            provider_used, forecast_kwh, actual_kwh, solcast_kwh, physics_kwh, hybrid_baseline_kwh,
                            ml_residual_kwh, error_class_bias_kwh, memory_bias_kwh,
                            signed_error_kwh, abs_error_kwh, ape_pct, normalized_error, opportunity_kwh,
                            slot_weather_bucket, day_regime,
                            actual_present, forecast_present, solcast_present,
                            usable_for_metrics, usable_for_error_memory,
                            manual_constraint_mask, cap_dispatch_mask, curtailed_mask, operational_mask, solar_mask,
                            rad_wm2, cloud_pct, support_weight, actual_source,
                            p50_locked_mw, p10_locked_mw, p90_locked_mw, spread_pct_cap_locked,
                            err_vs_p50_locked_mw, err_vs_p10_locked_mw, err_vs_p90_locked_mw, actual_within_band
                        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT({slot_conflict_target}) DO UPDATE SET
                            run_audit_id=excluded.run_audit_id,
                            daily_compare_id=excluded.daily_compare_id,
                            ts_local=excluded.ts_local,
                            time_hms=excluded.time_hms,
                            provider_used=excluded.provider_used,
                            forecast_kwh=excluded.forecast_kwh,
                            actual_kwh=excluded.actual_kwh,
                            solcast_kwh=excluded.solcast_kwh,
                            physics_kwh=excluded.physics_kwh,
                            hybrid_baseline_kwh=excluded.hybrid_baseline_kwh,
                            ml_residual_kwh=excluded.ml_residual_kwh,
                            error_class_bias_kwh=excluded.error_class_bias_kwh,
                            memory_bias_kwh=excluded.memory_bias_kwh,
                            signed_error_kwh=excluded.signed_error_kwh,
                            abs_error_kwh=excluded.abs_error_kwh,
                            ape_pct=excluded.ape_pct,
                            normalized_error=excluded.normalized_error,
                            opportunity_kwh=excluded.opportunity_kwh,
                            slot_weather_bucket=excluded.slot_weather_bucket,
                            day_regime=excluded.day_regime,
                            actual_present=excluded.actual_present,
                            forecast_present=excluded.forecast_present,
                            solcast_present=excluded.solcast_present,
                            usable_for_metrics=excluded.usable_for_metrics,
                            usable_for_error_memory=excluded.usable_for_error_memory,
                            manual_constraint_mask=excluded.manual_constraint_mask,
                            cap_dispatch_mask=excluded.cap_dispatch_mask,
                            curtailed_mask=excluded.curtailed_mask,
                            operational_mask=excluded.operational_mask,
                            solar_mask=excluded.solar_mask,
                            rad_wm2=excluded.rad_wm2,
                            cloud_pct=excluded.cloud_pct,
                            support_weight=excluded.support_weight,
                            actual_source=excluded.actual_source,
                            p50_locked_mw=excluded.p50_locked_mw,
                            p10_locked_mw=excluded.p10_locked_mw,
                            p90_locked_mw=excluded.p90_locked_mw,
                            spread_pct_cap_locked=excluded.spread_pct_cap_locked,
                            err_vs_p50_locked_mw=excluded.err_vs_p50_locked_mw,
                            err_vs_p10_locked_mw=excluded.err_vs_p10_locked_mw,
                            err_vs_p90_locked_mw=excluded.err_vs_p90_locked_mw,
                            actual_within_band=excluded.actual_within_band
                        """,
                        slot_rows
                    )

                # Step 10 (v2.8): Daily within-band hit-rate aggregate.
                # Computed after slot loop because actual_within_band is per-slot.
                # locked_within_band_pct = % of slots where actual fell inside [P10, P90].
                # Use (target_date, run_audit_id) instead of daily_compare_id because
                # INSERT...ON CONFLICT DO UPDATE leaves lastrowid=0 when an existing
                # row is updated (only set on actual insert).
                if locked_daily_total_count > 0:
                    locked_within_band_pct_val = (
                        locked_daily_within_band_count / locked_daily_total_count
                    ) * 100.0
                    if daily_target_pk:
                        conn.execute(
                            "UPDATE forecast_error_compare_daily SET locked_within_band_pct = ? WHERE target_date = ?",
                            (locked_within_band_pct_val, target_date),
                        )
                    else:
                        conn.execute(
                            "UPDATE forecast_error_compare_daily SET locked_within_band_pct = ? WHERE target_date = ? AND run_audit_id = ?",
                            (locked_within_band_pct_val, target_date, run_audit_id),
                        )

                conn.commit()
            # v2.8 S1: success — exit the retry loop. Without this return,
            # the for loop would continue and re-run the whole write.
            return
        except Exception as e:
            if _qa_attempt < SQLITE_RETRY_ATTEMPTS and _is_retryable_sqlite_error(e):
                log.warning(
                    "QA persist retry %d/%d for %s: %s",
                    _qa_attempt, SQLITE_RETRY_ATTEMPTS, target_date, e,
                )
                _sleep_sqlite_retry(_qa_attempt)
                continue
            log.warning("Failed to persist forecast comparison for %s: %s", target_date, e)
            return

def forecast_qa(today: date) -> None:
    """
    Compute and log forecast accuracy and skill score vs persistence for yesterday.
    Persistence forecast = yesterday's actual shifted to today.
    """
    yesterday = (today - timedelta(days=1)).isoformat()
    day2ago   = (today - timedelta(days=2)).isoformat()

    # E5 priority chain: metered substation → loss-adjusted inverter → Solcast est_actual
    actual, actual_present, actual_source = resolve_actual_5min_for_date(yesterday)
    fc, fc_present = load_dayahead_with_presence(yesterday)
    fc_lo, fc_hi = _load_dayahead_bands_from_db(yesterday)
    pers, pers_present, _ = resolve_actual_5min_for_date(day2ago)   # persistence proxy

    if (
        not np.any(actual_present)
        or fc is None
        or fc_present is None
    ):
        log.info("QA: no data for %s", yesterday)
        return
    log.info("QA: actual source for %s = %s", yesterday, actual_source)

    _, constraint_meta = build_operational_constraint_mask(yesterday)
    # QA exclusion based on 1000H alarm (true inverter manual-stop), NOT audit_log
    # STOP commands.  A node going to 0 Pac is normal MPPT clipping — only alarm
    # 0x1000 indicates the node is genuinely stopped.  Slots are excluded only when
    # ALL nodes of at least one inverter show 1000H (entire inverter down).
    exclude_mask = _build_1000h_inverter_outage_mask(yesterday).copy()
    metrics = compute_forecast_metrics(
        actual,
        fc,
        actual_present=actual_present,
        forecast_present=fc_present,
        exclude_mask=exclude_mask,
    )
    if metrics is None:
        return

    pers_metrics = (
        compute_forecast_metrics(
            actual,
            pers,
            actual_present=actual_present,
            forecast_present=pers_present,
            exclude_mask=exclude_mask,
        )
        if pers is not None and pers_present is not None
        else None
    )
    if pers_metrics is not None and pers_metrics["rmse_kwh"] > 0:
        skill = 1.0 - metrics["rmse_kwh"] / max(pers_metrics["rmse_kwh"], 1.0)
    else:
        skill = float("nan")

    bucket_labels = None
    weather_5min = None
    hybrid_baseline_slots = None
    classifier_metrics = None
    snapshot = load_forecast_weather_snapshot(yesterday)
    snapshot_meta = snapshot.get("meta") if isinstance(snapshot, dict) else {}
    error_debug = snapshot_meta.get("error_class_debug") if isinstance(snapshot_meta, dict) else {}
    if isinstance(error_debug, dict):
        debug_buckets = error_debug.get("slot_weather_buckets")
        if isinstance(debug_buckets, list) and len(debug_buckets) >= SLOTS_DAY:
            bucket_labels = np.asarray(debug_buckets[:SLOTS_DAY], dtype=object)
        hybrid_debug = error_debug.get("hybrid_baseline_kwh")
        if isinstance(hybrid_debug, list) and len(hybrid_debug) >= SLOTS_DAY:
            hybrid_baseline_slots = np.asarray(hybrid_debug[:SLOTS_DAY], dtype=float)
        predicted_debug = error_debug.get("predicted_labels")
        confidence_debug = error_debug.get("class_confidence")
        if (
            isinstance(hybrid_debug, list)
            and len(hybrid_debug) >= SLOTS_DAY
            and isinstance(predicted_debug, list)
            and len(predicted_debug) >= SLOTS_DAY
        ):
            classifier_metrics = compute_error_class_metrics(
                actual,
                np.asarray(hybrid_debug[:SLOTS_DAY], dtype=float),
                np.asarray(predicted_debug[:SLOTS_DAY], dtype=int),
                class_confidence=np.asarray(confidence_debug[:SLOTS_DAY], dtype=float) if isinstance(confidence_debug, list) and len(confidence_debug) >= SLOTS_DAY else None,
                actual_present=actual_present,
                exclude_mask=exclude_mask,
            )
    if bucket_labels is None:
        weather_hourly = load_forecast_weather_for_day(yesterday)
        if weather_hourly is not None and not weather_hourly.empty:
            weather_5min = interpolate_5min(weather_hourly, yesterday)
            bucket_labels = classify_slot_weather_buckets(weather_5min, yesterday)
    if weather_5min is None:
        weather_hourly = load_forecast_weather_for_day(yesterday)
        if weather_hourly is not None and not weather_hourly.empty:
            weather_5min = interpolate_5min(weather_hourly, yesterday)
    bucket_metrics = compute_bucketed_forecast_metrics(
        actual,
        fc,
        bucket_labels,
        actual_present=actual_present,
        forecast_present=fc_present,
        exclude_mask=exclude_mask,
    ) if bucket_labels is not None else {}
    solcast_metrics = None
    solcast_bucket_metrics = {}
    solcast_snapshot = load_solcast_snapshot(yesterday)
    solcast_forecast = np.zeros(SLOTS_DAY, dtype=float)
    solcast_present = np.zeros(SLOTS_DAY, dtype=bool)
    if solcast_snapshot:
        solcast_forecast = np.clip(np.asarray(solcast_snapshot.get("forecast_kwh"), dtype=float), 0.0, None)
        solcast_present = np.asarray(solcast_snapshot.get("present"), dtype=bool)
        solcast_metrics = compute_forecast_metrics(
            actual,
            solcast_forecast,
            actual_present=actual_present,
            forecast_present=solcast_present,
            exclude_mask=exclude_mask,
        )
        solcast_bucket_metrics = compute_bucketed_forecast_metrics(
            actual,
            solcast_forecast,
            bucket_labels,
            actual_present=actual_present,
            forecast_present=solcast_present,
            exclude_mask=exclude_mask,
        ) if bucket_labels is not None else {}
    day_regime = str(
        snapshot_meta.get("target_regime")
        or ((snapshot.get("applied_signature") or {}).get("day_regime") if isinstance(snapshot, dict) else "")
        or ((snapshot.get("signature") or {}).get("day_regime") if isinstance(snapshot, dict) else "")
        or ""
    )
    # Ensure day_regime is never empty — compute from weather data if snapshot lacked it
    # (backfills, manual runs, or pre-v2.7.17 snapshots may not have target_regime).
    if not day_regime and weather_5min is not None and not weather_5min.empty:
        _qa_stats = analyse_weather_day(yesterday, weather_5min, actual)
        day_regime = classify_day_regime(_qa_stats)
        log.debug("QA: day_regime computed from weather data for %s: %s", yesterday, day_regime)

    # ── Est_actual reconstruction for QA comparison ──
    # When actual energy data is unreliable due to capping, manual start/stops,
    # or low inverter availability, replace with Solcast estimated actuals so
    # the day can still be compared against the day-ahead forecast.
    actual_recon = np.asarray(actual, dtype=float).copy()
    actual_present_recon = np.asarray(actual_present, dtype=bool).copy()
    est_actual_recon_slots = 0
    manual_mask_raw = np.asarray(constraint_meta.get("manual_constraint_mask"), dtype=bool).copy()
    cap_mask_raw = np.asarray(constraint_meta.get("cap_dispatch_mask"), dtype=bool).copy()
    manual_mask_recon = manual_mask_raw.copy()
    cap_mask_recon = cap_mask_raw.copy()
    exclude_recon = np.asarray(exclude_mask, dtype=bool).copy()

    est_actual_gap_fill_slots = 0
    if solcast_snapshot:
        est_actual_kwh = np.asarray(
            solcast_snapshot.get("est_actual_kwh", np.zeros(SLOTS_DAY)), dtype=float
        )
        solar_slot_mask = np.zeros(SLOTS_DAY, dtype=bool)
        solar_slot_mask[SOLAR_START_SLOT:SOLAR_END_SLOT] = True
        est_available = (est_actual_kwh > 0.0) & np.isfinite(est_actual_kwh) & solar_slot_mask

        # A2: Gap-fill — slots where actual is missing but est_actual is available.
        # This captures brief inverter comm drops and partial data gaps not flagged
        # as formal outages.  Gap-filled slots get full trust (no constraint flag).
        gap_fill_mask = (~actual_present_recon) & est_available
        if np.any(gap_fill_mask):
            actual_recon[gap_fill_mask] = est_actual_kwh[gap_fill_mask]
            actual_present_recon[gap_fill_mask] = True
            est_actual_gap_fill_slots = int(np.count_nonzero(gap_fill_mask))
            log.info(
                "QA [%s] est_actual gap-fill: %d missing solar slots filled from Solcast",
                yesterday,
                est_actual_gap_fill_slots,
            )

        # Detect outage/low-availability slots
        outage_mask = _detect_outage_slots(yesterday)
        # Slots needing reconstruction: outage, cap-dispatch, manual-constraint, or 1000H alarm
        needs_recon = (outage_mask | cap_mask_raw | manual_mask_raw | exclude_recon) & solar_slot_mask
        recon_mask = needs_recon & est_available

        if np.any(recon_mask):
            actual_recon[recon_mask] = est_actual_kwh[recon_mask]
            actual_present_recon[recon_mask] = True
            # Clear constraint flags for reconstructed slots so they become usable.
            # This flows into _persist_qa_comparison() which sets usable_for_error_memory=1,
            # and compute_error_memory() trusts that persisted flag (no inline re-check).
            manual_mask_recon[recon_mask] = False
            cap_mask_recon[recon_mask] = False
            exclude_recon[recon_mask] = False
            est_actual_recon_slots = int(np.count_nonzero(recon_mask))
            log.info(
                "QA [%s] est_actual reconstruction: %d slots replaced "
                "(outage=%d, cap=%d, manual=%d, 1000H=%d)",
                yesterday,
                est_actual_recon_slots,
                int(np.count_nonzero(outage_mask & recon_mask)),
                int(np.count_nonzero(cap_mask_raw & recon_mask)),
                int(np.count_nonzero(manual_mask_raw & recon_mask)),
                int(np.count_nonzero(np.asarray(exclude_mask, dtype=bool) & recon_mask)),
            )

    # Recompute metrics with reconstructed/gap-filled actual data
    if est_actual_recon_slots > 0 or est_actual_gap_fill_slots > 0:
        metrics = compute_forecast_metrics(
            actual_recon,
            fc,
            actual_present=actual_present_recon,
            forecast_present=fc_present,
            exclude_mask=exclude_recon,
        )
        if metrics is None:
            return
        bucket_metrics = compute_bucketed_forecast_metrics(
            actual_recon,
            fc,
            bucket_labels,
            actual_present=actual_present_recon,
            forecast_present=fc_present,
            exclude_mask=exclude_recon,
        ) if bucket_labels is not None else bucket_metrics
        pers_metrics = (
            compute_forecast_metrics(
                actual_recon,
                pers,
                actual_present=actual_present_recon,
                forecast_present=pers_present,
                exclude_mask=exclude_recon,
            )
            if pers is not None and pers_present is not None
            else None
        )
        if pers_metrics is not None and pers_metrics["rmse_kwh"] > 0:
            skill = 1.0 - metrics["rmse_kwh"] / max(pers_metrics["rmse_kwh"], 1.0)
        else:
            skill = float("nan")

    run_audit_meta = _fetch_run_audit_meta(yesterday)
    actual_present_arr = np.asarray(actual_present_recon, dtype=bool)
    fc_present_arr = np.asarray(fc_present, dtype=bool)
    exclude_arr = exclude_recon
    manual_mask_arr = manual_mask_recon
    cap_mask_arr = cap_mask_recon
    usable_mask = actual_present_arr & fc_present_arr & (~exclude_arr)

    rad_slots = None
    cloud_slots = None
    if weather_5min is not None and not weather_5min.empty:
        rad_slots = pd.to_numeric(weather_5min.get("rad"), errors="coerce").fillna(0.0).values
        cloud_slots = pd.to_numeric(weather_5min.get("cloud"), errors="coerce").fillna(0.0).values

    _persist_qa_comparison(
        yesterday,
        run_audit_meta,
        metrics,
        fc,
        actual_recon,
        actual_source,
        usable_mask,
        actual_present_arr,
        fc_present_arr,
        exclude_arr,
        manual_mask_arr,
        cap_mask_arr,
        slot_weather_buckets=bucket_labels,
        day_regime=day_regime,
        solcast_slots=solcast_forecast,
        solcast_present=solcast_present,
        hybrid_baseline_slots=hybrid_baseline_slots,
        rad_slots=rad_slots,
        cloud_slots=cloud_slots,
        lo_slots=fc_lo,
        hi_slots=fc_hi,
        est_actual_recon_slots=est_actual_recon_slots,
    )

    resolution_debug = _build_resolution_daily_record(
        yesterday,
        day_regime,
        solcast_metrics,
        metrics,
        solcast_bucket_metrics,
        bucket_metrics,
    )
    overall_resolution = resolution_debug.get("overall") if isinstance(resolution_debug.get("overall"), dict) else {}
    if overall_resolution.get("solcast") or overall_resolution.get("dayahead"):
        update_forecast_weather_snapshot_meta(yesterday, {"resolution_debug": resolution_debug})

    log.info(
        "QA [%s] usable=%d masked=%d WAPE=%.1f%% MAPE=%.1f%% TotalAPE=%.1f%% MBE=%.1f kWh/slot RMSE=%.1f kWh/slot First=%s Last=%s Skill=%.3f est_recon=%d gap_fill=%d",
        yesterday,
        metrics["usable_slot_count"],
        metrics["masked_slot_count"],
        metrics["wape_pct"],
        metrics["mape_pct"],
        metrics["total_ape_pct"],
        metrics["mbe_kwh"],
        metrics["rmse_kwh"],
        _format_minutes(metrics["first_active_error_min"]),
        _format_minutes(metrics["last_active_error_min"]),
        skill,
        est_actual_recon_slots,
        est_actual_gap_fill_slots,
    )
    log.info("QA weather buckets [%s] %s", yesterday, _format_bucket_metric_summary(bucket_metrics))
    if overall_resolution:
        log.info(
            "QA resolution [%s] winner=%s solcast_weight=%.2f support_days=%d",
            yesterday,
            overall_resolution.get("preferred_source"),
            float(overall_resolution.get("solcast_weight", SOLCAST_RESOLUTION_WEIGHT_FALLBACK)),
            int(overall_resolution.get("support_days", 0)),
        )
    if classifier_metrics is not None:
        log.info(
            "QA classifier [%s] sign_hit=%.3f exact_hit=%.3f severe_hit=%s mean_conf=%.2f",
            yesterday,
            float(classifier_metrics.get("sign_hit_rate", 0.0)),
            float(classifier_metrics.get("exact_hit_rate", 0.0)),
            f"{float(classifier_metrics['severe_hit_rate']):.3f}" if classifier_metrics.get("severe_hit_rate") is not None else "n/a",
            float(classifier_metrics.get("mean_confidence", 0.0)),
        )

def backfill_qa_comparisons(days_back: int = 15) -> int:
    """Re-run QA comparison for recent past dates to apply est_actual reconstruction.

    Returns the number of dates successfully reprocessed.
    """
    today_local = datetime.now(_TZ_UTC8).date()
    reprocessed = 0
    for offset in range(1, days_back + 1):
        target_today = today_local - timedelta(days=offset - 1)
        try:
            forecast_qa(target_today)
            reprocessed += 1
        except Exception as e:
            log.warning("backfill_qa_comparisons: failed for %s: %s",
                        target_today.isoformat(), e)
    log.info("backfill_qa_comparisons: reprocessed %d/%d dates", reprocessed, days_back)
    return reprocessed

# ============================================================================
# OUTPUT SERIALISER
# ============================================================================

def to_ui_series(
    values: np.ndarray,
    lo: np.ndarray,
    hi: np.ndarray,
    day: str,
) -> list[dict]:
    base_time = datetime.fromisoformat(day) + timedelta(hours=SOLAR_START_H)
    solar_vals = values[SOLAR_START_SLOT:SOLAR_END_SLOT]
    solar_lo   = lo[SOLAR_START_SLOT:SOLAR_END_SLOT]
    solar_hi   = hi[SOLAR_START_SLOT:SOLAR_END_SLOT]

    return [
        {
            "time":    (base_time + timedelta(minutes=i * SLOT_MIN)).strftime("%H:%M:%S"),
            "kWh_inc": round(float(v),  6),
            "kWh_lo":  round(float(l),  6),
            "kWh_hi":  round(float(h),  6),
        }
        for i, (v, l, h) in enumerate(zip(solar_vals, solar_lo, solar_hi))
    ]

def _forecast_table_name_for_key(key: str) -> str | None:
    mapping = {
        "PacEnergy_DayAhead": "forecast_dayahead",
        "PacEnergy_IntradayAdjusted": "forecast_intraday_adjusted",
    }
    return mapping.get(str(key or "").strip())

def _ensure_forecast_table(conn: sqlite3.Connection, table_name: str) -> None:
    index_prefix = "fd" if table_name == "forecast_dayahead" else "fia"
    conn.execute(
        f"""
        CREATE TABLE IF NOT EXISTS {table_name} (
            date       TEXT NOT NULL,
            ts         INTEGER NOT NULL,
            slot       INTEGER NOT NULL,
            time_hms   TEXT NOT NULL,
            kwh_inc    REAL NOT NULL DEFAULT 0,
            kwh_lo     REAL DEFAULT 0,
            kwh_hi     REAL DEFAULT 0,
            source     TEXT DEFAULT 'service',
            updated_ts INTEGER NOT NULL,
            series_run_id TEXT,
            PRIMARY KEY(date, slot)
        )
        """
    )
    try:
        conn.execute(f"ALTER TABLE {table_name} ADD COLUMN series_run_id TEXT")
    except sqlite3.OperationalError:
        pass
    conn.execute(f"CREATE INDEX IF NOT EXISTS idx_{index_prefix}_ts ON {table_name}(ts)")
    conn.execute(f"CREATE INDEX IF NOT EXISTS idx_{index_prefix}_date_ts ON {table_name}(date, ts)")

def _write_forecast_db(
    key: str,
    day: str,
    series: list[dict],
    updated_ts: int | None = None,
) -> bool:
    """
    Persist day-ahead slots to SQLite so forecast data is unified with AppData DB.
    Keeps file write path for compatibility while DB is now the source of truth.
    """
    table_name = _forecast_table_name_for_key(key)
    if table_name is None:
        return True
    if not series:
        return True

    try:
        day_dt = datetime.fromisoformat(day)
    except Exception:
        log.error("DB forecast write skipped: invalid day=%s", day)
        return False

    rows = []
    write_ts = int(updated_ts if updated_ts is not None else time.time() * 1000)
    for rec in series:
        t = str(rec.get("time", "")).strip()
        try:
            hh, mm, ss = [int(x) for x in t.split(":")]
        except Exception:
            continue
        ts = int(datetime(day_dt.year, day_dt.month, day_dt.day, hh, mm, ss).timestamp() * 1000)
        slot = int((hh * 60 + mm) // SLOT_MIN)
        if slot < 0 or slot >= SLOTS_DAY:
            continue
        rows.append(
            (
                str(day),
                ts,
                slot,
                f"{hh:02d}:{mm:02d}:{ss:02d}",
                float(rec.get("kWh_inc", rec.get("kwh_inc", 0)) or 0.0),
                float(rec.get("kWh_lo", rec.get("kwh_lo", 0)) or 0.0),
                float(rec.get("kWh_hi", rec.get("kwh_hi", 0)) or 0.0),
                "service",
                write_ts,
                rec.get("series_run_id"),
            )
        )

    for attempt in range(1, SQLITE_RETRY_ATTEMPTS + 1):
        try:
            with _open_sqlite(APP_DB_FILE, SQLITE_WRITE_TIMEOUT_SEC, readonly=False) as conn:
                _ensure_forecast_table(conn, table_name)
                cur = conn.cursor()
                cur.execute(f"DELETE FROM {table_name} WHERE date=?", (str(day),))
                cur.executemany(
                    f"""
                    INSERT INTO {table_name}
                    (date, ts, slot, time_hms, kwh_inc, kwh_lo, kwh_hi, source, updated_ts, series_run_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(date, slot) DO UPDATE SET
                        ts=excluded.ts,
                        time_hms=excluded.time_hms,
                        kwh_inc=excluded.kwh_inc,
                        kwh_lo=excluded.kwh_lo,
                        kwh_hi=excluded.kwh_hi,
                        source=excluded.source,
                        updated_ts=excluded.updated_ts,
                        series_run_id=excluded.series_run_id
                    """,
                    rows,
                )
                conn.commit()
            clear_forecast_data_cache()
            log.info("Wrote forecast DB [%s:%s] - %d slots", key, day, len(rows))
            return True
        except Exception as e:
            if attempt < SQLITE_RETRY_ATTEMPTS and _is_retryable_sqlite_error(e):
                log.warning(
                    "DB forecast write retry %d/%d for %s:%s: %s",
                    attempt,
                    SQLITE_RETRY_ATTEMPTS,
                    key,
                    day,
                    e,
                )
                _sleep_sqlite_retry(attempt)
                continue
            log.error("DB forecast write failed for %s:%s: %s", key, day, e)
            return False

def _classify_variant_from_solcast_meta(solcast_meta: dict) -> str:
    """Derive forecast_variant string from solcast_meta dict."""
    if not solcast_meta or not bool(solcast_meta.get("used_solcast")):
        return "ml_without_solcast"
    coverage = float(solcast_meta.get("coverage_ratio", 0.0))
    mean_blend = float(solcast_meta.get("mean_blend", 0.0))
    if coverage >= SOLCAST_COVERAGE_FRESH_THRESHOLD and mean_blend >= 0.5:
        return "ml_solcast_hybrid_fresh"
    return "ml_solcast_hybrid_stale"

def _classify_solcast_freshness_python(solcast_meta: dict) -> str:
    """Derive Solcast freshness class from solcast_meta dict."""
    import time as _time
    if not solcast_meta or not bool(solcast_meta.get("used_solcast")):
        return "not_expected"
    coverage = float(solcast_meta.get("coverage_ratio", 0.0))
    freshness_class = (
        "fresh"
        if coverage >= SOLCAST_COVERAGE_FRESH_THRESHOLD
        else ("stale_usable" if coverage >= SOLCAST_COVERAGE_USABLE_THRESHOLD else "stale_reject")
    )

    # Check age and downgrade if too old
    _pulled_ts = solcast_meta.get("pulled_ts") or solcast_meta.get("fetched_at") or 0
    _age_hours = (_time.time() - float(_pulled_ts)) / 3600.0 if _pulled_ts else 999.0

    # Downgrade "fresh" to "stale_usable" if older than 4 hours
    if freshness_class == "fresh" and _age_hours > 4.0:
        log.debug("Solcast snapshot age %.1fh > 4h - downgraded from fresh to stale_usable", _age_hours)
        freshness_class = "stale_usable"
    # Downgrade "stale_usable" to "stale_reject" if older than 12 hours
    elif freshness_class == "stale_usable" and _age_hours > 12.0:
        log.debug("Solcast snapshot age %.1fh > 12h - downgraded to stale_reject", _age_hours)
        freshness_class = "stale_reject"

    return freshness_class

def _write_forecast_run_audit_from_python(
    target_date,
    generator_mode: str,
    weather_source: str,
    solcast_meta: dict,
    forecast_total_kwh: float,
    baseline_total_kwh: float,
    hybrid_total_kwh: float,
    ml_total_kwh: float,
    error_class_total_kwh: float,
    bias_total_kwh: float,
    ml_failed: bool = False,
    notes_extra: dict | None = None,
    solcast_lo_total_kwh: float | None = None,
    solcast_hi_total_kwh: float | None = None,
) -> int | None:
    """Write a forecast_run_audit row from Python direct generation path.

    Returns the new row id, or None on exception (logs warning, does not
    fail generation).
    """
    if solcast_meta is None:
        solcast_meta = {}
    target_s = str(target_date)
    variant = _classify_variant_from_solcast_meta(solcast_meta)
    if ml_failed:
        variant = f"{variant}_ml_fallback"
    freshness = _classify_solcast_freshness_python(solcast_meta)

    # Compute quality class based on generation outcome
    quality_class = "healthy"  # default
    if ml_failed:
        quality_class = "weak_quality"
    elif freshness == "stale_reject":
        quality_class = "stale_input"
    elif not bool(solcast_meta.get("used_solcast")):
        # Solcast was not used — check if it should have been
        coverage = float(solcast_meta.get("coverage_ratio", 0.0))
        if coverage > 0.0 and coverage < SOLCAST_COVERAGE_USABLE_THRESHOLD:
            quality_class = "incomplete"  # Partial Solcast data
        # else: no Solcast available, which is acceptable for weather-only fallback
    else:
        # Solcast was used — check for quality issues
        coverage = float(solcast_meta.get("coverage_ratio", 0.0))
        if coverage < SOLCAST_COVERAGE_USABLE_THRESHOLD:
            quality_class = "incomplete"
        elif freshness == "stale_usable":
            quality_class = "stale_input"

    generated_ts = int(time.time() * 1000)

    # v2.8 S2: retry on transient lock so the authoritative audit row
    # isn't silently dropped when Node is mid-write. Each attempt opens
    # a fresh write connection to avoid inheriting any partial state.
    for _attempt in range(1, SQLITE_RETRY_ATTEMPTS + 1):
        try:
            with _open_sqlite(APP_DB_FILE, SQLITE_WRITE_TIMEOUT_SEC, readonly=False) as conn:
                # Check for existing authoritative audit row to supersede
                prev_row = conn.execute(
                    """
                    SELECT id FROM forecast_run_audit
                     WHERE target_date = ?
                       AND is_authoritative_runtime = 1
                       AND run_status = 'success'
                     ORDER BY generated_ts DESC LIMIT 1
                    """,
                    (target_s,),
                ).fetchone()
                prev_id = int(prev_row[0]) if prev_row else None

                notes_dict: dict = {"source": "python_direct", "generator_mode": generator_mode}
                if notes_extra:
                    notes_dict.update(notes_extra)
                notes = json.dumps(notes_dict)
                cur = conn.execute(
                    """
                    INSERT INTO forecast_run_audit(
                        target_date, generated_ts, generator_mode,
                        provider_used, provider_expected,
                        forecast_variant, weather_source,
                        solcast_snapshot_coverage_ratio, solcast_mean_blend,
                        solcast_reliability, solcast_primary_mode, solcast_snapshot_source,
                        physics_total_kwh, hybrid_total_kwh,
                        final_forecast_total_kwh, ml_residual_total_kwh,
                        error_class_total_kwh, bias_total_kwh,
                        shape_skipped_for_solcast,
                        run_status, solcast_freshness_class,
                        is_authoritative_runtime, is_authoritative_learning,
                        replaces_run_audit_id, notes_json,
                        solcast_lo_total_kwh, solcast_hi_total_kwh, baseline_is_solcast_mid
                    ) VALUES(
                        ?, ?, ?,
                        ?, ?,
                        ?, ?,
                        ?, ?,
                        ?, ?, ?,
                        ?, ?,
                        ?, ?,
                        ?, ?,
                        ?,
                        ?, ?,
                        ?, ?,
                        ?, ?,
                        ?, ?, ?
                    )
                    """,
                    (
                        target_s, generated_ts, generator_mode,
                        "ml_local", "ml_local",
                        variant, weather_source,
                        float(solcast_meta.get("coverage_ratio", 0.0)),
                        float(solcast_meta.get("mean_blend", 0.0)),
                        float(solcast_meta.get("reliability", 0.0)),
                        1 if bool(solcast_meta.get("primary_mode")) else 0,
                        str(solcast_meta.get("source", "")),
                        float(baseline_total_kwh),
                        float(hybrid_total_kwh),
                        float(forecast_total_kwh),
                        float(ml_total_kwh),
                        float(error_class_total_kwh),
                        float(bias_total_kwh),
                        1 if bool(solcast_meta.get("used_solcast")) else 0,
                        "success", freshness,
                        1, 1,
                        prev_id, notes,
                        float(solcast_lo_total_kwh) if solcast_lo_total_kwh is not None else None,
                        float(solcast_hi_total_kwh) if solcast_hi_total_kwh is not None else None,
                        1 if bool(solcast_meta.get("used_solcast")) else 0,  # baseline_is_solcast_mid: 0 on physics fallback
                    ),
                )
                new_id = cur.lastrowid

                # Supersede previous authoritative row
                if prev_id is not None and new_id:
                    conn.execute(
                        """
                        UPDATE forecast_run_audit
                           SET is_authoritative_runtime = 0,
                               is_authoritative_learning = 0,
                               superseded_by_run_audit_id = ?,
                               run_status = 'superseded'
                         WHERE id = ?
                        """,
                        (new_id, prev_id),
                    )

                conn.commit()
                if ml_failed:
                    log.warning("Forecast written with ML fallback (Solcast baseline only) - quality degraded")
                log.info(
                    "Python audit row written for %s: id=%s variant=%s freshness=%s (replaces=%s)",
                    target_s, new_id, variant, freshness, prev_id,
                )
                return new_id
        except Exception as e:
            if _attempt < SQLITE_RETRY_ATTEMPTS and _is_retryable_sqlite_error(e):
                log.warning(
                    "forecast_run_audit write retry %d/%d for %s: %s",
                    _attempt, SQLITE_RETRY_ATTEMPTS, target_s, e,
                )
                _sleep_sqlite_retry(_attempt)
                continue
            log.warning("Failed to write forecast_run_audit from Python for %s: %s", target_s, e)
            return None
    return None

def _constraint_snapshot_for_replay(day_s: str) -> dict:
    _, constraint_meta = build_operational_constraint_mask(day_s)
    cap_dispatch = np.asarray(
        constraint_meta.get("cap_dispatch_mask", np.zeros(SLOTS_DAY)), dtype=bool
    )
    manual = np.asarray(
        constraint_meta.get("manual_constraint_mask", np.zeros(SLOTS_DAY)), dtype=bool
    )
    outage = np.asarray(_build_1000h_inverter_outage_mask(day_s), dtype=bool)
    for name, arr in (("cap_dispatch", cap_dispatch), ("manual", manual), ("outage", outage)):
        if arr.size != SLOTS_DAY:
            raise ValueError(f"{name} constraint mask has {arr.size} slots, expected {SLOTS_DAY}")
    blend_override = _setting_float_or_none("forecastIntradayBlendMax", 0.0, 1.0)
    inverter_node_map = _get_inverter_node_map()
    reporting_capacity_kw = {
        str(int(inverter)): float(max(1, len(nodes)) * NODE_KW_DEPENDABLE)
        for inverter, nodes in sorted(inverter_node_map.items())
        if nodes
    }
    if not reporting_capacity_kw:
        raise ValueError("cannot capture replay basis without inverter topology")
    physical_profile = plant_capacity_profile()
    export_limit_mw = float(load_forecast_export_limit_mw())
    export_cap_slot_kwh = export_limit_mw * 1000.0 * SLOT_MIN / 60.0
    return {
        "schema_version": 2,
        "captured_ts": int(time.time() * 1000),
        "slot_cap_kwh": float(slot_cap_kwh(False)),
        "cap_dispatch_mask": cap_dispatch.astype(np.uint8).tolist(),
        "manual_constraint_mask": manual.astype(np.uint8).tolist(),
        "outage_mask": outage.astype(np.uint8).tolist(),
        "constraint_event_count": int(constraint_meta.get("event_count", 0) or 0),
        "export_curtailment": {
            "tolerance": float(CAP_DISPATCH_TOLERANCE),
            "export_limit_mw": export_limit_mw,
            "export_cap_slot_kwh": export_cap_slot_kwh,
            "baseline_multiplier": 1.05,
        },
        "capacity_basis": {
            "inverter_node_map": {
                str(int(inverter)): [int(node) for node in nodes]
                for inverter, nodes in sorted(inverter_node_map.items())
            },
            "reporting_capacity_kw": reporting_capacity_kw,
            "total_reporting_capacity_kw": float(sum(reporting_capacity_kw.values())),
            "node_kw_dependable": float(NODE_KW_DEPENDABLE),
            "plant_max_kw": float(physical_profile.get("max_kw", 0.0)),
            "plant_dependable_kw": float(physical_profile.get("dependable_kw", 0.0)),
        },
        "nowcast_config": {
            "forecastIntradayBlendMax": float(
                INTRADAY_BLEND_MAX if blend_override is None else blend_override
            ),
        },
    }


def _parse_replay_constraint_snapshot(snapshot: dict) -> dict:
    """Validate and normalise every causal setting/topology replay depends on."""
    if not isinstance(snapshot, dict) or type(snapshot.get("schema_version")) is not int:
        raise ValueError("invalid constraint snapshot schema")
    if snapshot.get("schema_version") != 2:
        raise ValueError("unsupported constraint snapshot schema")
    slot_cap = float(snapshot.get("slot_cap_kwh"))
    blend_max = float((snapshot.get("nowcast_config") or {}).get("forecastIntradayBlendMax"))
    if not math.isfinite(slot_cap) or slot_cap <= 0.0:
        raise ValueError("invalid physical slot cap")
    if not math.isfinite(blend_max) or not 0.0 <= blend_max <= 1.0:
        raise ValueError("invalid issue-time blend setting")

    masks = {
        "cap_dispatch_mask": _normalise_slot_mask(snapshot.get("cap_dispatch_mask")),
        "manual_constraint_mask": _normalise_slot_mask(snapshot.get("manual_constraint_mask")),
        "outage_mask": _normalise_slot_mask(snapshot.get("outage_mask")),
    }
    export = snapshot.get("export_curtailment")
    if not isinstance(export, dict):
        raise ValueError("missing export-curtailment basis")
    tolerance = float(export.get("tolerance"))
    export_limit_mw = float(export.get("export_limit_mw"))
    export_cap_slot = float(export.get("export_cap_slot_kwh"))
    baseline_multiplier = float(export.get("baseline_multiplier"))
    expected_export_slot = export_limit_mw * 1000.0 * SLOT_MIN / 60.0
    if (
        not all(math.isfinite(v) for v in (tolerance, export_limit_mw, export_cap_slot, baseline_multiplier))
        or not 0.0 < tolerance <= 1.0 or export_limit_mw <= 0.0
        or export_cap_slot <= 0.0 or baseline_multiplier <= 1.0
        or not math.isclose(export_cap_slot, expected_export_slot, rel_tol=1e-9, abs_tol=1e-9)
    ):
        raise ValueError("invalid export-curtailment basis")

    basis = snapshot.get("capacity_basis")
    if not isinstance(basis, dict):
        raise ValueError("missing capacity/topology basis")
    raw_node_map = basis.get("inverter_node_map")
    raw_capacities = basis.get("reporting_capacity_kw")
    if not isinstance(raw_node_map, dict) or not isinstance(raw_capacities, dict):
        raise ValueError("invalid capacity/topology basis")
    node_map: dict[int, list[int]] = {}
    capacities: dict[int, float] = {}
    for raw_inv, raw_nodes in raw_node_map.items():
        inv = int(raw_inv)
        nodes = _sanitize_units(raw_nodes)
        if inv <= 0 or not nodes or len(nodes) != len(raw_nodes):
            raise ValueError("invalid inverter topology")
        node_map[inv] = nodes
    for raw_inv, raw_capacity in raw_capacities.items():
        inv = int(raw_inv)
        capacity = float(raw_capacity)
        if inv <= 0 or not math.isfinite(capacity) or capacity <= 0.0:
            raise ValueError("invalid reporting capacity")
        capacities[inv] = capacity
    if not node_map or set(node_map) != set(capacities):
        raise ValueError("topology and reporting capacity disagree")
    total_capacity = float(basis.get("total_reporting_capacity_kw"))
    plant_max_kw = float(basis.get("plant_max_kw"))
    plant_dependable_kw = float(basis.get("plant_dependable_kw"))
    if (
        not all(math.isfinite(v) and v > 0.0 for v in (total_capacity, plant_max_kw, plant_dependable_kw))
        or not math.isclose(total_capacity, sum(capacities.values()), rel_tol=1e-9, abs_tol=1e-6)
        or not math.isclose(slot_cap, plant_max_kw * SLOT_MIN / 60.0, rel_tol=1e-9, abs_tol=1e-6)
    ):
        raise ValueError("inconsistent capacity basis")
    return {
        **masks,
        "slot_cap_kwh": slot_cap,
        "blend_max": blend_max,
        "export_curtailment": {
            "tolerance": tolerance,
            "export_limit_mw": export_limit_mw,
            "export_cap_slot_kwh": export_cap_slot,
            "baseline_multiplier": baseline_multiplier,
        },
        "inverter_node_map": node_map,
        "reporting_capacity_kw": capacities,
    }

def _capture_immutable_dayahead_issuance(
    day_s: str,
    series: list[dict],
    weather_snapshot: dict,
    *,
    base_run_audit_id: int | None = None,
    source: str = "service",
    constraint_snapshot: dict | None = None,
) -> str | None:
    """Append one complete causal replay issuance after weather/audit success."""
    if not isinstance(weather_snapshot, dict) or str(weather_snapshot.get("day") or "") != str(day_s):
        log.warning("Immutable day-ahead capture skipped [%s]: exact weather snapshot unavailable", day_s)
        return None
    try:
        constraints = constraint_snapshot if constraint_snapshot is not None else _constraint_snapshot_for_replay(day_s)
        parsed_constraints = _parse_replay_constraint_snapshot(constraints)
    except Exception as exc:
        log.warning("Immutable day-ahead capture rejected [%s]: invalid causal constraint basis: %s", day_s, exc)
        return None

    parsed_rows: list[tuple[int, str, float, float, float]] = []
    seen_slots: set[int] = set()
    cap = float(parsed_constraints["slot_cap_kwh"])
    for rec in series or []:
        if not isinstance(rec, dict):
            return None
        time_hms = str(rec.get("time") or rec.get("time_hms") or "")
        slot = _parse_slot_from_time_text(day_s, time_hms)
        mid = _coerce_optional_non_negative_float(rec.get("kWh_inc", rec.get("kwh_inc")))
        low = _coerce_optional_non_negative_float(rec.get("kWh_lo", rec.get("kwh_lo")))
        high = _coerce_optional_non_negative_float(rec.get("kWh_hi", rec.get("kwh_hi")))
        if (
            slot is None or slot in seen_slots or mid is None or low is None or high is None
            or not (SOLAR_START_SLOT <= slot < SOLAR_END_SLOT)
            or low > mid + 1e-9 or mid > high + 1e-9 or high > cap + 1e-9
        ):
            log.warning("Immutable day-ahead capture rejected [%s]: invalid slot/band", day_s)
            return None
        seen_slots.add(slot)
        parsed_rows.append((int(slot), time_hms, float(mid), float(low), float(high)))
    if seen_slots != set(range(SOLAR_START_SLOT, SOLAR_END_SLOT)):
        log.warning("Immutable day-ahead capture rejected [%s]: incomplete solar slot set", day_s)
        return None

    try:
        weather_json, weather_sha = _canonical_json_sha256(weather_snapshot)
        constraint_json, constraint_sha = _canonical_json_sha256(constraints)
        checksum = _immutable_basis_checksum(parsed_rows)
        generated_ts = int(time.time() * 1000)
        issuance_id = f"DI-{generated_ts}-{uuid.uuid4().hex[:10]}"
        model_sha = _file_sha256(MODEL_BUNDLE_FILE) if MODEL_BUNDLE_FILE.exists() else None
        artifact_sha = _file_sha256(ARTIFACT_FILE) if ARTIFACT_FILE.exists() else None
        with _open_sqlite(APP_DB_FILE, SQLITE_WRITE_TIMEOUT_SEC, readonly=False) as conn:
            _ensure_immutable_dayahead_tables(conn)
            conn.commit()
            conn.execute("BEGIN IMMEDIATE")
            conn.execute(
                """
                INSERT INTO forecast_dayahead_issuance(
                    issuance_id, date, generated_ts, source, expected_slot_count,
                    basis_checksum, weather_snapshot_json, weather_snapshot_sha256,
                    constraint_snapshot_json, constraint_snapshot_sha256,
                    model_sha256, artifact_sha256, base_run_audit_id, created_by
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    issuance_id, str(day_s), generated_ts, str(source or "service"),
                    len(parsed_rows), checksum, weather_json, weather_sha,
                    constraint_json, constraint_sha, model_sha, artifact_sha,
                    int(base_run_audit_id) if base_run_audit_id is not None else None,
                    "forecast_engine",
                ),
            )
            conn.executemany(
                """
                INSERT INTO forecast_dayahead_immutable(
                    date, issuance_id, generated_ts, slot, time_hms,
                    kwh_inc, kwh_lo, kwh_hi, source
                ) VALUES(?,?,?,?,?,?,?,?,?)
                """,
                [
                    (str(day_s), issuance_id, generated_ts, slot, time_hms, mid, low, high, str(source or "service"))
                    for slot, time_hms, mid, low, high in parsed_rows
                ],
            )
            conn.commit()
        return issuance_id
    except Exception as exc:
        log.warning("Immutable day-ahead capture failed [%s]: %s", day_s, exc)
        return None

def write_forecast(
    key: str,
    day: str,
    series: list[dict],
    *,
    updated_ts: int | None = None,
) -> bool:
    ctx = _load_json(FORECAST_CTX)
    ctx.setdefault(key, {})[day] = series
    ok_file = _save_json(FORECAST_CTX, ctx)
    ok_db = (
        _write_forecast_db(key, day, series)
        if updated_ts is None
        else _write_forecast_db(key, day, series, updated_ts=updated_ts)
    )
    if ok_file:
        log.info("Wrote %s[%s] %d slots", key, day, len(series))
    if ok_db and not ok_file:
        log.warning("Legacy forecast JSON write failed for %s; DB write succeeded and remains authoritative.", day)
    elif ok_file and not ok_db:
        log.warning("Forecast DB write failed for %s; legacy JSON fallback succeeded.", day)
    return bool(ok_db) if _forecast_table_name_for_key(key) is not None else bool(ok_file)

def load_forecast_weather_for_day(day: str) -> pd.DataFrame | None:
    snap = load_forecast_weather_snapshot(day)
    if snap:
        applied = _weather_records_to_frame(list(snap.get("applied_hourly") or []), day)
        if not applied.empty:
            return applied
        raw = _weather_records_to_frame(list(snap.get("raw_hourly") or []), day)
        if not raw.empty:
            return raw
    source = "forecast" if not _is_past_day(day) else "archive"
    return fetch_weather(day, source=source)

def _weighted_median(values: np.ndarray, weights: np.ndarray) -> float:
    """Robust weighted median with finite-value and positive-weight guards."""
    vals = np.asarray(values, dtype=float).reshape(-1)
    wts = np.asarray(weights, dtype=float).reshape(-1)
    valid = np.isfinite(vals) & np.isfinite(wts) & (wts > 0)
    vals = vals[valid]
    wts = wts[valid]
    if vals.size == 0:
        raise ValueError("weighted median requires at least one finite value")
    order = np.argsort(vals, kind="stable")
    vals = vals[order]
    wts = wts[order]
    cumulative = np.cumsum(wts)
    idx = int(np.searchsorted(cumulative, cumulative[-1] / 2.0, side="left"))
    return float(vals[min(idx, vals.size - 1)])

def _nowcast_short_weight(lead_minutes: float, half_life_minutes: float = NOWCAST_HALF_LIFE_MINUTES) -> float:
    half_life = max(float(half_life_minutes), 1.0)
    return float(math.exp(-math.log(2.0) * max(0.0, float(lead_minutes)) / half_life))

def _intraday_cutoff_slot(actual_present: np.ndarray, cutoff_slot: int | None) -> int:
    if cutoff_slot is not None:
        return int(np.clip(int(cutoff_slot), 0, SLOTS_DAY - 1))
    present = np.where(np.asarray(actual_present, dtype=bool))[0]
    return int(present[-1]) if present.size else -1

def _load_intraday_inputs(day_s: str) -> dict:
    dayahead, dayahead_present = load_dayahead_with_presence(day_s)
    actual, actual_present = load_actual_loss_adjusted_with_presence(day_s, min_solar_slots=0)
    _, constraint_meta = build_operational_constraint_mask(day_s)
    outage = _build_1000h_inverter_outage_mask(day_s).copy()
    cap_dispatch = np.asarray(
        constraint_meta.get("cap_dispatch_mask", np.zeros(SLOTS_DAY)), dtype=bool
    )
    manual_constraint = np.asarray(
        constraint_meta.get("manual_constraint_mask", np.zeros(SLOTS_DAY)), dtype=bool
    )
    if cap_dispatch.size != SLOTS_DAY:
        cap_dispatch = np.resize(cap_dispatch, SLOTS_DAY).astype(bool)
    if manual_constraint.size != SLOTS_DAY:
        manual_constraint = np.resize(manual_constraint, SLOTS_DAY).astype(bool)
    return {
        "dayahead": None if dayahead is None else np.asarray(dayahead, dtype=float),
        "dayahead_present": dayahead_present,
        "actual": None if actual is None else np.asarray(actual, dtype=float),
        "actual_present": actual_present,
        "outage_mask": np.asarray(outage, dtype=bool),
        "cap_dispatch_mask": cap_dispatch,
        "constraint_meta": constraint_meta,
    }

def _intraday_weather_frame(day_s: str) -> pd.DataFrame:
    weather_hourly = load_forecast_weather_for_day(day_s)
    if weather_hourly is not None and not weather_hourly.empty:
        return interpolate_5min(weather_hourly, day_s)
    return pd.DataFrame({
        "cloud": np.zeros(SLOTS_DAY), "cloud_low": np.zeros(SLOTS_DAY),
        "cloud_mid": np.zeros(SLOTS_DAY), "cloud_high": np.zeros(SLOTS_DAY),
        "rad": np.zeros(SLOTS_DAY), "rh": np.zeros(SLOTS_DAY),
        "temp": np.zeros(SLOTS_DAY), "wind": np.zeros(SLOTS_DAY),
        "precip": np.zeros(SLOTS_DAY), "cape": np.zeros(SLOTS_DAY),
    })

def _normalise_slot_mask(value, default: bool = False) -> np.ndarray:
    if value is None:
        return np.full(SLOTS_DAY, bool(default), dtype=bool)
    arr = np.asarray(value, dtype=bool).reshape(-1)
    if arr.size != SLOTS_DAY:
        raise ValueError(f"slot mask has {arr.size} values, expected {SLOTS_DAY}")
    return arr.copy()

def _prepare_nowcast_inputs(inputs: dict) -> tuple[dict | None, dict]:
    """Validate observation presence and physical bounds without fabricating zeros."""
    diagnostics = {
        "excluded_invalid_actual_slots": 0,
        "excluded_over_cap_actual_slots": 0,
        "invalid_dayahead_slots": 0,
    }
    if not isinstance(inputs, dict) or inputs.get("dayahead") is None or inputs.get("actual") is None:
        return None, diagnostics
    try:
        dayahead_raw = np.asarray(inputs["dayahead"], dtype=float).reshape(-1)
        actual_raw = np.asarray(inputs["actual"], dtype=float).reshape(-1)
        if dayahead_raw.size != SLOTS_DAY or actual_raw.size != SLOTS_DAY:
            return None, diagnostics
        requested_cap = inputs.get("slot_cap_kwh")
        cap = float(requested_cap) if requested_cap is not None else float(slot_cap_kwh(False))
        if not math.isfinite(cap) or cap <= 0.0:
            return None, diagnostics
        dayahead_present = _normalise_slot_mask(
            inputs.get("dayahead_present"), default=True
        )
        actual_present = _normalise_slot_mask(inputs.get("actual_present"), default=False)
        outage = _normalise_slot_mask(inputs.get("outage_mask"), default=False)
        cap_dispatch = _normalise_slot_mask(inputs.get("cap_dispatch_mask"), default=False)
        manual_constraint = _normalise_slot_mask(
            inputs.get("manual_constraint_mask"), default=False
        )
        export_curtailment = (
            _normalise_slot_mask(inputs.get("export_curtailment_mask"), default=False)
            if "export_curtailment_mask" in inputs else None
        )
    except Exception:
        return None, diagnostics

    dayahead_valid = (
        np.isfinite(dayahead_raw) & (dayahead_raw >= 0.0) & (dayahead_raw <= cap + 1e-9)
    )
    invalid_da = dayahead_present & (~dayahead_valid)
    diagnostics["invalid_dayahead_slots"] = int(np.count_nonzero(invalid_da))
    dayahead_present &= dayahead_valid
    # A nowcast must have one complete physical baseline over the solar window.
    if not np.all(dayahead_present[SOLAR_START_SLOT:SOLAR_END_SLOT]):
        return None, diagnostics

    finite_non_negative = np.isfinite(actual_raw) & (actual_raw >= 0.0)
    over_cap = finite_non_negative & (actual_raw > cap + 1e-9)
    diagnostics["excluded_invalid_actual_slots"] = int(
        np.count_nonzero(actual_present & (~finite_non_negative))
    )
    diagnostics["excluded_over_cap_actual_slots"] = int(
        np.count_nonzero(actual_present & over_cap)
    )
    actual_present &= finite_non_negative & (~over_cap)
    return {
        **inputs,
        "dayahead": np.where(dayahead_present, dayahead_raw, 0.0),
        "dayahead_present": dayahead_present,
        "actual": np.where(actual_present, actual_raw, 0.0),
        "actual_present": actual_present,
        "outage_mask": outage,
        "cap_dispatch_mask": cap_dispatch,
        "manual_constraint_mask": manual_constraint,
        "export_curtailment_mask": export_curtailment,
        "slot_cap_kwh": cap,
    }, diagnostics

def _validate_nowcast_output(
    values: np.ndarray,
    lo: np.ndarray,
    hi: np.ndarray,
    meta: dict,
) -> tuple[np.ndarray, np.ndarray, np.ndarray] | None:
    """Enforce the common finite/cap/P10<=P50<=P90 output contract."""
    try:
        mid = np.asarray(values, dtype=float).reshape(-1).copy()
        low = np.asarray(lo, dtype=float).reshape(-1).copy()
        high = np.asarray(hi, dtype=float).reshape(-1).copy()
        if mid.size != SLOTS_DAY or low.size != SLOTS_DAY or high.size != SLOTS_DAY:
            raise ValueError("wrong slot count")
        if not (np.all(np.isfinite(mid)) and np.all(np.isfinite(low)) and np.all(np.isfinite(high))):
            raise ValueError("non-finite output")
        cap = float(meta.get("slot_cap_kwh") or slot_cap_kwh(False))
        corrections = int(np.count_nonzero(
            (mid < 0.0) | (mid > cap) | (low < 0.0) | (low > mid)
            | (high < mid) | (high > cap)
        ))
        mid = np.clip(mid, 0.0, cap)
        low = np.clip(low, 0.0, mid)
        high = np.clip(high, mid, cap)
        mid[:SOLAR_START_SLOT] = low[:SOLAR_START_SLOT] = high[:SOLAR_START_SLOT] = 0.0
        mid[SOLAR_END_SLOT:] = low[SOLAR_END_SLOT:] = high[SOLAR_END_SLOT:] = 0.0
        meta["output_validation_corrections"] = corrections
        return mid, low, high
    except Exception as exc:
        meta["fallback_reason"] = f"invalid_band_or_series:{type(exc).__name__}"
        meta["run_status"] = "failed"
        return None

def _weather_frame_from_issuance_snapshot(day_s: str, snapshot: dict) -> pd.DataFrame | None:
    if not isinstance(snapshot, dict) or str(snapshot.get("day") or "") != str(day_s):
        return None
    records = list(snapshot.get("applied_hourly") or snapshot.get("raw_hourly") or [])
    hourly = _weather_records_to_frame(records, day_s)
    if hourly.empty:
        return None
    frame = interpolate_5min(hourly, day_s)
    return frame if len(frame) == SLOTS_DAY else None

def _build_current_intraday_adjusted_forecast(
    day: date,
    cutoff_slot: int | None = None,
    input_bundle: dict | None = None,
) -> tuple[list[dict] | None, dict]:
    """Original ratio-space algorithm retained as champion and rollback path."""
    day_s = day.isoformat()
    raw_inputs = input_bundle if input_bundle is not None else _load_intraday_inputs(day_s)
    inputs, input_diagnostics = _prepare_nowcast_inputs(raw_inputs)
    if inputs is None:
        return None, {
            "day": day_s,
            "algorithm_version": NOWCAST_CURRENT_ALGORITHM_VERSION,
            "execution_mode": "off",
            "run_status": "skipped",
            "fallback_reason": "invalid_or_incomplete_inputs",
            **input_diagnostics,
        }
    dayahead = inputs["dayahead"]
    actual = inputs["actual"]
    actual_present = inputs["actual_present"]
    inverter_outage_mask = inputs["outage_mask"]
    cap_dispatch_mask = inputs["cap_dispatch_mask"]
    manual_constraint_mask = inputs["manual_constraint_mask"]
    operational_mask = inverter_outage_mask | cap_dispatch_mask | manual_constraint_mask
    meta = {
        "day": day_s,
        "algorithm_version": NOWCAST_CURRENT_ALGORITHM_VERSION,
        "execution_mode": "off",
        "observed_slots": 0,
        "last_observed_slot": None,
        "global_ratio": 1.0,
        "recent_ratio": 1.0,
        "strength": 0.0,
        "constraint_mode": "none",
        "run_status": "skipped",
        "slot_cap_kwh": float(inputs["slot_cap_kwh"]),
        **input_diagnostics,
    }
    if dayahead is None or actual is None or actual_present is None:
        meta["fallback_reason"] = "missing_dayahead_or_actual"
        return None, meta

    dayahead = np.asarray(dayahead, dtype=float)
    actual = np.asarray(actual, dtype=float)
    actual_present_arr = np.array(actual_present, dtype=bool, copy=True)
    cutoff = _intraday_cutoff_slot(actual_present_arr, cutoff_slot)
    visible = np.arange(SLOTS_DAY) <= cutoff
    actual_present_arr &= visible
    unconstrained_mask = actual_present_arr & (~operational_mask)
    cap_free_mask = actual_present_arr & (~cap_dispatch_mask)
    fallback_mask = actual_present_arr.copy()

    if inputs.get("export_curtailment_mask") is not None:
        export_curtailed = inputs["export_curtailment_mask"]
    else:
        try:
            export_curtailed = curtailed_mask(actual, dayahead)
        except Exception:
            export_curtailed = np.zeros(len(actual_present_arr), dtype=bool)
    unconstrained_mask = unconstrained_mask & (~export_curtailed)

    def solar_slots(mask: np.ndarray) -> np.ndarray:
        return np.where(np.asarray(mask, dtype=bool)[SOLAR_START_SLOT:SOLAR_END_SLOT])[0] + SOLAR_START_SLOT

    solar_obs = solar_slots(unconstrained_mask)
    constraint_mode = "unconstrained"
    if solar_obs.size < INTRADAY_MIN_OBS_SLOTS:
        solar_obs = solar_slots(cap_free_mask)
        constraint_mode = "cap-free"
    if solar_obs.size < INTRADAY_MIN_OBS_SLOTS:
        solar_obs = solar_slots(fallback_mask)
        constraint_mode = "all-observed"
    if solar_obs.size < INTRADAY_MIN_OBS_SLOTS:
        meta["observed_slots"] = int(solar_obs.size)
        meta["constraint_mode"] = constraint_mode
        meta["fallback_reason"] = "insufficient_observed_slots"
        return None, meta

    observed_slots = solar_obs[-min(int(solar_obs.size), INTRADAY_MAX_OBS_SLOTS):]
    last_observed_slot = int(observed_slots[-1])
    obs_mask = np.zeros(SLOTS_DAY, dtype=bool)
    obs_mask[observed_slots] = True
    adjusted = dayahead.copy()
    adjusted[actual_present_arr] = actual[actual_present_arr]

    dayahead_obs_total = float(dayahead[obs_mask].sum())
    actual_obs_total = float(actual[obs_mask].sum())
    global_ratio = float(np.clip(actual_obs_total / max(dayahead_obs_total, 1.0), INTRADAY_RATIO_CLIP[0], INTRADAY_RATIO_CLIP[1]))

    recent_slots = observed_slots[-12:]
    recent_mask = np.zeros(SLOTS_DAY, dtype=bool)
    recent_mask[recent_slots] = True
    dayahead_recent_total = float(dayahead[recent_mask].sum())
    actual_recent_total = float(actual[recent_mask].sum())
    recent_ratio = float(np.clip(actual_recent_total / max(dayahead_recent_total, 1.0), INTRADAY_RECENT_RATIO_CLIP[0], INTRADAY_RECENT_RATIO_CLIP[1]))
    # Operator override (option A): `forecastIntradayBlendMax` caps how strongly
    # intraday observed-vs-dayahead corrections are blended in; unset = engine default.
    if input_bundle is not None and inputs.get("blend_max") is not None:
        _blend_max = float(np.clip(float(inputs["blend_max"]), 0.0, 1.0))
    else:
        _blend_max_ovr = _setting_float_or_none("forecastIntradayBlendMax", 0.0, 1.0)
        _blend_max = INTRADAY_BLEND_MAX if _blend_max_ovr is None else _blend_max_ovr
    strength = float(min(_blend_max, 0.24 + 0.02 * len(observed_slots)))

    cap_slot = float(inputs["slot_cap_kwh"])
    for step, slot in enumerate(range(cutoff + 1, SOLAR_END_SLOT)):
        fade = min(1.0, step / 24.0)
        target_ratio = (1.0 - fade) * recent_ratio + fade * global_ratio
        factor = 1.0 + strength * (target_ratio - 1.0)
        adjusted[slot] = float(np.clip(dayahead[slot] * factor, 0.0, cap_slot))

    for slot in range(max(SOLAR_START_SLOT + 1, cutoff + 1), SOLAR_END_SLOT):
        upper = adjusted[slot - 1] + 320.0
        lower = max(0.0, adjusted[slot - 1] - 320.0)
        adjusted[slot] = float(np.clip(adjusted[slot], lower, min(cap_slot, upper)))

    adjusted[:SOLAR_START_SLOT] = 0.0
    adjusted[SOLAR_END_SLOT:] = 0.0

    w5 = inputs.get("weather_frame") if input_bundle is not None else None
    if not isinstance(w5, pd.DataFrame):
        w5 = _intraday_weather_frame(day_s)
    lo, hi = confidence_bands(adjusted, w5, day_s)
    for slot in range(SOLAR_START_SLOT, SOLAR_END_SLOT):
        lo[slot] = float(np.clip(lo[slot], 0.0, adjusted[slot]))
        hi[slot] = float(np.clip(hi[slot], adjusted[slot], cap_slot))

    validated = _validate_nowcast_output(adjusted, lo, hi, meta)
    if validated is None:
        return None, meta
    adjusted, lo, hi = validated
    meta.update({
        "observed_slots": int(len(observed_slots)),
        "last_observed_slot": last_observed_slot,
        "global_ratio": global_ratio,
        "recent_ratio": recent_ratio,
        "strength": strength,
        "constraint_mode": constraint_mode,
        "cutoff_slot": cutoff,
        "cap_dispatch_slots": int(np.count_nonzero(cap_dispatch_mask[SOLAR_START_SLOT:SOLAR_END_SLOT])),
        "operational_slots": int(np.count_nonzero(operational_mask[SOLAR_START_SLOT:SOLAR_END_SLOT])),
        "run_status": "success",
    })
    return to_ui_series(adjusted, lo, hi, day_s), meta

def _build_robust_intraday_nowcast(
    day: date,
    cutoff_slot: int | None = None,
    input_bundle: dict | None = None,
) -> tuple[list[dict] | None, dict]:
    """Leakage-safe robust log-ratio nowcast challenger."""
    day_s = day.isoformat()
    raw_inputs = input_bundle if input_bundle is not None else _load_intraday_inputs(day_s)
    inputs, input_diagnostics = _prepare_nowcast_inputs(raw_inputs)
    if inputs is None:
        return None, {
            "day": day_s,
            "algorithm_version": NOWCAST_ALGORITHM_VERSION,
            "execution_mode": "shadow",
            "actual_source": "pac_loss_adjusted",
            "run_status": "skipped",
            "fallback_reason": "invalid_or_incomplete_inputs",
            **input_diagnostics,
        }
    dayahead = inputs["dayahead"]
    actual = inputs["actual"]
    actual_present = inputs["actual_present"]
    outage_mask = inputs["outage_mask"]
    cap_dispatch_mask = inputs["cap_dispatch_mask"]
    manual_constraint_mask = inputs["manual_constraint_mask"]
    meta = {
        "day": day_s,
        "algorithm_version": NOWCAST_ALGORITHM_VERSION,
        "execution_mode": "shadow",
        "actual_source": "pac_loss_adjusted",
        "eligible_slots": 0,
        "observed_slots": 0,
        "cutoff_slot": None,
        "last_observed_slot": None,
        "recent_log_ratio": None,
        "session_log_ratio": None,
        "strength": 0.0,
        "half_life_minutes": NOWCAST_HALF_LIFE_MINUTES,
        "constraint_mode": "strict_unconstrained",
        "run_status": "fallback",
        "fallback_reason": None,
        "slot_cap_kwh": float(inputs["slot_cap_kwh"]),
        **input_diagnostics,
    }
    if dayahead is None or actual is None or actual_present is None:
        meta["fallback_reason"] = "missing_dayahead_or_actual"
        return None, meta

    dayahead = np.asarray(dayahead, dtype=float)
    actual = np.asarray(actual, dtype=float)
    present = np.array(actual_present, dtype=bool, copy=True)
    cutoff = _intraday_cutoff_slot(present, cutoff_slot)
    visible = np.arange(SLOTS_DAY) <= cutoff
    present &= visible
    meta["cutoff_slot"] = cutoff
    meta["observed_slots"] = int(np.count_nonzero(present[SOLAR_START_SLOT:SOLAR_END_SLOT]))

    if inputs.get("export_curtailment_mask") is not None:
        export_curtailed = inputs["export_curtailment_mask"]
    else:
        try:
            export_curtailed = curtailed_mask(actual, dayahead)
        except Exception:
            export_curtailed = np.zeros(SLOTS_DAY, dtype=bool)
    capacity_coverage = inputs.get("capacity_coverage") if input_bundle is not None else None
    if capacity_coverage is None:
        capacity_coverage = _load_energy_reporting_coverage(day_s)
    capacity_coverage = np.asarray(capacity_coverage, dtype=float).reshape(-1)
    if capacity_coverage.size != SLOTS_DAY:
        capacity_coverage = np.zeros(SLOTS_DAY, dtype=float)
    capacity_coverage = np.where(np.isfinite(capacity_coverage), np.clip(capacity_coverage, 0.0, 1.0), 0.0)
    solar = (np.arange(SLOTS_DAY) >= SOLAR_START_SLOT) & (np.arange(SLOTS_DAY) < SOLAR_END_SLOT)
    baseline_quality = dayahead >= NOWCAST_MIN_BASELINE_ENERGY
    capacity_quality = capacity_coverage >= NOWCAST_MIN_CAPACITY_COVERAGE
    eligible_mask = (
        present & solar & baseline_quality & capacity_quality
        & (~cap_dispatch_mask) & (~manual_constraint_mask)
        & (~outage_mask) & (~export_curtailed)
    )
    eligible_slots = np.where(eligible_mask)[0]
    if eligible_slots.size > INTRADAY_MAX_OBS_SLOTS:
        eligible_slots = eligible_slots[-INTRADAY_MAX_OBS_SLOTS:]
    meta.update({
        "eligible_slots": int(eligible_slots.size),
        "excluded_cap_slots": int(np.count_nonzero(present & cap_dispatch_mask & solar)),
        "excluded_manual_slots": int(np.count_nonzero(present & manual_constraint_mask & solar)),
        "excluded_outage_slots": int(np.count_nonzero(present & outage_mask & solar)),
        "excluded_curtailed_slots": int(np.count_nonzero(present & export_curtailed & solar)),
        "excluded_quality_slots": int(np.count_nonzero(present & solar & (~baseline_quality | ~capacity_quality))),
        "capacity_coverage_mean": float(np.mean(capacity_coverage[eligible_slots])) if eligible_slots.size else 0.0,
    })

    adjusted = dayahead.copy()
    adjusted[present] = actual[present]
    factors = np.ones(SLOTS_DAY, dtype=float)
    fallback_reason = None
    if eligible_slots.size < INTRADAY_MIN_OBS_SLOTS:
        fallback_reason = "insufficient_eligible_slots"
    else:
        try:
            session_slots = eligible_slots[-INTRADAY_MAX_OBS_SLOTS:]
            recent_slots = session_slots[-NOWCAST_RECENT_SLOTS:]
            log_ratios = np.log(
                np.maximum(actual[session_slots], NOWCAST_LOG_RATIO_EPSILON)
                / np.maximum(dayahead[session_slots], NOWCAST_LOG_RATIO_EPSILON)
            )
            session_weights = np.exp(np.linspace(-1.6, 0.0, session_slots.size))
            recent_values = log_ratios[-recent_slots.size:]
            recent_weights = np.exp(np.linspace(-1.8, 0.0, recent_slots.size))
            session_bias = _weighted_median(log_ratios, session_weights)
            recent_bias = _weighted_median(recent_values, recent_weights)
            volatility = float(np.std(recent_values)) if recent_values.size > 1 else 0.0
            count_conf = float(np.clip(session_slots.size / 18.0, 0.0, 1.0))
            energy_conf = 0.65 + 0.35 * float(np.clip(np.median(dayahead[session_slots]) / 40.0, 0.0, 1.0))
            coverage_mean = float(np.mean(capacity_coverage[session_slots]))
            coverage_conf = 0.70 + 0.30 * float(np.clip(
                (coverage_mean - NOWCAST_MIN_CAPACITY_COVERAGE)
                / max(1.0 - NOWCAST_MIN_CAPACITY_COVERAGE, 1e-6), 0.0, 1.0
            ))
            volatility_conf = NOWCAST_VOLATILITY_DAMP if volatility >= 0.35 else float(np.clip(1.0 - 0.35 * volatility, NOWCAST_VOLATILITY_DAMP, 1.0))
            if input_bundle is not None and inputs.get("blend_max") is not None:
                blend_max = float(np.clip(float(inputs["blend_max"]), 0.0, 1.0))
            else:
                blend_override = _setting_float_or_none("forecastIntradayBlendMax", 0.0, 1.0)
                blend_max = INTRADAY_BLEND_MAX if blend_override is None else blend_override
            strength = float(np.clip(
                blend_max * count_conf * energy_conf * coverage_conf * volatility_conf,
                0.0, blend_max,
            ))
            last_observed_slot = int(session_slots[-1])
            cap_slot = float(inputs["slot_cap_kwh"])
            for slot in range(cutoff + 1, SOLAR_END_SLOT):
                lead_minutes = float((slot - cutoff) * SLOT_MIN)
                short_weight = _nowcast_short_weight(lead_minutes)
                # The complete correction fades toward the immutable day-ahead
                # baseline. Keeping a permanent session component would make
                # the half-life claim false and over-correct the late horizon.
                bias = strength * short_weight * (
                    (1.0 - NOWCAST_RECENT_MIX) * session_bias
                    + NOWCAST_RECENT_MIX * recent_bias
                )
                factor = float(np.clip(math.exp(bias), NOWCAST_RATIO_FLOOR, NOWCAST_RATIO_CEILING))
                factors[slot] = factor
                adjusted[slot] = float(np.clip(dayahead[slot] * factor, 0.0, cap_slot))
            for slot in range(max(SOLAR_START_SLOT + 1, cutoff + 1), SOLAR_END_SLOT):
                adjusted[slot] = float(np.clip(
                    adjusted[slot], max(0.0, adjusted[slot - 1] - 320.0), min(cap_slot, adjusted[slot - 1] + 320.0)
                ))
            meta.update({
                "last_observed_slot": last_observed_slot,
                "recent_log_ratio": float(recent_bias),
                "session_log_ratio": float(session_bias),
                "recent_ratio": float(math.exp(recent_bias)),
                "global_ratio": float(math.exp(session_bias)),
                "ratio_volatility": volatility,
                "strength": strength,
                "run_status": "success",
            })
        except Exception as exc:
            fallback_reason = f"calculation_error:{type(exc).__name__}"

    if fallback_reason:
        meta["fallback_reason"] = fallback_reason
        meta["run_status"] = "fallback"
    adjusted[:SOLAR_START_SLOT] = 0.0
    adjusted[SOLAR_END_SLOT:] = 0.0
    cap_slot = float(inputs["slot_cap_kwh"])
    w5 = inputs.get("weather_frame") if input_bundle is not None else None
    if not isinstance(w5, pd.DataFrame):
        w5 = _intraday_weather_frame(day_s)
    base_lo = inputs.get("dayahead_lo") if input_bundle is not None else None
    base_hi = inputs.get("dayahead_hi") if input_bundle is not None else None
    if base_lo is None or base_hi is None:
        base_lo, base_hi = _load_dayahead_bands_from_db(day_s)
    base_lo = np.nan_to_num(base_lo, nan=0.0, posinf=0.0, neginf=0.0)
    base_hi = np.nan_to_num(base_hi, nan=0.0, posinf=0.0, neginf=0.0)
    if not np.any(base_hi > base_lo):
        base_lo, base_hi = confidence_bands(dayahead, w5, day_s)
        base_lo = np.nan_to_num(base_lo, nan=0.0, posinf=0.0, neginf=0.0)
        base_hi = np.nan_to_num(base_hi, nan=0.0, posinf=0.0, neginf=0.0)
    lo = np.zeros(SLOTS_DAY, dtype=float)
    hi = np.zeros(SLOTS_DAY, dtype=float)
    last_obs = int(meta.get("last_observed_slot") if meta.get("last_observed_slot") is not None else cutoff)
    for slot in range(SOLAR_START_SLOT, SOLAR_END_SLOT):
        if present[slot]:
            lo[slot] = hi[slot] = adjusted[slot]
            continue
        lead_minutes = max(0.0, float((slot - last_obs) * SLOT_MIN))
        horizon_uncertainty = 0.02 * (1.0 + lead_minutes / 120.0)
        factor = factors[slot]
        lo[slot] = float(np.clip(base_lo[slot] * factor * (1.0 - horizon_uncertainty), 0.0, cap_slot))
        hi[slot] = float(np.clip(base_hi[slot] * factor * (1.0 + horizon_uncertainty), 0.0, cap_slot))
        lo[slot] = float(np.clip(lo[slot], 0.0, adjusted[slot]))
        hi[slot] = float(np.clip(hi[slot], adjusted[slot], cap_slot))
    validated = _validate_nowcast_output(adjusted, lo, hi, meta)
    if validated is None:
        return None, meta
    adjusted, lo, hi = validated
    meta.update({
        "dayahead_total_kwh": float(np.sum(dayahead[SOLAR_START_SLOT:SOLAR_END_SLOT])),
        "nowcast_total_kwh": float(np.sum(adjusted[SOLAR_START_SLOT:SOLAR_END_SLOT])),
    })
    return to_ui_series(adjusted, lo, hi, day_s), meta

def _run_with_deadline(func, args: tuple, deadline_monotonic: float):
    """Run a read-only builder without ever waiting beyond the global deadline.

    A daemon worker is intentional here: Python threads cannot be force-killed,
    but these builders perform no writes, the result queue is isolated, and a
    timed-out worker cannot keep the process alive or consume the fallback's
    budget.  This avoids ThreadPoolExecutor.shutdown(wait=True), which made the
    former 30-second timeout illusory.
    """
    global _nowcast_timed_out_worker
    with _nowcast_worker_guard:
        if _nowcast_timed_out_worker is not None:
            if _nowcast_timed_out_worker.is_alive():
                raise NowcastWorkerQuarantinedError(
                    "prior timed-out nowcast worker is still draining"
                )
            _nowcast_timed_out_worker = None

    remaining = float(deadline_monotonic) - time.monotonic()
    if remaining <= 0.0:
        raise TimeoutError(f"{getattr(func, '__name__', 'builder')} exceeded global deadline")
    result_queue: queue.Queue = queue.Queue(maxsize=1)

    def _worker() -> None:
        global _nowcast_timed_out_worker
        try:
            result_queue.put((True, func(*args)), block=False)
        except BaseException as exc:  # propagate builder failures to caller
            try:
                result_queue.put((False, exc), block=False)
            except queue.Full:
                pass
        finally:
            current = threading.current_thread()
            with _nowcast_worker_guard:
                if _nowcast_timed_out_worker is current:
                    _nowcast_timed_out_worker = None

    worker = threading.Thread(
        target=_worker,
        name=f"nowcast-{getattr(func, '__name__', 'builder')}",
        daemon=True,
    )
    worker.start()
    try:
        succeeded, value = result_queue.get(timeout=max(0.0, remaining))
    except queue.Empty as exc:
        with _nowcast_worker_guard:
            _nowcast_timed_out_worker = worker
        raise TimeoutError(
            f"{getattr(func, '__name__', 'builder')} exceeded global deadline"
        ) from exc
    if succeeded:
        return value
    raise value

def build_intraday_adjusted_forecast(
    day: date,
    cutoff_slot: int | None = None,
    mode_override: str | None = None,
    execution_budget_seconds: float = NOWCAST_EXECUTION_BUDGET_SEC,
) -> tuple[list[dict] | None, dict]:
    """Single production entry with off/shadow/active rollout semantics.

    Both implementations apply the operator's ``forecastIntradayBlendMax``
    cap internally, preserving the established tuning contract.
    """
    series_run_id = f"IR-{int(time.time()*1000)}-{uuid.uuid4().hex[:8]}"
    mode = str(mode_override or _setting_string_or_default(
        "forecastVirtualNowcastMode", "off", set(NOWCAST_VALID_MODES)
    )).strip().lower()
    deadline = time.monotonic() + max(0.001, min(float(execution_budget_seconds), NOWCAST_EXECUTION_BUDGET_SEC))

    def _finalize(s, m):
        m["series_run_id"] = series_run_id
        m["configured_mode"] = mode
        if s:
            for row in s:
                row["series_run_id"] = series_run_id
        return s, m

    def _failure_meta(algorithm: str, stage: str, exc: Exception) -> dict:
        timed_out = isinstance(exc, TimeoutError)
        quarantined = isinstance(exc, NowcastWorkerQuarantinedError)
        return {
            "day": day.isoformat(),
            "algorithm_version": algorithm,
            "run_status": "failed",
            "fallback_reason": f"{stage}_{'worker_quarantined' if quarantined else ('timeout' if timed_out else 'exception')}:{type(exc).__name__}",
        }

    if mode == "off":
        try:
            series, meta = _run_with_deadline(
                _build_current_intraday_adjusted_forecast, (day, cutoff_slot), deadline
            )
        except Exception as exc:
            series = None
            meta = _failure_meta(NOWCAST_CURRENT_ALGORITHM_VERSION, "champion", exc)
        meta["execution_mode"] = "off"
        meta["run_status"] = "success" if series else str(meta.get("run_status") or "skipped")
        meta["challenger_status"] = "skipped"
        meta["authoritative_algorithm"] = NOWCAST_CURRENT_ALGORITHM_VERSION
        return _finalize(series, meta)

    try:
        challenger_series, challenger_meta = _run_with_deadline(
            _build_robust_intraday_nowcast, (day, cutoff_slot), deadline
        )
    except Exception as exc:
        challenger_series = None
        challenger_meta = _failure_meta(NOWCAST_ALGORITHM_VERSION, "challenger", exc)

    challenger_meta["execution_mode"] = mode
    challenger_outcome = str(challenger_meta.get("run_status") or "failed")
    if mode == "shadow":
        try:
            current_series, current_meta = _run_with_deadline(
                _build_current_intraday_adjusted_forecast, (day, cutoff_slot), deadline
            )
        except Exception as exc:
            current_series = None
            current_meta = _failure_meta(NOWCAST_CURRENT_ALGORITHM_VERSION, "champion", exc)
        challenger_meta["authoritative_algorithm"] = NOWCAST_CURRENT_ALGORITHM_VERSION
        challenger_meta["challenger_would_write"] = bool(challenger_series and challenger_outcome == "success")
        challenger_meta["current_meta"] = current_meta
        if challenger_series and challenger_outcome == "success":
            cutoff_slot_val = challenger_meta.get("cutoff_slot")
            if cutoff_slot_val is not None:
                checkpoints = {}
                for lead_min in [5, 15, 30, 60, 120]:
                    target_slot = cutoff_slot_val + math.ceil(lead_min / SLOT_MIN)
                    target_idx = target_slot - SOLAR_START_SLOT
                    if 0 <= target_idx < len(challenger_series):
                        row = challenger_series[target_idx]
                        checkpoints[str(lead_min)] = {
                            "slot": target_slot,
                            "time": row["time"],
                            "p10_kwh": row["kWh_lo"],
                            "p50_kwh": row["kWh_inc"],
                            "p90_kwh": row["kWh_hi"]
                        }
                cutoff_idx = cutoff_slot_val - SOLAR_START_SLOT
                if cutoff_idx >= -1:
                    future_rows = challenger_series[max(0, cutoff_idx + 1):]
                    checkpoints["remaining_day"] = {
                        "p10_kwh": round(sum(r["kWh_lo"] for r in future_rows), 6),
                        "p50_kwh": round(sum(r["kWh_inc"] for r in future_rows), 6),
                        "p90_kwh": round(sum(r["kWh_hi"] for r in future_rows), 6)
                    }
                challenger_meta["checkpoints"] = checkpoints
        challenger_meta["challenger_status"] = challenger_outcome
        challenger_meta["run_status"] = "success" if current_series else "failed"
        return _finalize(current_series, challenger_meta)

    if challenger_series and challenger_meta.get("run_status") == "success":
        challenger_meta["authoritative_algorithm"] = NOWCAST_ALGORITHM_VERSION
        challenger_meta["challenger_status"] = "success"
        return _finalize(challenger_series, challenger_meta)

    try:
        current_series, current_meta = _run_with_deadline(
            _build_current_intraday_adjusted_forecast, (day, cutoff_slot), deadline
        )
    except Exception as exc:
        current_series = None
        current_meta = _failure_meta(NOWCAST_CURRENT_ALGORITHM_VERSION, "champion", exc)
    challenger_meta["authoritative_algorithm"] = NOWCAST_CURRENT_ALGORITHM_VERSION
    challenger_meta["current_meta"] = current_meta
    challenger_meta["run_status"] = "success" if current_series else "failed"
    challenger_meta["fallback_used"] = bool(current_series)
    challenger_meta["challenger_status"] = challenger_outcome
    return _finalize(current_series, challenger_meta)

def _ensure_intraday_audit_table(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS forecast_intraday_run_audit (
            id INTEGER PRIMARY KEY,
            target_date TEXT NOT NULL,
            generated_ts INTEGER NOT NULL,
            cutoff_slot INTEGER NOT NULL,
            base_run_audit_id INTEGER,
            base_forecast_updated_ts INTEGER,
            algorithm_version TEXT NOT NULL,
            execution_mode TEXT NOT NULL DEFAULT 'active',
            actual_source TEXT NOT NULL DEFAULT 'pac_loss_adjusted',
            eligible_slots INTEGER NOT NULL DEFAULT 0,
            excluded_cap_slots INTEGER NOT NULL DEFAULT 0,
            excluded_outage_slots INTEGER NOT NULL DEFAULT 0,
            excluded_quality_slots INTEGER NOT NULL DEFAULT 0,
            excluded_curtailed_slots INTEGER NOT NULL DEFAULT 0,
            recent_log_ratio REAL,
            session_log_ratio REAL,
            strength REAL,
            half_life_minutes REAL,
            dayahead_total_kwh REAL,
            nowcast_total_kwh REAL,
            constraint_mode TEXT,
            run_status TEXT NOT NULL DEFAULT 'success',
            notes_json TEXT,
            series_run_id TEXT,
            output_updated_ts INTEGER,
            authoritative_algorithm TEXT,
            challenger_status TEXT,
            authoritative_write_status TEXT,
            configured_mode TEXT,
            prior_series_preserved INTEGER,
            UNIQUE(target_date, generated_ts)
        );
        CREATE INDEX IF NOT EXISTS idx_fira_date_ts
            ON forecast_intraday_run_audit(target_date, generated_ts DESC);
        CREATE INDEX IF NOT EXISTS idx_fira_status
            ON forecast_intraday_run_audit(target_date, run_status);
    """)
    for col in [
        "series_run_id TEXT",
        "output_updated_ts INTEGER",
        "authoritative_algorithm TEXT",
        "challenger_status TEXT",
        "authoritative_write_status TEXT",
        "configured_mode TEXT",
        "prior_series_preserved INTEGER"
    ]:
        try:
            conn.execute(f"ALTER TABLE forecast_intraday_run_audit ADD COLUMN {col}")
        except sqlite3.OperationalError:
            pass

def _insert_intraday_run_audit_row(
    conn: sqlite3.Connection,
    day_s: str,
    meta: dict,
    *,
    generated_ts: int | None = None,
) -> int:
    """Insert one audit row on the caller's transaction."""
    audit_ts = int(generated_ts if generated_ts is not None else time.time() * 1000)
    notes = {
        "fallback_reason": meta.get("fallback_reason"),
        "authoritative_algorithm": meta.get("authoritative_algorithm"),
        "challenger_would_write": meta.get("challenger_would_write"),
        "capacity_coverage_mean": meta.get("capacity_coverage_mean"),
        "ratio_volatility": meta.get("ratio_volatility"),
        "excluded_manual_slots": meta.get("excluded_manual_slots"),
        "checkpoints": meta.get("checkpoints"),
    }
    base_row = None
    if _sqlite_table_columns(conn, "forecast_run_audit"):
        base_row = conn.execute(
            """SELECT id FROM forecast_run_audit
                 WHERE target_date=? AND run_status='success'
                 ORDER BY is_authoritative_runtime DESC, generated_ts DESC LIMIT 1""",
            (str(day_s),),
        ).fetchone()
    forecast_row = None
    if _sqlite_table_columns(conn, "forecast_dayahead"):
        forecast_row = conn.execute(
            "SELECT MAX(updated_ts) FROM forecast_dayahead WHERE date=?",
            (str(day_s),),
        ).fetchone()
    cur = conn.execute(
                    """
                    INSERT INTO forecast_intraday_run_audit(
                        target_date, generated_ts, cutoff_slot,
                        base_run_audit_id, base_forecast_updated_ts,
                        algorithm_version, execution_mode, actual_source,
                        eligible_slots, excluded_cap_slots, excluded_outage_slots,
                        excluded_quality_slots, excluded_curtailed_slots,
                        recent_log_ratio, session_log_ratio, strength,
                        half_life_minutes, dayahead_total_kwh, nowcast_total_kwh,
                        constraint_mode, run_status, notes_json,
                        series_run_id, output_updated_ts, authoritative_algorithm,
                        challenger_status, authoritative_write_status, configured_mode,
                        prior_series_preserved
                    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                    """,
                    (
                        str(day_s), audit_ts, int(meta.get("cutoff_slot") or 0),
                        int(base_row[0]) if base_row else None,
                        int(forecast_row[0]) if forecast_row and forecast_row[0] is not None else None,
                        str(meta.get("algorithm_version") or NOWCAST_ALGORITHM_VERSION),
                        str(meta.get("execution_mode") or "active"),
                        "pac_loss_adjusted",
                        int(meta.get("eligible_slots", meta.get("observed_slots", 0)) or 0),
                        int(meta.get("excluded_cap_slots", 0) or 0),
                        int(meta.get("excluded_outage_slots", 0) or 0),
                        int(meta.get("excluded_quality_slots", 0) or 0),
                        int(meta.get("excluded_curtailed_slots", 0) or 0),
                        float(meta["recent_log_ratio"]) if meta.get("recent_log_ratio") is not None else None,
                        float(meta["session_log_ratio"]) if meta.get("session_log_ratio") is not None else None,
                        float(meta.get("strength", 0.0) or 0.0),
                        float(meta.get("half_life_minutes", NOWCAST_HALF_LIFE_MINUTES) or NOWCAST_HALF_LIFE_MINUTES),
                        float(meta.get("dayahead_total_kwh", 0.0) or 0.0),
                        float(meta.get("nowcast_total_kwh", 0.0) or 0.0),
                        str(meta.get("constraint_mode") or "strict_unconstrained"),
                        str(meta.get("run_status") or "unknown"),
                        json.dumps(notes, separators=(",", ":"), sort_keys=True),
                        meta.get("series_run_id"),
                        meta.get("output_updated_ts"),
                        meta.get("authoritative_algorithm"),
                        meta.get("challenger_status"),
                        meta.get("authoritative_write_status"),
                        meta.get("configured_mode"),
                        meta.get("prior_series_preserved"),
                    ),
    )
    return int(cur.lastrowid)


def _write_intraday_run_audit(day_s: str, meta: dict) -> int | None:
    """Persist bounded nowcast diagnostics without touching day-ahead audit authority."""
    if _read_operation_mode() != "gateway":
        log.warning("Intraday audit write blocked in remote mode for %s", day_s)
        return None
    for attempt in range(1, SQLITE_RETRY_ATTEMPTS + 1):
        try:
            with _open_sqlite(APP_DB_FILE, SQLITE_WRITE_TIMEOUT_SEC, readonly=False) as conn:
                _ensure_intraday_audit_table(conn)
                audit_id = _insert_intraday_run_audit_row(conn, day_s, meta)
                conn.commit()
                return audit_id
        except Exception as e:
            if attempt < SQLITE_RETRY_ATTEMPTS and _is_retryable_sqlite_error(e):
                _sleep_sqlite_retry(attempt)
                continue
            log.warning("Intraday audit write failed for %s: %s", day_s, e)
            return None
    return None


def _prepare_intraday_forecast_rows(
    day_s: str,
    series: list[dict],
    updated_ts: int,
) -> list[tuple]:
    """Validate a complete authoritative solar-window row batch before SQL."""
    day_dt = datetime.fromisoformat(day_s)
    expected_slots = set(range(SOLAR_START_SLOT, SOLAR_END_SLOT))
    rows: list[tuple] = []
    seen: set[int] = set()
    series_ids: set[str] = set()
    for rec in series or []:
        if not isinstance(rec, dict):
            raise ValueError("invalid intraday row")
        time_hms = str(rec.get("time") or rec.get("time_hms") or "").strip()
        slot = _parse_slot_from_time_text(day_s, time_hms)
        mid = float(rec.get("kWh_inc", rec.get("kwh_inc")))
        low = float(rec.get("kWh_lo", rec.get("kwh_lo")))
        high = float(rec.get("kWh_hi", rec.get("kwh_hi")))
        series_id = str(rec.get("series_run_id") or "").strip()
        if (
            slot is None or slot in seen or slot not in expected_slots or not series_id
            or not all(math.isfinite(v) for v in (mid, low, high))
            or not 0.0 <= low <= mid <= high
        ):
            raise ValueError("invalid intraday slot/band/provenance")
        hh, mm, ss = [int(value) for value in time_hms.split(":")]
        ts = int(datetime(day_dt.year, day_dt.month, day_dt.day, hh, mm, ss).timestamp() * 1000)
        seen.add(slot)
        series_ids.add(series_id)
        rows.append((
            str(day_s), ts, int(slot), f"{hh:02d}:{mm:02d}:{ss:02d}",
            mid, low, high, "service", int(updated_ts), series_id,
        ))
    if seen != expected_slots or len(series_ids) != 1:
        raise ValueError("intraday batch is incomplete or mixes series identities")
    return sorted(rows, key=lambda row: int(row[2]))


def _write_intraday_series_and_success_audit_atomic(
    day_s: str,
    series: list[dict],
    meta: dict,
    *,
    updated_ts: int,
) -> bool:
    """Commit the authoritative row batch and its success audit together."""
    if _read_operation_mode() != "gateway":
        log.warning("Intraday authoritative write blocked in remote mode for %s", day_s)
        return False
    try:
        rows = _prepare_intraday_forecast_rows(day_s, series, int(updated_ts))
        series_id = str(rows[0][9])
        if series_id != str(meta.get("series_run_id") or ""):
            raise ValueError("audit/series provenance mismatch")
    except Exception as exc:
        log.warning("Intraday authoritative batch rejected for %s: %s", day_s, exc)
        return False

    for attempt in range(1, SQLITE_RETRY_ATTEMPTS + 1):
        try:
            with _open_sqlite(APP_DB_FILE, SQLITE_WRITE_TIMEOUT_SEC, readonly=False) as conn:
                _ensure_forecast_table(conn, "forecast_intraday_adjusted")
                _ensure_intraday_audit_table(conn)
                conn.commit()
                conn.execute("BEGIN IMMEDIATE")
                conn.execute("DELETE FROM forecast_intraday_adjusted WHERE date=?", (str(day_s),))
                conn.executemany(
                    """
                    INSERT INTO forecast_intraday_adjusted(
                        date, ts, slot, time_hms, kwh_inc, kwh_lo, kwh_hi,
                        source, updated_ts, series_run_id
                    ) VALUES(?,?,?,?,?,?,?,?,?,?)
                    """,
                    rows,
                )
                _insert_intraday_run_audit_row(
                    conn, day_s, meta, generated_ts=int(updated_ts)
                )
                conn.commit()
            clear_forecast_data_cache()
            # JSON is a legacy compatibility mirror, never the authority.  Its
            # failure cannot invalidate an already atomic SQLite commit.
            context = _load_json(FORECAST_CTX)
            context.setdefault("PacEnergy_IntradayAdjusted", {})[day_s] = series
            if not _save_json(FORECAST_CTX, context):
                log.warning("Legacy intraday JSON mirror failed for %s", day_s)
            return True
        except Exception as exc:
            if attempt < SQLITE_RETRY_ATTEMPTS and _is_retryable_sqlite_error(exc):
                _sleep_sqlite_retry(attempt)
                continue
            log.warning("Atomic intraday series/audit write failed for %s: %s", day_s, exc)
            return False
    return False

def score_completed_shadow_checkpoints(target_date: date, persist: bool = True) -> dict:
    """Score exact stored shadow checkpoints against completed, masked truth.

    No forecast is regenerated.  This distinction is essential: checkpoint
    evidence evaluates what was actually recorded at issue time, including its
    original bands and immutable day-ahead/constraint identity.
    """
    day_s = target_date.isoformat()
    actual, actual_present = load_actual_loss_adjusted_with_presence(day_s, min_solar_slots=0)
    if actual is None or actual_present is None:
        return {"target_date": day_s, "status": "skipped_missing_actual", "audits_scored": 0}
    actual_arr = np.asarray(actual, dtype=float).reshape(-1)
    present = _normalise_slot_mask(actual_present)
    if actual_arr.size != SLOTS_DAY:
        return {"target_date": day_s, "status": "skipped_invalid_actual", "audits_scored": 0}

    try:
        _, truth_meta = build_operational_constraint_mask(day_s)
        truth_cap = _normalise_slot_mask(truth_meta.get("cap_dispatch_mask"))
        truth_manual = _normalise_slot_mask(truth_meta.get("manual_constraint_mask"))
    except Exception as exc:
        return {
            "target_date": day_s,
            "status": "failed_constraint_masks",
            "error": type(exc).__name__,
            "audits_scored": 0,
        }

    if not APP_DB_FILE.exists():
        return {"target_date": day_s, "status": "skipped_missing_audits", "audits_scored": 0}
    scored_count = 0
    skipped_count = 0
    already_scored_count = 0
    try:
        with _open_sqlite(APP_DB_FILE, SQLITE_WRITE_TIMEOUT_SEC, readonly=not persist) as conn:
            if persist:
                _ensure_intraday_audit_table(conn)
            columns = _sqlite_table_columns(conn, "forecast_intraday_run_audit")
            if not columns:
                return {"target_date": day_s, "status": "skipped_missing_audits", "audits_scored": 0}
            rows = conn.execute(
                """
                SELECT id, generated_ts, cutoff_slot, notes_json
                  FROM forecast_intraday_run_audit
                 WHERE target_date=? AND execution_mode='shadow'
                 ORDER BY generated_ts ASC
                """,
                (day_s,),
            ).fetchall()
            for audit_id, generated_ts, cutoff_slot, notes_json in rows:
                try:
                    notes = json.loads(notes_json or "{}")
                except Exception:
                    skipped_count += 1
                    continue
                checkpoints = notes.get("checkpoints")
                prior_scores = notes.get("checkpoint_scores")
                if (
                    isinstance(prior_scores, dict)
                    and prior_scores.get("score_schema_version") == 2
                    and prior_scores.get("status") == "scored"
                ):
                    already_scored_count += 1
                    continue
                if not isinstance(checkpoints, dict):
                    scores = {
                        "score_schema_version": 2,
                        "status": "skipped_missing_stored_checkpoints",
                        "scored_slot_count": 0,
                    }
                    notes["checkpoint_scores"] = scores
                    if persist:
                        conn.execute(
                            "UPDATE forecast_intraday_run_audit SET notes_json=? WHERE id=?",
                            (json.dumps(notes, separators=(",", ":"), sort_keys=True), int(audit_id)),
                        )
                    skipped_count += 1
                    continue
                immutable = _load_immutable_dayahead_bundle_from_db(day_s, int(generated_ts))
                if not immutable:
                    scores = {
                        "score_schema_version": 2,
                        "status": "skipped_missing_immutable_basis",
                        "scored_slot_count": 0,
                    }
                else:
                    try:
                        parsed = _parse_replay_constraint_snapshot(
                            immutable.get("constraint_snapshot") or {}
                        )
                        issue_cap = parsed["cap_dispatch_mask"]
                        issue_manual = parsed["manual_constraint_mask"]
                        issue_outage = parsed["outage_mask"]
                        recorded_cap = parsed["slot_cap_kwh"]
                        # Completed truth uses historical alarms with the stored
                        # issue-time topology, never today's ipconfig.
                        truth_outage = _query_1000h_inverter_outage_mask(
                            day_s, parsed["inverter_node_map"], strict=True
                        )
                        export_basis = parsed["export_curtailment"]
                        export_curtailed = _curtailed_mask_from_recorded_basis(
                            actual_arr,
                            immutable["dayahead"],
                            tolerance=export_basis["tolerance"],
                            export_cap_slot_kwh=export_basis["export_cap_slot_kwh"],
                            baseline_multiplier=export_basis["baseline_multiplier"],
                        )
                        constraint_mask = (
                            truth_cap | truth_manual | truth_outage | issue_cap
                            | issue_manual | issue_outage | export_curtailed
                        )
                    except Exception as exc:
                        scores = {
                            "score_schema_version": 2,
                            "status": "skipped_invalid_constraint_basis",
                            "error": type(exc).__name__,
                            "scored_slot_count": 0,
                        }
                    else:
                        valid_truth = (
                            present & np.isfinite(actual_arr) & (actual_arr >= 0.0)
                            & (actual_arr <= recorded_cap + 1e-9)
                        )
                        scoring_mask = valid_truth & (~constraint_mask)
                        required_horizons = {
                            str(minutes): int(cutoff_slot) + int(math.ceil(minutes / SLOT_MIN))
                            for minutes in NOWCAST_REPLAY_HORIZONS_MIN
                            if int(cutoff_slot) + int(math.ceil(minutes / SLOT_MIN)) < SOLAR_END_SLOT
                        }
                        invalid_reason = None
                        for horizon, expected_slot in required_horizons.items():
                            checkpoint = checkpoints.get(horizon)
                            try:
                                values = tuple(float(checkpoint[key]) for key in ("p10_kwh", "p50_kwh", "p90_kwh"))
                                slot = int(checkpoint.get("slot"))
                            except Exception:
                                invalid_reason = f"missing_or_invalid_horizon_{horizon}"
                                break
                            if slot != expected_slot:
                                invalid_reason = f"misbound_horizon_{horizon}"
                                break
                            if (
                                not all(math.isfinite(value) for value in values)
                                or not 0.0 <= values[0] <= values[1] <= values[2] <= recorded_cap + 1e-9
                            ):
                                invalid_reason = f"invalid_horizon_band_{horizon}"
                                break

                        start = int(cutoff_slot) + 1
                        remaining_slots = np.arange(start, SOLAR_END_SLOT, dtype=int)
                        remaining_checkpoint = checkpoints.get("remaining_day")
                        try:
                            remaining_values = tuple(
                                float(remaining_checkpoint[key])
                                for key in ("p10_kwh", "p50_kwh", "p90_kwh")
                            )
                        except Exception:
                            remaining_values = ()
                        remaining_cap = recorded_cap * int(remaining_slots.size)
                        if invalid_reason is None and (
                            not remaining_values
                            or not all(math.isfinite(value) for value in remaining_values)
                            or not 0.0 <= remaining_values[0] <= remaining_values[1] <= remaining_values[2] <= remaining_cap + 1e-9
                        ):
                            invalid_reason = "invalid_remaining_day_band"

                        if invalid_reason:
                            scores = {
                                "score_schema_version": 2,
                                "status": "skipped_invalid_stored_checkpoints",
                                "skip_reason": invalid_reason,
                                "scored_slot_count": 0,
                            }
                        else:
                            scores = {
                                "score_schema_version": 2,
                                "status": "scored",
                                "truth_source": "pac_loss_adjusted",
                                "basis_checksum": immutable.get("basis_checksum"),
                                "issuance_id": immutable.get("issuance_id"),
                                "constraint_masked_slot_count": int(np.count_nonzero(constraint_mask)),
                                "horizons": {},
                            }
                            total_scored = 0
                            for horizon, slot in required_horizons.items():
                                checkpoint = checkpoints[horizon]
                                p10, p50, p90 = (
                                    float(checkpoint["p10_kwh"]),
                                    float(checkpoint["p50_kwh"]),
                                    float(checkpoint["p90_kwh"]),
                                )
                                item = {"target_slot": slot, "support_slot_count": 1, "scored_slot_count": 0}
                                if not scoring_mask[slot]:
                                    item.update(status="skipped", skip_reason="truth_missing_or_constrained")
                                else:
                                    truth = float(actual_arr[slot])
                                    item.update(
                                        status="scored", scored_slot_count=1, actual_kwh=truth,
                                        absolute_error_kwh=abs(p50 - truth),
                                        squared_error_kwh2=(p50 - truth) ** 2,
                                        interval_covered=bool(p10 <= truth <= p90),
                                    )
                                    total_scored += 1
                                scores["horizons"][horizon] = item

                            remaining_valid = (
                                remaining_slots[scoring_mask[remaining_slots]]
                                if remaining_slots.size else remaining_slots
                            )
                            remaining_score = {
                                "support_slot_count": int(remaining_slots.size),
                                "scored_slot_count": int(remaining_valid.size),
                            }
                            if remaining_valid.size != remaining_slots.size or remaining_slots.size == 0:
                                remaining_score.update(status="skipped", skip_reason="incomplete_or_constrained_truth")
                            else:
                                actual_total = float(np.sum(actual_arr[remaining_slots]))
                                p10_total, p50_total, p90_total = remaining_values
                                remaining_score.update(
                                    status="scored", actual_kwh=actual_total,
                                    absolute_error_kwh=abs(p50_total - actual_total),
                                    ape_pct=abs(p50_total - actual_total) / max(actual_total, 0.1) * 100.0,
                                    interval_covered=bool(p10_total <= actual_total <= p90_total),
                                )
                            scores["remaining_day"] = remaining_score
                            scores["scored_slot_count"] = total_scored
                            if total_scored == 0 and remaining_score.get("status") != "scored":
                                scores["status"] = "skipped_no_valid_truth"

                notes["checkpoint_scores"] = scores
                if persist:
                    conn.execute(
                        "UPDATE forecast_intraday_run_audit SET notes_json=? WHERE id=?",
                        (json.dumps(notes, separators=(",", ":"), sort_keys=True), int(audit_id)),
                    )
                scored_count += int(scores.get("status") == "scored")
                skipped_count += int(scores.get("status") != "scored")
            if persist:
                conn.commit()
    except Exception as exc:
        log.warning("Shadow checkpoint scoring failed [%s]: %s", day_s, exc)
        return {"target_date": day_s, "status": "failed", "error": type(exc).__name__, "audits_scored": scored_count}
    return {
        "target_date": day_s,
        "status": "complete" if (scored_count or already_scored_count) else "skipped_no_scorable_audits",
        "audits_scored": scored_count,
        "audits_already_scored": already_scored_count,
        "audits_skipped": skipped_count,
    }


def _score_shadow_checkpoint_backlog(
    reference_date: date,
    completed_dates: set[str],
    *,
    lookback_days: int = 14,
) -> list[dict]:
    """Retry incomplete completed days; remember only genuinely complete days."""
    outcomes: list[dict] = []
    for offset in range(max(1, int(lookback_days)), 0, -1):
        target = reference_date - timedelta(days=offset)
        key = target.isoformat()
        if key in completed_dates:
            continue
        result = score_completed_shadow_checkpoints(target, persist=True)
        outcomes.append(result)
        if result.get("status") == "complete":
            completed_dates.add(key)
    return outcomes

def _forecast_series_exists(table_name: str, day_s: str) -> bool:
    if table_name not in {"forecast_dayahead", "forecast_intraday_adjusted"} or not APP_DB_FILE.exists():
        return False
    try:
        with _open_sqlite(APP_DB_FILE, SQLITE_READ_TIMEOUT_SEC, readonly=True) as conn:
            row = conn.execute(
                f"SELECT 1 FROM {table_name} WHERE date=? LIMIT 1", (str(day_s),)
            ).fetchone()
            return bool(row)
    except Exception:
        return False

def run_intraday_adjusted(day: date) -> bool:
    day_s = day.isoformat()
    had_prior_series = _forecast_series_exists("forecast_intraday_adjusted", day_s)
    series, meta = build_intraday_adjusted_forecast(day)
    if not series:
        log.info(
            "Intraday-adjusted skipped [%s] - observed_slots=%d",
            day_s,
            int(meta.get("observed_slots", 0)),
        )
        if str(meta.get("run_status") or "") not in {"failed", "timeout"}:
            meta["run_status"] = "skipped"
        meta["authoritative_write_status"] = "preserved" if had_prior_series else "no_output"
        meta["prior_series_preserved"] = int(had_prior_series)
        meta.pop("output_updated_ts", None)
        if str(meta.get("execution_mode")) in {"shadow", "active", "off"}:
            _write_intraday_run_audit(day_s, meta)
        return False
    output_updated_ts = int(time.time() * 1000)
    meta["run_status"] = "success"
    meta["authoritative_write_status"] = "success"
    meta["prior_series_preserved"] = 0
    meta["output_updated_ts"] = output_updated_ts
    ok = _write_intraday_series_and_success_audit_atomic(
        day_s, series, meta, updated_ts=output_updated_ts
    )
    if not ok:
        meta["run_status"] = "write_failed"
        meta["fallback_reason"] = meta.get("fallback_reason") or "series_write_failed"
        meta["authoritative_write_status"] = "failed"
        meta["prior_series_preserved"] = int(had_prior_series)
        meta.pop("output_updated_ts", None)
    # The success audit is already in the authoritative SQLite transaction.
    # Only failure outcomes require a separate best-effort audit write.
    if not ok and str(meta.get("execution_mode")) in {"shadow", "active", "off"}:
        _write_intraday_run_audit(day_s, meta)
    if ok:
        log.info(
            "Intraday-adjusted updated [%s] - mode=%s algo=%s eligible=%d last_slot=%s global_ratio=%.3f recent_ratio=%.3f strength=%.2f",
            day_s,
            str(meta.get("execution_mode", "off")),
            str(meta.get("authoritative_algorithm", meta.get("algorithm_version", "current"))),
            int(meta.get("eligible_slots", meta.get("observed_slots", 0))),
            meta.get("last_observed_slot"),
            float(meta.get("global_ratio", 1.0)),
            float(meta.get("recent_ratio", 1.0)),
            float(meta.get("strength", 0.0)),
        )
    return ok

# ============================================================================
# CORE FORECAST FUNCTION
# ============================================================================

def run_dayahead(
    target_date: date,
    today: date,
    runtime_state: dict | None = None,
    persist: bool = True,
    require_saved_snapshot_for_past: bool = False,
    write_audit: bool = False,
    audit_generator_mode: str = "",
) -> bool | dict:
    """
    Generate the day-ahead forecast for *target_date*.

    Pipeline:
        1. Fetch weather for target day
        2. Compute physics baseline
        3. Predict ML residual (if model available)
        4. Apply error memory bias correction
        5. Clip to slot capacity, enforce ramp limits
        6. Compute confidence bands
        7. Optionally write to forecast context

    Returns a boolean when `persist=True`, otherwise a result payload.
    """
    target_s = target_date.isoformat()
    log.info(""" Day-Ahead Forecast  target=%s """, target_s)

    # v2.8 efficiency audit (E1a/P2): reset per-cycle read cache so this
    # pass starts from a clean slate. Subsequent calls to
    # load_solcast_snapshot / load_dayahead_with_presence /
    # load_actual_loss_adjusted_with_presence dedupe within this cycle,
    # but never leak stale rows from a previous cycle.
    _reset_forecast_cycle_cache()

    def _load_saved_snapshot_hourly(snapshot_day: str) -> pd.DataFrame:
        snap = load_forecast_weather_snapshot(snapshot_day)
        if not snap:
            return pd.DataFrame()
        raw_hourly_records = list(snap.get("raw_hourly") or [])
        if raw_hourly_records:
            frame = _weather_records_to_frame(raw_hourly_records, snapshot_day)
            if not frame.empty:
                return frame
        applied_hourly_records = list(snap.get("applied_hourly") or [])
        if applied_hourly_records:
            return _weather_records_to_frame(applied_hourly_records, snapshot_day)
        return pd.DataFrame()

    # 1. Weather
    weather_source = "forecast"
    raw_hourly = pd.DataFrame()
    historical_snapshot_mode = bool(
        require_saved_snapshot_for_past and target_date < datetime.now().date()
    )
    if target_date < today or historical_snapshot_mode:
        snap = load_forecast_weather_snapshot(target_s)
        if snap:
            raw_hourly = _weather_records_to_frame(list(snap.get("raw_hourly") or []), target_s)
            weather_source = "snapshot"
        if raw_hourly.empty:
            if require_saved_snapshot_for_past:
                log.warning("Past target %s has no saved forecast snapshot - skipping strict day-ahead replay.", target_s)
                return False if persist else None
            log.warning("Past target %s has no saved forecast snapshot - using archive weather fallback.", target_s)
            fetched = fetch_weather(target_s, source="archive")
            raw_hourly = fetched if fetched is not None else pd.DataFrame()
            weather_source = "archive-fallback"
    else:
        fetched = fetch_weather(target_s, source="forecast")
        raw_hourly = fetched if fetched is not None else pd.DataFrame()
        if raw_hourly.empty:
            snap_hourly = _load_saved_snapshot_hourly(target_s)
            if not snap_hourly.empty:
                raw_hourly = snap_hourly
                weather_source = "snapshot-fallback"
                log.warning(
                    "Forecast weather unavailable for %s - using saved weather snapshot fallback.",
                    target_s,
                )

    if raw_hourly.empty and not persist:
        log.error("Cannot run forecast - weather unavailable for %s", target_s)
        return None

    if raw_hourly.empty:
        log.error("Cannot run forecast - weather unavailable for %s", target_s)
        return False

    if runtime_state is not None and "weather_bias" in runtime_state:
        weather_bias = runtime_state.get("weather_bias")
    else:
        weather_bias = load_weather_bias_artifact(today, allow_build=True)
    hourly_applied, bias_meta = apply_weather_bias_adjustment(raw_hourly, target_s, weather_bias)
    w5   = interpolate_5min(hourly_applied, target_s)
    ok_w5, reason_w5 = validate_weather_5min(target_s, w5)
    if (not ok_w5) and (not persist):
        log.error("Cannot run forecast - weather quality failed for %s: %s", target_s, reason_w5)
        return None
    if not ok_w5:
        log.error("Cannot run forecast - weather quality failed for %s: %s", target_s, reason_w5)
        return False
    stats = analyse_weather_day(target_s, w5)
    target_regime = classify_day_regime(stats)
    log.info(
        "Target weather: sky=%-14s  cloud=%.0f%%  rad_peak=%.0f W/m  "
        "RH=%.0f%%  convective=%s  rainy=%s",
        stats["sky_class"], stats["cloud_mean"], stats["rad_peak"],
        stats["rh_mean"], stats["convective"], stats["rainy"],
    )
    log.info(
        "Weather bias: source=%s matches=%d regime=%s conf=%.2f rad_factor=%.3f shift_slots=%.1f",
        weather_source,
        int(bias_meta.get("matches", 0)),
        bias_meta.get("day_regime"),
        float(bias_meta.get("regime_confidence", 1.0)),
        float(bias_meta.get("mean_rad_factor", 1.0)),
        float(bias_meta.get("morning_shift_slots", 0.0)),
    )

    # 2. Provider baseline selection.
    #   Primary (PHASE 4): the Solcast snapshot IS the baseline.
    #   Fallback (2026-05-30): when no usable Solcast snapshot exists, degrade
    #   gracefully to the self-sufficient physics baseline + ML residual + error
    #   memory rather than producing no forecast at all — removing the single
    #   point of failure on Solcast. Audited as forecast_variant='ml_without_solcast'
    #   (downstream physics-only branch at used_solcast==False already handles this).
    #   Controlled by `forecastAllowPhysicsFallback` (default on).
    solcast_snapshot = load_solcast_snapshot(target_s)
    solcast_prior = None
    if solcast_snapshot is not None:
        _sc_fc = solcast_snapshot.get("forecast_kwh")
        if _sc_fc is None or (isinstance(_sc_fc, (list, np.ndarray)) and len(_sc_fc) == 0):
            log.warning("Solcast snapshot for %s has no forecast data - treating as missing", target_s)
            solcast_snapshot = None

    if solcast_snapshot is not None:
        if runtime_state is not None and "solcast_reliability" in runtime_state:
            solcast_reliability = runtime_state.get("solcast_reliability")
        else:
            solcast_reliability = load_solcast_reliability_artifact(today, allow_build=True)
        solcast_prior = solcast_prior_from_snapshot(target_s, w5, solcast_snapshot, solcast_reliability)
        if solcast_prior is not None:
            _pk = np.asarray(solcast_prior.get("prior_kwh", []), dtype=float)
            if _pk.size != SLOTS_DAY:
                log.warning("Solcast prior invalid for %s (size %d != %d) - treating as missing",
                            target_s, _pk.size, SLOTS_DAY)
                solcast_prior = None
    else:
        solcast_reliability = None

    # Physics baseline is always computed: it anchors the fallback path and, on the
    # primary path, normalizes Solcast's daily total inside blend_physics_with_solcast.
    physics_baseline_arr = physics_baseline(target_s, w5)

    if solcast_prior is not None:
        # ---- Solcast-primary path (PHASE 4): Solcast mid IS the baseline ----
        solcast_mid_kwh = np.asarray(solcast_prior.get("prior_kwh"), dtype=float)
        baseline = solcast_mid_kwh.copy()
        hybrid_baseline, solcast_meta = blend_physics_with_solcast(physics_baseline_arr, solcast_prior)
        solcast_meta = {
            **solcast_meta,
            "used_solcast": True,
            "mean_blend": 1.0,   # Solcast is 100% of baseline
            "primary_mode": True,
        }
    else:
        # ---- Physics fallback path: graceful degradation when Solcast absent ----
        if not _setting_bool_or_default("forecastAllowPhysicsFallback", True):
            log.error(
                "Day-ahead requires Solcast snapshot - none usable for %s and physics "
                "fallback is disabled (forecastAllowPhysicsFallback=0).", target_s,
            )
            return False if persist else None
        log.warning(
            "Day-ahead PHYSICS FALLBACK for %s - no usable Solcast snapshot; generating "
            "from physics baseline + ML residual + error memory (variant=ml_without_solcast).",
            target_s,
        )
        solcast_mid_kwh = physics_baseline_arr.copy()
        baseline = physics_baseline_arr.copy()
        # blend_physics_with_solcast(physics, None) -> physics passthrough, used_solcast=False.
        hybrid_baseline, solcast_meta = blend_physics_with_solcast(physics_baseline_arr, None)
    if runtime_state is not None and "forecast_artifacts" in runtime_state:
        artifacts = runtime_state.get("forecast_artifacts")
    else:
        artifacts = load_forecast_artifacts(today, allow_build=True)
    solcast_primary = bool(
        solcast_meta.get("used_solcast")
        and (
            bool(solcast_meta.get("primary_mode"))
            or float(solcast_meta.get("mean_blend", 0)) >= 0.75
        )
    )
    log.info(
        "Solcast prior: used=%s primary=%s regime=%s season=%s cov=%.2f blend=%.2f reliability=%.2f res=%.2f bias_ratio=%.3f ratio=%.2f->%.2f source=%s trend=%s(%.3f)",
        bool(solcast_meta.get("used_solcast")),
        solcast_primary,
        solcast_meta.get("regime"),
        solcast_meta.get("season", ""),
        float(solcast_meta.get("coverage_ratio", 0.0)),
        float(solcast_meta.get("mean_blend", 0.0)),
        float(solcast_meta.get("reliability", 0.0)),
        float(solcast_meta.get("resolution_weight_mean", SOLCAST_RESOLUTION_WEIGHT_FALLBACK)),
        float(solcast_meta.get("bias_ratio", 1.0)),
        float(solcast_meta.get("raw_prior_ratio", 1.0)),
        float(solcast_meta.get("applied_prior_ratio", 1.0)),
        solcast_meta.get("source"),
        solcast_meta.get("trend_signal", "stable"),
        float(solcast_meta.get("trend_magnitude", 0.0)),
    )

    # 3. ML residual correction
    feat = build_features(w5, target_s, solcast_prior)
    X_pred = feat[FEATURE_COLS]
    slot_weather_buckets = classify_slot_weather_buckets(w5, target_s)
    blend = residual_blend_vector(w5, target_s, float(bias_meta.get("regime_confidence", 1.0)))
    solcast_residual_scale = solcast_residual_damp_factor(solcast_meta)
    # NOTE (v2.8 cleanup): `clear_solcast_priority` was removed — it was a
    # third Solcast-trust damper applied on top of `solcast_residual_scale`
    # (which already accounts for Solcast reliability) and the regime-aware
    # `_bias_damp` (which already has a "clear" branch). Three layers of the
    # same intent. The remaining two cover the same case correctly.

    ml_residual = np.zeros(SLOTS_DAY)
    error_class_term = np.zeros(SLOTS_DAY)
    _ml_failed = False
    model_meta = None  # set if ML prediction succeeds
    error_class_meta = {
        "available": False,
        "target_regime": target_regime,
        "used_regime_model": False,
        "blend": 0.0,
        "confidence": np.ones(SLOTS_DAY, dtype=float),
        "severe_probability": np.zeros(SLOTS_DAY, dtype=float),
        "predicted_labels": np.full(SLOTS_DAY, ERROR_CLASS_NEUTRAL_IDX, dtype=int),
        "probabilities": np.zeros((SLOTS_DAY, len(ERROR_CLASS_NAMES)), dtype=float),
        "slot_weather_buckets": slot_weather_buckets.copy(),
        "weather_profiles": {},
        "class_blend": np.zeros(SLOTS_DAY, dtype=float),
        "class_bias_kwh": np.zeros(SLOTS_DAY, dtype=float),
        "support_strength": np.zeros(SLOTS_DAY, dtype=float),
        "profile_reliability": np.ones(SLOTS_DAY, dtype=float),
        "trust_scale": np.zeros(SLOTS_DAY, dtype=float),
        "cap_frac": np.full(SLOTS_DAY, ERROR_CLASS_BIAS_CAP_FRAC, dtype=float),
        "class_support_weights": {name: 1.0 for name in ERROR_CLASS_NAMES},
    }
    if runtime_state is not None and "model_bundle" in runtime_state:
        model_bundle = runtime_state.get("model_bundle")
    else:
        model_bundle = load_model_bundle()
    if model_bundle:
        try:
            raw_residual, model_meta = predict_residual_with_bundle(
                model_bundle,
                X_pred,
                target_regime,
                regime_confidence=float(bias_meta.get("regime_confidence", 1.0)),
            )

            # T4.5 fix: surface prediction failures.  predict_residual_with_bundle
            # returns `prediction_error` / `regime_prediction_error` keys in the
            # metadata when model.predict() raises, but callers previously
            # ignored them and silently treated the zero residual as a healthy
            # prediction.  Now we log and mark _ml_failed so audit + QA layers
            # can see that the model was not actually consulted.
            _pred_err = model_meta.get("prediction_error")
            _reg_err = model_meta.get("regime_prediction_error")
            if _pred_err:
                log.error(
                    "ML global prediction error surfaced to caller: %s (target_regime=%s)",
                    _pred_err, target_regime,
                )
                _ml_failed = True
            if _reg_err:
                log.warning(
                    "ML regime prediction error surfaced to caller: %s (target_regime=%s)",
                    _reg_err, target_regime,
                )

            ml_residual           = np.zeros(SLOTS_DAY)
            ml_residual[:] = raw_residual

            # MEDIUM: Check for NaN/Inf in ML residual (could indicate model corruption or scaling failure)
            if not np.all(np.isfinite(ml_residual)):
                nan_count = int(np.sum(~np.isfinite(ml_residual)))
                log.error(
                    "ML residual contains %d NaN/Inf values — reverting to zeros (possible model/scaler corruption)",
                    nan_count,
                )
                ml_residual = np.zeros(SLOTS_DAY)
                _ml_failed = True

            # Zero residual outside solar hours & below radiation threshold
            ml_residual[:SOLAR_START_SLOT]  = 0.0
            ml_residual[SOLAR_END_SLOT:]    = 0.0
            ml_residual[w5["rad"].values < RAD_MIN_WM2] = 0.0

            # Clip extreme residuals (prevent model from overcorrecting)
            cap_kwh = slot_cap_kwh()
            ml_residual = np.clip(ml_residual, -cap_kwh * 0.5, cap_kwh * 0.5)

            # Weather-adaptive blending: trust ML less in volatile/rainy slots.
            ml_residual = ml_residual * blend
            ml_residual = _rolling_mean(ml_residual, 3, center=True)
            if solcast_residual_scale < 0.999:
                ml_residual = ml_residual * solcast_residual_scale

            log.info(
                "ML residual: mean=%.2f  std=%.2f  p95=%.2f kWh/slot  blend_mean=%.2f  solcast_scale=%.2f",
                ml_residual[SOLAR_START_SLOT:SOLAR_END_SLOT].mean(),
                ml_residual[SOLAR_START_SLOT:SOLAR_END_SLOT].std(),
                np.percentile(np.abs(ml_residual[SOLAR_START_SLOT:SOLAR_END_SLOT]), 95),
                blend[SOLAR_START_SLOT:SOLAR_END_SLOT].mean(),
                solcast_residual_scale,
            )
            log.info(
                "ML routing: target_regime=%s regime_model=%s blend=%.2f regime_days=%d regime_samples=%d",
                model_meta.get("target_regime"),
                bool(model_meta.get("used_regime_model")),
                float(model_meta.get("blend", 0.0)),
                int(model_meta.get("regime_days", 0)),
                int(model_meta.get("regime_samples", 0)),
            )
            raw_class_bias, classifier_meta = predict_error_classifier_with_bundle(
                model_bundle,
                X_pred,
                target_regime,
                regime_confidence=float(bias_meta.get("regime_confidence", 1.0)),
                slot_weather_buckets=slot_weather_buckets,
            )
            error_class_term = np.asarray(raw_class_bias, dtype=float)
            error_class_term[:SOLAR_START_SLOT] = 0.0
            error_class_term[SOLAR_END_SLOT:] = 0.0
            error_class_term[w5["rad"].values < RAD_MIN_WM2] = 0.0
            class_cap_frac = np.asarray(classifier_meta.get("cap_frac"), dtype=float).reshape(-1)
            if class_cap_frac.size < SLOTS_DAY:
                class_cap_frac = np.pad(class_cap_frac, (0, SLOTS_DAY - class_cap_frac.size), constant_values=ERROR_CLASS_BIAS_CAP_FRAC)
            class_cap_frac = np.clip(class_cap_frac[:SLOTS_DAY], 0.0, ERROR_CLASS_BIAS_CAP_FRAC)
            class_cap_kwh = cap_kwh * class_cap_frac
            error_class_term = np.clip(error_class_term, -class_cap_kwh, class_cap_kwh)
            class_confidence = np.asarray(classifier_meta.get("confidence"), dtype=float)
            # Hard confidence gate: zero out error class term for very low confidence slots
            _low_conf_mask = class_confidence < ERROR_CLASS_CONFIDENCE_GATE
            error_class_term[_low_conf_mask] = 0.0
            class_blend = ERROR_CLASS_BLEND_MIN + (
                ERROR_CLASS_BLEND_MAX - ERROR_CLASS_BLEND_MIN
            ) * np.clip(
                (class_confidence - ERROR_CLASS_BLEND_CONFIDENCE_FLOOR)
                / max(1.0 - ERROR_CLASS_BLEND_CONFIDENCE_FLOOR, 1e-6),
                0.0,
                1.0,
            )
            class_trust_scale = np.asarray(classifier_meta.get("trust_scale"), dtype=float).reshape(-1)
            if class_trust_scale.size < SLOTS_DAY:
                class_trust_scale = np.pad(class_trust_scale, (0, SLOTS_DAY - class_trust_scale.size), constant_values=1.0)
            class_trust_scale = np.clip(class_trust_scale[:SLOTS_DAY], 0.0, 1.0)
            class_blend = class_blend * class_trust_scale
            error_class_term = error_class_term * blend
            error_class_term = _rolling_mean(error_class_term, 3, center=True)
            # Re-apply confidence gate after rolling mean (smoothing can bleed signal
            # from neighbors into gated slots).
            error_class_term[_low_conf_mask] = 0.0
            if solcast_residual_scale < 0.999:
                error_class_term = error_class_term * solcast_residual_scale
            error_class_term = error_class_term * class_blend
            error_class_term = np.clip(error_class_term, -class_cap_kwh, class_cap_kwh)
            error_class_meta = {
                **classifier_meta,
                "slot_weather_buckets": slot_weather_buckets.copy(),
                "class_blend": class_blend,
                "class_bias_kwh": error_class_term.copy(),
            }
            log.info(
                "Error classifier: available=%s regime_model=%s blend=%.2f mean_conf=%.2f severe_prob=%.2f support=%.2f profile_rel=%.2f total_bias=%.0f kWh",
                bool(error_class_meta.get("available")),
                bool(error_class_meta.get("used_regime_model")),
                float(error_class_meta.get("blend", 0.0)),
                float(np.mean(np.asarray(error_class_meta.get("confidence"), dtype=float)[SOLAR_START_SLOT:SOLAR_END_SLOT])),
                float(np.mean(np.asarray(error_class_meta.get("severe_probability"), dtype=float)[SOLAR_START_SLOT:SOLAR_END_SLOT])),
                float(np.mean(np.asarray(error_class_meta.get("support_strength"), dtype=float)[SOLAR_START_SLOT:SOLAR_END_SLOT])),
                float(np.mean(np.asarray(error_class_meta.get("profile_reliability"), dtype=float)[SOLAR_START_SLOT:SOLAR_END_SLOT])),
                float(np.sum(error_class_term)),
            )
        except Exception as e:
            log.error("ML prediction failed - falling back to physics only: %s", e)
            _ml_failed = True
            ml_residual = np.zeros(SLOTS_DAY)
            error_class_term = np.zeros(SLOTS_DAY)
    else:
        log.warning("No trained model found - using Solcast baseline only")

    # 4. Error memory bias correction
    err_mem = compute_error_memory(today, w5, target_regime=target_regime)
    # Capture error_memory metadata from module-level cache
    with _ERROR_MEMORY_LOCK:
        error_memory_meta = _LAST_ERROR_MEMORY_META.copy() if _LAST_ERROR_MEMORY_META else {}
    bias_correction = ERROR_ALPHA * err_mem
    bias_correction[:SOLAR_START_SLOT] = 0.0
    bias_correction[SOLAR_END_SLOT:]   = 0.0

    # v2.8 H4 documentation: physics-only branch (used_solcast == False).
    # When Solcast is missing / stale-rejected and the forecast runs on
    # physics + ML only, the regime-aware damping block below is SKIPPED
    # and the raw `ERROR_ALPHA * mem_err` lands in the final forecast.
    # This is intentional: without a Solcast hedge, the learned error
    # memory is the only thing correcting plant-response drift, so we
    # should not damp it further. The ERROR_ALPHA=0.28 scalar and the
    # ±100 kWh/slot clip inside compute_error_memory remain the safety
    # envelope. Tests exercising this branch live in
    # test_forecast_engine_error_classifier.py::test_physics_only_path.
    #
    # Regime-aware Solcast fresh-damping: trust Solcast less during
    # rainy/overcast because satellite cloud tracking can't resolve
    # tropical convective cells.
    if bool(solcast_meta.get("used_solcast")):
        _sc_cov = float(solcast_meta.get("coverage_ratio", 0.0))
        if target_regime == "rainy":
            # Step 13: Rainy-regime damping relaxation (active learning)
            # Once 30+ days of real locked snapshots accumulate, relax damping to let error memory work better
            _rainy_damping = 0.10  # legacy conservative
            _sufficient_locked = False
            try:
                with _open_sqlite(APP_DB_FILE, SQLITE_READ_TIMEOUT_SEC, readonly=True) as conn_check:
                    _sufficient_locked = _has_sufficient_locked_history(conn_check, min_days=30)
            except Exception:
                pass
            if _sufficient_locked:
                _rainy_damping = 0.28
                log.info("[rainy-regime] sufficient locked history (30+ days) — relaxing Solcast damping from 0.10 to 0.28")
            # Rainy: minimal damping — let error memory do its job
            if _sc_cov >= SOLCAST_COVERAGE_FRESH_THRESHOLD:
                _bias_damp = 1.0 - _rainy_damping   # conservative (0.90) or relaxed (0.72)
            elif _sc_cov >= SOLCAST_COVERAGE_USABLE_THRESHOLD:
                _bias_damp = 1.0 - (_rainy_damping * 0.5)  # conservative (0.95) or relaxed (0.86)
            else:
                _bias_damp = 1.0
        elif target_regime == "overcast":
            # Overcast: moderate damping — Solcast is somewhat useful for uniform cloud
            if _sc_cov >= SOLCAST_COVERAGE_FRESH_THRESHOLD:
                _bias_damp = 0.70   # 30% reduction (was 70%)
            elif _sc_cov >= SOLCAST_COVERAGE_USABLE_THRESHOLD:
                _bias_damp = 0.80   # 20% reduction (was 50%)
            else:
                _bias_damp = 1.0
        elif target_regime == "mixed":
            # Mixed: slight relaxation from original
            if _sc_cov >= SOLCAST_COVERAGE_FRESH_THRESHOLD:
                _bias_damp = 0.40   # 60% reduction (was 70%)
            elif _sc_cov >= SOLCAST_COVERAGE_USABLE_THRESHOLD:
                _bias_damp = 0.55   # 45% reduction (was 50%)
            else:
                _bias_damp = 1.0
        else:
            # Clear: keep original behavior — Solcast is most reliable here
            if _sc_cov >= SOLCAST_COVERAGE_FRESH_THRESHOLD:
                _bias_damp = 0.30   # 70% reduction (unchanged)
            elif _sc_cov >= SOLCAST_COVERAGE_USABLE_THRESHOLD:
                _bias_damp = 0.50   # 50% reduction (unchanged)
            else:
                _bias_damp = 1.0
        if _bias_damp < 1.0:
            bias_correction = bias_correction * _bias_damp
            log.info(
                "Bias correction damped %.0f%% for Solcast (coverage=%.2f regime=%s bias_damp=%.2f)",
                (1.0 - _bias_damp) * 100.0, _sc_cov, target_regime or "unknown", _bias_damp,
            )

    # v2.8 H5 fix: overwrite the applied_bias_total_kwh telemetry with the
    # post-damping magnitude so operators see what actually hit the final
    # forecast (not the pre-damping aspiration). raw_bias_total_kwh is
    # preserved so the learning-loop strength signal is still visible.
    try:
        _applied_total = float(bias_correction[SOLAR_START_SLOT:SOLAR_END_SLOT].sum())
        error_memory_meta["applied_bias_total_kwh"] = _applied_total
        # Also mirror into the module-level cache so downstream readers
        # (engine-health endpoint) see the corrected value.
        with _ERROR_MEMORY_LOCK:
            if _LAST_ERROR_MEMORY_META:
                _LAST_ERROR_MEMORY_META["applied_bias_total_kwh"] = _applied_total
    except Exception:
        pass

    log.info(
        "Bias correction: mean=%.2f  max=%.2f kWh/slot (alpha=%.2f)",
        bias_correction[SOLAR_START_SLOT:SOLAR_END_SLOT].mean(),
        np.abs(bias_correction[SOLAR_START_SLOT:SOLAR_END_SLOT]).max(),
        ERROR_ALPHA,
    )

    # 5. PHASE 4: Combine using Solcast-mid baseline instead of hybrid_baseline
    # hybrid_baseline was remapped to solcast_mid above
    forecast = baseline + ml_residual + error_class_term + bias_correction

    # Hard capacity constraints:
    # - dependable cap is used in physics baseline shaping
    # - max cap is the hard physical upper bound per 5-min slot
    cap_slot_dep = slot_cap_kwh(dependable=True)
    cap_slot_max = slot_cap_kwh(dependable=False)
    log.info(
        "Capacity guard: dep=%.4f MWh/slot  max=%.4f MWh/slot (5-min)",
        cap_slot_dep / 1000.0,
        cap_slot_max / 1000.0,
    )

    # Clamp by hard physical max so day-ahead cannot exceed real plant capacity.
    # Example: 23 MW max PAC -> 23 * (5/60) = 1.9167 MWh max per slot.
    cap_slot = cap_slot_max
    forecast = np.clip(forecast, 0.0, cap_slot)
    forecast[:SOLAR_START_SLOT] = 0.0
    forecast[SOLAR_END_SLOT:]   = 0.0

    # NOTE (v2.8 cleanup): hour-shape correction was removed — Phase 4 made
    # Solcast the 100% baseline, so the legacy `apply_hour_shape_correction`
    # branch was structurally unreachable. Activity hysteresis + block staging
    # are still active.
    forecast, activity_meta = apply_activity_hysteresis(forecast, target_s, w5, artifacts, bias_meta=bias_meta)
    forecast, staging_meta = apply_block_staging(forecast, w5)
    forecast = np.clip(forecast, 0.0, cap_slot)
    forecast[:SOLAR_START_SLOT] = 0.0
    forecast[SOLAR_END_SLOT:]   = 0.0

    log.info(
        "Hardening: start=%s end=%s hist_window=%d bias_shift=%d staged_slots=%d node_step=%.2f",
        activity_meta.get("first_slot"),
        activity_meta.get("last_slot"),
        int(activity_meta.get("history_matches", 0)),
        int(activity_meta.get("bias_shift_slots", 0)),
        int(staging_meta.get("staged_slots", 0)),
        float(staging_meta.get("node_step_kwh", 0.0)),
    )

    # Ramp rate limit
    forecast = apply_ramp_limit(forecast)

    # Final clip (ramp may push slightly over)
    forecast = np.clip(forecast, 0.0, cap_slot)

    # Sanity check: total energy must be <= theoretical physical maximum.
    max_kwh_day = plant_capacity_kw(False) * (SOLAR_END_H - SOLAR_START_H)
    _fsum = forecast.sum()
    if _fsum > max_kwh_day and _fsum > 0:
        log.warning(
            "Forecast total %.0f kWh exceeds theoretical max %.0f kWh - scaling down",
            _fsum, max_kwh_day,
        )
        forecast *= max_kwh_day / _fsum

    # Solcast per-slot energy floor: for each 5-minute slot, enforce that the forecast
    # does not fall below floor_ratio  Solcast slot kWh when Solcast is fresh.
    # This preserves ML shape adjustments where ML is above the floor, but prevents
    # individual slots from being dragged far below Solcast by ML residual or bias.
    if bool(solcast_meta.get("used_solcast")):
        _sc_cov_f = float(solcast_meta.get("coverage_ratio", 0.0))
        _sc_kwh = np.asarray(solcast_snapshot.get("forecast_kwh", []), dtype=float)
        if _sc_kwh.size == SLOTS_DAY:
            if _sc_cov_f >= SOLCAST_COVERAGE_FRESH_THRESHOLD:
                _floor_ratio = SOLCAST_FORECAST_FLOOR_RATIO_FRESH
            elif _sc_cov_f >= SOLCAST_COVERAGE_USABLE_THRESHOLD:
                _floor_ratio = SOLCAST_FORECAST_FLOOR_RATIO_USABLE
            else:
                _floor_ratio = 0.0
            if _floor_ratio > 0.0:
                _fc_before = float(forecast.sum())
                # Time-of-day floor modulation
                _tod_mod = np.ones(SLOTS_DAY, dtype=float)
                if solcast_reliability is not None and isinstance(solcast_reliability, dict) and solcast_reliability.get("time_of_day"):
                    _overall_rel_floor = float(np.clip(
                        (lookup_solcast_reliability(solcast_reliability, solcast_meta.get("regime", "mixed")) or {}).get("reliability", 0.62),
                        0.25, 1.0,
                    ))
                    for _zone, (_zs, _ze) in TOD_ZONES.items():
                        _ztod = lookup_solcast_tod_reliability(solcast_reliability, solcast_meta.get("regime", "mixed"), _zone)
                        _zrel = float(np.clip(_ztod.get("reliability", _overall_rel_floor), 0.25, 1.0))
                        _tod_mod[_zs:_ze] = float(np.clip(_zrel / max(_overall_rel_floor, 0.30), 0.80, 1.10))
                _slot_floor = _sc_kwh * _floor_ratio * _tod_mod
                _slot_floor[:SOLAR_START_SLOT] = 0.0
                _slot_floor[SOLAR_END_SLOT:]   = 0.0
                # Raise each slot to at least floor_ratio  Solcast, capped at slot capacity
                _lifted = np.where(
                    (forecast < _slot_floor) & (_slot_floor > 0.0),
                    np.minimum(_slot_floor, cap_slot),
                    forecast,
                )
                _lifted_count = int(np.sum(
                    (forecast[SOLAR_START_SLOT:SOLAR_END_SLOT] < _slot_floor[SOLAR_START_SLOT:SOLAR_END_SLOT])
                    & (_slot_floor[SOLAR_START_SLOT:SOLAR_END_SLOT] > 0.0)
                ))
                if _lifted_count > 0:
                    forecast = _lifted
                    log.info(
                        "Solcast per-slot floor applied: %d/%d slots lifted, %.0f->%.0f kWh (floor=%.0f%% coverage=%.2f)",
                        _lifted_count, SOLAR_END_SLOT - SOLAR_START_SLOT,
                        _fc_before, float(forecast.sum()),
                        _floor_ratio * 100.0, _sc_cov_f,
                    )

    # NOTE (v2.8 cleanup): the standalone "5a. Solcast per-slot ceiling"
    # block was removed — it was a duplicate of the P90 ceiling that runs
    # inside the tri-band hard clamp below. Same operation, twice.
    #
    # NOTE (v2.8 cleanup): Analog Ensemble (AnEn) post-correction was removed.
    # See earlier comment near `_anen_*`.

    # 5c. FINAL Solcast tri-band hard clamp (P10 floor + P90 ceiling)
    # Runs AFTER all corrections (ramp, staging, etc.) to guarantee the
    # forecast stays within the Solcast confidence interval when Solcast data
    # is available. The previous Open-Meteo "weather-divergence override" was
    # removed (v2.8 cleanup) — Open-Meteo is unreliable for this site per
    # operator (`project_openmeteo_rain_unreliable`), so we should not let it
    # veto the Solcast clamp.
    if bool(solcast_meta.get("used_solcast")):
        _sc_lo_final = np.asarray(solcast_snapshot.get("forecast_lo_kwh", []), dtype=float)
        _sc_hi_final = np.asarray(solcast_snapshot.get("forecast_hi_kwh", []), dtype=float)
        _sc_cov_final = float(solcast_meta.get("coverage_ratio", 0.0))
        _solar = slice(SOLAR_START_SLOT, SOLAR_END_SLOT)
        _triband_log_parts = []

        # P10 hard floor — never go below Solcast lo band
        if _sc_lo_final.size == SLOTS_DAY and _sc_cov_final >= SOLCAST_COVERAGE_USABLE_THRESHOLD:
            _below_p10 = (
                (forecast[_solar] < _sc_lo_final[_solar])
                & (_sc_lo_final[_solar] > 0.0)
                & np.isfinite(_sc_lo_final[_solar])
            )
            _below_count = int(np.sum(_below_p10))
            if _below_count > 0:
                forecast[_solar] = np.where(
                    _below_p10,
                    np.minimum(_sc_lo_final[_solar], cap_slot),
                    forecast[_solar],
                )
                _triband_log_parts.append(f"P10 floor lifted {_below_count} slots")
        # P90 hard ceiling — never exceed Solcast hi band
        if _sc_hi_final.size == SLOTS_DAY and _sc_cov_final >= SOLCAST_COVERAGE_USABLE_THRESHOLD:
            _above_p90 = (forecast[_solar] > _sc_hi_final[_solar]) & np.isfinite(_sc_hi_final[_solar])
            _above_count = int(np.sum(_above_p90))
            if _above_count > 0:
                forecast[_solar] = np.where(
                    _above_p90,
                    np.minimum(_sc_hi_final[_solar], cap_slot),
                    forecast[_solar],
                )
                _triband_log_parts.append(f"P90 ceiling clamped {_above_count} slots")
        if _triband_log_parts:
            log.info(
                "Solcast tri-band hard clamp: %s (coverage=%.2f)",
                ", ".join(_triband_log_parts), _sc_cov_final,
            )

    # 6. Confidence bands
    lo, hi = confidence_bands(
        forecast,
        w5,
        target_s,
        float(bias_meta.get("regime_confidence", 1.0)),
        error_class_meta=error_class_meta if bool(error_class_meta.get("available")) else None,
        solcast_prior=solcast_prior if isinstance(solcast_prior, dict) else None,
    )

    # 7. PHASE 4: Summary log - reference Solcast baseline
    log.info(
        "Forecast summary: total=%.0f kWh  peak=%.2f kWh/slot  "
        "solcast_mid_total=%.0f kWh  ml_corr=%.0f kWh  class_corr=%.0f kWh  bias_corr=%.0f kWh",
        forecast.sum(),
        forecast.max(),
        baseline.sum(),
        ml_residual.sum(),
        error_class_term.sum(),
        bias_correction.sum(),
    )

    series = to_ui_series(forecast, lo, hi, target_s)
    error_class_summary = {
        "available": bool(error_class_meta.get("available")),
        "target_regime": target_regime,
        "used_regime_model": bool(error_class_meta.get("used_regime_model")),
        "blend": float(error_class_meta.get("blend", 0.0)),
        "mean_confidence": float(np.mean(np.asarray(error_class_meta.get("confidence"), dtype=float)[SOLAR_START_SLOT:SOLAR_END_SLOT])) if bool(error_class_meta.get("available")) else 0.0,
        "mean_support_strength": float(np.mean(np.asarray(error_class_meta.get("support_strength"), dtype=float)[SOLAR_START_SLOT:SOLAR_END_SLOT])) if bool(error_class_meta.get("available")) else 0.0,
        "mean_profile_reliability": float(np.mean(np.asarray(error_class_meta.get("profile_reliability"), dtype=float)[SOLAR_START_SLOT:SOLAR_END_SLOT])) if bool(error_class_meta.get("available")) else 0.0,
        "mean_probabilities": {
            name: float(np.mean(np.asarray(error_class_meta.get("probabilities"), dtype=float)[SOLAR_START_SLOT:SOLAR_END_SLOT, idx]))
            for idx, name in enumerate(ERROR_CLASS_NAMES)
        } if bool(error_class_meta.get("available")) else {name: 0.0 for name in ERROR_CLASS_NAMES},
        "weather_bucket_forecast_summary": summarize_value_by_bucket(forecast, slot_weather_buckets),
        "weather_profiles": error_class_meta.get("weather_profiles") or {},
        "class_support_weights": dict(error_class_meta.get("class_support_weights") or {}),
        "slot_weather_buckets": slot_weather_buckets.copy(),
        "predicted_labels": np.asarray(error_class_meta.get("predicted_labels"), dtype=int).copy(),
        "class_confidence": np.asarray(error_class_meta.get("confidence"), dtype=float).copy(),
        "severe_probability": np.asarray(error_class_meta.get("severe_probability"), dtype=float).copy(),
        "support_strength": np.asarray(error_class_meta.get("support_strength"), dtype=float).copy(),
        "profile_reliability": np.asarray(error_class_meta.get("profile_reliability"), dtype=float).copy(),
        "trust_scale": np.asarray(error_class_meta.get("trust_scale"), dtype=float).copy(),
        "cap_frac": np.asarray(error_class_meta.get("cap_frac"), dtype=float).copy(),
        "class_blend": np.asarray(error_class_meta.get("class_blend"), dtype=float).copy(),
        "class_bias_kwh": np.asarray(error_class_meta.get("class_bias_kwh"), dtype=float).copy(),
        "total_bias_kwh": float(np.sum(error_class_term)),
    }
    if not persist:
        return {
            "day": target_s,
            "series": series,
            "forecast": forecast,
            "solcast_mid_baseline": baseline,  # PHASE 4: Renamed from hybrid_baseline
            "lo": lo,
            "hi": hi,
            "weather_source": weather_source,
            "raw_hourly": raw_hourly,
            "hourly_applied": hourly_applied,
            "target_regime": target_regime,
            "bias_meta": bias_meta,
            "solcast_meta": solcast_meta,
            "activity_meta": activity_meta,
            "staging_meta": staging_meta,
            "baseline_total_kwh": float(baseline.sum()),  # PHASE 4: Now Solcast mid total
            # NB: solcast_snapshot is None on the physics-fallback path — guard each
            # access (mirrors the persist-path audit writer at ~11387). Provenance flag
            # reflects the actual baseline used, not a hardcoded assumption.
            "solcast_lo_total_kwh": float(np.asarray(solcast_snapshot.get("forecast_lo_kwh", []), dtype=float).sum()) if solcast_snapshot else None,  # PHASE 4: NEW
            "solcast_hi_total_kwh": float(np.asarray(solcast_snapshot.get("forecast_hi_kwh", []), dtype=float).sum()) if solcast_snapshot else None,  # PHASE 4: NEW
            "baseline_is_solcast_mid": bool(solcast_meta.get("used_solcast")),  # PHASE 4: NEW - flag new architecture
            "forecast_total_kwh": float(forecast.sum()),
            "ml_residual_total_kwh": float(ml_residual.sum()),
            "ml_total_kwh": float(ml_residual.sum()),
            "error_class_total_kwh": float(error_class_term.sum()),
            "bias_total_kwh": float(bias_correction.sum()),
            "error_memory_meta": error_memory_meta,
            "error_class_meta": error_class_summary,
        }

    # --- PHASE 4: Forecast sanity check using Solcast mid baseline ---
    _fc_total_kwh = float(np.sum(forecast))
    _solcast_total_kwh = float(np.sum(baseline))  # baseline IS Solcast mid now
    if _solcast_total_kwh > 0:
        _fc_ratio = _fc_total_kwh / _solcast_total_kwh
        if _fc_ratio < 0.30 or _fc_ratio > 2.50:
            log.error("FORECAST SANITY FAIL: total=%.1f kWh is %.1f%% of Solcast baseline=%.1f kWh - suppressing write",
                      _fc_total_kwh, _fc_ratio * 100, _solcast_total_kwh)
            return {"status": "error", "reason": "sanity_check_failed", "fc_ratio": round(_fc_ratio, 3)} if not persist else False
        elif _fc_ratio < 0.50 or _fc_ratio > 1.80:
            log.warning("Forecast total %.1f kWh is %.1f%% of Solcast baseline - unusual but within tolerance",
                        _fc_total_kwh, _fc_ratio * 100)

    # Validate confidence bands ordering
    if lo is not None and hi is not None:
        _band_violations = int(np.sum(lo > hi))
        if _band_violations > 0:
            log.warning("Confidence band ordering violated in %d slots (lo > hi) - clamping", _band_violations)
            hi = np.maximum(lo, hi)

    # Persist error_memory metadata to ml_train_state.json
    try:
        _train_state = _load_json(ML_TRAIN_STATE_FILE)
        if _train_state is None:
            _train_state = {}
        _train_state["error_memory"] = error_memory_meta
        _save_json(ML_TRAIN_STATE_FILE, _train_state)
    except Exception as e:
        log.warning("Failed to persist error_memory metadata to ml_train_state.json: %s", e)

    # 8. Write
    ok = write_forecast("PacEnergy_DayAhead", target_s, series)
    _snapshot_saved = False
    if ok and weather_source in {"forecast", "snapshot"}:
        _snapshot_saved = save_forecast_weather_snapshot(
            target_s,
            raw_hourly,
            hourly_applied,
            provider="open-meteo",
            meta={
                "weather_source": weather_source,
                "bias_meta": bias_meta,
                "target_regime": target_regime,
                "error_class_debug": {
                    "hybrid_baseline_kwh": [float(v) for v in np.asarray(hybrid_baseline, dtype=float)],
                    "slot_weather_buckets": [str(v) for v in np.asarray(slot_weather_buckets, dtype=object)],
                    "predicted_labels": [int(v) for v in np.asarray(error_class_meta.get("predicted_labels"), dtype=int)],
                    "class_confidence": [float(v) for v in np.asarray(error_class_meta.get("confidence"), dtype=float)],
                    "support_strength": [float(v) for v in np.asarray(error_class_meta.get("support_strength"), dtype=float)],
                    "profile_reliability": [float(v) for v in np.asarray(error_class_meta.get("profile_reliability"), dtype=float)],
                },
            },
        )

    _base_run_audit_id = None
    if ok and write_audit:
        # Build audit enrichment notes (Phase 2 gaps)
        _sc_kwh_snap = np.asarray(solcast_snapshot.get("forecast_kwh", []) if solcast_snapshot else [], dtype=float)
        _sc_lo_snap  = np.asarray(solcast_snapshot.get("forecast_lo_kwh", []) if solcast_snapshot else [], dtype=float)
        _sc_hi_snap  = np.asarray(solcast_snapshot.get("forecast_hi_kwh", []) if solcast_snapshot else [], dtype=float)

        # 2.1 weather_source_breakdown
        _wsb = {
            "met_source": weather_source,
            "solcast_used": bool(solcast_meta.get("used_solcast")),
            "solcast_coverage_ratio": float(solcast_meta.get("coverage_ratio", 0.0)),
        }

        # 2.2 solcast_gap_profile (per-zone zero-slot count in solar window)
        _gap_profile: dict = {}
        if _sc_kwh_snap.size == SLOTS_DAY:
            for _zone, (_zs, _ze) in TOD_ZONES.items():
                _gap_profile[_zone] = int(np.sum(_sc_kwh_snap[_zs:_ze] <= 0.0))

        # 2.3 forecast lo/hi band totals
        _lo_total = float(_sc_lo_snap.sum()) if _sc_lo_snap.size == SLOTS_DAY else None
        _hi_total = float(_sc_hi_snap.sum()) if _sc_hi_snap.size == SLOTS_DAY else None

        # 2.4 ml_model_routing
        if not _ml_failed and model_meta is not None:
            _mlr: dict = {
                "target_regime": model_meta.get("target_regime"),
                "used_regime_model": bool(model_meta.get("used_regime_model")),
                "blend": float(model_meta.get("blend", 0.0)),
                "regime_days": int(model_meta.get("regime_days", 0)),
                "ml_fallback": False,
            }
        else:
            _mlr = {"target_regime": target_regime, "ml_fallback": True}

        # 2.5 zero-filled weather feature warnings
        _data_warnings: list[str] = []
        for _wcol in ("rad", "cloud", "rh", "precip", "cape"):
            if _wcol not in w5.columns or float(pd.to_numeric(w5[_wcol], errors="coerce").fillna(0.0).abs().max()) == 0.0:
                _data_warnings.append(f"weather_col_zero_filled:{_wcol}")

        _notes_extra: dict = {
            "weather_source_breakdown": _wsb,
            "solcast_gap_profile": _gap_profile,
            "ml_model_routing": _mlr,
            "forecast_lo_total_kwh": _lo_total,
            "forecast_hi_total_kwh": _hi_total,
            "error_memory": error_memory_meta,
            # data_warnings is the authoritative source in ml_train_state.json; not duplicated here
        }
        # FIX-09: Tag fallback reason when Node delegation failed
        if "fallback" in (audit_generator_mode or ""):
            _notes_extra["fallback_reason"] = "node_delegation_failed"

        _base_run_audit_id = _write_forecast_run_audit_from_python(
            target_date=target_s,
            generator_mode=audit_generator_mode or "python_direct",
            weather_source=weather_source,
            solcast_meta=solcast_meta,
            forecast_total_kwh=float(forecast.sum()),
            baseline_total_kwh=float(baseline.sum()),
            hybrid_total_kwh=float(hybrid_baseline.sum()),
            ml_total_kwh=float(ml_residual.sum()),
            error_class_total_kwh=float(error_class_term.sum()),
            bias_total_kwh=float(bias_correction.sum()),
            ml_failed=_ml_failed,
            notes_extra=_notes_extra,
            solcast_lo_total_kwh=float(np.asarray(solcast_snapshot.get("forecast_lo_kwh", []), dtype=float).sum()) if solcast_snapshot else None,
            solcast_hi_total_kwh=float(np.asarray(solcast_snapshot.get("forecast_hi_kwh", []), dtype=float).sum()) if solcast_snapshot else None,
        )

    # Capture replay evidence only after the exact weather snapshot and any
    # authoritative Python audit row exist.  A generic mutable-table sync must
    # never mint an issuance because it cannot recover original issue time.
    if ok:
        _issuance_weather = load_forecast_weather_snapshot(target_s) if _snapshot_saved or weather_source == "snapshot" else None
        if _issuance_weather:
            _issuance_id = _capture_immutable_dayahead_issuance(
                target_s,
                series,
                _issuance_weather,
                base_run_audit_id=_base_run_audit_id,
                source="python_direct",
            )
            if not _issuance_id:
                log.error("Day-ahead written but immutable replay issuance capture failed [%s]", target_s)
        else:
            log.warning("Day-ahead written without immutable replay issuance [%s]: exact weather snapshot unavailable", target_s)

    return ok

# ============================================================================
# MANUAL GENERATION (CLI)
# ============================================================================

def _parse_iso_date_safe(value: str) -> date:
    try:
        return datetime.strptime(str(value).strip(), "%Y-%m-%d").date()
    except Exception as e:
        raise ValueError(f"Invalid date '{value}'. Use YYYY-MM-DD.") from e

def _iter_days(start_date: date, end_date: date) -> list[date]:
    if end_date < start_date:
        raise ValueError("End date must be on or after start date.")
    days = []
    cur = start_date
    while cur <= end_date:
        days.append(cur)
        cur += timedelta(days=1)
    return days

def run_manual_generation(dates: list[date]) -> bool:
    dates = sorted(set(dates))
    if not dates:
        log.error("Manual generation: no target dates provided.")
        return False

    clear_forecast_data_cache()
    today_ref = datetime.now().date()
    log.info("Manual generation start: %d date(s), reference=%s", len(dates), today_ref.isoformat())

    trained = train_model(today_ref)
    if not trained:
        log.warning("Manual generation: model training skipped - physics fallback may be used.")

    forecast_qa(today_ref)

    ok_all = True
    parent_locked_child = (
        str(os.environ.get("ADSI_FORECAST_DIRECT_UNDER_PARENT_LOCK", "")).strip() == "1"
    )
    node_reachable = not parent_locked_child

    for d in dates:
        ok = False
        used_delegation = False

        if parent_locked_child:
            # This exact environment contract is set only by Node's generator
            # child.  Node already owns the cross-process/date lock and creates
            # the authoritative audit, so delegating or reacquiring here would
            # deadlock/duplicate the same generation.
            ok = bool(run_dayahead(
                d,
                today_ref,
                write_audit=False,
                audit_generator_mode="node_parent_locked_child",
            ))
            used_delegation = True
        elif node_reachable:
            result = _delegate_run_dayahead(d, trigger="manual_cli")
            if result is not None:
                ok = True
                used_delegation = True
            else:
                node_reachable = False
                log.warning(
                    "Manual generation: Node delegation failed for %s - "
                    "falling back to direct run_dayahead for remaining dates.",
                    d.isoformat(),
                )

        if not used_delegation:
            # T4.4 fix: hold advisory lock across direct fallback so a concurrent
            # Node completion can't also write an audit row for the same date.
            _acquired = _dayahead_gen_lock_acquire(d, owner="manual_cli_fallback")
            try:
                if _acquired:
                    ok = run_dayahead(d, today_ref, write_audit=True, audit_generator_mode="manual_cli_fallback")
                else:
                    log.warning(
                        "Manual CLI fallback skipped for %s — generation lock held by another process.",
                        d.isoformat(),
                    )
                    ok = False
            finally:
                if _acquired:
                    _dayahead_gen_lock_release(d)

        if ok and d == today_ref:
            run_intraday_adjusted(d)
        ok_all = ok_all and ok
        if ok:
            log.info("Manual generation OK: %s (delegated=%s)", d.isoformat(), used_delegation)
        else:
            log.error("Manual generation FAILED: %s", d.isoformat())

    return ok_all

def run_backtest(dates: list[date]) -> bool:
    """
    Replay historical day-ahead forecasts over a date range.

    This mode requires saved forecast-weather snapshots for past targets so the
    scored forecast reflects true day-ahead inputs instead of hindsight weather.
    """
    dates = sorted(set(dates))
    if not dates:
        log.error("Backtest: no target dates provided.")
        return False

    clear_forecast_data_cache()
    log.info(
        "Backtest start: %d date(s), range=%s..%s, strict_snapshots=true",
        len(dates),
        dates[0].isoformat(),
        dates[-1].isoformat(),
    )

    rows: list[dict] = []
    skipped_actual = 0
    skipped_snapshot = 0
    skipped_training = 0
    skipped_forecast = 0

    for target_date in dates:
        target_s = target_date.isoformat()
        # E5 priority chain: metered substation → loss-adjusted inverter → Solcast est_actual
        actual, actual_present, _ = resolve_actual_5min_for_date(target_s)
        if not np.any(actual_present):
            skipped_actual += 1
            log.warning("Backtest skip [%s] - actual 5-minute history unavailable", target_s)
            continue

        if not load_forecast_weather_snapshot(target_s):
            skipped_snapshot += 1
            log.warning("Backtest skip [%s] - saved forecast weather snapshot unavailable", target_s)
            continue

        reference_day = target_date - timedelta(days=1)
        runtime_state = build_training_state(reference_day)
        if not runtime_state:
            skipped_training += 1
            log.warning("Backtest skip [%s] - training state unavailable at reference=%s", target_s, reference_day.isoformat())
            continue

        result = run_dayahead(
            target_date,
            reference_day,
            runtime_state=runtime_state,
            persist=False,
            require_saved_snapshot_for_past=True,
        )
        if not isinstance(result, dict):
            skipped_forecast += 1
            log.warning("Backtest skip [%s] - forecast replay failed", target_s)
            continue

        _, constraint_meta = build_operational_constraint_mask(target_s)
        # Use 1000H alarm-based outage mask instead of stale audit_log operational_mask
        _bt_outage = _build_1000h_inverter_outage_mask(target_s)
        _bt_cap = np.asarray(constraint_meta.get("cap_dispatch_mask"), dtype=bool)
        _bt_exclude = _bt_outage | _bt_cap
        metrics = compute_forecast_metrics(
            actual,
            np.asarray(result["forecast"], dtype=float),
            actual_present=actual_present,
            exclude_mask=_bt_exclude,
        )
        if metrics is None:
            skipped_forecast += 1
            log.warning("Backtest skip [%s] - forecast metrics unavailable", target_s)
            continue

        bucket_metrics = compute_bucketed_forecast_metrics(
            actual,
            np.asarray(result["forecast"], dtype=float),
            (result.get("error_class_meta") or {}).get("slot_weather_buckets"),
            actual_present=actual_present,
            exclude_mask=_bt_exclude,
        )
        class_metrics = compute_error_class_metrics(
            actual,
            np.asarray(result.get("hybrid_baseline"), dtype=float) if result.get("hybrid_baseline") is not None else None,
            (result.get("error_class_meta") or {}).get("predicted_labels"),
            class_confidence=(result.get("error_class_meta") or {}).get("class_confidence"),
            actual_present=actual_present,
            exclude_mask=_bt_exclude,
        )

        rows.append({
            "day": target_s,
            "reference_day": reference_day.isoformat(),
            "weather_source": str(result.get("weather_source") or ""),
            "target_regime": str(result.get("target_regime") or ""),
            "solcast_used": bool((result.get("solcast_meta") or {}).get("used_solcast")),
            "solcast_blend": float((result.get("solcast_meta") or {}).get("mean_blend", 0.0)),
            "bucket_metrics": bucket_metrics,
            "classifier_sign_hit_rate": None if class_metrics is None else float(class_metrics.get("sign_hit_rate", 0.0)),
            "classifier_severe_hit_rate": None if class_metrics is None or class_metrics.get("severe_hit_rate") is None else float(class_metrics.get("severe_hit_rate", 0.0)),
            "classifier_mean_confidence": 0.0 if class_metrics is None else float(class_metrics.get("mean_confidence", 0.0)),
            **metrics,
        })
        log.info(
            "Backtest [%s] usable=%d masked=%d WAPE=%.1f%% TotalAPE=%.1f%% MAPE=%.1f%% RMSE=%.1f kWh/slot First=%s Last=%s regime=%s solcast=%s blend=%.2f sign_hit=%s conf=%.2f",
            target_s,
            metrics["usable_slot_count"],
            metrics["masked_slot_count"],
            metrics["wape_pct"],
            metrics["total_ape_pct"],
            metrics["mape_pct"],
            metrics["rmse_kwh"],
            _format_minutes(metrics["first_active_error_min"]),
            _format_minutes(metrics["last_active_error_min"]),
            result.get("target_regime"),
            bool((result.get("solcast_meta") or {}).get("used_solcast")),
            float((result.get("solcast_meta") or {}).get("mean_blend", 0.0)),
            f"{float(class_metrics['sign_hit_rate']):.3f}" if class_metrics is not None else "n/a",
            0.0 if class_metrics is None else float(class_metrics.get("mean_confidence", 0.0)),
        )
        log.info("Backtest buckets [%s] %s", target_s, _format_bucket_metric_summary(bucket_metrics))

    if not rows:
        log.error(
            "Backtest produced no scored days (skipped: actual=%d snapshot=%d training=%d forecast=%d)",
            skipped_actual,
            skipped_snapshot,
            skipped_training,
            skipped_forecast,
        )
        return False

    actual_total = float(sum(row["actual_total_kwh"] for row in rows))
    abs_error_total = float(sum(row["abs_error_sum_kwh"] for row in rows))
    overall_wape = float((abs_error_total / max(actual_total, 1.0)) * 100.0)
    mean_daily_wape = float(np.mean([row["wape_pct"] for row in rows]))
    median_daily_wape = float(np.median([row["wape_pct"] for row in rows]))
    mean_total_ape = float(np.mean([row["total_ape_pct"] for row in rows]))
    mean_mape = float(np.mean([row["mape_pct"] for row in rows]))
    regime_summary_parts = []
    for regime in sorted({str(row.get("target_regime") or "") for row in rows if row.get("target_regime")}):
        regime_rows = [row for row in rows if str(row.get("target_regime") or "") == regime]
        regime_actual_total = float(sum(row["actual_total_kwh"] for row in regime_rows))
        regime_abs_total = float(sum(row["abs_error_sum_kwh"] for row in regime_rows))
        regime_wape = float((regime_abs_total / max(regime_actual_total, 1.0)) * 100.0)
        regime_summary_parts.append(f"{regime}:WAPE={regime_wape:.1f}% n={len(regime_rows)}")

    log.info(
        "Backtest summary: scored=%d/%d overall_WAPE=%.1f%% mean_daily_WAPE=%.1f%% median_daily_WAPE=%.1f%% mean_total_APE=%.1f%% mean_MAPE=%.1f%% skipped(actual=%d snapshot=%d training=%d forecast=%d)",
        len(rows),
        len(dates),
        overall_wape,
        mean_daily_wape,
        median_daily_wape,
        mean_total_ape,
        mean_mape,
        skipped_actual,
        skipped_snapshot,
        skipped_training,
        skipped_forecast,
    )
    if regime_summary_parts:
        log.info("Backtest regimes: %s", ", ".join(regime_summary_parts))
    return True

def _git_commit_hash() -> str | None:
    try:
        repo_root = Path(__file__).resolve().parent.parent
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=repo_root,
            capture_output=True, text=True, timeout=5, check=False,
        )
        value = str(result.stdout or "").strip()
        return value if result.returncode == 0 and value else None
    except Exception:
        return None

def resolve_forecast_build_identity() -> dict:
    """Resolve source or frozen identity without trusting stale adjacent JSON."""
    repo_root = Path(__file__).resolve().parent.parent
    is_frozen = bool(getattr(sys, "frozen", False) or getattr(sys, "_MEIPASS", None))

    def _valid_hex(value, size: int) -> bool:
        text = str(value or "").strip().lower()
        return len(text) == size and all(ch in "0123456789abcdef" for ch in text)

    def _canonical_timestamp_matches(data: dict) -> bool:
        timestamp = data.get("build_timestamp")
        recorded_utc = data.get("build_timestamp_utc")
        if type(timestamp) is not int or timestamp < 0 or type(recorded_utc) is not str:
            return False
        try:
            canonical_utc = datetime.fromtimestamp(
                timestamp / 1000.0, tz=timezone.utc
            ).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        except (OverflowError, OSError, ValueError):
            return False
        return recorded_utc == canonical_utc

    if is_frozen:
        roots = []
        if getattr(sys, "_MEIPASS", None):
            roots.append(Path(str(sys._MEIPASS)))
        roots.extend((Path(__file__).resolve().parent, Path(sys.executable).resolve().parent))
        build_info_path = next(
            (root / "forecast-build-info.json" for root in roots if (root / "forecast-build-info.json").exists()),
            None,
        )
        try:
            data = json.loads(build_info_path.read_text(encoding="utf-8")) if build_info_path else {}
            complete = bool(
                isinstance(data, dict)
                and data.get("schema_version") == 1
                and isinstance(data.get("package_version"), str) and data.get("package_version")
                and _valid_hex(data.get("git_commit"), 40)
                and _valid_hex(data.get("source_hash"), 64)
                and type(data.get("git_dirty")) is bool
                and type(data.get("git_status_available")) is bool
                and data.get("build_channel") in {"development", "signed-release"}
                and data.get("source_path") == "services/forecast_engine.py"
                and _canonical_timestamp_matches(data)
                and isinstance(data.get("artifact_compatibility_version"), int)
                and data.get("artifact_compatibility_version") > 0
                and data.get("identity_status") == "verified"
            )
            promotion = bool(
                complete and data.get("promotion_eligible") is True
                and data.get("build_channel") == "signed-release"
                and data.get("git_status_available") is True and data.get("git_dirty") is False
                and data.get("release_base_ref_available") is True
                and data.get("release_base_ref") == "origin/main"
                and type(data.get("commits_behind_release_base")) is int
                and data.get("commits_behind_release_base") == 0
                and data.get("package_version_tag_exists") is False
                and data.get("release_ready") is True
            )
            if complete:
                return {**data, "promotion_eligible": promotion}
        except Exception:
            pass
        return {
            "schema_version": 1, "package_version": None, "git_commit": None,
            "git_dirty": True, "git_status_available": False,
            "build_timestamp": None, "build_timestamp_utc": None,
            "source_hash": None, "artifact_compatibility_version": None,
            "identity_status": "unverified", "promotion_eligible": False,
        }

    package_version = None
    try:
        pkg_file = repo_root / "package.json"
        if pkg_file.exists():
            package_version = json.loads(pkg_file.read_text(encoding="utf-8")).get("version")
    except Exception:
        pass

    commit = _git_commit_hash()
    commit = commit.lower() if _valid_hex(commit, 40) else None
    git_dirty = True
    git_status_available = False
    try:
        result = subprocess.run(
            ["git", "status", "--porcelain=v1", "--untracked-files=all", "--", ".",
             ":(exclude)services/forecast-build-info.json"],
            cwd=repo_root, capture_output=True, text=True, timeout=5, check=False,
        )
        if result.returncode == 0:
            git_status_available = True
            git_dirty = bool(str(result.stdout or "").strip())
    except Exception:
        pass
    source_hash = _file_sha256(Path(__file__).resolve())
    complete = bool(package_version and commit and _valid_hex(source_hash, 64) and git_status_available)
    return {
        "schema_version": 1,
        "build_channel": "source",
        "package_version": package_version,
        "git_commit": commit,
        "git_dirty": git_dirty,
        "git_status_available": git_status_available,
        "build_timestamp": None,
        "build_timestamp_utc": None,
        "source_path": "services/forecast_engine.py",
        "source_hash": source_hash,
        "artifact_compatibility_version": 1,
        "identity_status": "verified" if complete else "unverified",
        # A source checkout is useful for reproducible experiments, but it is
        # not a signed release artifact.  Only the build wrapper can mint a
        # promotion-eligible frozen identity after all release gates pass.
        "promotion_eligible": False,
    }

def _file_sha256(path: Path) -> str | None:
    try:
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()
    except Exception:
        return None

def build_nowcast_baseline_snapshot(persist: bool = True) -> dict:
    """Capture reproducible, credential-free nowcast comparison metadata."""
    identity = resolve_forecast_build_identity()
    commit = identity.get("git_commit")
    short_commit = commit[:7] if commit else "unknown"
    created_ts = int(time.time() * 1000)

    build_date = datetime.now(_TZ_UTC8).date()
    artifacts = load_forecast_artifacts(today=build_date) or {}
    artifact_valid, _artifact_reason = _validate_forecast_artifact(
        artifacts, target_date=build_date
    ) if artifacts else (False, "missing_artifact")
    artifact_schema_v2 = bool(
        artifact_valid and type(artifacts.get("schema_version")) is int
        and artifacts.get("schema_version") == 2
    )
    model_sha256 = _file_sha256(MODEL_BUNDLE_FILE)
    artifact_sha256 = _file_sha256(ARTIFACT_FILE) if ARTIFACT_FILE.exists() else None
    baseline_promotion_eligible = bool(
        identity.get("promotion_eligible") is True
        and model_sha256 and artifact_sha256 and artifact_schema_v2
    )
    reliability = {}
    if SOLCAST_RELIABILITY_FILE.exists():
        try:
            loaded = load(SOLCAST_RELIABILITY_FILE)
            reliability = loaded if isinstance(loaded, dict) else {}
        except Exception:
            reliability = {}
    regime_counts = {}
    for key, value in (reliability.get("regimes") or {}).items():
        if isinstance(value, dict):
            regime_counts[str(key)] = int(value.get("sample_count", value.get("days", 0)) or 0)

    snapshot = {
        "baseline_id": f"BL-{created_ts}-{short_commit}",
        "schema_version": 1,
        "created_ts": created_ts,
        "package_version": identity.get("package_version"),
        "git_commit": commit,
        "identity_status": identity.get("identity_status", "unverified"),
        "promotion_eligible": baseline_promotion_eligible,
        "git_dirty": identity.get("git_dirty", True),
        "git_status_available": identity.get("git_status_available", False),
        "build_timestamp": identity.get("build_timestamp"),
        "build_timestamp_utc": identity.get("build_timestamp_utc"),
        "source_hash": identity.get("source_hash"),
        "artifact_compatibility_version": identity.get("artifact_compatibility_version"),
        "model_bundle": {
            "path": str(MODEL_BUNDLE_FILE),
            "sha256": model_sha256,
            "feature_names": list(FEATURE_COLS),
            "feature_count": int(len(FEATURE_COLS)),
        },
        "forecast_artifact": {
            "path": str(ARTIFACT_FILE),
            "sha256": artifact_sha256,
            "schema_version": int(artifacts.get("schema_version", 1) or 1),
            "created_ts": artifacts.get("created_ts"),
            "lookback_days": artifacts.get("lookback_days"),
            "training_cutoff_date": artifacts.get("training_cutoff_date"),
            "promotion_eligible": artifact_schema_v2,
            "validation_error": _artifact_reason,
        },
        "settings": {
            "forecastIntradayBlendMax": _setting_float_or_none("forecastIntradayBlendMax", 0.0, 1.0),
            "forecastVirtualNowcastMode": _setting_string_or_default(
                "forecastVirtualNowcastMode", "off", set(NOWCAST_VALID_MODES)
            ),
        },
        "current_algorithm": {
            "min_obs_slots": INTRADAY_MIN_OBS_SLOTS,
            "max_obs_slots": INTRADAY_MAX_OBS_SLOTS,
            "ratio_clip": list(INTRADAY_RATIO_CLIP),
            "recent_ratio_clip": list(INTRADAY_RECENT_RATIO_CLIP),
            "blend_max": INTRADAY_BLEND_MAX,
        },
        "challenger": {
            "algorithm_version": NOWCAST_ALGORITHM_VERSION,
            "half_life_minutes": NOWCAST_HALF_LIFE_MINUTES,
            "recent_mix": NOWCAST_RECENT_MIX,
            "ratio_floor": NOWCAST_RATIO_FLOOR,
            "ratio_ceiling": NOWCAST_RATIO_CEILING,
            "min_capacity_coverage": NOWCAST_MIN_CAPACITY_COVERAGE,
        },
        "data_coverage": {
            "issue_time_weather_snapshot_days": len(list(FORECAST_SNAPSHOT_DIR.glob("*.json"))) if FORECAST_SNAPSHOT_DIR.exists() else 0,
            "solcast_regime_counts": regime_counts,
        },
        "provider_config": {
            "forecast_provider": _read_setting_value("forecastProvider"),
            "solcast_access_mode": _read_setting_value("solcastAccessMode"),
            "credentials_included": False,
        },
    }
    if persist:
        _save_json(FORECAST_BASELINE_SNAPSHOT_FILE, snapshot)
    return snapshot

def _series_to_full_array(series: list[dict] | None) -> np.ndarray | None:
    if not series:
        return None
    out = np.zeros(SLOTS_DAY, dtype=float)
    for idx, row in enumerate(series):
        slot = _parse_slot_from_time_text("2000-01-01", row.get("time") or row.get("time_hms"))
        if slot is None:
            slot = SOLAR_START_SLOT + idx
        if 0 <= int(slot) < SLOTS_DAY:
            out[int(slot)] = _coerce_non_negative_float(row.get("kWh_inc", row.get("kwh_inc", 0.0)))
    return out

def _score_nowcast_variant(
    forecast: np.ndarray,
    actual: np.ndarray,
    actual_present: np.ndarray,
    cutoff_slot: int,
    horizons_min: tuple[int, ...],
) -> dict:
    forecast_arr = np.asarray(forecast, dtype=float)
    actual_arr = np.asarray(actual, dtype=float)
    base_present = (
        np.asarray(actual_present, dtype=bool)
        & np.isfinite(actual_arr) & np.isfinite(forecast_arr)
        & (actual_arr >= 0.0) & (forecast_arr >= 0.0)
    )
    metrics: dict[str, float | int | str | None] = {"status": "scored"}
    for minutes in horizons_min:
        slots = max(1, int(math.ceil(int(minutes) / SLOT_MIN)))
        start = int(cutoff_slot) + 1
        end = min(SOLAR_END_SLOT, start + slots)
        mask = np.zeros(SLOTS_DAY, dtype=bool)
        if end > start:
            mask[start:end] = True
        support_slots = max(0, end - start)
        mask &= base_present
        scored_slots = int(np.count_nonzero(mask))
        metrics[f"support_slots_{minutes}m"] = int(support_slots)
        metrics[f"scored_slots_{minutes}m"] = scored_slots
        metrics[f"coverage_{minutes}m"] = (
            float(scored_slots / support_slots) if support_slots else 0.0
        )
        if not np.any(mask):
            metrics[f"mae_{minutes}m"] = None
            metrics[f"wape_{minutes}m"] = None
            metrics[f"rmse_{minutes}m"] = None
            continue
        err = forecast_arr[mask] - actual_arr[mask]
        metrics[f"mae_{minutes}m"] = float(np.mean(np.abs(err)))
        metrics[f"wape_{minutes}m"] = float(np.sum(np.abs(err)) / max(np.sum(actual[mask]), 0.1) * 100.0)
        metrics[f"rmse_{minutes}m"] = float(np.sqrt(np.mean(np.square(err))))
    remaining = (
        (np.arange(SLOTS_DAY) > int(cutoff_slot))
        & (np.arange(SLOTS_DAY) < SOLAR_END_SLOT)
        & base_present
    )
    metrics["remaining_day_support_slots"] = int(max(0, SOLAR_END_SLOT - int(cutoff_slot) - 1))
    metrics["remaining_day_scored_slots"] = int(np.count_nonzero(remaining))
    if np.any(remaining):
        actual_total = float(np.sum(actual[remaining]))
        forecast_total = float(np.sum(forecast[remaining]))
        metrics["remaining_day_actual_kwh"] = actual_total
        metrics["remaining_day_forecast_kwh"] = forecast_total
        metrics["remaining_day_total_ape_pct"] = float(abs(forecast_total - actual_total) / max(actual_total, 0.1) * 100.0)
    else:
        metrics["remaining_day_actual_kwh"] = None
        metrics["remaining_day_forecast_kwh"] = None
        metrics["remaining_day_total_ape_pct"] = None
    if not any(int(metrics.get(f"scored_slots_{minutes}m", 0) or 0) > 0 for minutes in horizons_min):
        metrics["status"] = "skipped_no_valid_slots"
    return metrics

def _build_replay_intraday_input_bundle(day_s: str, simulated_issue_ts: int) -> dict:
    immutable = _load_immutable_dayahead_bundle_from_db(day_s, simulated_issue_ts)
    if not immutable:
        raise ValueError(f"missing complete immutable replay basis for {day_s} before {simulated_issue_ts}")
    weather_frame = _weather_frame_from_issuance_snapshot(
        day_s, immutable.get("weather_snapshot") or {}
    )
    if weather_frame is None:
        raise ValueError(f"invalid issue-time weather snapshot for {day_s}")
    try:
        constraint_snapshot = immutable.get("constraint_snapshot") or {}
        parsed_constraints = _parse_replay_constraint_snapshot(constraint_snapshot)
        cap_dispatch = parsed_constraints["cap_dispatch_mask"]
        manual_constraint = parsed_constraints["manual_constraint_mask"]
        outage = parsed_constraints["outage_mask"]
        recorded_cap = parsed_constraints["slot_cap_kwh"]
        blend_max = parsed_constraints["blend_max"]
    except Exception as exc:
        raise ValueError(f"invalid issue-time constraint snapshot for {day_s}") from exc
    actual, actual_present = load_actual_loss_adjusted_with_presence(day_s, min_solar_slots=0)
    if actual is None or actual_present is None:
        raise ValueError(f"missing replay actuals for {day_s}")
    # Capacity reporting is observation evidence.  Future slots are explicitly
    # hidden so only rows visible at the simulated issue can influence quality.
    coverage = np.asarray(
        _load_energy_reporting_coverage(
            day_s,
            capacity_by_inverter_kw=parsed_constraints["reporting_capacity_kw"],
        ),
        dtype=float,
    ).reshape(-1)
    if coverage.size != SLOTS_DAY:
        coverage = np.zeros(SLOTS_DAY, dtype=float)
    issue_slot = int((int(simulated_issue_ts) - int(datetime.fromisoformat(day_s).replace(tzinfo=_TZ_UTC8).timestamp() * 1000)) // (SLOT_MIN * 60 * 1000)) - 1
    coverage[np.arange(SLOTS_DAY) > issue_slot] = 0.0
    export_basis = parsed_constraints["export_curtailment"]
    export_curtailment = _curtailed_mask_from_recorded_basis(
        np.asarray(actual, dtype=float),
        np.asarray(immutable["dayahead"], dtype=float),
        tolerance=export_basis["tolerance"],
        export_cap_slot_kwh=export_basis["export_cap_slot_kwh"],
        baseline_multiplier=export_basis["baseline_multiplier"],
    )
    return {
        "dayahead": np.asarray(immutable["dayahead"], dtype=float).copy(),
        "dayahead_lo": np.asarray(immutable["dayahead_lo"], dtype=float).copy(),
        "dayahead_hi": np.asarray(immutable["dayahead_hi"], dtype=float).copy(),
        "dayahead_present": np.asarray(immutable["dayahead_present"], dtype=bool).copy(),
        "actual": np.asarray(actual, dtype=float).copy(),
        "actual_present": np.asarray(actual_present, dtype=bool).copy(),
        "outage_mask": outage,
        "cap_dispatch_mask": cap_dispatch,
        "manual_constraint_mask": manual_constraint,
        "export_curtailment_mask": export_curtailment,
        "constraint_meta": {"source": "immutable_issue_time", **constraint_snapshot},
        "slot_cap_kwh": recorded_cap,
        "blend_max": blend_max,
        "capacity_coverage": coverage,
        "weather_frame": weather_frame.copy(deep=True),
        "replay_provenance": {
            key: immutable.get(key) for key in (
                "issuance_id", "generated_ts", "basis_checksum",
                "weather_snapshot_sha256", "constraint_snapshot_sha256",
                "model_sha256", "artifact_sha256", "base_run_audit_id", "created_by",
            )
        },
    }

def _load_nowcast_baseline_link() -> dict:
    if not FORECAST_BASELINE_SNAPSHOT_FILE.exists():
        return {"baseline_id": None, "baseline_sha256": None, "promotion_eligible": False}
    try:
        raw = FORECAST_BASELINE_SNAPSHOT_FILE.read_bytes()
        payload = json.loads(raw.decode("utf-8"))
        return {
            "baseline_id": payload.get("baseline_id"),
            "baseline_sha256": hashlib.sha256(raw).hexdigest(),
            "baseline_commit": payload.get("git_commit"),
            "promotion_eligible": bool(payload.get("promotion_eligible")),
        }
    except Exception:
        return {"baseline_id": None, "baseline_sha256": None, "promotion_eligible": False}

def replay_intraday_nowcast(
    target_date: date,
    simulated_cutoff_slot: int,
    challenger_algo: str = "robust_decay",
    persist: bool = False,
    horizons_min: tuple[int, ...] = NOWCAST_REPLAY_HORIZONS_MIN,
    variants: tuple[str, ...] | None = None,
) -> dict:
    """Replay historical issuance without writing live forecast or audit tables."""
    day_s = target_date.isoformat()
    cutoff = int(np.clip(int(simulated_cutoff_slot), SOLAR_START_SLOT, SOLAR_END_SLOT - 1))
    midnight_ts = int(datetime.combine(target_date, datetime.min.time(), _TZ_UTC8).timestamp() * 1000)
    simulated_issue_ts = midnight_ts + (cutoff + 1) * 300000

    replay_inputs = _build_replay_intraday_input_bundle(day_s, simulated_issue_ts)
    dayahead = replay_inputs["dayahead"]
    actual = replay_inputs["actual"]
    actual_present = replay_inputs["actual_present"]
    selected = tuple(variants or ("unchanged_dayahead", "current", challenger_algo))
    arrays: dict[str, np.ndarray] = {"unchanged_dayahead": np.asarray(dayahead, dtype=float).copy()}
    variant_meta: dict[str, dict] = {}
    if "current" in selected:
        current_series, current_meta = _build_current_intraday_adjusted_forecast(
            target_date, cutoff, input_bundle=replay_inputs
        )
        current_arr = _series_to_full_array(current_series)
        if current_arr is not None:
            arrays["current"] = current_arr
        variant_meta["current"] = current_meta
    if "robust_decay" in selected:
        robust_series, robust_meta = _build_robust_intraday_nowcast(
            target_date, cutoff, input_bundle=replay_inputs
        )
        robust_arr = _series_to_full_array(robust_series)
        if robust_arr is not None:
            arrays["robust_decay"] = robust_arr
        variant_meta["robust_decay"] = robust_meta

    actual_raw = np.asarray(actual, dtype=float)
    actual_arr = np.where(np.isfinite(actual_raw), actual_raw, 0.0)
    dayahead_arr = np.nan_to_num(np.asarray(dayahead, dtype=float), nan=0.0)
    outage_mask = np.asarray(replay_inputs.get("outage_mask", np.zeros(SLOTS_DAY)), dtype=bool)
    cap_dispatch_mask = np.asarray(replay_inputs.get("cap_dispatch_mask", np.zeros(SLOTS_DAY)), dtype=bool)
    manual_constraint_mask = np.asarray(replay_inputs.get("manual_constraint_mask", np.zeros(SLOTS_DAY)), dtype=bool)
    export_curtailed = np.asarray(replay_inputs.get("export_curtailment_mask", np.zeros(SLOTS_DAY)), dtype=bool)

    recorded_cap = float(replay_inputs["slot_cap_kwh"])
    present_arr = (
        np.asarray(actual_present, dtype=bool) & np.isfinite(actual_raw)
        & (actual_raw >= 0.0) & (actual_raw <= recorded_cap + 1e-9)
    )
    scoring_present = (
        present_arr & (~outage_mask) & (~cap_dispatch_mask)
        & (~manual_constraint_mask) & (~export_curtailed)
    )

    # Check if there's any valid scoring slots after the cutoff
    future_scoring = scoring_present[cutoff + 1:SOLAR_END_SLOT]
    if not np.any(future_scoring):
        return {"replay_id": str(uuid.uuid4()), "target_date": day_s, "simulated_cutoff_slot": cutoff, "status": "skipped_no_valid_future_slots"}

    scored = {}
    for name in selected:
        arr = arrays.get(name)
        if arr is None:
            meta = variant_meta.get(name, {})
            scored[name] = {
                "status": "skipped_builder",
                "skip_reason": meta.get("fallback_reason") or "builder_returned_no_series",
                **{f"scored_slots_{minutes}m": 0 for minutes in horizons_min},
            }
        else:
            scored[name] = _score_nowcast_variant(
                arr, actual_arr, scoring_present, cutoff, tuple(horizons_min)
            )
    baseline_metrics = scored.get("unchanged_dayahead", {})
    current_metrics = scored.get("current", {})
    for name, metrics in scored.items():
        for minutes in horizons_min:
            key = f"wape_{minutes}m"
            value = metrics.get(key)
            baseline_value = baseline_metrics.get(key)
            current_value = current_metrics.get(key)
            metrics[f"improvement_vs_dayahead_{minutes}m_pct"] = (
                float((baseline_value - value) / baseline_value * 100.0)
                if value is not None and baseline_value not in (None, 0) else None
            )
            metrics[f"improvement_vs_current_{minutes}m_pct"] = (
                float((current_value - value) / current_value * 100.0)
                if value is not None and current_value not in (None, 0) else None
            )

    robust_meta = variant_meta.get("robust_decay", {})
    baseline_link = _load_nowcast_baseline_link()
    replay_provenance = replay_inputs.get("replay_provenance") or {}
    result = {
        "schema_version": 1,
        "status": "complete",
        "replay_id": str(uuid.uuid4()),
        **baseline_link,
        "target_date": day_s,
        "simulated_cutoff_slot": cutoff,
        "algorithm_version": NOWCAST_ALGORITHM_VERSION,
        "variants": scored,
        "variant_meta": variant_meta,
        "actual_provenance": "pac_loss_adjusted",
        "constraint_masks": {
            "cap_dispatch_slots": int(robust_meta.get("excluded_cap_slots", 0) or 0),
            "outage_slots": int(robust_meta.get("excluded_outage_slots", 0) or 0),
            "curtailed_slots": int(robust_meta.get("excluded_curtailed_slots", 0) or 0),
        },
        "feature_versions": {
            "FEATURE_COLS_count": len(FEATURE_COLS),
            "artifact_sha256": replay_provenance.get("artifact_sha256"),
            "model_sha256": replay_provenance.get("model_sha256"),
        },
        "issue_time_basis": replay_provenance,
        "persisted_to_live_tables": False,
    }
    if persist:
        path = FORECAST_REPLAY_RESULTS_DIR / f"replay_{day_s}_{cutoff}.json"
        if not _save_json(path, result):
            raise OSError(f"failed to persist replay result: {path}")
        result["result_path"] = str(path)
    return result


def _build_replay_aggregate(
    results: list[dict],
    variants: tuple[str, ...],
    horizons: tuple[int, ...],
    *,
    skipped_runs: int = 0,
) -> dict:
    """Build paired, promotion-safe replay counts and metrics.

    One date with many cutoffs is one eligible day.  A run is eligible only
    when every requested builder scored every requested horizon and the
    remaining-day total; skipped builders can never inflate evidence.
    """
    def variant_eligible(result: dict, variant: str) -> bool:
        metrics = (result.get("variants") or {}).get(variant) or {}
        if metrics.get("status") != "scored":
            return False
        if metrics.get("remaining_day_total_ape_pct") is None:
            return False
        return all(
            int(metrics.get(f"scored_slots_{minutes}m", 0) or 0) > 0
            and metrics.get(f"wape_{minutes}m") is not None
            for minutes in horizons
        )

    per_variant_results = {
        variant: [result for result in results if variant_eligible(result, variant)]
        for variant in variants
    }
    paired = [
        result for result in results
        if all(variant_eligible(result, variant) for variant in variants)
    ]
    eligible_dates = sorted({str(result.get("target_date")) for result in paired})
    summary = {
        "schema_version": 2,
        "raw_completed_results": int(len(results)),
        "completed_runs": int(len(paired)),
        "eligible_runs": int(len(paired)),
        "eligible_days": int(len(eligible_dates)),
        "eligible_dates": eligible_dates,
        "skipped_runs": int(skipped_runs),
        "excluded_ineligible_runs": int(len(results) - len(paired)),
        "required_variants": list(variants),
        "required_horizons_min": [int(value) for value in horizons],
        "eligible_days_by_variant": {
            variant: len({str(result.get("target_date")) for result in rows})
            for variant, rows in per_variant_results.items()
        },
        "eligible_runs_by_variant": {
            variant: len(rows) for variant, rows in per_variant_results.items()
        },
        "metrics_by_variant": {},
    }
    for variant in variants:
        metrics: dict[str, float] = {}
        for minutes in horizons:
            weight_key = f"scored_slots_{minutes}m"
            for metric in ("wape", "mae", "rmse"):
                key = f"{metric}_{minutes}m"
                values_and_weights = [
                    (float(result["variants"][variant][key]), int(result["variants"][variant][weight_key]))
                    for result in paired
                    if result["variants"][variant].get(key) is not None
                    and int(result["variants"][variant].get(weight_key, 0) or 0) > 0
                ]
                if values_and_weights:
                    values = np.asarray([item[0] for item in values_and_weights], dtype=float)
                    weights = np.asarray([item[1] for item in values_and_weights], dtype=float)
                    metrics[f"weighted_{key}"] = float(np.average(values, weights=weights))
                    metrics[f"median_{key}"] = float(np.median(values))
        remaining = [
            float(result["variants"][variant]["remaining_day_total_ape_pct"])
            for result in paired
        ]
        if remaining:
            metrics["mean_remaining_day_total_ape_pct"] = float(np.mean(remaining))
            metrics["median_remaining_day_total_ape_pct"] = float(np.median(remaining))
        summary["metrics_by_variant"][variant] = metrics
    return summary

def parse_cli_args():
    parser = argparse.ArgumentParser(
        description="Inverter Dashboard Forecast Service - daemon mode or manual day-ahead generation",
    )
    parser.add_argument(
        "--generate-date",
        metavar="YYYY-MM-DD",
        help="Generate day-ahead for a single date and exit.",
    )
    parser.add_argument(
        "--generate-range",
        nargs=2,
        metavar=("START_YYYY-MM-DD", "END_YYYY-MM-DD"),
        help="Generate day-ahead for an inclusive date range and exit.",
    )
    parser.add_argument(
        "--generate-days",
        type=int,
        metavar="N",
        help="Generate day-ahead for N consecutive days starting tomorrow and exit.",
    )
    parser.add_argument(
        "--backtest-range",
        nargs=2,
        metavar=("START_YYYY-MM-DD", "END_YYYY-MM-DD"),
        help="Replay historical day-ahead forecasts over an inclusive date range using saved forecast weather snapshots.",
    )
    parser.add_argument(
        "--backtest-days",
        type=int,
        metavar="N",
        help="Replay historical day-ahead forecasts for the last N completed days using saved forecast weather snapshots.",
    )
    parser.add_argument(
        "--backfill-qa",
        type=int,
        nargs="?",
        const=15,
        metavar="DAYS",
        help="Re-run QA comparison for the last N days (default 15) to apply est_actual reconstruction.",
    )
    parser.add_argument(
        "--qa-today",
        action="store_true",
        help="Run QA evaluation for today's completed solar data (use after solar window closes).",
    )
    parser.add_argument(
        "--qa-date",
        type=str,
        metavar="YYYY-MM-DD",
        help="Re-run QA evaluation for a specific date (e.g. after substation meter data entry).",
    )
    parser.add_argument("--baseline-snapshot", action="store_true", help="Write a credential-free nowcast baseline snapshot and exit.")
    parser.add_argument("--replay", action="store_true", help="Run leakage-safe intraday replay and exit.")
    parser.add_argument("--from-date", type=str, metavar="YYYY-MM-DD", help="Replay range start date.")
    parser.add_argument("--to-date", type=str, metavar="YYYY-MM-DD", help="Replay range end date.")
    parser.add_argument("--horizons", default="5,15,30,60,120", help="Comma-separated replay horizons in minutes.")
    parser.add_argument("--variants", default="unchanged_dayahead,current,robust_decay", help="Comma-separated replay variants.")
    parser.add_argument("--dry-run", action="store_true", help="Evaluate without persisting experiment/artifact output.")
    parser.add_argument("--rebuild-forecast-artifacts", action="store_true", help="Rebuild schema-v2 activity artifacts and exit.")
    parser.add_argument("--lookback-days", type=int, default=SHAPE_LOOKBACK_DAYS, help="Artifact rebuild lookback days.")
    return parser.parse_args()

def run_cli_generation(args) -> int:
    try:
        if (
            args.generate_date
            or args.generate_range
            or args.generate_days is not None
            or args.replay
            or args.rebuild_forecast_artifacts
        ) and _read_operation_mode() == "remote":
            log.error("Forecast generation, replay, and artifact rebuild are disabled in remote mode")
            return 2

        if args.baseline_snapshot:
            snapshot = build_nowcast_baseline_snapshot(persist=not args.dry_run)
            log.info(
                "Nowcast baseline captured: version=%s commit=%s features=%d output=%s",
                snapshot.get("package_version"), snapshot.get("git_commit"),
                len(snapshot.get("model_bundle", {}).get("feature_names", [])),
                "dry-run" if args.dry_run else FORECAST_BASELINE_SNAPSHOT_FILE,
            )
            return 0

        if args.replay:
            if not args.from_date or not args.to_date:
                raise ValueError("--replay requires --from-date and --to-date")
            start_d = _parse_iso_date_safe(args.from_date)
            end_d = _parse_iso_date_safe(args.to_date)
            horizons = tuple(sorted({int(v.strip()) for v in str(args.horizons).split(",") if v.strip()}))
            if not horizons or any(v <= 0 for v in horizons):
                raise ValueError("--horizons must contain positive minute values")
            variants = tuple(dict.fromkeys(v.strip() for v in str(args.variants).split(",") if v.strip()))
            allowed_variants = {"unchanged_dayahead", "current", "robust_decay"}
            unknown = set(variants) - allowed_variants
            if unknown:
                raise ValueError(f"unimplemented replay variants: {sorted(unknown)}")
            completed = 0
            skipped = 0
            persistence_failed = False
            all_results = []
            for replay_day in _iter_days(start_d, end_d):
                # Hourly issuance points after the six-slot activation floor.
                first_cutoff = SOLAR_START_SLOT + INTRADAY_MIN_OBS_SLOTS - 1
                for cutoff in range(first_cutoff, SOLAR_END_SLOT - 1, 12):
                    try:
                        res = replay_intraday_nowcast(
                            replay_day, cutoff, persist=not args.dry_run,
                            horizons_min=horizons, variants=variants,
                        )
                        if res.get("status") == "skipped_no_valid_future_slots":
                            skipped += 1
                        else:
                            all_results.append(res)
                            completed += 1
                    except ValueError as exc:
                        skipped += 1
                        log.debug("Replay skipped %s cutoff=%d: %s", replay_day, cutoff, exc)
                    except OSError as exc:
                        skipped += 1
                        persistence_failed = True
                        log.error("Replay persistence failed %s cutoff=%d: %s", replay_day, cutoff, exc)

            summary = _build_replay_aggregate(
                all_results, variants, horizons, skipped_runs=skipped
            )
            if summary["eligible_runs"] > 0 and not args.dry_run:
                report_path = FORECAST_REPLAY_RESULTS_DIR / f"aggregate_report_{start_d}_{end_d}.json"
                if not _save_json(report_path, summary):
                    persistence_failed = True
                    log.error("Aggregate replay report persistence failed: %s", report_path)
                else:
                    log.info("Aggregate report saved to %s", report_path)

            log.info(
                "Intraday replay complete: raw=%d eligible_runs=%d eligible_days=%d skipped=%d",
                completed, summary["eligible_runs"], summary["eligible_days"], skipped,
            )
            return 0 if summary["eligible_runs"] > 0 and not persistence_failed else 2

        if args.rebuild_forecast_artifacts:
            lookback = max(1, min(365, int(args.lookback_days)))
            target = datetime.now(_TZ_UTC8).date()
            if not _dayahead_gen_lock_acquire(target, owner="artifact_rebuild_cli"):
                return 2
            try:
                reliability = build_solcast_reliability_artifact(target)
                history = collect_history_days(target, lookback, solcast_reliability=reliability)
                artifact = build_forecast_artifacts(history)
                log.info(
                    "Artifact-v2 coverage: history=%d accepted=%d rejected=%d",
                    int(artifact.get("history_days", 0)), int(artifact.get("accepted_days", 0)),
                    int(artifact.get("rejected_days", 0)),
                )
                if not args.dry_run and not save_forecast_artifacts(artifact):
                    return 2
                return 0
            finally:
                _dayahead_gen_lock_release(target)

        if args.generate_date:
            day = _parse_iso_date_safe(args.generate_date)
            ok = run_manual_generation([day])
            return 0 if ok else 2

        if args.generate_range:
            start_s, end_s = args.generate_range
            start_d = _parse_iso_date_safe(start_s)
            end_d = _parse_iso_date_safe(end_s)
            days = _iter_days(start_d, end_d)
            ok = run_manual_generation(days)
            return 0 if ok else 2

        if args.generate_days is not None:
            count = int(args.generate_days)
            if count < 1:
                raise ValueError("--generate-days must be >= 1")
            start_d = datetime.now().date() + timedelta(days=1)
            days = [start_d + timedelta(days=i) for i in range(count)]
            ok = run_manual_generation(days)
            return 0 if ok else 2

        if args.backtest_range:
            start_s, end_s = args.backtest_range
            start_d = _parse_iso_date_safe(start_s)
            end_d = _parse_iso_date_safe(end_s)
            days = _iter_days(start_d, end_d)
            ok = run_backtest(days)
            return 0 if ok else 2

        if args.backtest_days is not None:
            count = int(args.backtest_days)
            if count < 1:
                raise ValueError("--backtest-days must be >= 1")
            end_d = datetime.now().date() - timedelta(days=1)
            start_d = end_d - timedelta(days=count - 1)
            days = _iter_days(start_d, end_d)
            ok = run_backtest(days)
            return 0 if ok else 2

        if args.qa_today:
            # Evaluate today's solar data right after solar window closes.
            # forecast_qa(ref) processes ref-1, so pass tomorrow to process today.
            tomorrow_ref = datetime.now(_TZ_UTC8).date() + timedelta(days=1)
            log.info("QA-today: evaluating %s", (tomorrow_ref - timedelta(days=1)).isoformat())
            forecast_qa(tomorrow_ref)
            return 0

        if args.qa_date:
            target = _parse_iso_date_safe(args.qa_date)
            ref_today = target + timedelta(days=1)
            log.info("QA-date: evaluating %s", target.isoformat())
            forecast_qa(ref_today)
            return 0

        if args.backfill_qa is not None:
            n = backfill_qa_comparisons(args.backfill_qa)
            log.info("QA backfill complete: %d dates reprocessed", n)
            return 0

        return -1  # no CLI generation mode requested
    except Exception as e:
        log.error("Manual generation argument error: %s", e)
        return 2

# ============================================================================
# MAIN SERVICE LOOP
# ============================================================================

@lru_cache(maxsize=64)
def _read_setting_value(key: str) -> str | None:
    """Read a setting value from the settings table, returning None if absent."""
    if not APP_DB_FILE.exists():
        return None
    # v2.8 SQLite audit M1: use `with` for automatic cleanup, matching
    # the 24 other read call sites in this module.
    try:
        with _open_sqlite(APP_DB_FILE, SQLITE_READ_TIMEOUT_SEC, readonly=True) as conn:
            row = conn.execute(
                "SELECT value FROM settings WHERE key = ? LIMIT 1",
                (str(key),),
            ).fetchone()
    except Exception:
        return None
    if not row or row[0] is None:
        return None
    value = str(row[0]).strip()
    return value or None

# Operator-tunable forecast knobs (option A, 2026-05-30). Read FRESH from the
# settings table (NOT via the process-cached _read_setting_value) so a change
# takes effect on the next forecast cycle without restarting the service. Each
# returns None when unset/blank/invalid — callers then keep the engine default,
# guaranteeing identical behavior until the operator opts in.
def _setting_float_or_none(key: str, lo: float, hi: float) -> float | None:
    try:
        if not APP_DB_FILE.exists():
            return None
        with _open_sqlite(APP_DB_FILE, SQLITE_READ_TIMEOUT_SEC, readonly=True) as conn:
            row = conn.execute(
                "SELECT value FROM settings WHERE key = ? LIMIT 1", (str(key),)
            ).fetchone()
    except Exception:
        return None
    if not row or row[0] is None:
        return None
    raw = str(row[0]).strip()
    if not raw:
        return None
    try:
        val = float(raw)
    except (TypeError, ValueError):
        log.warning("Invalid forecast tunable %s=%r - ignoring (using engine default)", key, raw)
        return None
    if not np.isfinite(val):
        return None
    return float(np.clip(val, lo, hi))

def _setting_bool_or_default(key: str, default: bool) -> bool:
    """Read a boolean forecast tunable fresh from the settings table.

    Returns ``default`` when unset/blank/unreadable. Truthy: 1/true/yes/on;
    falsy: 0/false/no/off (case-insensitive); anything else -> ``default``."""
    try:
        if not APP_DB_FILE.exists():
            return default
        with _open_sqlite(APP_DB_FILE, SQLITE_READ_TIMEOUT_SEC, readonly=True) as conn:
            row = conn.execute(
                "SELECT value FROM settings WHERE key = ? LIMIT 1", (str(key),)
            ).fetchone()
    except Exception:
        return default
    if not row or row[0] is None:
        return default
    raw = str(row[0]).strip().lower()
    if raw in ('1', 'true', 'yes', 'on'):
        return True
    if raw in ('0', 'false', 'no', 'off'):
        return False
    return default

_INVALID_STRING_SETTING_WARNED: set[tuple[str, str]] = set()

def _setting_string_or_default(key: str, default: str, valid: set[str]) -> str:
    """Read a string setting fresh; invalid values safely resolve to default."""
    try:
        if not APP_DB_FILE.exists():
            return str(default)
        with _open_sqlite(APP_DB_FILE, SQLITE_READ_TIMEOUT_SEC, readonly=True) as conn:
            row = conn.execute(
                "SELECT value FROM settings WHERE key = ? LIMIT 1", (str(key),)
            ).fetchone()
    except Exception:
        return str(default)
    raw = str(row[0]).strip().lower() if row and row[0] is not None else ""
    if not raw:
        return str(default)
    allowed = {str(v).strip().lower() for v in valid}
    if raw in allowed:
        return raw
    marker = (str(key), raw)
    if marker not in _INVALID_STRING_SETTING_WARNED:
        _INVALID_STRING_SETTING_WARNED.add(marker)
        log.warning("Invalid forecast setting %s=%r - using %r", key, raw, default)
    return str(default)

@lru_cache(maxsize=1)
def load_forecast_export_limit_mw() -> float:
    raw = _read_setting_value(FORECAST_EXPORT_LIMIT_SETTING_KEY)
    if raw is None:
        return float(EXPORT_MW)
    try:
        value = float(raw)
    except (TypeError, ValueError):
        log.warning(
            "Invalid %s setting %r - using fallback %.1f MW",
            FORECAST_EXPORT_LIMIT_SETTING_KEY,
            raw,
            EXPORT_MW,
        )
        return float(EXPORT_MW)
    if not np.isfinite(value) or value <= 0.0:
        log.warning(
            "Non-positive %s setting %r - using fallback %.1f MW",
            FORECAST_EXPORT_LIMIT_SETTING_KEY,
            raw,
            EXPORT_MW,
        )
        return float(EXPORT_MW)
    return float(value)

def _read_operation_mode() -> str:
    """Read operationMode from the settings table. Returns 'gateway' or 'remote'."""
    try:
        value = str(_read_setting_value("operationMode") or "gateway").strip().lower()
        return "remote" if value == "remote" else "gateway"
    except Exception:
        return "gateway"

def _register_forecast_failure(
    consecutive_failures: int,
    monotonic_now: float,
    base_backoff_sec: int,
) -> tuple[int, float, int]:
    next_failures = max(0, int(consecutive_failures)) + 1
    backoff = min(
        int(base_backoff_sec) * (2 ** min(next_failures - 1, 3)),
        1800,
    )
    return next_failures, float(monotonic_now) + float(backoff), int(backoff)

def _resolve_service_target_date(today: date, now_h: int, da_today_in_db: bool) -> date:
    """
    Resolve the day-ahead target for the main service loop.

    Before sunrise, the upcoming solar window is today. During daylight hours,
    a missing day-ahead for today takes priority over generating tomorrow.
    Otherwise, target tomorrow.
    """
    hour = int(now_h)
    if hour < SOLAR_START_H:
        return today
    if (SOLAR_START_H <= hour < SOLAR_END_H) and (not da_today_in_db):
        return today
    return today + timedelta(days=1)

def _dayahead_gen_lock_path(target_date) -> "Path":
    """Return the advisory lock path for a target date (see T4.4)."""
    day_s = target_date.isoformat() if hasattr(target_date, "isoformat") else str(target_date)
    return DAYAHEAD_GEN_LOCK_DIR / f"dayahead_{day_s}.lock"

def _dayahead_gen_lock_acquire(target_date, owner: str) -> bool:
    """T4.4 fix: acquire an advisory generation lock for target_date.

    Returns True if acquired (no fresh lock, or prior lock is stale).
    Returns False if a fresh lock by another owner is present — caller
    should skip to avoid writing duplicate forecast_run_audit rows.
    """
    lock_path = _dayahead_gen_lock_path(target_date)
    try:
        if lock_path.exists():
            age = time.time() - lock_path.stat().st_mtime
            if age < DAYAHEAD_GEN_LOCK_MAX_AGE_SEC:
                try:
                    prior = lock_path.read_text(encoding="utf-8").strip()
                except Exception:
                    prior = "<unreadable>"
                log.warning(
                    "Day-ahead gen lock busy for %s (owner=%s, age=%.0fs) — caller=%s skipping.",
                    target_date, prior, age, owner,
                )
                return False
            log.info(
                "Day-ahead gen lock for %s is stale (%.0fs old) — force-acquiring for %s.",
                target_date, age, owner,
            )
        lock_path.write_text(
            f"{owner} pid={os.getpid()} ts={int(time.time())}",
            encoding="utf-8",
        )
        return True
    except Exception as e:
        log.warning("Could not acquire day-ahead gen lock for %s: %s (proceeding without lock)", target_date, e)
        return True

def _dayahead_gen_lock_release(target_date) -> None:
    try:
        _dayahead_gen_lock_path(target_date).unlink(missing_ok=True)
    except Exception:
        pass

def _delegate_run_dayahead(target_date: date, trigger: str = "auto_service") -> dict | None:
    """Delegate day-ahead generation to the Node.js orchestrator.

    Returns the full response dict on success, or None on failure.
    Python truthiness is preserved: dict is truthy, None is falsy.
    """
    port = os.getenv("ADSI_SERVER_PORT", "3500")
    url = f"http://127.0.0.1:{port}/api/internal/forecast/generate-auto"
    target_s = target_date.isoformat()
    log.info("Delegating day-ahead generation for %s to Node.js orchestrator at %s (trigger=%s)", target_s, url, trigger)
    # T4.4 fix (Phase 2, 2026-04-14): DO NOT acquire the advisory lock before
    # delegating.  The Node orchestrator acquires the same file-lock itself
    # (see server/forecastGenLock.js), so if Python held it here Node would
    # see "busy" and refuse every delegation call — a self-deadlock.
    #
    # Correct ownership:
    #   - Node owns the lock while it runs the orchestrator.
    #   - If Python's HTTP call times out but Node is still working, Node
    #     keeps holding the lock; any Python direct-fallback path
    #     (_run_dayahead_direct_fallback, recovery fallback) will then see
    #     the lock as BUSY and skip, preventing duplicate audit rows.
    #   - If Node is unreachable at all, no lock is ever created by Node,
    #     and the direct-fallback path acquires its own lock there.
    try:
        resp = requests.post(url, json={
            "dates": [target_s],
            "trigger": trigger,
        }, timeout=180)
        resp.raise_for_status()
        data = resp.json()
        if not data.get("ok"):
            log.error("Node.js orchestrator returned error: %s", data.get("error"))
            return None
        log.info(
            "Delegation success for %s: provider_used=%s variant=%s freshness=%s total=%.1f kWh",
            target_s,
            data.get("provider_used", "?"),
            data.get("variant", "?"),
            data.get("freshness", "?"),
            float(data.get("total_kwh", 0) or 0),
        )
        return data
    except Exception as e:
        log.error("Failed to delegate generation to Node.js: %s", e)
        return None

def main() -> None:
    _clear_service_stop_file()
    profile = plant_capacity_profile()
    cap_dep = float(profile["dependable_kw"])
    cap_max = float(profile["max_kw"])

    log.info("=" * 70)
    log.info("Inverter Dashboard - Day-Ahead Forecast Service  v3.0")
    log.info("Site          : Configured  (%.6f N  %.6f E)", LAT_DEG, LON_DEG)
    log.info("Inverters     : %.2f kW max / %.2f kW dependable each", UNIT_KW_MAX, UNIT_KW_DEPENDABLE)
    log.info(
        "Configured    : %d inverter rows  |  enabled nodes=%d  (loss-adj nodes=%.3f)",
        profile["configured_inverters"],
        profile["enabled_nodes"],
        profile["loss_adjusted_nodes"],
    )
    log.info(
        "IPConfig      : source=%s  path=%s",
        profile.get("ipconfig_source", profile.get("source", "unknown")),
        profile.get("ipconfig_path", IPCONFIG_FILE),
    )
    log.info("Plant Capacity: %.3f MW dep  /  %.3f MW max", cap_dep / 1000.0, cap_max / 1000.0)
    log.info("Slot Cap      : dep=%.4f MWh  max=%.4f MWh per 5-min", slot_cap_kwh(True) / 1000.0, slot_cap_kwh(False) / 1000.0)
    log.info(
        "Export Limit  : %.2f MW  (%s, dispatch only - not applied to forecast curve)",
        load_forecast_export_limit_mw(),
        FORECAST_EXPORT_LIMIT_SETTING_KEY,
    )
    log.info("Train Window  : %d days  (min %d)", N_TRAIN_DAYS, MIN_TRAIN_DAYS)
    log.info("Actual Source : AppData energy_5min (hot + archive), legacy JSON fallback only")
    log.info("ML backend    : %s", "LightGBM" if (FORECAST_USE_LIGHTGBM and _LIGHTGBM_AVAILABLE) else "sklearn GBR")
    log.info("=" * 70)

    # Persist ml_backend_type at startup so UI chip works before first training run
    try:
        _su_state = _load_json(ML_TRAIN_STATE_FILE)
        _su_state["ml_backend_type"] = _detect_ml_backend()
        _su_state["ml_backend_detail"] = _detect_ml_backend_detail()
        _su_mf = MODEL_BUNDLE_FILE if MODEL_BUNDLE_FILE.exists() else (MODEL_FILE if MODEL_FILE.exists() else None)
        if _su_mf:
            _su_state["model_file_path"] = str(_su_mf)
            _su_state["model_file_mtime_ms"] = int(_su_mf.stat().st_mtime * 1000)
        _save_json(ML_TRAIN_STATE_FILE, _su_state)
    except Exception as _su_err:
        log.warning("Startup: could not persist ml_backend_type to train state: %s", _su_err)

    last_run_hour = -1   # track which hour we last ran in
    last_intraday_slot_key = ""
    completed_shadow_score_days: set[str] = set()
    next_shadow_score_retry_monotonic = 0.0
    _fail_cooldown_until = 0.0       # monotonic time until retry is allowed
    _FAIL_COOLDOWN_BASE = 300        # 5 min base backoff after a failed attempt
    _consecutive_failures = 0

    while True:
        try:
            if _service_stop_requested():
                raise KeyboardInterrupt
            # Viewer model: skip all forecast generation in remote mode.
            if _read_operation_mode() == "remote":
                log.debug("Remote mode - skipping forecast generation (viewer model)")
                _sleep_with_service_stop(60)
                continue

            now        = datetime.now()
            today      = now.date()
            today_s    = today.isoformat()
            now_h      = now.hour
            mono_now   = time.monotonic()

            # Score yesterday's exact stored shadow checkpoints once per
            # service day.  The scorer never regenerates a forecast and is
            # therefore safe to run independently of today's rollout mode.
            if now_h >= 1 and mono_now >= next_shadow_score_retry_monotonic:
                next_shadow_score_retry_monotonic = mono_now + 15 * 60
                try:
                    for score_result in _score_shadow_checkpoint_backlog(
                        today, completed_shadow_score_days
                    ):
                        log.info(
                            "Completed shadow scoring [%s]: status=%s scored=%d skipped=%d",
                            score_result.get("target_date"),
                            score_result.get("status"),
                            int(score_result.get("audits_scored", 0) or 0),
                            int(score_result.get("audits_skipped", 0) or 0),
                        )
                except Exception as score_exc:
                    log.warning("Completed shadow backlog scoring crashed: %s", score_exc)

            da_today_in_db = _has_forecast_dayahead_in_db(today_s)
            target     = _resolve_service_target_date(today, now_h, da_today_in_db)
            target_s   = target.isoformat()
            da_target_in_db = _has_forecast_dayahead_in_db(target_s)

            # """ Decide whether to run a forecast this loop """""""""""""""
            #
            # Run conditions (any one sufficient):
            #   A) Primary scheduled hour (DA_RUN_HOURS_PRIMARY) and we have not
            #      run this hour yet
            #   B) Outside-solar target missing from DB:
            #      today before sunrise, tomorrow after sunset
            #   C) Today's forecast is missing and we are inside solar hours
            #      (morning recovery)

            run_scheduled = (now_h in DA_RUN_HOURS_PRIMARY) and (last_run_hour != now_h)
            # Outside-solar constant checker:
            #   00:00-04:59 -> ensure today's solar-window forecast exists
            #   18:00-23:59 -> ensure tomorrow's solar-window forecast exists
            outside_solar = (now_h >= SOLAR_END_H) or (now_h < SOLAR_START_H)
            run_postsolar = outside_solar and (not da_target_in_db)
            run_recovery  = (SOLAR_START_H <= now_h < SOLAR_END_H) and (not da_today_in_db)

            # Respect failure cooldown for post-solar retries.
            # Primary scheduled runs always bypass the cooldown.
            if not run_scheduled and run_postsolar and mono_now < _fail_cooldown_until:
                log.debug(
                    "Target missing but in failure cooldown (%.0fs remaining)",
                    _fail_cooldown_until - mono_now,
                )
                run_postsolar = False

            if run_scheduled or run_postsolar:
                log.info(
                    "Run trigger: target=%s scheduled=%s postsolar_check=%s failures=%d",
                    target_s,
                    run_scheduled,
                    run_postsolar,
                    _consecutive_failures,
                )
                clear_forecast_data_cache()
                if _service_stop_requested():
                    raise KeyboardInterrupt

                try:
                    # (Re)train model before forecast
                    trained = train_model(today)
                    if _service_stop_requested():
                        raise KeyboardInterrupt
                    if not trained:
                        log.warning("Model training skipped - will use existing model or physics")

                    # Forecast quality audit of yesterday
                    forecast_qa(today)
                    if _service_stop_requested():
                        raise KeyboardInterrupt

                    # Generate the resolved target day-ahead
                    ok = _delegate_run_dayahead(target)
                    if not ok:
                        log.warning("Node delegation failed in auto loop - attempting direct Python fallback for %s", target_s)
                        # T4.4 fix: acquire advisory lock before direct fallback.
                        _acquired = _dayahead_gen_lock_acquire(target, owner="auto_service_fallback")
                        try:
                            if not _acquired:
                                log.warning(
                                    "Auto loop fallback skipped for %s — generation lock held by another process.",
                                    target_s,
                                )
                            else:
                                _direct_result = run_dayahead(target, today, write_audit=True, audit_generator_mode="auto_service_fallback")
                                if _direct_result:
                                    log.info("Auto loop Python fallback generation succeeded for %s", target_s)
                                    ok = True
                                else:
                                    log.error("Auto loop Python fallback generation also failed for %s", target_s)
                        except Exception as _fb_exc:
                            log.error("Auto loop Python fallback raised: %s", _fb_exc)
                        finally:
                            if _acquired:
                                _dayahead_gen_lock_release(target)
                except Exception:
                    _consecutive_failures, _fail_cooldown_until, backoff = _register_forecast_failure(
                        _consecutive_failures,
                        time.monotonic(),
                        _FAIL_COOLDOWN_BASE,
                    )
                    log.error(
                        "Day-ahead for %s crashed (attempt %d, cooldown %ds)",
                        target_s, _consecutive_failures, backoff,
                        exc_info=True,
                    )
                else:
                    if ok:
                        last_run_hour = now_h
                        _consecutive_failures = 0
                        _fail_cooldown_until = 0.0
                        log.info("Day-ahead for %s completed successfully", target_s)
                    else:
                        _consecutive_failures, _fail_cooldown_until, backoff = _register_forecast_failure(
                            _consecutive_failures,
                            time.monotonic(),
                            _FAIL_COOLDOWN_BASE,
                        )
                        log.error(
                            "Day-ahead for %s FAILED (attempt %d, cooldown %ds)",
                            target_s, _consecutive_failures, backoff,
                        )

            elif run_recovery:
                log.warning("Recovery: today %s missing day-ahead - generating now", today_s)
                clear_forecast_data_cache()
                if _service_stop_requested():
                    raise KeyboardInterrupt
                try:
                    ok = _delegate_run_dayahead(today)
                    if not ok:
                        log.warning("Node delegation failed in recovery - attempting direct Python fallback for %s", today_s)
                        # T4.4 fix: advisory lock on recovery fallback too.
                        _acquired = _dayahead_gen_lock_acquire(today, owner="auto_recovery_fallback")
                        try:
                            if not _acquired:
                                log.warning(
                                    "Recovery fallback skipped for %s — generation lock held by another process.",
                                    today_s,
                                )
                            else:
                                _direct_result = run_dayahead(today, today, write_audit=True, audit_generator_mode="auto_service_fallback")
                                if _direct_result:
                                    log.info("Recovery Python fallback generation succeeded for %s", today_s)
                                    ok = True
                                else:
                                    log.error("Recovery Python fallback generation also failed for %s", today_s)
                        except Exception as _fb_exc:
                            log.error("Recovery Python fallback raised: %s", _fb_exc)
                        finally:
                            if _acquired:
                                _dayahead_gen_lock_release(today)
                except Exception:
                    log.error("Recovery day-ahead for %s crashed", today_s, exc_info=True)
                else:
                    if ok:
                        log.info("Recovery day-ahead for %s completed successfully", today_s)
                        clear_forecast_data_cache()
                        run_intraday_adjusted(today)
                    else:
                        log.error("Recovery day-ahead for %s FAILED", today_s)

            else:
                if outside_solar and da_target_in_db:
                    log.debug("Outside-solar check: day-ahead for %s exists - OK", target_s)
                else:
                    log.debug("No forecast action needed (hour=%02d)", now_h)

            if SOLAR_START_H <= now_h < SOLAR_END_H:
                slot_idx = int((now_h * 60 + now.minute) // SLOT_MIN)
                intraday_slot_key = f"{today_s}:{slot_idx:03d}"
                if intraday_slot_key != last_intraday_slot_key:
                    if _service_stop_requested():
                        raise KeyboardInterrupt
                    clear_forecast_data_cache()
                    run_intraday_adjusted(today)
                    last_intraday_slot_key = intraday_slot_key

            _sleep_with_service_stop(60)   # check every minute

        except KeyboardInterrupt:
            log.info("Shutdown requested - exiting")
            break
        except Exception:
            log.critical("Unhandled exception in main loop", exc_info=True)
            try:
                _sleep_with_service_stop(60)
            except KeyboardInterrupt:
                log.info("Shutdown requested  exiting")
                break

    _clear_service_stop_file()

if __name__ == "__main__":
    args = parse_cli_args()
    code = run_cli_generation(args)
    if code >= 0:
        sys.exit(code)
    main()
