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

## Verification

- JavaScript syntax checks passed for both shipped `app.js` files.
- Browser DOM checks confirmed all Settings cards are direct children of the Settings container and there are no duplicate HTML IDs.
- Browser role checks confirmed the expected operator/developer menu, selector, and Connectivity tabs, including the safe operator fallback from a persisted developer-only tab.
- Browser layout checks confirmed that the menu is scrollable, the Settings heading remains pinned while it scrolls, and the Settings page has no horizontal overflow.
- Verified the two shipped HTML files and two shipped app scripts remain byte-identical.
- `server/tests/serverLifecycleWiring.test.js` passed, covering canonical atomic persistence, preload exposure, Remote-mode interlocks, serialized Start/Stop, complete Stop wiring, recoverable background mode, paired renderer behavior, and matching asset cache versions.
- `server/tests/ipConfigRemoteSave.test.js` now proves that clearing a Remote client's Server Host URL performs no empty settings POST to its former gateway, while shared topology changes remain gateway-authoritative.
- Electron-based Node smoke suite passed: **108/108** tests (`node scripts/smoke-all.js --skip-python --no-rebuild`).

## Scope

Changes are confined to `D:\Inverter-Dashboard`. No legacy ADSI project or legacy runtime directory was accessed or modified.
