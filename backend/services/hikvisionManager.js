"use strict";

const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");

const PROGRAMDATA_ROOT = path.join(
  process.env.PROGRAMDATA || "C:\\ProgramData",
  "Inverter-Dashboard",
  "hikvision",
);
const API_HOST = "127.0.0.1";
const API_PORT = 1994;
// go2rtc's FFmpeg source publishes its transcoded output back through the
// embedded RTSP module. The general Tapo go2rtc instance owns the default
// 8554 port, so the Hikvision instance needs an isolated loopback listener.
// If this listener cannot bind, go2rtc otherwise stays alive while returning
// an empty HTTP 200 HLS manifest for hikvision_browser.
const RTSP_PORT = 8564;
const WEBRTC_PORT = 8565;
const STREAM_DIRECT = "hikvision_direct";
const STREAM_BROWSER = "hikvision_browser";
const STREAM_COMPAT = "hikvision_compatible";
const HEALTH_INTERVAL_MS = 5000;
const START_TIMEOUT_MS = 8000;
const STOP_TIMEOUT_MS = 3000;

let child = null;
let status = "stopped";
let activeConfig = null;
let healthTimer = null;
let lastHealthTs = 0;
let crashCount = 0;
let stopping = false;
let startPromise = null;
const digestCache = new Map();
const isapiAgent = new http.Agent({ keepAlive: true, maxSockets: 6, maxFreeSockets: 4 });

function defaults() {
  return {
    enabled: true,
    name: "Hikvision CCTV",
    host: "192.168.1.12",
    httpPort: "80",
    rtspPort: "554",
    channel: "1",
    stream: "main",
    transport: "tcp",
    username: "admin",
    password: "",
    playbackMode: "localservice",
    transcodeHardware: "cuda",
    autoStart: false,
  };
}

function loadLocalConfigFallback() {
  const candidates = [
    path.join(PROGRAMDATA_ROOT, "credentials.json"),
    path.join(__dirname, "..", "private", "hikvision-camera.json"),
  ];
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object") return sanitizeConfig(parsed);
    } catch (err) {
      console.warn(`[hikvision] ignored invalid local credential file: ${path.basename(file)}`);
    }
  }
  const password = cleanText(process.env.ADSI_HIKVISION_PASSWORD, 256);
  return password ? sanitizeConfig({ ...defaults(), password }) : null;
}

function cleanText(value, max = 120) {
  return String(value == null ? "" : value).trim().slice(0, max);
}

function sanitizeConfig(raw, options = {}) {
  const src = raw && typeof raw === "object" ? raw : {};
  const base = defaults();
  const host = cleanText(src.host || base.host, 120).replace(/[^a-zA-Z0-9.:[\]-]/g, "");
  const rtspPortNum = Number(src.rtspPort || base.rtspPort);
  const httpPortNum = Number(src.httpPort || base.httpPort);
  const channelNum = Math.max(1, Math.min(32, Math.trunc(Number(src.channel || 1)) || 1));
  const stream = cleanText(src.stream || base.stream, 12).toLowerCase() === "main" ? "main" : "sub";
  const transport = cleanText(src.transport || base.transport, 12).toLowerCase() === "udp" ? "udp" : "tcp";
  const requestedMode = cleanText(src.playbackMode || base.playbackMode, 20).toLowerCase();
  const playbackMode = ["native", "browser", "auto"].includes(requestedMode)
    ? "localservice"
    : ["localservice", "hls", "compatible"].includes(requestedMode)
      ? requestedMode
      : "localservice";
  const requestedHardware = cleanText(src.transcodeHardware || base.transcodeHardware, 16).toLowerCase();
  const transcodeHardware = ["auto", "cuda", "dxva2", "software", "amf"].includes(requestedHardware)
    ? requestedHardware
    : "auto";
  const out = {
    enabled: src.enabled !== false && src.enabled !== "0",
    name: cleanText(src.name || base.name, 80) || base.name,
    host: host || base.host,
    httpPort: String(Number.isInteger(httpPortNum) && httpPortNum >= 1 && httpPortNum <= 65535 ? httpPortNum : 80),
    rtspPort: String(Number.isInteger(rtspPortNum) && rtspPortNum >= 1 && rtspPortNum <= 65535 ? rtspPortNum : 554),
    channel: String(channelNum),
    stream,
    transport,
    username: cleanText(src.username || base.username, 80),
    password: cleanText(src.password, 256),
    playbackMode,
    transcodeHardware,
    autoStart: src.autoStart === true || src.autoStart === "1",
  };
  if (options.redact) {
    out.passwordConfigured = Boolean(out.password);
    delete out.password;
  }
  return out;
}

