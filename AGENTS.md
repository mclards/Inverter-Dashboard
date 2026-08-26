# Inverter Dashboard — Project Instructions

## Scope and isolation

- Work only in `D:\Inverter-Dashboard` unless the user explicitly expands scope.
- Never read, edit, move, copy from, delete, or otherwise touch `D:\ADSI-Dashboard`. It is a separate, older dashboard.
- Do not use, migrate from, or delete `C:\ProgramData\InverterDashboard` (without the hyphen). It belongs to the separate older approach.

## Authoritative runtime data

The new dashboard's only default Windows settings root is:

`C:\ProgramData\Inverter-Dashboard\`

Important locations:

- `db\ipconfig.json`: inverter IP addresses, per-inverter polling intervals, active nodes, and losses.
- `db\adsi.db`: persisted dashboard settings and operational data.
- `autoreset.json`: auto-reset configuration.

All desktop, gateway, and Python inverter-engine launches must resolve the same runtime data directory: `C:\ProgramData\Inverter-Dashboard\db`. Environment/portable overrides may be honoured only when explicitly supplied by the operator.

## Inverter topology contract

- The installed protocol profile is **INGECON SUN PMax**, Modbus/TCP port `502`.
- Nodes are named `N1` through `N4`, never `U1` through `U4`.
- `ipconfig.json` uses scalar maps:

  ```json
  {
    "inverters": { "1": "192.168.1.101" },
    "poll_interval": { "1": 0.05 },
    "units": { "1": [1, 2, 3] },
    "losses": { "1": 2.5 }
  }
  ```

- Do not convert `inverters` entries into `{ "ip": ..., "slaves": ... }` objects. Preserve an explicitly empty `units` list as disabled; never silently re-enable four nodes.
- Treat a failed reachability or Modbus test as inconclusive when the workstation is not connected to the inverter subnet. Do not mark hardware faulty from an off-network result.

## Collaboration and safety

- The user also works with Antigravity. Treat existing/uncommitted files and Antigravity edits as user-owned: inspect before editing and do not overwrite or revert unrelated changes.
- Do not use destructive Git commands (`reset --hard`, `checkout --`, clean) or delete configuration/data unless the user explicitly requests the exact target.
- Preserve the gateway/remote-mode authorization and validation flow. Do not add renderer-side bypasses to control or configuration APIs.

## Durable operating rules

### Instruction and path precedence

1. A current, explicit user instruction wins over any older project note.
2. For an ordinary desktop launch, the canonical runtime configuration is always `C:\ProgramData\Inverter-Dashboard\db`.
3. A portable mode or an explicit operator-supplied data-directory environment override may supersede the default. Never infer such an override or repoint it to another product's data tree.
4. Repository `storage/`, AppData fallbacks, and the non-hyphenated ProgramData root are never authoritative production settings for this project.

Before changing any runtime configuration, confirm the exact target path. Never merge, synchronize, replace, or delete a second dashboard's files merely because their names or schemas look similar.

### Configuration integrity

- Preserve all four top-level `ipconfig.json` maps: `inverters`, `poll_interval`, `units`, and `losses`.
- Preserve all 27 inverter records and their intentionally sparse node assignments. Changing an IP must not reset its interval, nodes, or loss value; changing nodes must not replace an IP.
- Accept only valid IPv4 addresses in topology edits. Keep port `502` and the PMax protocol profile fixed unless the user explicitly authorizes a verified hardware/protocol change.
- Read configuration before writing it, validate the complete resulting JSON, and confirm it can be loaded by the Python engine. Never write partial or incompatible topology data.
- When the browser, Electron IPC, Node gateway, and Python engine disagree on configuration, diagnose the active data directory and schema first. Do not compensate by copying settings between products.

### Service-state truthfulness

- The Web Gateway normally serves port `3500`, the Inverter Telemetry Engine port `9100`, and the AI Forecast Worker port `9200`.
- A lifecycle label must be based on current health probes, not on the last Start/Stop button click, a stale PID, or a cached status response.
- Report component-level state accurately: a web gateway can be reachable while telemetry is offline; that is degraded, not a healthy polling state.
- Starting the desktop server does not prove inverter polling succeeded. Polling is successful only after a fresh telemetry read from a configured inverter/node.
- Before any live polling test, confirm the host has a route to the configured inverter subnet. Never issue control commands while merely testing reachability.

### Local server lifecycle persistence

- Persist `Run as Background Service` and `Auto-start local server services` atomically in the canonical runtime root: `C:\ProgramData\Inverter-Dashboard\server-service-config.json` (or the approved portable/explicit equivalent). Read the old per-user Electron file only as a migration fallback; never make it the ongoing source of truth.
- A populated Server Host URL disables both local-server lifecycle settings and their IPC handlers. Preserve an earlier gateway preference for a future gateway restart, but do not apply or change it while the device is a Remote client.
- `Start Local Server` and `Stop Local Server` must be serialized and idempotent. Start must not kill tracked healthy workers; Stop must stop forecast supervision, the web gateway, telemetry, forecast, go2rtc, and Hikvision workers before reporting success.
- Background mode must hide the eligible Gateway window and retain a recoverable tray menu with Show, Stop Local Services, and Exit. It must never leave a hidden process with no supported way to restore or shut it down.

### Server host / client-device invariant

- The login-page **Server Host URL** is for a Remote client device only. It identifies the gateway from which the client streams dashboard data; it is not an operator-password destination.
- On a Gateway/server device, the field is blank. It remains editable at sign-in so an operator can configure this device as a Remote client; leaving it blank keeps Gateway/server operation.
- A populated server host is a hard Remote-client lock: do not start local telemetry/polling, disable local-server controls, and reject any bypassed start request.
- To convert a client back into a server, clear the server host and restart the dashboard before enabling local services. Preserve the remote API token as a separate secret.
- When a Server Host URL is supplied at sign-in, show a separate masked Remote API Token field. Validate operator credentials first, then atomically persist the normalized host, derived role, and any supplied token. Never prefill or expose a saved token, and never treat it as the operator password.
- Keep the login screen compact: show a connection summary by default, reveal Server Host URL only through an explicit `Connect to server` / `Change` action, and reveal the token only inside that editor after a host is entered. A saved Remote configuration must remain collapsed and editable on demand.

### Gateway and remote-mode protection

- In gateway mode, persist a validated configuration through the gateway and mirror it only to the same new-dashboard runtime data root.
- In remote/client mode, the gateway is authoritative for every plant-wide setting and topology value. Do not mirror remote settings or `ipconfig.json` back into the client's local database, legacy files, or polling configuration. A standby refresh is the sole way to obtain a local copy before a later Gateway-mode switch.
- A Remote client may persist only its connection fields, local export/UI/camera preferences, and its device-bound operator profile. A failed remote save must be reported as a failure; never present a local fallback as an accepted gateway change.
- Device-bound operator profiles are keyed by `inverter_2_device_id`. Preserve that ID and forward it with the device operator name for gateway audit attribution; never overwrite it with a shared plant setting or a later login username.
- Preserve authentication, authorization, audit, request validation, rate limits, and control interlocks. Do not weaken them to make a test or UI action appear to work.

### Forecast configuration authority

- Forecast provider selection, Solcast access mode, credentials, resource identifiers, forecast horizon, and tuning are developer-only settings located in the dedicated **Forecast Configuration** Settings section. The operational forecast preview is not a Settings control.
- In Remote mode, the gateway is authoritative for every forecast setting, Solcast test, preview, and snapshot refresh. A Remote client must proxy these operations to the gateway and must not create an independent local Solcast cache or configuration.
- Keep forecast configuration fields in Settings; the Forecast page owns Toolkit Preview and Refresh Preview. Route authorized configuration changes through Settings so the layout and audit flow remain consistent.
- Keep Forecast Configuration compact: use **Source & Tuning** and **Solcast Connection**. API Key and Toolkit credentials belong in the connection tab and change with the selected access mode; do not add separate sparse credential tabs. Settings verification must report a text-only connection result and must not load a preview chart.

### Antigravity collaboration protocol

- Antigravity is an active collaborator on this repository. Before editing a file, inspect the targeted diff and preserve unrelated uncommitted work.
- Do not rewrite, reformat, revert, or delete broad file sets to resolve a conflict. Make the narrowest compatible change and surface an actual overlap to the user.
- After edits, test the changed boundary and state exactly what was verified versus what requires the plant network or a desktop restart.

### Browser developer authentication

- The browser gateway must match the desktop developer-login contract: accept the fixed `devClard` username case-insensitively, while requiring the exact rotating `devMM` password for the gateway server's current minute (with the established one-minute clock-tolerance window).
- Preserve the browser protections around this flow: rate limiting, generic authentication failures, same-origin enforcement, an HttpOnly `SameSite=Strict` session cookie, and canonical `username`/`role` values in a successful login response. Do not expose, persist, or weaken developer credentials to make web access easier.

### Browser per-role authorization

- A browser session must carry the signed canonical role (`operator` or `developer`). Treat an old session without a role claim as `operator`; never grant privileges from `localStorage`, a username string, DOM state, or a renderer-supplied role.
- On every browser app start, verify `/api/auth/session` before exposing developer controls. Developer-only controls must be hidden by default until a signed developer session is confirmed.
- Operators may use the shared Plant & Display settings only. Keep their settings POST payload to the explicit shared-field allow-list; require a signed developer session for topology, lifecycle, polling, diagnostics, backup, camera/stream administration, forecast configuration/testing, and other protected administration APIs.
- Apply the same developer check to standalone administration pages. Remote API tokens authenticate a configured Remote client to its gateway; the client-facing gateway must still enforce the signed browser role before forwarding a developer-only operation.

### Implementation records

- The `implemented/` directory contains one living implementation record per related feature area. Update the existing record for follow-up work in the same area; do not create a new timestamped record for every incremental change.
- Consolidate redundant records when a feature evolves. Keep the original record filename unless the scope genuinely becomes a separate feature, and preserve relevant implementation decisions and verification evidence in the retained record.

### Release and handoff checks

- Keep `public/` and `frontend/public/` changes intentional and synchronized when both are shipped. Bump every affected cache-busting query string.
- Verify JavaScript syntax, Python compilation, and relevant focused tests. Validate `ipconfig.json` as JSON and confirm the engine resolves the hyphenated path.
- Never claim that field polling, reachability, commands, or service recovery passed without a corresponding successful live result.
- State when a dashboard restart, packaged-app rebuild, or reconnection to the inverter network is required for a change to take effect or be confirmed.

## UI and verification

- `public/` and `frontend/public/` contain paired dashboard assets. Keep intentional UI/script changes mirrored when both copies are shipped.
- When changing a cache-busted browser asset, increment the corresponding query version in both HTML entry points (`public/index.html` and `frontend/public/index.html`).
- **Strict Desktop Protection:** NEVER modify or break the desktop UI layout (`> 768px`). Desktop layout must remain 100% intact across all monitors.
- **Mobile Scope Enforcement:** All mobile-specific styles and overrides must be strictly placed inside `@media screen and (max-width: 768px)` at the bottom of `public/css/style.css` (and mirrored to `frontend/public/css/style.css`).
- **Inline Checkbox Invariant (`.chk-inline`):**
  - Checkboxes/toggles in forms and cards must use `<label class="chk-inline">` with `display: flex !important; flex-direction: row !important; align-items: center !important; gap: 10px !important; width: 100% !important;`.
  - All parent `.srow label` or `.settings-card label` column-flex rules must be guarded with `:not(.chk-inline)` so checkboxes are never converted to vertical stacks.
  - Checkbox inputs must enforce fixed $16\text{px} \times 16\text{px}$ dimensions (`flex: 0 0 16px !important;`).
- **Settings Card & Subsection Wrapper (`.settings-subsection`):**
  - Multi-column settings cards (`grid-template-columns: repeat(auto-fit, ...)`) MUST encapsulate contents inside `<div class="settings-subsection">` (`grid-column: 1 / -1; width: 100%; box-sizing: border-box;`) to prevent direct children from collapsing into narrow grid tracks.
- **Dynamic Button Lifecycle States:** Action buttons (e.g. Start/Stop Local Server) must dynamically bind `.disabled` states and visual cues based on live status.
- **Atomic Markup Edit Safety Protocol:** Always run `git diff` after editing HTML to verify that all opening/closing tags (`<label>`, `<div>`, `<button>`) are fully balanced.
- At minimum, run relevant syntax/compile checks after backend changes (`node --check ...`, `python -m py_compile ...`), verify every discovered Node test passes via `node scripts/smoke-all.js --skip-python --no-rebuild`, and validate `ipconfig.json` as JSON. Run live Modbus polling only while connected to the inverter network.
