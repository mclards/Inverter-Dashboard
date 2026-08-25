# Master Architecture Blueprint â€” ADSI Inverter Dashboard 2.0

**Project Name:** Inverter Dashboard (ADSI Inverter Dashboard 2.0)  
**Target Repository:** `D:\Inverter-Dashboard` (Standalone, preserving legacy `ADSI-Dashboard` untouched)  
**Architecture Model:** Pure Client-Server Model (inspired by `edocflow` + proven industrial cores)  
**Status:** IN PROGRESS (Phases 1, 2, 3 Complete; Phase 4 Active)  

---

## Progress Status Summary

- [x] **Phase 1: Repository Foundation & Core Server Setup** *(Completed â€” Git `5e49dee`, `a98a613`)*
  - Initialized `D:\Inverter-Dashboard` with clean modular structure.
  - Built Express Gateway (`backend/server.js`) on Port 3500.
  - Implemented SQLite database layer (`backend/core/db.js`) with WAL mode, 10s busy timeout, and multi-year archive resolution.
  - Tested REST endpoints (`/api/health`, `/api/config/connect-urls`) with 100% pass rate.
- [x] **Phase 2: Device Identity & Multi-Controller Personalization** *(Completed)*
  - Implemented `deviceRegistry.js` (`client_devices` table) tracking unique `deviceId`, controller friendly names, and server-persisted themes.
  - Built `controlArbiter.js` single-writer 60s sliding mutex guard for all inverter write commands.
  - Integrated `websocket.js` real-time telemetry and live control lock broadcast hub.
- [x] **Phase 3: Engine Integration & Strict Path Isolation** *(Completed â€” Git `25a9e39`, `4c32552`)*
  - Ported Modbus Telemetry Engine (`InverterCoreService.py`) into `backend/engines/inverter/`.
  - Ported Solar AI Forecast Engine (`ForecastCoreService.py`) into `backend/engines/forecast/`.
  - Ported go2rtc live camera streaming manager (`go2rtcManager.js`) into `backend/engines/go2rtc/`.
  - **Strict Path Isolation:** Auto-detects `D:\Inverter-Dashboard\storage\` (and uses `inverter.db`), strictly bypassing legacy `C:\ProgramData\InverterDashboard`.
- [ ] **Phase 4: Frontend Modernization & Modular Layouts** *(CURRENT)*
  - Port core responsive UI components (Overview, Analytics, Plant Cap, Data Export) into `frontend/public/`.
  - Wire WebSocket live telemetry and live single-writer lock ownership banner.
  - Multi-theme engine (Dark Navy, Solar Amber, High-Contrast, Cyberpunk).
  - Verify Golden Rules 1, 2, 4, 5 (pristine desktop + zero-collision mobile).
- [ ] **Phase 5: Desktop App & Production Deployment Suite** *(Upcoming)*
  - Configure `desktop/` wrapper (`edocflow/desktop` pattern) with server URL picker and QR connect codes.
  - Create 18-step hardened Linux appliance setup script (`deploy/linux/setup.sh`) and systemd unit suite (`inverter.target`).

---

## 1. Complete Path & Namespace Isolation Matrix

| Component | Legacy InverterDashboard | Inverter Dashboard 2.0 | Isolation Status |
|---|---|---|---|
| **Windows ProgramData** | `C:\ProgramData\InverterDashboard` | `D:\Inverter-Dashboard\storage\` (or `C:\ProgramData\InverterDashboard-2.0`) | **100% Isolated** |
| **Active SQLite File** | `adsi.db` | `inverter.db` (with `adsi.db` import fallback) | **100% Isolated** |
| **Desktop AppData** | `%APPDATA%\inverter-dashboard` | `%APPDATA%\InverterDashboard-2.0` | **100% Isolated** |
| **Linux Runtime Path** | `/var/lib/adsi-dashboard/` | `/var/lib/inverter-dashboard/` | **100% Isolated** |
| **Linux Systemd Suite** | `adsi.target` (`adsi-*.service`) | `inverter.target` (`inverter-*.service`) | **100% Isolated** |
| **Local Storage Key** | `adsi-auth`, `adsi-settings` | `inverter_2_device_id`, `inverter_2_theme` | **100% Isolated** |

---

## 2. Directory Structure (`D:\Inverter-Dashboard`)

```
Inverter-Dashboard/
â”œâ”€â”€ backend/                  # Server API & Microservice Gateway (:3500)
â”‚   â”œâ”€â”€ api/                  # Modular Route Controllers (Telemetry, Control, Forecast, Cameras, Config)
â”‚   â”œâ”€â”€ core/                 # Core Subsystems (Device Registry, Control Arbiter, DB Layer, WebSockets)
â”‚   â”œâ”€â”€ engines/              # Industrial Engines (Inverter Modbus, Solar AI Forecast, go2rtc)
â”‚   â””â”€â”€ server.js             # Express Gateway Entry Point
â”œâ”€â”€ frontend/                 # Universal Responsive Web Dashboard
â”‚   â””â”€â”€ public/               # HTML5, CSS3, JS Modules, Theme Engine, Material Icons
â”œâ”€â”€ desktop/                  # Lightweight Electron Desktop Wrapper
â”‚   â”œâ”€â”€ main.js               # Clean Electron window loader
â”‚   â”œâ”€â”€ config.js             # Server connection resolver
â”‚   â””â”€â”€ package.json
â”œâ”€â”€ deploy/                   # Production Deployment Suite
â”‚   â”œâ”€â”€ linux/                # Hardened 18-step Linux setup & systemd units
â”‚   â””â”€â”€ windows/              # One-click Windows deployment & launchers
â””â”€â”€ storage/                  # 100% Isolated Master Server Storage
    â”œâ”€â”€ db/                   # inverter.db + multi-year archive/*.db
    â”œâ”€â”€ config/               # ipconfig.json
    â”œâ”€â”€ auth/                 # credentials.json
    â””â”€â”€ programdata/          # forecast models, weather, snapshots
```

---

## 3. Verification & Testing Matrix

| Test Category | Target Objective | Status | Verification Result |
|---|---|---|---|
| **Database & Archive** | Resilient SQLite with WAL mode & busy timeout | **PASSED** | Verified table creation and archive query compatibility |
| **Device Identity** | Multi-controller friendly name & server-persisted theme | **PASSED** | Registered test device (`Shift Tech Laptop` â€” Mark) |
| **Control Safety** | Single-writer 60s mutex lock prevents write collisions | **PASSED** | Acquired lease with sliding expiration & conflict rejection |
| **Reachable Network** | Auto-discovery of Tailscale, LAN, and Localhost IPs | **PASSED** | Enumerated `100.115.222.36:3500`, `192.168.23.154:3500` |
| **Engine Porting** | Modbus & AI forecast engines isolated in 2.0 | **PASSED** | Ported and verified isolated storage path resolution |
| **Responsive UI** | Zero mobile overflow and pristine desktop layout | *Pending* | To be executed in Phase 4 |

