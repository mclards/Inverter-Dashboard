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

---

## 6. Widescreen 16:9 Landscape Mimic Polish & Hardware-Grade CAD Styling

### 6.1 Design Motivation & Simulator Parity
- Modeled after the dark industrial CAD styling of the ESP32 hardware simulator (`D:\PROJECTS_IO\Plastic-Bottle-Vending-Machine`): deep `#070d18` canvas with subtle 32px technical grid, dark slate panels (`#081120`), 1px high-contrast status borders, corner mounting rivets (`#334155`), and crisp monospace readouts with zero blurry neon bloom halos.

### 6.2 Widescreen Aspect Ratio & Screen Maximization
- Replaced the portrait/square `581 x 628` viewBox with a native widescreen landscape `1360 x 680` viewBox (~2:1 aspect ratio).
- Eliminated giant horizontal empty voids on modern 16:9/16:10 displays while preventing vertical clipping of bottom inverters (`INV 01`, `INV 02`).
- Updated `BASE_VB` in the pan/zoom engine to `{ x: 0, y: 0, w: 1360, h: 680 }`.

### 6.3 Lowered Substation / SCADA Gateway Unit
- Moved `SUBSTATION / SCADA` down from the ceiling (`cy=20`) to a balanced upper-center focal point (`x=520..840`, `y=55..133`).
- Redesigned as a high-voltage substation switchgear unit featuring:
  - Dual interlocking IEEE step-up transformer graphic (`30 MVA XFMR`).
  - Terminal ports for `FEEDER 1 (WEST)` and `FEEDER 2 (EAST)`.
  - Grid intertie status ratings (`69 kV / 34.5 kV STEP-UP`, `PCC BUS: 115 kV`, `60.00 Hz INTERTIE`).

### 6.4 100% Orthogonal Feeder Routing & Combiner Switchgear Boxes
- Routed all 14 electrical feeder links (`link-block5-server`, `link-block7-server`, `link-block4-block5`, etc.) strictly along horizontal and vertical trajectories with 90° junctions and junction solder dots (`#38bdf8`), completely eliminating steep diagonal link artifacts.
- Fixed the missing CSS styling on `.block` elements (which had previously caused them to render as solid pitch-black rectangles) with crisp combiner box borders (`#1e3450`), readable headers (`BLOCK 01` to `BLOCK 13`), and dynamic status cues (`.block-ok`, `.block-warn`, `.block-down`).
- Expanded inverter card dimensions to $94\text{px} \times 48\text{px}$ (and $80\text{px} \times 48\text{px}$ for 3-node Block 11) with responsive capacity gauges (`data-max-w="82"` / `"68"`).

### 6.5 Plant Telemetry HUD
- Utilized the lower-center canvas space (`x=350..1040`, `y=555..625`) to house an authentic SCADA Telemetry & Collector HUD displaying overall plant capacity ($27.00\text{ MWp}$, $108$ IGBT nodes), feeder distribution breakdown, and Modbus/TCP protocol telemetry specifications.

