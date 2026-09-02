# Electron to Tauri Migration Blueprint

## Evidence-backed architecture, delivery, security, and verification plan

- Product: ADSI Inverter Dashboard
- Current production desktop version: 1.0.9
- Current desktop shell: Electron 29
- Proposed desktop shell: Tauri v2 on Windows/WebView2
- Record status: Revised architecture plan; implementation has not started
- Revised: 2026-09-03 Asia/Taipei
- Baseline source revision: 2b196f4174dab97057b8c0968076d5576e7cc83c
- Signed 1.0.9 artifact source revision: 9841875bfe400ad63e343d185a6c375d473bed8f
- Baseline release tag: v1.0.9

This is the living migration record for replacing the Electron desktop shell.
It supersedes the original optimistic blueprint committed with version 1.0.9.
It does not authorize removal of Electron, deletion or relocation of production
data, or deployment of an unverified Tauri build.

---

## 1. Executive decision

Tauri is a technically viable replacement for the Windows Electron shell, but
the migration must not be treated as a direct browser wrapper or a simple
preload rewrite.

The recommended strategy is:

1. Preserve Electron 1.0.9 as the production baseline.
2. Build a separately identified Windows-only Tauri prototype.
3. Preserve the existing local-bridge behavior during shell-parity work.
4. Load application-controlled frontend content; do not load the remote
   gateway page and then grant it native Tauri capabilities.
5. Preserve the existing window.electronAPI contract during the transition.
6. Replace the Remote-only local bridge with Rust only after behavioral parity
   is demonstrated by contract and workstation tests.
7. Move the Windows Gateway shell to Tauri sidecars only after the Remote
   client is stable.
8. Treat a full Rust rewrite of the Express, telemetry, and forecast services
   as a separate program with its own design and validation record.

The original proposal was directionally correct about Tauri potentially
reducing desktop-shell overhead. It was not implementation-ready because it:

- assumed the Remote client did not use SQLite or a local bridge;
- counted 28 IPC channels when 80 renderer IPC/event channels exist;
- treated the Hikvision integration as a simple WebSocket connection;
- used nonexistent Python service filenames and understated service size;
- presented RAM, startup, and installer targets as measured results;
- called Tauri updates delta updates without supporting evidence;
- did not define data ownership, upgrade coexistence, rollback, or field
  acceptance gates.

### What Tauri is expected to improve

- Electron/Chromium runtime duplication on Windows.
- Shell startup and idle memory, subject to actual measurements.
- Native window, tray, dialog, and process-supervision implementation.
- Capability scoping when commands are designed narrowly and default-denied.
- Long-term removal of Node from a dedicated Remote client, after the local
  bridge is replaced.

### What Tauri will not inherently fix

- RTSP source latency.
- go2rtc transcoding or remux latency.
- HLS segment accumulation.
- WebRTC negotiation failures.
- Hikvision LocalService behavior.
- constrained WAN/Tailscale bandwidth.
- gateway Modbus sweep age.
- stale frames already queued in TCP, WebSocket, MSE, or decoder buffers.
- inefficient dashboard JavaScript, canvas rendering, or chart updates.

Tauri on Windows uses WebView2, which is Chromium-based. A shell migration may
reduce process overhead, but it is not by itself a fix for a reported
approximately ten-second camera delay.

---

## 2. Evidence rules used by this plan

Every numeric statement is classified as one of the following:

| Classification | Meaning |
|---|---|
| Measured | Observed from the repository, release artifact, test record, or a live diagnostic |
| Source-derived | Counted or inferred directly from the current source tree |
| Vendor fact | Taken from current official Tauri documentation |
| Target | A desired acceptance limit, not yet achieved |
| Hypothesis | An estimate requiring a prototype and repeatable measurement |

No hypothesis may be reported later as a migration result. No transport smoke
test may be reported as proof of decoded camera smoothness. No service health
probe may be reported as proof of fresh Modbus polling.

---

## 3. Reproducible 1.0.9 baseline

### 3.1 Repository and build host

The following values were captured on 2026-09-02/03 from the current committed
1.0.9 source tree. The signed installer was produced immediately before the
follow-up streaming/migration hardening commit, so source and artifact revision
are recorded separately:

| Item | Observed value | Classification |
|---|---:|---|
| Current source revision | 2b196f4174dab97057b8c0968076d5576e7cc83c | Measured |
| Signed installer source revision | 9841875bfe400ad63e343d185a6c375d473bed8f | Measured from signed-release build metadata |
| Package version | 1.0.9 | Measured |
| Electron dependency | ^29.0.0 | Source-derived |
| electron-builder dependency | ^24.13.3 | Source-derived |
| better-sqlite3 dependency | ^11.10.0 | Source-derived |
| Build host OS | Windows 11 Pro for Workstations, build 26200, x64 | Measured |
| Node available on host | v24.14.0 | Measured |
| npm available on host | 11.6.2 | Measured |
| cargo available on host | No | Measured |
| rustc available on host | No | Measured |

The Rust and MSVC Tauri prerequisites must therefore be installed and recorded
before the first reproducible Tauri build. Installation of toolchains is a
development-host change and is not part of this architecture-only revision.

### 3.2 Signed 1.0.9 artifact

| Item | Observed value | Classification |
|---|---:|---|
| Artifact | release/Inverter-Dashboard-Setup-1.0.9.exe | Measured |
| Exact size | 354,747,752 bytes | Measured |
| Size in MiB | 338.31 MiB | Measured |
| SHA-256 | A2F6F3C315E7D4DBC6D091C618EDD6FF9585343B6B74B4FAF8486FDDCF1970EC | Measured |
| latest.yml size | 354,747,752 bytes | Measured |
| Authenticode subject | CN=Engr. Clariden D. Montaño REE, O=MCTech Engineering, C=PH | Measured |
| Certificate thumbprint | 7A3DE7F937C44A2A7EE1C0B51745EE2189CC0958 | Measured |
| Local trust status | UnknownError because the private root is not trusted on this build host | Measured |

The signature status is not an invalid-signature finding. The signer and
thumbprint are present, while the private organizational root is absent from
the workstation trust store. This also does not establish Microsoft SmartScreen
reputation.

The former statement that the current installer is approximately 185 MB was
incorrect for 1.0.9 and is removed.

### 3.3 Current packaged native/service payload

These binaries are explicitly packaged by package.json:

| Binary | Exact bytes | MiB | Purpose |
|---|---:|---:|---|
| dist/InverterCoreService.exe | 47,738,437 | 45.53 | Python telemetry engine packaged by PyInstaller |
| dist/ForecastCoreService.exe | 107,402,982 | 102.43 | Python forecast engine packaged by PyInstaller |
| dist/CalibratorService.exe | 46,804,228 | 44.64 | Python calibrator packaged by PyInstaller |
| server/go2rtc/go2rtc.exe | 19,737,088 | 18.82 | Camera relay |
| server/ffmpeg/ffmpeg.exe | 202,113,536 | 192.75 | Media processing |
| Total | 423,796,271 | 404.17 | Uncompressed sum of the five listed binaries |

This explains why a complete Tauri Gateway installer cannot be assumed to be
16 MB or 85 MB while retaining the existing service payload. A Remote-only
installer can exclude these binaries, but it must still provide the local
bridge functions described below.

