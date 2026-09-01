"use strict";

const assert = require("assert");
const http = require("http");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run() {
  const testPort = Number(process.env.GO2RTC_API_PORT || 1984);
  process.env.GO2RTC_API_PORT = String(testPort);
  const external = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  await new Promise((resolve, reject) => {
    external.once("error", (err) => {
      if (err.code === "EACCES" || err.code === "EADDRINUSE") {
        const fallbackPort = 11984;
        process.env.GO2RTC_API_PORT = String(fallbackPort);
        external.listen(fallbackPort, "127.0.0.1", resolve);
      } else {
        reject(err);
      }
    });
    external.listen(testPort, "127.0.0.1", resolve);
  });

  try {
    const manager = require("../go2rtcManager");
    await wait(1800);
    const status = manager.getStatus();
    assert.equal(status.running, true);
    assert.equal(status.managedExternally, true);

    const stopResult = await manager.stop();
    assert.equal(stopResult.ok, false);
    assert.equal(stopResult.managedExternally, true);
    assert.match(stopResult.error, /managed by systemd/);
    assert.equal(manager.getStatus().running, true, "refused stop must not report the external service stopped");
  } finally {
    await new Promise((resolve) => external.close(resolve));
  }

  console.log("go2rtcExternalLifecycle.test.js: PASS");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
