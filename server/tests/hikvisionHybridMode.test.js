"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const nativePlayer = require("../../electron/hikvisionNativePlayer");
const hikvisionManager = require("../hikvisionManager");

const ROOT = path.join(__dirname, "..", "..");
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), "utf8");

try {
  const app = read("public/js/app.js");
  const html = read("public/index.html");
  const main = read("electron/main.js");
  const nativeSource = read("electron/hikvisionNativePlayer.js");
  const server = read("server/index.js");
  const manager = read("server/hikvisionManager.js");
  const preload = read("electron/preload.js");
  const viewerHtml = read("public/hikvision-native-viewer.html");
  const viewerJs = read("public/js/hikvision-native-viewer.js");
  const viewerCss = read("public/css/hikvision-native-viewer.css");
  const style = read("public/css/style.css");
  const packageConfig = JSON.parse(read("package.json"));
  const installerScript = read("scripts/installer.nsh");

  assert.strictEqual(
    packageConfig.build?.win?.requestedExecutionLevel,
    "asInvoker",
    "the installed dashboard must share LocalService's normal integrity level so native video can embed",
  );
  assert.strictEqual(packageConfig.build?.nsis?.perMachine, true, "the installer must remain per-machine/elevated");
  assert.strictEqual(packageConfig.build?.nsis?.allowElevation, true, "the installer must retain its UAC elevation path");
  assert(
    installerScript.includes("*S-1-5-32-545:(OI)(CI)M"),
    "the elevated installer must grant language-neutral Users modify ACLs for the non-elevated runtime",
  );
  assert(
    installerScript.includes('DeleteRegValue HKCU "Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers" "$INSTDIR\\ADSI Inverter Dashboard.exe"'),
    "the installer must remove the stale per-user RUNASADMIN compatibility override",
  );
  assert(
    installerScript.includes('DeleteRegValue HKLM "Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers" "$INSTDIR\\ADSI Inverter Dashboard.exe"'),
    "the installer must remove the stale machine-wide RUNASADMIN compatibility override",
  );

  assert(app.includes('id="btnCamFullscreen" title="Open flexible camera viewer window"'), "Tapo fullscreen control must open the flexible viewer window");
  assert(!app.includes('id="btnCamPopout"'), "the redundant Tapo popout control must be removed");
  assert(app.includes('$("btnCamFullscreen")?.addEventListener("click", openCameraViewerWindow)'), "Tapo viewer control must use the Electron popout path");
  assert(app.includes('document.body.classList.add("camera-popout-mode")'), "the Tapo viewer must activate its full-bleed layout");
  assert(app.includes("cameraUiAbortController?.abort()"), "Tapo viewer lifecycle listeners must be disposed across grid rebuilds");
  assert(main.includes('camera:        "ADSI \\u2013 Tapo Camera Viewer"'), "Tapo viewer must have a distinct native window title");
  assert(main.includes('minWidth: page === "camera" ? 480 : 900'), "Tapo viewer needs the compact Hikvision-style minimum width");
  assert(main.includes('minHeight: page === "camera" ? 300 : 600'), "Tapo viewer needs the compact Hikvision-style minimum height");
  assert(!main.includes('if (page === "camera") win.maximize();'), "Tapo viewer must not force itself maximized");
  assert(style.includes(".camera-popout-mode #page-camera .camera-card"), "Tapo viewer card must fill its dedicated window");
  assert(style.includes("body.camera-popout-mode > :not(#main)"), "Tapo viewer must exclude dashboard-level HTML from its client area");
  assert(style.includes(".camera-popout-mode #main > :not(#page-camera)"), "Tapo viewer must exclude the footer and all non-camera main content");
  assert(style.includes(".camera-body > :not(video):not(canvas)"), "Tapo viewer must frame only its video or canvas surface");

  assert(app.includes('this.requestedMode === "localservice"\n        ? "browser"'), "recommended dashboard mode must remain browser HLS");
  assert(app.includes("this.connectGeneration"), "hybrid transitions need stale-connect cancellation");
  assert(app.includes("hikvisionUiAbortController?.abort()"), "grid rebuilds must dispose prior Hikvision UI listeners");
  assert(app.includes("openHikvisionNativeViewer(theme)"), "dashboard must open the dedicated Electron native viewer");
  assert(app.includes('requestedMode === "localservice" && window.electronAPI?.openHikvisionNativeViewer'), "only recommended hybrid mode should open the native viewer");
  assert(app.includes("_pausedForNativeViewer"), "requesting HLS player must pause while the native viewer owns the DVR");
  assert(!app.includes("setHikvisionFloating"), "Hikvision must not float over other dashboard pages");
  assert(app.includes("if (!hikvisionPageActive && hikvisionPlayer)"), "Hikvision playback must stop away from its owning page");
  assert(app.includes("hikvisionCard.hidden = !hikvisionPageActive"), "Hikvision card must be explicitly hidden off-page");
  assert(app.includes('id="btnHikvisionSettings"'));
  assert(!app.includes('id="btnHikvisionPopout"'), "obsolete Hikvision HLS popout button must be removed");
  assert(app.includes('id="btnHikvisionNativeViewer"'), "native viewer control must remain available");
  assert(!html.includes('id="page-hikvision-camera"'), "obsolete Hikvision HLS popout page must be removed");
  assert(!main.includes('"hikvision-camera": "ADSI \\u2013 Hikvision Viewer"'), "obsolete Hikvision HLS popout route must be removed");
  assert(main.includes("function openHikvisionNativeViewer"));
  assert(main.includes('title: "ADSI \\u2013 Hikvision Native Viewer"'));
  assert(main.includes("frame: true"), "native viewer must use standard Windows window controls");
  assert(main.includes("minWidth: 480") && main.includes("minHeight: 300"), "native viewer must support compact multi-window layouts");
  assert(main.includes('hikvision-native-viewer.html?theme='));
  assert(main.includes("await hikvisionNativePlayer.stop(win)"), "native viewer must stop native playback before destruction");
  assert(main.includes("hikvisionNativePlayer.stop(getTrustedHikvisionOwner(event))"), "native stop IPC must be owner scoped");
  assert(nativeSource.includes("await waitForOwnerVisible(owner, expectedGeneration)"), "native surface creation must wait until its dedicated Electron window is visible");
  assert(nativeSource.includes("const WINDOW_BIND_DELAY_MS = 350"), "native HWND discovery must allow the UUID title to propagate");
  assert(nativeSource.includes('request("window.updateParentWnd")'), "native surface must rebind to its dedicated viewer parent");
  assert(nativeSource.includes("for (const attempt of buildPlaybackAttempts(config))"), "native playback must fall back when the DVR SDK path produces no frames");
  assert(!preload.includes("onHikvisionPopoutOpened") && !preload.includes("onHikvisionPopoutClosed"));
  assert(preload.includes("openHikvisionNativeViewer") && preload.includes("onHikvisionNativeViewerClosed"));
  assert(viewerHtml.includes('id="nativeSurface"') && !viewerHtml.includes('id="nativeExit"'));
  assert(viewerJs.includes("requestAnimationFrame(() => requestAnimationFrame"), "native viewer must wait for settled geometry");
  assert(!viewerJs.includes("closeHikvisionNativeFullscreen"));
  assert(viewerCss.includes(".native-surface") && viewerCss.includes("height: 100%"), "native surface must fill the framed window content area");
  assert(server.includes("function proxyHikvisionMediaToRemote"), "remote Hikvision media needs a binary streaming proxy");
  assert(server.includes("shouldUseLocalHikvisionFallback()"), "remote camera playback must support a direct workstation fallback");
  assert(server.includes("validateHlsManifest: true"), "the remote proxy must validate gateway playlists before selecting the relay");
  assert(server.includes('setRemoteHikvisionRelayCapability("degraded")'), "invalid gateway media must activate direct fallback");
  assert(server.includes("remoteHikvisionRelayCapabilityAt >= 60000"), "a degraded relay must be re-probed after the fallback cooldown");
  assert(server.includes("function isHostOnLocalSubnet"), "route policy must distinguish same-LAN remote workstations from Tailscale clients");
  assert(server.includes('nativeReady: Boolean(sdk.reachable)'), "operation mode must not block a directly reachable native DVR route");
  assert(server.includes("getRemoteHikvisionDirectRouteState"), "complete Remote mode must remember bounded direct-route reachability");
  assert(server.includes("Complete Remote mode requires the gateway camera relay"), "unreachable direct fallback must return explicit Complete Remote guidance");
  assert(app.includes('unavailable: "No reachable HLS path"'), "the settings modal must expose a distinct no-route state");
  assert(server.includes('app.post("/api/hikvision/route-status"'), "viewer-local DVR route diagnostics must remain available");
  assert(server.includes('recommendedRoute: net.isIP(cfg.host) === 4 ? `${cfg.host}/32`'), "route guidance must recommend only the DVR host, not the plant subnet");
  assert(html.includes('id="hikHttpPort"'), "native SDK HTTP port must be configurable alongside RTSP");
  assert(html.includes('id="hikRoutePanel"') && html.includes('id="btnHikRouteCheck"'), "settings must expose secure path diagnostics");
  assert(app.includes('api("/api/hikvision/route-status", "POST", configFromForm())'), "settings route check must use the current unsaved DVR target");
  assert(app.includes("Gateway HLS relay") && app.includes("Direct DVR over local LAN") && app.includes("Direct DVR over Tailscale"), "remote path labels must distinguish relay, LAN, and Tailscale");
  assert(html.includes('id="hikOperationBadge"') && html.includes('id="hikOperationBanner"'), "settings must visibly separate Gateway and Remote camera contexts");
  assert(app.includes('operationBadge.textContent = remote ? "Remote mode" : "Gateway mode"'), "settings mode badge must follow the active operation mode");
  assert(server.includes("isMissingRemoteHikvisionRoute"), "old gateway HTML 404 responses must be detected and contained");
  assert(app.includes("invalid HLS manifest") && app.includes("#EXTM3U"), "the renderer must validate gateway playlists before Hls.js parses them");
  assert(app.includes("requiresGatewayUpdate"), "missing relay endpoints must not enter an automatic retry loop");
  assert(manager.includes('"/api/hikvision/hls/hls/"'), "go2rtc child playlist and segment paths must stay inside the authenticated Hikvision relay");
  assert(manager.includes("const RTSP_PORT = 8564"), "Hikvision go2rtc must not collide with the Tapo RTSP listener on 8554");
  assert(manager.includes('rtsp: { listen: `${API_HOST}:${RTSP_PORT}` }'), "Hikvision FFmpeg output needs its own loopback RTSP module");
  assert(manager.includes("isPortFree(RTSP_PORT)"), "Hikvision startup must fail clearly when its internal RTSP port is unavailable");
  assert(manager.includes("isPortListening(RTSP_PORT)"), "Hikvision readiness must include the internal RTSP module");
  assert(manager.includes("let startPromise = null"), "concurrent HLS requests must share one media-service startup");
  assert(manager.includes("if (startPromise) return startPromise"), "HLS callers must await readiness instead of treating a spawned child as ready");
  assert(manager.includes("${encodeURIComponent(selectedStream(cfg))}&mp4"), "Hikvision HLS must use go2rtc fragmented-MP4 output instead of invalid video-only MPEG-TS fragments");
  const rewrittenPlaylist = hikvisionManager.__test.rewriteHikvisionPlaylist(
    "#EXTM3U\n/api/hls/playlist.m3u8?id=abc\n/api/hls/init.mp4?id=abc\n/api/hls/segment.m4s?id=abc",
  );
  assert(rewrittenPlaylist.includes("/api/hikvision/hls/hls/playlist.m3u8?id=abc"));
  assert(rewrittenPlaylist.includes("/api/hikvision/hls/hls/init.mp4?id=abc"));
  assert(rewrittenPlaylist.includes("/api/hikvision/hls/hls/segment.m4s?id=abc"));
  assert(!rewrittenPlaylist.includes("\n/api/hls/"), "no child request may escape the Hikvision relay namespace");

  const fakeOwner = {
    isDestroyed: () => false,
    getContentSize: () => [800, 600],
  };
  const rect = nativePlayer.__test.sanitizeRect(
    { left: 10, top: 20, width: 400, height: 300, scaleFactor: 1.5 },
    fakeOwner,
  );
  assert.deepStrictEqual(rect, { left: 15, top: 30, width: 600, height: 450 });
  const clamped = nativePlayer.__test.sanitizeRect(
    { left: -100, top: -20, width: 5000, height: 5000, scaleFactor: 1 },
    fakeOwner,
  );
  assert.deepStrictEqual(clamped, { left: 0, top: 0, width: 800, height: 600 });
  for (const invalid of [null, {}, { left: 0, top: 0, width: 0, height: 20 }, { left: 0, top: 0, width: Infinity, height: 20 }]) {
    assert.throws(() => nativePlayer.__test.sanitizeRect(invalid, fakeOwner), /Invalid Hikvision native surface rectangle/);
  }

  const playbackAttempts = nativePlayer.__test.buildPlaybackAttempts({
    host: "192.168.1.12",
    httpPort: 80,
    rtspPort: 554,
    channel: 1,
    stream: "main",
    username: "admin",
    password: "test-password",
  });
  assert.strictEqual(playbackAttempts[0].url, "http://192.168.1.12:80/SDK/play/100/004");
  assert.strictEqual(Buffer.from(playbackAttempts[0].auth, "base64").toString("utf8"), ":::2:admin:test-password");
  assert.strictEqual(playbackAttempts[1].url, "rtsp://192.168.1.12:554/ISAPI/streaming/channels/101");
  assert.strictEqual(Buffer.from(playbackAttempts[1].auth, "base64").toString("utf8"), "admin:test-password");
  assert.deepStrictEqual(
    nativePlayer.__test.extractPlayInfo({ playInfo: { playInfo: { pictureSize: { width: 1920, height: 1080 } } } }),
    { pictureSize: { width: 1920, height: 1080 } },
  );
  assert.deepStrictEqual(
    nativePlayer.__test.extractPlayInfo({ playInfo: { pictureSize: { width: 960, height: 576 } } }),
    { pictureSize: { width: 960, height: 576 } },
  );

  console.log("hikvisionHybridMode.test.js: PASS");
} catch (err) {
  console.error("hikvisionHybridMode.test.js: FAIL", err?.stack || err);
  process.exit(1);
}
