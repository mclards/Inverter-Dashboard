# Ingeteam Inverter Firmware Ecosystem, Reverse-Engineering & Motorola S-Record Reconstruction

## 1. Executive Summary

This record documents the reverse-engineering of Ingeteam's firmware distribution architecture, the interception of official firmware release packages from Ingeteam's cloud infrastructure, the binary decomposition of Ingeteam's modern `.afd` (Advanced Firmware Data) container format, and the mathematical reconstruction of standard Motorola S-records (`.S`) required by **Ingecon Sun Manager (ISM)** for manual per-node inverter upgrades.

---

## 2. Problem Statement & Initial Constraints

1. **Dead Website / 404 Links:** Accessing `https://www.ingeras.es/inverters/repos/index.html` or querying direct file names such as `AAV1003BD.ipk` returned HTTP 404, leading operators to believe Ingeteam's update service was dead or decommissioned.
2. **Missing BD Package:** Operators required the modern revision **`AAV1003BD`** firmware for INGECON SUN Power Max X inverters. Older revision `BC` (`AAV1003BC.s` / `AAV1003IJK01BC.S`) was obsolete and incompatible with recent node hardware.
3. **Format Dichotomy:** 
   - Modern communication boards (`AAX1031CN` running embedded Linux) consume `.ipk` (Debian/opkg) packages containing binary `.afd` files.
   - Plant field technicians utilizing **Ingecon Sun Manager (ISM)** desktop software on field laptops require Motorola S-record (`.S`) files to flash individual power units (N1–N4) over RS-485 or Modbus.

---

## 3. Network Discovery & Live Cloud Interception

### A. Dual Commboard Generation Audit (27 Inverters)
- **Modern Linux Commboards (`AAX1031CN` / `AAX0057`):** Inverters 2, 8, 9, 10, 11, 13, 14, 16, 17, 18, 24, 25, 26.
  - Features: Lighttpd web server (port 80), `opkg` package manager, `firmwarizer` daemon, internal CAN/Modbus bridge (port 7128) to Freescale DSPs.
  - REST API Basic Auth: `adsi2025:adsi2025`.
- **Legacy Boa / RTOS Commboards (2014):** Inverters 1, 3, 4, 5, 6, 7, 12, 15, 20, 21, 22, 23, 27.
  - Fixed firmware, non-upgradable via `.ipk`. Requires direct RS-485 / Modbus flashing via ISM.

### B. Windows ICS Interception Setup
1. Laptop uplink: Wi-Fi connected to internet gateway (`192.168.4.145`).
2. Laptop plant link: `Ethernet 5` on plant LAN (`192.168.1.8/24`).
3. Windows Internet Connection Sharing (ICS) enabled on Wi-Fi adapter, NAT-routed to `Ethernet 5`.
4. Target Inverter 8 (`192.168.1.138`) configured via REST API:
   ```json
   POST /network/config/interface/ethprimary
   { "Ifc": "ethprimary", "Ip": "192.168.1.138", "SubnetMask": "255.255.255.0", "DefaultGateway": "192.168.1.8", "DHCP": false }
   ```
5. Triggered package update:
   ```json
   POST /system/package-manager/update
   POST /system/package-manager/install/aav1003
   ```
6. Wireshark Packet #10538 captured the outbound HTTP GET request to `www.ingeras.es`.

### C. Root Cause: Timestamped Package URLs
Ingeteam's package server prefixes all `.ipk` files with dynamic automated build timestamps:
$$\mathbf{20260924021003\_AAV1003BD.ipk}$$

Static requests like `AAV1003BD.ipk` fail with 404 because the server does not maintain alias symlinks. The commboard resolves the exact filename by downloading and parsing `https://www.ingeras.es/inverters/repos/Packages.gz`.

---

## 4. Master Ingeteam Repository Index (`Packages.gz`)

The captured `Packages.gz` catalog revealed the official, timestamped package identifiers for all Ingeteam product lines:

| Package Identifier | Target Hardware | Revision | Official Filename | Size | MD5 Checksum |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`aav1003`** | **INGECON SUN Power Max X (Freescale DSP56807)** | **BD** | `20260924021003_AAV1003BD.ipk` | `73,302 B` | `789a646fb8449c858c5658fb4e4c4b76` |
| `aav1057` | INGECON SUN 3Play / Storage | G | `20260924021002_AAV1057_G.ipk` | `24,916 B` | `3f0475ee090831b3ce0a6653d1383a08` |
| `aav1089` | INGECON SUN String / Central | Q | `20260924021003_AAV1089_Q.ipk` | `22,262 B` | `9aa943ec1520ceaed6287e27c52641df` |
| `abe1000` | INGECON EMS / Plant Controller | T | `20260924021002_ABE1000_T.ipk` | `135,446 B` | `bdee77765dc28486b37a5d0494835b1a` |
| `abh1002` | INGECON Smart R | AL | `20260924021002_ABH1002AL.ipk` | `140,742 B` | `2261bb5e3dc12e9895552a9af0640cca` |
| `abi1000` | INGECON Battery Storage Inverter | Q | `20260924021002_ABI1000_Q.ipk` | `129,176 B` | `05547b848eed4990b8ddc3eebfce93f5` |
| `abk1000` | INGECON Communication Board AAX | V | `20260924021003_ABK1000_V.ipk` | `186,864 B` | `f298e3c15969259ae2338dca59a70717` |
| `abu1000` | INGECON Power Control Unit | C | `20260924021003_ABU1000_C.ipk` | `252,784 B` | `7801a75a1e04a8162f53f24ec3d92cc6` |

---

## 5. Binary Reverse-Engineering of `.afd` (Advanced Firmware Data)

Decompressing `20260924021003_AAV1003BD.ipk` revealed:
1. `AAV1003BD.json` (`80,174 bytes`): Complete Modbus register schema for revision BD.
2. `AAV1003BD.DSP807.afd` (`121,280 bytes`): Native binary container.

### A. Container Header Specification
- **Offset `0x0000` (32 bytes):** Target architecture string: `iarch-AAA0060IKF03`.
- **Offset `0x0024` (60 bytes):** Platform description: `INGECON SUN Power Max X`.
- **Offset `0x0064` (32 bytes):** Hardware serial regex: `^[0-9][0-9][0-9]......[B-HRJ]`.
- **Offset `0x0084` (32 bytes):** Protocol identifier: `ModbusAA`.
- **Offset `0x00A4` (32 bytes):** Microcontroller target: `DSP807` (Freescale DSP56F807).
- **Offset `0x00C4` (32 bytes):** Firmware release name: `AAV1003BD`.
- **Offset `0x00E4` (32 bytes):** Bootloader prerequisite: `XXX1000`.
- **Offset `0x0106` (3 bytes):** Total payload size: `0x01D8B7` (`121,015 bytes`).

### B. Embedded Flashing Protocol Frames (Port 7128)
The `.afd` body is an array of raw Modbus/CAN flashing frames consumed directly by `firmwarizer`:
- **Command `0x90`:** Flash sector erase / initialize.
- **Command `0x91`:** Flash block write:
  - Byte 0: Unit ID (`0x01`)
  - Byte 1: Function code (`0x91`)
  - Bytes 2–3: Word address (Big-endian uint16, e.g. `0x0004`, `0x0200`, `0x0400`...)
  - Bytes 4–5: Word count (Big-endian uint16, e.g. `0x01FC` = 508 words, `0x0200` = 512 words)
  - Data: 16-bit words stored in little-endian order (e.g. `E9 C8` represents DSP word `0xC8E9`).
- **Command `0x92`:** Flash finalize and verification trailer (`0x0192 735A`).

---

## 6. Memory Map Partitioning & Motorola S-Record Reconstruction

Freescale DSP56800E microcontrollers utilize 16-bit word-addressed memory spaces. Motorola S-record files (`.S`) structure this memory into distinct 32-bit address blocks:

```
0x00000004 --------------------------------------- Program Flash (PFlash)
           | Main Inverter Application Firmware
           | (Control loops, PWM, Modbus stack)
           | 57,291 words (114,582 bytes)
0x0000DFCF ---------------------------------------
0x0000F800 --------------------------------------- Secondary Bootloader (PFlash2)
           | Factory DSP Boot ROM Flasher Driver
           | 1,532 words (3,064 bytes)
0x0000FDFC ---------------------------------------
0x00200040 --------------------------------------- RAM Execution Buffer
           | RAM scratch execution tables
           | 297 words (594 bytes)
0x00200169 ---------------------------------------
0x00202000 --------------------------------------- Data Flash (XFlash)
           | Firmware Banner ("AAV1003 BD") & Static
           | Operational Parameter Calibration Tables
           | 2,470 words (4,940 bytes)
0x002029A6 ---------------------------------------
```

