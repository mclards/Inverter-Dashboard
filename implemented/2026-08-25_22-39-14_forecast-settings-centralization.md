# Forecast Settings Centralization

Timestamp: 2026-08-25 22:39:14 (Asia/Taipei)

## GUI migration

- Moved the complete Forecast Configuration card from the Forecast page into a dedicated developer-only Settings section.
- Kept the existing Settings-card and section-navigation system, while consolidating configuration into two focused tabs: **Source & Tuning** and **Solcast Connection**.
- The new item is located under **Forecast & Automation** in both the desktop menu and responsive Settings selector.
- The Forecast page retains Toolkit Preview and Refresh Preview as operational forecast tools. It provides an explicit route to the centralized Settings section for authorized developers.
- Operators cannot see or open Forecast Configuration, including Solcast credentials and model tuning controls.
- API Key and Toolkit are access modes within **Solcast Connection**, not separate navigation destinations. Only the credential group matching the selected access mode is shown.
- Settings provides **Save & Verify Connection**, which saves the configuration and reports only a plain connection success/failure result. It never loads or renders a preview chart.
- Existing field IDs, validation, persistence, and keyboard-accessible card-tab behavior were preserved. A stale saved selection from the former five-tab layout falls back safely to **Source & Tuning**.

## Remote authority

- Forecast settings already use the gateway-authoritative `/api/settings` path in Remote mode; client-local settings filtering excludes every forecast field.
- Solcast Test, Preview, Load Data, snapshot-date lookup, and week-ahead reads now proxy to the gateway in Remote mode.
- Remote clients therefore do not create a second Solcast cache or independent forecast configuration. The gateway owns forecast credentials, snapshots, tests, previews, and persisted tuning.
- In Gateway mode, those same operations execute against the gateway's own settings and data store; the UI does not select a separate forecast authority.

## Verification

- `modeIsolation.test.js` passed through Electron Node mode. It verifies forecast settings are forwarded to the gateway, never copied into the client standby settings, and that a Solcast test reaches the gateway with the configured remote token.
- JavaScript syntax and whitespace checks passed.
- Browser checks at 1440px and 390px confirmed Forecast Configuration is a direct Settings child with exactly two compact tabs; Forecast Preview remains on the Forecast page; API/Toolkit mode visibility works correctly; and there is no horizontal overflow.
- Shipped `public/` and `frontend/public/` HTML and application scripts remain byte-identical.

## Scope

All work is confined to `D:\Inverter-Dashboard`. No legacy ADSI project or legacy runtime directory was accessed or modified.
