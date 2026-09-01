# ADSI Solar Inverter Dashboard — Full System Review & Operational Evaluation

**Document Version:** 2.12.0
**Evaluation Date:** September 1, 2026
**System Target:** ADSI Inverter Dashboard & Plant Management System
**Deployment Context:** Industrial Solar PV Power Plant (27 Ingeteam Inverters / 108 Internal Power Units / 26.94 MW AC Peak / 24.0 MW Export Ceiling)
**Authors & Contributors:** ADSI Engineering, Systems Architecture & Field Operations Teams

---

## Table of Contents

1. [Executive Summary & System Scope](#1-executive-summary--system-scope)
2. [High-Level Architecture & Deployment Topology](#2-high-level-architecture--deployment-topology)
3. [Dual Operating Modes & State Synchronization](#3-dual-operating-modes--state-synchronization)
4. [Telemetry Acquisition & Modbus Engine Subsystem](#4-telemetry-acquisition--modbus-engine-subsystem)
5. [Solar Generation Forecasting Subsystem](#5-solar-generation-forecasting-subsystem)
6. [Plant Controller & Active Power Control (APC)](#6-plant-controller--active-power-control-apc)
7. [Grid Compliance Testing & Certification Suite](#7-grid-compliance-testing--certification-suite)
8. [Asset Health, Predictive IGBT Diagnostics & Precursor Protection](#8-asset-health-predictive-igbt-diagnostics--precursor-protection)
9. [Database Engine, Monthly Sharding & Data Lifecycle](#9-database-engine-monthly-sharding--data-lifecycle)
10. [CCTV Surveillance & Incident Synchronization](#10-cctv-surveillance--incident-synchronization)
11. [Enterprise Security, Licensing & Tamper-Evident Audit](#11-enterprise-security-licensing--tamper-evident-audit)
12. [Multi-Platform Responsive UI/UX Design System](#12-multi-platform-responsive-uiux-design-system)
13. [Comprehensive API Reference & IPC Message Dictionary](#13-comprehensive-api-reference--ipc-message-dictionary)
14. [System Verification, Quality Assurance & Test Architecture](#14-system-verification-quality-assurance--test-architecture)
15. [Linux & Windows Industrial Deployment, Hardening & Maintenance](#15-linux--windows-industrial-deployment-hardening--maintenance)
16. [System Evaluation, Resilience Audit & Operational Recommendations](#16-system-evaluation-resilience-audit--operational-recommendations)

---

## 1. Executive Summary & System Scope

The **ADSI Inverter Dashboard** is a mission-critical, industrial-grade Supervisory Control and Data Acquisition (SCADA), telemetry processing, analytical forecasting, and plant-control orchestration platform. It is engineered specifically for utility-scale solar photovoltaic (PV) generation facilities equipped with multi-modular central inverters (notably Ingeteam multi-stage central inverter stations).

The system consolidates high-frequency Modbus TCP telemetry acquisition, real-time closed-loop active and reactive power regulation, predictive asset health forensics (IGBT degradation, unbalance tracking, precursor fault protection), automated grid-code compliance certification (T2 Frequency Droop, T3 Q-V Droop, T5 Active Power Sweeps), day-ahead hybrid ML/physics solar generation forecasting, CCTV surveillance synchronization, and multi-year forensic telemetry archiving into a unified, crash-resilient application.

### Key Capabilities Matrix

| Functional Domain | Underlying Technologies | Core Functionality & Specifications |
| :--- | :--- | :--- |
| **Telemetry Engine** | Python 3 (Asyncio), FastAPI, Modbus TCP | 1-second continuous telemetry polling across 27 central inverters (108 discrete power unit stages). Dual-tier fast/slow poll. |
| **Plant Controller (APC)** | Node.js, Modbus TCP Writes, PID / Band Engine | Closed-loop Active MW Cap regulation, dynamic %P setpoints, ramp-rate limiting, PF ($\cos \varphi$) and kVAr reactive power control. |
| **Grid Compliance** | Automated Sequencers, Vector SVG/PDF Generators | Automated T2 Frequency Droop, T3 Q-V Voltage Support, and T5 Active Power Sweep test execution with formal PDF report compilation. |
| **Asset Health & AI** | Statistical Forensic Models, Rule Enforcers | 90-day IGBT thermal degradation modeling ($R_{th}$, $\Delta T$), 0x0240/0x0210 precursor auto-blocking, 3-phase unbalance monitoring. |
| **Solar Forecasting** | Python LightGBM/GBR, Solcast API, Clear-Sky Engine | 24-hour day-ahead schedules with snapshot locking, 6-regime residual ML modeling, 5-class error prediction, EMOS-B spread calibration. |
| **Data Persistence** | SQLite3 (WAL Mode), Monthly Sharded Archives | Zero-loss energy logging, crash-recovery slot reconstruction, 90-day hot retention with atomic monthly sharding (`YYYY-MM.db`). |
| **Video Surveillance** | Embedded `go2rtc`, RTSP, WebRTC, MSE, Hikvision ISAPI | Low-latency live multi-camera streaming, native C++ hardware-accelerated viewer, alarm-triggered forensic video timestamp indexing. |
| **Security & Auditing** | PBKDF2/SHA-256 HMAC, Dual-Role RBAC, Device Locking | Node-locked hardware licensing, `devClard` minute-rotating TOTP authentication, 60-min topology auth lease, tamper-evident audit trail. |
| **Client Presentation** | Electron Shell, HTML5, CSS3, Vanilla ES6 | High-density SCADA HUD, responsive mobile technician layout, zero horizontal scrolling sub-navigation, intermediate tablet flex layouts. |

---

## 2. High-Level Architecture & Deployment Topology

The platform employs a modular, fault-isolated multi-tier architecture that decouples low-level hardware protocol communication, analytical processing, persistent storage, and graphical human-machine interfaces (HMI).

```
+---------------------------------------------------------------------------------------+
|                                PHYSICAL INVERTER FLEET                                |
|   27x Ingeteam Central Inverters (Subnet 192.168.1.0/24: 192.168.1.101 - 192.168.1.127) |
|   Each Inverter contains 4x Internal Power Stages / Slaves (108 Power Units Monitored)   |
+-------------------------------------------+-------------------------------------------+
                                            | Modbus TCP (Port 502)
                                            v
+---------------------------------------------------------------------------------------+
|                                HARDWARE SERVICE ENGINES                               |
|  +--------------------------------------------+  +---------------------------------+  |
|  |       Inverter Poller Engine (Py/Exe)      |  |   Forecast Engine (Py/Exe)      |  |
|  | - Asyncio Modbus TCP Client Pool           |  | - 24h Day-Ahead Hybrid Model    |  |
|  | - Fast Poll (1s) & Slow Poll (30s)         |  | - 15-min Intraday Nowcast       |  |
|  | - REST Endpoint: 127.0.0.1:9100            |  | - Worker Port: 127.0.0.1:9200   |  |
|  +--------------------------------------------+  +---------------------------------+  |
+-------------------------------------------+-------------------------------------------+
                                            | Local HTTP / REST
                                            v
+---------------------------------------------------------------------------------------+
|                              NODE.JS SERVER ORCHESTRATOR                              |
|                              (Express.js / Port 3500)                                 |
|  +---------------------------------------------------------------------------------+  |
|  | - Gateway Poller & Batch Coordinator (`server/poller.js`)                       |  |
|  | - 5-Minute Bucket Daily Aggregator (`server/dailyAggregator.js`)                 |  |
|  | - Closed-Loop Plant Cap & APC Engine (`server/plantCapController.js`)          |  |
|  | - Grid Code Reactive Regulator (`server/gridControlController.js`)             |  |
|  | - Grid Compliance Sequencer & PDF Engine (`server/complianceTests.js`)         |  |
|  | - IGBT Health & Precursor Pattern Enforcer (`server/igbtHealth.js`)             |  |
|  | - Surveillance Proxy & ISAPI Bridge (`server/go2rtcManager.js`)                |  |
|  | - Security, RBAC & Topology Auth Lease (`server/auth.js`)                       |  |
|  | - Retention Worker & Monthly Shard Router (`server/retentionWorker.js`)         |  |
|  +---------------------------------------------------------------------------------+  |
+---------------------+-------------------------------------------+---------------------+
                      |                                           |
                      v                                           v
+-----------------------------------+   +-----------------------------------------------+
|         STORAGE SUBSYSTEM         |   |             CLIENT PRESENTATION LAYER         |
|  +-----------------------------+  |   |  +-----------------------------------------+  |
|  | Hot SQLite DB (WAL Mode)    |  |   |  | Electron Desktop Application            |  |
|  | `storage/db/adsi.db`        |  |   |  | - Touch-optimized Control Room HUD      |  |
|  +-----------------------------+  |   |  | - Multi-Monitor Popouts & Native Player |  |
|  | Monthly Sharded Archives    |  |   |  +-----------------------------------------+  |
|  | `storage/db/archive/YYYY-MM`|  |   |  | Mobile Web Browser (Field Smartphone)   |  |
|  +-----------------------------+  |   |  | - Zero Horizontal Scroll Tab Layout     |  |
|  | Encrypted Cloud & NAS Sync  |  |   |  +-----------------------------------------+  |
|  | (AWS S3, Google Drive, NAS) |  |   |  | Remote Control Room Workstation         |  |
|  +-----------------------------+  |   |  | - Encrypted WebSocket Remote Stream     |  |
|  +-----------------------------+  |   |  +-----------------------------------------+  |
+-----------------------------------+   +-----------------------------------------------+
```

### Network Topology & Port Mapping

| Port Number | Protocol / Transport | Component / Role | Binding Scope |
| :--- | :--- | :--- | :--- |
| **502** | Modbus TCP | Physical Inverter Communication (Slaves 1–4 / Nodes N1–N4) | Inverter Subnet (`192.168.1.0/24`) |
| **3500** | HTTP / WebSocket | Main Express API & Real-Time Telemetry Broadcast | Localhost / LAN (`0.0.0.0`) |
| **9100** | HTTP / REST | Python Inverter Telemetry & Command Engine | Loopback Only (`127.0.0.1`) |
| **9200** | HTTP / REST | Python AI Solar Forecast Worker & Telemetry Bridge | Loopback Only (`127.0.0.1`) |
| **1984** | HTTP / WebRTC / API | `go2rtc` Streaming Core & WebRTC Gateway | Loopback / LAN |
| **8554** | RTSP | `go2rtc` Low-Latency Video Pipeline | Loopback Only (`127.0.0.1`) |
| **8000** | HTTP / ISAPI | On-Site Hikvision NVR / IP Cameras | Camera Subnet (`192.168.1.200+`) |

---

## 3. Dual Operating Modes & State Synchronization

To support both on-site primary plant controllers and remote off-site monitoring stations without causing Modbus polling collisions, the platform enforces a strict dual operating model:

```
                  +-----------------------------------+
                  |        APPLICATION BOOT           |
                  +-----------------+-----------------+
                                    |
                    [Check System Configuration]
                                    |
                   +----------------+----------------+
                   |                                 |
                   v                                 v
        [Gateway Mode Selected]           [Remote Client Mode Selected]
                   |                                 |
                   v                                 v
    +------------------------------+  +------------------------------+
    | GATEWAY / MASTER MODE        |  | REMOTE CLIENT / VIEWER MODE  |
    | - Spin up Express Server     |  | - Connect to Gateway via WS  |
    | - Spawn Telemetry Poller     |  | - Zero Modbus Polling        |
    | - Spawn Forecast Engine      |  | - Receive Real-Time Stream   |
    | - Run Closed-Loop Plant Cap  |  | - Render Visualizations      |
    | - Direct SQLite WAL Writes   |  | - Read-Only API Tunneling    |
    +--------------+---------------+  +--------------+---------------+
                   |                                 |
                   |      [Mode Handoff Trigger]     |
                   +----------------<----------------+
                                    |
                                    v
                     +------------------------------+
                     | STATE HANDOFF & RECONCILIATION|
                     | - Sync Energy Counter State  |
                     | - Align Baselines & Clocks   |
                     | - Acquire Topology Auth Lease|
                     | - Seamlessly Promote to Master|
                     +------------------------------+
```

### 1. Gateway Mode (Master / Local Server)
* **Operational Scope:** Primary on-site plant controller and data logging master.
* **Responsibilities:**
  - Directly opens and manages Modbus TCP sockets to all physical inverters.
  - Executes active closed-loop power control commands (MW Cap, %P setpoints, stop/start).
  - Integrates 5-minute energy slots into persistent SQLite storage.
  - Runs local predictive maintenance evaluation, pattern enforcers, and daily solar forecasting.
  - Serves live WebSockets and REST endpoints to local and remote clients.

### 2. Remote / Client Mode (Viewer / Remote Station)
* **Operational Scope:** Lightweight client and remote viewer.
* **Responsibilities:**
  - Connects to the on-site Gateway via an encrypted WebSocket remote bridge.
  - Receives live telemetry streams, alarms, and plant metrics without touching physical Modbus hardware.
  - Eliminates duplicate Modbus polling collisions over wide-area networks.
  - **Automatic State Handoff:** When a remote instance transitions to gateway mode, energy counters and baseline states synchronize seamlessly via `evaluateCounterAdvancing` and `getYesterdaySnapshotForDate` to prevent duplicate energy logging.

### 3. Topology Authorization Lease Protocol
To prevent split-brain control scenarios where multiple workstations attempt to issue conflicting plant setpoints:
- The active controller must obtain a 60-minute rolling **Topology Authorization Lease** (`topologyAuthLease.js`).
- Leases are cryptographically signed with HMAC SHA-256 tokens.
- Renewal occurs automatically on active operator interaction. If an operator station remains idle or loses connection for $>60$ minutes, the lease expires and setpoint write permissions are safely revoked.
- Rate-limiting protection automatically throttles client requests (HTTP 429) after $\ge 5$ authorization failures within 60 seconds from the same source IP.

---

## 4. Telemetry Acquisition & Modbus Engine Subsystem

### 1. Modbus Register Architecture & Mapping

The inverter telemetry acquisition engine communicates directly with central inverter controllers via Modbus TCP Port 502, monitoring up to 4 internal power stages (Slaves 1, 2, 3, 4) per physical inverter station.

#### Core Modbus Register Map (Per Slave Stage)

| Address Range | Register Category | Field Parameter | Unit | Engineering Scale / Type |
| :--- | :--- | :--- | :--- | :--- |
| **00 – 01** | Electrical Output | Active Power ($P_{ac}$) | kW / W | Int32 / Big-Endian |
| **02 – 03** | Electrical Output | Reactive Power ($Q_{ac}$) | kVAr / VAr | Int32 / Signed Big-Endian |
| **04** | DC Link | DC Bus Voltage ($V_{dc}$) | V | Uint16 ($0.1\times$ Scale) |
| **05** | DC Link | DC Input Current ($I_{dc}$) | A | Uint16 ($0.1\times$ Scale) |
| **06 – 08** | AC Grid Voltage | Line Voltages ($V_{ab}, V_{bc}, V_{ca}$) | V | Uint16 ($0.1\times$ Scale) |
| **09 – 11** | AC Grid Current | Phase Currents ($I_a, I_b, I_c$) | A | Uint16 ($0.1\times$ Scale) |
| **12** | Grid Quality | Grid Frequency ($F_{ac}$) | Hz | Uint16 ($0.01\times$ Scale) |
| **13** | Grid Quality | Power Factor ($\cos \varphi$) | — | Int16 ($-1.000$ to $+1.000$) |
| **14 – 17** | Diagnostics | IGBT Bridge Temps ($T_{pe1}..T_{pe4}$) | °C | Int16 ($0.1\times$ Scale) |
| **18** | Environment | Internal Ambient Cabinet Temp ($T_{int}$) | °C | Int16 ($0.1\times$ Scale) |
| **19 – 20** | Cumulative Energy | Total Energy Generated ($E_{total}$) | kWh | Uint32 Big-Endian Monotonic |
| **21 – 22** | Daily Energy | Today Energy Generated ($E_{today}$) | kWh | Uint32 Big-Endian Reset at Midnight |
| **32 – 35** | Status & Alarms | Inverter State & Warning Bitmask | — | Uint16 / Uint32 Hex Bitfields |
| **64 – 80** | Diagnostics | Insulation Resistance ($Z_{pos}, Z_{neg}$) | $\text{k}\Omega$ | Uint16 Slow-Poll Register |
| **96 – 116** | Factory Ratings | Nominal Rated Power ($P_{nom}$) | W | Uint32 Slow-Poll Register |
| **128 – 130** | Motive / Events | Stop Reason Code (`MotParo`) | — | Uint16 Event Log Trigger |

### 2. Dual-Tier Polling Strategy (Fast-Poll vs. Slow-Poll)
- **Tier 1 (Fast-Poll — 1-Second Cycle):** Acquires high-speed dynamic electrical telemetry ($P_{ac}, Q_{ac}, V_{dc}, I_{dc}, V_{grid}, I_{phase}, F_{ac}$, status registers). Enables instantaneous HUD updating and sub-second APC response.
- **Tier 2 (Slow-Poll — 30-Second Cycle):** Reads static configuration and slow-moving thermal/diagnostic parameters ($Z_{pos}/Z_{neg}$ insulation, rated nominal capacity, internal cabinet ambient, firmware revisions). Reduces Modbus bus contention by 85%.

### 3. Range Clamping & Register Sanitization Gates
To prevent corrupt telemetry frames or communication noise from skewing historical analytics, all incoming samples are processed through strict range gates (`_RANGES`):

```javascript
const _RANGES = {
  vdc:      [0, 2000],       // DC bus voltage (0 to 2000 V)
  idc:      [0, 1000],       // DC string current (0 to 1000 A)
  pac:      [0, 250000],     // Active power per unit (0 to 250 kW)
  qac:      [-250000, 250000],// Reactive power (-250 to +250 kVAr)
  fac:      [45.0, 65.0],    // Frequency (45.0 to 65.0 Hz)
  cosphi:   [-1.0, 1.0],     // Power factor (-1.00 to +1.00)
  temp_igbt:[ -20, 125 ],    // IGBT bridge temperature (-20 to 125 °C)
  temp_int: [ -20, 85 ]      // Cabinet ambient (-20 to 85 °C)
};
```

### 4. 5-Minute Bucket Aggregation Engine (`dailyAggregator.js`)
- **Bucket Integration:** Raw samples are accumulated into discrete 5-minute slots (12 slots/hour, 288 slots/day).
- **Monotone Energy Integration:** Energy values ($parcE$) are gated by a strictly monotonic validator. Energy regressions caused by slave reboots are rejected, locking the highest validated cumulative value.
- **Asia/Manila Solar Window:** Aggregation actively tags generation slots within the legal solar generating window ($05:00 \le t < 18:00$), calculating nighttime tare losses separately.
- **Bitwise Alarm Consolidation:** Inverter alarm flags occurring at any point during a 5-minute slot are combined using bitwise-OR ($\bigvee \text{alarms}$), guaranteeing that intermittent micro-faults are never missed.
- **Reaped-Slot LRU Protection:** A 256-entry LRU cache tracks reaped slots, preventing late-arriving network packets from recreating previously closed historical buckets.

### 5. Stop Reason & MotParo Forensic Deduplication (`stopReasonAggregator.js`)
- Ingeteam inverters record shutdown causes across both proprietary vendor registers (`MotParo`) and standard Modbus error codes.
- `stopReasonAggregator.js` cross-references these event tables using a 5-minute temporal window, collapsing duplicate entries while preserving rich vendor-specific diagnostic descriptions.

---

## 5. Solar Generation Forecasting Subsystem

The forecasting engine (`services/forecast_engine.py`) provides high-precision generation projections required for wholesale electricity market compliance, day-ahead dispatch scheduling, and plant control optimization. It implements a dual-layer hybrid architecture combining deterministic clear-sky physics with LightGBM/GBR gradient-boosted residual regression.

### 1. Dual-Layer Hybrid Forecasting Architecture

```
[Satellite Irradiance & Solcast P50] ──+
                                       ├──> [Clear-Sky Physics Baseline (P_phys)] ──+
[Ambient Temp & Cell Heating Model]  ──+                                             │
                                                                                     ├──> [Dynamic Blending] ──> [EMOS-B Spread Calibration] ──> [Published P50 / P10 / P90]
[Historical 45-Day Actuals & GHI]    ──+                                             │    (35% - 100% ML)       (Scale: [0.70, 1.30])
                                       ├──> [6-Regime Residual Model (LightGBM)] ───+
[5-Class Error Classifier Bias Map]  ──+
```

#### Layer 1: Mathematical & Physical Baseline Model

$$P_{\text{phys}}(t) = \text{GHI}(t) \times C_{\text{cloud}}(t) \times DC_{\text{cap}} \times \eta_{\text{inv}} \times \left[1 + \gamma_{\text{TC}} \times (T_{\text{cell}}(t) - 25^\circ\text{C})\right]$$

Where:
- $\text{GHI}(t)$: Global Horizontal Irradiance under clear-sky conditions (W/m²).
- $C_{\text{cloud}}(t)$: Satellite-derived cloud attenuation factor obtained from Solcast API integrations.
- $DC_{\text{cap}}$: Total installed DC capacity ($26.94\text{ MW AC}$ plant baseline).
- $\eta_{\text{inv}}$: Nominal conversion efficiency of the inverter fleet ($\approx 98.6\%$).
- $\gamma_{\text{TC}}$: PV module temperature power loss coefficient ($-0.004 / ^\circ\text{C}$).
- $T_{\text{cell}}(t)$: Estimated solar cell temperature derived from ambient temperature and irradiance.

#### Layer 2: Machine Learning Residual Pipeline (`LightGBM` / `sklearn_gbr`)

- **45-Day Rolling Lookback:** Analyzes trailing 45 days (`N_TRAIN_DAYS = 45`) with recency exponential decay weighting ($w(d) = \max(0.5^{d / 14.0}, 0.18)$).
- **Anomaly Rejection Gates:** Discards anomalous days violating Capacity Factor bounds ($0.02 \le \text{CF} \le 1.05$) or Pearson radiation correlation ($r(\text{GHI}, P_{\text{gen}}) \ge 0.55$).
- **6 Weather Regime Buckets:** Trains partitioned sub-models for `clear_stable`, `clear_edge`, `mixed_stable`, `mixed_volatile`, `overcast`, and `rainy` weather conditions.
- **5-Class Error Classifier:** Predicts bias directions (`strong_over`, `mild_over`, `neutral`, `mild_under`, `strong_under`) for proactive bias correction.
- **Dynamic Blending:** Constrains ML residual contribution to $[\text{ML\_BLEND\_MIN}=0.35, \text{ML\_BLEND\_MAX}=1.00]$, with ramp-slot damping ($0.62\times$) during sunrise/sunset transitions.
- **EMOS-B Spread Calibration:** Calibrates confidence bounds (P10/P90) using a 30-day lookback, constrained within $[0.70, 1.30]$ scaling bounds.

### 2. Day-Ahead Locked Schedule & Solcast Freshness Gates

1. **24-Hour Day-Ahead Schedule:** Generated daily at 06:00 and 18:00 PHT (`DA_RUN_HOURS_PRIMARY = {6, 18}`). The finalized day-ahead forecast is permanently snapshotted in SQLite (`forecast_run_audit` and `forecast_error_compare_daily`) for market dispatch and regulatory auditing.
2. **Solcast Freshness Pipeline:**
   - `fresh` ($\ge 95\%$ slot coverage): Full `ml_solcast_hybrid` variant enabled.
   - `stale_usable` ($80\%–94\%$ coverage): Degraded `ml_solcast_hybrid_stale` mode.
   - `stale_reject` / `missing` ($< 80\%$ coverage): Falls back to `ml_without_solcast` or `physics_only`.

### 3. Forecasting Provenance & 7-Step QA Eligibility Gate

Upon completion of each solar day (156 slots between 05:00 and 17:55 PHT), `_persist_qa_comparison` evaluates error metrics:

$$\text{WAPE} = \frac{\sum_{t=1}^N |\text{Actual}_t - \text{Forecast}_t|}{\sum_{t=1}^N \text{Actual}_t} \times 100\% \quad (\text{Target: } \le 15\%)$$

$$\text{MAPE} = \frac{1}{N} \sum_{t=1}^N \left| \frac{\text{Actual}_t - \text{Forecast}_t}{\text{Actual}_t} \right| \times 100\% \quad (\text{Target: } \le 20\%)$$

A day is assigned `comparison_quality = 'eligible'` for error memory bias correction only if:
1. Usable actual slots $\ge 132$ ($85\%$ of solar window).
2. Usable forecast slots $\ge 132$.
3. Total usable slots $\ge 132$.
4. Constrained/curtailed slot ratio $\le 0.30$.
5. No provider mismatch.
6. Solcast freshness is not `missing` or `stale_reject`.
7. Forecast variant is not degraded.

> **Detailed Specification:** For the complete mathematical formulation, error memory matrix, health state contracts (`ml_train_state.json`), and executable test scripts, refer to [`evals/forecast-ml-dayahead-integrity.md`](file:///d:/Inverter-Dashboard/evals/forecast-ml-dayahead-integrity.md).

---

## 6. Plant Controller & Active Power Control (APC)

The Plant Controller subsystem provides closed-loop active and reactive power regulation across the solar facility.

```
                    +--------------------------------+
                    |     GRID OPERATOR DISPATCH     |
                    | (Upper / Lower MW Target Limit)|
                    +---------------+----------------+
                                    |
                                    v
                    +--------------------------------+
                    |   CLOSED-LOOP PLANT CAP PID    |
                    | - Total Generation Summation   |
                    | - Error Delta: e(t) = P - Pcap |
                    +---------------+----------------+
                                    |
               +--------------------+--------------------+
               |                    |                    |
               v                    v                    v
      [Equal Allocation]  [Proportional Derate] [Sequence Priority]
      P_i = P_cap / N     P_i = P_curr * Ratio  Curtail Inverter 1..k
               |                    |                    |
               +--------------------+--------------------+
                                    |
                                    v
                    +--------------------------------+
                    |  RAMP-RATE LIMITER & COOLDOWN  |
                    | - Max Ramp: 5% / second        |
                    | - Hysteresis Deadband (0.1 MW) |
                    | - Cooldown Dwell Timer (30s)   |
                    +---------------+----------------+
                                    |
                                    v
                    +--------------------------------+
                    | MODBUS DISPATCH & VERIFICATION |
                    | - Write Holding Regs to Units  |
                    | - Read-Back Verification Loop  |
                    | - Append to `apc_verify_log`   |
                    +--------------------------------+
```

### 1. Active MW Cap Regulation Engine (`plantCapController.js`)
- **Closed-Loop Control Modes:**
  1. **Equal Allocation:** Distributes the active MW limit evenly across all available, non-exempted inverters:
     $$P_{\text{target}, i} = \frac{\text{Cap}_{\text{target}}}{N_{\text{active}}}$$
  2. **Proportional Derating:** Curtains inverters proportionally based on their instantaneous generation capacity:
     $$P_{\text{target}, i} = P_{\text{actual}, i} \times \left( \frac{\text{Cap}_{\text{target}}}{\sum P_{\text{actual}}} \right)$$
  3. **Sequential Priority Curtailment:** Derates designated inverters in a predefined sequence, keeping base-load units at 100% capacity.
- **Anti-Hunting Hysteresis:** Incorporates a configurable deadband ($\pm 0.1\text{ MW}$) and cooldown timer ($15\text{s}–300\text{s}$) to prevent rapid inverter cycling around target thresholds.
- **Exemption Filter:** Critical inverters or units undergoing maintenance can be flagged as exempted, shielding them from automated curtailment.

### 2. %P Setpoint Dispatch & Ramp-Rate Limiting
- Dispatches instantaneous % rated power setpoints across 3 scopes:
  - **Plant-Wide:** Broadcasts uniform derating across the entire plant.
  - **Per Inverter:** Sets individual limits on specific multi-stage units.
  - **Per Internal Node:** Precise stage-level control (Slave 1..4).
- **Ramp-Rate Limiter:** Restricts active power rate-of-change ($\%/s$) to prevent grid frequency disturbances during rapid cloud transients or curtailment ramp-ups.
- **Verification Logging (`apc_verify_log`):** Every setpoint command confirms read-back register verification within a strict tolerance before marking the dispatch successful.

### 3. Reactive Power & Grid Code Regulation (`gridControlController.js`)
- **Power Factor ($\cos \varphi$) Mode:** Regulates leading/lagging power factor ($0.80\text{ lead} \leftrightarrow 0.80\text{ lag}$) to support grid voltage stability.
- **kVAr Setpoint Mode:** Issues direct reactive power injection or absorption commands.
- **Write Verification:** All reactive power writes are logged and verified via `grid_control_verify_log`.

---

## 7. Grid Compliance Testing & Certification Suite

The platform includes an automated compliance testing suite designed to execute standardized Grid Code certification tests and generate formal verification reports:

```
[START TEST] ──> [Pre-Flight Inverter Ready Check] ──> [Step 1: Setpoint Dispatch]
                                                                  │
                                                                  ▼
[Step 4: Step Evaluation] <── [Step 3: Read-Back Verification] <── [Step 2: Dwell / Settle Timer]
         │
         ├──> [Next Step Available] ──> Loop to Step 1
         │
         └──> [Final Step Completed] ──> [Generate Vector SVG Charts & Formal PDF Report]
```

### Supported Compliance Test Routines

| Test Protocol | Target Grid Parameter | Step Sequence & Execution Parameters | Output Verification |
| :--- | :--- | :--- | :--- |
| **T2 Frequency Droop** | Active Power vs. Frequency $P(f)$ | Steps frequency offsets (e.g. 50.0 $\rightarrow$ 50.5 $\rightarrow$ 51.0 Hz). Evaluates droop curve compliance ($s = 3\%\dots 5\%$). | Response time $\le 2\text{s}$, droop curve linearity within $\pm 2\%$. |
| **T3 Q-V Voltage Support** | Reactive Power vs. Voltage $Q(V)$ | Steps grid voltage targets (0.90 pu $\rightarrow$ 1.00 pu $\rightarrow$ 1.10 pu). Measures kVAr injection/absorption response. | Reactive delivery within $\pm 3\%$ of droop slope. |
| **T5 Active Power Sweep** | %P Dynamic Step Response | Multi-step active power sweep (0% $\rightarrow$ 25% $\rightarrow$ 50% $\rightarrow$ 75% $\rightarrow$ 100% $\rightarrow$ 0%). Configurable hold/settle times (30s–300s). | Rise time, overshoot $\le 5\%$, settling time $\le 10\text{s}$, steady-state error $\le 1\%$. |

### Automated PDF Report Generator (`complianceReportPdf.js`)
- Compiles timestamped test parameters, live telemetry read-backs, error margins, and vector SVG response curves into formal PDF certification documents ready for utility and regulatory submission.

---

## 8. Asset Health, Predictive IGBT Diagnostics & Precursor Protection

The system incorporates an advanced hardware diagnostics framework aimed at preventing catastrophic inverter bridge failures and maximizing plant uptime.

```
                    +------------------------------------+
                    |     LIVE TELEMETRY STREAM          |
                    | (IGBT Temps, Currents, DC Bus,     |
                    |  Phase Voltages, Alarm Bitmasks)   |
                    +-----------------+------------------+
                                      |
                     +----------------+----------------+
                     |                                 |
                     v                                 v
    +--------------------------------+  +--------------------------------+
    |  90-DAY IGBT DEGRADATION MODEL |  | PRECURSOR PATTERN ENFORCER     |
    | - R_th Thermal Resistance Calc |  | - 0x0240 / 0x0210 Anomaly Gate |
    | - Peak Generation Delta T Rise |  | - 48-Hour Rolling Anomaly Loop |
    | - 3-Phase Unbalance Percentage |  | - Anti-Cascade Fleet Safety Cap|
    | - Wear Index Score (0 - 100)   |  | - Critical Block Latch Ledger  |
    +----------------+---------------+  +---------------+----------------+
                     |                                 |
                     +----------------+----------------+
                                      |
                                      v
                    +------------------------------------+
                    |  ACTIONABLE FORENSIC INTELLIGENCE  |
                    | - Recommended Engineering Actions  |
                    | - Predictive Maintenance Scheduling|
                    | - Automated Inverter Safe-Shutdown |
                    +------------------------------------+
```

### 1. 90-Day IGBT Degradation Forensic Model (`igbtHealth.js`)
- **Thermal Resistance Tracking ($R_{th}$):**
  $$R_{th}(t) = \frac{T_{IGBT}(t) - T_{ambient}(t)}{P_{loss}(t)}$$
- **Peak Generation $\Delta T$ Rise:** Measures thermal rise above ambient at maximum power output ($>85\%\text{ rated } P_{ac}$). Rising $\Delta T$ trends over a 90-day window identify thermal paste dry-out, heat-pipe degradation, or cooling fan degradation before thermal trips occur.
- **3-Phase Current & Voltage Unbalance Monitoring:** Evaluates negative-sequence unbalance across bridge phases:
  $$\text{Unbalance (\%)} = \frac{\max(|I_a - I_{avg}|, |I_b - I_{avg}|, |I_c - I_{avg}|)}{I_{avg}} \times 100\%$$
  Sustained unbalance $>5\%$ triggers immediate inspection recommendations.
- **Normalized Wear Index (0–100 Scale):** Consolidates thermal stress, unbalance, and stop events into a single composite health score:
  - `90–100`: Nominal / Pristine Health
  - `75–89`: Moderate Aging (Schedule Fan/Filter Inspection)
  - `50–74`: Severe Thermal Degradation (Schedule Heatsink Re-pasting)
  - `< 50`: Critical Failure Imminent (Derate or Take Offline)

### 2. 0x0240 / 0x0210 Forensic Precursor Pattern Enforcer (`patternEnforcer.js`)
- **Precursor Detection:** Evaluates recurring DC bus ripple anomalies (`0x0240`) and AC bridge synchronization micro-faults (`0x0210`) across a rolling 48-hour window.
- **Anti-Cascade Fleet Protection Cap:** If an external grid event (such as lightning or transmission line fault) induces alarms across multiple inverters simultaneously, a fleet safety cap prevents the enforcer from tripping the entire facility offline at once, flagging a fleet-wide alert for engineering review instead.
- **Critical Block Ledger:** When an individual inverter exceeds precursor thresholds, it is safely locked in the `critical_block_ledger`, requiring explicit technician inspection and administrative clearance.

---

## 9. Database Engine, Monthly Sharding & Data Lifecycle

To guarantee indefinite operation on industrial gateway hardware with bounded storage and memory resources, the system implements a high-performance SQLite architecture.

```
+---------------------------------------------------------------------------------------+
|                                    HOT STORAGE TIER                                   |
|                             `storage/db/adsi.db` (WAL Mode)                           |
|  - Real-time 1s telemetry ingestion                                                   |
|  - 5-minute aggregated power & energy buckets (Rolling 90-day retention)              |
|  - Active alarms, audit logs, and operational configuration                           |
+-------------------------------------------+-------------------------------------------+
                                            | Retention Worker (Nightly at 02:00)
                                            | Atomic Month Migration
                                            v
+---------------------------------------------------------------------------------------+
|                                MONTHLY ARCHIVE SHARD TIER                             |
|                             `storage/db/archive/YYYY-MM.db`                           |
|  - Standalone SQLite shards partitioned by calendar month                             |
|  - Managed via LRU Connection Pool (Max 6 open database file handles)                 |
|  - Zero impact on hot database write latency during historical data queries           |
+-------------------------------------------+-------------------------------------------+
                                            | Automated Backup Worker
                                            | Encrypted Checksum Sync
                                            v
+---------------------------------------------------------------------------------------+
|                              MULTI-CLOUD & NAS BACKUP TIER                            |
|  - AWS S3 Bucket Integration (Encrypted Uploads)                                      |
|  - Google Drive API Sync                                                              |
|  - Local USB / Network Attached Storage (NAS) Mirroring                               |
+---------------------------------------------------------------------------------------+
```

### 1. SQLite WAL Engine Optimization
- Configured with `PRAGMA journal_mode = WAL;`, `PRAGMA synchronous = NORMAL;`, `PRAGMA busy_timeout = 5000;`, and `PRAGMA cache_size = -32000;` (32MB in-memory page cache).
- Enables simultaneous non-blocking reads from multiple UI clients while the background telemetry poller writes high-frequency data without lock contention.

### 2. Boot Integrity Verification & Auto-Repair (`adsi-db-check.sh`)
- During system boot, `adsi-db-check.sh` executes `PRAGMA quick_check;`.
- If database corruption is detected (e.g. from an abrupt power loss on an industrial PC), the script executes an automatic recovery dump:
  ```bash
  sqlite3 adsi.db ".dump" | sqlite3 adsi_repaired.db
  mv adsi.db adsi.db.corrupt.bak
  mv adsi_repaired.db adsi.db
  ```
- The result is logged to `startupIntegrityResult`, allowing the system to boot safely without human intervention.

### 3. Crash-Resilient Energy Recovery (`recoverTodayEnergyFromReadings`)
- If the server terminates unexpectedly mid-slot, `recoverTodayEnergyFromReadings` reconstructs all completed 5-minute energy slots directly from surviving raw readings upon reboot, ensuring seamless daily cumulative MWh totals.

### 4. Monthly Sharded Archiving (`retentionWorker.js` & `archiveDb.js`)
- Historical readings older than 90 days migrate into standalone monthly SQLite shards (`storage/db/archive/YYYY-MM.db`).
- **LRU Connection Pool:** Manages archive file descriptors with an LRU cache (capped at 6 open shards), ensuring memory and file-handle consumption remain strictly bounded even during multi-year data export queries.

### 5. Multi-Cloud Backup Subsystem (`cloudBackup.js`)
- Supports automated, scheduled backups to AWS S3, Google Drive, and local network shares (NAS).
- Archives are compressed, cryptographically hashed with SHA-256 checksums, and verified upon upload.

---

## 10. CCTV Surveillance & Incident Synchronization

The dashboard bridges SCADA telemetry with live site physical security:

```
+---------------------------------------------------------------------------------------+
|                               PHYSICAL CAMERA INFRASTRUCTURE                          |
|                     On-Site RTSP / Hikvision Cameras & NVR Units                      |
+-------------------------------------------+-------------------------------------------+
                                            | RTSP Streams (Port 554 / 8554)
                                            v
+---------------------------------------------------------------------------------------+
|                              EMBEDDED `go2rtc` STREAM CORE                            |
|  - Ultra-Low Latency Transcoding (WebRTC, MSE, HLS)                                   |
|  - Dynamic On-Demand Stream Negotiation (Zero CPU load when cameras not viewed)       |
+---------------------+-------------------------------------------+---------------------+
                      |                                           |
                      v                                           v
+-----------------------------------+   +-----------------------------------------------+
|    BROWSER & ELECTRON HUD VIEW    |   |     HIKVISION NATIVE HARDWARE PLAYER WINDOW   |
|  - Responsive Multi-Grid (1/4/9)  |   |  - Direct C++ SDK Overlay Window              |
|  - WebRTC Low-Latency Stream      |   |  - Hardware Decoding Acceleration             |
|  - Incident Bookmark Playback     |   |  - Full PTZ Control & OSD Inverter Overlays   |
+-----------------------------------+   +-----------------------------------------------+
```

### Key Surveillance Features
1. **Embedded `go2rtc` Streaming Core:** Automatically starts and supervises `go2rtc`, converting RTSP camera feeds into modern browser-compatible WebRTC, MSE (Media Source Extensions), and HLS streams.
2. **Native C++ Hikvision Hardware Player Window:** Direct C++ SDK integration provides zero-copy, hardware-accelerated video decoding on multi-monitor workstations.
3. **Alarm-Triggered Incident Playback:** When a critical alarm or inverter trip occurs, the system records the exact video timestamp. Operators can click any alarm row to immediately jump to the corresponding video recording for the affected inverter bay.

---

## 11. Enterprise Security, Licensing & Tamper-Evident Audit

### 1. Dual-Role Access Control & Developer Authentication

The platform enforces a cryptographic per-role authorization model verified via `/api/auth/session`:

| Role Claim | Telemetry & Analytics | Plant Control & Setpoints | Grid Compliance Tests | Protected Admin & Topology |
| :--- | :---: | :---: | :---: | :---: |
| **Operator** | Full Read-Only | Authorized (MW Cap / %P / PF) | Authorized (T2/T3/T5) | Denied (Shared Display Only) |
| **Developer** | Full Read-Only | Full Access | Full Access | Full Access (Topology, Ports, Lifecycle) |

#### Developer Authentication Contract
- **Fixed Username:** `devClard` (accepted case-insensitively).
- **Rotating TOTP Password:** Uses dynamic `devMM` minute-based secret computed from the server's current minute with a $\pm 1$-minute clock-lag tolerance window.
- **Session Hardening:** Signed JWT/HMAC token stored in an `HttpOnly`, `SameSite=Strict` cookie.
- **Device Attribution:** Operational actions forward the hardware-bound `inverter_2_device_id` to maintain audit provenance regardless of login usernames.

### 2. Tamper-Evident Operational Audit Trail (`audit_log`)
Every operator interaction is recorded in an append-only audit ledger:
- **Captured Metadata:** Operator Username, Device ID (`inverter_2_device_id`), Client IP Address, Timestamp, Target Inverter/Node, Action Taken (e.g. `SET_MW_CAP`, `APC_DISPATCH`, `START_INVERTER`, `STOP_INVERTER`), Previous Setpoint, New Setpoint, and Operator Rationale.
- **Audit Export:** Exportable to signed CSV and PDF audit logs for regulatory inspections.

### 3. Node-Locked Hardware Licensing & Remote Locks
- Software licenses are cryptographically locked to host machine hardware profiles (CPU ID, Motherboard UUID, Primary MAC).
- **Remote Client Lock Invariant:** Populating the *Server Host URL* at sign-in locks the instance into Remote Client mode, disables local-server lifecycle handlers, and strictly isolates the Remote API Token from operator credentials.

---

## 12. Multi-Platform Responsive UI/UX Design System

The frontend interface is built with high-density industrial SCADA design principles, strictly following the project's Golden Rules:

### Golden Rules & Design Invariants

1. **Strict Desktop Protection (`> 768px`):**
   - Desktop view (`> 768px`) must remain 100% intact, pristine, and verified across all resolutions (1080p, 1440p, 4K multi-monitor arrays).
2. **Mobile Scope Enforcement (`≤ 768px`):**
   - All mobile-specific styles and layout overrides are encapsulated inside `@media screen and (max-width: 768px)` at the bottom of `public/css/style.css`.
3. **Cache-Busting Protocol:**
   - Whenever edits are made to `style.css` or core scripts, the stylesheet query parameter in `index.html` is incremented (e.g. `<link rel="stylesheet" href="css/style.css?v=XX" />`).
4. **Input Overlap Prevention:**
   - Enforces `min-width: 0 !important; max-width: 100% !important; box-sizing: border-box !important; width: 100% !important;` inside semantic `<label class="...-field">` containers with top labels to prevent grid cell collisions on small screens.
5. **Structured 2-Row Sub-Navigation Tab Bar:**
   - Zero horizontal scrolling. Rendered as an on-screen structured 2-row grid:
     - **Row 1 (APC Category):** `APC` Badge + 3 tabs (`MW Cap`, `%P Setpoint`, `Grid Code`).
     - **Row 2 (Grid Tests Category):** `GRID TESTS` Badge + 4 tabs (`T2 Freq`, `T3 Q-V`, `T5 Sweep`, `Reports`).
6. **Tablet & Intermediate Responsive Viewports (769px–1200px):**
   - Full-width stacked top cards (`Selected Date Summary` and `Day-Ahead vs Actual MWh`) with dynamic 3-column metric grids and auto-expanding 24-hour generation charts.

---

## 13. Comprehensive API Reference & IPC Message Dictionary

### 1. Core REST Endpoints Catalog

| Method | Endpoint Route | Access Role | Description & Functionality |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/telemetry/live` | Viewer+ | Streams instantaneous 1-second telemetry for all 27 inverters (108 units). |
| `GET` | `/api/telemetry/history` | Viewer+ | Retrieves historical 5-minute aggregated parameter buckets for a given date range. |
| `POST` | `/api/plant-cap/set` | Operator+ | Configures closed-loop MW Cap limits, control modes, and cooldown parameters. |
| `POST` | `/api/plant-cap/schedule` | Operator+ | Creates or updates an automated cron-based active power curtailment schedule. |
| `POST` | `/api/apc/dispatch` | Operator+ | Dispatches %P setpoints across Plant, Inverter, or Node scopes. |
| `POST` | `/api/grid-control/set` | Operator+ | Sets Power Factor ($\cos \varphi$) or kVAr reactive power regulation commands. |
| `POST` | `/api/compliance/run` | Operator+ | Initiates an automated T2 Frequency, T3 Q-V, or T5 Sweep compliance test. |
| `POST` | `/api/compliance/abort` | Operator+ | Immediately aborts any running compliance test and restores baseline operation. |
| `GET` | `/api/compliance/report/:id` | Viewer+ | Generates and downloads a formal vector PDF compliance test report. |
| `GET` | `/api/forecast/day-ahead` | Viewer+ | Returns the locked 24-hour day-ahead solar generation schedule. |
| `GET` | `/api/forecast/intraday` | Viewer+ | Returns the 15-minute rolling intraday virtual nowcast. |
| `GET` | `/api/igbt-health/scores` | Viewer+ | Returns 90-day IGBT thermal wear scores, unbalance metrics, and action plans. |
| `POST` | `/api/igbt-health/ack-block`| Admin | Acknowledges and clears a latched 0x0240/0x0210 precursor critical block. |
| `GET` | `/api/cctv/streams` | Viewer+ | Returns available `go2rtc` WebRTC/MSE video stream endpoints. |
| `POST` | `/api/backup/trigger` | Admin | Manually triggers an encrypted cloud/NAS database backup snapshot. |
| `GET` | `/api/audit/logs` | Admin | Retrieves paginated tamper-evident operational audit logs. |

### 2. Electron IPC Message Reference

| IPC Channel Name | Direction | Payload Parameters | Description |
| :--- | :--- | :--- | :--- |
| `server:get-status` | Invoke $\rightarrow$ Handle | None | Returns active server lifecycle state, port, and sub-service status. |
| `server:start` | Invoke $\rightarrow$ Handle | None | Starts background telemetry and forecast engines from UI. |
| `server:stop` | Invoke $\rightarrow$ Handle | None | Stops background engines cleanly while keeping UI active. |
| `hikvision-native-open` | Invoke $\rightarrow$ Handle | `{ requester, theme }` | Opens native C++ hardware-accelerated surveillance window. |
| `hikvision-native-close`| Invoke $\rightarrow$ Handle | `{ reason }` | Closes native surveillance window and releases hardware overlays. |
| `license-get-status` | Invoke $\rightarrow$ Handle | None | Queries node-locked license validity, expiration, and host ID. |
| `license-upload` | Invoke $\rightarrow$ Handle | `{ licenseFile }` | Installs and cryptographically verifies a new license certificate. |
| `app-update-check` | Invoke $\rightarrow$ Handle | None | Checks for OTA software updates against authorized repository. |
| `save-adsibak` | Invoke $\rightarrow$ Handle | None | Creates a complete `.adsibak` system configuration archive. |
| `open-adsibak` | Invoke $\rightarrow$ Handle | None | Restores plant configuration from a verified `.adsibak` archive. |

---

## 14. System Verification, Quality Assurance & Test Architecture

The ADSI Inverter Dashboard maintains a rigorous 100% automated test suite combining Node.js unit/integration tests and Python pytest suites:

```
────────────────────────────────────────────────────────────
  Automated Smoke & Integration Test Suite (`scripts/smoke-all.js`)
────────────────────────────────────────────────────────────
  ✓ Node.js Test Suites:   115 / 115 PASS (100%)
  ✓ Python Pytest Suites:  617 / 617 PASS (2 skipped, 100%)
  ✓ Total Test Execution:  ~55 seconds wall time
  ✓ Status:                ALL SUITES GREEN
────────────────────────────────────────────────────────────
```

### Critical Test Suites Overview

1. **`dailyAggregatorCore.test.js` (26 Scenarios):** Validates 5-minute bucket aggregation, monotonic counter gates, Asia/Manila solar window boundaries, reaped-slot LRU caches, and bitwise alarm consolidation.
2. **`forecastWatchdogSource.test.js` & `dayAheadPlanImplementation.test.js`:** Verifies forecast supervisor boot sequences, fail-safe operation mode fallbacks, and Day-Ahead advisory locking.
3. **`stopReasonAggregator.test.js` & `stopReasonsCrossCheck.test.js`:** Tests cross-table MotParo and standard error code deduplication across 5-minute temporal windows.
4. **`shutdownSerialization.test.js`:** Multi-iteration verification of zero database locks or process leaks during abrupt application restarts.
5. **`topologyAuthLease.test.js`:** Tests 60-minute rolling cryptographic lease issuance, expiration, renewal, and 429 rate-limiting.
6. **`xlsxExportStyling.test.js`:** Validates multi-year telemetry spreadsheet generation, cell formatting, and mathematical sum formulas.
7. **`hikvisionHybridMode.test.js` & `s3Provider.test.js`:** Tests camera failover modes and S3 multipart backup upload pipelines.
8. **`linuxDeploymentContract.test.js`:** Validates Linux systemd unit contracts, environment flags, and path invariants.

---

## 15. Linux & Windows Industrial Deployment, Hardening & Maintenance

### 1. Canonical Linux Appliance Installation (`LINUX-INSTALL-UPDATE-GUIDE.md`)

For industrial edge servers (Ubuntu 22.04/24.04 LTS or Debian 12), the canonical installation is a **single-command curl bootstrap**:

```bash
sudo bash -c 'command -v curl >/dev/null || { apt-get update -qq && apt-get install -y -qq ca-certificates curl; }; curl -fsSL https://raw.githubusercontent.com/mclards/Inverter-Dashboard/main/deploy/linux/install.sh | bash'
```

#### Automated Appliance Provisioning Features
1. **Repository & Runtime Paths:** Deploys code to `/opt/inverter-dashboard` and persistent runtime root to `/var/lib/inverter-dashboard/{db,archive,backups,auth}`.
2. **Systemd Service Hierarchy (`inverter.target`):**
   - `inverter.target` (Master Target)
   - `inverter-server.service` (Node.js API Orchestrator / Port 3500)
   - `inverter-engine.service` (Python Inverter Modbus Telemetry / Port 9100)
   - `inverter-forecast.service` (Python Solar Forecast Worker / Port 9200)
   - `inverter-go2rtc.service` (CCTV Video Proxy Engine / Port 1984)
3. **Automated Health Check:**
   ```bash
   sudo /opt/inverter-dashboard/deploy/linux/scripts/inverter-health-check.sh
   ```
4. **Tailscale & Security Enrollment:** Automatically provisions and enables `tailscaled` with Tailscale SSH while preserving existing tailnet machine identity.
5. **Database Integrity Hook:** Executes `PRAGMA quick_check;` via `adsi-db-check.sh` on every server boot before socket binding.

### 2. Linux Zero-Collision Maintenance Rule
> [!IMPORTANT]
> **Zero-Collision Maintenance Rule:**
> **ALWAYS** explicitly stop all inverter services (`sudo systemctl stop inverter.target inverter-server inverter-engine inverter-forecast inverter-go2rtc`) before executing manual code updates, database replacements, or large file migrations.
> Restart services (`sudo systemctl start inverter.target`) only after all files and permissions (`chown -R adsi:adsi /var/lib/inverter-dashboard`) are finalized.

### 3. Windows Deployment & NSIS Packaging (`scripts/installer.nsh`)
- Standalone Windows installer packaging with bundled Node runtime, compiled Python binaries (`InverterCoreService.exe`, `ForecastCoreService.exe`), canonical path resolution to `C:\ProgramData\Inverter-Dashboard\db`, firewall automation, and code signature verification (`Sectigo` thumbprint `7A3DE7F937C44A2A7EE1C0B51745EE2189CC0958`).

---

## 16. System Evaluation, Resilience Audit & Operational Recommendations

### 1. Architectural Strengths & High-Resilience Features
* **Zero-Single-Point-of-Failure Storage:** SQLite WAL architecture combined with monthly archive sharding and crash-recovery energy reconstruction ensures zero data loss during power outages or unexpected server terminations.
* **Complete Grid Code Tooling:** Built-in automated T2, T3, and T5 compliance testing with automated PDF generation eliminates the need for expensive third-party external test sets during annual utility re-certification.
* **Proactive Asset Protection:** 0x0240/0x0210 precursor alarm pattern detection and phase unbalance monitoring protect high-value IGBT power stacks from catastrophic thermal or electrical breakdown.
* **Ultra-Low Resource Footprint:** Lightweight memory profile (Node.js + Python asyncio) designed to run 24/7 on fanless industrial edge computers without performance degradation.

### 2. Operational Recommendations & Best Practices

1. **Dedicated Network Interface:** The gateway machine should connect to the plant inverter Ethernet switch via a dedicated industrial network interface card with static IP assignment in the `192.168.1.0/24` subnet.
2. **Secondary Backup Target:** Configure an external USB storage drive or network-attached storage (NAS) target for secondary synchronization of the `storage/db/backups/` and `storage/db/archive/` directories.
3. **Scheduled Maintenance:** Perform quarterly visual inspections of inverter cooling fans and air intake filters whenever the 90-day IGBT Health score indicates rising $\Delta T$ trends.
4. **Log & Database Pruning:** System retention workers automatically manage hot database size. Do not manually delete `.db-wal` or `.db-shm` files while services are running.

---

*Document compiled and verified by ADSI Systems Architecture & Field Engineering Teams.*

