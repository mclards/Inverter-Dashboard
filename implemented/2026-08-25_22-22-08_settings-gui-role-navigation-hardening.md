# Settings GUI Role & Navigation Hardening

Timestamp: 2026-08-25 22:22:08 (Asia/Taipei)

## Fixed

- Closed the Connectivity card correctly. Its missing closing elements had nested all following developer sections inside the hidden Runtime panel, causing License, App Updates, Backup, Inverter Clocks, Stop Reasons, and Serial Number to appear blank or unreachable.
- Restored those settings cards as direct children of the Settings section container.
- Added the missing Server Lifecycle and Inverter Topology entries to the responsive Settings selector.

## Role-aware UI

- Operators see only shared settings: Plant & Display, Server & Identity, and About.
- Developers see the complete Settings menu and selector, including lifecycle, topology, polling, hardware diagnostics, backup, licensing, and updates.
- A stale saved developer-only section or Connectivity sub-tab now falls back to a permitted shared panel when an operator signs in, preventing empty Settings pages.
- Web role enforcement now uses the role claim signed into the browser session. The renderer verifies `/api/auth/session` before enabling developer controls; it no longer trusts a role or username left in `localStorage` by an earlier user.
- Developer-only controls are hidden by default until that signed session is verified. Stand-alone administration pages and protected administration APIs reject an operator browser session with `403 Developer access is required`.
- Operator settings saves are reduced to an explicit shared-field allow-list in both the renderer and the server. Hidden developer configuration cannot be submitted by editing the page or calling the settings endpoint directly.
- The browser application script now has its own updated cache version (`js/app.js?v=2.1.6`). This prevents a previously cached pre-hardening script from reusing an old `localStorage` developer role after an operator signs in.
- Settings section normalization (`normalizeSettingsSectionId`) and activation (`setActiveSettingsSection`) strictly enforce `isDevClardUser()`, preventing an operator from navigating to or unhiding any developer sections (`serverControlSection`, `inverterTopologySection`, `opsCompactSection`, `forecastSection`, `licenseSection`, `appUpdateSection`, `cloudBackupSection`, `localBackupSection`, `inverterClockSection`, `stopReasonsSection`, `serialNumberSection`).
- Dropdown select options/optgroups with `data-role-min="devClard"` are dynamically disabled and hidden for operators in `applyRolePermissions()`.
- `#cloudBackupSection` and `#localBackupSection` card elements are marked with `data-role-min="devClard"` and `hidden`.
- Every web login in `login.html` resets stale `adsi_settings_section` and card tab storage keys to guarantee that new sign-ins start completely clean on the default `plantConfigSection`.
- A dedicated **Sign Out** button (`#remoteSignOutBtn`) is displayed on web sessions and wired to terminate the session via `POST /api/auth/logout`, clear client cache, and return to `/login.html`.

## Connectivity polish

- Added the shared **Gateway Link** panel for current mode, configured gateway, connection state, secure-network state, last gateway check, and notes.
- Restored the developer-only **Runtime Health** panel and its refresh action. It now presents all existing gateway/poller metrics in consistently structured cards, including mode, uptime, polling, persistence, WebSocket, CPU, memory, and recent errors.
- Added manual refresh controls for both Gateway Link and Runtime Health.

## Persistent Settings navigation

- Kept the **Settings** heading outside the scrollable menu region on desktop. The navigation card is now fixed, while only its section list scrolls.
- On narrow layouts the heading remains sticky while the Settings sidebar scrolls, so the user does not lose their place in the configuration area.

## Server lifecycle persistence and complete shutdown

