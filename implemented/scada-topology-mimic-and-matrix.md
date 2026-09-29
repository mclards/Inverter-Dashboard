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
- Utilized the lower-center canvas space (`x=350..1040`, `y=555..625`) to house an authentic SCADA Telemetry & Collector HUD displaying overall plant capacity, feeder distribution breakdown, and Modbus/TCP protocol telemetry specifications.

---

## 7. As-Built Digos Solar PV Plant Engineering Specifications & RMU Integration

### 7.1 Authoritative Drawing Ingestion
All schematic parameters, voltage levels, breaker ratings, transformer vector groups, and feeder allocations were extracted directly from the official plant blueprints in `docs/For Learning`:
1. **`SWD-DGO-28.59 MWp-PH-E-DWG-102` (69 kV Substation Single Line Diagram):**
   - Interconnection: 69 kV, 3-Phase, 60 Hz to NGCP transmission intertie.
   - High-Voltage Circuit Breakers: 69 kV, 1250 A, 31.5 kA SF6 CBs (`103-52`, `101-52`, `102-52`) with motorized isolators (`103-89`, `101-89`, `102-89`).
   - Main Power Transformers: Dual 12.5 / 15 MVA (ONAN/ONAF) 69 kV / 11 kV, Vector Group **Dyn11**, $Z = 12.5\%$, OLTC $\pm 10\%$ @ $1.25\%$ steps (`P-TRAFO #1` and `P-TRAFO #2`).
2. **`SWD-DGO-28.59 MWp-PH-E-DWG-101` (MV 11 kV Single Line Diagram):**
   - Collector Voltage: **11 kV, 18 kA, 60 Hz** internal medium-voltage distribution (replaces older 34.5 kV draft assumptions).
   - Main 11 kV Switchgear: 1600 A, 11 kV, 18 kA Cu busbar with 1600 A Bus Coupler VCB between Bus Section A and Bus Section B.
   - Incomer VCBs: Two 1250 A, 11 kV, 18 kA VCBs fed by $3\text{Rx}3\text{Cx}400\text{ mm}^2\ 11\text{ kV Al Ar XLPE}$ cables.
   - 13 Inverter Stations (IS-01 to IS-13), each equipped with an **11 kV 4-Way RMU Panel**:
     - IS-01 to IS-10, IS-12, IS-13: 2000 kW (2 x Ingecon Sun PMax) + 2.0 MVA Step-Up Transformer ($360\text{V} / 360\text{V} / 11\text{ kV}$, **Dy11y11**).
     - IS-11: 3000 kW (3 x inverters: INV 21, 22, 23) + one 2.0 MVA and one 1.0 MVA step-up transformer.
     - Feeder 1 (Bus Section A): Inverter Stations IS-01 through IS-06 (12 MW nominal peak).
     - Feeder 2 (Bus Section B): Inverter Stations IS-07 through IS-13 (15 MW nominal peak / 14.75 MW continuous AC).
3. **`SWD-DGO-28.59 MWp-PH-E-DWG-105` (General Development Plan):**
   - Site: Digos Solar PV Power Plant, Digos City, Davao del Sur, Philippines.
   - DC Nameplate Capacity: **28.59 MWp** ($28,591,920\text{ Wp}$, $92,232 \times 310\text{ Wp}$ modules across $4,392$ strings).
   - AC Continuous Capacity: **24.75 MW** ($27 \times 917\text{ kW}$ continuous rated output; $27.00\text{ MW}$ peak).
4. **`SWD-DGO-28.59 MWp-PH-E-DWG-109` (Inverter Station Equipment Arrangement):**
   - Physical layout: 2 Inverters, central CCTV monitoring pole, step-up transformer, 4-Way RMU panel, and Aux + PLC/SCADA panel.

### 7.2 SLD & UI Mimic Updates
- **CAD Drawing Frame:** Embedded official drawing IDs (`DWG: SWD-DGO-28.59 MWp-PH-E-DWG-101/102 • DIGOS SOLAR PV PLANT`) and nameplate ratings (`28.59 MWp DC / 24.75 MW AC • 27 x INGECON SUN PMax (11 kV)`).
- **Substation Unit:** Updated to reflect the 69 kV / 11 kV dual-transformer unit (`2x 12.5/15 MVA Dyn11`, SF6 CB 31.5 kA, 11 kV Bus 1600 A, 18 kA).
- **Combiner Panels:** Relabeled to exact RMU panels (`IS-01 • RMU-01 (2.0 MVA)` through `IS-13 • RMU-13 (2.0 MVA)` with `IS-11 • RMU-11 (3.0 MVA)`).
- **SCADA CAD HUD:** Embedded comprehensive as-built parameters, feeder section groupings, transformer vector groups, and acquisition rates.
- **Diagnostics Drawer & Matrix View:** Synchronized block headers and drawer subheadings to reflect `INVERTER STATION XX (11 kV RMU-XX • 2.0/3.0 MVA)` across all operational views.

