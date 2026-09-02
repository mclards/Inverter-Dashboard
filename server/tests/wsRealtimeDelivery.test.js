"use strict";

const assert = require("assert");
const wsBus = require("../ws");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  wsBus.clients.clear();
  wsBus.setBroadcastPayloadEnricher(null);

  const sent = [];
  const client = {
    readyState: 1,
    bufferedAmount: 0,
    send(message) {
      sent.push(JSON.parse(String(message)));
    },
  };
  wsBus.clients.add(client);

  wsBus.broadcastUpdate({ type: "live", sequence: 1 });
  wsBus.broadcastUpdate({ type: "live", sequence: 2 });
  wsBus.broadcastUpdate({ type: "live", sequence: 3 });
  await wait(550);

  assert.equal(sent.length, 2, "a burst must send the first frame and one coalesced latest frame");
  assert.equal(sent[0].sequence, 1);
  assert.equal(sent[1].sequence, 3, "the obsolete middle frame must be discarded");
  assert(Number(sent[0].wsSentTs) > 0 && Number(sent[1].wsSentTs) > 0);

  const droppedBefore = wsBus.getStats().droppedFramesBackpressure;
  client.bufferedAmount = 300 * 1024;
  await wait(500);
  wsBus.broadcastUpdate({ type: "live", sequence: 4 });
  assert.equal(
    wsBus.getStats().droppedFramesBackpressure,
    droppedBefore + 1,
    "live data must be dropped before a long obsolete queue accumulates",
  );

  wsBus.broadcastUpdate({ type: "control_lock", locked: true });
  assert.equal(sent.at(-1).type, "control_lock", "control events must not be coalesced with live data");

  wsBus.clients.clear();
  console.log("wsRealtimeDelivery.test.js: PASS");
}

main().catch((err) => {
  wsBus.clients.clear();
  console.error("wsRealtimeDelivery.test.js: FAIL", err?.stack || err);
  process.exitCode = 1;
});
