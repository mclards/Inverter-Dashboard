# ADSI Inverter Dashboard User Manual

<!-- adsi-guide-source: complete -->

**Applies to:** Current ADSI Inverter Dashboard release
**Document type:** Operator and administrator reference
**Scope:** Main dashboard, forecast workspace, settings center, cloud backup, standby database workflow, alarm handling, exports, IP Configuration, and Topology

---

## Service documentation (v2.12.5+)

Four Ingeteam reference PDFs ship with the installer under `docs/` and are
also hosted on GitHub for in-app auto-download from the alarm drilldown:

| File | Code | Purpose |
|---|---|---|
| `Inverter-Schematic-Diagram.pdf` | AQM0027 | 22-page wiring schematic (4-module EQUIPO X variant) |
| `Inverter-Incident-Workflow.pdf` | AAV2011IMC01_ | Level 1 incident workflow (16 alarm codes) |
| `Inverter-Incident-Workflow-Level2.pdf` | AAV2011IFA01_ | Level 2 — SCOPE tool, DebugDesc sub-codes, calibration |
| `INGECON-SUN-Manager-User-Manual.pdf` | PTD138 | Windows SCADA tool user manual |

**Alarm drilldown:** click any alarm hex code (e.g. `0x0020H`) in the Alarms
page or Inverter Detail panel to open the service-reference drilldown. Each
active bit shows a full novice-friendly walkthrough sourced directly from the
Ingeteam Level 1 / Level 2 PDFs and the AQM0027 schematic:

- **Safety preparation** (amber border) — PPE, what stays energized after stop,
  what tools and records to have on hand BEFORE you touch anything.
- **Action** — one-line summary plus a numbered procedural walkthrough with
  branching criteria; ⚠ steps render in red.
- **Physical location** — every device with a "where on the cabinet" descriptor.
- **Schematic reference** — one precise sentence about what the linked schematic
  page actually shows, so you know whether to open p.4 (DC input), p.5 (K1 +
  harmonic filter), p.6 (AC supply / RVAC / FAC fuses), p.12 (+15 Vdc rails),
  p.15 (door limit switches), p.21 (sync card / RS-485) or p.22 (CAN bus).
- **Expected normal readings** — what GOOD looks like (Vac ranges, continuity
  pairs, +15 Vdc check points, insulation thresholds, fuse continuity).
- **Training modules** — TrinPM chips link directly to the matching YouTube
  video on `ingeconsuntraining.info` (each chip resolves to its specific video,
  not the index page).
- **DebugDesc (Level 2 / SCOPE)** — sub-code → action mapping (e.g. 0x0004 →
  40/92/107-109; 0x0040 → 55,56/119).
- **Stop-reason sub-codes** — surfaced under 0x1000 Manual Shutdown
  (1320 / 1360 / 1363).
- **Escalate to Ingeteam SAT when** (red border) — explicit stop-criteria so
  you know when to stop poking and call SAT.
- **Note** — short safety / context callout at the bottom.

The footer carries one-click PDF download buttons for the schematic, Level 1,
Level 2, and SUN Manager manual. Downloads come from the GitHub raw URL first
(always current) with a local `/docs/` fallback when offline.

**7FFF fatal-error handling:** when an inverter reports `0x7FFF` fatal
error, a red banner on the drilldown explains that the inverter can only be
unlocked by entering a code through the physical display. The auto-reset
engine will not retry fatal errors — it logs once and waits for the
operator to act.

---

## 1. Purpose

This manual provides a complete operational guide for the ADSI Inverter Dashboard. It is intended for plant operators, supervisors, maintenance personnel, and authorized administrators who use the dashboard to:

- monitor inverter and node status in real time
- review alarms, energy history, analytics, and daily reports
- generate or validate day-ahead forecast data
- export operational records
- manage gateway or remote workstation behavior
- maintain settings, licensing, updates, backups, and standby database refreshes

This document follows the current implementation in this repository and is written to match the dashboard labels and workflows used by the application.

---

## 2. System Overview

### 2.1 Primary Functions

The dashboard is a plant operations workstation for centralized inverter supervision. It combines live telemetry, historical review, controlled command actions, forecast support, reporting, and administrative maintenance in one application.

### 2.2 Operating Modes

| Mode | Purpose | Main Behavior | Typical Use |
| --- | --- | --- | --- |
| `Gateway` | Local plant-connected workstation | Polls and persists plant data locally | Main on-site control and reporting station |
| `Remote` | Gateway-linked viewer workstation | Streams live data from the gateway and proxies historical access | Off-site monitoring, review, and supervised control |

If the application starts in `Remote` mode and the gateway is unreachable, the startup loading screen displays a **Connection Mode** picker. The picker allows the operator to switch to `Gateway` mode immediately or retry the `Remote` connection without restarting the application manually.

### 2.3 Data Architecture

| Data Layer | Description | Used For |
| --- | --- | --- |
| `Main DB` | Current working database containing hot operational data | Live history, reports, analytics, exports, local gateway operation |
| `Archive DBs` | Monthly historical database files | Long-term history, older reports, historical exports |
| `Standby DB` | Staged local copy of the gateway main database | Local standby use before switching back to `Gateway` mode |
| `Live Stream` | Real-time gateway-fed runtime data in `Remote` mode | Current values, live status, alarms, control visibility |

### 2.3.1 Live Updates vs Historical Queries

The dashboard keeps the live operations path separate from the historical-read path so the gateway can continue polling devices, persisting data, and serving the active dashboard without unnecessary lag.

Typical operating flow:

```text
Devices
   ->
Gateway poller
   -> Main DB
   -> Live stream -> Dashboard UI

Dashboard UI
   -> On-demand history/report/export request
   -> Gateway API
   -> Main DB or Archive DBs
```

Operational rule:

- Use the live stream for current values, alarm visibility, topology state, and other continuously changing dashboard elements.
- Use HTTP API reads for initial page state, historical charts, reports, analytics ranges, and export jobs.
- Request history on demand and by explicit time range instead of repeatedly reloading large windows in the background.
- Prefer summarized datasets such as daily reports or interval-energy tables when they satisfy the screen requirement.
- Keep full standby DB refreshes and archive transfers as separate maintenance actions, not as part of normal live viewing.

This split protects the source gateway from avoidable load. Large historical pulls, archive downloads, and export generation may consume noticeable disk, CPU, and network resources, so they should stay off the live refresh path.

### 2.3.2 Historical Data Without Slowing the Gateway

When a remote operator needs history without collapsing or lagging the source dashboard, use this pattern:

```text
Client start
   ->
GET lightweight current snapshot
   ->
connect live stream
   ->
render live dashboard updates

Only when needed:
   ->
GET or POST bounded history/report/export request
   ->
render the returned historical dataset separately
```

Implementation guidance for this repository:

- Do not tie historical reloads to every live update tick.
- Do not keep refetching large date ranges while the live dashboard is open.
- Use bounded queries, pagination, or aggregated intervals for long ranges.
- Run heavy export and standby-refresh tasks in their dedicated background flow.
- Schedule full standby DB refreshes during lower-traffic windows when fresh local offline history is required.

### 2.4 Important Standby DB Rule

The `Refresh Standby DB` action stages archive DB files first (when included) for historical consistency, then downloads the gateway main database for local use. The staged database is **not** applied immediately — a restart is needed to activate the new data.

The staged standby refresh also preserves the gateway's current-day energy baseline so that, after restart and switch back to `Gateway` mode, `TODAY MWh` can bridge cleanly while the local poller catches up.

### 2.5 Current-Day Energy Authority

For the current day, the dashboard treats these values as one aligned metric family:

- `TODAY MWh`
- analytics `Actual MWh` when the selected date is today
- per-inverter `Today Energy`

Operational rule:

- these values are computed on the server from `PAC x elapsed time`
- the server combines persisted `energy_5min` totals with the current live partial interval
- they are **not** taken directly from inverter lifetime-energy registers or Python `/metrics` energy fields
- current-day exports use the same server-side current-day snapshot so exported totals match the displayed totals as of export time

### 2.6 Polling and Logging Outside Solar Hours

Outside the normal solar window, the system still polls devices so operators can continue to see:

- communication status
- current online or offline state
- active alarm state
- gateway or remote health

Operational rule:

- raw telemetry persistence for `readings` and `energy_5min` remains limited to the solar window
- alarm and audit logging may still continue outside the solar window
- graceful shutdown does not force an off-window raw-telemetry write

---

## 3. Interface Layout

### 3.1 Header Bar

The fixed header is the primary global status strip.

| Element | Meaning | Operator Use |
| --- | --- | --- |
| Plant logo/title area | Identifies the plant and dashboard instance | Visual confirmation of the correct workstation |
| `TOTAL PAC` | Total present plant active power | Quick view of current plant output in `kW` |
| `TODAY MWh` | Today accumulated plant energy | Daily generation reference in `MWh` |
| Alarm sound button | Mutes or unmutes alarm audio | Silence notification sound without disabling alarms |
| Theme toggle | Changes dashboard appearance | Switch between available visual themes |
| Connection dot | Live connection indicator | Quick check of data-link health |
| Clock and date | Local workstation time | Time reference for operations and event review |
| Menu button | Opens or closes the side navigation | Access page tabs and About section |

### 3.2 Global Progress and Notice Areas

| Element | Meaning |
| --- | --- |
| Progress row under header | App-level background progress feedback |
| License notice | Appears when license action is required or recommended |

### 3.3 Side Navigation

The right-side navigation contains the main pages:

- `Inverters`
- `Analytics`
- `Forecast`
- `Alarms`
- `Parameters` (per-node 5-minute parameter log; renamed from `Energy` in v2.10.x)
- `Audit`
- `Report`
- `Export`
- `Settings`

### 3.4 Pop-out Windows

For multi-monitor setups or complex monitoring needs, the dashboard supports isolating specific tools into separate, independent windows. This allows you to monitor live dashboards (like Analytics or Asset Health) simultaneously with other activities without interrupting data polling.

To open a pop-out window:
1. Navigate to a supported page (**Analytics**, **Forecast**, **Alarms**, or **Asset Health**).
2. Click the small "pop-out" icon (`↗`) located in the top-right toolbar of the page.
3. The selected tool will open in a new window with a simplified interface (no side navigation or global header). Both windows will continue to receive live real-time updates independently.

*Note: You can only have one pop-out window active per tool at any given time. Clicking the button again will focus the existing window rather than opening a duplicate.*

The `About` card also shows:

- installed application version
- data directory
- license state
- update state
- website reference
- user guide access

### 3.4 Overlay Panels and Popups

| Overlay | Purpose |
| --- | --- |
| Alarm notification hub (bottom-right pill + panel) | Quick list of active unacknowledged alarms |
| Operator Messages panel | Short notes exchanged between gateway and remote operators |
| User Guide modal | Embedded quick-reference guide |
| Bulk authorization modal | Required for selected multi-inverter control actions |
| Mode transition overlay | Temporarily blocks normal actions while the selected runtime becomes ready |
| Confirm dialogs | Used before important actions such as restore, mode switch, refresh, or delete |
| Camera Settings modal | Configures camera stream mode, connection, and go2rtc service controls |

---

## 4. Data Types, Units, and Uses

### 4.1 Operational Data Types

| Data Type | Typical Fields | Where Used | Operational Purpose |
| --- | --- | --- | --- |
| Live telemetry | inverter, node, `pac`, `pdc`, online, alarm, last seen | Inverters page, header metrics, topology | Real-time operating awareness |
| Interval energy | date, interval end, inverter, interval energy | Energy page, Analytics page, exports | Production tracking and interval review |
| Alarm event | alarm time, inverter, node, code, severity, description, cleared, status, acknowledged | Alarms page, notification panel, inverter detail | Fault review and operator response |
| Audit event | timestamp, operator, inverter, node, action, scope, result, IP | Audit page, audit export | Command accountability and traceability |
| Daily report record | inverter, energy, peak output, average output, uptime, alarms, availability, performance | Report page, report export | Formal daily performance review |
| Forecast data | date, interval, forecast energy/power, estimated actual, variance | Analytics page, Forecast page, forecast export | Day-ahead planning and comparison |
| Weather data | date, sky, temperature min/max, rainfall, cloud cover | Analytics page, Forecast context | Production context and expectation setting |
| Runtime health data | CPU, memory, uptime, polling metrics, fetch errors, connected clients | Settings -> Connectivity & Gateway Link | Technical health monitoring |
| Replication and standby data | mode, gateway link, last success, standby status, transfer progress, archive option | Settings -> Connectivity & Gateway Link | Remote readiness and local standby maintenance |
| Backup package | provider, scope, size, created time, status | Settings -> Cloud Backup & Restore | Disaster recovery and controlled rollback |

### 4.2 Core Display Units

| Item | Unit | Meaning |
| --- | --- | --- |
| `PAC` | `W` or `kW` | Active AC output power |
| `PDC` | `W` or `kW` | DC-side input power |
| Energy | `MWh` | Produced electrical energy |
| Duration | seconds, minutes, hours, days | Event age, uptime, or interval length |
| CPU | percent | Runtime processor load |
| Memory | RSS size | Resident memory used by the app |
| RX / TX | `B/s`, `KB/s`, etc. | Current transfer speed during link or file activity |

### 4.3 Status Terms

| Status | Meaning |
| --- | --- |
| `Online` | Fresh data is available and the unit is communicating normally |
| `Offline` | No current live data is available |
| `Stale` | Last retained snapshot is shown while fresh data is temporarily unavailable |
| `Alarm` | Alarm condition is active |
| `Critical` | Highest alarm condition in the current summary |
| `Acknowledged` | Alarm has been operator-acknowledged |
| `Isolated` / `N/A` | Node is not configured for that inverter position |

### 4.4 Node Power Band Legend

The inverter toolbar legend classifies node PAC against the configured node rated output.

| Band | Rule |
| --- | --- |
| `High` | `>= 90%` of rated node output |
| `Moderate` | `> 70%` of rated node output |
| `Mild` | `> 40%` of rated node output |
| `Low` | `<= 40%` of rated node output |
| `Alarm` | Alarm condition overrides the normal band display |

---

## 5. Header and Global Features

### 5.1 Alarm Sound Control

Use the speaker button in the header to mute or restore alarm sound. This affects sound only; alarms continue to be detected, displayed, and logged.

Current behavior:

- alarm sound starts only when an unacknowledged alarm remains active for at least `5` seconds
- very short alarm blips do not trigger audio
- if a node already has an active alarm and the alarm value expands or changes while staying active, the dashboard keeps that as the same active alarm episode and does not replay the sound just because an additional alarm bit appeared

### 5.2 Theme Selection

Use the theme toggle to switch the dashboard visual theme. Theme choice persists between restarts.

### 5.3 Alarm Notification Hub and Quick-ACK

Alarm notifications are consolidated into a single bottom-right hub so they stay readable without blocking the page. There is exactly one indicator per side:

