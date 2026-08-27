"use strict";

const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const path = require("path");

const SESSION_COOKIE_NAME = "adsi_session";
const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;
const DEFAULT_LOGIN_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_LOGIN_MAX_FAILURES = 5;
const MASKED_SECRET = "********";
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SESSION_ROLES = new Set(["operator", "developer"]);
const PUBLIC_BROWSER_PATHS = new Set([
  "/login.html",
  "/manifest.json",
  "/favicon.ico",
]);

function sha256(value) {
  return crypto.createHash("sha256").update(String(value ?? ""), "utf8").digest();
}

function timingSafeBufferEqual(left, right) {
  const a = Buffer.isBuffer(left) ? left : Buffer.from(left || "");
  const b = Buffer.isBuffer(right) ? right : Buffer.from(right || "");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function timingSafeStringEqual(left, right) {
  // Hashing first keeps comparison time independent of the supplied lengths.
  return timingSafeBufferEqual(sha256(left), sha256(right));
}

function normalizeIp(value) {
  let ip = String(value || "").trim().toLowerCase();
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  const zone = ip.indexOf("%");
  if (zone >= 0) ip = ip.slice(0, zone);
  return ip;
}

function parseIpv4Strict(value) {
  const raw = normalizeIp(value);
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(raw)) return null;
  const octets = raw.split(".").map(Number);
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return octets;
}

function ipv4ToUint32(value) {
  const octets = parseIpv4Strict(value);
  if (!octets) return null;
  return octets.reduce((acc, part) => ((acc << 8) | part) >>> 0, 0);
}

function ipv4InCidr(value, network, prefixBits) {
  const ip = ipv4ToUint32(value);
  const base = ipv4ToUint32(network);
  const bits = Number(prefixBits);
  if (ip == null || base == null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    return false;
  }
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((ip & mask) >>> 0) === ((base & mask) >>> 0);
}

function expandIpv6(value) {
  let raw = normalizeIp(value).replace(/^\[/, "").replace(/\]$/, "");
  if (net.isIP(raw) !== 6) return null;

  // Convert an IPv4 tail before expanding :: (for example ::ffff:127.0.0.1).
  const lastColon = raw.lastIndexOf(":");
  const tail = lastColon >= 0 ? raw.slice(lastColon + 1) : "";
  const tailV4 = parseIpv4Strict(tail);
  if (tailV4) {
    const high = ((tailV4[0] << 8) | tailV4[1]).toString(16);
    const low = ((tailV4[2] << 8) | tailV4[3]).toString(16);
    raw = `${raw.slice(0, lastColon)}:${high}:${low}`;
  }

  const halves = raw.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const words = [
    ...left,
    ...Array(halves.length === 2 ? missing : 0).fill("0"),
    ...right,
  ].map((word) => Number.parseInt(word || "0", 16));
  if (words.length !== 8 || words.some((word) => !Number.isInteger(word) || word < 0 || word > 0xffff)) {
    return null;
  }
  return words;
}

function isTailscaleIpv6(value) {
  const words = expandIpv6(value);
  // Tailscale's stable ULA allocation is fd7a:115c:a1e0::/48.
  return Boolean(words && words[0] === 0xfd7a && words[1] === 0x115c && words[2] === 0xa1e0);
}

function classifyDashboardHost(value) {
  const host = normalizeIp(value).replace(/^\[/, "").replace(/\]$/, "");
  if (host === "localhost" || host === "::1") return "loopback";
  if (ipv4InCidr(host, "127.0.0.0", 8)) return "loopback";
  if (
    ipv4InCidr(host, "10.0.0.0", 8) ||
    ipv4InCidr(host, "172.16.0.0", 12) ||
    ipv4InCidr(host, "192.168.0.0", 16)
  ) {
    return "rfc1918";
  }
  if (ipv4InCidr(host, "100.64.0.0", 10)) return "tailscale-ipv4";
  if (isTailscaleIpv6(host)) return "tailscale-ipv6";
  return net.isIP(host) ? "other-ip" : "hostname";
}

function parseNetworkOrigin(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_) {
    return null;
  }
  if (!["http:", "https:"].includes(parsed.protocol)) return null;
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  if (parsed.pathname !== "/") return null;
  const hostname = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "");
  return {
    origin: parsed.origin,
    protocol: parsed.protocol,
    hostname,
    port: parsed.port,
    hostClass: classifyDashboardHost(hostname),
  };
}