function channelPath(cfg) {
  const suffix = cfg.stream === "main" ? "01" : "02";
  return `/Streaming/Channels/${cfg.channel}${suffix}`;
}

function buildRtspUrl(cfgRaw) {
  const cfg = sanitizeConfig(cfgRaw);
  const auth = cfg.username
    ? `${encodeURIComponent(cfg.username)}:${encodeURIComponent(cfg.password)}@`
    : "";
  return `rtsp://${auth}${cfg.host}:${cfg.rtspPort}${channelPath(cfg)}?transport=${cfg.transport}`;
}

function resolveGo2rtcPath() {
  if (process.resourcesPath) {
    const packaged = path.join(process.resourcesPath, "backend", "go2rtc", "go2rtc.exe");
    if (fs.existsSync(packaged)) return packaged;
  }
  const dev = path.join(__dirname, "go2rtc", "go2rtc.exe");
  return fs.existsSync(dev) ? dev : "";
}

function resolveFfmpegDir() {
  if (process.resourcesPath) {
    const packaged = path.join(process.resourcesPath, "backend", "ffmpeg");
    if (fs.existsSync(path.join(packaged, "ffmpeg.exe"))) return packaged;
  }
  const dev = path.join(__dirname, "ffmpeg");
  return fs.existsSync(path.join(dev, "ffmpeg.exe")) ? dev : "";
}

function runtimeConfigPath() {
  return path.join(PROGRAMDATA_ROOT, "go2rtc.runtime.json");
}

function writeRuntimeConfig(cfg) {
  fs.mkdirSync(PROGRAMDATA_ROOT, { recursive: true });
  const rtspUrl = buildRtspUrl(cfg);
  // Hikvision compatibility is a DVR-native secondary profile, not a decode /
  // re-encode of the malformed HEVC source. Channel xx02 can be prepared as
  // H.264 while xx01 remains the recorder-quality H.265 stream.
  const compatibleUrl = buildRtspUrl({ ...cfg, stream: "sub" });
  const ffmpegInputUrl = rtspUrl.replace(/\?transport=(?:tcp|udp)$/i, "");
  // Keep HEVC decoding on the stable software decoder and accelerate only the
  // H.264 encode. go2rtc's `#hardware=cuda` preset also forces CUDA decoding,
  // which stalls on this DVR's HEVC main stream even though NVENC itself works.
  // The configured DVR main profile is 12 fps. A one-second GOP reduces
  // WebRTC join/recovery delay without inventing duplicate frames.
  const commonEncode = "-r:v 12 -fps_mode cfr -g:v 12 -forced-idr 1 -bf 0 -b:v 5M -maxrate:v 6M -bufsize:v 8M";
  const h264Template = cfg.transcodeHardware === "software"
    ? `-c:v libx264 ${commonEncode} -profile:v high -level:v 5.1 -preset:v veryfast -tune:v zerolatency -pix_fmt:v yuv420p`
    : cfg.transcodeHardware === "dxva2"
      ? `-c:v h264_qsv ${commonEncode} -profile:v high -level:v 5.1 -preset:v veryfast -async_depth:v 1`
      : cfg.transcodeHardware === "amf"
        ? `-c:v h264_amf ${commonEncode} -profile:v high -level:v auto -quality speed`
        : `-c:v h264_nvenc ${commonEncode} -profile:v high -level:v auto -preset:v p2 -tune:v ll`;
  const browserUrl = `ffmpeg:${ffmpegInputUrl}#video=h264`;
  const doc = {
    streams: {
      [STREAM_DIRECT]: [rtspUrl],
      [STREAM_BROWSER]: [browserUrl],
      [STREAM_COMPAT]: [compatibleUrl],
    },
    // The dashboard is served from localhost:3500 while this isolated player
    // listens only on loopback:1994. Allow that cross-origin WebSocket handshake.
    api: { listen: `${API_HOST}:${API_PORT}`, origin: "*" },
    rtsp: { listen: `${API_HOST}:${RTSP_PORT}` },
    webrtc: { listen: `${API_HOST}:${WEBRTC_PORT}` },
    ffmpeg: {
      // The DVR's HEVC stream does not tolerate go2rtc's default
      // `-fflags nobuffer` RTSP input template. TCP without that flag is stable.
      rtsp: "-rtsp_transport tcp -timeout {timeout} -user_agent go2rtc/ffmpeg -i {input}",
      h264: h264Template,
    },
  };
  const file = runtimeConfigPath();
  fs.writeFileSync(file, JSON.stringify(doc, null, 2), { encoding: "utf8", mode: 0o600 });
  return file;
}

