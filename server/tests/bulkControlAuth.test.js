"use strict";

const assert = require("assert");
const {
  getPlantWideAuthKeys,
  isValidPlantWideAuthKey,
  issuePlantWideAuthSession,
  isValidPlantWideAuthSession,
  __resetForTests,
} = require("../bulkControlAuth");

function run() {
  const base = Date.parse("2026-03-13T12:05:30.000Z");

  __resetForTests();
  {
    // 2026-05-31 — the plant-wide bulk-control key was unified with the
    // topology key: the prefix is now `adsi` (the old `sacups` is retired) and
    // BOTH padded (`adsi05`) and unpadded (`adsi5`) minute forms validate, for
    // parity with requireTopologyAuth.
    // 2026-06-02 — the window is ±1 minute in BOTH directions (prior, current,
    // next) to match the documented Credentials Reference contract and to
    // tolerate a gateway clock that lags the operator's reference clock. At
    // minute 5 the valid set is {adsi4, adsi04, adsi5, adsi05, adsi6, adsi06}.
    const keys = [...getPlantWideAuthKeys(base)];
    assert.deepEqual(
      keys.sort(),
      ["adsi04", "adsi05", "adsi06", "adsi4", "adsi5", "adsi6"],
    );
    assert.equal(isValidPlantWideAuthKey("adsi05", base), true);
    assert.equal(isValidPlantWideAuthKey("adsi5", base), true);
    assert.equal(isValidPlantWideAuthKey("adsi04", base), true);
    assert.equal(isValidPlantWideAuthKey("adsi4", base), true);
    // Next minute (clock-lag tolerance) — previously rejected, now valid.
    assert.equal(isValidPlantWideAuthKey("adsi06", base), true);
    assert.equal(isValidPlantWideAuthKey("adsi6", base), true);
    // Two minutes away in either direction stays invalid (window is exactly ±1).
    assert.equal(isValidPlantWideAuthKey("adsi03", base), false);
    assert.equal(isValidPlantWideAuthKey("adsi3", base), false);
    assert.equal(isValidPlantWideAuthKey("adsi07", base), false);
    assert.equal(isValidPlantWideAuthKey("adsi7", base), false);
    // Regression guard: the retired `sacups` prefix must NEVER validate again.
    assert.equal(isValidPlantWideAuthKey("sacups05", base), false);
    assert.equal(isValidPlantWideAuthKey("sacups5", base), false);
  }

  __resetForTests();
  {
    // v2.11.x — operator preference: rolling lease is now 60 min so the
    // dashboard prompts for adsiMM at most once per hour. The lease still
    // expires at TTL, just on a longer horizon. Numbers below check the new
    // boundary: still valid at 30 min, expired by 65 min.
    assert.equal(isValidPlantWideAuthKey("adsi05", base), true);
    assert.equal(
      isValidPlantWideAuthKey("adsi05", base + 30 * 60 * 1000),
      true,
    );
    assert.equal(
      isValidPlantWideAuthKey("adsi05", base + 65 * 60 * 1000),
      false,
    );
  }

  __resetForTests();
  {
    const session = issuePlantWideAuthSession(base);
    assert.equal(
      isValidPlantWideAuthSession(session.token, base + 30 * 60 * 1000),
      true,
    );
    assert.equal(
      isValidPlantWideAuthSession(session.token, base + 65 * 60 * 1000),
      false,
    );
  }

  console.log("bulkControlAuth.test.js: PASS");
}

run();