---

## 8. Sending-End Power Flow, Multi-Color SCADA Palette & Responsive Matrix

### 8.1 Sending-End Power Flow Direction (Generation -> Grid)
- Re-oriented all 14 collector link trajectories and animations from the downstream inverters UPWARD along the collector spine, INWARD into the 11 kV Substation switchgear, and UPWARD through `link-substation-grid` into the NGCP 69 kV Grid Intertie.
- Added a dedicated 69 kV overhead transmission bus bar (`x=560..800`, `y=22`) and export link (`link-substation-grid`) that activates whenever plant generation is online.
- With decreasing `stroke-dashoffset` animation (`from 20 to 0`), active power pulses visually stream from the PV array arrays into the substation and export outward to the grid, establishing physical sending-end authenticity.

### 8.2 Rich Multi-Color SCADA Palette (Breaking Monochrome Green)
- **11 kV RMU Combiner Headers:** Styled as authentic high-voltage switchgear enclosures (`stroke: #0284c7; fill: rgba(2, 132, 199, 0.12)`) with crisp ice-blue lettering (`#93c5fd`), eliminating the solid green flood.
- **Inverter Cards:** Differentiated with a deep slate/cyan enclosure (`#081726` / `#0284c7`), titanium-white title (`#f8fafc`), high-contrast solar electric gold active power numbers (`#facc15`), and vibrant cyan progress meters (`#06b6d4`).
- **Voltage-Coded Transmission Links:** 11 kV internal collector links pulse in electric cyan (`#06b6d4`), while the 69 kV transmission intertie pulses in high-voltage amber/gold (`#f59e0b`).
- **Color-Coded Electrical Channels in Matrix:**
  - $V_{dc}$ (Solar DC Voltage): Solar Amber (`#f59e0b`)
  - $I_{dc}$ (Solar DC Current): Electric Sky Blue (`#38bdf8`)
  - $V_{ac}$ (3-Phase AC Voltage): Electric Purple (`#a78bfa`)
  - $T_{hs}$ (Heatsink Temperature): Warm Coral (`#fb923c`)

### 8.3 Screen-Filling Responsive Plant Matrix Panels
- Resolved the 70% black empty space on widescreen monitors by grouping inverters into 13 `.matrix-station-group` panels.
- Configured `.matrix-grid` as `repeat(auto-fill, minmax(440px, 1fr))`, arranging the stations across 3 to 4 balanced columns per row on 1080p and 1440p displays.
- Each station group cleanly presents its RMU rating, station active power in gold LED readout (`#facc15`), and paired inverter cards side-by-side with zero horizontal wastage.

### 8.4 CAD HUD Overlap & Station 12 Symmetry Fixes
- Widened the bottom CAD HUD to 780px (`x=290..1070`) and redistributed information into 3 structured columns with generous margin thresholds (> 80px), eliminating all text collisions and divider overlaps.
- Centered the two inverters in Station 12 symmetrically (110px width each, `x=790` and `x=920`) so the vertical feeder link from Station 11 lands cleanly at `x=910` between the inverters with zero overhang.

---

## 9. Single Master SCADA Plant Fleet Table Grouped by Station Numbering

### 9.1 Overview & Architecture
Per operator instruction, View 2 was streamlined from multi-card grid layouts into a single, high-density **Master SCADA Plant Fleet Table** (`.scada-fleet-table`), featuring 1 row per inverter (27 rows total) grouped sequentially by physical Inverter Station (IS-01 through IS-13).

The node-level mini-slots were removed from the fleet table view to maximize scan efficiency, leaving clean per-inverter aggregates on the primary table surface while preserving full per-node ($N_1..N_4$) granular telemetry in the slide-over Diagnostics Drawer.

