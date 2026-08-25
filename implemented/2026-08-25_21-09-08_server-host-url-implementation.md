# Server Host URL, Remote Authority & Audit Identity

Timestamp: 2026-08-25 21:09:08 Asia/Taipei

## Implemented behavior

- `Server Host URL` is the sole device-role authority.
- A non-empty, validated HTTP(S) host makes the device a Remote client.
- A blank host makes the device the local Gateway/server.
- A Remote client cannot start local inverter polling or local-server services.
- No separate Operation Mode selector is required or shown in the configuration UI.
- Clearing the Server Host URL and restarting returns the device to local-server operation.

## Sign-in persistence contract

1. The operator credentials are validated.
2. Only after successful validation, the normalized Server Host URL is saved in the local settings database.
3. The authenticated dashboard session starts.

The value is stored locally in:

`C:\ProgramData\Inverter-Dashboard\db\adsi.db`

The next dashboard start reads the saved value, pre-populates the sign-in field, and applies the matching client/server role. Invalid credentials do not save or alter the Server Host URL.

## Remote API token onboarding

When a Server Host URL is entered, the login screen reveals a masked Remote API Token field. The operator enters the token configured on the gateway. After credentials succeed, the host, derived role, and supplied token are saved together in a local database transaction.

- A Remote client with no existing token must provide one before it can sign in.
- A previously saved token is never displayed; leaving its field blank preserves it.
- Clearing the Server Host URL returns the device to Gateway/server role and does not delete the stored token.
- Invalid credentials never cause either host or token to be written.
- Once in Remote mode, a save containing only device-local connection or UI preferences does not contact the old gateway. This makes clearing the Server Host URL reliable even when that gateway is offline; any save that includes plant settings remains gateway-authoritative and still requires the Remote API token.
- An incoming `operationMode` value is never trusted as a role override. The saved Server Host URL continues to derive the role, so a Remote client cannot bypass gateway authority with a forged request.

## Compact login presentation

The sign-in page uses progressive disclosure rather than permanently showing connection fields:

- A local server device shows a compact local-server summary and a `Connect to server` action.
- A configured Remote client shows its server address and a `Change` action; the token remains hidden.
- The connection editor opens as a modal, so the sign-in card never expands or shifts.
- The modal reveals Server Host URL only after the action is selected, then reveals the masked token only once a host has been entered.
- `Done` stages the edited connection and returns to the stable sign-in card; it does not save anything by itself.
- `Cancel`, clicking the backdrop, or pressing Escape discards unsaved editor changes. `Use this device as server` stages a blank host to be saved on the next successful sign-in.

## Remote authority and device-bound audit identity

- In Remote mode, plant-wide settings and topology saves are sent to the gateway and are never copied into the client's standby database or legacy configuration files.
- Remote clients read their current plant settings from the gateway. Only explicit client-local settings remain local: connection details, local export/UI/camera preferences, and the device profile.
- The dashboard's existing `inverter_2_device_id` scopes the remembered operator name. A successful later login does not overwrite that device profile.
- Every browser request carries `X-Device-Id` and `X-Operator-Name`; the Remote bridge forwards both to the gateway. Control and settings audit entries record the device-bound operator identity together with the full dashboard device ID.
- The device ID is an audit identity, not an authorization credential. Gateway authentication, Remote API tokens, topology keys, and control interlocks remain mandatory.

## Remote gateway endpoint verification

The configured remote endpoint `http://100.81.240.80:3500/login.html` was checked without credentials.

- It was reachable and returned `HTTP 200 OK` with the expected login HTML.
- Its `/api/health`, `/api/settings`, and `/api/live` routes returned `HTTP 401 Unauthorized` without a token. They do not expose health, settings, or live telemetry anonymously.
- The explicit port `3500` is retained by Server Host URL normalization.
- A full streaming test was intentionally not attempted: no approved Remote API token or operator credentials were available, and none were guessed or submitted.

The Server Host URL is part of the local Electron login workflow. It is deliberately not expected in the HTML served by the remote gateway itself.

## Browser developer access

- The supported browser gateway is `server/index.js` with `server/browserAuth.js`; Electron launches that exact server implementation.
- Browser developer login now follows the same contract as desktop login: `devClard` is accepted case-insensitively, while the rotating password remains exact (`devMM` for the gateway server's current minute, with the existing one-minute tolerance on either side).
- A successful browser login returns the canonical developer username and `developer` role to the login page, in addition to issuing the protected session cookie. This fixes role handoff for browser logins without changing rate limits, same-origin checks, generic error messages, or cookie protections.
- The browser page shown at a remote gateway is therefore allowed to sign in as developer. If it still fails, first verify that the password matches the **gateway server's** clock, not the client computer's clock.

## Verification performed

- Electron, server, and dashboard JavaScript syntax checks passed.
- Login and configuration HTML inline JavaScript checks passed.
- Paired `public/` and `frontend/public/` login/configuration files were verified synchronized.
- The host persistence sequence was checked: credential validation precedes local host save, which precedes session handoff.
- Focused remote/gateway isolation tests passed after updating them to use the Server Host URL as the authority.
- `server/tests/modeIsolation.test.js` verified gateway-authoritative settings, client-only field filtering, and unchanged local standby settings in Remote mode.
- `server/tests/ipConfigRemoteSave.test.js` verified Remote topology saves do not mutate standby topology and malformed gateway responses are rejected.
- The same remote-save regression verifies that clearing the Server Host URL transitions the client back to Gateway mode without proxying an empty settings request to the former gateway.
- `server/tests/browserAuthDevLogin.test.js` passed: a lowercase `devclard` browser login with the current rotating password received the canonical `devClard` developer role and an HttpOnly session cookie.

## Scope

This record applies only to `D:\Inverter-Dashboard` and its canonical runtime data root, `C:\ProgramData\Inverter-Dashboard\`. The separate old ADSI dashboard and its non-hyphenated ProgramData directory are out of scope.
