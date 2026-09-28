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

---

## 8. Ingeteam Inverter Commboard Hardware Ecosystem & Topologies

- **Dual-Generation Commboard Fleet (27 Plant Inverters):**
  - **Modern Embedded Linux Generation (`AAX1031CN` / `AAX0057`):**
    - Installed on Inverters: 2, 8, 9, 10, 11, 13, 14, 16, 17, 18, 24, 25, 26.
    - Operating System: Embedded Linux (`rootfs.squashfs`, Barebox bootloader, Linux kernel `zImage`).
    - Internal Services: Lighttpd Web Gateway (port 80), `opkg` package manager, `firmwarizer` DSP management daemon, `ingeteam.upgrader`.
    - Internal Inter-Process / CAN Bridge: Internal port `7128` connects the commboard directly to the Freescale DSP56807 power units.
    - REST & Authentication: HTTP Basic Auth (`adsi2025:adsi2025`), endpoints for network (`/network/config/interface/ethprimary`), package manager (`/system/package-manager/*`), firmware storage (`/firmwarizer/*`), and hardware inventory (`/plant/devices`).
  - **Legacy Boa / RTOS Generation (2014):**
    - Installed on Inverters: 1, 3, 4, 5, 6, 7, 12, 15, 20, 21, 22, 23, 27.
    - Architecture: Legacy Boa Webserver / eCos RTOS board.
    - Fixed firmware, non-upgradable via modern `.ipk` packages; requires direct RS-485 / Modbus flashing via Ingecon Sun Manager (ISM).

---

## 9. Ingeteam Cloud Update Architecture & Repository Protocol

- **Upstream Repository Structure:**
  - Base Repository URL: `https://www.ingeras.es/inverters/repos/`
  - Master Package Catalog: `https://www.ingeras.es/inverters/repos/Packages.gz`
- **Dynamic Timestamp Naming Scheme (Resolving the 404 Mystery):**
  - Ingeteam's HTTP server does **not** host packages with static filenames (e.g. requesting `AAV1003BD.ipk` directly returns HTTP 404).
  - All package files are prefixed with automated build timestamps:
    $$\text{Build Timestamp} + \text{Package Name} \longrightarrow \mathbf{20260924021003\_AAV1003BD.ipk}$$
  - The commboard's package manager queries `Packages.gz`, which contains the authoritative manifest mapping package identifiers (`Package: aav1003`, `Version: 1.30500.0.0`) to their exact timestamped filename, MD5 checksum (`789a646fb8449c858c5658fb4e4c4b76`), and file size (`73,302 bytes`).
- **Telemetry & Cloud Broker Tunnels:**
  - Commboards attempt mutual TLS (mTLS) outbound to Ingeteam broker `194.30.98.71:8883` using factory x509 client certificates (e.g. `03M132519A13`).
  - Secondary fallback: OpenVPN tunnel to `vpn.ingeconsunmonitor.com` (`194.30.98.70`).
- **Offline Air-Gap Deployment Strategy:**
  - Inverters on isolated plant LANs do not need internet access. The captured `.ipk` can be pushed directly to modern commboards via their web interface (`http://192.168.1.x/#/main/firmware`) or via HTTP POST to `/firmwarizer/upload`.

---

## 10. Inverter Firmware Binary Encodings: `.ipk`, `.afd`, and `.S`

- **Debian IPK Container (`.ipk`):**
  - Format: Standard `ar` archive (`debian-binary`, `control.tar.gz`, `data.tar.gz`).
  - Target Payload:
    - `/var/lib/ingeteam/rmaps/AAV1003BD.json`: Complete Modbus register holding and input map.
    - `/var/lib/ingeteam/firmwares/AAV1003BD.DSP807.afd`: Compiled Freescale DSP56807 binary image.
- **Advanced Firmware Data (`.afd`) Container Structure:**
  - **Header (Bytes 0x000–0x1B0):**
    - Architecture ID: `iarch-AAA0060IKF03`
    - Hardware Family: `INGECON SUN Power Max X`
    - Serial Regex Match: `^[0-9][0-9][0-9]......[B-HRJ]`
    - Protocol & Target DSP: `ModbusAA`, `DSP807`
    - Firmware Revision: `AAV1003BD`
    - Bootloader Compatibility Requirement: `XXX1000`
  - **Internal Flashing Sequence Frames (Modbus / Port 7128):**
    - Command `0x90`: Flash prepare / block erase.
    - Command `0x91`: Flash block write (`0x0191 [addr:2] [nwords:2] [data: nwords*2]`). Words stored as 16-bit little-endian.
    - Command `0x92`: Flash verify / end-of-programming trailer.
- **Memory Map Partitioning (DSP56807):**
  - **Program Flash (PFlash):** Word addresses `0x00000004 .. 0x0000DFCF` (57,291 words = 114,582 bytes in BD).
  - **Secondary Bootloader (PFlash2):** Word addresses `0x0000F800 .. 0x0000FDFC` (1,532 words = 3,064 bytes).
  - **RAM Execution Buffer:** Word addresses `0x00200040 .. 0x00200169` (297 words).
  - **Data Flash (XFlash):** Word addresses `0x00202000 .. 0x002029A6` (2,470 words = 4,940 bytes in BD).
    - Contains ASCII firmware identity banner at `0x00202000` (`"AAV1003 BD"`).

---

## 11. Ingecon Sun Manager (ISM) Node Flashing & Motorola S-Record Reconstruction

- **Ingecon Sun Manager (ISM) Protocol Requirements:**
  - ISM desktop utility flashes individual inverter power nodes (N1–N4) via direct RS-485 / Modbus.
  - ISM rejects raw `.afd` or `.ipk` files; it strictly requires Motorola S-record files (`.S` / `.s`).
  - ISM's `ValidaFicheroS` engine validates that the `.S` file contains:
    - Standard S0 Header: `S0110000000050524F4752414D264441544196` ("PROGRAM&DATA").
    - Continuous Program Flash (`NumTramasPFlash`).
    - Bootloader Flash (`NumTramasPFlash2`).
    - Application Data Flash (`NumTramasXFlash`).
    - Termination Record S7 with valid execution entry point (`S7050000B153F6`).
- **Conversion Pipeline (`scripts/convert_afd_to_s.py`):**
  - Transforms native 16-bit little-endian `.afd` machine code words to big-endian Motorola format.
  - Slices memory streams into 38-word (76-byte) records (`S351...`).
  - Synthesizes 100% mathematically valid one's complement checksums.
  - Verified outputs:
    - `D:\INVERTER\FIRMWARE\AAV1003IJK01BD.S` (272,384 bytes, 1,625 lines, 0 checksum errors).
    - `D:\Inverter-Dashboard\firmware\AAV1003BD.s` (272,384 bytes).