### 3.4 Test evidence

The most recent committed smoke summary records:

| Test evidence | Result |
|---|---|
| Command arguments | --skip-python --no-rebuild |
| Node test files discovered | 119 |
| Node test files passed | 119 |
| Node test files failed | 0 |
| Recorded duration | 84,614 ms |
| Python test execution | Skipped |
| Python test files present | 38 |

Therefore, the verified statement is 119/119 Node test files passed. It is not
correct to call this a complete Node-and-Python suite result. Before a Tauri
release candidate, both the existing Node suite and relevant Python tests must
run, in addition to the new Rust and packaged-client tests.

### 3.5 Runtime performance evidence already available

The living record implemented/desktop-streaming-performance-optimization.md
contains the only current end-to-end Remote transport measurements:

| Path/metric | Observed result | Classification |
|---|---:|---|
| Pre-fix direct gateway HTTP pull | 1,209 to 1,657 ms per request | Measured live |
| Pre-fix local snapshot change interval | approximately 3 to 4 seconds | Measured live |
| Pre-fix oldest source sample | approximately 12.4 seconds | Measured live |
| Gateway poll duration | current 32 ms, average 34 ms | Measured live |
| Gateway event-loop lag | current 1 ms | Measured live |
| Gateway payload | approximately 86 to 88 KB decoded JSON | Measured live |
| Historical gateway backpressure drops | 561 | Measured live |
| Fixed direct gateway WebSocket interval | average 548.9 ms, maximum 1,325.3 ms | Measured live |
| Fixed gateway-to-workstation frame age | average 339.3 ms, maximum 356.0 ms | Measured live sample |
| Fixed bridge-to-renderer interval | average 508.0 ms, maximum 514.9 ms | Measured live |
| Fixed local bridge overhead | average 4.7 ms, maximum 11.8 ms | Measured live |
| Fixed total gateway-to-client age | average 438.4 ms, maximum 514.9 ms | Measured live |
| HLS advertised segment duration | 0.5 seconds | Measured transport |
| Sample HLS segment | 60,988 bytes in 319.2 ms | Measured transport |
| Decoded camera glass-to-glass latency | Not measured | Unknown |
| Packaged 1.0.9 RAM and cold start | Not measured in this revision | Unknown |

The prior ten-to-twelve-second telemetry staleness was caused by a failed
token-authenticated WebSocket upgrade falling back to repeated HTTP pulls. The
fixed bridge adds only milliseconds in the cited live sample. These facts argue
against deleting the bridge merely to remove one network hop.

Camera transport availability remains separate from decoded playback latency.

---

## 4. Current architecture that must be preserved

### 4.1 Gateway mode

    Signed Electron UI
      -> local http://localhost:3500
      -> Express gateway and browser/session authorization
      -> local SQLite at C:\ProgramData\Inverter-Dashboard\db\adsi.db
      -> InverterCoreService on port 9100
      -> ForecastCoreService on port 9200
      -> go2rtc and FFmpeg
      -> configured INGECON SUN PMax inverters on Modbus/TCP port 502

Gateway mode is the authority for topology, plant settings, forecasts, control
operations, audit data, telemetry, and camera administration.

### 4.2 Remote client mode

    Signed Electron UI
      -> local http://localhost:3500
      -> local Express bridge
           -> local device settings and standby state
           -> inject Remote API token outside renderer JavaScript
           -> proxy REST operations to the gateway
           -> maintain authenticated upstream WebSocket
           -> coalesce and rebroadcast live snapshots
           -> retry, degrade, retain stale state, and recover
           -> perform authorized pull-only standby replication
      -> remote Linux or Windows gateway

The Remote client does not perform local Modbus polling, but it does use a local
server and SQLite state. These are different claims. The original plan combined
them and was incorrect.

### 4.3 Canonical Windows data ownership

The ordinary installed application uses only:

- C:\ProgramData\Inverter-Dashboard\db\ipconfig.json
- C:\ProgramData\Inverter-Dashboard\db\adsi.db
- C:\ProgramData\Inverter-Dashboard\autoreset.json
- C:\ProgramData\Inverter-Dashboard\server-service-config.json

Explicit operator-supplied data-directory and portable overrides may be
honored. The Tauri implementation must never infer an alternate root, use the
non-hyphenated C:\ProgramData\InverterDashboard tree, or access the separate
D:\ADSI-Dashboard project.

In Remote mode:

- the remote gateway remains authoritative for plant-wide settings;
- local polling remains prohibited;
- only connection, device-bound identity, local UI/export/camera preferences,
  updater state, and approved standby state may persist locally;
- failed remote saves must remain failures;
- remote settings must not silently fall back to local acceptance.

### 4.4 Authentication and authorization boundaries

The current product has several distinct identities:

- the desktop operator login;
- the signed browser session and canonical operator/developer role;
- the machine-to-machine Remote API token;
- the device-bound operator profile keyed by inverter_2_device_id;
- updater signing identity;
- Windows Authenticode publisher identity.

These are not interchangeable. Tauri must not:

- treat a Remote API token as an operator password;
- expose a stored Remote API token to renderer JavaScript;
- derive developer privileges from a username, DOM state, or localStorage;
- bypass browser/session authorization because the request comes from a
  desktop app;
- grant broad shell or filesystem capabilities to a gateway-hosted page;
- overwrite the device-bound identity with a shared plant setting.

---

## 5. Source inventory and migration scope

### 5.1 Core source size

The line counts below were measured from revision 2b196f4:

| Component | File | Lines | Bytes |
|---|---|---:|---:|
| Electron main process | electron/main.js | 7,360 | 277,094 |
| Main preload | electron/preload.js | 131 | 6,623 |
| Login preload | electron/preload-login.js | 18 | 1,012 |
| Bootstrap restore preload | electron/preload-bootstrap-restore.js | 34 | 1,516 |
| Hikvision native bridge | electron/hikvisionNativePlayer.js | 478 | 16,352 |
| Integrity gate | electron/integrityGate.js | 251 | 8,072 |
| Recovery dialog | electron/recoveryDialog.js | 182 | 5,973 |
| Express gateway/bridge | server/index.js | 27,876 | 1,062,083 |
| SQLite layer | server/db.js | 7,765 | 325,975 |
| Telemetry engine source | services/inverter_engine.py | 4,874 | 198,691 |
| Forecast engine source | services/forecast_engine.py | 14,922 | 688,379 |
| Calibrator source | services/calibrator_app.py | 1,553 | 63,251 |
| Primary frontend application | public/js/app.js | 37,088 | 1,517,631 |
| Mirrored frontend application | frontend/public/js/app.js | 37,088 | 1,517,631 |

The former blueprint named services/inverter-telemetry.py and
services/forecast_service.py. Those files do not exist in this repository.

The forecast engine is 14,922 lines and includes substantially more behavior
than ONNX inference. An ONNX runtime does not replace provider integration,
feature engineering, cache policy, database behavior, audits, backfills,
weather acquisition, configuration, supervision, and error handling.

### 5.2 Desktop bridge surface

Static source inspection found:

