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
