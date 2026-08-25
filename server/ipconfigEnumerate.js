"use strict";

// ipconfigEnumerate — pure helpers that walk the persisted ipconfig and yield
// one `{ inverter, ip, slave }` triple per configured node.
//
// The persisted ipconfig (see sanitizeIpConfig in server/index.js) is an
// OBJECT MAP keyed by inverter number:
//
//   { inverters: { 1: "192.168.1.101", 2: "...", ... },
//     units:     { 1: [1,2,3,4],       2: [...], ... } }
//
// Three IGBT health endpoints previously read `inverters` as if it were an
// array of `{inverter, ip}` records (`(cfg.inverters || []).filter(r => ...)`),
// silently 500ing on every request. Centralising the walk in a pure module
// lets tests lock the shape contract without spinning the full Express stack.

const MIN_INVERTER = 1;
const MAX_INVERTER = 27;
const MIN_UNIT = 1;
const MAX_UNIT = 4;
const DEFAULT_UNITS = [1, 2, 3, 4];

function enumerateConfiguredNodes(cfg) {
  const out = [];
  if (!cfg || typeof cfg !== "object") return out;
  for (let inv = MIN_INVERTER; inv <= MAX_INVERTER; inv++) {
    const ip = String(
      cfg?.inverters?.[inv] ?? cfg?.inverters?.[String(inv)] ?? "",
    ).trim();
    if (!ip) continue;
    const unitsRaw =
      cfg?.units?.[inv] ?? cfg?.units?.[String(inv)] ?? DEFAULT_UNITS;
    const unitsClean = Array.isArray(unitsRaw)
      ? unitsRaw.map((n) => Number(n)).filter((n) => n >= MIN_UNIT && n <= MAX_UNIT)
      : DEFAULT_UNITS.slice();
    const units =
      unitsClean.length > 0 ? [...new Set(unitsClean)] : DEFAULT_UNITS.slice();
    for (const slave of units) {
      out.push({ inverter: inv, ip, slave });
    }
  }
  return out;
}

function lookupConfiguredNode(cfg, inv, slave) {
  const invNum = Number(inv);
  const slaveNum = Number(slave);
  return (
    enumerateConfiguredNodes(cfg).find(
      (n) => n.inverter === invNum && n.slave === slaveNum,
    ) || null
  );
}

module.exports = {
  enumerateConfiguredNodes,
  lookupConfiguredNode,
  MIN_INVERTER,
  MAX_INVERTER,
  MIN_UNIT,
  MAX_UNIT,
};
