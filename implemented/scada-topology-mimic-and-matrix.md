# SCADA Inverter Topology Mimic & Fullscreen Plant Matrix

## Overview
This implementation upgrades the Inverter Topology display into a full-screen, authentic industrial SCADA supervisory GUI. It supports both Single Line Diagram (SLD) vector plant mimics and high-density 27-Inverter plant matrix views, equipped with realtime active power metrics, electrical telemetry gauges, dynamic power flow animations, and deep-dive inverter diagnostics.

---

## 1. SCADA Display Architecture

### 1.1 Dual-View Presentation Engine
The new topology viewport supports two synchronized operational views accessible via buttons or keyboard shortcuts (`1` and `2`):

1. **SLD Mimic Diagram (View 1):**
   - Vector-accurate Single Line Diagram connecting Central Inverters across Blocks 1 through 13 to the central Substation / SCADA bus.
   - Every inverter displays:
     - Inverter ID (`INV 01` .. `INV 27`).
     - Digital Realtime Active Power ($P_{ac}$) readout (e.g. `645.2 kW`).
     - Proportional power meter gauge bar ($0–1000\text{ kW}$ capacity).
     - Color-coded status states: Generating (emerald green glow), Standby (cyan/blue), Offline (crimson), and Alarm (amber).
   - Dynamic power flow lines: when inverters within a block are producing active power, interconnection links animate with dashed directional flow marches (`animation: link-power-flow 1.2s linear infinite`).
   - Smooth viewport pan & zoom (wheel zoom, mouse drag pan, fit-to-screen, $100\%$ reset).

2. **SCADA Inverter Matrix (View 2):**
   - Full-screen, high-density industrial grid grouping all 27 central inverters into their physical plant Blocks 1 to 13.
   - Aggregate Block Active Power displayed on each block header.
   - Industrial SCADA Inverter Tile Cards:
     - Card Header: Inverter badge, Block indicator, Operational status pill (`GENERATING`, `STANDBY`, `OFFLINE`, `ALARM`).
     - Hero Power Readout: Large high-contrast LED active power display in kW with percentage of nominal $1000\text{ kW}$ load.
     - 4-Node Unit Mini Strip: Real-time telemetry for nodes `N1`, `N2`, `N3`, and `N4` (individual kW generation or offline state).
     - Metrics Grid: DC bus voltage ($V_{dc}$), DC total current ($I_{dc}$), 3-phase AC voltage ($V_{ac}$), and maximum heatsink temperature ($T_{hs}$).
     - Direct click-to-diagnose interaction opening the slide-over deep-dive drawer.

---

## 2. Plant-Wide Digital SCADA KPIs
The master SCADA header bar features high-contrast digital LED readouts continuously aggregating plant-wide electrical metrics:
- **Total Active Power ($P_{ac}$):** Total real-time generation in MW across all 27 central inverters.
- **Grid Frequency ($F_{ac}$):** PCC frequency in Hz (nominal 60.00 Hz).
- **Bus AC Voltage ($V_{ac}$):** Plant average line-to-line AC voltage.
- **Reactive Power ($Q_{ac}$):** Fleet reactive power in MVAr and displacement power factor ($\cos\phi$).
- **Online Fleet Counter:** Ratio of online inverters (e.g., `27 / 27 Inv`) and active node units.
- **Plant Load Gauge Bar:** Visual generation progress ($0\%–100\%$) against the plant's 27.00 MW nameplate capacity.

---

## 3. Realtime Telemetry Acquisition & Resilience

- **Dual-Transport Telemetry:**
  - Primary: Low-latency WebSocket streaming over `ws://${location.host}/ws` subscribing to `live`, `init`, and `offline` broadcasts.
  - Secondary: Automatic fallback to HTTP polling (`/api/live`) every 1500 ms when WebSocket is disconnected or in restricted proxy environments.
