# ADSI Inverter Dashboard 2.0 (Inverter Dashboard)
### Industrial Solar SCADA, AI Day-Ahead Forecasting & Telemetry Engine

**Designed & Developed by Engr. Clariden Montaño REE (Engr. M.)**  
*Self-hosted · Local-First · Pure Client-Server · Single Source of Truth*

---

## 1. System Architecture

```
                       ┌─────────────────────────────────────────────────────────────┐
                       │                     ADSI Server Backend                     │
                       │           (Linux Server / 24/7 Appliance / Local)           │
                       │                                                             │
                       │  • Port 3500: Express Web Gateway & WebSockets              │
                       │  • Port 9100: Inverter Modbus Telemetry Engine (Python)     │
                       │  • Background: Solar AI Day-Ahead Forecasting Engine        │
                       │  • Ports 1984/8555: go2rtc Live Video Streaming (WebRTC)    │
                       │  • Authoritative SQLite Master Storage (`adsi.db` + shards) │
                       │                                                             │
                       │  [Core Security & SCADA Protection]                         │
                       │  ├── Device Registry (`client_devices` table)               │
                       │  ├── Server-Side Personalization (Themes/Views by Device)   │
                       │  ├── Single-Writer Control Lease (60s Inverter Write Mutex) │
                       │  └── Full SCADA Audit Logger (Device ID, IP, Action)        │
                       └──────────────────────────────┬──────────────────────────────┘
                                                      │ REST APIs & WebSockets
                      ┌───────────────────────────────┼──────────────────────────────┐
                      ▼                               ▼                              ▼
             ┌─────────────────┐             ┌─────────────────┐            ┌─────────────────┐
             │   Web Browser   │             │  Desktop Client │            │   Mobile/Tablet │
             │  (Chrome/Edge)  │             │ (Electron Shell)│            │   (Field PWA)   │
             │ Multi-User View │             │  Lead Engineer  │            │ Shift Tech View │
             └─────────────────┘             └─────────────────┘            └─────────────────┘
```

---

## 2. Directory Structure

```
Inverter-Dashboard/
├── backend/                  # Server API & Microservice Gateway (:3500)
│   ├── api/                  # Modular Route Controllers (Telemetry, Control, Forecast, Cameras, Config)
│   ├── core/                 # Core Subsystems (Device Registry, Control Arbiter, DB Layer, WebSockets)
│   ├── engines/              # Industrial Engines (Inverter Modbus, Solar AI Forecast, go2rtc)
│   └── server.js             # Express Gateway Entry Point
├── frontend/                 # Universal Responsive Web Dashboard
│   └── public/               # HTML5, CSS3, JS Modules, Theme Engine, Material Icons
├── desktop/                  # Lightweight Electron Desktop Wrapper
│   ├── main.js               # Clean Electron window loader
│   ├── config.js             # Server connection resolver
│   └── server.js             # Local standalone server launcher
├── deploy/                   # Production Deployment Suite
│   ├── linux/                # Hardened 18-step Linux setup & systemd units
│   └── windows/              # One-click Windows deployment & launchers
└── storage/                  # Authoritative Master Server Storage
    ├── db/                   # adsi.db + multi-year archive/*.db (27.5 GB Telemetry)
    ├── config/               # ipconfig.json
    ├── auth/                 # credentials.json
    └── programdata/          # forecast models, weather, snapshots
```

---

## 3. Quick Start

### Starting the Server:
```bash
# 1. Install Node.js dependencies
npm install

# 2. Install Python engine dependencies
python -m venv venv
venv\Scripts\activate      # On Windows (or source venv/bin/activate on Linux)
pip install -r requirements.txt

# 3. Start the Server Gateway
npm start
```
The server will boot on `http://localhost:3500`.

### Connecting from Any Device:
- Open `http://<server-ip>:3500` in any web browser.
- Or launch the native desktop shell: `npm run desktop`.