function requestLocal(pathname, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: API_HOST, port: API_PORT, path: pathname, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        }));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Hikvision media service timed out")));
  });
}

function md5(value) {
  return crypto.createHash("md5").update(String(value)).digest("hex");
}

function parseDigestChallenge(header) {
  const text = String(header || "").replace(/^Digest\s+/i, "");
  const out = {};
  const re = /(\w+)=(?:"([^"]*)"|([^,\s]+))/g;
  let match;
  while ((match = re.exec(text))) out[match[1].toLowerCase()] = match[2] ?? match[3];
  return out;
}

function isapiRequestOnce(cfg, method, pathname, body, authorization = "") {
  return new Promise((resolve, reject) => {
    const headers = { Accept: "application/xml" };
    if (authorization) headers.Authorization = authorization;
    if (body != null) {
      headers["Content-Type"] = "application/xml; charset=utf-8";
      headers["Content-Length"] = Buffer.byteLength(body);
    }
    const req = http.request(
      {
        host: cfg.host,
        port: Number(cfg.httpPort || 80),
        method,
        path: pathname,
        headers,
        agent: isapiAgent,
        timeout: 6000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const rawBody = Buffer.concat(chunks);
          resolve({
            statusCode: res.statusCode || 0,
            headers: res.headers,
            rawBody,
            body: rawBody.toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Hikvision ISAPI request timed out")));
    if (body != null) req.write(body);
    req.end();
  });
}

async function isapiRequest(configRaw, method, pathname, body = null) {
  const cfg = sanitizeConfig(configRaw);
  const cacheKey = `${cfg.host}:${cfg.httpPort || 80}:${cfg.username}`;
  const cachedChallenge = digestCache.get(cacheKey);
  if (cachedChallenge) {
    const cached = await isapiRequestWithDigest(cfg, method, pathname, body, cachedChallenge);
    if (cached.statusCode !== 401) return cached;
    digestCache.delete(cacheKey);
  }
  const first = await isapiRequestOnce(cfg, method, pathname, body);
  if (first.statusCode !== 401) return first;
  const challenge = parseDigestChallenge(first.headers["www-authenticate"]);
  if (!challenge.realm || !challenge.nonce) throw new Error("DVR did not provide a valid Digest challenge");
  digestCache.set(cacheKey, challenge);
  return isapiRequestWithDigest(cfg, method, pathname, body, challenge);
}

function isapiRequestWithDigest(cfg, method, pathname, body, challenge) {
  const uri = pathname;
  const ha1 = md5(`${cfg.username}:${challenge.realm}:${cfg.password}`);
  const ha2 = md5(`${method}:${uri}`);
  const qop = String(challenge.qop || "").split(",")[0].trim();
  const nc = "00000001";
  const cnonce = crypto.randomBytes(8).toString("hex");
  const response = qop
    ? md5(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${challenge.nonce}:${ha2}`);
  const parts = [
    `username="${cfg.username.replace(/["\\]/g, "")}"`,
    `realm="${challenge.realm}"`,
    `nonce="${challenge.nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`,
    `algorithm=${challenge.algorithm || "MD5"}`,
  ];
  if (challenge.opaque) parts.push(`opaque="${challenge.opaque}"`);
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  return isapiRequestOnce(cfg, method, pathname, body, `Digest ${parts.join(", ")}`);
}

async function getStreamProfile(configRaw, suffix) {
  const cfg = sanitizeConfig(configRaw);
  const channelId = `${cfg.channel}${suffix}`;
  const r = await isapiRequest(cfg, "GET", `/ISAPI/Streaming/channels/${channelId}`);
  if (r.statusCode !== 200) throw new Error(`DVR profile read failed (HTTP ${r.statusCode})`);
  const value = (name) => {
    const match = r.body.match(new RegExp(`<${name}>([^<]*)</${name}>`, "i"));
    return match ? match[1].trim() : "";
  };
  return {
    channelId,
    codec: value("videoCodecType"),
    width: Number(value("videoResolutionWidth")) || null,
    height: Number(value("videoResolutionHeight")) || null,
    frameRateRaw: Number(value("maxFrameRate")) || null,
    xml: r.body,
  };
}

function getMainstreamProfile(configRaw) {
  return getStreamProfile(configRaw, "01");
}

function getSubstreamProfile(configRaw) {
  return getStreamProfile(configRaw, "02");
}

async function optimizeSubstream(configRaw) {
  const cfg = sanitizeConfig(configRaw);
  const profile = await getSubstreamProfile(cfg);
  if (/^H\.264$/i.test(profile.codec)) {
    return { ok: true, already: true, ...profile, xml: undefined };
  }
  const xml = profile.xml.replace(
    /<videoCodecType>[^<]*<\/videoCodecType>/i,
    "<videoCodecType>H.264</videoCodecType>",
  )
    .replace(/<vbrUpperCap>[^<]*<\/vbrUpperCap>/i, "<vbrUpperCap>1024</vbrUpperCap>")
    .replace(
      /<Audio>[\s\S]*?<enabled>[^<]*<\/enabled>/i,
      (audio) => audio.replace(/<enabled>[^<]*<\/enabled>/i, "<enabled>false</enabled>"),
    );
  if (xml === profile.xml) throw new Error("DVR profile did not contain a writable video codec field");
  const r = await isapiRequest(cfg, "PUT", `/ISAPI/Streaming/channels/${profile.channelId}`, xml);
  if (r.statusCode < 200 || r.statusCode >= 300) {
    throw new Error(`DVR rejected the H.264 substream update (HTTP ${r.statusCode})`);
  }
  const verified = await getSubstreamProfile(cfg);
  if (!/^H\.264$/i.test(verified.codec)) throw new Error("DVR accepted the update but the substream is still not H.264");
  return { ok: true, changed: true, ...verified, xml: undefined };
}

async function getSnapshot(configRaw) {
  const cfg = sanitizeConfig(configRaw);
  const channelId = `${cfg.channel}02`;
  // This DVR family defaults snapshots to 704x576 even when the video profile
  // is larger. Supplying a supported HD request makes it return 1920x1088.
  const picturePath = `/ISAPI/Streaming/channels/${channelId}/picture` +
    "?videoResolutionWidth=1920&videoResolutionHeight=1080";
  const r = await isapiRequest(cfg, "GET", picturePath);
  const contentType = String(r.headers["content-type"] || "").toLowerCase();
  if (r.statusCode !== 200 || !contentType.includes("image/jpeg") || !r.rawBody?.length) {
    throw new Error(`DVR snapshot failed (HTTP ${r.statusCode})`);
  }
  return { channelId, contentType: "image/jpeg", body: r.rawBody };
}

async function waitUntilReady() {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const r = await requestLocal("/api/streams", 1000);
      if (r.statusCode > 0 && r.statusCode < 500 && await isPortListening(RTSP_PORT)) return true;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function startHealthLoop() {
  stopHealthLoop();
  healthTimer = setInterval(async () => {
    if (!child || child.exitCode !== null) return;
    try {
      const r = await requestLocal("/api/streams", 1500);
      if (r.statusCode > 0 && r.statusCode < 500) {
        lastHealthTs = Date.now();
        status = "running";
      }
    } catch (_) {}
  }, HEALTH_INTERVAL_MS);
  if (healthTimer.unref) healthTimer.unref();
}

function stopHealthLoop() {
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = null;
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, API_HOST, () => server.close(() => resolve(true)));
  });
}