| Surface | Count | Notes |
|---|---:|---|
| Unique renderer IPC/event channel names | 80 | Across three preload files |
| Unique ipcMain handler/listener names found | 65 | Some events are main-to-renderer only |
| Frontend occurrences of electronAPI | 310 | public and frontend/public combined |
| Frontend files containing electronAPI | 12 | JS and HTML |
| Frontend occurrences of desktopAPI | 0 | The proposed adapter does not exist |
| Static unique Express route paths/prefixes | 238 | Lower-bound source count |

The IPC work is not a 28-command mapping. It includes:

- window minimize, maximize, close, hide, and current-window close;
- topology, global configuration, calibrator, camera viewer, and page popouts;
- navigation context menus and shortcuts;
- folder selection and restricted folder opening;
- text import/export;
- user guide and credential-reference PDF generation;
- ADSI backup save/open and bootstrap restore workflow;
- topology/configuration reads and validated writes;
- license status, audit, fingerprint, upload, and status events;
- desktop authentication session and login connection preparation;
- updater state, checks, download, install, restart, and policy settings;
- startup progress, ready, failure, and Remote connectivity events;
- Hikvision native start, update, stop, hide, show, status, and viewer events;
- OAuth window handling;
- local server health, serialized start/stop, background mode, and auto-start.

### 5.3 Why the existing frontend is not a zero-work drop-in

WebView2 is Chromium-based, so most standards-based HTML/CSS/JavaScript is
likely reusable. Compatibility is still unproven because:

- the frontend has 310 electronAPI references;
- different windows rely on different preload contracts;
- browser-versus-desktop branching tests for electronAPI presence;
- same-origin relative REST and WebSocket paths assume localhost:3500;
- login/session cookies and same-origin enforcement depend on the served origin;
- native camera integration relies on window lifecycle and geometry;
- the main HTML contains inline style attributes that affect CSP design;
- HLS, MSE, WebRTC, canvas, print-to-PDF, downloads, and GPU behavior require
  packaged WebView2 tests;
- both public and frontend/public assets must remain intentionally synchronized.

The preferred compatibility strategy is initially to expose the same
window.electronAPI method names and event-unsubscribe behavior from a narrowly
scoped Tauri initialization layer. Renaming the bridge to window.desktopAPI
before parity would create needless churn and make regression comparison harder.

---

## 6. Corrected target architecture

### 6.1 Architecture principles

1. Windows first. The initial target is x86_64 Windows with WebView2.
2. Production remains on Electron until a Tauri release candidate passes every
   applicable gate.
3. The remote gateway URL is data-plane configuration, not the origin from
   which privileged desktop code is loaded.
4. Native commands are default-denied and granted per window/capability.
5. Renderer code never receives reusable Remote API tokens.
6. Local-server controls remain unavailable when a Server Host URL is set.
7. The canonical ProgramData root and topology schema do not change.
8. Every phase is installable alongside Electron and independently removable.
9. No phase may silently modify production data merely by being launched.
10. Performance improvements are measured against the same workstation,
    gateway, display, camera, and network conditions.

### 6.2 Trust zones

| Zone | Trusted content | Allowed responsibility | Prohibited responsibility |
|---|---|---|---|
| Tauri Rust core | Signed application binary | Windowing, commands, secret use, process lifecycle, updater | Plant authorization bypass |
| Bundled frontend | Files shipped with signed app | UI, sanitized command requests, rendering | Direct secret storage |
| Local compatibility bridge | Shipped Express code during transition | Existing REST/WS proxy and local state | Local polling in Remote mode |
| Remote gateway | Authenticated configured server | Plant authority and telemetry | Native workstation access |
| Sidecars | Explicitly bundled known binaries | Telemetry, forecast, camera, gateway tasks | Arbitrary renderer-selected execution |
| Browser content/OAuth | External web content | Its constrained web flow | Tauri filesystem, shell, or service control |

Tauri documentation states that its API is available to bundled code by
default, while remote sources require explicit capability configuration.
Therefore, granting the gateway page broad remote capabilities is rejected as
the production architecture.

### 6.3 Frontend origin decision

The end-state Remote client must load bundled application-controlled frontend
assets. It must not directly load http://gateway:3500 as its privileged main
window.

Two transitional mechanisms are acceptable:

#### Compatibility mechanism A: existing localhost bridge

- Package or otherwise launch the existing Node/Express bridge as a controlled
  sidecar.
- Continue serving the UI from localhost:3500 for the first parity prototype.
- Bind loopback only.
- Fail if the port is unexpectedly owned instead of trusting foreign content.
- Use an unguessable per-launch handshake between Rust and the bridge.
- Allow only the exact main-window origin and the minimum Tauri command set.
- Block navigation away from approved application pages.

This has the smallest behavior change but does not achieve the smallest
installer or RAM footprint. It exists to separate shell risk from bridge risk.

#### End-state mechanism B: bundled UI plus Rust Remote bridge

- Load bundled UI from the Tauri application origin.
- Maintain the upstream HTTP/WebSocket clients inside Rust.
- Inject the Remote API token only inside Rust.
- Expose sanitized telemetry events to the renderer.
- Provide a constrained API proxy whose methods and paths are allow-listed.
- Preserve browser-role/session semantics for privileged operations.
- Preserve reconnect, stale-state, backoff, coalescing, replication, gateway
  handoff, and local-setting rules.
- Keep any local listening socket loopback-only, or avoid one when a safe
  request/event adapter provides parity.

Mechanism B is required before claiming a zero-Node Remote client.

### 6.4 Compatibility bridge contract

The initial Tauri bridge must preserve:

- method names;
- arguments and result shapes;
- Promise rejection behavior;
- event payload shapes;
- event subscription and unsubscribe behavior;
- active-window ownership checks;
- validation before filesystem, URL, and process operations;
- Remote mode rejection of local service controls;
- developer-only restrictions;
- audit attribution.

The bridge should be implemented by domain rather than as one unrestricted
invoke function:

- window commands;
- dialog/export commands;
- license commands;
- updater commands;
- authentication commands;
- service-lifecycle commands;
- Hikvision commands;
- recovery/restore commands;
- navigation/popout commands.

Do not expose tauri-plugin-shell directly to ordinary renderer code. Sidecars
should be launched through Rust-owned commands with fixed binary names and
fixed/validated arguments.

### 6.5 Remote bridge minimum behavior

A Rust Remote bridge is not complete until it implements or deliberately
delegates all of the following:

- normalized Server Host URL parsing;
- health probing with bounded timeouts;
- token-bearing upstream REST requests;
- authenticated upstream WebSocket;
- per-message compression compatibility where applicable;
- latest-live-frame coalescing;
- bounded queues and backpressure accounting;
- source timestamp and local receive/send timestamp propagation;
- retry and exponential backoff;
- degraded/offline state transitions;
- stale snapshot retention;
- gateway identity/source change detection;
- today-energy shadow and handoff behavior;
- remote settings authority;
- local setting allow-list;
- device identity and operator attribution;
- camera relay/direct-route selection;
- Remote browser-session role enforcement;
- standby replication cursor and cancellation rules;
- archive transfer limits and integrity checks;
- clean shutdown and restart recovery.