- **Left (navigation only):** the sidebar `ALARMS` item shows a count badge of unacknowledged active alarms. Clicking it opens the full Alarms page.
- **Bottom-right (live alerts):** a compact **summary pill** appears whenever unacknowledged active alarms exist. It shows a per-severity tally and the active-alarm count. Clicking the pill opens the alarm notification panel directly above it — no page navigation. Click it again (or the panel's close button) to dismiss the panel.

The earlier bottom-left floating bell has been removed; the pill replaces it, eliminating the previous duplicate left/right notification icons.

The notification panel shows up to 50 recent active alarms. Each unacknowledged alarm entry includes:

- inverter label and alarm code with severity
- alarm description
- timestamp
- **`✔ ACK` button** — acknowledges the alarm directly from the panel without navigating to the Alarms page

Already-acknowledged alarms show a muted **`✔ Acked`** label instead of the button. When there are no active alarms the panel shows a simple "No active alarms." message and the pill is hidden.

Acknowledgement is gateway-authoritative in both operating modes. An ACK made on the gateway dashboard or any Remote-mode viewer is saved on the gateway and synchronized immediately to every connected dashboard. The Alarms table, sidebar badge, notification panel, alarm sound, and inverter-card alarm state reconcile together; reconnecting or replicated standby databases retain the same ACK state.

Use the Alarms page for formal review, bulk acknowledgement, and history. Use the bottom-right hub pill and its panel for quick acknowledgement without leaving the current page.

### 5.4 Operator Messages

The floating message bubble opens the `Operator Messages` panel. This panel supports:

- viewing gateway or remote notes
- sending short operational messages
- clearing recent messages
- auto-close after inactivity

### 5.5 License Notice

If the current license requires attention, the dashboard displays a notice bar with a direct upload action for a replacement license.

### 5.6 Windows Elevation Behavior

The per-machine installer requests administrator rights, while the installed dashboard runs with the signed-in operator's normal Windows permissions.

Operational note:

- Windows shows a User Account Control prompt during installation and update, not during ordinary dashboard startup
- the elevated installer grants the shared `ProgramData\InverterDashboard` tree the access required by the normal runtime and removes obsolete ADSI `RUNASADMIN` compatibility overrides
- do not force **Run as administrator** for routine use; Hikvision LocalService native video must run at the same Windows integrity level as the dashboard window
- the current Windows release set is installer-only; a portable EXE is not generated by current builds

---

## 6. Main Pages

## 6.1 Inverters Page

The `Inverters` page is the primary live operations page.

### Purpose

- monitor the full inverter fleet in real time
- review node-by-node operating state
- send start or stop commands
- review or supervise plant-wide MW capping (now on the dedicated **Plant Cap** page)
- inspect current alarms and recent inverter history

### Toolbar Controls

| Control | Function |
| --- | --- |
| `All Inverters` filter | Show the full fleet or focus on one inverter |
| `Layout` | Change the grid column layout |
| _(Plant Cap has moved to its own dedicated page — see Section 5.2)_ | |
| Status legend | Shows output-band colors and alarm state meaning |
| Fleet stat chips | Summarize inverter count, node count, online, alarmed, and offline totals |

The status legend keeps fixed signal colors across all themes:

- green for `High`
- yellow for `Moderate`
- orange for `Mild`
- red for `Low`
- blinking red for `Alarm`

### Inverter Card Contents

Each inverter card contains:

- inverter title and current state badge
- inverter-wide start and stop buttons displayed side by side
- compact inline `Pdc` and `Pac` summary cells
- node table

The PAC strip is intentionally shorter than the node table area so the card keeps a dense operational layout without making the summary values smaller than the row data.

### Node Table Columns

| Column | Meaning |
| --- | --- |
| `Node` | Node label such as `N1`, `N2`, `N3`, `N4` |
| `Alarm` | Current alarm code shown in hexadecimal format such as `0000H` |
| `Pdc (W)` | Node DC power |
| `Pac (W)` | Node AC power |
| `Last Seen` | Last telemetry timestamp for that node |
| `Ctrl` | Node-level start/stop or `N/A` for isolated nodes |

### Node Controls
| Action Type | Scope | Notes |
| --- | --- | --- |
| Node button | Single node | Sends a single `START` or `STOP` command |
| Card `Start` / `Stop` | Entire inverter | Sends the same command to all configured nodes in that inverter |
| Bulk control | Selected inverter set | Requires a separate authorization step |

### Bulk Inverter Command Panel

The bulk control panel is located with the inverter grid and supports structured inverter targeting.

| Field or Action | Function |
| --- | --- |
| `Inverter Numbers / Ranges` | Accepts values such as `1-13, 16, 18, 23-27` |
| `All Inverters` | Fills the full valid inverter range automatically |
| `Clear` | Clears the current selection |
| `START SELECTED` | Sends start command to configured nodes in selected inverters |
| `STOP SELECTED` | Sends stop command to configured nodes in selected inverters |

Important behavior:

- duplicate inverter entries are rejected
- invalid range tokens are rejected
- isolated inverters are skipped automatically
- current builds batch whole-inverter and selected-inverter node writes per inverter so one inverter action does not wait for a separate gateway HTTP request per node
- selected multi-inverter actions require an authorization key from authorized personnel

### 5.2 Plant Cap Page

The **Plant Cap** page is a dedicated workspace accessible from the navigation bar. It contains the full plant output cap controller, schedule management, and action history.

#### Page Toolbar

The toolbar at the top displays live summary indicators:

| Element | Function |
| --- | --- |
| `Status` badge | Current controller mode: **Enabled**, **Paused**, or **Idle** |
| `Plant MW` | Current total plant AC output from live PAC data |
| `Band` | Configured lower–upper MW cap band |
| `+ Add Schedule` button | Opens the schedule creation modal |

#### Cap Inputs

| Field | Function |
| --- | --- |
| `Upper Limit (MW)` | Upper plant MW threshold that triggers automatic capping decisions |
| `Lower Limit (MW)` | Lower plant MW threshold used to decide whether eligible stopped non-exempt inverters may be restarted |
| `Sequence` | Inverter selection mode: `Ascending`, `Descending`, or `Exemption` |
| `Exempted Inverter Numbers` | Comma-separated inverter numbers skipped during automatic stop selection |
| `Cooldown (s)` | Settling time after each automatic stop or restart before the next controller decision |

#### Cap Actions

| Action | Function |
| --- | --- |
| `Preview Plan` | Simulates the next stop or restart decision using the current live plant state |
| `Enable Cap` | Enables gateway-side plant output capping after confirmation and authorization |
| `Disable Monitoring` | Stops automatic capping for the current session without automatically restarting controller-owned inverters |
| `Release Controlled Inverters` | Restarts controller-owned inverters sequentially and ends the current plant-cap session |

#### Cap Status Panel

The status panel reports live controller state through a set of labeled metrics:

| Metric | Meaning |
| --- | --- |
| `Status` | Controller state: Idle, Monitoring, Stopping, Starting, Paused, or Fault |
| `Reason` | Human-readable explanation of the current state or pending action |
| `Last Action` | Most recent automatic stop or restart, with inverter number and timestamp |
| `Cooldown` | Remaining settling time after the most recent controller action |
| `Curtailed` | Total MW removed by controller-owned stops (sum of Pac at each stop time) |
| `Controllable` | Number of inverters eligible for stop selection |
| `Pending` | In-flight controller action, if any |
| `Exempted` | Inverter numbers excluded from automatic stop selection |

#### Controlled Inverters Table

When the controller owns one or more stopped inverters, a detailed table appears inside the cap panel:

| Column | Meaning |
| --- | --- |
| `Inverter` | Inverter number stopped by the controller |
| `Stopped At` | Time the controller issued the stop command |
| `Duration` | Elapsed time since the stop (e.g. 12m 35s or 2h 05m), updated each render cycle |
| `Pac Removed (kW)` | AC power output at the moment of stop |
| `Nodes` | Enabled node count at the time of stop |
| `Rated kW` | Node-adjusted rated inverter capacity |
| `Depend. kW` | Node-adjusted dependable inverter capacity |

#### Cap-Stopped Inverter Card Indicators

Inverters stopped by the plant cap controller are visually distinct in the inverter grid:

- the card badge changes from `OFFLINE` to `CAP STOPPED` (blue)
- a stoppage timestamp appears below the badge showing when the controller stopped the inverter
- the card border and icon shift to a blue accent instead of the dimmed gray used for regular offline inverters
- the card stays at full opacity, unlike ordinary offline cards which are dimmed
- indicators appear on all three themes (dark, light, classic) and clear automatically when the inverter is released or the cap session ends

#### Cap Plan Preview

The preview table shows each candidate inverter in sequence order with its node count, rated and dependable capacity, estimated step kW, projected plant MW after the step, and the planner's decision reason. The selected candidate (the next action the controller would execute) is highlighted.

#### Operational Rules

- current builds use whole-inverter sequential stopping and starting only
- planning is node-aware and capacity-aware; enabled node count affects each inverter step size
- live inverter `Pac` is the primary estimate for the next shedding step
- dependable inverter capacity is used as the fallback and as the stability guard when the cap band is very narrow
- while plant-cap monitoring is enabled, all non-exempted inverters are treated as controller-controlled assets
- the controller may restart any eligible fresh stopped non-exempt inverter; controller-owned stops are still tracked separately for release order and history
- manual control for non-exempted inverters is blocked while plant cap is active; the operator is warned that the cap session is still ongoing and must disable or exempt first

#### Grid Code Tab — Grid Monitor (v2.11.x)

Inside the Plant Controller page, the **Grid Code** tab adds a read-only **Grid Monitor** panel that visualises live grid behaviour over a rolling 5-minute window at 5-second resolution:

| Chart | Shows |
| --- | --- |
| `P vs f` | Active power against grid frequency, with NGCP envelope overlay (continuous 59.7–60.3 Hz; withstand 58.2–61.8 Hz) |
| `Q vs V` | Reactive power against AC voltage, with ±5 % nominal band shaded |
| `dP/dt` | Per-node ramp rate over time. Comparable to the configured APC ramp limit when enabled |
| `Observed PF` | Power factor (|cos φ|) over time, with NGCP 0.95 lag/lead boundaries |

The top-strip chips show live plant aggregate: fresh-node count, mean frequency, mean voltage, total P and Q. The panel polls only while the Grid Code tab is visible and pauses when the operator switches to another tab or page.

#### APC Ramp-Rate Limiter (v2.11.x)

A new optional pacing layer wraps every `set` opcode issued by the **%P Setpoint** tab and the T5 sweep compliance test. The controls live inline at the bottom of the **%P Setpoint** tab — a checkbox + a `Max ramp (%/min)` input that auto-saves on change. Status chip on the right reports `Disabled` (default) or `Pacing @ N%/min`.

| Control | Default | Notes |
| --- | --- | --- |
| `Ramp-rate limiter` | OFF | Master switch. When OFF, setpoints write through unchanged |
| `Max ramp (%/min)` | 10 | Maximum absolute %P change per minute. Industry typical 10 %/min; range 1–100 |

When enabled and the requested setpoint exceeds the per-minute step, the dashboard issues an immediate paced step, schedules the remaining steps as background timers (15 s apart), broadcasts an `apc:throttled` notification, and writes one `apc.ramp_paced` row plus one `apc.ramp_step` row per intermediate setpoint to the audit log. The Slice δ closed-loop verifier defers its read-back until the ramp finishes to avoid false-mismatch records.

#### Grid Code Write Verification (v2.11.x)

Every successful Slice ζ write (`Set PF`, `Set kVAr`, `Disable reactive`) schedules a delayed read-back of holding registers 41006–41010 and records the result in `grid_control_verify_log`. The Read-back panel surfaces the most recent `OK`, `MISMATCH`, `NO_RESPONSE`, `TIMEOUT`, or `PENDING` status for the selected node, with the requested vs observed raw values and the result age in seconds. The same flow refuses writes against an inverter that is auto-blocked by a recurring critical alarm pattern (HTTP 423 with the pattern hex code). `Disable reactive` is intentionally exempt from the block — releasing reactive control is always permitted as the safe direction.
- a very small gap between `Upper Limit` and `Lower Limit` produces warnings because the controller may overshoot or fail to settle cleanly
- hover descriptions are available on plant-cap controls, metrics, warnings, and preview fields
- in `Remote` mode, the panel remains viewable and the requests are proxied to the gateway workstation
- if a remote workstation reports `Cannot POST /api/plant-cap/...`, the gateway is usually running an older build or the remote gateway target is incorrect
- all cap controller stop and start actions are recorded in the Audit page with scope `PLANT-CAP`

#### Scheduled Auto-Cap

The **Scheduled Auto-Cap** section displays compact chip cards for each configured schedule. Each chip shows the time window, schedule name, and a state badge (Active, Waiting, Paused, Completed, or Disabled).

| Action | How |
| --- | --- |
| Create schedule | Click **+ Add Schedule** in the toolbar or **+ Add** in the chip section |
| Edit schedule | Click the pencil icon on any schedule chip |
| Delete schedule | Use the delete option in the schedule detail |

##### Schedule Form (Modal)

The schedule form opens as a centered modal overlay:

| Field | Description |
| --- | --- |
| `Name` | Display label for the schedule |
| `Start Time` * | 24-hour HH:MM when the cap activates daily |
| `Stop Time` * | 24-hour HH:MM when the cap releases daily (must be after start) |
| `Upper MW` | Override for this schedule (blank uses global default) |
| `Lower MW` | Override for this schedule (blank uses global default) |
| `Sequence Mode` | Override inverter selection order (blank uses global default) |
| `Cooldown (s)` | Override cooldown seconds (blank uses global default) |
| `Auth Key` * | Plant-wide control authorization key (required for all mutations) |

### Inverter Detail Panel

Selecting an inverter opens a focused detail view with:

- live inverter card
- `Today's Alarm Activity`
- `Last 7 Days Summary`

Use this view for closer troubleshooting or shift handover review.

---

## 6.2 Analytics Page

The `Analytics` page supports interval-based review of production and day-ahead comparison.

### Main Controls

| Control | Function |
| --- | --- |
| `Date` | Selects the day to analyze |
| `Interval` | Chooses chart interval: `5 min`, `15 min`, `30 min`, or `1 hour` |
| `Load View` | Loads the analytics set for the selected date and interval |

### Top Summary Row

The toolbar summary shows:

- selected interval
- total energy
- peak plant output
- reporting inverter count
- latest interval

### Generated Analytics Cards

The page builds:

- one total plant energy chart
- one selected-date summary card
- one chart per inverter

### Selected Date Summary Card

| Item | Meaning |
| --- | --- |
| `Actual MWh` | Authoritative total daily energy. For today's date this stays live and updates automatically as new energy data arrives over the gateway connection |
| `Day-ahead MWh` | Forecast total daily energy |
| `Variance MWh` | Difference between actual and day-ahead values |
| `Peak Interval` | Highest interval energy or output summary for the selected view |

Operational note:

- when **today's date** is selected, the summary card and interval charts update automatically on each server push, at the same cadence as `TODAY MWh` in the header — no manual reload is needed
- for past dates, data is loaded on demand by pressing `Load View`

### Day-ahead Generator

The analytics side card includes:

- `Days` input
- `Generate` button

Operational rule:

- day-ahead generation is available on the `Gateway` workstation only
- in `Remote` mode, generation is blocked and should be performed from the gateway workstation
- generated day-ahead data can be exported from the dedicated Export page

#### Automatic Day-Ahead Schedule

The system automatically generates tomorrow's day-ahead forecast on a fixed cron schedule. Each run checks the existing forecast's **quality** before deciding whether to regenerate.

| Time | Role |
| --- | --- |
| 04:30 | Early morning — first pass with overnight Solcast data |
| 09:30 | Pre-cutoff — catches weather data refreshes before the 10:00 AM control room submission deadline |
| 18:30 | Post-solar-day — refreshes with full day of actual generation data |
| 20:00 | Evening re-check |
| 22:00 | Final nightly pass |

#### Quality Gate

Before each cron run, the system classifies the existing forecast into one of these quality states:

| Quality | Meaning | Action |
| --- | --- | --- |
| **healthy** | Complete forecast, correct provider, fresh Solcast input | Skip — no regeneration |
| missing | No forecast rows exist | Generate |
| incomplete | Fewer slots than the solar window requires | Regenerate |
| wrong_provider | Generated with a different provider than currently configured | Regenerate |
| stale_input | Solcast data has been refreshed since the forecast was built | Regenerate |
| weak_quality | Last run failed or variant is unknown | Regenerate |

> **Solcast Freshness Detection:** The quality gate compares the Solcast snapshot timestamp used at generation time against the current snapshot timestamp. If Solcast has published updated weather data since the last generation (e.g., weather changes after the 04:30 run), the 09:30 cron will detect the stale input and regenerate automatically before the 10:00 AM cutoff.

> **Actuals Isolation:** The quality assessment only reads forecast predictions, audit metadata, and Solcast weather snapshots. It never reads today's running energy actuals (energy_5min, inverter readings, or intraday adjustments). Live production data cannot interfere with the quality gate or trigger false regenerations.

### Weekly Weather Outlook

The `7-Day Weather Outlook` provides context for expected production behavior using:

- sky condition
- temperature range
- rainfall
- cloud percentage

Use this view to support planning, performance interpretation, and forecast review.

### Day-Ahead vs Reality — Locked @ Previous 10 AM

The `Day-Ahead vs Reality` chart displays a multi-series comparison of the frozen 10 AM day-ahead forecast snapshot against actual output as the day unfolds. It shows:

- **P10/P50/P90 confidence band** — locked forecast envelope from previous 10 AM
- **Solcast est. actual** — separate provider-derived reference overlay
- **Plant actual** — PAC-integrated plant output used as the operational actual
- **ML intraday product** — locally generated intraday rows; the chart identifies an ML nowcast versus a day-ahead fallback, and the expandable diagnostics identify the exact plotted algorithm and provenance

Header metrics include spread % (cap-weighted), variance vs P50, and % of actual output within the band. Useful for validating forecast accuracy, detecting late-day weather shifts, and reviewing confidence band tightness.

---

## 6.3 Forecast Page

The `Forecast` page provides a dedicated workspace for forecast configuration and validation. In the current UI, this page hosts the forecast settings section directly in its own workspace.

### Purpose

- manage forecast source selection
- configure Solcast access
- test connectivity
- preview toolkit forecast data
- export preview data

### Forecast Source Options

| Option | Use |
| --- | --- |
| `Local ML (Current)` | Standard local forecasting source |
| `Solcast` | External forecast source for validation or alternate use |

### Solcast Access Modes

| Access Mode | Use |
| --- | --- |
| `Toolkit Login` | Reads the Solcast toolkit chart feed using account sign-in |
| `API Key` | Uses formal Solcast API credentials and resource ID |

### Forecast Fields

| Field | Purpose |
| --- | --- |
| `Solcast Base URL` | Target Solcast service endpoint |
| `Timezone` | Timezone used for forecast interpretation |
| `Solcast API Key` | API credential for API mode |
| `Resource ID` | Solcast site or resource identifier |
| `Toolkit Chart URL` | Exact Solcast toolkit chart link |
| `Toolkit Email` | Toolkit account user name |
| `Toolkit Password` | Toolkit account password |

### Forecast Tuning

Manual overrides for ML engine training parameters. Leave blank to use the engine's own defaults.

| Field | Purpose | Range | Default |
| --- | --- | --- | --- |
| `Est-actual Weight` | Override the satellite est-actual training weight (how much weight the engine gives to Solcast estimated-actual values when training the model). Validate new values with a backtest before relying. | 0.50–1.00 | Auto (engine-tuned) |
| `Intraday Blend Max` | Cap how strongly intraday observed vs. day-ahead corrections are blended (0 = no intraday blending, 1 = maximum). Validate with a backtest. | 0.00–1.00 | 0.72 |
| `Virtual Nowcast Mode` | Select the established current intraday path, evaluate the robust challenger without publishing it, or permit controlled activation with automatic fallback. The robust path remains unpromoted; keep this setting at `Off` unless an authorized promotion decision says otherwise. | Off / Shadow / Active | Off |

### Virtual Nowcast (Experimental; Default Off)

> **Promotion status:** The robust virtual-nowcast algorithm is a challenger,
> not the production default. `Off` is the safe default. Do not select
> `Active` until replay, live-shadow, reliability, and operator-approval
> gates have passed.

The virtual-nowcast rollout extends the existing intraday-adjusted forecast
path. It does not replace the issued day-ahead forecast, the locked comparison
snapshot, or the day-ahead audit authority.

#### Products shown on the Analytics chart

| Product | Meaning | Operational rule |
| --- | --- | --- |
| **Day-ahead / locked P10–P50–P90** | The issued forecast basis retained for operational comparison. | Intraday nowcasting does not rewrite immutable day-ahead issuance history or its authoritative run audit. |
| **ML intraday nowcast** | The locally calculated PAC-integrated, loss-adjusted intraday series. Its diagnostics identify the algorithm that actually produced the plotted rows. | Where a cutoff is known, the observation-side segment through the cutoff is solid and the future projection is dashed. If the intraday product is unavailable, the chart identifies a day-ahead fallback instead of pretending it is a nowcast. |
| **Solcast est. actual** | A separate provider-derived reference overlay. | It is never treated as plant truth for live nowcast correction or promotion scoring. |

#### Rollout modes

Open **Forecast → Tuning → Virtual Nowcast Mode**. A saved change applies on
the next eligible five-minute forecast cycle.

| Mode | Published series | Audit behavior | Use |
| --- | --- | --- | --- |
| `Off` | The established current intraday algorithm, when it produces a valid output. | The run and authoritative write outcome are still recorded in `forecast_intraday_run_audit`; challenger status is `skipped`. | Default operation and immediate rollback. |
| `Shadow` | The established current intraday algorithm remains authoritative. | The robust challenger is evaluated and its outcome/checkpoints are recorded as evaluation-only diagnostics. | Required live evaluation stage before any activation. |
| `Active` | The robust challenger only when valid; otherwise the established current algorithm is used if available. | The exact plotted run, challenger outcome, fallback, and authoritative write status are recorded separately. | Controlled use only after all promotion gates pass and an operator explicitly enables it. |

Only the Gateway evaluates, writes, and prunes this diagnostic history.
Remote/viewer workstations display gateway data through the existing proxy path.

#### Safety and fallback

- Uses only PAC-integrated, loss-adjusted plant energy at or before the run
  cutoff; future observations and Solcast estimated actuals are excluded.
 - Excludes low-baseline, low-capacity-coverage, cap-dispatched,
   inverter-outage, and export-curtailed slots.
- Requires at least six eligible observations, estimates the correction with a
  robust weighted median in log-ratio space, and fades the complete correction
  toward day-ahead with a 45-minute half-life.
- Applies configured correction-strength, ratio, ramp, physical-cap,
  finite-value, and confidence-band ordering checks
  (`0 ≤ P10 ≤ P50 ≤ P90`).
- In Active mode, an invalid, insufficient, failed, or timed-out challenger
  falls back to the established current algorithm. If no valid replacement can
  be written, the last valid intraday series is preserved when one exists; the
  audit records that outcome.

#### Focusable diagnostics and provenance

The compact nowcast control above the **Day-Ahead vs Actual** chart is an
expandable, keyboard-focusable details control. Click it, or move focus to its
summary with `Tab` and use `Enter` or `Space`, to inspect:

- plotted algorithm and series kind
- run ID and provenance match
- generation time and freshness
- cutoff, eligible-observation count, and correction strength
- authoritative write status
- latest attempt, challenger result, and fallback reason

This control does not require hover. Mouse users can also hover an individual
nowcast chart point for a compact tooltip.

The plotted-series provenance and the latest attempt are deliberately separate.
A newer failed or shadow attempt must not be presented as the producer of older
plotted rows. When an exact row-to-audit match cannot be established, the UI
reports **unknown** instead of guessing from the current setting.

#### Promotion gates

1. Use at least 30 eligible historical days in chronological, rolling-origin
   replay with no future-observation or artifact leakage.
2. Complete at least 14 solar days in `Shadow`, including clear, mixed, and
   overcast/rainy conditions.
3. Demonstrate at least 5% relative improvement in median nowcast WAPE over the
   established current algorithm across +15 to +120 minute horizons, with no
   unacceptable shoulder, overall, or weather-regime regression.
4. Confirm no increase in missing/incomplete production series, automatic
   fallback on every failure path, and P95 runtime below 30 seconds.
5. Keep activity-v2 and weather-derivative candidates unpromoted until their own
   ablations and support requirements pass.

#### Diagnostics and rollback

The Gateway retains `forecast_intraday_run_audit` diagnostics for 30 days,
includes them in normal database backups, and keeps them separate from the
authoritative day-ahead audit ledger. For immediate operator rollback, select
`Off` and save; the established current algorithm is used on the next eligible
cycle.

Gateway-only engineering checks:

```powershell
python services/forecast_engine.py --baseline-snapshot --dry-run
python services/forecast_engine.py --replay --from-date YYYY-MM-DD --to-date YYYY-MM-DD --dry-run
python services/forecast_engine.py --rebuild-forecast-artifacts --lookback-days 45 --dry-run
```

Dry-run replay and rebuild checks do not write live forecast or audit tables.
Treat activity-v2 profiles, weather derivatives, and the robust nowcast itself
as experimental until the evidence gates above are met.

### Toolkit Preview

When toolkit preview is enabled, the forecast workspace provides:

| Control or Metric | Purpose |
| --- | --- |
| `Start Day` | First day shown in preview |
| `Days to Display` | Number of days included |
| `Chart Unit` | View values as `MWh` or `MW` |
| `Forecast Total` | Total forecasted energy in the selected window |
| `Estimated Actual` | Estimated actual value for comparison |
| `Selected Range` | Exact date window shown |
| `Window` | Solar review window, shown as `05:00-18:00` in the current UI |

### Forecast Actions

| Button | Function |
| --- | --- |
| `Save Forecast Settings` | Saves forecast settings using the same settings save flow |
| `Refresh Preview` | Reloads toolkit preview using current form values |
| `Save and Test Solcast` | Saves active values, then tests the chosen Solcast mode |

| `Test Solcast Connection` | Tests current values without saving |

### Forecast Performance Monitor

The Forecast Performance Monitor provides a visual audit of the ML forecast engine: health status, accuracy trends, and a per-day comparison table for the selected look-back window. Access it from the **Analytics** page (scroll below the analytics charts).

#### Health Chips

| Chip | What it shows |
| --- | --- |
| `ML Training` | Status of the last model training run: *Trained*, *Rejected (N consecutive)*, or *No data* |
| `Last Run` | Outcome of the most recent day-ahead generation attempt and its timestamp |
| `Provider` | Data provider used for the last run: *Local ML* or *Solcast* |
| `Recent Quality` | Aggregate quality rating over the selected window: *Good*, *Acceptable*, or *Poor* |

#### Charts

| Chart | Description |
| --- | --- |
| Compare | Overlays day-ahead forecast (line) against actual generation (bars) with a shaded confidence band |
| WAPE | Daily Weighted Absolute Percentage Error bar chart; bar colour reflects quality tier |

#### History Table Columns

| Column | Description |
| --- | --- |
| `Date` | Target date of the forecast |
| `Provider` | Data provider used (*Local ML* or *Solcast*) |
| `Variant` | Forecast variant tag (e.g. *day_ahead*) |
| `WAPE %` | Weighted Absolute Percentage Error for that day |
| `Forecast MWh` | Forecasted daily energy total |
| `Actual MWh` | Observed actual energy total |
| `Freshness` | Solcast input freshness classification |
| `Quality` | Overall quality tier for that forecast run |
| `In-Memory` | Whether the forecast is held in the in-memory error-correction pool |

#### Controls

| Control | Function |
| --- | --- |
| Day-range selector | Sets the look-back window: 7, 14, 30, 60, 90, or 180 days |
| Refresh | Reloads all panel data from the server |

### ML Backend — LightGBM

The forecast engine uses **LightGBM** as its primary ML backend when installed (enabled by default from v2.4.40). If LightGBM is not installed the engine falls back automatically to sklearn's Gradient Boosting Regressor — no configuration change is required.

#### Installation

```
pip install lightgbm
```

Install into the Python environment used by the Forecast Service. On Windows the Visual C++ Redistributable (usually already present) is also required by the LightGBM DLL.

#### Requirements

| Requirement | Details |
| --- | --- |
| Python | 3.8 or later |
| LightGBM package | 3.x or later (`pip install lightgbm`) |
| Visual C++ Redistributable | Windows only — usually already present |
| CPU / RAM | Standard workstation hardware; no GPU required |
| Disk | ~50 MB for package and DLLs |

#### Verifying the Active Backend

- Check the **ML Training** health chip in the Forecast Performance Monitor after the next training run.
- The Forecast Service log prints `[LightGBM]` entries during model fit when LightGBM is active.
- To force the sklearn fallback (e.g. for debugging), set `FORECAST_USE_LIGHTGBM=0` before starting the Forecast Service.
- PyInstaller builds bundle LightGBM automatically if it is installed on the build machine; if not, the packaged EXE uses the sklearn fallback at runtime.

### Solcast Tri-Band Integration

When Solcast Toolkit data is available, the forecast engine automatically uses all three confidence levels — the standard forecast value plus Solcast's P10 (low confidence) and P90 (high confidence) intervals — as additional ML features. This provides the model with explicit weather uncertainty information, which is especially valuable on partly cloudy or changeable-weather days.

The tri-band integration is fully transparent to the operator. No configuration or action is required — the model automatically detects and incorporates tri-band data when it is available from your Solcast Toolkit feed. Historical forecasts generated without tri-band data continue to work normally, and the model gracefully switches to using all three bands as new data arrives.
This enhancement improves forecast accuracy across uncertain weather regimes by helping the model learn how weather unpredictability affects generation variance and timing.

---

## 6.4 Alarms Page

The `Alarms` page is the formal alarm review and acknowledgement workspace.

### Controls

| Control | Function |
| --- | --- |
| `Inverter` | Filter by specific inverter or all inverters |
| `Date` | Select review date |
| `Load Records` | Query alarms for the selected date |
| `Acknowledge All` | Acknowledge active alarms in the current scope |

### Alarm Table Columns

| Column | Meaning |
| --- | --- |
| `Alarm Time` | Timestamp of the event |
| `Inverter` | Inverter identifier |
| `Node` | Node identifier |
| `Alarm Code` | Code in operational hexadecimal form |
| `Severity` | Severity classification such as warning, fault, or critical |
| `Description` | Human-readable alarm description |
| `Cleared` | Clear time if the event has ended |
| `Duration` | Active or total duration |
| `Status` | Active or closed state |
| `Ack.` | Acknowledgement state |

Use this page for:

- shift alarm review
- confirmation that alarms were acknowledged
- incident reporting and maintenance coordination

Single-alarm ACK and `Acknowledge All` use the gateway as the source of truth. Their results synchronize across Gateway and Remote mode, including other open dashboard windows, without requiring a manual reload.

---

## 6.5 Parameters Page

The `Parameters` page (renamed from `Energy` in v2.10.x) shows the per-node
5-minute parameter log for a single inverter at a time. Each tab is one node
on the picked inverter; rows are 5-minute snapshots of every electrical and
operational reading the dashboard captures.

This page replaces the legacy single-list Energy table. The underlying
`energy_5min` and `inverter_5min` tables are untouched — Forecast, Analytics,
Reports, and cloud replication continue to consume them as before — and a
new `inverter_5min_param` table feeds this view via `dailyAggregator.js`.

### Controls

| Control | Function |
| --- | --- |
| `Inverter` | Pick which inverter (1..N) to view. The page is blank until an inverter is selected. |
| `Date` | Day to load. **Today** streams live 5-minute samples; **past dates** load from history. |
| Mode badge | Appears next to the date picker: shows `LIVE` while today's slots are still streaming, and `HISTORY` once a past date is loaded. |
| Solar-window indicator | Right-side badge — `Solar window: HH:MM–HH:MM` — confirms which slots are clipped by the configured solar window. |
| `Refresh` | Re-fetch the selected day's data without changing the date. |
| Row count | Right-side counter — total slots loaded across all node tabs. |

### Tab Layout

- One tab per configured node on the picked inverter — tabs are built from
  the IP Configuration `units[invId]` map, so disabled or de-configured
  nodes never appear.
- Each tab has its own scrolling table of 5-minute slots. Switching tabs
  does not re-fetch — all data for the inverter is loaded once per refresh.

### Per-Node Parameter Columns

Each tab shows ISM-compatible columns at 5-minute granularity:

| Column | Meaning |
| --- | --- |
| `Slot End` | End of the 5-minute slot (HH:MM, plant-local) |
| `Pdc / Vdc / Idc` | DC string power, voltage, current |
| `Vac1 / Vac2 / Vac3` | AC line-to-neutral voltages, three phases |
| `Iac1 / Iac2 / Iac3` | AC line currents, three phases |
| `Pac` | AC active power output |
| `CosΦ` | Power factor at the AC terminals |
| `Freq` | AC line frequency |
| `parcE` | Partial-energy hardware counter snapshot at slot end |
| `Alarm` | Decoded alarm hex active during the slot (blank if none) |
| `Temp` | Internal heatsink temperature. **Blank by design in v2.10.x** — see §6.8.2 for the road-to-resolution. The column is reserved so a future firmware register decode will populate it without a schema change. |

### Operational Notes

- **Live behavior** — when **today's date** is selected, the active node's
  table appends a new row at every 5-minute boundary; no manual reload is
  needed. The mode badge shows `LIVE` and the row count ticks up.
- **Past-date behavior** — past dates load on the first selection and stay
  cached until you change the inverter, change the date, or press
  `Refresh`. The mode badge shows `HISTORY`.
- **Solar-window clipping** — slots outside the configured window are
  automatically suppressed. To inspect overnight diagnostic rows, change
  the solar window in `Settings → Plant Configuration`.
- **Day rollover** — at local midnight the page resets the date to the new
  day and clears the live buffer; an in-flight fetch from the previous day
  is dropped via a request-id race guard.

Use this page for per-node electrical verification, alarm correlation
against parameter trends, and interval-level validation. For a workbook-
style export of the same data see **§6.8.2 Daily Data Export**.

---

## 6.6 Audit Page

The `Audit` page records operator command activity.

### Purpose

- review who performed a command
- confirm whether the command succeeded
- filter by operator, inverter, node, scope, result, or IP

### Main Controls

| Control | Function |
| --- | --- |
| `Inverter` | Top-level inverter filter |
| `Date` | Day filter |
| `Load Records` | Loads the audit data |
| `Clear Filters` | Clears the filter row |

### Audit Columns

| Column | Meaning |
| --- | --- |
| `Date/Time` | Command timestamp |
| `Operator` | Operator name recorded at execution |
| `Inverter` | Affected inverter |
| `Node` | Affected node or aggregated scope (`ALL` if the command targeted all nodes) |
| `Action` | `START` or `STOP` |
| `Scope` | `SINGLE`, `INVERTER`, `SELECTED`, `ALL`, or `PLANT-CAP` |
| `Result` | `OK` or `ERROR` |
| `IP` | Source workstation or inverter IP address |
| `Reason` | Controller decision reason for automatic actions (`PLANT-CAP` scope); blank for manual commands |

### Plant-Cap Scope Indicator

Audit entries generated by the Plant Output Cap controller display a `PLANT-CAP` badge in the Scope column with a blue highlight on the row. The `Reason` column shows the controller's decision reason (e.g. "Keeps projected plant output above the lower limit."), making it straightforward to distinguish automatic cap actions from manual operator commands.

### Filter Row

The filter row allows targeted review by:

- timestamp text
- operator name
- inverter
- node
- action
- scope (including `PLANT-CAP` for cap controller actions)
- result
- IP address

This page is the primary accountability record for command execution.

---

## 6.7 Report Page

The `Report` page provides the daily inverter-by-inverter performance summary.

### Controls

| Control | Function |
| --- | --- |
| `Date` | Selects the report day |
| `Load Report` | Loads the calculated daily report |
| `Format` | Selects `Excel (.xlsx)` or `CSV` for export |
| `Export Report` | Exports the current report |

### Report Columns

| Column | Meaning |
| --- | --- |
| `Inverter` | Inverter identifier |
| `Energy (MWh)` | Daily energy total |
| `Peak Pac (kW)` | Highest AC active power for the day |
| `Avg Pac (kW)` | Average AC active power |
| `Uptime (h)` | Operating uptime for the day |
| `Alarms` | Alarm count |
| `Availability (%)` | Availability indicator |
| `Performance (%)` | Performance indicator |

### Filter Row

The filter row supports:

- inverter-specific selection
- text filters for energy, peak, average, uptime, availability, and performance
- alarm-state filter such as `With Alarms` or `No Alarms`

Use this page for formal daily reporting, operational review, and management handoff.

---

## 6.8 Export Page

The `Export` page provides dedicated export packages for common operational records.

### Export Packages

| Package | Inputs | Output Use |
| --- | --- | --- |
| `Alarm History Export` | inverter, date, minimum alarm duration, format | Formal alarm records |
| `Energy Summary Export` | inverter, date, format, optional `Etotal` / `parcE` columns | Production summary, hardware-counter reconciliation |
| `Daily Data Export` | inverter, date | ISM-compatible per-node 5-minute parameter workbook |
| `Day-Ahead Comparison Export` | date, resolution, format | Forecast-versus-actual comparison |
| `Operational Data Export` | inverter, date, interval, format | Detailed engineering or troubleshooting data |
| `Operator Audit Export` | inverter, date, format | Command accountability records |
| `Daily Performance Report` | from date, to date, format | Shift, management, or archival reporting |

#### 6.8.1 Energy Summary — Hardware Counter Columns

The `Energy Summary Export` adds two reconciliation columns when the operator
enables them:

| Column | Source | Notes |
| --- | --- | --- |
| `Etotal_kWh` | Lifetime hardware kWh counter (Modbus regs 0–1) at slot end | Daily delta = current snapshot − today's baseline |
| `parcE_kWh` | Partial-energy hardware counter (Modbus regs 58–59) | Same delta rule |
| `Counter_Source` | `eod_clean`, `poll`, `pac_seed`, or blank | Which baseline anchor was used |
| `Etotal_Quarantined` / `Quarantine_Reason` | Set when the snapshot fell outside the sanity gate | Clamps protect against parser hiccups |

Hardening rules (v2.10.x):

- **Today** — delta is taken against today's baseline regardless of source
  (`eod_clean`, `poll`, or `pac_seed`); for partial-day starts the delta
  represents "energy since polling began", which lines up with the
  PAC-integrated `Total_MWh` on the same row.
- **Today — fallback** — if today's baseline row is missing, yesterday's
  `eod_clean` snapshot is used as the anchor instead of leaving the column
  blank.
- **Past day** — same-day `eod_clean` − baseline is preferred; if missing,
  the next day's open is used as the close-out anchor.
- **Sanity ceiling** — every accepted delta must be `≥ 0` and bounded by
  9 000 kWh per unit per day. Anything outside that range is dropped to a
  blank cell and the day total NaN-propagates so the operator notices.
- **PAC remains authoritative.** Hardware counters are reconciliation
  aids only — they never overwrite the running PAC integration.

#### 6.8.2 Daily Data Export

The `Daily Data Export` produces a per-inverter Excel workbook with one
sheet per configured node — the same layout the ISM vendor software uses
so historical data can be cross-referenced.

| Field | Function |
| --- | --- |
| `Inverter` | Pick the inverter to export. |
| `Date` | Date to export. **Today is locked** until the dashboard reaches the End-of-Day snapshot hour (`Settings → Plant Configuration → Solar Window`). Until then only past dates may be exported (HTTP 423 returned otherwise). |
| `Export` | Streams the workbook directly to disk via `ExcelJS.WorkbookWriter`. (All export-card primary buttons are now labelled simply **Export**; the card title identifies what is exported.) |
| `Cancel` | Cancels an in-flight build. |

Workbook structure:

- One workbook per inverter, filename in plant-standard format.
- One sheet per configured node (sheets named `Node 1`, `Node 2`, …).
- Each sheet uses the ISM-compatible column order (`Pdc`, `Vdc`, `Idc`,
  `Vac1..3`, `Iac1..3`, `Pac`, `CosΦ`, `Freq`, `parcE`, `Alarm`, `Temp`).
- Slots are clipped to the configured solar window so dawn/dusk noise is
  excluded.

Operational notes:

- The export reads from the new `inverter_5min_param` table populated by
  `dailyAggregator.js` — it does **not** disturb live polling.
- The today-lock prevents partially-collected days from being exported as
  if they were finalized; the unlock fires alongside the same EOD-clean
  snapshot that anchors the next day's baseline.
- Streaming output keeps memory bounded for plants with many nodes; the
  cancel button safely stops the writer mid-stream.
- Filename uses the standard project convention shared with every other
  export: single-day pulls produce `DD-MM-YY Inverter N Daily Data.xlsx`,
  date ranges produce `DD-MM-YY-DD-MM-YY Inverter N Daily Data.xlsx`.

Column-level notes:

- The `Temp (°C)` column is **blank by design in v2.10.x**. The schema
  reserves the column so that a future firmware register decode will
  populate it without a migration; today no Modbus FC04 register on
  INGECON SUN exposes inverter heatsink temperature. See the FIXME v2.11
  block in `services/inverter_engine.py` for the road-to-resolution.
- The `Inv Alarms` column is rendered as the bitwise-OR of every alarm
  bitmask seen during the slot, not the alarm at slot end — so a transient
  fault that flickered for 30 seconds inside a 5-minute slot still appears
  on the row. Use the Alarms page for episode-level resolution.

#### Gap detection (v2.10.x)

A partial day (one inverter offline for 30 min, gateway restart, etc.)
will produce fewer rows than the configured solar window expects. To find
out whether a date's export is complete BEFORE you ship the workbook,
query the operator-facing slot-coverage endpoint:

```
GET /api/params/:inverter/:slave/coverage/:date
```

Response shape:

```json
{
  "ok": true,
  "inverter": 1,
  "inverter_ip": "192.168.1.10",
  "slave": 1,
  "date_local": "2026-04-28",
  "expected": 156,
  "present": 150,
  "missing": 6,
  "coveragePct": 0.9615,
  "missingSlots": [96, 97, 98, 99, 100, 101],
  "missingRuns": [
    { "startSlot": 96, "endSlot": 101, "startHHMM": "08:00", "endHHMM": "08:30" }
  ],
  "status": "partial",
  "solar_window_start_hour": 5,
  "eod_snapshot_hour_local": 18,
  "slot_minutes": 5
}
```

`status` is one of `complete` (all expected slots present), `partial`
(some present, some missing), or `empty` (zero slots — gateway was down
or the day is outside the configured solar window). Missing-slot ranges
are rendered as plant-local `HH:MM` so operators can correlate against
incident logs without converting slot indices by hand.

The aggregator's drop-sample reasons are also surfaced on
`GET /api/system/heartbeat` under `aggregator.samplesDropped*` and
`aggregator.fieldClampCount` — useful to confirm whether missing slots
were caused by inverter downtime, clock skew, or out-of-order frames.

#### 6.8.3 Anchor source — HW counter trust ladder (v2.10.x)

The `Counter_Source` column on the Energy Summary export and the `Anchor`
pill on the Inverter Clocks → Per-Unit Counter Health table report which
data source today's `etotal_baseline` and `parce_baseline` came from.
This drives how trustworthy `Etotal Δ` / `parcE Δ` are for that day.

| Pill | DB source | Meaning | Trust |
| --- | --- | --- | --- |
| `CLEAN` | `eod_clean` (and today's snapshot captured) | Yesterday's clean close anchored today **and** today's EOD snapshot has been captured (post-EOD hour). | ★★★★ Best — Δ is fleet-comparable |
| `EOD` | `eod_clean` | Yesterday's clean close anchored today; today's EOD snapshot pending (will fire after the configured EOD hour). | ★★★ Δ is fleet-comparable |
| `EOD-ONLY` | `eod_clean_only` | Late-created row from a dark-window capture: the day's morning baseline was never recorded (gateway started post-midnight, fresh install, etc.). The day's own Δ is unknown — the export blanks the HW columns for that day — but the row anchors **tomorrow's** baseline. Self-heals to EOD/CLEAN tomorrow. | ★ Same-day Δ unknown |
| `POLL` | `poll` | Today's baseline came from the first poll of the day, **not** yesterday's clean close. Etotal Δ undercounts today's energy by whatever the inverter produced before the gateway's first poll. PAC-integrated `Total_MWh` stays authoritative. | ★★ Δ undercounts |
| `SEED` | `pac_seed` | Reserved slot from the v2.9.0 design. No code path currently writes `pac_seed`; the renderer keeps the branch for forward compatibility. | n/a (unused) |
| `—` | (empty) | No baseline row recorded for today yet — will populate on the next poll inside the solar window. | n/a |

**Self-healing rules** (v2.10.x):

- The dark-window snapshot capture now uses `INSERT-or-UPDATE` (was
  `UPDATE-only`), so it can create yesterday's row when missing — fixes
  the silent failure mode where a fresh-boot gateway lost yesterday's
  close forever even though it had the data.
- After every successful eod_clean capture, the system re-evaluates
  today's row: if today is `POLL` and yesterday's eod_clean is now
  available, today's baseline is rewritten in-place to `eod_clean` and
  re-anchored to yesterday's true close. Operators see the pill flip
  from `POLL` to `EOD` within seconds.
- Day-total `Etotal_MWh` / `parcE_MWh` columns NaN-propagate (blank)
  for `EOD-ONLY` days so partial-coverage exports don't silently report
  0 kWh for a day that was unmeasured — the operator sees the gap.

### Common Export Behavior

- exports are written to the configured export folder
- most export cards support `Cancel` while running
- result text appears at the bottom of each export card
- format choices are typically `Excel (.xlsx)` and `CSV`
- XLSX exports now apply fitted column widths, colored headers, bordered cells, and highlighted summary or total rows for easier review in Excel

### Refresh Button (v2.8.10+)

The Export page toolbar includes a **Refresh** button with a status line
that reports when the last reload happened and the result per data
source. Clicking Refresh drives every data pipeline that feeds the
Export tab:

1. **Settings reload** — inverter count and display labels.
2. **Dropdowns rebuilt** — every inverter select, every Alarm / Energy /
   Forecast / Operational Data / Audit / Daily Report selector.
3. **Forecast date list** reloaded — the Day-Ahead Comparison card's
   snapshot/forecast date dropdown.
4. **Server pipeline refresh** (`POST /api/export/refresh-pipelines`)
   in gateway mode:
   - Pulls fresh Solcast snapshots for today and tomorrow (capped by a
     12 s timeout so a slow upstream cannot stall the UI).
   - Returns current row counts for forecast days, snapshot dates,
     audit log, alarms, daily report, energy, and readings.
   - Returns `skipped (remote-mode)` when running from a remote
     workstation — Solcast only runs on the gateway.
5. **Forecast date list reloaded again** — newly-arrived snapshot dates
   appear in the dropdown without leaving the page.
6. **Status line updated** with an inline summary. Example:
   `Last refreshed 14:32:07 — Solcast 288 slots, 2 snap dates, 28 forecast days, 107 audit rows`.
   Hover the status line for the full per-source diagnostic JSON.

Use Refresh whenever:

- the inverter count or labels were changed in **Settings** while the
  Export page was already open
- a plant-cap or topology change should be reflected in the dropdown
  before running an export
- the operator wants the Day-Ahead Comparison card to pull Solcast data
  fresher than the last cron cycle
- a cancelled or stale export card should be reset

The Refresh button is safe to click at any time. In-flight exports
continue to run to completion because they hold their own cancel tokens
— refreshing only touches dropdowns, defaults, cached UI state, and the
Solcast snapshot cache. If the Solcast fetch times out or any other
pipeline fails, the button shows `Partial` and the status line lists
the number of errors; hover it to see which source failed.

---

## 6.9 Settings Page

The `Settings` page is the administrative center. It is organized as a section-based review workflow.

### Global Settings Actions

| Action | Function |
| --- | --- |
| `Save Settings` | Saves the active configuration |
| `Export Settings` | Exports a configuration file |
| `Import Settings` | Imports a saved configuration file |
| `Export Folder...` | Selects the export destination path |
| `Open Folder` | Opens the current export path |
| `IP Configuration` | Opens the network configuration window |
| `Restore Defaults` | Resets settings and disconnects cloud providers |

### 6.9.1 Plant Configuration

| Field | Use |
| --- | --- |
| `Plant Name` | Display and document naming |
| `Operator Name` | Recorded operator identity |
| `Inverter Count` | Total inverter count used by the dashboard |
| `Nodes/Inverter` | Reporting nodes per inverter |
| `Plant Latitude` | Weather and forecast context |
| `Plant Longitude` | Weather and forecast context |

### 6.9.2 Data & Polling

#### Service Endpoints

| Field | Use |
| --- | --- |
| `Data API URL` | Read-side service endpoint |
| `Write API URL` | Command/write service endpoint |

#### Storage

| Field | Use |
| --- | --- |
| `Export Folder` | Destination for generated files |
| `Retention Window (days)` | Number of days kept in the main hot database before archival logic applies |

#### Polling Timing

| Field | Use |
| --- | --- |
| `Modbus Timeout (s)` | Max wait time for read response |
| `Reconnect Delay (s)` | Delay before read retry after reconnect |
| `Read Spacing (s)` | Pause between register groups to reduce device pressure |

#### Plant Output Cap Defaults

These settings define the default values loaded into the **Plant Cap** page. The settings view also shows a small planner summary for selection mode, band gap, controllable inverter count, and the smallest available controller step.

| Field | Use |
| --- | --- |
| `Upper Limit (MW)` | Default upper plant MW cap threshold |
| `Lower Limit (MW)` | Default lower plant MW threshold |
| `Sequence` | Default inverter selection mode |
| `Exempted Inverter Numbers` | Default comma-separated inverter exclusion list used by `Exemption` mode |
| `Cooldown (s)` | Default settling delay after each controller action |

### 6.9.3 Connectivity & Gateway Link

This section defines whether the workstation is acting locally at the plant or as a remote viewer.

#### Mode & Remote Access

| Field | Use |
| --- | --- |
| `Operation Mode` | `Gateway` or `Remote` |
| `Remote Gateway URL` | URL of the authoritative gateway workstation |
| `Remote API Token` | Shared API token for remote access |
| `Tailscale Device Hint` | Optional identifier used when checking secure-network status |

#### Connectivity Actions

| Button | Function |
| --- | --- |
| `Test Remote Gateway` | Confirms the configured remote URL is reachable |
| `Check Tailscale` | Verifies Tailscale installation and connection state |
| `Refresh` | Refreshes replication and link-health information |
| `Refresh Standby DB` | Stages archive DB files first (when included) for historical consistency, then downloads a fresh gateway main DB snapshot for local use; if newer local standby data exists, the app blocks and offers explicit `Force Pull` |

The Gateway Link tab groups its status tiles into two labelled groups so the
network state and the standby-refresh activity read separately at a glance.

#### Connection Fields

Shown under the **Connection** group.

| Field | Meaning |
| --- | --- |
| `Mode` | Current runtime mode |
| `Gateway URL` | Remote gateway target |
| `Gateway Reachable` | Whether the gateway can currently be reached over the network |
| `Tailscale` | Secure path status |
| `Gateway Live Link` | Current data-link (WebSocket) activity state |
| `Last Successful Contact` | Last successful gateway response timestamp |

#### Standby Refresh Fields

Shown under the **Standby Refresh** group, with the `Last Errors` panel below it.

| Field | Meaning |
| --- | --- |
| `Last Standby Refresh` | Last background or manual standby operation |
| `Rows Received` | Received row counter for related operations |
| `Last Standby DB Pull` | Last full standby DB staging event |
| `Background Job` | Current standby or transfer job state |
| `Last Errors` | Most recent connectivity or transfer errors |

#### Transfer Monitor

The transfer monitor reports:

- current RX and TX speeds
- transfer direction
- transfer phase
- transfer scope
- percent complete
- current bytes versus total bytes

#### Standby Refresh Safety Behavior

Operational rules for `Refresh Standby DB`:

- normal standby refresh is download-only; it does not push local standby data back to the gateway
- if the local standby copy contains newer replicated operational data than the gateway, the app stops with a `Force Pull` choice instead of overwriting silently
- this safety check happens before the heavy transfer starts, helping protect gateway responsiveness
- `Force Pull` should be used only when the gateway is the intended source of truth and overwriting newer local standby data is deliberate
- failed or cancelled standby refreshes discard staged replacement files automatically; partial failed downloads are not applied on restart

#### Runtime Health

This area reports application health indicators such as:

- CPU
- memory
- uptime
- live value key count
- polling cycles
- poll duration
- fetch errors
- rows persisted
- persist skipped
- connected clients

### 6.9.4 Forecast

The dedicated forecast settings content is presented in the `Forecast` page workspace. Refer to Section `6.3 Forecast Page`.

### 6.9.5 License

| Field or Action | Purpose |
| --- | --- |
| `Status` | Current license state |
| `Source` | Where the license was loaded from |
| `Expiry` | License expiry date |
| `Remaining Days` | Remaining term |
| `Upload Replacement` | Applies a new license file |
| `Refresh License` | Reloads license state |
| License audit table | Shows license-related events and messages |

### 6.9.6 App Updates

| Field or Action | Purpose |
| --- | --- |
| `Current Version` | Installed application version |
| `Channel` | Release/update channel |
| `Latest Version` | Most recent release available |
| `Status` | Current update state |
| `Check for Updates` | Queries the update channel |
| `Download Update` | Downloads the update package when available |
| `Restart & Install` | Restarts the app and installs the downloaded update |

Operational note:

- `Restart & Install` now uses an orderly shutdown path before the installer handoff.
- The app first asks the local dashboard server, inverter backend, and forecast background service to stop cleanly.
- Force termination is used only as a fallback if a background service does not exit within its bounded grace window.
- Do not power off the workstation or relaunch the app manually while the restart/install handoff is in progress.
- After restart, wait for the first local poll cycle before relying on fresh `TODAY MWh` or gateway-only forecast actions.

### 6.9.7 Stop Reasons (v2.10.x)

The `Stop Reasons` settings card surfaces the per-node `StopReason`
diagnostic each Ingeteam INGECON inverter records when it stops or trips.
The dashboard reads this snapshot through a vendor-FC `0x71` SCOPE peek
(transparent across both the comm-board and EKI-1222-BE gateway path) and
persists it to the `inverter_stop_reasons` and `inverter_stop_histogram`
tables.

The card has two tabs:

#### Captured Snapshots

| Control | Function |
| --- | --- |
| `Inverter` | Pick which inverter to inspect. |
| `Refresh now` | Reads the StopReason snapshot for every node on the picked inverter. Bulk-auth is **not** required for this read-only peek (v2.10.x). |
| Snapshot table | One row per node with timestamp, decoded `DebugDesc`, raw fingerprint, and the originating alarm transition (when present). |

Auto-capture (always on):

- The dashboard automatically captures a snapshot whenever an alarm
  transition is detected on a node.
- A 500 ms delay separates the alarm event from the FC `0x71` read so the
  inverter has time to stage its DebugDesc.
- A 30-second cooldown per `(inverter, node)` prevents thrashing during
  alarm storms.
- Each captured row links back to its `alarm_id` via the
  `alarms.stop_reason_id` foreign key, so the alarm drilldown panel can
  pull the contextual stop reason without a second read.

#### Lifetime Counters

| Control | Function |
| --- | --- |
| `Reload histogram` | Reloads the cached `ARRAYHISTMOTPARO` lifetime motive counters (30 stop motives plus `TOTAL`). |
| Histogram table | Sorted bar view of how many times each motive has been recorded against the picked inverter. |

Remote-mode behavior:

- Captured snapshots and histograms mirror from the gateway as part of
  normal replication.
- `Refresh now` is disabled when running from a remote workstation
  because the FC `0x71` read must execute on the gateway-side network.

### 6.9.8 Serial Number Setting (v2.10.x)

The `Serial Number Setting` card mirrors ISM's `frmSetSerial` flow so the
dashboard can read, edit, and write inverter serial numbers without
plugging in the vendor laptop.

The card has three tabs:

#### Read / Edit / Send

| Control | Function |
| --- | --- |
| `Inverter` | Pick the inverter (controller) to operate on. |
| `Slave` | Modbus slave id (1..4) on the daisy chain. `All nodes` reads every configured slave at once and exposes a per-row `Send` action. |
| `Format` | `Motorola (12)` for FreescaleDSP56F firmware (12 ASCII bytes) or `Texas TI (32)` for TexasTMS320F firmware (32 ASCII bytes). |
| `Read` | Issues FC11 `Report Slave ID` and shows the current serial, model, and firmware version. The successful read **mints a 5-minute session token** required by `Send`. |
| `New serial` | Candidate serial. Length is enforced per format and only ASCII printable characters are accepted. |
| `Verify Serial Number to send` | Default-on. Before writing, scans every reachable `(inverter, slave)` pair via FC11 in parallel and rejects the candidate if it is already in use elsewhere on the fleet. The fleet scan honors a 5-minute cache so repeated reads do not stress the bus. |
| `Send` | Two-frame write: UNLOCK (`0xFFFA = 0x0065, 0x07A7`) → WRITE (`0x9C74`) → readback verify. Bulk-auth is required, plus the active session token from a prior `Read`. |
| Recent serial-number changes | Audit table of the last `serial_change_log` entries — operator, target, candidate, outcome, reason on failure. |

Operational rules:

- The unlock magic and the FC16 write target were decoded byte-for-byte
  from the vendor IL bytecode and are **identical to ISM's writer** — the
  dashboard write is indistinguishable on the wire.
- A duplicate serial blocks the write before the unlock frame is sent;
  the operator can either pick a different candidate or send with
  `override_conflicts` when the duplicate is intentional (e.g. RMA
  replacement).
- **The read-back is the source of truth.** Writing a serial makes the
  inverter re-initialise its Modbus stack, so the FC16 write *response* is
  frequently lost even though the write physically landed. The pipeline
  therefore always performs the verify read-back (longer settle + retries
  when the write wasn't acknowledged) and decides the outcome from what the
  unit actually reports: a confirmed read-back is `success` even if the
  write ACK was lost (flagged `write_ack_lost`). Only a read-back that
  still shows the old serial is a true failure. If neither the write ACK
  nor a read-back can be obtained, the result is `write_unconfirmed`
  (never reported as success) — rescan to confirm.
- **One credential, end to end.** The entire Serial Number feature —
  single Read / Send, Read-all, Plant Serial Map scan, Bulk Fix
  plan/apply, and the duplicate override — is gated by **one** key:
  the authorization key (`adsiMM`) — the same rolling key used for every
  privileged action across the dashboard. Pure read surfaces (audit log,
  migration history, cached map, target map) need no key at all.

#### Plant Serial Map

| Control | Function |
| --- | --- |
| `Scan plant` | Reads every `(inverter, slave)` pair via FC11 in parallel. Bulk-auth required because this drives traffic on the shared bus. |
| `Bypass 5-min cache` | When checked, ignores the cache and re-reads every inverter from the wire. |
| `Show cached map` | Renders the last cached fleet map without triggering any new reads (works in remote mode). |
| Fleet table | One row per `(inverter, slave)` with current serial, model, firmware, and a duplicate-detection badge. |

#### Bulk Fix

Re-writes the entire plant against the **locked factory serial map**
(`docs/Fixed_Inverter_SerialNumbers.xlsx`) in one reviewed pass, instead of
editing 100+ nodes one at a time.

| Control | Function |
| --- | --- |
| `Show target map` | Displays the locked factory map for all 27 inverters, generated 1:1 from the authoritative `docs/Fixed_Inverter_SerialNumbers.xlsx` (the permanent field guide). `T` is the inverter nameplate (reference only — never written); slaves 1–4 are the writable nodes. Read-only — works in remote mode. |
| `Scan & diff` | Reads every node from the wire and compares it to the locked map. Bulk-auth required. **No writes.** Each node is classified `match`, `mismatch`, `unreachable`, or `no live unit`, and each mismatch gets an **Origin**: `factory / unknown` (serial not in the map) or **relocated** (`⇄ Inv X / Node Y` — the live serial belongs to a different slot, i.e. a physically moved power module). Only `mismatch` rows are selectable. |
| `Acknowledge relocated module(s)` | **Auto-detected.** This control appears only when the current selection includes one or more relocated modules. It must be ticked to re-serialize moved boards; otherwise those rows are skipped (their origin is logged either way). It does not appear when nothing relocated is selected. |
| `Apply selected` | UNLOCK + WRITE + readback-verify the locked serial to every selected mismatched node, **one at a time**. Every write is recorded in `serial_change_log` (scope `bulk`) with the action timestamp, operator, old→new serial, and — for a moved module — a structured origin (`origin_inverter`/`origin_node`) plus an `origin_note` such as `module from Inv 4 / Node 1 (serial 400152915R41)`. Cannot be undone in one click. |
| `Load migration history` | Opens the **Measurement Board (Power Module) Migration History** — the chronological trail of every physically relocated board: origin slot → where it was found → re-serialized, with timestamp, operator, and result. It captures relocations re-serialized via **either** Bulk Fix **or** the one-by-one Read / Edit / Send tab, so the trail is complete regardless of method. Read-only; works in remote mode (reads the replicated `serial_change_log`). A relocation that was only detected but not yet acknowledged is listed as *detected (pending ack)* so nothing is lost. |
| `Export` (format selector) | Saves the full Measurement Board migration trail through the **standard export pipeline** — a styled Excel workbook (`.xlsx`) or CSV, written to the same Logs tree as every other export (`<csvSavePath>\All Inverters\Audits\`) with the same date-aware filename convention (`DD-MMYYYY All Inverters Measurement Board Migration.xlsx`). Columns: Date, Time, Plant, Operator, Board Serial (Old), Origin Inverter, Origin Node, Found At Inverter, Found At Node, New Serial, Outcome, Verified, Origin Note, Error. The folder opens automatically when done. Endpoint `POST /api/export/measurement-board-migration` (gateway export job; proxied + downloaded locally in remote mode, exactly like the Alarms/Audit exports). |

Operational rules:

- The source file is the **single source of truth**. If a field serial is
  wrong, fix `docs/Fixed_Inverter_SerialNumbers.xlsx` and regenerate the
  map — the dashboard cross-checks every live node against it.
- The serial numbering is **locked**: every node's serial is fixed even
  when a physical node is absent — its serial stays reserved and is never
  reused. That is what lets the dashboard recognise a relocated module by
  its serial. `Scan & diff` reports absent units as `no live unit` and
  never writes to them.
- **Module relocation tracking:** when you physically move a power module
  (e.g. Inverter 4 / Node 1 → Inverter 27 / Node 2), the moved board still
  reports its old serial. Bulk Fix recognises that serial as belonging to
  Inv 4 / Node 1, flags it relocated, requires the auto acknowledgement,
  and records where the board came from in the change log with correct
  timestamps — so the move is traceable for historical data.
- The fleet uniqueness scan is **skipped** during Bulk Fix because the
  factory map is pre-validated globally unique; transient mid-sweep
  collisions would otherwise produce false blocks. Every write is still
  readback-verified.
- Writes run sequentially to keep the shared RS485 bus quiet and the
  audit trail cleanly attributed.

Remote-mode behavior:

- The audit log mirrors from the gateway so remote operators can review
  past changes.
- `Read`, `Send`, `Scan & diff`, and `Apply selected` are disabled when
  running from a remote workstation because the FC11 / FC16 transactions
  must execute on the gateway-side network. `Show target map` and the
  audit log remain available.

#### Firmware Map

The nodes **within one inverter** should all run the **same firmware**.
The Firmware Map tab audits that invariant **per inverter** — each
inverter is judged only against *its own* nodes, never against other
inverters or a plant-wide version. Firmware rides the same FC11 payload
the serial scan already reads, so this is a **projection of the serial
scan — it adds no extra bus traffic**.

**What "firmware" means here (verified 2026-05-19):** the comparison uses
the **inverter firmware code** — the `AAV1003xx` string in the
**Firmware** column. This was confirmed by decompiling ISM's own FC11
parser (`IngeconModbusSlaveID_Freescale`): for this hardware family ISM
extracts exactly the serial plus *one* firmware code, and never a
separate display-firmware field. The two extra strings in the **Aux ID 1
/ Aux ID 2** columns (the `AAS…` values) are *unverified auxiliary
identifiers* the vendor tool does not treat as a firmware version — they
are shown for diagnostics only and are **not** part of the comparison
(so a blank or varying Aux value never raises a false alarm).

| Control | Function |
| --- | --- |
| `Scan firmware` | Reads every `(inverter, slave)` via FC11 (reusing the serial scan path). Bulk-auth required; gateway-only. |
| `Bypass 5-min cache` | Re-reads every inverter from the wire instead of serving recent cache hits. |
| `Show last snapshot` | Renders the last persisted firmware map without any new reads. Works in remote mode (reads the replicated `inverter_firmware_state`). |
| `Drift log` | Chronological trail of every inverter-firmware change detected between scans (`firmware_drift_log`). Works in remote mode. |
| Fleet table | One block per inverter (sorted by inverter number, then slave) with each slave's Firmware code, the two Aux IDs, and a per-inverter verdict pill. |

Per-inverter verdict pill:

- **all same** (green) — every readable node on the inverter runs the
  same firmware code.
- **mixed nodes** (red) — nodes *on the same inverter* run different
  firmware. This is the post-board-swap signature (a replaced power
  module brought a different firmware) — the firmware-side dual of the
  serial relocation guard.
- **partial read** (amber) — at least one node on the inverter could not
  be read this scan; the ones that answered agree.
- **no read** (red) — no node on the inverter answered.

Per-node Status is **same** or **different** *relative to the other nodes
on the same inverter* (the minority node in a mixed inverter is the one
shown **different**, with its Firmware cell highlighted).

A drift event is logged **only** when a previously-seen node's
**inverter-firmware code** actually changes between scans — first
sightings, unreadable nodes, and Aux-ID-only changes never create noise.
The snapshot of an unreadable node is never overwritten by a failed read.

**Field check (Utility / Calibration Tool):** the calibration tool exposes
a single-inverter `Firmware Check` for the connected inverter — it reads
slaves 1–4 and reports whether that one inverter's nodes match, so a
technician can confirm a freshly swapped board matches its siblings
without a full plant scan.

Remote-mode behavior:

- `Show last snapshot` and `Drift log` work remotely (replicated tables).
- `Scan firmware` is disabled on a remote workstation because the FC11
  reads must execute on the gateway-side network.

### 6.9.9 Cloud Backup & Restore

#### Provider Access

| Field or Action | Use |
| --- | --- |
| `Email` | Provider suggestion or reference only |
| `Backup Provider` | `Auto`, `OneDrive`, `Google Drive`, `S3-compatible`, or `Both` |
| `Authorize OneDrive` | Starts Microsoft provider authorization |
| `Authorize Google Drive` | Starts Google provider authorization |
| `Validate & Connect` | Validates the configured S3-compatible bucket and stores the credential pair locally |
| `Disconnect Provider` | Disconnects the current provider session |
| `Azure Client ID` | OneDrive authorization client ID |
| `Google Client ID` | Google authorization client ID |
| `Google Client Secret` | Stored locally after save; not shown again |
| `S3 Endpoint / Region / Bucket / Prefix` | Object-storage location and folder-style prefix |
| `S3 Access Key ID / Secret Access Key` | Stored locally after validation; not shown again |

#### Backup Policy

| Field | Use |
| --- | --- |
| `Enable scheduled cloud backup` | Enables scheduled backup execution |
| `Application data` | Include the main database plus forecast model bundles, forecast history context, weather cache, Solcast reliability artifacts, and forecast snapshots |
| `Configuration files` | Include configuration settings |
| `Logs (optional)` | Include log files when needed |
| `Schedule` | `Manual only`, `Daily at 3:00 AM`, or `Every 6 hours` |
| `Backup date tag` | Date tag used for package labeling |

#### Backup Actions

| Action | Function |
| --- | --- |
| `Save Backup Settings` | Saves cloud backup configuration |
| `Backup Now` | Creates and uploads a backup package immediately |
| `Refresh Cloud List` | Lists available cloud backups |
| `Refresh backup history` | Refreshes local backup activity and restore list |

#### Backup Activity and Restore

The backup activity table reports:

- date and time
- backup tag
- included scope
- backup size
- backup status
- cloud provider

Forecast data is packaged under the same backup when `Application data` is selected. This includes the active SQLite database and the forecast engine artifact directories stored under `ProgramData\\InverterDashboard`.

For `S3-compatible` storage, unchanged backup content is chunk-deduplicated and reused across later backups instead of being uploaded again.
- available actions

Restore behavior:

- restore creates a safety backup first
- restore overwrites the active database and configuration
- restore requires application restart to complete cleanly

## 6.10 Camera Viewer

The `Camera Viewer` is a live IP camera card displayed within the main inverter grid. It supports three streaming modes and includes an integrated go2rtc process manager for RTSP-to-browser streaming.

### Camera Card

The camera card is a draggable card that participates in the inverter grid layout alongside inverter cards. It displays:

- **Live video viewport** filling the card body
- **Top-left overlay**: Camera name label (e.g., `Tapo C110 - Live`)
- **Top-right overlay**: Blinking red dot indicator when the stream is active
- **Bottom controls bar**:
  - ⚙️ Settings — opens the Camera Settings modal
  - 🔇/🔊 Mute/unmute toggle
  - **Viewer window** — opens the Tapo stream in a standard framed Electron window
- **Loading spinner** while buffering
- **Error overlay** with `Retry` button when the stream fails
- **Auto-reconnect** every 5 seconds on stream drop

The viewer-window control replaces browser DOM fullscreen. It pauses the dashboard card and opens **ADSI – Tapo Camera Viewer** with normal Windows move, resize, minimize, maximize/restore, and close controls. Inside that operating-system frame, only the video surface is rendered—card labels, settings controls, messages, alarms, footers, and other dashboard HTML are excluded. The viewer opens at 1280×820, can be reduced to **480×300**, and keeps the video full-bleed with its aspect ratio preserved. Closing it releases the viewer stream and resumes the dashboard card only when its owning page is visible. Double-clicking Tapo video opens the same viewer.

### Stream Modes

| Mode | Backend | Description |
| --- | --- | --- |
| **HLS** | go2rtc | HTTP Live Streaming. Best compatibility, ~2-5 s delay. Default mode. |
| **WebRTC** | go2rtc | Ultra-low latency (<1 s). Requires STUN/TURN for NAT traversal. |
| **FFmpeg** | Server | Direct RTSP transcode via FFmpeg. MPEG1/TS over WebSocket. Requires FFmpeg installed on server. |

### Camera Settings Modal

Click the **⚙️ Settings** icon on the Tapo camera card to open the modal. The modal is a page-level dialog centered on the screen (not card-scoped). Its header includes **Hikvision DVR**, which opens the separate DVR configuration modal without requiring controls on the native Hikvision card.

#### Stream Mode Selection

Three visual mode cards at the top of the modal. Click a card to select that mode. The selected card is highlighted with an accent-colored border. Selecting a mode dynamically shows or hides the relevant input sections below.

#### go2rtc Connection Fields (HLS and WebRTC modes)

| Field | Default | Description |
| --- | --- | --- |
| `Tailscale / Server IP` | `100.93.11.9` | IP address where go2rtc is reachable (localhost or Tailscale VPN IP) |
| `API Port` | `1984` | go2rtc API port |
| `Stream Key` | `tapo_cam` | Stream name configured in `go2rtc.yaml` |

#### RTSP Connection Fields (FFmpeg mode)

| Field | Default | Description |
| --- | --- | --- |
| `Camera IP` | `192.168.4.211` | RTSP camera IP address |
| `RTSP Port` | `554` | RTSP port |
| `Stream Path` | `stream1` (High Quality) | `stream1` or `stream2` (Low Quality) |
| `Username` | `Adsicamera` | Camera login username |
| `Password` | *(empty)* | Camera login password (masked with show/hide toggle) |

A warning banner appears in FFmpeg mode: *Direct FFmpeg mode requires FFmpeg installed on the server.*

#### go2rtc Service Controls (HLS and WebRTC modes, gateway mode only)

This section is hidden when FFmpeg mode is selected or when operating in remote mode.

| Control | Description |
| --- | --- |
| **Status** | Current process state: `running`, `stopped`, `starting`, `error` |
| **PID** | Process ID when running |
| **Crashes** | Consecutive crash count (resets on manual start) |
| **Health** | Timestamp of last successful health check |
| **Auto-start on server boot** | When checked, go2rtc starts automatically when the Express server boots in gateway mode |
| **Start** | Starts the go2rtc process |
| **Stop** | Stops the go2rtc process gracefully |

The service status grid polls `GET /api/streaming/go2rtc-status` every 5 seconds while the modal is open. Polling stops when the modal is closed.

#### Modal Actions

| Button | Function |
| --- | --- |
| `Reset Defaults` | Restores all fields to factory defaults |
| `Apply & Connect` | Saves settings to localStorage, persists auto-start to server, closes modal, and reconnects stream |

### Settings Persistence

| Setting | Storage | Scope |
| --- | --- | --- |
| Stream mode, IPs, ports, credentials | `localStorage` (per key) | Browser/client |
| go2rtc auto-start | Server setting (`go2rtcAutoStart`) | Server-wide |

### go2rtc Service Behavior

| Behavior | Detail |
| --- | --- |
| **Gateway-mode only** | Start is blocked with HTTP 403 in remote mode |
| **Localhost-only binding** | API on `127.0.0.1:1984`, WebRTC on `127.0.0.1:8555` |
| **Auto-restart on crash** | Up to 3 consecutive crashes, then stops with `error` status |
| **Non-blocking** | go2rtc failure never blocks server startup or other dashboard features |
| **Graceful shutdown** | Stopped automatically during app shutdown, update install, or server stop |
| **Config override** | Place a `go2rtc.yaml` in `C:\ProgramData\InverterDashboard\go2rtc\` to override bundled defaults |

### Separate Hikvision DVR Card

The Hikvision DVR uses its own draggable dashboard card, settings modal, browser stream, native decoder bridge, and API routes. Its DVR-specific connection stays separate from the Tapo configuration. The polished modal groups secure stream paths, device identity, DVR connection, channel/playback, stream profile, and playback status into separate panels. Enter the DVR's local username and password; Hik-Connect cloud credentials and camera access codes are not used. The SDK/HTTP port defaults to `80`, while RTSP defaults to `554`.

Use **Hybrid HLS + native viewer window** for normal operation. On the Inverters-page card, FFmpeg supplies browser-safe H.264 HLS. Expect roughly 2–3 seconds of latency and modest transcoding loss. The native-viewer control pauses card HLS and opens a standard Electron window like the Analytics popout. Hikvision LocalService fills its content area at the DVR's original quality and frame rate. The installed dashboard normally runs without elevation so Windows permits LocalService to embed this native surface; do not force **Run as administrator**. Use the normal Windows title-bar controls to move, resize, minimize, maximize, restore, or close it. The viewer can be reduced to **480×300** for flexible side-by-side and multi-monitor layouts. Closing the window stops the native decoder and resumes HLS automatically when Inverters is visible.

When the operator navigates away from Inverters, the Hikvision card disappears with that page and its HLS playback stops. Returning to Inverters restores the card in its saved grid position and reconnects playback. The card provides **Settings** and **Open native viewer window** controls. Closing the native viewer resumes the card only when Inverters is visible. Native playback is restricted to its owning viewer window, and rapid window transitions cancel stale starts. If LocalService cannot start, the viewer shows a **Retry** button; otherwise the native video fills the content area.

**Compatible snapshots** remains a low-frame-rate fallback, while **Direct HLS** remains a raw-codec diagnostic mode; these explicit modes use ordinary HTML fullscreen instead of opening the native viewer. **Prepare H.264 Substream** is an optional isolated change to channel **xx02** and never modifies **xx01**. A blank password means “keep the existing password.”

#### Hikvision routing in Gateway and Remote modes

The settings modal has an explicit **Gateway mode** or **Remote mode** context banner. Camera routing is selected independently from inverter-data authority:

| Playback surface | Gateway mode | Remote mode |
| --- | --- | --- |
| Inverters-page camera card | Local H.264 HLS generated beside the DVR | Prefers the authenticated gateway HLS relay; automatically uses workstation-direct HLS over the local LAN or Tailscale when the relay is missing, unhealthy, or invalid and the DVR is reachable |
| Native viewer window | LocalService connects directly to the DVR over the plant LAN | LocalService connects directly over the local LAN when the workstation shares the DVR subnet; otherwise it uses the approved Tailscale subnet route |

In Remote mode the gateway relay remains preferred. A workstation-side go2rtc/FFmpeg pipeline starts only as a camera fallback when the relay cannot provide a valid HLS stream and the configured DVR RTSP port is directly reachable. This does not switch operation mode: inverter telemetry, history, writes, replication, and forecasts remain gateway-authoritative. Native LocalService and direct HLS use the DVR password saved locally on that viewer; the gateway password is never returned through the API. Gateway host, port, channel, stream, and username changes synchronize to the viewer when the gateway supports the Hikvision routes.

In **Complete Remote mode**—where the workstation is outside the plant LAN and has no approved DVR subnet route—the workstation cannot create camera HLS itself. A compatible gateway Hikvision relay is therefore required. If both the gateway relay and direct DVR route are unavailable, the modal reports **No reachable HLS path**, disables route-dependent actions, and tells the operator to update/restart the gateway camera relay or approve the least-privilege DVR `/32` route. It does not start an idle local transcoder or misreport an HTML response as HLS.

During a rolling deployment, an older gateway may not expose `/api/hikvision/*`, may return HTML with HTTP 200, or may have an unhealthy camera service. The viewer validates the playlist before Hls.js sees it, contains invalid markup, marks the relay degraded, and selects the direct workstation path when available.

For least privilege, configure the gateway as a Tailscale subnet router advertising only the DVR host, for example `192.168.1.12/32`, instead of the entire plant subnet. Approve that route in the Tailscale admin console and grant only approved viewer devices access to the configured SDK/HTTP and RTSP ports (normally TCP `80` and `554`). The **Secure Stream Paths** panel and **Check Routes** button report:

- whether the dashboard card is gateway-relayed or using workstation-direct HLS
- whether this workstation can reach the DVR's SDK port for native playback
- whether the DVR is on the workstation's local subnet; Tailscale is shown as optional in that case
- whether Tailscale is installed and connected when a subnet route is required
- the recommended `/32` route when native playback is blocked

The route check is read-only. It opens bounded TCP connectivity probes and never starts video, changes the DVR, or activates a microphone.

| Hikvision control | Purpose |
| --- | --- |
| Gear button / `Tapo Camera Settings > Hikvision DVR` | Opens the dedicated Hikvision DVR configuration modal |
| Native viewer button or double-click video | In recommended hybrid mode, pauses HLS and opens an Analytics-style framed, resizable LocalService window |
| Windows title-bar controls | Move, resize, minimize, maximize/restore, or close the native viewer; closing stops the decoder and resumes H.264 HLS |
| `Playback Mode` | Selects hybrid HLS/native playback, compatible snapshots, or diagnostic direct HLS |
| `SDK / HTTP` | Port used by LocalService native playback; default `80` |
| Mode banner and `Secure Stream Paths` / `Check Routes` | Separates Gateway-hosted playback from Remote relay/direct-fallback behavior and reports the active LAN or Tailscale route without starting playback |
| `Verify Connection` | Saves the current fields and verifies the browser-safe HLS stream against the DVR |
| `Prepare H.264 Substream` | Converts only the selected channel's xx02 profile to browser-compatible H.264 after confirmation |
| `Save & View` | Persists the Hikvision configuration and reconnects the dedicated card |
| `Start` / `Stop` | Starts or stops the current Hikvision presentation |

### Troubleshooting

| Problem | Likely Cause | Action |
| --- | --- | --- |
| Stream fails to load | go2rtc not running | Open camera settings, check Status, click Start |
| go2rtc won't start | Port 1984 or 8555 already in use | Stop conflicting process or change ports in `go2rtc.yaml` |
| WebRTC shows no video | NAT or firewall blocking UDP | Ensure STUN server is reachable, configure TURN if behind strict NAT |
| FFmpeg mode shows no video | FFmpeg not installed | Install FFmpeg and add to system PATH |
| Service controls hidden | Remote operation mode | Switch to Gateway mode in Settings > Connectivity |
| Status shows `error` | 3+ consecutive crashes | Check RTSP source and `go2rtc.yaml` config, then manually restart |
| Hikvision card stays on “Starting” | The Hikvision media service is unavailable, the DVR is unreachable, or the local DVR login failed | Verify the DVR/LAN connection, then use `Verify Connection` |
| Remote gateway relay is unavailable | The gateway is older, its camera service is unhealthy, or it returned a non-HLS response | Use **Check Routes**. If RTSP is reachable, the viewer selects direct HLS automatically; otherwise restore the gateway relay or the DVR subnet route |
| HLS works but the native viewer is blank | Hikvision LocalService is unavailable, or the dashboard was manually forced to run as administrator | Start LocalService, relaunch the dashboard normally (not **Run as administrator**), then select **Retry** |
| Remote card works but native viewer is blocked | The gateway relay is healthy, but the viewer has no approved route to the DVR or no viewer-local DVR password | Advertise and approve the DVR `/32` route, allow the SDK/RTSP ports in the tailnet grant, enter the password on the viewer, then use **Check Routes** |
| Secure Stream Paths shows Tailscale offline | Tailscale is stopped or signed out on a workstation that is not on the DVR's local subnet | If the modal says **local LAN active**, no action is required. Otherwise connect Tailscale, confirm the correct tailnet, then rerun **Check Routes** |
| Hikvision profile or stream is unavailable | DVR IP, RTSP account, or LAN route is incorrect | Verify the DVR is reachable, then use `Test Stream` |

---

## 6.11 Field Calibration Page (v2.11.x)

The **Field Calibration** page is a dedicated top-nav workspace
(navigation bar → `FIELD CALIB`) that surfaces each inverter electronic
block's INGECON-firmware scale-factor / reactive-curve calibration over
Modbus TCP, so an operator can read and adjust the same values that the
local LCD display exposes under **Ajustes → Other Adjustments → Scale
Factor Adjustments** — **without** walking the inverter cabinet and
stepping through arrow-key menus.

Read-only access is concurrent with normal dashboard operation; the
**write path** is gated by the `calibrationWritesEnabled` setting
(default OFF) and requires an active calibration session that triggers
dashboard lockdown.

### Per-Node Readout tab

Pick an `Inverter` and `Node` (1..4), enter the topology auth key
(`adsiM` or `adsiMM` where `M` is the current minute), and click
**Read**. The dashboard issues an FC03 read of holding registers
`0x50..0x5E` (15 UInt16s) and displays:

| Register window | What it shows |
|---|---|
| `ValidCfgCode` (offset 80) | Must read `0x1F1F`. If anything else, the inverter's config block is in an unexpected state and **writes will refuse**. |
| **AC Voltage** group: `F_E_Vac1/2/3` (offsets 81-83) | Per-phase AC voltage full-scale calibration constants (display labels match LCD). |
| **AC Current** group: `F_E_Iac1/2/3` (offsets 84-86) | Per-phase AC current full-scale (low-gain). |
| **DC** group: `F_E_Ipv` (87), `F_E_Vpvp` (88), `F_E_Vpvn` (89) | DC input current + DC voltage (+/−) full-scale. |
| **Active P** group: `Per. Vacio` (90) | Self-consumption / standby compensation. |
| **Reactive 1** group: `Pot. Reactiv_X1`, `Comp. Reacti_Y1` (91-92) | First point of the digital reactive-power curve (Pn = 20 % per display calibration procedure). |
| **Reactive 2** group: `Pot. Reactiv_X2`, `Comp. Reacti_Y2` (93-94) | Second point (Pn = 70 %). `Y2` is the only field that decodes as signed Int16. |

The **Full Config Dump** button issues a slow FC03 read of all 177
registers (offsets `0x00..0xB0`) and additionally surfaces:

- Inverter RTC mirror (offset 0-5) — useful for cross-checking the clock-sync log
- Grid envelope (Vacmin/Vacmax, Facmin/Facmax)
- Nominal and limit active power (decoded as Watts)
- Country / grid-standard code
- Raw register dump (collapsible) — 14 rows × 13 cols of hex words

### Fleet Anomalies tab

Click **Scan Fleet** (also gated by topology key). The dashboard walks
every configured `(inverter, slave)` pair, reads each calibration block,
computes the per-field median across the fleet, and displays each node's
delta versus median. Color thresholds:

| Δ vs median | Color | Meaning |
|---|---|---|
| ≤ 2 % | green | within normal sensor manufacturing tolerance |
| 2–5 % | orange | drift worth investigating on next maintenance visit |
| > 5 % | red | outlier — likely a recently-replaced module with stale factory calibration, or a sensor that needs recalibration |

A full 108-node fleet scan takes ~10 s and is throttled to one
concurrent call (the second operator click receives HTTP 429 until the
first scan finishes).

### Calibration Session (writes + dashboard lockdown)

Click **`[Start Calibration Session]`** after picking an inverter / node,
entering your initials, and supplying a topology key (`adsiM` /
`adsiMM`). The session card turns red, the dashboard enters **lockdown
mode**, and a persistent banner pins to the top of every page.

While a session is active:

- **All other top-nav pages are hidden** — only the Field Calibration page is reachable.
- **APC writes are refused** for the session's inverter (operator must
  drive `%Pn` via the consign tiles instead).
- **Critical-pattern auto-block enforcer is suspended** for the session's
  inverter (alarms still record, but no auto-STOP fires).
- **Auto-reset is suspended** for the session's node.
- **Per-register write inputs appear** on the per-node readout table.
- **Heartbeat pings the server every 10 s** — if your laptop closes or
  the network drops for 30 s, the session auto-ends and the dashboard
  restores normal operation.
- **Hard ceiling of 30 minutes** — sessions auto-end at the absolute
  limit regardless of heartbeat.

Click **`[End Session]`** to release consign, write a post-session
snapshot, and restore all paused background processes.

### Writing a calibration value

After starting a session, the per-node readout table gains a `New Value`
column with editable inputs and a `Write` button per row. To write:

1. Enter the new value (an integer; signed for offsets 92, 94)
2. Enter your `adsiMM` key in the bulk-auth field (`adsi` + current
   minute, e.g. `adsi37`)
3. Click `Write`
4. Confirm the modal showing old → new

The pipeline runs: **UNLOCK → WRITE → 1 s settle → VERIFY**. A
read-back confirms the new value landed. The `ValidCfgCode = 0x1F1F`
sentinel is checked before AND after the write — if it changes, the
write reports `sentinel_clobbered` and the operator must investigate
before continuing.

**Range guard:** writes whose delta vs current is greater than 50 % are
refused. Tick `Force (bypass 50 % range guard)` to override (logged in
the audit trail with the override flag).

**Every write is audited** in the `calibration_write_log` table:
`session_id`, `operator`, `inverter`, `slave`, `reg_offset`,
`param_name`, `value_before`, `value_requested`, `value_after`,
`verify_ok`, `auth_method`, `error_detail`. Retention 5 years.

### Consign Mode

When a session is active, a panel appears with tile buttons:
**`10 %`** / **`20 %`** / **`60 %`** / **`70 %`** / **`Release`**.

Clicking a tile drives `cmd-3` (APC) to that percentage of nominal
power. The 5 presets correspond to the training PDF's consign steps:

- **10 %** — initial DC current calibration ladder
- **20 %** — reactive curve X₁Y₁ calibration point
- **60 %** — DC current calibration target
- **70 %** — reactive curve X₂Y₂ calibration point
- **Release** — restore to 100 % Pn

Between distinct setpoints, a 30-second dwell timer enforces PAC
settling time before another consign command will be accepted. The
release-to-100 % command is exempt from the dwell guard.

Consign auto-releases on session end (returns to 100 %).

### Bulk Copy

The `Copy from another node` panel lets you read a donor inverter's
calibration block and write every differing field to the session
target under one unlock + verify cycle. Useful after a module swap when
the new electronic block's factory calibration differs from a known-good
sibling.

Both source and destination must have `ValidCfgCode = 0x1F1F`. Only
fields where source ≠ destination are written — no-op fields are
skipped. Every write goes into the audit log with
`auth_method = adsiMM+session+copy` and a `notes` column citing the
source.

### Feature flag

Calibration writes are gated by the `calibrationWritesEnabled` setting,
default `0`. Set to `1` (Settings → Plant Configuration) after operator
sign-off. The `Start Calibration Session` button stays disabled when
the flag is off, with a tooltip explaining how to enable. The page
toolbar shows a `Writes: ENABLED / OFF` badge so the current state is
visible at a glance.

### Firmware Upgrade (EXPERIMENTAL)

> **Irreversible.** Flashing rewrites the inverter DSP program and
> **cannot be undone**. A wrong or interrupted image can brick the unit.
> This feature is gated, experimental, and available **only in the
> standalone Utility Tool** (not the dashboard). Use it only
> with the manufacturer-supplied image for the exact unit, after operator
> sign-off.

A **FW Upgrade** button at the top-right of the per-node controls row
(standalone calibrator only) opens the **Firmware Upgrade** dialog,
presented as a guided **4-step wizard** — *File → Target → Dry-run →
Flash*. A progress rail shows each step's status (done / current /
locked); a later step stays locked until its prerequisite is met, so the
irreversible step cannot be reached by accident:

1. **Connect a transport** to the target inverter — either **Ethernet**
   (Modbus-TCP via the transparent gateway) or **RS485-USB** (Modbus-RTU,
   the most-direct link to the node DSP — no comm board / gateway in the
   loop). The flash uses whichever is connected. For a serial flash the
   tool takes **exclusive ownership of the COM port** for the duration
   (the serial analogue of the RS-485 bus lock); reconnect the transport
   in the calibrator afterwards. The `0x96` high-speed/baud-bump frame is
   never sent, so there is no baud-switch race at any speed.
   *Bus-lock note:* for an Ethernet flash, the dashboard's live poller is
   a second Modbus master on the same gateway. The flash now publishes a
   cross-process claim so the dashboard **automatically pauses polling of
   that one inverter** for the duration (it is shown as *maintenance*, not
   offline, and not counted as downtime) and resumes the moment the flash
   ends. This prevents the two-master collision that otherwise makes the
   DSP reject the start with *"firmware load start (0x90) error code 2"*.
   The claim self-expires (~2 min) if the calibrator crashes, so polling
   can never be permanently silenced.
   *Transport status:* the dialog shows a **transport-status line** near the
   top — **green** when a link is open, **amber** with an inline **Connect…**
   shortcut when none is. So you know *before* clicking whether **Read
   Identity** and **FLASH (live)** can actually reach the unit; both guide you
   to connect a transport instead of failing with a cryptic error. (Dry-Run is
   hardware-free and needs no transport.)
2. **Browse… to the firmware file.** The native OS file picker opens;
   choose the `.S` Motorola S-record image (you may also paste an
   absolute path). The filename must follow the ISM `LLLnnnn…` rule
   (e.g. `AAV1003IJK01BC_InverterFirmware.S`); the server still verifies
   it is a real `.S` file, size-capped, and SHA-256-pinned to the
   dry-run.
3. **Set the target node** (1–247; broadcast/0 is forbidden) and
   optionally **Read Identity** — an FC11 Report-Slave-ID showing the
   exact serial / model / running firmware of the unit you would flash.
   When a file is already selected, the readout also states whether the
   flash is an **upgrade**, **downgrade**, or **no change** (unit version →
   file version), mirroring ISM's pre-flash advisory so you confirm the
   direction *before* arming.
4. **Dry-Run (safe).** This simulates the *entire* flash against an
   in-memory DSP with **zero hardware contact**. It also computes and
   displays the file's **SHA-256**, and verifies that the firmware **code
   embedded in the image matches the filename** (ISM's
   `VerificaFicheroFirmware` *"Invalid firmware"* guard) — so a renamed or
   corrupt file is rejected here, before you can arm. A successful dry-run
   of the *exact* selected file/node/parameters is a hard precondition for
   arming the live flash — changing any of them re-disables the live button.
5. **Arm.** The live block reveals only after a passing dry-run. You
   must (a) tick the irreversible-acknowledgement box and (b) supply the
   authorization key (`adsiMM`). The **FLASH (live)** button stays
   disabled until both hold and the SHA still matches.
6. **FLASH (live).** The flash runs as a background job with a live
   progress bar, an audit-event log, and an **Abort** button.

**Server-side gates (enforced regardless of the UI).** The live flash is
refused unless *all* hold: explicit irreversible confirmation; a prior
successful dry-run of the same SHA-256; exactly one link (a TCP host or
a serial COM port — never both, never neither); a
single non-broadcast node; a verified file (real regular file, `.S`,
size capped, ISM filename rule, SHA-256 match); the **embedded
firmware-code match** (the code stored in the image must match the
filename — ISM `VerificaFicheroFirmware`); an FC11 model/version
compatibility check (apparent downgrades blocked unless **Allow
downgrade** is ticked); an exclusive RS-485 bus lock; an audit sink; and
a watchdog deadline.

**Bootloader preservation.** The loader never transmits the bootloader
or reset-vector banks. An interrupted or aborted application flash
therefore leaves the unit **re-flashable** — Abort is fail-safe and is
intentionally *not* behind an auth prompt so it is always immediately
available. While a flash is running the dialog **cannot be closed** (the
X, the backdrop, and Escape are all blocked); wait for completion or use
**Abort**, so an in-progress irreversible operation is never hidden.

**Post-flash verification.** After a successful flash the tool re-reads
the unit's FC11 identity (ISM `Identifica`) and reports the firmware it
now runs, so you can confirm the new image booted. This is read-only and
best-effort: if the unit is still rebooting and cannot be re-read, the
log says so and asks you to verify manually — it never marks a
successful flash as failed.

**Downgrade is possible.** The DSP bootloader and the on-wire protocol
enforce no version monotonicity — the loader erases and writes whatever
compatible image you send, older or newer. In ISM the
upgrade-vs-downgrade decision is purely an application-layer policy
(`QueHableAhoraOCalleParaSiempre(newCode, forceDowngrade)` /
`CheckCanUpgradeFirmware`), bypassable with ISM's own *force* flag. This
tool mirrors that: the downgrade block compares the unit's **authoritative
`model_code` version** (the `AAV1003xx` firmware FC11 actually reports)
against the file's version trailer, and is lifted by ticking **Allow
downgrade** under Advanced. (It deliberately does *not* use the FC11
`AAS…` auxiliary IDs, which are not the running firmware.) This guard is
conservative and does not change what the hardware accepts — the
bootloader takes any compatible image. The file↔model prefix check
(`AAV1003…`), the embedded firmware-code match, and the SHA-pinned
dry-run still apply, and bootloader-bank preservation keeps even a
mistaken-direction flash recoverable.

**Audit trail.** Every live attempt and its outcome is appended to
`firmware-audit.jsonl` under `%PROGRAMDATA%\InverterDashboard\`
(`firmware.pre_flash.direction` with the upgrade/downgrade decision;
`firmware.live.start` / `.ok` / `.fail` with host, node, file, SHA-256,
and frame counters; and `firmware.live.verify_ok` / `.verify_warn` with
the old → new firmware codes from the post-flash re-read).

### What this does NOT replace

- The multimeter and 3-phase wattmeter still go on-site with the
  technician. Calibration is iterative: read the live measurement,
  compute the new scale factor, write, verify against the meter, repeat.
- Configuration regions outside offsets 81–94 (alarm thresholds, Q-V/Q-P
  thresholds, derating curves) are intentionally out of scope. Those
  remain ISM-only commissioning-tier settings.
- The serial-number write path (`0x9C74` + 0xFFFA unlock magic) is a
  separate feature under Settings → Serial Number Setting.

---

## 7. Auxiliary Windows

## 7.1 Global Configuration

The `Global Configuration` window is the compact administration surface for inverter addressing, plant/data settings, hardware endpoints and inverter clocks, and connectivity/backup status. Open it from **Settings > Global Configuration** or `Ctrl+I`. Access requires an auth gate key (`adsiM` or `adsiMM`, where M is the current minute). The session lasts 1 hour.

The window is available in **both Gateway and Remote mode**. When opened on a Remote viewer, a banner indicates that edits are saved to the gateway (the authoritative source) and mirrored back to the local viewer, so an operator working away from the plant can update inverter addressing without remoting into the gateway PC. The local device-reachability scan (gear-icon status, the **Check Status** button, and the "Online x / 27" counter) is suppressed in Remote mode because those inverters live on the gateway's LAN and are not reachable from the viewer; the gateway continues to poll them normally.

### Configuration Tabs

| Tab | Purpose |
|-----|---------|
| **Network & IP** | Inverter IP addresses, poll intervals, enabled nodes, loss factors, reconnect, and device-page access. |
| **Plant & Data** | Plant/operator identity, fleet sizing, dashboard grid layout, export folder, retention, and forecast provider. |
| **Hardware & Clocks** | Python inverter-service data/write endpoints plus daily inverter RTC synchronization and drift threshold. |
| **Connectivity & Backup** | Gateway/Remote mode, gateway URL/token, Tailscale hint, standby auto-refresh, live link state, backup readiness, and gateway-only portable backup export. |

License and application-update controls are intentionally kept in the main **Settings** page because they belong to the individual workstation and are not gateway-synchronized global configuration.

Use **Save All Changes** to commit pending editable settings across the tabs. A dot on the button indicates unsaved changes. Server validation errors remain visible in the bottom status bar and are never reported as successful saves. Switching from Remote to Gateway mode displays a warning and restarts the desktop app after a successful save so the new local-authority state starts cleanly.

### Network & IP Table

Each of the 27 inverters has one row with the following columns:

| Column | Description |
|--------|-------------|
| **Inverter** | Inverter number and device label (INV-01 -- INV-27). Click the gear icon to open the inverter web page. |
| **IP Address** | IPv4 address of the inverter on the local network. |
| **Polling Interval (s)** | How often the gateway polls this inverter, in seconds (min 0.01, default 0.05). |
| **Enabled Units** | Which nodes (1--4) are active. Use **All** to toggle all four. Empty selection disables the inverter. |
| **Loss %** | Estimated MW transmission loss from this inverter to the substation (0--100%). Default is `2.5%` per inverter unless overridden. Used exclusively by the forecast engine for substation-level accuracy; does *not* affect live dashboard readings, energy totals, or exports. |
| **Save** | Saves the individual row without discarding edits still pending in other rows. Use **Save All Changes** at the bottom to save every pending row and global setting. |

IP Config is also the authority for live inverter identity. The dashboard binds telemetry to an inverter by the configured IP address and enabled node list, not by any assumed IP numbering pattern. Cards, selectors, and alarm labels may show the configured IP alongside `INV-xx` so operators can verify the assignment directly.

### Loss % and Forecasting

Loss % is forecast-only. The dashboard, logged telemetry, daily reports, and exports continue using raw measured values. The day-ahead forecast engine adjusts historical 5-minute energy data per inverter before training so the ML model and Solcast reliability calibration learn substation-level output patterns rather than raw inverter output. Solcast forecasts themselves are treated as already substation-based and are not reduced again by `Loss %`. Raw Solcast power arrives in `MW` and is normalized to `kWh` per 5-minute slot for forecast scoring, and the forecast artifact keeps daily weather-bucket resolution history on that same loss-adjusted actual basis.

Example: if INV-15 has a 2.5% loss (degraded cable) and INV-26 has 1.0% (far from substation), the forecast engine reduces their historical energy contributions by those percentages when building training data, computing error corrections, and scoring forecast quality.

### Additional Controls

- **Check Status** -- scans all configured IPs for reachability and shows an online count.
- **Topology** -- opens the visual plant topology map (Gateway mode only).
- **Theme toggle** -- switches between light and dark mode for this window.
- **Export .adsibak** -- creates a complete portable backup from the gateway workstation; it is disabled on Remote viewers.
- **License / update actions** -- refresh or replace the license and check, download, or install application updates through the desktop shell.

### Operational Notes

- This function is intended for authorized personnel only.
- In `Remote` mode, the dashboard blocks access to gateway-only configuration actions.

## 7.2 Topology

The `Topology` window provides a plant-wide visual status overview.

Typical use:

- review fleet structure visually
- identify online, offline, or unknown device states
- move quickly between a status map and IP configuration

Operational note:

- topology is treated as a gateway-side operational tool
- access may be blocked in `Remote` mode

---

## 8. Standard Operating Workflows

## 8.1 Daily Startup Check

1. Launch the application and complete sign-in if required.
2. Wait for the startup loading screen to finish before evaluating live values.
3. If operating in `Remote` mode and the gateway is unreachable, the loading screen will present a **Connection Mode** picker instead of a generic error. Choose **Gateway Mode** to switch to local Modbus polling, or choose **Remote Mode** to retry the gateway connection.
4. Confirm the license notice area is clear.
5. Check the header connection dot and clock.
6. Review `TOTAL PAC` and `TODAY MWh`.
7. Open the `Inverters` page and confirm online, alarmed, and offline counts.
8. If operating remotely, confirm `Connectivity & Gateway Link` status in Settings.

## 8.2 Live Control Workflow

1. Open the `Inverters` page.
2. Select the target inverter or node.
3. Review current alarm state and last-seen freshness.
4. Send the required `START` or `STOP` action.
5. Confirm the result through status updates, toast feedback, and audit history.

## 8.3 Bulk Inverter Workflow

1. Enter inverter numbers or ranges in the bulk command field.
2. Normalize the entry if needed by using `All Inverters` or reviewing the accepted range.
3. Click `START SELECTED` or `STOP SELECTED`.
4. Enter the required authorization key when prompted.
5. Confirm results from toast messages and the `Audit` page.

## 8.4 Plant Output Cap Workflow

1. Open the **Plant Cap** page from the navigation bar.
2. Enter the required `Upper Limit (MW)` and `Lower Limit (MW)`.
3. Choose the inverter `Sequence` and add any `Exempted Inverter Numbers` if needed.
4. Review the client warnings, especially narrow-band warnings.
5. Click `Preview Plan`.
6. Review the proposed inverter step, projected plant MW, and reason text.
7. Click `Enable Cap` and complete the required authorization.
8. Monitor `Status`, `Reason`, `Last Action`, `Cooldown`, `Curtailed`, and planner warnings while the session is active.
9. Cap-stopped inverter cards show a blue `CAP STOPPED` badge with the stoppage time for at-a-glance identification in the inverter grid.
10. Review the `Controlled Inverters` table inside the cap panel for duration, removed Pac, rated kW, and dependable kW per stopped inverter.
11. Use `Disable Monitoring` to stop automation without restarting controller-owned inverters, or use `Release Controlled Inverters` to restart them sequentially and end the session.
12. Check the `Audit` page for a full record of cap controller actions (scope: `PLANT-CAP`) with decision reasons.

## 8.5 Scheduled Auto-Cap Workflow

1. Open the **Plant Cap** page.
2. Click **+ Add Schedule** in the toolbar.
3. Fill in Name, Start Time, Stop Time, and optional MW/Sequence/Cooldown overrides.
4. Enter the Auth Key and click **Save**.
5. Monitor schedule chips for state transitions (Waiting → Active → Completed).
6. Edit or delete schedules via the pencil icon on each chip.

Important:

- plant-cap control runs as whole-inverter sequential control in current builds
- very narrow MW bands may not be reachable cleanly with whole-inverter steps
- in `Remote` mode, plant-cap actions are proxied to the gateway workstation
- if preview or enable fails with `Cannot POST /api/plant-cap/...`, update or restart the gateway app and verify the configured `Remote Gateway URL`

## 8.5 Alarm Review Workflow

1. Open the `Alarms` page.
2. Filter by inverter and date if needed.
3. Load records.
4. Review severity, duration, status, and acknowledgement state.
5. Acknowledge alarms when permitted.
6. Use the bottom-right notification hub pill for quick active-alarm review.

## 8.6 Daily Performance Review

1. Open `Analytics` for interval review and day-ahead comparison.
2. Open `Energy` for interval production detail.
3. Open `Report` for the formal daily inverter summary.
4. Export the required package from `Report` or `Export`.

## 8.7 Remote Standby Refresh Workflow

1. Confirm the workstation is in `Remote` mode.
2. Open `Settings -> Connectivity & Gateway Link`.
3. Review gateway link and transfer monitor status.
4. Decide whether archive DB files are required.
5. Run `Refresh Standby DB`.
6. Allow the preflight phase to finish before expecting the heavier snapshot transfer to begin.
7. If the app reports that local standby data is newer than the gateway, decide whether to cancel or use explicit `Force Pull`.
8. Wait for completion and confirm success.
9. Restart the application when you need the refreshed standby DB to become the active local database.
10. After restart, allow the startup loading screen and the first local poll cycle to finish before relying on live totals.

Important:

- remote live streaming pauses temporarily during manual standby refresh
- archive inclusion extends transfer time
- remote mode itself does not keep the local database current
- the refreshed standby DB is the safe path before returning a remote workstation to `Gateway` mode for local history use
- if the refresh is blocked before transfer begins, the gateway should not see the heavier standby-download load
- use `Force Pull` only when you intentionally want the gateway copy to replace newer local standby data

## 8.8 Cloud Backup Workflow

1. Configure provider access.
2. Save backup settings.
3. Select backup scope.
4. Run `Backup Now` or rely on the configured schedule.
5. Review history and cloud file listings.

## 8.9 Cloud Restore Workflow

1. Open `Settings -> Cloud Backup & Restore`.
2. Refresh backup history or cloud list.
3. Choose the correct restore point.
4. Confirm the restore action.
5. Allow the app to create a safety backup.
6. Restart when prompted to apply the restored state.

## 8.11 Recovering from Sudden Power Loss

*Introduced in v2.8.10 — 2026-04-17.*

Sudden Windows shutdowns (power cuts, forced hard resets, brownouts) can leave
NTFS files under `C:\Program Files\ADSI Inverter Dashboard\` in a torn state,
and in rare cases can prevent the PC from finding its boot volume on the next
start. Your plant data under `C:\ProgramData\InverterDashboard\` is protected
by a separate 2-hour rotating backup (WAL + synchronous=NORMAL) and is almost
always recoverable independently.

### 8.11.1 If the PC boots to a black screen with "Intel UNDI PXE"

The BIOS fell through every local boot option and is trying to network-boot.

1. Power off the PC (hold the power button if needed). Wait 10 seconds.
2. Power on. Immediately press the boot-menu key for your BIOS (commonly
   `F12`, `F10`, `F9`, or `Esc`) and pick **Windows Boot Manager**.
3. Once Windows is up, open Command Prompt as Administrator and run:

   ```
   chkdsk C: /f /r
   sfc /scannow
   ```

   `chkdsk` will schedule a scan at next reboot. Reboot and let it finish
   (can take 30–60 minutes on large drives).
4. Once Windows is back up normally, launch the dashboard.

### 8.11.2 If the dashboard shows "Dashboard files are damaged"

This is the recovery dialog introduced in v2.8.10. It means `app.asar` or
another packaged file is torn and the app cannot safely continue.

1. Click **Reinstall Now**. The dashboard will silently run the local copy
   of the installer at
   `C:\ProgramData\InverterDashboard\updates\last-good-installer.exe` and
   relaunch automatically when install completes (typically 30–60 seconds).
2. If **Reinstall Now** is unavailable (first-ever install on this PC, or
   the local installer was deleted), click **Open Updates Folder** and
   place the latest signed installer there, or reinstall from the original
   MSI.
3. The recovery log is written to
   `C:\ProgramData\InverterDashboard\logs\recovery.log` for diagnostic
   forwarding.

### 8.11.3 If the dashboard shows "Database auto-restored" banner

The application detected that `adsi.db` was corrupt at startup and swapped
in the newer of the two rotating backups under `backups/`. Your plant data
is safe.

1. Up to ~2 hours of the most recent readings may be missing. The poller
   refills the gap on the next live sweep as inverters continue generating.
2. An audit log entry is written at scope `startup-integrity`, action
   `db-auto-restore`. Review it in the **Audit** page.
3. The original corrupt DB is quarantined as `adsi.db.corrupt-<timestamp>`
   for forensic inspection if needed.
4. Dismiss the banner when satisfied.

### 8.11.4 Preventive measures

- **Install a UPS** on the dashboard PC. This is the single most effective
  mitigation. A small consumer UPS (500-1000 VA) is enough for the few
  seconds required for NTFS to flush and Windows to power down gracefully.
- **Disable Windows Fast Startup**: Control Panel → Power Options →
  *Choose what the power button does* → *Change settings currently
  unavailable* → uncheck *Turn on fast startup*. This ensures a reboot
  always fully flushes NTFS.
- **Keep the local installer fresh**: after each successful auto-update
  the dashboard stashes a signed copy at
  `C:\ProgramData\InverterDashboard\updates\last-good-installer.exe`.
  Periodically verify the file exists and its version matches the
  currently installed version.
- **Check integrity after any power event**: run `chkdsk` and `sfc` once
  after Windows has recovered, before relying on the dashboard for
  operational decisions.

## 8.10 Camera Setup Workflow

1. Ensure the workstation is in `Gateway` mode (camera streaming is gateway-only).
2. Click the **⚙️ gear icon** on the camera card to open Camera Settings.
3. Select the desired stream mode (HLS, WebRTC, or FFmpeg).
4. For HLS or WebRTC:
   a. Enter the go2rtc server IP (localhost or Tailscale IP) and API port.
   b. Enter the stream key matching `go2rtc.yaml` (default: `tapo_cam`).
   c. In the go2rtc Service section, click **Start** to launch the go2rtc process.
   d. Optionally check **Auto-start on server boot** for automatic startup.
5. For FFmpeg:
   a. Enter the camera IP, RTSP port, stream path, username, and password.
   b. Ensure FFmpeg is installed on the server and available on PATH.
6. Click **Apply & Connect**.
7. Verify the live feed appears in the camera card.
8. If the stream fails, check the go2rtc service status, verify network connectivity, and retry.

For the separate Hikvision DVR card:

1. Open the Hikvision gear button, or use **Tapo Camera Settings > Hikvision DVR**.
2. Enter the DVR host, local username/password, channel, stream, and transport.
3. Select **Hybrid HLS + native viewer window** and click **Verify Connection**.
4. Click **Save & View**. Confirm the card badge changes to **H.264 HLS**.
5. Navigate to another dashboard page and confirm the Hikvision card is completely absent. Return to Inverters and confirm it reconnects in its saved grid position.
6. Click the native-viewer button or double-click the video. Confirm an Analytics-style window opens with the standard Windows title bar and the vendor native surface fills its content area.
7. Resize, maximize, restore, and minimize the viewer, then close it with the title-bar **X** and confirm H.264 HLS resumes.

---

## 9. Operational Notes and Best Practices

- Use `Gateway` mode on the plant-connected workstation.
- Use `Remote` mode only from approved monitored workstations.
- Do not treat `Remote` mode live viewing as proof that the local standby DB is current.
- Use `Refresh Standby DB` before switching a remote workstation back to `Gateway` mode if fresh local history is required.
- Include archive DB files only when historical records are needed locally.
- Protect exported settings files, backup files, and exported operational data as controlled records.
- Do not expose authorization keys, API tokens, client secrets, or toolkit credentials in shared documents.
- Use the `Audit` page after control actions when traceability matters.
- Use `Cloud Backup` and export functions as complementary controls, not substitutes for one another.

---

## 10. Troubleshooting Reference

| Symptom | Likely Meaning | Recommended Action |
| --- | --- | --- |
| Connection dot shows disconnected | Live link is unavailable | Check mode, gateway URL, token, and Tailscale status |
| `Stale` status appears | Last retained snapshot is being shown | Check live link health and recent gateway contact |
| `Refresh Standby DB` completes but data is unchanged locally | Staged data is not applied until restart | Restart the application to activate the new database |
| `Refresh Standby DB` stops with a newer-local warning or `Force Pull` prompt | The local standby copy has newer replicated data than the gateway | Review which machine is authoritative. Cancel to preserve local standby data, or use `Force Pull` only if overwriting local standby data is intentional |
| `TODAY MWh` looks older immediately after returning to `Gateway` mode | Local polling has not caught up yet or standby data was not refreshed before restart | Run `Refresh Standby DB`, restart, and wait for the first local poll cycle |
| Live totals or forecast status look old immediately after `Restart & Install` | Background services are still completing clean shutdown/startup handoff or the first local poll cycle has not finished yet | Wait for the app to reopen fully, confirm gateway mode/runtime health, and allow the first local poll cycle to complete before judging data freshness |
| Startup loading screen shows a **Connection Mode** picker | The workstation is in `Remote` mode and the remote gateway did not respond within the connection timeout | Choose **Gateway Mode** to switch to local Modbus polling, or choose **Remote Mode** to retry the gateway connection. If the gateway is expected to be online, verify the `Remote Gateway URL`, API token, and network connectivity (e.g. Tailscale) before retrying |
| Day-ahead generation is unavailable | Workstation is in `Remote` mode | Run generation from the gateway workstation |
| Plant-cap preview or control fails with `Cannot POST /api/plant-cap/...` | The request reached a server that does not expose the plant-cap routes, usually an older gateway build or a wrong remote gateway target | Restart or update the gateway app, then verify `Remote Gateway URL` and token settings |
| Plant-cap band warning says the limits are too close | Whole-inverter step size is larger than the configured deadband or close to it | Increase the gap between `Lower Limit` and `Upper Limit`, or review exempted inverters and node counts |
| Whole-inverter `Start` / `Stop` still feels slow on one workstation | The workstation or gateway is still running an older build without batched inverter writes, or the backend link itself is slow | Update both gateway and remote builds to the same release first, then review Python service health and network latency |
| Cloud restore is unavailable or incomplete | Provider or backup state is not ready | Refresh cloud list and verify provider authorization |
| Topology cannot be opened | Current mode is `Remote` or access is restricted | Use the gateway workstation (Topology is Gateway-only; IP Configuration now works in Remote mode) |
| IP Configuration changes do not take effect | Remote viewer cannot reach the gateway, or the gateway rejected the save | Confirm the gateway URL/token in Settings and that the gateway is online; the save banner reports the gateway error if one occurred |
| Alarm sound is silent | Sound is muted or system audio is unavailable | Re-enable alarm sound and check workstation audio |
| Export fails | Path, date, format, or dataset issue | Verify export folder, input filters, and current mode |
| Dashboard shows **"Dashboard files are damaged"** (v2.8.10+) | Packaged files torn by sudden shutdown (power loss, forced reboot) | Click **Reinstall Now** to run the locally stashed installer. See section 8.11 for full recovery procedure |
| Red **"Database auto-restored"** banner at top of dashboard (v2.8.10+) | `adsi.db` was corrupt at startup; app swapped in a 2-hour backup | Normal. Up to ~2 h of readings re-fill automatically from live polling. Dismiss when ready |
| PC boots to **"Intel UNDI PXE"** network-boot screen | BIOS could not find a local OS (boot sector / bootloader damage after hard shutdown) | Power off, wait 10 s, power on, F12 → **Windows Boot Manager**. Run `chkdsk C: /f /r` and `sfc /scannow` after Windows recovers. See section 8.11 |
| An inverter's nodes stop polling but its IP still pings | The gateway's Modbus session to that inverter has wedged (stale socket or comm-board TCP queue). A `ping` only proves the comm board's network chip is alive, not that the Modbus session is healthy | The gateway auto-rebuilds the connection after ~30 s of failed reads. To force it now, open **IP Configuration** and click the **Reconnect** button on that inverter's row (no IP change). See section 10.1 |
| "Open device web page" does nothing from a remote viewer | The comm board is on the gateway LAN, not reachable from the remote PC | Use the gear icon in **IP Configuration** — it routes the device page through the gateway automatically. See section 10.1 |

### 10.1 Inverter polling stalls while the IP still pings (v2.11.x)

An Ingeteam **AAX0041** Ethernet→RS-485 comm board keeps answering `ping` and even
accepts the TCP connection while its Modbus polling has stalled — so a reachable
IP does not prove the inverter is being read. When the gateway's per-inverter
Modbus session wedges, polling for that inverter can stay dead even though the IP
responds. The old field workaround was to change the inverter's IP, which forced
the gateway to build a fresh connection.

- **Automatic recovery:** the gateway watches each inverter's connection and,
  after roughly 30 seconds with no successful read, discards the wedged Modbus
  client and builds a new one (at most once per minute per inverter). No operator
  action and no IP change are required.
- **Manual Reconnect:** open **IP Configuration** and click the circular
  **Reconnect** button on that inverter's row (next to Save). This rebuilds only
  that inverter's gateway socket — it changes no inverter setting and no IP. It
  works from a remote viewer too: the request is routed to the gateway.
- **If only a manual reconnect ever helps** (auto-recovery does not), the fault is
  most likely upstream of the gateway — a duplicate IP, or a stale ARP /
  connection-tracking entry on the network switch/router — rather than the comm
  board itself.

#### Open device web page (gateway and remote)

The gear icon on each **IP Configuration** row opens the comm board's own web
page. On the gateway it opens directly on the plant LAN. From a **remote viewer**
the device is not reachable directly, so the page is routed through the gateway
automatically. The remote route is byte-for-byte, so HTML, styles, scripts and
images all render.

> **Tailscale note:** an inverter's LAN IP (e.g. `192.168.1.132`) is *not*
> reachable directly over Tailscale unless a subnet router is configured on the
> gateway (`tailscale up --advertise-routes=192.168.1.0/24`, then approved in the
> admin console). The gateway proxy above is what makes "Open device web page"
> work remotely **without** that change.

---

## 11. Keyboard Shortcuts and Interface Tips

| Shortcut | Function |
| --- | --- |
| `Ctrl+T` | Open the Topology window |
| `Ctrl+I` | Open the IP Configuration window |
| `Ctrl+=` | Zoom in where supported |
| `Ctrl+-` | Zoom out where supported |
| `Ctrl+0` | Reset zoom where supported |
| `Ctrl+L` | Theme toggle in auxiliary windows where implemented |

Additional tips:

- use the bottom-right notification hub pill for active alarm review without changing pages
- use the operator message bubble for shift notes and remote coordination
- use `Open Folder` in Settings to verify export output quickly
- use `Check for Updates` and `Refresh License` during planned maintenance windows

---

## 12. Security and Administrative Caution

This dashboard includes controlled operational actions and credential-bearing configuration fields. Only authorized personnel should:

- change operation mode
- edit endpoint URLs or polling timing
- upload replacement licenses
- connect or disconnect cloud providers
- restore from backup
- manage Solcast credentials
- use bulk inverter control authorization
- modify IP configuration and topology-related network settings

This manual intentionally does not publish authorization-key generation rules or private credential formats.

---

## 13. Quick Reference Summary

| Need | Best Page or Section |
| --- | --- |
| Live plant status | `Inverters` |
| Interval production analysis | `Analytics` and `Energy` |
| Day-ahead comparison | `Analytics` and `Export` |
| Forecast source setup | `Forecast` |
| Alarm review and acknowledgement | `Alarms` |
| Operator action traceability | `Audit` |
| Formal daily summary | `Report` |
| File generation | `Export` |
| Mode, link, standby DB, runtime health | `Settings -> Connectivity & Gateway Link` |
| License and update management | `Settings -> License` and `Settings -> App Updates` |
| Backup and restore | `Settings -> Cloud Backup & Restore` |
| Network configuration | `IP Configuration` |
| Visual plant map | `Topology` |

---

## 14. Revision Note

This manual reflects the current ADSI Dashboard implementation represented by this repository. It deliberately uses release-neutral wording so the complete guide remains valid when package metadata changes. If the dashboard UI, operating modes, export packages, or administrative workflows change, update this document together with the application.
