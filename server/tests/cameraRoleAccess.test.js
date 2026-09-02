"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const serverCode = fs.readFileSync(path.resolve(__dirname, "../index.js"), "utf8");

const match = serverCode.match(/const DEVELOPER_API_PREFIXES = [\s\S]*?function isDeveloperOnlyApiRequest\(req\) \{([\s\S]*?)\n\}/);
assert(match, "must find isDeveloperOnlyApiRequest and prefix definitions in server/index.js");

const OPERATOR_SHARED_SETTINGS_KEYS = new Set([
  "plantName",
  "operatorName",
  "inverterCount",
  "nodeCount",
  "invGridLayout",
  "plantLatitude",
  "plantLongitude",
  "exportUiState",
]);

const fnCode = match[0];
const evaluateRoute = new Function(
  "req",
  `${fnCode}; return isDeveloperOnlyApiRequest(req);`
);

function test() {
  const operatorRoutes = [
    { url: "/api/hikvision/config", method: "GET" },
    { url: "/api/hikvision/status", method: "GET" },
    { url: "/api/hikvision/snapshot", method: "GET" },
    { url: "/api/hikvision/hls/master.m3u8?mode=compatible", method: "GET" },
    { url: "/api/hikvision/hls/playlist.m3u8?id=abc", method: "GET" },
    { url: "/api/hikvision/hls/segment.m4s?id=abc&n=0", method: "GET" },
    { url: "/api/hikvision/hls/init.mp4?id=abc", method: "GET" },
    { url: "/api/hikvision/start", method: "POST" },
    { url: "/api/hikvision/stop", method: "POST" },
    { url: "/api/streaming/go2rtc-status", method: "GET" },
    { url: "/api/streaming/go2rtc/start", method: "POST" },
    { url: "/api/streaming/go2rtc/stop", method: "POST" },
  ];

  for (const r of operatorRoutes) {
    const isDevOnly = evaluateRoute(r);
    assert.strictEqual(
      isDevOnly,
      false,
      `Operator route ${r.method} ${r.url} should NOT be developer-only (got isDevOnly=${isDevOnly})`
    );
  }

  const developerRoutes = [
    { url: "/api/hikvision/config", method: "POST" },
    { url: "/api/hikvision/test", method: "POST" },
    { url: "/api/hikvision/substream-profile", method: "GET" },
    { url: "/api/hikvision/substream-profile", method: "POST" },
    { url: "/api/hikvision/optimize-substream", method: "POST" },
    { url: "/api/hikvision/route-status", method: "POST" },
    { url: "/api/streaming/config", method: "POST" },
    { url: "/api/server/start", method: "POST" },
    { url: "/api/server/stop", method: "POST" },
    { url: "/api/backup/download", method: "GET" },
    { url: "/api/ip-config", method: "POST" },
  ];

  for (const r of developerRoutes) {
    const isDevOnly = evaluateRoute(r);
    assert.strictEqual(
      isDevOnly,
      true,
      `Developer admin route ${r.method} ${r.url} MUST be developer-only (got isDevOnly=${isDevOnly})`
    );
  }

  console.log("cameraRoleAccess.test.js: PASS");
}

test();
