# Alarm Logging Integrity & Verification Record

## Overview & Scope
This record documents the diagnosis, root cause analysis, architecture invariants, and database reconciliation for alarm logging across the ADSI Inverter Dashboard.

## 1. Discrepancy Analysis & Findings

### Discrepancy A: Negative Duration (`cleared_ts < ts`)
- **Symptom:** Historical alarms occasionally recorded `cleared_ts < ts`, resulting in raw negative durations in milliseconds (`-758 ms`, `-1173 ms`), and causing the cleared time to display a timestamp earlier than the alarm occurrence timestamp.
- **Root Cause:** In `server/db.js` and `backend/services/db.js`, `clearAlarm` previously executed:
  ```sql
  UPDATE alarms SET cleared_ts=? WHERE inverter=? AND unit=? AND cleared_ts IS NULL
  ```
  When poll frames were ingested with millisecond frame timestamps (`row.ts`), slight clock jitter, network batch delivery skew, or inter-thread latency allowed an incoming clearing frame timestamp (`evTs`) to be slightly smaller than the alarm insertion timestamp (`ts`).
- **Resolution:**
  1. Enforced `cleared_ts = MAX(ts, ?)` directly in `stmts.clearAlarm` in both `server/db.js` and `backend/services/db.js`.
  2. Clamped `safeTs = Math.max(Number(existing?.ts) || 0, Number(evTsNum) || 0)` in `_closeAndReopenAlarmTx` and in `checkAlarms`.
  3. Added boot-time database repair migration:
     ```sql
     UPDATE alarms SET cleared_ts = ts, updated_ts = NOW_MS WHERE cleared_ts IS NOT NULL AND cleared_ts < ts;
     ```
  4. Updated client-side `duration_min` in `public/js/app.js` and `frontend/public/js/app.js` to enforce `Math.max(0, ts2 - ts1)`.

### Discrepancy B: Orphaned Open Alarms on Disabled/Unconfigured Nodes
- **Symptom:** Exactly 8 alarms in `adsi.db` remained permanently in `ACTIVE` state (`cleared_ts IS NULL`) dating back to May, June, August, and October 2026, displaying ongoing durations of up to 160+ days ($>3,800\text{ hours}$):
  - Inverter 18, Unit 1 (`id 14678`, started 2026-05-06)
  - Inverter 9, Unit 3 (`id 16715`, started 2026-05-11)
  - Inverter 12, Unit 1 (`id 26689`, started 2026-06-04)
  - Inverter 19, Units 1–4 (`id 45265, 45297, 45298, 45299`, started 2026-08-07)
  - Inverter 27, Unit 1 (`id 67109`, started 2026-10-15)
- **Root Cause:** Every one of these nodes was intentionally disabled in `ipconfig.json` (`units`). When a node was removed from configuration:
  1. `checkAlarms` pruned the node from the in-memory `activeAlarmState` map, but never updated the database row in `alarms`.
  2. Because the node was disabled, the poller never polled it, meaning no frame with `cur === 0` was ever received.
  3. Consequently, the active row in `alarms` was never closed and remained `cleared_ts IS NULL` indefinitely.
- **Resolution:**
  1. Created `closeOrphanedUnconfiguredAlarms()` in `server/alarms.js` and `backend/services/alarms.js` that checks for active alarms belonging to nodes not in `getConfiguredNodeSet()` and closes them at the node's final reading timestamp (or `ts`).
  2. In `checkAlarms(batch)`, when unconfigured nodes are pruned from in-memory state, any active alarm row for that node is immediately closed in the database.
  3. Reconciled historical database records on `adsi-server` using exact final telemetry timestamps:
     - `id 67109` (Inv 27 U1): closed at `1792030414092` (2026-10-15 02:13:34 UTC)
     - `id 14678` (Inv 18 U1): closed at `1778029432227` (2026-05-06 01:03:52 UTC)
     - `id 16715` (Inv 9 U3): closed at `1778486069806` (2026-05-11 07:54:29 UTC)
     - `id 26689` (Inv 12 U1): closed at `1780553170856` (2026-06-04 06:06:10 UTC)
     - `id 45265` (Inv 19 U1): closed at `1786075794999` (2026-08-07 04:09:54 UTC)
     - `id 45297` (Inv 19 U2): closed at `1786075841066` (2026-08-07 04:10:41 UTC)
     - `id 45298` (Inv 19 U3): closed at `1786075840066` (2026-08-07 04:10:40 UTC)
     - `id 45299` (Inv 19 U4): closed at `1786075840915` (2026-08-07 04:10:40 UTC)