Omitting database replication is acceptable only for a separately approved
viewer SKU whose functional requirements explicitly exclude standby refresh,
offline history, and later Gateway handoff. It must not be described as parity
with the existing Remote client.

---

## 7. Detailed phased delivery plan

Dates are deliberately omitted until Phase 0 sizing is complete. The old
two-to-three-week estimate was unsupported.

### Phase 0: Baseline, requirements freeze, and toolchain

#### Deliverables

- Install and pin the supported stable MSVC Rust toolchain.
- Record rustc, cargo, Tauri CLI, WebView2, Windows SDK, and MSVC versions.
- Add a source-controlled dependency policy and Cargo.lock.
- Produce a complete generated IPC inventory from all preload and main files.
- Produce an HTTP, WebSocket, and settings-authority contract inventory.
- Mark every capability as Remote-required, Gateway-only, local-only, or
  unsupported in the first prototype.
- Capture an installed Electron baseline on the affected workstation.
- Define the Tauri application identifier, executable name, install directory,
  data access policy, and update channel.
- Write the threat model before granting capabilities.

#### Required Electron baseline measurements

- cold start from process creation to dashboard-startup-ready;
- warm start;
- process-tree private working set at idle;
- process-tree private working set with 89 or the current live-node count;
- CPU and GPU utilization during five-minute telemetry-only and camera runs;
- direct browser, installed Electron, and development Electron comparisons;
- telemetry interval and gateway-to-renderer frame age;
- camera mode, source, resolution, codec, bitrate, dropped frames, and
  glass-to-glass delay;
- disconnect/reconnect recovery time;
- installer and installed-directory size.

#### Exit criteria

- Baseline raw evidence is retained.
- All 80 renderer channel names are classified.
- All current roles, origins, secrets, and data stores have owners.
- No unanswered design question could cause a production-data or authorization
  regression.

### Phase 1: Non-production Tauri shell scaffold

#### Deliverables

- Add src-tauri without altering Electron production entry points.
- Configure Windows x86_64 only.
- Add main, login, bootstrap-restore, popout, calibrator, and native-viewer
  window definitions as required.
- Add a deny-by-default capability set per window label.
- Add CSP and navigation/new-window allow-lists.
- Implement basic window controls, tray, logging, crash evidence, and version
  reporting.
- Expose a minimal compatibility window.electronAPI for completed commands.
- Use a separate app identifier and visible Development/Preview product name.
- Use a non-production test data root by explicit environment override.

#### Security requirements

- No wildcard remote URL capabilities.
- No arbitrary shell command.
- No arbitrary path open/write.
- No generic unrestricted HTTP client exposed to JavaScript.
- OAuth content receives no local native capabilities.
- Popout and native-viewer commands verify their owning window.
- Devtools are controlled by build profile.

#### Exit criteria

- Tauri builds reproducibly on a clean build host.
- It installs and uninstalls without touching Electron.
- It cannot start local telemetry when configured as Remote.
- Navigation to unapproved origins is blocked.
- Capability tests prove denied operations remain denied.

### Phase 2: Remote client parity using the existing bridge

This phase deliberately keeps the current Node/Express Remote bridge. Its
purpose is to validate the Tauri shell without simultaneously rewriting the
data plane.

#### Deliverables

- Package a controlled Node/Express compatibility sidecar or managed runtime.
- Prove better-sqlite3 native-module compatibility in the chosen packaging
  method.
- Start the bridge on loopback only and verify ownership before loading it.
- Carry a per-launch handshake between the Tauri core and bridge.
- Preserve login, token preparation, local settings, proxy, WebSocket,
  replication, exports, license, and updater UI behavior.
- Complete the 80-channel mapping or document intentionally unavailable
  Gateway-only commands with correct disabled UI.
- Port window and popout lifecycle without changing desktop layout.

#### Packaging warning

Bundling node.exe or packaging server/index.js is not assumed to be trivial.
better-sqlite3 has native ABI requirements, and the server loads many local
modules and assets dynamically. A production sidecar proof must test:

- native ABI;
- ASAR/non-ASAR paths;
- child-process paths;
- packaged resource lookup;
- SQLite WAL and backup behavior;
- graceful shutdown;
- code signing of executables;
- antivirus behavior;
- logs and crash evidence.

#### Exit criteria

- Functional Remote parity on the same gateway.
- Existing Node suite passes.
- Relevant Python tests pass if any packaged service boundary is touched.
- No token appears in renderer storage, logs, URLs, or diagnostic exports.
- Remote local-server start is rejected through UI and direct command calls.
- Telemetry performance is no worse than the installed Electron baseline.
- Camera behavior is measured, not inferred from an HTTP 200 response.

No claim of major installer or memory reduction is made at this phase.

### Phase 3: Native Rust Remote bridge

This is the phase that may produce a lightweight zero-Node Remote client.

#### Deliverables

- Implement a Rust upstream HTTP client with URL/path allow-lists.
- Implement authenticated WebSocket connection and sanitized event delivery.
- Implement bounded queues, coalescing, timestamps, and diagnostics.
- Implement retry, reconnect, degraded state, stale-state retention, and
  gateway-switch reset behavior.
- Implement device-local settings and required SQLite persistence.
- Implement Remote settings authority and developer-role checks.
- Implement standby replication only if the chosen Remote SKU requires it.
- Remove the Node sidecar only when parity evidence is complete.
- Load signed bundled frontend assets in the privileged main window.

#### Data compatibility

- Use the canonical data root only for an approved production candidate.
- Use the existing SQLite schema where practical.
- Back up adsi.db plus WAL/SHM consistently before any schema change.
- Run SQLite quick_check before and after conversion.
- Preserve ipconfig.json without rewriting it in Remote mode.
- Preserve the four topology maps and intentionally empty units lists.
- Never create local polling merely because topology data exists.
- Use a schema/version marker that Electron can recognize or make the cutover
  explicitly one-way with documented rollback restoration.

#### Exit criteria

- Node is absent from the Remote-client process tree and installer.
- Every required Remote contract has automated coverage.
- Gateway-to-renderer telemetry age meets the approved field threshold.
- Reconnect and stale-state behavior match or improve on Electron.
- Local bridge secret isolation is preserved.
- Five-day operator soak has no unrecovered crash, orphan process, state
  corruption, privilege regression, or unexplained stream stall.

### Phase 4: Tauri Windows Gateway with sidecars

This phase replaces Electron as the supervisor while preserving the current
service implementations.

#### Actual sidecars

- InverterCoreService.exe
- ForecastCoreService.exe
- CalibratorService.exe
- go2rtc.exe
- ffmpeg.exe
- Node/Express gateway sidecar until separately replaced

Tauri external binaries require target-triple-specific filenames/configuration.
The packaging layout must account for this rather than inventing service names.

#### Supervisor requirements

- serialized and idempotent Start/Stop;
- no killing of tracked healthy workers during Start;
- health probes for ports 3500, 9100, and 9200;
- component-level degraded status;
- child process containment and orphan prevention;
- bounded restart policy with crash-loop detection;
- shutdown ordering for forecast supervision, gateway, telemetry, forecast,
  go2rtc, Hikvision workers, and FFmpeg;