- **Remote / Gateway Mode Agnostic:**
  - Removed client-mode restrictions (`ensureGatewayModeForWindow`) in Electron so Remote client workstations can launch the full SCADA Topology window while streaming live data from the authoritative gateway.
- **Settings Integration:**
  - Added "Fullscreen SCADA Topology" buttons directly to the `inverterTopologySection` header and action bars.
  - Wired `[Inverter Topology]` in Settings to open the section with one-click full-screen launch.

---

## 4. Verification Evidence

1. **Syntax & Compilation:**
   - `node --check electron/main.js` passed.
   - `node --check public/js/app.js` passed.
2. **Asset Pairing:**
   - `public/topology.html` and `frontend/public/topology.html` verified 100% byte-for-byte identical (SHA-256 match).
   - `public/index.html` and `frontend/public/index.html` verified 100% byte-for-byte identical (SHA-256 match).
   - `public/js/app.js` and `frontend/public/js/app.js` verified 100% byte-for-byte identical (SHA-256 match).
3. **Automated Smoke Test Suite:**
   - `node scripts/smoke-all.js --skip-python --no-rebuild`
   - **Verdict: 119 / 119 Node tests pass (100% pass rate).**

---

## 5. Header Streamlining & Vector Pan/Zoom Engine Refactor

### 5.1 Single-Line Industrial Header (Logo Box Removed)
- Replaced the bulky, double-stacked header (`#scada-header` 72px + `#scada-subbar` 44px with large logo images and wrapping titles) with a single, streamlined 52px high-tech industrial command toolbar.
- Layout:
  - **Left:** View Mode Switcher (`[⚡ SLD Mimic]` | `[🎛️ Plant Matrix]`) and Telemetry Comm Status badge (`[● LIVE WS]`).
  - **Center:** Industrial digital gauges for $P_{ac}$ (MW, LED emerald glow), Grid Frequency ($F_{ac}$ in Hz), Bus Voltage ($V_{ac}$ in V), Fleet Online count (`X / 27`), and inline generation load progress bar ($0–27\text{ MW}$).
  - **Right:** Filter chips (`All 27`, `Gen`, `On`, `Off`, `Alm`), Theme switcher (`🌓`), Fullscreen toggle (`⛶`), Config gear (`⚙️`), and digital SCADA clock (`HH:MM:SS`).
- Eliminated horizontal header scrollbars and multi-line wrapping across standard monitor resolutions.

### 5.2 Vector ViewBox Zoom & Pan Engine
- **Root Cause of Zoom Bug:** The previous implementation used CSS `transform: scale()` on an SVG inside a flexbox centering container. This prevented the scroll container from tracking the scaled content dimensions, caused negative-overflow clipping, and resulted in degenerate scale calculations (such as collapsing to 33%).
- **Resolution:**
  - Implemented standard SVG ViewBox coordinate transformation (`BASE_VB = { x: 0, y: 0, w: 581, h: 628 }`).
  - Set SVG to `width: 100%; height: 100%; display: block;` with `preserveAspectRatio="xMidYMid meet"` for native, GPU-accelerated centering and viewport fitting.
  - **Cursor-Anchored Wheel Zoom:** Uses `mainSvg.getScreenCTM().inverse()` to calculate mouse coordinates in SVG space, zooming smoothly and keeping the targeted element anchored under the cursor.
  - **Pixel-Accurate 1:1 Pan Drag:** Pointer events track movement via `dx / ctm.a` and `dy / ctm.d`, providing smooth panning.
  - **Drag vs. Click Disambiguation:** Tracks pointer travel distance (`panMoved`); dragging the canvas no longer accidentally triggers the Inverter Diagnostics Drawer.
  - **Fit to Screen:** Reset button, keyboard shortcut `0`, and canvas double-click immediately re-center and fit the plant diagram at 100% resolution.
  - **Status Legend:** Floating bottom-right indicator clearly denoting Generating, Standby, Offline, and Alarm states.