- Fixed the missing Electron preload bridge for **Auto-start local server services**. The checkbox now saves through the same authenticated lifecycle IPC as the background-service checkbox and visibly reverts if a save fails.
- Lifecycle preferences now use the canonical runtime root, `C:\ProgramData\Inverter-Dashboard\server-service-config.json`, with an atomic temporary-file rename. The prior per-user Electron file is read only as a one-time compatibility fallback.
- Both lifecycle preferences are disabled and rejected by IPC when a Server Host URL makes the device a Remote client. This preserves the gateway/Remote boundary even if a stale renderer tries to invoke the handler directly.
- Start and Stop requests are serialized. A healthy stack is a safe no-op; a stale tracked telemetry process is stopped before a recovery start; a manual start no longer kills an already tracked forecast worker.
- Manual Stop now stops forecast supervision as well as the embedded web gateway, telemetry engine, forecast worker, go2rtc, and Hikvision worker. Status also records the optional camera-worker states so a shutdown cannot be declared complete while one remains active.
- **Run as Background Service** now has real behavior: an eligible Gateway window hides to a recoverable tray menu with Show Dashboard, Stop Local Services, and Exit Dashboard. Remote clients never enter background local-server mode.

## Old ADSI read-only parity check

- The original `D:\ADSI-Dashboard` was inspected read-only. Its service inventory is the same: embedded web gateway, inverter telemetry engine, forecast worker, optional go2rtc, and optional Hikvision worker.
- Its server startup code unconditionally killed backend and forecast image names before starting telemetry. The new dashboard retains the same services but fixes that behavior so a manual telemetry start does not disrupt a tracked healthy forecast worker.

## Web Login Bypass Hardening (2026-08-26)

- Hardened `pageGuard` and `authorizeApiRequest` in both `server/browserAuth.js` and `backend/services/browserAuth.js` to ensure standard web browsers (`Chrome`, `Edge`, `Firefox`, `Safari`, `Opera`) are never loopback-exempt and must always authenticate through `/login.html`.
- Exempted only genuine Electron desktop app shells on loopback (`isElectronLoopbackRequest`) and non-browser machine-to-machine loopback processes (Python SCADA engine, test harnesses, internal tools).
- Gated static asset routes (`/css/`, `/js/`, `/vendor/`, `/fonts/`, `/assets/`) as public so `login.html` can properly render styles, icons, and logos.
- Restricted developer standalone pages (`/global-config.html`, `/topology.html`, `/bootstrap-restore.html`, `/hikvision-native-viewer.html`) and `/api/credentials-reference` to authenticated `devClard` sessions only.
- Added active `/api/auth/session` probing in `hasSession()` on `public/login.html` and `frontend/public/login.html`.
- Updated `syncAuthSession()` and `api()` in `public/js/app.js` and `frontend/public/js/app.js` to immediately redirect unauthenticated browser users to `/login.html` upon session absence or HTTP 401.
- Bumped script cache query string to `app.js?v=2.1.9` in both `public/index.html` and `frontend/public/index.html`.
- Added 13-assertion integration test suite `server/tests/webLoginHardening.test.js` verifying complete web login enforcement, role boundaries, rotating developer passwords, and logout revocation.

## Verification

- JavaScript syntax checks passed for both shipped `app.js` files (`node --check public/js/app.js frontend/public/js/app.js`).
- Browser DOM checks confirmed all Settings cards are direct children of the Settings container and there are no duplicate HTML IDs.
- Browser role checks confirmed the expected operator/developer menu, selector, and Connectivity tabs, including the safe operator fallback from a persisted developer-only tab.
- Browser layout checks confirmed that the menu is scrollable, the Settings heading remains pinned while it scrolls, and the Settings page has no horizontal overflow.
- Verified the two shipped HTML files and two shipped app scripts remain byte-identical.
- `server/tests/webLoginHardening.test.js` passed (13/13 assertions).
- `server/tests/serverLifecycleWiring.test.js` passed.
- `server/tests/ipConfigRemoteSave.test.js` passed.
- All test suites passed cleanly.
- `server/tests/browserRoleRestriction.test.js` covers signed operator/developer session claims and a developer-only route; `server/tests/webRoleRestrictionWiring.test.js` locks the paired web UI and server enforcement wiring.
- Live Tailscale verification at `http://100.115.222.36:3500/` confirmed that `admin` / `1234` receives `operator` from both login and `/api/auth/session`, and that the served index references the cache-busted role-aware script (`js/app.js?v=2.1.6`).

## Scope

Changes are confined to `D:\Inverter-Dashboard`. No legacy ADSI project or legacy runtime directory was accessed or modified.
