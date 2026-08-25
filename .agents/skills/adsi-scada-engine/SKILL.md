---
name: adsi-scada-engine
description: SCADA engine architecture, Modbus polling, APC control loops, compliance sequencers, IGBT degradation modeling, SQLite WAL storage, and security.
---

# ADSI Dashboard — SCADA Engine & Industrial Telemetry Architecture

This skill documents the technical specifications, mathematical models, timing loops, and hardware interfaces powering the **Inverter Dashboard** industrial SCADA and plant controller platform.

---

## 1. Dual-Tier Modbus Telemetry Architecture

- **Fast-Poll Loop (1.0s interval):**
  - Continuous acquisition of high-velocity operational parameters: $P_{ac}, Q_{ac}, V_{dc}, I_{dc}, V_{grid}, I_{phase}, F_{ac}, \cos\phi, T_{heatsink}$.
  - Transport: Modbus TCP over plant industrial LAN across 27 inverters (108 power units).
  - Socket resilience: 1.0s Modbus timeout with 0.5s reconnect delay on link flap.
- **Slow-Poll Loop (30.0s interval):**
  - Auxiliary status, insulation resistance ($Z_{pos}, Z_{neg}$), contactor cycle counters, board temperatures, firmware build hashes, and static machine ratings.

---

## 2. 5-Minute Bucket Aggregation & Monotonic Energy Integration

- **288 Slots Per Day:** Day timeline structured into 288 discrete 5-minute slots ($00:00, 00:05, \dots, 23:55$).
- **Monotonic Energy Rule:** Cumulative generation ($parcE$) must be strictly non-decreasing ($\Delta E \ge 0$). Any retrograde energy reading is rejected as an inverter counter reset or communication corrupt frame.
- **Solar Window Gating:** Readings are tagged with Asia/Manila solar window flags ($05:00 \le t < 18:00$). Nighttime zero-generation intervals are handled without database bloat.
- **LRU Cache & Fast Flush:** 256-entry reaped-slot LRU cache prevents repeated disk IO for recently completed slots.
- **Alarm OR'ing:** Fault and alarm bitfields across 1-second ticks in a 5-minute window are bitwise-OR'd into the bucket summary.
- **Stop Reason Cross-Table Deduplication:** Correlates proprietary vendor stop codes (`MotParo`) with standard inverter error registers, collapsing duplicate records into a unified 5-minute event.

---

## 3. Closed-Loop Active Power Control (APC)

- **Regulation Algorithms:**
  - **Equal Allocation:** Distributes target active power evenly across all non-exempted, online inverters.
  - **Proportional Derate:** Derates each inverter in proportion to its current available DC capacity or nameplate rating.
  - **Sequence Priority:** Curtails/re-enables inverters sequentially according to configured priority ranks or thermal wear balancing.
- **Control Invariants:**
  - Deadband hysteresis: $\pm 0.1\text{ MW}$ band preventing unnecessary hunting/chattering.
  - Dwell cooldown timer: Configurable $15\text{s}–300\text{s}$ interval between successive setpoint writes.
  - Ramp-rate limiter: Enforces maximum active power ramp rate ($\%/s$ or $\text{MW/min}$) to protect transformer substations and prevent grid compliance trip-outs.
  - Write verification ledger: Every written setpoint is confirmed via Modbus read-back and logged to `apc_verify_log` with timestamp and operator identity.

---

## 4. Grid Code Compliance Step Sequencers (T2, T3, T5)

- **T2 Frequency Response (Over-Frequency / Under-Frequency):** Automated stepped active power curtailment tracking grid frequency excursions according to standard droop curves ($s = 3\%–5\%$).
- **T3 Q-V (Reactive Power vs Voltage):** Automated reactive power injection/absorption ($kVAr$) responding to grid point-of-common-coupling (PCC) voltage fluctuations.
- **T5 Power Sweep & Ramp Verification:** Linear stepped ramps ($0\% \to 100\% \to 0\%$) with configurable hold times, settle times, and tolerance margins.
- **PDF Test Report Generation:** Client-side and server-side PDF synthesis capturing test telemetry, target vs actual plots, response lag times, and certification metrics.

---

## 5. Asset Health & IGBT Thermal Degradation Forensics

- **Thermal Wear Model:**
  - Calculates junction-to-heatsink thermal resistance ($R_{th}$) and peak $\Delta T$ temperature delta under load.
  - Analyzes 3-phase negative-sequence current unbalance ($I_2 / I_1$).
  - Tracks 90-day rolling degradation trend generating a Normalized Wear Index ($0–100$).
- **Precursor Anti-Cascade Protection (0x0240 / 0x0210):**
  - Detects recurring 0x0240 and 0x0210 precursor alarm patterns within a 48-hour rolling window.
  - Automatically triggers an anti-cascade fleet safety power cap to prevent catastrophic IGBT bridge failure.
  - Maintains an append-only critical block latch ledger that requires engineer sign-off to release.

---

## 6. Storage Architecture, SQLite WAL & Monthly Sharding

- **Hot Database (`C:\ProgramData\Inverter-Dashboard\db\adsi.db`):**
  - High-performance SQLite database operating in `WAL` (Write-Ahead Logging) mode.
  - Pragmas: `PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;`.
  - Automatic integrity check on startup via `adsi-db-check.sh` with automated dump-and-restore repair for corrupted databases.
  - Automatic recovery of today's cumulative energy from raw readings after unexpected server restarts.
- **Monthly Archive Sharding (`storage/db/archive/YYYY-MM.db`):**
  - Telemetry and alarms older than the retention threshold ($90\text{ days}$) are pruned from `adsi.db` and partitioned into monthly shard databases.
  - Managed by an in-memory 6-handle LRU pool ensuring seamless query access across historical years without file handle exhaustion.
- **Encrypted Backup Engine:**
  - Automated local package creation and cloud sync (AWS S3, Google Drive, Local NAS) with AES encryption and SHA-256 verification.

---

## 7. Security & Authentication Lease Protocol

- **60-Minute Rolling Topology Auth Lease:**
  - HMAC SHA-256 token verification with clock drift tolerance ($\pm 1\text{ min}$).
  - Rolling lease automatically renewed upon active valid telemetry submissions.
  - Strict HTTP 429 rate-limiting on failed attempts (5 failures in 60s triggers cooldown).
- **Role-Based Access Control (RBAC):**
  - Strict hierarchical permissions: `viewer` $\to$ `operator` $\to$ `engineer` $\to$ `admin` $\to$ `devClard`.
  - Node-locked hardware licensing validated on launch.
