"use strict";

const assert = require("assert");
const hikvision = require("../hikvisionManager");

const defaults = hikvision.sanitizeConfig({});
assert.strictEqual(defaults.host, "192.168.1.12");
assert.strictEqual(defaults.rtspPort, "554");
assert.strictEqual(defaults.channel, "1");
assert.strictEqual(defaults.stream, "main");
assert.strictEqual(defaults.playbackMode, "localservice");
assert.strictEqual(defaults.transcodeHardware, "cuda");

const main = hikvision.sanitizeConfig({
  host: "192.168.1.12<script>",
  rtspPort: 99999,
  channel: 99,
  stream: "main",
  username: "admin",
  password: "secret!",
  playbackMode: "native",
});
assert.strictEqual(main.host, "192.168.1.12script");
assert.strictEqual(main.rtspPort, "554");
assert.strictEqual(main.channel, "32");
assert.strictEqual(main.stream, "main");
assert.strictEqual(main.playbackMode, "localservice");
assert.match(hikvision.buildRtspUrl(main), /\/Streaming\/Channels\/3201\?transport=tcp$/);

const browser = hikvision.sanitizeConfig({ playbackMode: "browser", transcodeHardware: "dxva2" });
assert.strictEqual(browser.playbackMode, "localservice");
assert.strictEqual(browser.transcodeHardware, "dxva2");

const legacy = hikvision.sanitizeConfig({ playbackMode: "localservice" });
assert.strictEqual(legacy.playbackMode, "localservice");

const redacted = hikvision.sanitizeConfig(main, { redact: true });
assert.strictEqual(redacted.password, undefined);
assert.strictEqual(redacted.passwordConfigured, true);

console.log("hikvisionManager.test.js: ok");