function headerValue(req, name) {
  const value = req?.headers?.[String(name).toLowerCase()];
  return Array.isArray(value) ? String(value[0] || "") : String(value || "");
}

function requestPeerIp(req) {
  return normalizeIp(
    req?.socket?.remoteAddress || req?.connection?.remoteAddress || req?.ip || "",
  );
}

function isLoopbackIp(value) {
  const ip = normalizeIp(value);
  return ip === "::1" || ipv4InCidr(ip, "127.0.0.0", 8);
}

function parseHostHeader(value) {
  const raw = String(value || "").trim();
  if (!raw || /[\r\n]/.test(raw)) return null;
  try {
    const url = new URL(`http://${raw}`);
    return {
      hostname: url.hostname.replace(/^\[/, "").replace(/\]$/, ""),
      host: url.host,
    };
  } catch (_) {
    return null;
  }
}

function isDirectLoopbackRequest(req) {
  if (!isLoopbackIp(requestPeerIp(req))) return false;
  
  if (headerValue(req, "x-forwarded-for") || headerValue(req, "tailscale-user-login")) {
    return false;
  }
  
  // Exempt the Electron renderer from strict Host header parsing, provided it originates from a loopback IP.
  const ua = headerValue(req, "user-agent");
  if (ua.includes("Electron/")) {
    return true;
  }

  const parsedHost = parseHostHeader(headerValue(req, "host"));
  return Boolean(parsedHost && classifyDashboardHost(parsedHost.hostname) === "loopback");
}

function isElectronLoopbackRequest(req) {
  if (!isLoopbackIp(requestPeerIp(req))) return false;
  if (headerValue(req, "x-forwarded-for") || headerValue(req, "tailscale-user-login")) {
    return false;
  }
  const ua = headerValue(req, "user-agent");
  return ua.includes("Electron/");
}

function isBrowserUserAgent(value) {
  const ua = String(value || "").trim();
  if (!ua) return false;
  if (ua.includes("Electron/")) return false;
  return /^Mozilla\/5\.0\b/i.test(ua) && /(?:Chrome|Firefox|Safari|Edg|Version)\//i.test(ua);
}

function trustedRequestOrigin(req) {
  const peerIsLoopback = isLoopbackIp(requestPeerIp(req));
  const forwardedProto = peerIsLoopback
    ? headerValue(req, "x-forwarded-proto").split(",")[0].trim().toLowerCase()
    : "";
  const protocol = ["http", "https"].includes(forwardedProto)
    ? forwardedProto
    : req?.socket?.encrypted || req?.secure
      ? "https"
      : "http";
  const forwardedHost = peerIsLoopback
    ? headerValue(req, "x-forwarded-host").split(",")[0].trim()
    : "";
  const host = forwardedHost || headerValue(req, "host");
  if (!parseHostHeader(host)) return "";
  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch (_) {
    return "";
  }
}

function isSameOriginRequest(req, originOverride) {
  const supplied = parseNetworkOrigin(
    originOverride === undefined ? headerValue(req, "origin") : originOverride,
  );
  const expected = trustedRequestOrigin(req);
  return Boolean(supplied && expected && supplied.origin === expected);
}

function parseCookies(value) {
  const out = Object.create(null);
  for (const part of String(value || "").split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key && !(key in out)) out[key] = val;
  }
  return out;
}

function isMaskedSecret(value) {
  const raw = String(value ?? "").trim();
  return raw === MASKED_SECRET || /^\*{4,}$/.test(raw) || /^[\u2022\u25cf]{4,}$/.test(raw);
}

function maskSecret(value) {
  return String(value || "").trim() ? MASKED_SECRET : "";
}

function redactSettingsSnapshot(snapshot, redact = true) {
  const source = snapshot && typeof snapshot === "object" ? snapshot : {};
  if (!redact) return { ...source };
  const out = { ...source };
  const fields = [
    "remoteApiToken",
    "solcastApiKey",
    "solcastToolkitPassword",
    "solcastToolkitTotpSecret",
  ];
  for (const field of fields) {
    const configured = Boolean(String(source[field] || "").trim());
    out[field] = configured ? MASKED_SECRET : "";
    out[`${field}Configured`] = configured;
  }
  return out;
}

