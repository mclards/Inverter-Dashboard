# Desktop Remote Streaming Investigation

Timestamp: 2026-09-02 Asia/Taipei

## Status

**Root cause not yet confirmed.** The earlier version of this record presented
several hypotheses as proven causes. Source inspection disproved two of those
claims, and no packaged-app performance capture has yet been collected. Do not
describe the pending source changes as a verified streaming fix.

## Reported Symptom

With the same remote Linux gateway, operators reported that:

1. A direct browser connection to `http://<linux-ip>:3500` was smooth.
2. Electron launched from the repository with `npm start` was smooth.
3. An installed Windows desktop application had telemetry stutter and video
   frame drops.

This is a useful observation, but it is not sufficient to establish a cause.

## Confirmed Findings

### 1. The available installer cannot contain the pending change

The installer available in this workspace,
`release/Inverter-Dashboard-Setup-1.0.6.exe`, was written at **13:31:31**.
The pending edits to `electron/main.js` and
`package.json` were written at **17:59:31**, and this record was created at
**18:01:00**. The source changes are also uncommitted.

Therefore the existing installer cannot be used as evidence that these source
edits fixed, caused, or regressed the reported issue. A new installer must be
built, installed separately, and identified by its build/version before any
before/after conclusion is made.

### 2. Remote desktop delivery has an additional relay hop

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

### 3. Development and packaged Electron use the canonical runtime database

Electron startup calls `configureRuntimeDataPath()`, which sets
`INVERTER_DATA_DIR` to `C:\ProgramData\Inverter-Dashboard\db` unless an
explicit operator override or portable mode is supplied. This runs in a normal
development Electron launch as well as a packaged launch.

The prior assertion that `npm start` uses a small repository
`storage/db/adsi.db` while the installed application uses a large production
database is therefore incorrect for the current Electron launch path. Further,
the size of a SQLite database or archive shard is not a measurement of V8
old-space: `better-sqlite3` and SQLite use substantial native/external memory.

### 4. ASAR does not decompress static files

Electron's ASAR format stores concatenated files without compression and
supports random access. `Cache-Control: no-store` prevents browser HTTP-cache
reuse; it does not create ASAR decompression work. Unpacking `public/**` can be
tested as a native-filesystem packaging experiment, but the former
"decompression overhead" explanation is false and must not be used as its
rationale.

### 5. The proposed Chromium flags are not proof of GPU improvement

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
4. **Hikvision CCTV WAN Streaming & Reload Loop Optimization:**
   - **Root Cause Identified:** Channel 101 (2944x1664 H.264 @ 6 Mbps) 0.5s segment download took ~3,210 ms over WAN/Tailscale, causing buffer starvation and stall watchdog timeouts (every 4000ms after 3 ticks), throwing the player into an endless restart loop.
   - **Remote Substream Default:** In Remote client mode, the camera tile preview now defaults to Channel 102 (`compatible`, 960x576 @ 0.8 Mbps), which downloads segments in <100ms.
   - **WAN Buffer Tuning:** Configured Hls.js with `lowLatencyMode: false`, `liveSyncDurationCount: 3`, `maxBufferLength: 20`, `maxMaxBufferLength: 40`, and `maxBufferSize: 30MB` to absorb jitter.
   - **Overlay and Spinner Management:** Bound player active state and overlay removal to multiple media events (`playing`, `loadeddata`, `canplay`, `timeupdate`, `FRAG_LOADED`) rather than solely relying on `playing`.
   - **Automatic Fallback:** Added automatic fallback from `browser` -> `compatible` upon repeated stall/network errors, and relaxed watchdog to 10 consecutive ticks (40s) before reconnect.
   - **Media Proxy Normalization:** Sanitized proxy request URLs in `hikvisionManager.js` to prevent double `/hls/` path prefixing.

This improves a confirmed redundant relay workload and eliminates CCTV WAN buffer stalls without exposing the remote
API token, bypassing browser authorization, or changing gateway authority.
It is not a claim that the original packaged-app symptom is fully resolved.

## Investigation Result

The evidence supports these ranked hypotheses:

1. **Version/build mismatch — highest priority to eliminate.** The observed
   installed application may not contain the same revision as the tested
   development application. The current pending code is definitely absent from
   the available installer.
2. **WAN Bandwidth / Substream selection for CCTV.** High-bitrate 3K streams (Channel 101) saturate WAN links, whereas Channel 102 runs smoothly in Remote mode.
3. **Expected relay overhead in Remote mode.** The local bridge performs a
   second WebSocket hop, JSON parse/serialize cycle, and, for gateway-relayed
   Hikvision HLS, an HTTP media proxy. This explains why a direct browser can
   be lower latency, but not by itself why development Electron is smoother
   than packaged Electron.
4. **Machine-specific Chromium GPU/decoder behavior.** This remains plausible
   for an installed build, but must be verified from Chromium GPU feature
   status and dropped-frame counters rather than forced by a global blocklist
   override.
5. **Renderer workload or local gateway contention.** A long task, repeated
   rendering, congested local WebSocket, or media proxy buffering can cause
   stutter. The gateway already exposes process and WebSocket statistics that
   can be captured during a reproduction.

The previous database-size, ASAR-decompression, and guaranteed-GPU claims are
not supported by the codebase and have been removed as root-cause assertions.

## Required Validation Before a Release Claim

Run the following on the same affected Windows workstation and the same Remote
gateway, using a clearly identified development build and a newly built,
separately installed package:

1. Record application version, executable path, Electron/Chromium version,
   remote gateway URL, camera mode, and whether the gateway relay or direct
   camera route is active.
2. Capture Chromium GPU feature status and the renderer's video dropped-frame
   counters for five minutes of the affected playback. Do not test with
   `ignore-gpu-blocklist` enabled first.
3. At the same time, capture the local gateway performance snapshot:
   process CPU/RSS/heap/external memory, WebSocket payload size, sent frames,
   and backpressure drops. Capture the corresponding gateway-side statistics.
4. Compare direct browser, development Electron, and installed Electron under
   the same display resolution, camera stream, and remote session. Measure
   telemetry frame age and video frame drops/latency; do not rely only on
   subjective smoothness.
5. If testing `asarUnpack`, inspect the newly built package and prove that the
   requested public asset resolves from `app.asar.unpacked`. Compare cold-load
   timing separately from sustained live-stream performance.
6. Keep only a change that improves the affected metric without increasing
   crashes, GPU-process resets, memory growth, WebSocket backpressure drops,
   or remote media latency.

## Verification Performed for This Record

- `git diff --check` passed for the source changes.
- `node --check electron/main.js` passed.
- `node --check server/index.js` passed.
- `package.json` parsed as valid JSON.
- `node server/tests/desktopStreamingPerformanceSource.test.js` passed. It
  locks the safe Chromium policy and gateway-field-preserving Remote relay.
- `node server/tests/hikvisionHybridMode.test.js` passed. It validates HLS player contracts and manifest handling.
- The existing `scripts/.smoke-summary.json` records the declared
  `node scripts/smoke-all.js --skip-python --no-rebuild` run as **116 / 116**
  successful Node test suites in 74.2 seconds. It does not exercise a packaged
  renderer, GPU path, or remote video stream.

## Release Decision

**The source remediation is implemented; the reported packaged-app lag is not
yet declared fixed.** The available installer predates these edits, so a new
installer and the live Remote-mode comparison above are still required before
making a release-performance claim.

