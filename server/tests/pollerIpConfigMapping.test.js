"use strict";

const assert = require("assert");
const {
  buildIpConfigLookup,
  resolveConfiguredTelemetryIdentity,
} = require("../poller");

function run() {
  const lookup = buildIpConfigLookup({
    inverters: {
      1: "192.168.1.101",
      2: "192.168.1.102",
    },
    poll_interval: {
      1: 0.05,
      2: 0.05,
    },
    units: {
      1: [1, 2],
      2: [3, 4],
    },
    losses: {
      1: 2.5,
      2: 2.5,
    },
  });

  {
    const resolved = resolveConfiguredTelemetryIdentity(
      {
        source_ip: "192.168.1.102",
        inverter: 1,
        unit: 3,
      },
      lookup,
    );
    assert.equal(resolved.ok, true, "configured IP should resolve");
    assert.equal(resolved.inverter, 2, "IP Config should be authoritative for inverter ownership");
    assert.equal(resolved.unit, 3, "configured node number should be preserved");
  }

  {
    const resolved = resolveConfiguredTelemetryIdentity(
      {
        source_ip: "192.168.1.102",
        inverter: 2,
        node_number: 1,
      },
      lookup,
    );
    assert.equal(resolved.ok, false, "unconfigured node should be rejected");
    assert.equal(resolved.reasonCode, "unit_unconfigured");
  }

  {
    const resolved = resolveConfiguredTelemetryIdentity(
      {
        inverter: 1,
        module: 2,
      },
      lookup,
    );
    assert.equal(resolved.ok, true, "legacy rows without source IP should still resolve");
    assert.equal(resolved.inverter, 1);
    assert.equal(resolved.unit, 2);
  }

  {
    const resolved = resolveConfiguredTelemetryIdentity(
      {
        source_ip: "192.168.1.250",
        unit: 1,
      },
      lookup,
    );
    assert.equal(resolved.ok, false, "unknown source IP should be rejected");
    assert.equal(resolved.reasonCode, "ip_unconfigured");
  }

  console.log("pollerIpConfigMapping.test.js: PASS");
}

run();