### Conversion Pipeline (`scripts/convert_afd_to_s.py`)
1. Reads `AAV1003BD.DSP807.afd` and extracts all `0x91` frames.
2. Byte-swaps each 16-bit word (`low, high` $\to$ `high, low`) to conform to Motorola S-record big-endian representation.
3. Partitions blocks into PFlash (`0x00000004 .. 0x0000DFCF`) and XFlash (`0x00202000 .. 0x002029A6`).
4. Re-incorporates the standard DSP56807 secondary bootloader (`0x0000F800`) and RAM tables (`0x00200040`) required by ISM's `ValidaFicheroS` engine.
5. Emits 38-word (76-byte) `S3` records with mathematically verified one's complement checksums.
6. Emits `S7` termination record with execution start address `0x0000B153`.

---

## 7. Artifacts & Verification Summary

### Produced & Verified Files
1. **`D:\INVERTER\FIRMWARE\AAV1003IJK01BD.S`** (`272,384 bytes`, 1,625 lines)
   - Verified: 0 checksum errors, internal banner `"AAV1003 BD"` confirmed at `0x00202000`.
   - Co-located with operator's existing `AAV1003IJK01BA.S` and `AAV1003IJK01BC.S` for immediate selection in ISM.
2. **`D:\Inverter-Dashboard\firmware\AAV1003BD.s`** (`272,384 bytes`)
   - Dashboard-local reference copy.
3. **`D:\Inverter-Dashboard\firmware\AAV1003BD\20260924021003_AAV1003BD.ipk`** (`73,302 bytes`)
   - Official Ingeteam package container for LAN/web-based offline commboard upgrades.
4. **`scripts/convert_afd_to_s.py`**
   - Automated conversion and verification utility in the repository.

### Network State Verification
- Inverter 8 (`192.168.1.138`) restored: `DefaultGateway = 192.168.1.1` (MikroTik Plant Router).
- Inverter 2 (`192.168.1.102`) confirmed: `DefaultGateway = 192.168.1.1`.
- Plant telemetry and Modbus communication: Online, healthy, zero disruption to SCADA operations.

---

## 8. Calibration & Utility Tool UI Revamp & ISM Parity

### A. Operator Ergonomics & Modernized Visual System
To provide field technicians with a modern, high-precision utility interface matching Ingecon Sun Manager (ISM) capabilities while upholding the ADSI Design System:

1. **Dedicated View Toolbar:**
   - Unified card header with subtle glass backdrop, high-contrast typography, and quick icon badge (`mdi-tune-variant`).
2. **Dual-Transport Segmented Switcher:**
   - Replaced raw radio toggles with custom pill switcher (`Modbus/TCP (LAN)` and `Serial / RS-485`).
   - Active state synchronization (`.is-active`) across client-side logic.
   - Distinctive input groups for IP/port and COM/baudrate parameters with crisp focus highlights.
3. **Targeting & Safety Interlock Controls:**
   - Inverter (1..27) and Unit Node (1..4) selectors grouped into a visual targeting block.
   - Primary `Read` button elevated with subtle hover translation and distinct active states.
   - Safety force/bypass toggles (`.fcal-force-toggle`) styled as precision hardware switches with glowing amber "ARMED" state warning indicator to prevent unintended parameter writes.
   - Direct `FW Upgrade` trigger button with microchip accent styling.
4. **Segmented Functional View Tabs:**
   - Visual tab strip with SVG iconography:
     - `Calibration` (`mdi-tune-variant`)
     - `Node & Startup` (`mdi-chip`)
     - `Grid Protection` (`mdi-shield-check-outline`)
     - `Power & Reactive` (`mdi-lightning-bolt-outline`)
     - `Isolation & Temp` (`mdi-thermometer-alert`)
   - High-contrast active tab indicator with subtle elevation and accent borders.
5. **Firmware Upgrade Terminal & Dialog:**
   - Dark glass modal dialog (`backdrop-filter: blur(4px)`, 14px rounded corners).
   - High-contrast developer terminal (`#0d1117`, cyan/blue monospace `#79c0ff`) for real-time `firmwarizer` and S-record block write telemetry.
6. **Mobile Adaptability & Strict Desktop Protection:**
   - Complete responsive wrapping encapsulated within `@media screen and (max-width: 768px)`.
   - Desktop viewports (`> 768px`) remain 100% pixel-perfect and intact.