function isPortListening(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: API_HOST, port });
    let settled = false;
    const finish = (listening) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function terminateProcessTree(proc) {
  if (!proc || !Number.isInteger(proc.pid) || proc.pid <= 0) return;
  if (process.platform !== "win32") {
    try { proc.kill("SIGKILL"); } catch (_) {}
    return;
  }
  // go2rtc starts FFmpeg as its own child. Killing only the parent leaves the
  // transcoder attached to the DVR/GPU, so terminate this exact PID tree.
  try {
    const killer = spawn("taskkill.exe", ["/PID", String(proc.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.once("error", () => {
      try { proc.kill("SIGKILL"); } catch (_) {}
    });
  } catch (_) {
    try { proc.kill("SIGKILL"); } catch (_) {}
  }
}

async function performStart(cfg) {
  if (!cfg.enabled) return { ok: false, error: "Hikvision camera is disabled" };
  if (!cfg.password) return { ok: false, error: "Hikvision DVR password is not configured" };
  const exe = resolveGo2rtcPath();
  if (!exe) return { ok: false, error: "Bundled go2rtc binary not found" };
  if (!(await isPortFree(API_PORT))) return { ok: false, error: `Hikvision media port ${API_PORT} is already in use` };
  if (!(await isPortFree(RTSP_PORT))) return { ok: false, error: `Hikvision internal RTSP port ${RTSP_PORT} is already in use` };
  if (!(await isPortFree(WEBRTC_PORT))) return { ok: false, error: `Hikvision WebRTC port ${WEBRTC_PORT} is already in use` };

  const configPath = writeRuntimeConfig(cfg);
  const ffmpegDir = resolveFfmpegDir();
  const env = { ...process.env };
  if (ffmpegDir) env.PATH = `${ffmpegDir};${env.PATH || ""}`;
  status = "starting";
  stopping = false;
  activeConfig = cfg;
  child = spawn(exe, ["-config", configPath], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env,
  });
  child.stdout.on("data", (data) => {
    const line = String(data).trim();
    if (line && (process.env.ADSI_HIK_DEBUG === "1" || /error|warn/i.test(line))) {
      console.warn("[hikvision] go2rtc:", line.replace(/rtsp:\/\/\S+@/g, "rtsp://[redacted]@"));
    }
  });
  child.stderr.on("data", (data) => {
    const line = String(data).trim();
    if (line && (process.env.ADSI_HIK_DEBUG === "1" || /error|warn/i.test(line))) {
      console.warn("[hikvision] go2rtc:", line.replace(/rtsp:\/\/\S+@/g, "rtsp://[redacted]@"));
    }
  });
  child.once("error", (err) => {
    console.warn("[hikvision] media process error:", err.message);
    status = "error";
    child = null;
  });
  child.once("exit", (code) => {
    if (!stopping) {
      crashCount += 1;
      status = "error";
      console.warn(`[hikvision] media process exited (${code})`);
    }
    child = null;
    stopHealthLoop();
  });

  const ready = await waitUntilReady();
  if (!ready) {
    await stop();
    status = "error";
    return { ok: false, error: "Hikvision media service did not become ready" };
  }
  status = "running";
  lastHealthTs = Date.now();
  startHealthLoop();
  return { ok: true, pid: child?.pid || null, ...getStatus() };
}

function start(configRaw) {
  const cfg = sanitizeConfig(configRaw);
  // The card, settings status, and an explicit Retry can request startup at
  // nearly the same time. Every caller must await the same readiness check;
  // seeing a spawned child process is not enough because its API may not be
  // listening yet.
  if (startPromise) return startPromise;
  if (child && child.exitCode === null) {
    return Promise.resolve({ ok: true, already: true, pid: child.pid, ...getStatus() });
  }
  const operation = performStart(cfg);
  const wrapped = operation.finally(() => {
    if (startPromise === wrapped) startPromise = null;
  });
  startPromise = wrapped;
  return wrapped;
}

function stop() {
  return new Promise((resolve) => {
    stopping = true;
    stopHealthLoop();
    if (!child || child.exitCode !== null) {
      child = null;
      status = "stopped";
      resolve();
      return;
    }
    const proc = child;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      child = null;
      status = "stopped";
      resolve();
    };
    const timer = setTimeout(() => {
      terminateProcessTree(proc);
      finish();
    }, STOP_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    proc.once("exit", () => {
      clearTimeout(timer);
      finish();
    });
    if (process.platform === "win32") {
      terminateProcessTree(proc);
    } else {
      try { proc.kill("SIGTERM"); } catch (_) { clearTimeout(timer); finish(); }
    }
  });
}

async function restart(configRaw) {
  await stop();
  return start(configRaw);
}

function selectedStream(configRaw = activeConfig) {
  const cfg = sanitizeConfig(configRaw || {});
  if (cfg.playbackMode === "compatible" || cfg.stream === "sub") return STREAM_COMPAT;
  if (cfg.playbackMode === "hls") return STREAM_DIRECT;
  return STREAM_BROWSER;
}

function getStatus() {
  return {
    status,
    running: Boolean(child && child.exitCode === null),
    pid: child && child.exitCode === null ? child.pid : null,
    crashCount,
    lastHealthTs,
    apiPort: API_PORT,
    rtspPort: RTSP_PORT,
    webrtcPort: WEBRTC_PORT,
    selectedStream: selectedStream(),
    config: sanitizeConfig(activeConfig || {}, { redact: true }),
  };
}

async function test(configRaw) {
  const cfg = sanitizeConfig(configRaw);
  const started = child && child.exitCode === null
    ? { ok: true, already: true }
    : await start(cfg);
  if (!started.ok) return started;
  const streamName = selectedStream(cfg);
  try {
    const r = await requestLocal(`/api/stream.m3u8?src=${encodeURIComponent(streamName)}`, 8000);
    const body = r.body.toString("utf8");
    const codec = (body.match(/CODECS="([^"]+)/i) || [])[1] || "unknown";
    return {
      ok: r.statusCode === 200 && body.includes("#EXTM3U"),
      reachable: true,
      stream: cfg.stream,
      channel: cfg.channel,
      codec,
      playbackMode: cfg.playbackMode,
      statusCode: r.statusCode,
    };
  } catch (err) {
    return { ok: false, reachable: false, error: err.message };
  }
}

