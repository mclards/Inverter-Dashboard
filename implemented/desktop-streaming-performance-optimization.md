# Desktop Remote Streaming Investigation

Timestamp: 2026-09-02 Asia/Taipei

## Status

**Remote inverter-telemetry delay root cause confirmed in the running
environment; source fix implemented, regression-tested, and packaged in the
signed 1.0.8 installer. Linux-gateway deployment and an installed-client field
measurement are still pending.** The camera and packaged-renderer portions
still require a live post-install test. Do not combine those separate results
into a claim that every reported streaming symptom is field-verified.

## Reported Symptom

With the same remote Linux gateway, operators reported that:

1. A direct browser connection to `http://<linux-ip>:3500` was smooth.
2. Electron launched from the repository with `npm start` was smooth.
3. An installed Windows desktop application had telemetry stutter and video
   frame drops.

This is a useful observation, but it is not sufficient to establish a cause.

## Confirmed Findings

### 1. The 1.0.8 installer contains the current telemetry fix

`release/Inverter-Dashboard-Setup-1.0.8.exe` was built from commit `520836e`
after the WebSocket authorization, compression, frame-coalescing, and
player-lifecycle changes documented below. The build script verified the
expected signing-certificate thumbprint and the timestamp signature. Windows
reports `UnknownError` on this build workstation because the private MCTech
root is not installed in its Trusted Root store; the thumbprint pin still
passed. This is an internal-PKI trust-state result, not a claim of public
SmartScreen reputation.

The older 1.0.7 installer does not contain these fixes and must not be used for
post-fix performance validation.

### 2. The Remote desktop live WebSocket was blocked before token validation

The live investigation reproduced the delay against the configured Linux
gateway without printing or persisting its credentials:

- The running Windows bridge was in Remote mode with 89 live nodes, low CPU,
  and no local WebSocket backpressure drops.
- An authenticated machine-to-machine WebSocket reached `OPEN` and was then
  immediately closed without receiving an `init` or `live` frame.
- `browserAuth.pageGuard` treated `/ws` as an ordinary protected page and
  rejected the request before `authorizeDashboardWebSocket` could validate the
  Remote API token in the `app.ws("/ws")` handler.
- The bridge consequently fell back to repeated full `/api/live` HTTP pulls.
  Five direct gateway pulls took 1,209-1,657 ms each.

This is the confirmed cause of the extra Remote-desktop delivery delay. The
fix allows only actual WebSocket upgrade requests under `/ws` to reach the
existing route-specific validator. It does not bypass token/session checks;
the integration test confirms an invalid token still closes with policy code
1008.

### 3. Remote desktop delivery has an additional relay hop

The Electron window always loads its local gateway at
`http://localhost:3500`. In Remote mode, the local gateway opens a WebSocket
to the configured Linux gateway, parses each incoming live frame, rebuilds the
remote live snapshot, serializes it again, and broadcasts it over another
WebSocket to the Electron renderer.

Direct browser path:

```text
Linux gateway -> browser renderer
```

Remote Electron path:

```text
Linux gateway -> local Windows gateway -> Electron renderer
```

The same relay pattern applies to remote Hikvision HLS when the gateway relay
is used: the Windows local gateway proxies the media response to the renderer.
This extra work is an architectural source of some added latency and CPU use
relative to a direct browser. It does **not** explain a difference between a
development Electron run and an installed Electron build when both use the
same source, version, configuration, and machine.

### 4. Development and packaged Electron use the canonical runtime database

Electron startup calls `configureRuntimeDataPath()`, which sets
`INVERTER_DATA_DIR` to `C:\ProgramData\Inverter-Dashboard\db` unless an
explicit operator override or portable mode is supplied. This runs in a normal
development Electron launch as well as a packaged launch.

The prior assertion that `npm start` uses a small repository
`storage/db/adsi.db` while the installed application uses a large production
database is therefore incorrect for the current Electron launch path. Further,
the size of a SQLite database or archive shard is not a measurement of V8
old-space: `better-sqlite3` and SQLite use substantial native/external memory.

### 5. ASAR does not decompress static files

Electron's ASAR format stores concatenated files without compression and
supports random access. `Cache-Control: no-store` prevents browser HTTP-cache
reuse; it does not create ASAR decompression work. Unpacking `public/**` can be
tested as a native-filesystem packaging experiment, but the former
"decompression overhead" explanation is false and must not be used as its
rationale.

### 6. The proposed Chromium flags are not proof of GPU improvement

The pending source change raises the V8 old-space maximum to 2 GB and adds
`enable-gpu-rasterization`, `enable-zero-copy`, and
`ignore-gpu-blocklist`.

These flags do not demonstrate a video pipeline improvement:

- A larger maximum heap does not allocate 2 GB, and it may help only if a
  measured V8 heap limit/GC problem exists.