- background mode with recoverable tray Show, Stop Local Services, and Exit;
- persisted background and auto-start settings at the canonical root;
- populated Server Host URL as a hard local-service lock;
- clean upgrade behavior with running services;
- log and crash evidence retained across restart.

#### Exit criteria

- Gateway lifecycle contract passes packaged tests.
- Fresh telemetry is observed on a host with a confirmed route to the inverter
  subnet before polling success is claimed.
- No control command is issued merely for reachability testing.
- Restart and shutdown leave no sidecars or locked database files.
- Canonical settings are used by Tauri, Node, and all Python services.
- Full installer size is reported from the artifact, not estimated.

### Phase 5: Optional native service replacement

This is not part of the shell-migration acceptance path.

Separate proposals are required for:

- Express gateway to axum or another Rust HTTP/WebSocket stack;
- better-sqlite3 to rusqlite;
- Python Modbus engine to an async Rust implementation;
- forecast service redesign;
- calibrator redesign;
- media-pipeline changes.

Each replacement must preserve wire contracts, database semantics, operational
safety, timing, audit behavior, and rollback. A Rust ONNX binding addresses only
model inference and cannot be considered a forecast-engine replacement by
itself.

---

## 8. Feature-parity matrix

| Capability | Current owner | First Tauri implementation | Required validation |
|---|---|---|---|
| Main dashboard rendering | Electron plus local Express | Phase 2 compatibility bridge | Visual comparison, no desktop layout regression |
| Login and remembered identity | Login preload/main/SQLite | Rust compatibility commands | Invalid/valid login, no secret exposure |
| Server Host and token preparation | Electron main plus SQLite | Rust command calling controlled persistence | Atomic host/role/token behavior |
| Browser signed role | Express browserAuth | Existing bridge, then Rust parity | Operator/developer route matrix |
| Remote live telemetry | Express upstream/downstream WS | Existing bridge, then Rust WS | Frame interval, age, reconnect |
| REST proxy | Express | Existing bridge, then allow-listed Rust proxy | Method/path/body/header contract |
| Remote settings authority | Express | Existing bridge, then Rust parity | No local false-success |
| Device-local settings | SQLite/Express | Existing schema or approved store | Allow-list tests |
| Standby replication | Express/SQLite | Existing bridge; Phase 3 decision | Cursor, integrity, cancellation, handoff |
| Topology edit | Electron IPC/Express | Gateway-only command | 27 records, four maps, validation |
| Local server lifecycle | Electron main | Phase 4 Rust supervisor | Serialized start/stop and Remote lock |
| Background/tray/autostart | Electron main | Rust plugins/core | Recovery and clean Exit |
| File/folder dialogs | Electron dialog/shell | Narrow Rust commands | Path and extension restrictions |
| PDF generation | Hidden Electron window | WebView2 print or controlled generator | Output visual/content parity |
| ADSI backup/restore | Electron and server | Rust orchestration over existing logic | Integrity, scope, cancellation |
| License status/upload | Electron main | Rust commands or retained module | Fingerprint and audit parity |
| Updater | electron-updater | Tauri updater on separate feed | Signatures, interruption, rollback |
| Popout windows | Electron BrowserWindow | Tauri windows/webviews | State, ownership, multi-monitor |
| OAuth | Restricted Electron window | Capability-free Tauri OAuth window | Redirect allow-list and closure |
| Hikvision LocalService | Electron native bridge | Dedicated Windows proof | DPI, geometry, z-order, crash cleanup |
| HLS/MSE/WebRTC | Chromium renderer | WebView2 | Codec and five-minute playback evidence |
| Startup/recovery UI | Electron gates/dialogs | Rust state machine/windows | Failure injection and restore |

---

## 9. Hikvision and camera migration plan

### 9.1 Why this is a high-risk boundary

electron/hikvisionNativePlayer.js currently:

- connects to ws://127.0.0.1:33686;
- assigns and verifies an owner window/webContents identity;
- temporarily changes the owner document/window title to a UUID;
- waits for visibility before native-window creation;
- sanitizes and DPI-scales the requested rectangle;
- updates native geometry;
- hides/shows/stops the native surface;
- reacts to owner closure, renderer destruction, navigation, process failure,
  and fullscreen exit.

The LocalService appears to discover or bind to a native Chromium/WebView host
window using the identity handshake. WebView2 equivalence is not established by
the fact that both environments can open a WebSocket.

### 9.2 Required proof of concept

- Start LocalService from an installed Tauri preview.
- Identify the correct WebView2 top-level/child HWND behavior.
- Reproduce the title/UUID handshake or replace it with a verified supported
  owner-handle mechanism.
- Confirm positioning at 100, 125, 150, and 200 percent DPI.
- Confirm negative monitor coordinates and mixed-DPI multi-monitor placement.
- Confirm minimize, restore, maximize, fullscreen, tab change, popout, and
  window move.
- Confirm z-order and clipping relative to dashboard controls.
- Confirm cleanup after renderer crash and application termination.
- Confirm medium-integrity/elevation compatibility.
- Confirm fallback to go2rtc HLS/WebRTC without falsely reporting native mode.

Until this passes, Hikvision native-viewer compatibility remains unproven and
must be rated high impact, medium-to-high likelihood.

### 9.3 Video validation

For each mode, record:

- camera and stream key;
- main/substream;
- codec, profile, resolution, FPS, and bitrate;
- direct, relay, or fallback route;
- HLS segment duration and live-edge distance;
- WebRTC connection/ICE state;
- decoded frames and dropped frames over five minutes;
- renderer CPU/GPU;
- glass-to-glass latency using a visible source timestamp or synchronized
  stopwatch.

A playlist, initialization segment, or media fragment returning HTTP 200 proves
transport availability only.

---

## 10. Performance measurement and acceptance

### 10.1 Test matrix

Use the same physical Windows workstation, display resolution, gateway,
Tailscale route, telemetry load, and camera stream for:

1. Direct supported browser.
2. Installed Electron 1.0.9.
3. Development Electron, when diagnosing packaging differences.
4. Installed Tauri compatibility build.
5. Installed Tauri native-Remote-bridge build.

Run each scenario at least three times after an equivalent clean start. Retain
raw timestamps and process samples.

### 10.2 Metrics

| Metric | Definition |
|---|---|
| Cold startup | Process creation to dashboard-startup-ready |
| Working memory | Sum of private working set for the complete application process tree |
| Idle CPU | Process-tree CPU after stabilization with no camera |
| Live CPU/GPU | Five-minute telemetry and camera observation |
| Telemetry cadence | Distribution of consecutive live-frame intervals |
| Transport age | Renderer receive time minus gateway send/source time |
| Bridge overhead | Renderer receive time minus local bridge send time |
| Backpressure | Dropped/coalesced frames and maximum buffered bytes |
| Reconnect | Link restoration to first fresh frame |
| Camera latency | Source event to decoded displayed frame |
| Camera smoothness | Decoded/dropped frames and visible stalls |
| Installer size | Exact artifact bytes and MiB |
| Installed size | Filesystem allocation after installation |

### 10.3 Initial gates

These gates may be tightened after the Phase 0 baseline:

- No recurrence of systematic three-to-four-second Remote telemetry gaps.
- Under the same known-good network, total gateway-to-renderer telemetry age
  should normally remain below one second and must not regress materially from
  the measured fixed Electron sample.
- Local bridge overhead should remain a small fraction of total age; investigate
  any sustained value above 50 ms.
- No unbounded WebSocket/MSE queue growth.
- No increase in dropped decoded video frames versus Electron under identical
  input.
- Reconnect must recover automatically without manual reload.
- RAM/startup targets are accepted only after side-by-side measurements.

The old claims of 75 to 78 MB RAM and less than 450 ms cold start are retained
only as hypotheses to test, not requirements already demonstrated.

---

## 11. Installer, WebView2, and size strategy

Official Tauri documentation lists these Windows WebView2 modes:

| Mode | Internet required | Vendor-stated installer addition | Intended use |
|---|---|---:|---|
| downloadBootstrapper | Yes | 0 MB | Small connected installer |
| embedBootstrapper | Yes | approximately 1.8 MB | Bootstrapper included, runtime still downloaded |
| offlineInstaller | No | approximately 127 MB | Offline/air-gapped installation |
| fixedVersion | No | approximately 180 MB | Pinned bundled runtime |
| skip | No | 0 MB | Not recommended; application fails if runtime is absent |

Windows 10 from version 1803 onward and Windows 11 normally have WebView2
available, but the installer policy must match the actual plant deployment.

Recommended release variants:

- Remote Online: system WebView2 plus download/bootstrap validation.
- Remote Offline: offline WebView2 installer included.
- Gateway Offline: offline WebView2 plus all required sidecars.

No exact Tauri artifact-size promise is approved until each actual signed
variant is built. The Remote variant is expected to be much smaller than the
338.31 MiB full Electron/Gateway installer only if it excludes Gateway service
binaries and does not retain a large Node compatibility payload.

---

## 12. Updater and signing design

### 12.1 Separate signing layers

Windows Authenticode and the Tauri updater solve different problems:

- Authenticode signs Windows executables/installers and identifies the
  publisher.
- The Tauri updater validates a Tauri-generated artifact signature using a
  public key embedded in the application.

Both are required for the intended internal distribution policy. Importing the
private organizational root establishes local Authenticode trust but does not
guarantee SmartScreen reputation.

The phrase ECDSA minisign is removed. The implementation must use the currently
supported Tauri signer workflow and record the exact key type/tool version
actually generated.

### 12.2 Artifact behavior

Official Tauri v2 documentation describes signed NSIS/MSI updater artifacts
such as setup.exe plus setup.exe.sig. It does not support the previous
blueprint's claim that updates are inherently binary delta updates.

### 12.3 Transition rules

- Use a Tauri-specific latest.json or dynamic endpoint.
- Do not reuse Electron latest.yml as if formats were compatible.
- Keep Tauri updater keys outside Git and back them up securely.
- Keep Authenticode private material outside Git.
- Give preview builds a separate application ID, executable, install directory,
  uninstall key, and update channel.
- Do not allow preview updates to target production Electron users.
- Test interrupted download, invalid signature, wrong publisher, downgrade,
  reboot-required, insufficient permissions, custom install path, and rollback.
- Decide explicitly whether the final cutover is a side-by-side install, a
  signed migration installer, or a manually managed fleet deployment.
- Never rely on Electron automatically replacing itself with a Tauri installer
  until product identity, uninstall registration, data preservation, and
  rollback have been proven in a disposable VM.

---

## 13. Data migration, coexistence, and rollback

### 13.1 Preview isolation

All development and preview builds must use an explicit test data directory.
They must not open production adsi.db concurrently with Electron.

### 13.2 Production cutover sequence

1. Stop Electron and all local services cleanly.
2. Confirm no process holds adsi.db, WAL, SHM, or service executables.
3. Record current application version and data-root resolution.
4. Create a recoverable backup of the canonical root.
5. Validate adsi.db with SQLite quick_check.
6. Validate ipconfig.json and its inverters, poll_interval, units, and losses
   maps.
7. Install the Tauri candidate without deleting data.
8. Start in read/health mode before allowing Gateway service startup.
9. Verify roles, settings authority, topology, service state, and fresh
   telemetry.
10. Retain the rollback artifact and backup until the soak period passes.

### 13.3 Rollback

Rollback must:

- stop Tauri and its sidecars;
- preserve diagnostic logs;
- restore the pre-cutover database only if the Tauri schema is incompatible;
- reinstall/start the pinned Electron release;
- verify canonical data-root resolution;
- verify database integrity;
- avoid copying from any other dashboard product or legacy ProgramData root.

If both shells use an unchanged compatible schema, rollback may reuse the same
data only after exclusive-lock and schema-version checks.

---

## 14. Security requirements

### 14.1 Capability policy

- Explicitly list enabled capability files in tauri.conf.json.
- Split capabilities by window and responsibility.
- Do not depend on every file in the capabilities directory being harmless.
- Do not grant a remote wildcard access to native commands.
- Do not grant shell execute/spawn directly to the main frontend.
- Scope filesystem access to operator-selected or product-owned locations.
- Validate URLs, paths, extensions, payload sizes, enums, and numeric bounds in
  Rust even if the frontend already validates them.
- Treat deny rules as defense in depth, not a substitute for command checks.

### 14.2 Content security policy

- Start with default-src restricted to the application.
- Permit only required connect-src destinations and schemes.
- Keep scripts bundled; do not introduce CDN scripts.
- Do not enable unsafe-eval without a documented measured requirement.
- Audit existing inline styles before choosing style-src policy.
- Restrict frame, object, worker, media, image, and font sources explicitly.
- Test HLS blob/media URLs and WebSocket connections under the actual CSP.

### 14.3 Secrets

The current Remote token is persisted in the local SQLite settings table and
used by the bridge; it is not proven to be encrypted at rest. The migration
must not repeat unsupported claims that it is encrypted merely because it is
outside the renderer.

For Tauri:

- keep token read/write/use in Rust or the controlled bridge;
- never prefill or return the saved token to JavaScript;
- evaluate Windows Credential Manager or Tauri Stronghold for at-rest
  protection;
- define recovery and device-binding behavior before changing storage;
- redact tokens from logs, URLs, errors, crash dumps, and exports;
- preserve the separate operator-login contract.

### 14.4 Dependency and supply-chain controls

- Commit Cargo.lock.
- Pin Tauri/plugin major versions and review upgrades.
- Run cargo audit or the approved equivalent.
- Generate and retain an SBOM for each release.
- Hash and sign every shipped sidecar.
- Reject an unexpected sidecar hash at startup.
- Record build toolchain versions and source commit in release metadata.
- Scan signed artifacts without treating antivirus success as functional proof.

---

## 15. Verification strategy

### 15.1 Automated checks on every migration change

- Existing JavaScript syntax checks.
- Existing 119-file Node suite, unless a later legitimate count is discovered
  dynamically by scripts/smoke-all.js.
- Relevant Python tests and py_compile checks.
- Cargo format check.
- Cargo clippy with warnings denied for production crates.
- Cargo unit and integration tests.
- Capability allow/deny tests.
- IPC contract-shape tests.
- REST and WebSocket compatibility tests.
- canonical ipconfig.json JSON/schema checks.
- paired public and frontend/public asset synchronization checks.
- packaged installation smoke tests.

