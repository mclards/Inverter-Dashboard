"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

function run() {
  const serverSrc = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const pollerSrc = fs.readFileSync(path.join(__dirname, "..", "poller.js"), "utf8");
  const uiSrc = fs.readFileSync(path.join(__dirname, "..", "..", "public", "global-config.html"), "utf8");

  assert(serverSrc.includes("const DEFAULT_INVERTER_LOSS_PCT = 2.5;"));
  assert(serverSrc.includes("cfg.losses[i] = DEFAULT_INVERTER_LOSS_PCT;"));
  assert(serverSrc.includes("src?.losses?.[i] ?? src?.losses?.[String(i)] ?? out.losses[i]"));

  assert(pollerSrc.includes("const DEFAULT_INVERTER_LOSS_PCT = 2.5;"));
  assert(pollerSrc.includes("cfg.losses[i] = DEFAULT_INVERTER_LOSS_PCT;"));

  assert(uiSrc.includes("const DEFAULT_LOSS_PCT = 2.5;"));
  assert(uiSrc.includes(": DEFAULT_LOSS_PCT;"));

  console.log("ipConfigLossDefaultsSource.test.js: PASS");
}

run();
