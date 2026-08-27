"use strict";

const assert = require("assert");
const http = require("http");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run() {
  const external = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  await new Promise((resolve, reject) => {
    external.once("error", reject);
    external.listen(1984, "127.0.0.1", resolve);
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