- `enable-zero-copy` is not a guarantee of a direct H.264/WebRTC texture
  path.
- `ignore-gpu-blocklist` bypasses Chromium protections for known unstable GPU
  and driver combinations. It can turn dropped frames into black output,
  renderer instability, or crashes.
- Removing `disable-software-rasterizer` permits a software fallback. It does
  not guarantee hardware compositing.

The flags must remain an experiment until GPU feature status and playback
metrics prove both safety and benefit on the affected workstation.

## Implemented Source Remediation

The following safe changes have been made in the working tree:

1. **Restore Chromium's default memory and GPU policy.** The global 256 MB V8
   cap was removed, but the unsafe 2 GB replacement and forced GPU switches
   were not retained. Electron now allows Chromium to select its normal V8,
   GPU, decoder, and fallback behavior for the workstation.
2. **Remove the unproven public-ASAR extraction.** `public/**` is no longer in
   `asarUnpack`; ASAR has no decompression cost to remove. This prevents a
   larger, duplicate unpacked payload being shipped based on an invalid theory.
3. **Stop redundant Remote-mode live enrichment.** The remote gateway already
   sends `todayEnergy`, `todaySummary`, and `plantCap` with each enriched live
   frame. The Windows relay now preserves those gateway-authoritative values,
   while adding only its local bridge-health snapshot. It no longer recomputes
   the day summary or plant-cap status on every relayed frame. A missing
   gateway `todayEnergy` field still uses the established local fallback.
4. **Hikvision CCTV WAN resilience and player lifecycle:**
   - Remote mode continues to select the lower-bandwidth `compatible`
     substream when the configured mode is `localservice` or `compatible`.
   - Hls.js uses a larger jitter buffer, trading additional latency for fewer
     WAN underruns.
   - Automatic `browser` to `compatible` fallback now persists across the
     config re-read performed by `connect()`. Before this correction,
     `connect()` immediately restored explicit `browser` mode and defeated the
     advertised fallback.
   - The player now declares `LIVE` only after Chromium exposes decoded video
     data and non-zero dimensions. Manifest parsing and fragment download no
     longer hide the overlay or cancel the startup timeout prematurely.
   - Per-connection media readiness listeners are owned by an
     `AbortController` and removed on playback, teardown, or reconnect instead
     of accumulating across recovery attempts.
   - Fallback tears down the previous Hls.js instance and timers before opening
     the compatible stream.
   - Media proxy URL normalization continues to contain child paths inside the
     authenticated Hikvision relay.

5. **Restore the Remote telemetry WebSocket fast path:**
   - WebSocket upgrades under `/ws` now pass the page guard and remain subject
     to `authorizeDashboardWebSocket`, preserving token/session enforcement.
   - Per-message deflate is enabled for WebSocket payloads. The observed live
     JSON was about 88 KB; a representative fast compression pass reduced the
     same content to about 8 KB (approximately 91%). This is a sizing estimate,
     not a captured on-wire WebSocket frame.
   - The binary MPEG camera socket explicitly disables per-message deflate;
     already-compressed video is not recompressed by the telemetry setting.
   - Full-plant live broadcasts are coalesced to the newest snapshot at a
     maximum 2 Hz. Alarm, control, configuration, and other event messages are
     not coalesced.
   - The live-frame backpressure ceiling is reduced from 1 MiB to 256 KiB so a
     slow client cannot retain a long queue of obsolete plant snapshots.
   - The renderer also coalesces bursts to the newest live frame before doing
     full state/DOM work.
   - Gateway and local send timestamps distinguish per-frame transport latency
     from connection lifetime. The old WebSocket path incorrectly treated the
     age of a long-lived connection as the latest frame's latency.
6. **Repair the release lockfile:** The prior camera commit accidentally
   removed `lockfileVersion` and the root `dependencies` key from
   `package-lock.json`, leaving invalid JSON. The v3 structure is restored and
   regression parsing now locks it to the package version.

These changes preserve the local bridge, Remote API-token boundary, gateway
authority, and local-only UI/export capabilities. They address the confirmed
Remote telemetry delivery failure and the identified camera lifecycle defects;
post-deployment field verification remains required for perceived smoothness.

## Investigation Result

The live evidence separates these latency components:

1. **Confirmed Remote transport failure.** The desktop bridge's token-based
   `/ws` request was closed by `pageGuard`, forcing HTTP polling. Local bridge
   snapshots changed only every 3-4 seconds during the capture, and their
   oldest source samples reached roughly 12.4 seconds of age.
2. **Gateway sweep age.** Gateway runtime metrics during the same investigation
   showed a current poll duration of 32 ms, average 34 ms, current event-loop
   lag of 1 ms, and source-frame age averaging about 1.8 seconds with a 3.7
   second recorded maximum. A separate five-request WAN sample observed about
   3.7-4.3 seconds average and 6.6-7.6 seconds maximum source age by the time
   each HTTP response arrived. This component reflects when individual
   inverter/node samples were collected plus WAN transfer time; it is not a
   10-second renderer throttle.