### 15.2 Required security scenarios

- invalid Remote token rejected;
- valid machine token accepted only at intended bridge/gateway boundary;
- operator denied developer-only action;
- old browser session without role treated as operator;
- navigation to an external page has no privileged commands;
- OAuth window has no filesystem/shell/service capability;
- renderer cannot request an arbitrary executable;
- renderer cannot escape allowed save/open paths;
- Remote client cannot start local telemetry;
- malformed Server Host URL is rejected;
- failed remote save is not represented as successful local persistence.

### 15.3 Required lifecycle scenarios

- first launch;
- normal launch and close;
- minimize to tray and restore;
- Exit from tray;
- background Gateway launch;
- Remote launch with local-service preferences previously enabled;
- repeated Start and Stop;
- child crash and bounded restart;
- system sleep/resume;
- network loss/recovery;
- gateway restart;
- Windows logout/shutdown;
- update while services are running;
- application crash during database activity;
- uninstall while preserving production data.

### 15.4 Field-only validation

The following cannot be honestly completed on a disconnected development host:

- fresh Modbus reads from configured inverters;
- control-command behavior;
- actual Tailscale/WAN performance;
- actual Hikvision LocalService compatibility;
- camera glass-to-glass delay;
- workstation GPU/decoder behavior;
- multi-monitor operator workflow.

These items require recorded live evidence before production approval.

---

## 16. Risk register

| Risk | Impact | Current likelihood | Mitigation / gate |
|---|---|---|---|
| Direct remote page receives native commands | Critical | High if original design used | Bundled UI; no broad remote capability |
| Remote token exposed to renderer | Critical | Medium | Rust/bridge-only token use and tests |
| Remote client starts local polling | Critical | Medium | Hard mode lock in UI and command handlers |
| Settings authority regresses | High | Medium | Route/field allow-list parity tests |
| SQLite corruption from dual shells | Critical | Medium | Preview isolation and exclusive cutover |
| Existing IPC behavior missed | High | High without inventory | Generated 80-channel manifest |
| Hikvision overlay incompatible with WebView2 | High | Medium-to-high | Early Windows proof of concept |
| Camera delay unchanged | High | High if shell assumed causal | Glass-to-glass comparison and pipeline work |
| better-sqlite3 fails in Node sidecar | High | Medium | Packaging ABI prototype |
| Sidecars remain orphaned | High | Medium | Process containment and shutdown tests |
| Installer is much larger than promised | Medium | High for offline Gateway | Build each real variant; publish exact bytes |
| WebView2 missing offline | High | Low-to-medium by fleet | Offline installer variant |
| WebView2 codec/GPU differs | High | Medium | Same-hardware packaged playback tests |
| CSP breaks UI/media | Medium | Medium | CSP inventory and automated smoke |
| Updater cannot cross shell safely | High | High without transition design | Separate feed; VM migration/rollback tests |
| Internal signing root not trusted | Medium | Deployment-specific | Managed PKI distribution and verifier |
| SmartScreen warning persists | Medium | Deployment-specific | Do not equate root trust with reputation |
| Rust rewrite changes SCADA semantics | Critical | High if rushed | Separate service-by-service program |
| Forecast scope underestimated | High | High | Inventory all non-inference behavior |
| Linux parity assumed from Windows | High | Medium | Windows-only first; separate Linux plan |

---

## 17. Go/no-go decision gates

### Gate A: allow a Tauri preview build

- Toolchain reproducible.
- Separate product identity and data root.
- Threat model reviewed.
- Basic capability-denial tests pass.

### Gate B: allow operator pilot in Remote mode

- Required IPC contract complete.
- Token isolation verified.
- Remote hard lock verified.
- Telemetry and reconnect no worse than Electron.
- Camera behavior measured on the affected workstation.
- Signed preview installer and updater tested.
- Rollback documented and rehearsed.

### Gate C: remove Node from Remote client

- Rust bridge has REST/WS/settings/state parity.
- Replication requirement is either implemented or explicitly removed from a
  newly defined viewer SKU.
- Five-day soak passes.
- Actual RAM, startup, installer size, and latency are published.

### Gate D: replace Electron production Remote client

- Managed deployment and update path approved.
- Production data cutover/rollback tested in a VM and workstation.
- No open critical/high security or data-integrity finding.
- Operator acceptance recorded.

### Gate E: replace Electron Gateway

- Sidecar lifecycle, data authority, health truthfulness, polling, forecast,
  camera, backup, license, updater, and tray behavior all pass.
- Live inverter-subnet verification succeeds.
- Gateway soak and rollback succeed.

---

## 18. Explicit non-goals for the first production Tauri release

- Rewriting the telemetry engine in Rust.
- Rewriting the forecast engine in Rust.
- Replacing go2rtc or FFmpeg.
- Changing the Modbus protocol profile or port.
- Changing topology schema.
- Redesigning desktop layout.
- Merging data from another dashboard product.
- Removing authentication or authorization layers.
- Claiming Linux/macOS parity from Windows results.
- Claiming camera latency improvement without measurement.

---

## 19. Official Tauri references

All vendor statements in this revision were checked against official Tauri
documentation on 2026-09-02/03:

- Tauri prerequisites:
  https://v2.tauri.app/start/prerequisites/
- Tauri capabilities and remote API access:
  https://v2.tauri.app/security/capabilities/
- Tauri command permissions:
  https://v2.tauri.app/security/permissions/
- Tauri command scopes:
  https://v2.tauri.app/security/scope/
- Tauri Content Security Policy:
  https://v2.tauri.app/security/csp/
- Tauri external binaries/sidecars:
  https://v2.tauri.app/develop/sidecar/
- Tauri Node sidecar guide:
  https://v2.tauri.app/learn/sidecar-nodejs/
- Tauri Windows installer and WebView2 modes:
  https://v2.tauri.app/distribute/windows-installer/
- Tauri updater:
  https://v2.tauri.app/plugin/updater/
- Tauri Windows code signing:
  https://v2.tauri.app/distribute/sign/windows/
- Tauri WebView versions:
  https://v2.tauri.app/reference/webview-versions/
- Tauri Stronghold:
  https://v2.tauri.app/plugin/stronghold/

Vendor documentation can change. The implementation must pin actual dependency
versions and recheck these references when scaffolding and before release.

---

## 20. Baseline reproduction commands

Run from D:\Inverter-Dashboard in PowerShell.

### Source and release identity

    git rev-parse HEAD
    git status --short
    node -p "require('./package.json').version"
    Get-Item release\Inverter-Dashboard-Setup-1.0.9.exe
    Get-FileHash release\Inverter-Dashboard-Setup-1.0.9.exe -Algorithm SHA256
    Get-AuthenticodeSignature release\Inverter-Dashboard-Setup-1.0.9.exe

### Tests

    (Get-ChildItem server\tests -Filter *.test.js -File).Count
    (Get-ChildItem services\tests -Filter test_*.py -File -Recurse).Count
    node scripts\smoke-all.js --skip-python --no-rebuild