function rewriteHikvisionPlaylist(text) {
  return String(text || "").replace(
    /\/api\/hls\//g,
    "/api/hikvision/hls/hls/",
  );
}

function proxyMedia(req, res, configRaw) {
  const requestedMode = cleanText(req.query?.mode, 20).toLowerCase();
  const cfg = sanitizeConfig({
    ...(configRaw || activeConfig || {}),
    ...(["browser", "compatible", "hls"].includes(requestedMode)
      ? { playbackMode: requestedMode }
      : {}),
  });
  const suffix = String(req.params?.[0] || "master.m3u8").replace(/^\/+/, "");
  let upstreamPath;
  if (suffix === "master.m3u8") {
    // go2rtc 1.9.x MPEG-TS HLS can expose video-only TS fragments without
    // transport program tables, which hls.js rejects as fragParsingError.
    // Its official fragmented-MP4 HLS output supplies an init segment and
    // standards-compliant .m4s fragments that Chromium can append directly.
    upstreamPath = `/api/stream.m3u8?src=${encodeURIComponent(selectedStream(cfg))}&mp4`;
  } else if (suffix.startsWith("hls/")) {
    upstreamPath = `/api/${suffix}${req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""}`;
  } else if (/\.(?:m3u8|m4s|mp4|ts)(?:\?|$)/i.test(suffix)) {
    upstreamPath = `/api/hls/${suffix}${req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""}`;
  } else {
    return res.status(404).end();
  }
  const upstream = http.get(
    { host: API_HOST, port: API_PORT, path: upstreamPath, timeout: 10000 },
    (mediaRes) => {
      const isPlaylist = /\.m3u8(?:\?|$)/i.test(upstreamPath);
      res.status(mediaRes.statusCode || 502);
      for (const name of ["content-type", "cache-control"]) {
        if (mediaRes.headers[name]) res.set(name, mediaRes.headers[name]);
      }
      res.set("Cache-Control", "no-store");
      if (!isPlaylist) {
        if (mediaRes.headers["content-length"]) res.set("Content-Length", mediaRes.headers["content-length"]);
        mediaRes.pipe(res);
        return;
      }
      const chunks = [];
      mediaRes.on("data", (chunk) => chunks.push(chunk));
      mediaRes.on("end", () => {
        // go2rtc emits absolute child-playlist and segment paths under
        // /api/hls/*. Keep every hop inside this authenticated dashboard
        // route; otherwise Remote mode asks Express for /api/hls/* and Hls.js
        // receives the dashboard HTML instead of an HLS manifest.
        const playlist = rewriteHikvisionPlaylist(Buffer.concat(chunks).toString("utf8"));
        res.set("Content-Length", String(Buffer.byteLength(playlist)));
        res.send(playlist);
      });
    },
  );
  upstream.on("timeout", () => upstream.destroy(new Error("Hikvision media proxy timed out")));
  upstream.on("error", (err) => {
    if (!res.headersSent) res.status(502).json({ ok: false, error: err.message });
    else res.end();
  });
  res.on("close", () => {
    if (!res.writableEnded) upstream.destroy();
  });
}

module.exports = {
  defaults,
  loadLocalConfigFallback,
  sanitizeConfig,
  buildRtspUrl,
  start,
  stop,
  restart,
  test,
  getMainstreamProfile,
  getSubstreamProfile,
  getSnapshot,
  optimizeSubstream,
  getStatus,
  proxyMedia,
  __test: { rewriteHikvisionPlaylist },
};
