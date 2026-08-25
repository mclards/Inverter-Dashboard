"use strict";

/**
 * Slice ε — standard-Modbus stop-reason cross-check logic
 *
 * Compares a vendor SCOPE stop-reason record against a standard-Modbus slot
 * to detect firmware bugs or Modbus corruption.
 *
 * Related plan: plans/slice-epsilon-implementation.md §8
 */

/**
 * Compare a vendor SCOPE stop-reason record against a standard-Modbus slot.
 *
 * Match rules:
 *   1. Both have valid timestamps (not offline / invalid)
 *   2. Timestamps within ±60 seconds
 *   3. Motive codes equal (vendor.motparo === std.motive_code)
 *
 * Returns {
 *   match: bool,
 *   reason?: string,  // Reason for mismatch if match=false
 *   delta?: {
 *     timeDeltaMs: number,
 *     timeMatchOk: bool,
 *     codeMatchOk: bool,
 *     vendorMotparo?: number,
 *     stdMotiveCode?: number,
 *     vendorEventAtMs?: number,
 *     stdCapturedAtMs?: number,
 *   }
 * }
 */
function crossCheckStopReasons(vendorSlot, stdSlot) {
  const TIMESTAMP_TOLERANCE_MS = 60 * 1000;  // 60 seconds

  // Validate vendor data
  if (vendorSlot === null || vendorSlot === undefined) {
    return {
      match: false,
      reason: "missing_vendor_data",
    };
  }
  if (vendorSlot.event_at_ms === null || vendorSlot.event_at_ms === undefined) {
    return {
      match: false,
      reason: "missing_vendor_data",
    };
  }
  if (vendorSlot.motparo === null || vendorSlot.motparo === undefined) {
    return {
      match: false,
      reason: "missing_vendor_data",
    };
  }

  // Validate std data
  if (stdSlot === null || stdSlot === undefined) {
    return {
      match: false,
      reason: "missing_data",
    };
  }

  // Check for invalid timestamp string FIRST (before offline check)
  if (typeof stdSlot.timestamp_iso === "string" && stdSlot.timestamp_iso.startsWith("invalid(")) {
    return {
      match: false,
      reason: "invalid_std_timestamp",
    };
  }

  // Check for offline slot
  if (stdSlot.timestamp_iso === "offline" || stdSlot.captured_at_ms === null || stdSlot.captured_at_ms === undefined) {
    return {
      match: false,
      reason: "offline_slot",
    };
  }

  // Calculate match criteria
  const vendorEventAtMs = parseInt(vendorSlot.event_at_ms, 10) || 0;
  const stdCapturedAtMs = parseInt(stdSlot.captured_at_ms, 10) || 0;
  const timeDeltaMs = Math.abs(vendorEventAtMs - stdCapturedAtMs);
  const timeMatchOk = timeDeltaMs <= TIMESTAMP_TOLERANCE_MS;
  const codeMatchOk = parseInt(vendorSlot.motparo, 10) === parseInt(stdSlot.motive_code, 10);

  // Determine match and reason
  let match = false;
  let reason = undefined;

  if (!codeMatchOk) {
    match = false;
    reason = "code_mismatch";
  } else if (!timeMatchOk) {
    match = false;
    reason = "timestamp_mismatch";
  } else {
    match = true;
  }

  const result = {
    match,
    timeMatchOk,
    codeMatchOk,
  };

  if (reason) {
    result.reason = reason;
  }

  // Add delta with detailed breakdown
  result.delta = {
    timeDeltaMs,
    timeMatchOk,
    codeMatchOk,
    vendorMotparo: parseInt(vendorSlot.motparo, 10),
    stdMotiveCode: parseInt(stdSlot.motive_code, 10),
    vendorEventAtMs,
    stdCapturedAtMs,
  };

  return result;
}

module.exports = { crossCheckStopReasons };