The recorded 1.0.9 smoke command skipped Python. A release-candidate command
must include Python and restore the required better-sqlite3 ABI according to the
existing smoke-harness contract.

### Toolchain

    node --version
    npm --version
    cargo --version
    rustc --version

### Artifact payload

    Get-Item dist\InverterCoreService.exe
    Get-Item dist\ForecastCoreService.exe
    Get-Item dist\CalibratorService.exe
    Get-Item server\go2rtc\go2rtc.exe
    Get-Item server\ffmpeg\ffmpeg.exe

---

## 21. Final recommendation

Proceed with Tauri as a controlled Windows Remote-client migration experiment,
not as an immediate replacement and not as a direct wrapper around the remote
gateway URL.

The first useful engineering milestone is a separately installable Tauri shell
that preserves the current local bridge and window.electronAPI contract. This
isolates WebView2, windowing, updater, signing, installer, native-camera, and
capability risks. Once that shell demonstrates parity, replace only the
Remote-mode bridge with Rust and measure whether removing Node provides enough
RAM, startup, and installer benefit to justify the work.

The existing live data shows that the corrected local bridge contributes only
about 4.7 ms average and 11.8 ms maximum in the recorded sample, while total
gateway-to-client age was below 515 ms. The bridge is therefore not the
demonstrated source of the prior ten-second telemetry delay. Preserve its
security and resilience behavior unless and until the Rust replacement passes
the same end-to-end tests.

Electron 1.0.9 remains the production baseline until the applicable gates in
this document are satisfied.

---

## Appendix A. Exact desktop IPC/event inventory

The following 80 unique channel names were extracted from:

- electron/preload.js
- electron/preload-login.js
- electron/preload-bootstrap-restore.js

This inventory includes renderer-to-main commands and main-to-renderer events.
Implementation must retain direction, ownership, payload shape, return shape,
and unsubscribe semantics; matching only the string name is insufficient.

### Window, navigation, and popout

- window-minimize
- window-maximize
- window-close
- close-current-window
- open-topology-window
- open-ip-config-window
- open-calibrator
- open-popout-window
- show-nav-context-menu
- create-calibrator-shortcut
- open-logs-folder
- open-ip
- open-ip-check
- camera-popout-opened
- camera-popout-closed
- camera-popout-ready

### File, export, and backup

- pick-folder
- open-folder
- save-text-file
- open-text-file
- download-user-guide-pdf
- download-credentials-pdf
- save-adsibak
- open-adsibak

### Topology and runtime configuration

- config-get
- config-save
- ip-status
- inverter-status

### Licensing

- license-get-status
- license-get-audit
- license-get-fingerprint
- license-upload
- license-status

### Authentication and connection preparation

- check-login
- login-get-connection-context
- login-prepare-connection
- change-username-password
- reset-password
- login-get-remembered
- login-save-remembered
- login-clear-remembered
- login-success
- get-auth-key
- get-auth-session

### Application update

- app-update-get-state
- app-update-check
- app-update-download
- app-update-install
- app-update-set-auto-download
- app-update-set-auto-install-overnight
- app-update-status
- app-update-ready
- app-restart

### Startup and operation-mode reporting

- dashboard-startup-progress
- dashboard-startup-ready
- dashboard-startup-failed
- dashboard-remote-connectivity-failed
- switch-operation-mode

### Hikvision native viewer

- hikvision-native-viewer-open
- hikvision-native-viewer-status
- hikvision-native-viewer-opened
- hikvision-native-viewer-closed
- hikvision-native-start
- hikvision-native-update
- hikvision-native-stop
- hikvision-native-hide
- hikvision-native-show
- hikvision-native-status

### OAuth

- oauth-start

### Local server lifecycle

- server:get-status
- server:start
- server:stop
- server:set-background
- server:set-auto-start

### Bootstrap restore

- bootstrap-restore:get-scopes
- bootstrap-restore:pick-file
- bootstrap-restore:validate
- bootstrap-restore:run
- bootstrap-restore:cancel
- bootstrap-restore:complete

## Appendix B. Exact Remote state contracts

### Device-local settings currently allowed in Remote mode

The source-defined REMOTE_CLIENT_LOCAL_SETTING_KEYS set contains:

- operationMode
- remoteGatewayUrl
- remoteApiToken
- remoteAutoSync
- tailscaleDeviceHint
- wireguardInterface
- csvSavePath
- invGridLayout
- exportUiState
- cameraConfig
- go2rtcAutoStart
- operatorName

The gateway remains authoritative for all settings outside this explicit set.
The Tauri bridge must not grow this set implicitly. A new local field requires
a reviewed source change, test, and update to this record.

### Settings preserved across Remote replication

The current replication preservation set contains:

- operationMode
- remoteAutoSync
- remoteGatewayUrl
- remoteApiToken
- tailscaleDeviceHint
- wireguardInterface
- csvSavePath
- operatorName
- remoteReplicationCursors
- remoteReplicationLastTs
- remoteReplicationLastSignature
- remoteTodayEnergyShadow
- remoteGatewayHandoffMeta

The full-main-database replacement preservation set is intentionally smaller
and excludes replication cursors/signature and handoff metadata while retaining
the same-day energy shadow. Rust parity must distinguish these operations.

### Current Remote bridge timing constants

These are source-derived 1.0.9 values, not universal performance promises:

| Setting | Current value |
|---|---:|
| Normal Remote bridge interval | 800 ms |
| Maximum reconnect backoff | 30,000 ms |
| Live fetch retries | 2 |
| Live retry base | 350 ms |
| Failures before offline | 6 |
| Failures before offline during synchronization | 10 |
| Degraded grace | 60,000 ms |
| Stale snapshot retention | 180,000 ms |
| Replication request timeout | 300,000 ms |
| Replication retry | 30,000 ms |
| Incremental replication interval | 3,000 ms |
| Today-energy polling interval | 30,000 ms |

A Rust implementation may tune these only with failure-injection and live
evidence. It must preserve state meaning and bounded behavior, not necessarily
copy every number blindly.

## Appendix C. Decisions still required before scaffolding

| Decision | Why it matters | Required owner/evidence |
|---|---|---|
| Preview product ID/name/install directory | Prevents collision with Electron | Release engineering |
| Preview data directory | Prevents concurrent production DB access | Architecture/security |
| Remote SKU includes standby replication or not | Determines Rust bridge and SQLite scope | Product/operator decision |
| Online versus offline WebView2 packages | Changes installer by about 127-180 MB | Deployment/IT inventory |
| Existing bridge packaging method | Node ABI and resource-path risk | Phase 2 proof |
| Long-term secret store | Changes migration/recovery behavior | Security review |
| Tauri update endpoint and key custody | Required for safe independent updates | Release/security |
| Electron-to-Tauri fleet cutover method | Determines rollback and installer identity | IT operations |
| PDF generation mechanism | Electron hidden-window behavior has no automatic parity | Prototype |
| Hikvision HWND integration method | Required for native LocalService overlay | Windows proof |
| Camera latency target per mode | HLS and WebRTC have different realistic bounds | Operator acceptance |
| Linux desktop scope | WebKitGTK is not validated by Windows work | Separate future plan |

No unresolved decision in this table should be hidden behind a default that
changes production data, security authority, or installer identity.