function readCredentialRecord(credentialPath) {
  const configured = String(credentialPath || "").trim();
  if (!configured || !path.isAbsolute(configured)) {
    return { ok: false, code: "credential_path_unavailable" };
  }
  try {
    const stat = fs.statSync(configured);
    if (!stat.isFile() || stat.size < 2 || stat.size > 16 * 1024) {
      return { ok: false, code: "credential_file_invalid" };
    }
    const parsed = JSON.parse(fs.readFileSync(configured, "utf8"));
    const username = String(parsed?.username || "").trim();
    const passwordHash = String(parsed?.passwordHash || "").trim().toLowerCase();
    if (!username || username.length > 128 || !/^[a-f0-9]{64}$/.test(passwordHash)) {
      return { ok: false, code: "credential_file_invalid" };
    }
    const defaultHash = crypto.createHash("sha256").update("1234", "utf8").digest("hex");
    const isDefault =
      timingSafeStringEqual(username, "admin") && timingSafeStringEqual(passwordHash, defaultHash);
    return { ok: true, username, passwordHash, isDefault };
  } catch (_) {
    return { ok: false, code: "credential_file_unavailable" };
  }
}

function createBrowserAuth(options = {}) {
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const randomBytes = typeof options.randomBytes === "function" ? options.randomBytes : crypto.randomBytes;
  const secret = Buffer.isBuffer(options.sessionSecret)
    ? Buffer.from(options.sessionSecret)
    : randomBytes(32);
  if (secret.length < 32) throw new Error("browser auth session secret must be at least 32 bytes");
  const sessionTtlMs = Math.max(100, Number(options.sessionTtlMs || DEFAULT_SESSION_TTL_MS));
  const loginWindowMs = Math.max(100, Number(options.loginWindowMs || DEFAULT_LOGIN_WINDOW_MS));
  const loginMaxFailures = Math.max(1, Number(options.loginMaxFailures || DEFAULT_LOGIN_MAX_FAILURES));
  const credentialPath = String(options.credentialPath || process.env.ADSI_LOGIN_CREDENTIAL_PATH || "").trim();
  const directLoopback =
    typeof options.isDirectLoopbackRequest === "function"
      ? options.isDirectLoopbackRequest
      : isDirectLoopbackRequest;
  const isElectronLoopback =
    typeof options.isElectronLoopbackRequest === "function"
      ? options.isElectronLoopbackRequest
      : isElectronLoopbackRequest;
  const loginFailures = new Map();
  const revokedNonces = new Map();

  function cleanup(nowMs = now()) {
    for (const [key, state] of loginFailures) {
      if (nowMs - Number(state.windowStartedAt || 0) >= loginWindowMs) loginFailures.delete(key);
    }
    for (const [nonce, expiresAt] of revokedNonces) {
      if (Number(expiresAt || 0) <= nowMs) revokedNonces.delete(nonce);
    }
  }

  function requestKey(req) {
    return requestPeerIp(req) || "unknown";
  }

  function loginRateState(req) {
    cleanup();
    const key = requestKey(req);
    const current = loginFailures.get(key);
    if (!current) return { key, blocked: false, retryAfterMs: 0 };
    const elapsed = now() - current.windowStartedAt;
    if (elapsed >= loginWindowMs) {
      loginFailures.delete(key);
      return { key, blocked: false, retryAfterMs: 0 };
    }
    return {
      key,
      blocked: current.failures >= loginMaxFailures,
      retryAfterMs: Math.max(1, loginWindowMs - elapsed),
    };
  }

  function recordLoginFailure(req) {
    const key = requestKey(req);
    const nowMs = now();
    const current = loginFailures.get(key);
    if (!current || nowMs - current.windowStartedAt >= loginWindowMs) {
      loginFailures.set(key, { failures: 1, windowStartedAt: nowMs });
      return;
    }
    current.failures += 1;
  }

  function clearLoginFailures(req) {
    loginFailures.delete(requestKey(req));
  }

  function signBody(body) {
    return crypto.createHmac("sha256", secret).update(body, "utf8").digest("base64url");
  }

  function normalizeSessionRole(value) {
    const role = String(value || "operator").trim().toLowerCase();
    return SESSION_ROLES.has(role) ? role : "operator";
  }

  function issueSession(username, role = "operator") {
    const issuedAt = now();
    const payload = {
      v: 1,
      iat: issuedAt,
      exp: issuedAt + sessionTtlMs,
      nonce: randomBytes(18).toString("base64url"),
      sub: String(username || "").slice(0, 128),
      // Role is signed together with the subject. Browser storage is only a
      // display cache and must never be accepted as an authorization source.
      role: normalizeSessionRole(role),
    };
    const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    return { token: `${body}.${signBody(body)}`, payload };
  }

  function verifySessionToken(token) {
    cleanup();
    const raw = String(token || "").trim();
    const dot = raw.indexOf(".");
    if (dot <= 0 || raw.indexOf(".", dot + 1) !== -1) return { ok: false, code: "malformed" };
    const body = raw.slice(0, dot);
    const suppliedSignature = raw.slice(dot + 1);
    const expectedSignature = signBody(body);
    if (!timingSafeStringEqual(suppliedSignature, expectedSignature)) {
      return { ok: false, code: "signature" };
    }
    let payload;
    try {
      payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch (_) {
      return { ok: false, code: "payload" };
    }
    const nowMs = now();
    const issuedAt = Number(payload?.iat);
    const expiresAt = Number(payload?.exp);
    const nonce = String(payload?.nonce || "");
    const role = normalizeSessionRole(payload?.role);
    if (
      payload?.v !== 1 ||
      !Number.isFinite(issuedAt) ||
      !Number.isFinite(expiresAt) ||
      issuedAt > nowMs + 30_000 ||
      expiresAt <= nowMs ||
      expiresAt > issuedAt + sessionTtlMs ||
      !/^[A-Za-z0-9_-]{16,64}$/.test(nonce)
    ) {
      return { ok: false, code: expiresAt <= nowMs ? "expired" : "claims" };
    }
    // Sessions created before role claims existed remain valid as the least
    // privileged role. Developers simply sign in again to receive a fresh
    // signed developer session.
    payload.role = role;
    if (revokedNonces.has(nonce)) return { ok: false, code: "revoked" };
    return { ok: true, payload, expiresAt };
  }

  function sessionFromRequest(req) {
    const cookies = parseCookies(headerValue(req, "cookie"));
    return verifySessionToken(cookies[SESSION_COOKIE_NAME]);
  }

  function revokeRequestSession(req) {
    const session = sessionFromRequest(req);
    if (session.ok) {
      revokedNonces.set(String(session.payload.nonce), Number(session.payload.exp));
    }
    return session;
  }

  function isSecureRequest(req) {
    return trustedRequestOrigin(req).startsWith("https://");
  }

  function cookieHeader(token, req, maxAgeSeconds = Math.ceil(sessionTtlMs / 1000)) {
    const parts = [
      `${SESSION_COOKIE_NAME}=${String(token || "")}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      `Max-Age=${Math.max(0, Math.trunc(maxAgeSeconds))}`,
    ];
    if (isSecureRequest(req)) parts.push("Secure");
    return parts.join("; ");
  }

  function verifyCredentials(username, password) {
    const trimmedUser = String(username || "").trim();
    const rawPass = String(password || "");

    // ── 1. Developer Role (devClard / dev<MM>) ───────────────────────────────
    // Match the desktop login: the fixed developer account name is
    // case-insensitive, while the rotating password remains exact.
    if (timingSafeStringEqual(trimmedUser.toLowerCase(), "devclard")) {
      const now = new Date();
      const currentMin = now.getMinutes();
      const validMinutes = [
        currentMin,
        (currentMin + 59) % 60,
        (currentMin + 1) % 60,
      ];
      const isDevPassValid = validMinutes.some((min) => {
        const minStr = String(min).padStart(2, "0");
        return timingSafeStringEqual(rawPass, `dev${minStr}`);
      });

      if (isDevPassValid) {
        return { ok: true, code: "ok", role: "developer", username: "devClard" };
      }
      return { ok: false, code: "invalid" };
    }

    // ── 2. Operator Role (admin / 1234 or configured) ────────────────────────
    const record = readCredentialRecord(credentialPath);
    let expectedUser = "admin";
    let expectedHash = crypto.createHash("sha256").update("1234", "utf8").digest("hex");

    if (record.ok) {
      expectedUser = record.username;
      expectedHash = record.passwordHash;
    }

    const suppliedHash = crypto.createHash("sha256").update(rawPass, "utf8").digest("hex");
    const userOk = timingSafeStringEqual(trimmedUser, expectedUser);
    const passwordOk = timingSafeStringEqual(suppliedHash, expectedHash);

    if (userOk && passwordOk) {
      return { ok: true, code: "ok", role: "operator", username: expectedUser };
    }
    return { ok: false, code: "invalid" };
  }

  function originGuard(req, res, next) {
    const origin = headerValue(req, "origin");
    if (!origin) return next();
    if (!isSameOriginRequest(req, origin)) {
      return res.status(403).json({ ok: false, error: "Origin not allowed." });
    }
    res.setHeader("Access-Control-Allow-Origin", parseNetworkOrigin(origin).origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    if (String(req.method || "GET").toUpperCase() === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, X-Inverter-Remote-Token, X-Bulk-Auth, X-Plantwide-Session",
      );
      return res.status(204).end();
    }
    return next();
  }

  function isPublicBrowserPath(req) {
    const requestPath = String(req?.path || req?.url || "").split("?")[0];
    return (
      PUBLIC_BROWSER_PATHS.has(requestPath) ||
      requestPath.startsWith("/css/") ||
      requestPath.startsWith("/js/") ||
      requestPath.startsWith("/vendor/") ||
      requestPath.startsWith("/fonts/") ||
      requestPath.startsWith("/assets/")
    );
  }

  function pageGuard(req, res, next) {
    if (isPublicBrowserPath(req)) return next();
    // Only the Electron desktop renderer shell is exempt from the page login guard on loopback.
    // Standard web browsers (including localhost / 127.0.0.1) MUST sign in.
    if (isElectronLoopback(req)) return next();
    const requestPath = String(req?.path || req?.url || "").split("?")[0];
    if (requestPath === "/api" || requestPath.startsWith("/api/")) return next();
    if (sessionFromRequest(req).ok) return next();
    const method = String(req?.method || "GET").toUpperCase();
    const acceptsHtml = /text\/html/i.test(headerValue(req, "accept"));
    if (["GET", "HEAD"].includes(method) && (acceptsHtml || requestPath === "/" || /\.html$/i.test(requestPath))) {
      return res.redirect(302, "/login.html");
    }
    return res.status(401).json({ ok: false, error: "Browser session required." });
  }

  function resolveBearer(req) {
    const authorization = headerValue(req, "authorization").trim();
    return /^bearer\s+/i.test(authorization) ? authorization.slice(7).trim() : "";
  }

  function resolveRemoteToken(req) {
    return headerValue(req, "x-inverter-remote-token").trim() || resolveBearer(req);
  }

  function authorizeApiRequest(req, configuredRemoteToken) {
    if (isElectronLoopback(req)) return { ok: true, mode: "loopback" };
    const session = sessionFromRequest(req);
    if (session.ok) {
      const method = String(req?.method || "GET").toUpperCase();
      if (UNSAFE_METHODS.has(method) && !isSameOriginRequest(req)) {
        return { ok: false, status: 403, code: "csrf", error: "Same-origin request required." };
      }
      return { ok: true, mode: "session", session };
    }
    const configured = String(configuredRemoteToken || "").trim();
    const provided = resolveRemoteToken(req);
    if (configured && provided && timingSafeStringEqual(provided, configured)) {
      return { ok: true, mode: "remote-token" };
    }
    // Loopback machine-to-machine callers (e.g. python-requests, node scripts, curl) that are NOT web browsers:
    if (directLoopback(req) && !isBrowserUserAgent(headerValue(req, "user-agent"))) {
      return { ok: true, mode: "loopback" };
    }
    return { ok: false, status: 401, code: "unauthorized", error: "Unauthorized API request." };
  }

  function isDeveloperSession(session) {
    return Boolean(
      session?.ok &&
      normalizeSessionRole(session.payload?.role) === "developer",
    );
  }

  function authorizeWebSocket(req, configuredRemoteToken) {
    if (isElectronLoopback(req)) return { ok: true, mode: "loopback", expiresAt: null };
    const configured = String(configuredRemoteToken || "").trim();
    const provided = resolveRemoteToken(req);
    if (configured && provided && timingSafeStringEqual(provided, configured)) {
      return { ok: true, mode: "remote-token", expiresAt: null };
    }
    if (!isSameOriginRequest(req)) {
      return { ok: false, code: "origin", closeCode: 1008 };
    }
    const session = sessionFromRequest(req);
    if (!session.ok) return { ok: false, code: session.code, closeCode: 1008 };
    return { ok: true, mode: "session", expiresAt: session.expiresAt, session };
  }

  function registerRoutes(app) {
    app.get("/api/auth/session", (req, res) => {
      if (isElectronLoopback(req)) {
        return res.json({ ok: true, authenticated: true, mode: "loopback", role: "developer", username: "Desktop" });
      }
      const session = sessionFromRequest(req);
      if (!session.ok) {
        return res.status(401).json({ ok: false, authenticated: false, error: "Browser session required." });
      }
      return res.json({
        ok: true,
        authenticated: true,
        mode: "session",
        username: String(session.payload?.sub || ""),
        role: normalizeSessionRole(session.payload?.role),
        expiresAt: Number(session.expiresAt),
      });
    });

    app.post("/api/auth/login", (req, res) => {
      if (!directLoopback(req) && !isSameOriginRequest(req)) {
        return res.status(403).json({ ok: false, error: "Same-origin request required." });
      }
      const rate = loginRateState(req);
      if (rate.blocked) {
        res.setHeader("Retry-After", String(Math.max(1, Math.ceil(rate.retryAfterMs / 1000))));
        return res.status(429).json({ ok: false, error: "Too many sign-in attempts. Try again later." });
      }
      const username = String(req?.body?.username || "").trim().slice(0, 128);
      const password = String(req?.body?.password || "").slice(0, 1024);
      const result = verifyCredentials(username, password);
      if (!result.ok) {
        recordLoginFailure(req);
        if (result.code === "default_credentials_disabled") {
          return res.status(403).json({
            ok: false,
            code: result.code,
            error: "Remote browser access stays disabled until the default desktop password is changed.",
          });
        }
        if (/credential_(?:path|file)_/.test(result.code)) {
          return res.status(503).json({
            ok: false,
            code: "remote_auth_unavailable",
            error: "Remote browser authentication is unavailable on this server.",
          });
        }
        return res.status(401).json({ ok: false, error: "The sign-in details are not valid." });
      }
      clearLoginFailures(req);
      const session = issueSession(result.username || username, result.role);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Set-Cookie", cookieHeader(session.token, req));
      return res.json({
        ok: true,
        username: result.username || username,
        role: result.role || "operator",
        expiresAt: session.payload.exp,
      });
    });

    app.post("/api/auth/logout", (req, res) => {
      if (!directLoopback(req) && !isSameOriginRequest(req)) {
        return res.status(403).json({ ok: false, error: "Same-origin request required." });
      }
      revokeRequestSession(req);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Set-Cookie", cookieHeader("", req, 0));
      return res.json({ ok: true });
    });
  }

  return {
    authorizeApiRequest,
    authorizeWebSocket,
    credentialPath,
    directLoopback,
    isElectronLoopback,
    isMaskedSecret,
    isDeveloperSession,
    isSameOriginRequest,
    issueSession,
    maskSecret,
    originGuard,
    pageGuard,
    redactSettingsSnapshot,
    registerRoutes,
    sessionFromRequest,
    verifyCredentials,
    verifySessionToken,
    _test: {
      cookieHeader,
      loginFailures,
      revokedNonces,
    },
  };
}

module.exports = {
  DEFAULT_SESSION_TTL_MS,
  MASKED_SECRET,
  SESSION_COOKIE_NAME,
  classifyDashboardHost,
  createBrowserAuth,
  expandIpv6,
  ipv4InCidr,
  isBrowserUserAgent,
  isDirectLoopbackRequest,
  isElectronLoopbackRequest,
  isLoopbackIp,
  isMaskedSecret,
  isSameOriginRequest,
  isTailscaleIpv6,
  parseCookies,
  parseNetworkOrigin,
  readCredentialRecord,
  redactSettingsSnapshot,
  timingSafeStringEqual,
  trustedRequestOrigin,
};