3. **Uncompressed full-snapshot pressure.** The gateway payload was about
   86-88 KB and its accumulated runtime statistics recorded 561 backpressure
   drops. Sending every 200 ms can exceed a constrained WAN link and preserve
   stale TCP/WebSocket work. Compression, coalescing, and the lower buffer
   ceiling bound that pressure.
4. **Camera bandwidth and decoding remain separate.** The compatible substream
   is a sensible Remote default and the HLS buffer settings improve jitter
   tolerance, but HTTP 200 responses or a downloaded fragment do not prove
   smooth decoded playback.
5. **Packaged Chromium behavior remains a validation item.** GPU feature state
   and dropped-frame counters still need comparison on the affected installed
   workstation. Forced GPU blocklist overrides remain unjustified.

The previous database-size, ASAR-decompression, and guaranteed-GPU claims are
not supported by the codebase and have been removed as root-cause assertions.

## Required Validation Before a Release Claim

Run the following on the same affected Windows workstation and the same Remote
gateway, using a clearly identified development build and a newly built,
separately installed package:

1. Deploy the same corrected revision to the Linux gateway and Windows client,
   restart both gateway processes, and verify that the Remote bridge remains on
   WebSocket instead of returning to `pull-live` fallback.
2. Record application version, executable path, Electron/Chromium version,
   remote gateway URL, camera mode, and whether the gateway relay or direct
   camera route is active.
3. Capture Chromium GPU feature status and the renderer's video dropped-frame
   counters for five minutes of the affected playback. Do not test with
   `ignore-gpu-blocklist` enabled first.
4. At the same time, capture the local gateway performance snapshot:
   process CPU/RSS/heap/external memory, WebSocket payload size, sent frames,
   and backpressure drops. Capture the corresponding gateway-side statistics.
5. Compare direct browser, development Electron, and installed Electron under
   the same display resolution, camera stream, and remote session. Measure
   telemetry frame age and video frame drops/latency; do not rely only on
   subjective smoothness.
6. If testing `asarUnpack`, inspect the newly built package and prove that the
   requested public asset resolves from `app.asar.unpacked`. Compare cold-load
   timing separately from sustained live-stream performance.
7. Keep only a change that improves the affected metric without increasing
   crashes, GPU-process resets, memory growth, WebSocket backpressure drops,
   or remote media latency.

## Verification Performed for This Record

- `git diff --check` passed for the source changes.
- JavaScript syntax checks passed for `server/browserAuth.js`, `server/ws.js`,
  `server/index.js`, both shipped `app.js` copies, and both shipped Hikvision
  native-viewer scripts.
- `package.json` and `package-lock.json` identify the corrected source as
  version `1.0.8`.
- `node server/tests/desktopStreamingPerformanceSource.test.js` passed. It
  locks the safe Chromium policy, gateway-field-preserving relay, WebSocket
  transport safeguards, and corrected camera readiness/fallback contracts.
- `node server/tests/webLoginHardening.test.js` passed, including a real
  token-authenticated WebSocket upgrade and an invalid-token rejection.
- `node server/tests/wsRealtimeDelivery.test.js` passed, proving a burst keeps
  the latest live snapshot, applies the lower live backpressure ceiling, and
  does not coalesce control events.
- `node server/tests/hikvisionHybridMode.test.js` passed.
- `node scripts/smoke-all.js --skip-python --no-rebuild` passed **117 / 117**
  Node test suites in 68.482 seconds after the final camera-socket adjustment.
- `python -m py_compile` passed for both shipped inverter-engine copies.
- Canonical `C:\ProgramData\Inverter-Dashboard\db\ipconfig.json` parsed as
  valid JSON with all four maps and 27 inverter records; the engine source
  resolves the hyphenated ProgramData path.
- `npm run build:installer:signed` produced
  `release/Inverter-Dashboard-Setup-1.0.8.exe` (354,772,632 bytes) from clean
  commit `520836e`; the expected signing thumbprint and Sectigo timestamp were
  present and the signing-thumbprint pin passed.
- Pre-fix live diagnostics reproduced the failed WebSocket fast path and the
  sample ages documented above. The corrected source has not yet been deployed
  to both endpoints, so a post-fix live latency number is not claimed here.

## Release Decision

**The confirmed Remote telemetry fault is fixed in version 1.0.8 source and
fully covered by local regression tests, and a signed 1.0.8 installer has been
built.** The currently running Linux gateway still predates the correction.
Install 1.0.8, update/restart the gateway, and repeat the live age capture
before declaring the field symptom resolved. Camera smoothness likewise
remains a live visual verification item.
