---
name: adsi-scada-engine
description: SCADA engine architecture, Modbus polling, PAC energy integration invariants, alarm integrity, APC control loops, SQLite WAL storage, and firmware protocols.
---

# ADSI Dashboard — SCADA Engine & Telemetry Invariants (Token-Optimized)

## 1. Dual-Tier Polling & Mirrored Backend Paths
- **Mirrored CodePaths:** Always keep `services/inverter_engine.py` & `backend/engines/inverter/inverter_engine.py`, `server/index.js` & `backend/services/index.js`, `server/db.js` & `backend/services/db.js`, and `server/alarms.js` & `backend/services/alarms.js` synchronized.
- **Fast Poll (1.0s / 0.05s per-IP config):** Modbus/TCP port `502` (**INGECON SUN PMax**, 27 inverters, nodes `N1..N4`). Reads `pac, qac, vdc, idc, vgrid, iphase, fac, cosphi, temp, alarm`.
- **Slow Poll (30.0s):** Reads `etotal, parce, insulation, firmware, counters`.
  - **CRITICAL Invariant:** When merging `slow_data` into `shared[ip]` frames in `slow_poll_inverter`, **never** overwrite fast-poll `"ts"` or `"kwh_today"` (`if sk not in ("ts", "kwh_today"): frame[sk] = sv; frame["slow_ts"] = slow_data.get("ts")`).

## 2. PAC Energy Integration & Reconciliation Invariants
- **Mid-Sweep `shared[ip]` Race Guard (`_update_metrics_from_frame`):**
  - `poll_inverter(ip)` updates `_update_metrics_from_frame(data)` per unit inside `for u in units:` before publishing `shared[ip] = list(out)` at the end of the inverter sweep.
  - Meanwhile, `GET /data` and `/metrics` inspect `shared[ip]` (which holds Cycle $N-1$ frames with $t_{N-1} < t_N$ for `units[:-1]`).
  - **Strict Monotonic Guard:** Always enforce `elif frame_ts > 0 and frame_ts <= last_frame_ts: return` (never `==`), and stamp `frame["kwh_today"] = round(pe["totalWh"] / 1000.0, 6)` directly on each frame. Never allow an older cached frame to rewind `pe["lastTime"]` or `pe["lastFrameTs"]`.
- **Daily Report & Energy Reconciliation Ordering:**
  - When repairing `energy_5min` for the current day, **always** call `poller.invalidateTodayEnergyBaseline?.()` **before** `buildDailyReportRowsForDate(day, { persist: true, refresh: false, includeTodayPartial: false })`. Otherwise `includeTodayPartial: true` reads the un-invalidated poller baseline and overwrites the repaired `daily_report.kwh_total` via `Math.max(...)`.
  - Use `refresh: false` when `daily_readings_summary` is already populated to avoid blocking the Node event loop for ~15s scanning 1M+ `readings` rows.
  - Sync `forecast_error_compare_daily` (`total_actual_kwh`, `total_abs_error_kwh`, `daily_total_ape_pct`, `actual_source = 'inverter'`) with `SUM(daily_report.kwh_total)`.

## 3. Alarm Logging Integrity Invariants
- **Monotonic Cleared Timestamp:** `stmts.clearAlarm` in `db.js` must enforce `cleared_ts = MAX(ts, ?)`. `_closeAndReopenAlarmTx` and `checkAlarms` clamp `safeTs = Math.max(existing.ts, evTs)`.
- **Unconfigured/Disabled Node Cleanup:** Pruning a disabled node from `ipconfig.json.units` must close any open DB alarm for that node via `closeOrphanedUnconfiguredAlarms()` using its last reading timestamp (or `ts`), preventing multi-month stuck `ACTIVE` alarms.

## 4. APC, Compliance (T2/T3/T5) & IGBT Health
- **APC:** Equal allocation, proportional derate, or sequence priority; $\pm 0.1\text{ MW}$ deadband; $15\text{s}-300\text{s}$ cooldown; ramp-rate limiter; Modbus read-back verification in `apc_verify_log`.
- **Compliance Sequencers:** T2 frequency droop ($3\%-5\%$), T3 Q-V reactive injection, T5 power sweep ($0\% \leftrightarrow 100\%$).
- **IGBT Forensics:** 90-day thermal resistance ($R_{th}$), negative-sequence unbalance ($I_2/I_1$), and 48h precursor anti-cascade latch on `0x0240`/`0x0210`.

## 5. SQLite WAL Storage & Commboard/Firmware Reference
- **Canonical Windows Root:** `C:\ProgramData\Inverter-Dashboard\db` (`adsi.db`, `ipconfig.json`). Linux root: `/var/lib/inverter-dashboard/db`. Never touch `D:\ADSI-Dashboard` or `C:\ProgramData\InverterDashboard`.
- **Archive Shards:** `db/archive/YYYY-MM.db` (90-day hot retention, 6-handle LRU pool).
- **Commboards:** Modern Linux (`AAX1031CN`/`AAX0057` on Inv 2,8,9,10,11,13,14,16,17,18,24,25,26; port 7128 DSP bridge, `.ipk` via `/firmwarizer/upload`) vs Legacy Boa/RTOS (`2014` on Inv 1,3,4,5,6,7,12,15,20,21,22,23,27; RS-485 `.S` flashing via ISM using `scripts/convert_afd_to_s.py`).
