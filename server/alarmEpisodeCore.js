"use strict";

function normalizeAlarmValue(value) {
  const n = Math.max(0, Math.trunc(Number(value) || 0));
  return Number.isFinite(n) ? n : 0;
}

function classifyAlarmTransition(prevValue, nextValue) {
  const prev = normalizeAlarmValue(prevValue);
  const next = normalizeAlarmValue(nextValue);
  if (prev === next) return "noop";
  if (prev === 0 && next !== 0) return "raise";
  if (prev !== 0 && next === 0) return "clear";
  return "update_active";
}

module.exports = {
  classifyAlarmTransition,
};