## 2. Invariants Locked
1. **Mathematical Monotonicity:** `cleared_ts >= ts` is enforced at both SQL statement level and JavaScript application level.
2. **Configuration Integrity:** Removing or disabling an inverter node in `ipconfig.json.units` atomically closes any open alarms for that node.
3. **Audit Truthfulness:** Historical timestamps match the physical readings recorded by the telemetry poller.

## 3. Verification Evidence
- `alarmDiscrepancyIntegrity.test.js`: All 7 assertions PASS.
- Full smoke test suite (`scripts/smoke-all.js`): 120/120 Node tests PASS.
- Production `adsi.db` verification query:
  - `negative_dur_count`: **0**
  - `open_alarms_count`: **0** (matches all currently active healthy inverters)
- Production appliance services: `inverter-server`, `inverter-engine`, and `inverter-forecast` active and healthy.

## 4. Telemetry PAC Energy Integration & Daily Report Reconciliation (`2026-10-19`)

### Root Cause Analysis
- **Symptom:** On `2026-10-19`, the New Dashboard recorded `INVERTER MWH_T = 118.3894 MWh` (`SUBS. EST. MWH_T = 116.1164 MWh`) vs. the Legacy Dashboard's `112.1273 MWh` (`109.9745 MWh` Substation Est.) and hardware counters (`kwh_total_etotal = 112.1470 MWh`, `kwh_total_parce = 112.1470 MWh`) — an afternoon over-count of `+6.2621 MWh`.
- **Root Cause:**
  1. Up to `13:51:58 PST`, `energy_5min` matched true PAC integration at `1.000x` (`97.9349 MWh`).
  2. In `services/inverter_engine.py` (and `backend/engines/inverter/inverter_engine.py`), `poll_inverter(ip)` called `_update_metrics_from_frame(data)` per unit inside `for u in units:` while `shared[ip] = list(out)` was only published after the final unit of each inverter completed its Modbus read.
  3. During the ~1.1 s mid-sweep window while subsequent units were being read, Node polled `GET /data` every `200 ms`, which iterated over `shared[ip]` (still holding Cycle $N-1$'s frames with timestamp $t_{N-1}$) and called `_update_metrics_from_frame(frame)`.
  4. Because `_update_metrics_from_frame` checked `elif frame_ts > 0 and pe.get("lastFrameTs") == frame_ts:` instead of `frame_ts <= last_frame_ts`, the older cached frame ($t_{N-1} < t_N$) fell into the `else:` branch and overwrote `pe["lastTime"]` and `pe["lastFrameTs"]` back to $t_{N-1}$ for every non-final unit (`units[:-1]`). When `shared[ip]` published Cycle $N$'s frames ($t_N$), `GET /data` integrated $[t_{N-1} \to t_N]$ a second time (`2.0000x` on non-final units, `1.0000x` on the final unit).
  5. Additionally, `slow_poll_inverter` merged `slow_data` (including `"ts"`) directly onto cached fast-poll frames via `frame.update(slow_data)`.

### Resolution & Verification
1. **Strict Monotonic Frame Guard:** Updated `_update_metrics_from_frame` in `services/inverter_engine.py` and `backend/engines/inverter/inverter_engine.py` to enforce `elif frame_ts > 0 and frame_ts <= last_frame_ts: return` and stamp `frame["kwh_today"]` directly onto each integrated frame.
2. **Slow-Poll Timestamp Isolation:** Updated `slow_poll_inverter` so merging slow-poll fields never overwrites fast-poll `"ts"` or `"kwh_today"` (storing the slow timestamp under `"slow_ts"`).
3. **Historical Reconciliation (`V5`):** Added `reconcileOct19AfternoonDoubleInt()` in `server/index.js` and `backend/services/index.js` to re-integrate `2026-10-19` `readings.pac` after `13:51:58 PST`, replace inflated afternoon `energy_5min` buckets, invalidate the in-memory poller baseline, rebuild `daily_report`, and align `forecast_error_compare_daily`.
4. **Verified Production Totals (`2026-10-19` on `adsi-server`):**
   - `energy_5min`: `112,127.3 kWh` (`112.1273 MWh`)
   - `daily_report`: `112.1273 MWh` (`INVERTER MWH_T`), `109.9745 MWh` (`SUBS. EST. MWH_T`), `112.1470 MWh` (`etotal` / `parce`)
   - `forecast_error_compare_daily`: `total_actual_kwh = 112,127.3 kWh` (`actual_source = 'inverter'`)