### 9.2 Realtime Columns & Industrial SCADA Color Palette
Each inverter row provides comprehensive electrical and operational telemetry with sticky headers:
1. **INVERTER:** Inverter identity badge (`INV 01`..`INV 27`), LAN icon, and configured IP address (`192.168.1.101`..`127`).
2. **STATUS:** Industrial operational pill (`GENERATING`, `STANDBY`, `OFFLINE`, `ALARM`).
3. **ACTIVE POWER ($P_{ac}$):** Total real-time generation in kW in Solar Gold (`#facc15`).
4. **LOAD FACTOR:** Percentage of nominal $1000\text{ kW}$ rating with a dynamic gradient bar indicator ($0–100\%$).
5. **DC VOLT ($V_{dc}$):** Average DC input voltage in V in Solar Amber (`#f59e0b`).
6. **DC CURR ($I_{dc}$):** Total DC current in A in Electric Sky Blue (`#38bdf8`).
7. **DC POWER ($P_{dc}$):** Total DC input power in kW in Emerald (`#34d399`).
8. **AC VOLT ($V_{ac}$):** 3-Phase line-to-line AC voltage in V in Electric Purple (`#a78bfa`).
9. **TEMP ($T_{hs}$):** Maximum power module heatsink temperature in °C in Warm Coral (`#fb923c`).
10. **ACTION:** Dedicated diagnostics launch button (`mdi-tune-vertical`) triggering the per-node ($N_1..N_4$) deep-dive drawer.

### 9.3 Inverter Station Group Banners
- Between inverter groupings, an aesthetic full-width banner (`.station-group-row`) designates the physical Inverter Station (IS-01 through IS-13), 11 kV RMU switchgear tag, and transformer capacity (`2.0 MVA` / `3.0 MVA`).
- Each station banner dynamically computes and displays the real-time aggregate active power output for that station (`#facc15` LED text).

### 9.4 Filtering & Realtime Telemetry Binding
- Synchronized with plant header filter chips (`All 27`, `Gen`, `On`, `Off`, `Alm`): inverters matching the filter remain visible while non-matching rows are cleanly hidden. Empty station groups hide automatically when all child inverters are filtered out.
- Low-latency batch updates: updates are bound directly to pre-rendered DOM elements without DOM thrashing or layout re-computation.

### 9.5 Ultra-Compact Single-Screen Viewport Density
To ensure all 27 central inverters and all 13 Inverter Station groupings fit seamlessly onto a single display viewport without vertical scrolling:
- Tightened inverter row heights to $17\text{px}$ (`padding: 1px 6px; font-size: 0.64rem; line-height: 1.12;`).
- Streamlined station group banners to $16\text{px}$ (`height: 16px; padding: 0 8px; font-size: 0.61rem;`).
- Compacted thead sticky headers to $19\text{px}$ (`padding: 2px 6px; font-size: 0.57rem;`).
- Reduced vertical margins and container padding (`padding: 2px 10px 4px 10px;`).
- Added `@media (max-height: 820px)` micro-scaling query so smaller laptop screens (e.g. 1366x768) also display the complete fleet without vertical scrollbars.

### 9.6 Strict View Isolation (Zero Overlap Guarantee)
- Enforced strict CSS isolation between `.scada-view` (`display: none !important;`) and `.scada-view.active` (`display: flex !important;`).
- Removed unconditional `display: flex;` from `#view-matrix` so inactive views never bleed through or render as transparent overlays over View 1 (SLD Mimic Diagram).
- Applied explicit opaque canvas backgrounds (`background: var(--bg);`) to each view surface.

### 9.7 Proportional Column Distribution & Viewport Fill Optimization
- **Fixed Table Layout (`table-layout: fixed`):** Eliminated arbitrary column expansion gaps by setting exact proportional column allocations summing to 100%:
  - `INVERTER`: 14% (ID badge, LAN icon, IP address)
  - `STATUS`: 8% (Centered industrial status pill)
  - `ACTIVE POWER`: 11% (Right-aligned Solar Gold LED readout)
  - `LOAD FACTOR`: 18% (Full-width dynamic gradient meter bar and % readout)
  - `DC VOLT`, `DC CURR`, `AC VOLT`, `TEMP`: 8.5% each (Right-aligned telemetry metrics)
  - `DC POWER`: 10% (Right-aligned total DC input power)
  - `ACTION`: 5% (Centered diagnostic drawer trigger button)
- **Full-Width Meter Bar:** Removed artificial `max-width` capping on `.table-load-wrap`, allowing the load factor meter bar to span smoothly across its column without leaving gaping black voids.
- **Natural Vertical Viewport Fill:** Balanced row padding ($2\text{px}\times 8\text{px}$) and banner height ($18\text{px}$) so all 27 inverters and 13 stations fill the 1080p viewport comfortably from top to bottom with zero leftover voids.

