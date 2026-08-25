"use strict";

/**
 * criticalPatternEnforcer.js — Slice κ.3 (v2.11.x)
 *
 * Automatically blocks an inverter from generation when a critical alarm
 * pattern (0x0240 or 0x0210) recurs unresolved within 48 hours. Operator
 * rule (2026-05-11): "2-day recurring 0x0240 or 0x0210 episode count must
 * be considered critical already, needs attention by the inverter engineer.
 * Block START control … STOP the generation automatically and block the
 * control on the inverter card and put notice overlayed on it."
 *
 * Design:
 *   - The enforcement loop walks each configured inverter on a fixed cadence
 *     (default every 2 min). For each inverter it asks the dependency
 *     `loadPatternsForNode(inv, slave)` for the current pattern severities
 *     across that inverter's slaves.
 *   - If ANY slave is severity === "critical" AND no active block exists,
 *     it opens a block row + issues STOP (value=0) to every configured
 *     slave of that inverter.
 *   - If an active block already exists, it checks whether re-enforcement
 *     is needed (i.e. a slave is currently running) and re-issues STOP at
 *     most once per re-enforcement interval (default 5 min).
 *   - Operator clicks "Confirmed" → ackCriticalBlock() closes the block.
 *     A *new* critical episode after the ack will create a new block row.
 *
 * Pure decision logic lives in `decideBlockAction()`. Side effects (STOP
 * commands, DB writes, logging) are injected as `deps`.
 */

const { patternSeverityRank } = require("./criticalAlarmPatterns");

// How often we can re-issue STOP for the same active block.
const RE_ENFORCEMENT_INTERVAL_MS = 5 * 60 * 1000;  // 5 min

// Slice κ.5 — graceful-stop settle interval. The enforcer fans STOP out
// across every configured slave of an inverter. Firing them in lockstep
// makes all K1 contactors open at the same instant, which on a shared AC
// bus produces a coincident voltage transient + di/dt that the surrounding
// inverters see as a brief disturbance. Spacing the STOPs by this interval
// lets each slave's K1 settle (~ 50–80 ms mechanical) and lets the gate
// driver complete its soft-shutdown ramp before the next slave goes.
//
// 1500 ms is conservative: well past the K1 mechanical settle, comfortably
// below the operator's perception of "blocked immediately" (the block row
// + UI overlay land synchronously on the FIRST tick anyway).
const STOP_PER_SLAVE_DELAY_MS = 1500;

function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

/**
 * Per-inverter decision based on current pattern severities + existing block.
 *
 * Selection rule (2026-05-12): when multiple patterns are critical at the
 * same time, pick the one with the highest `severity_rank` (catalogue order:
 * 0x0240 substrate-breach OUTRANKS 0x0210 AC overcurrent). Within equal
 * ranks, tie-break by most-recent episode so the freshest signal wins.
 *
 * Slice κ.8 (2026-05-12) gate: a critical alarm pattern is no longer
 * sufficient on its own to open a block. The slave entry may carry an
 * `unbalance` field (from phaseUnbalance.evaluateSustainedUnbalance);
 * open_block fires only when both the alarm pattern is critical AND the
 * unbalance is sustained on the same slave. If pattern is critical but
 * unbalance is NOT sustained, the action becomes `gated_pending_unbalance`
 * — the caller logs it for forensics but issues no STOP. This preserves
 * the precursor-detection visibility (UI still shows "critical" pattern
 * status) while removing the false-positive STOP that motivated the
 * change.
 *
 * The gate is OPT-IN: if no slave carries `unbalance`, behaviour falls
 * back to pre-Slice-κ.8 (pattern-only block). This lets legacy callers
 * and tests upgrade incrementally.
 *
 * @param {Object} ctx
 * @param {number} ctx.inverter
 * @param {Array<{slave:number, patterns: Array<{key,hex,label,severity,severity_rank,count_in_window,last_seen_ts}>, unbalance?: {sustained:boolean, max_pct:number}}>} ctx.slaves
 * @param {Object|null} ctx.activeBlock  — current open block row, or null
 * @param {number} ctx.now
 *
 * @returns {Object} action
 *   action.kind: "noop" | "open_block" | "reenforce" | "skip_reenforce" | "promote_block" | "gated_pending_unbalance"
 *   action.reason: string
 *   action.pattern?: { key, hex, label }
 *   action.triggering_slave?: number
 *   action.count_in_window?: number
 *   action.latest_episode_ts?: number
 *   action.unbalance?: { sustained, max_pct }   // present on open_block + gated_pending_unbalance
 */
function decideBlockAction(ctx) {
  const slaves = Array.isArray(ctx?.slaves) ? ctx.slaves : [];
  const now    = Number(ctx?.now) || Date.now();
  const active = ctx?.activeBlock || null;

  // Find the worst pattern across slaves. Ordering rule:
  //   1. higher catalogue severity_rank wins (0x0240 > 0x0210)
  //   2. on ties, more-recent last_seen_ts wins (freshest signal)
  // Fallback: if the payload omits severity_rank (legacy), look it up.
  //
  // Slice κ.8 — also attach the per-slave unbalance verdict to the candidate
  // so the gate logic below can decide whether to open or hold.
  const unbalanceBySlave = new Map();
  for (const s of slaves) {
    if (s && typeof s.slave !== "undefined" && s.unbalance) {
      unbalanceBySlave.set(Number(s.slave), s.unbalance);
    }
  }
  let worst = null;
  for (const s of slaves) {
    if (!s || !Array.isArray(s.patterns)) continue;
    for (const p of s.patterns) {
      if (p?.severity !== "critical") continue;
      const ts   = Number(p.last_seen_ts) || 0;
      const rank = Number(p.severity_rank) || patternSeverityRank(p.key);
      const cand = {
        slave: Number(s.slave),
        key:   String(p.key || ""),
        hex:   String(p.hex || ""),
        label: String(p.label || ""),
        count_in_window: Number(p.count_in_window || 0),
        last_seen_ts:    ts,
        severity_rank:   rank,
      };
      if (!worst) { worst = cand; continue; }
      if (cand.severity_rank > worst.severity_rank) { worst = cand; continue; }
      if (cand.severity_rank === worst.severity_rank && cand.last_seen_ts > worst.last_seen_ts) {
        worst = cand;
      }
    }
  }

  if (!worst) {
    // Slice κ.9 — a pending (armed-during-solar) row whose pattern is no
    // longer critical must be disarmed: the condition is NOT still met, so
    // the deferred STOP must never execute (2.2 "verify condition is always
    // met before triggering").
    if (!active && ctx?.pendingBlock) {
      return { kind: "disarm_pending", reason: "pattern_resolved_before_stop" };
    }
    return { kind: "noop", reason: active ? "block_active_no_new_critical" : "no_critical_pattern" };
  }

  // Slice κ.8 unbalance gate: a critical alarm pattern alone is not
  // enough — we also need a sustained physical-measurement signal on the
  // SAME slave (the IGBT leg that's actually misbehaving). If the unbalance
  // verdict is absent (legacy / test shape), fall back to pre-Slice-κ.8
  // behaviour. If it's present but not sustained, hold the block open.
  const unbalanceForWorst = unbalanceBySlave.get(worst.slave) || null;
  const unbalanceProvided = unbalanceBySlave.size > 0;
  // 2.2 — phase-current imbalance is now a MANDATORY gate. The pre-Slice-κ.8
  // "no unbalance data ⇒ pass" legacy fallback is removed: an auto-block must
  // never fire without a confirmed sustained Iac1/Iac2/Iac3 imbalance on the
  // triggering slave.
  const unbalancePass =
    unbalanceProvided && !!unbalanceForWorst && unbalanceForWorst.sustained === true;
  const inSolar = ctx?.inSolarWindow === true;
  const pending = ctx?.pendingBlock || null;
  const latchedUnbalance = unbalanceForWorst
    ? { sustained: !!unbalanceForWorst.sustained, max_pct: Number(unbalanceForWorst.max_pct || 0) }
    : { sustained: false, max_pct: 0 };

  if (!active) {
    // 2.2 "Detect during, STOP after": confirm pattern + imbalance while the
    // inverter is producing (currents are only real in the solar window), but
    // defer the actual STOP/block until the window closes so a borderline
    // signal never interrupts active generation.
    if (unbalancePass && inSolar) {
      return {
        kind: "arm_pending",
        reason: "confirmed_in_solar_defer_stop_until_window_close",
        pattern: { key: worst.key, hex: worst.hex, label: worst.label },
        triggering_slave: worst.slave,
        count_in_window: worst.count_in_window,
        latest_episode_ts: worst.last_seen_ts,
        unbalance: latchedUnbalance,
      };
    }
    // Solar window has closed and we previously armed this inverter during
    // solar (pattern + imbalance were confirmed and latched). Re-verify the
    // pattern is STILL critical (worst is truthy here), then execute the
    // deferred STOP using the latched evidence — a live out-of-solar
    // unbalance read is structurally unavailable (rejected by the solar gate).
    if (pending && !inSolar) {
      return {
        kind: "open_block",
        reason: "deferred_after_solar",
        pattern: { key: worst.key, hex: worst.hex, label: worst.label },
        triggering_slave: worst.slave,
        count_in_window: worst.count_in_window,
        latest_episode_ts: worst.last_seen_ts,
        unbalance: pending.unbalance_latched || latchedUnbalance,
        from_pending: true,
      };
    }
    if (!unbalancePass) {
      return {
        kind: "gated_pending_unbalance",
        reason: "critical_pattern_without_sustained_unbalance",
        pattern: { key: worst.key, hex: worst.hex, label: worst.label },
        triggering_slave: worst.slave,
        count_in_window: worst.count_in_window,
        latest_episode_ts: worst.last_seen_ts,
        unbalance: latchedUnbalance,
      };
    }
    // unbalancePass && !inSolar && no pending: a fresh confirmation outside
    // the solar window (rare — currents are usually zero at night). Act now;
    // there is no production to protect by deferring.
    return {
      kind: "open_block",
      reason: "recurring_critical_pattern_with_unbalance",
      pattern: { key: worst.key, hex: worst.hex, label: worst.label },
      triggering_slave: worst.slave,
      count_in_window: worst.count_in_window,
      latest_episode_ts: worst.last_seen_ts,
      unbalance: latchedUnbalance,
    };
  }

  // Active block exists. First check whether the currently-worst critical
  // pattern OUTRANKS the active block's pattern. If yes, promote the block
  // so the overlay shows the more catastrophic failure mode immediately —
  // operator must not be misled into thinking only the lesser pattern is
  // active when the bigger one has also reached critical.
  const activeRank = patternSeverityRank(active.pattern_key);
  if (worst.severity_rank > activeRank && worst.key !== active.pattern_key) {
    return {
      kind: "promote_block",
      reason: `promoted_${active.pattern_key}_to_${worst.key}`,
      pattern: { key: worst.key, hex: worst.hex, label: worst.label },
      triggering_slave: worst.slave,
      count_in_window: worst.count_in_window,
      latest_episode_ts: worst.last_seen_ts,
    };
  }

  // Block already active and pattern hasn't been outranked — re-enforce STOP
  // if the cooldown elapsed.
  const lastReenforce = Number(active.last_reenforced_ms) || Number(active.stop_issued_at_ms) || Number(active.created_at_ms) || 0;
  if (now - lastReenforce < RE_ENFORCEMENT_INTERVAL_MS) {
    return { kind: "skip_reenforce", reason: "cooldown_active" };
  }

  return {
    kind: "reenforce",
    reason: "still_critical_after_block",
    pattern: { key: worst.key, hex: worst.hex, label: worst.label },
    triggering_slave: worst.slave,
    count_in_window: worst.count_in_window,
    latest_episode_ts: worst.last_seen_ts,
  };
}

/**
 * Build a public "block status" view used by GET /api/critical-blocks and
 * the inverter-card overlay. Hides internal fields, keeps operator-facing
 * forensic info.
 */
function summarizeBlockForApi(row) {
  if (!row) return null;
  return {
    id: row.id,
    inverter: row.inverter,
    created_at_ms: row.created_at_ms,
    pattern_key:   row.pattern_key,
    pattern_hex:   row.pattern_hex,
    pattern_label: row.pattern_label,
    triggering_slave:  row.triggering_slave,
    count_in_window:   row.count_in_window,
    latest_episode_ts: row.latest_episode_ts,
    stop_issued_at_ms: row.stop_issued_at_ms,
    stop_result:       row.stop_result,
    last_reenforced_ms: row.last_reenforced_ms,
    reenforce_count:   row.reenforce_count,
    acked_at_ms:       row.acked_at_ms,
    acked_by:          row.acked_by,
    ack_note:          row.ack_note,
    is_active:         row.acked_at_ms == null,
  };
}

/**
 * Run one enforcement tick for one inverter.
 *
 * Side effects are mediated by `deps`:
 *   deps.getActiveBlock(inverter)               → row|null
 *   deps.openBlock(rowFields)                   → newId
 *   deps.promoteBlock(id, patternFields, now)   → void   (Slice κ.3 — pattern update)
 *   deps.markReenforced(id, nowMs, stopResult)
 *   deps.issueStop(inverter, slave, reason)     → "ok" | "err:<msg>"
 *   deps.listSlaves(inverter)                   → [slave numbers]
 *   deps.loadPatternsForNode(inv, slave, now)   → patternStatus[]
 *   deps.loadUnbalanceForNode?(inv, slave, now) → {sustained, max_pct, ...} | null
 *                                                 — Slice κ.8 optional; absent
 *                                                 = legacy pattern-only behaviour
 *   deps.logAction(payload)                     → void
 *   deps.now()                                  → number
 */
async function enforceOne(inverter, deps) {
  const now = Number(deps?.now?.() || Date.now());
  const slaves = (deps?.listSlaves?.(inverter) || []).map(Number).filter((s) => Number.isFinite(s));
  if (slaves.length === 0) {
    return { inverter, action: { kind: "noop", reason: "no_configured_slaves" } };
  }

  // Pull pattern status + unbalance verdict for each slave. The unbalance
  // dep is optional — if not provided, decideBlockAction falls back to
  // pre-Slice-κ.8 pattern-only behaviour (this keeps legacy tests working
  // without requiring every test to inject phase-current data).
  const slavePatterns = slaves.map((s) => {
    const entry = {
      slave: s,
      patterns: deps.loadPatternsForNode(inverter, s, now) || [],
    };
    if (typeof deps.loadUnbalanceForNode === "function") {
      try {
        const u = deps.loadUnbalanceForNode(inverter, s, now);
        if (u && typeof u === "object") entry.unbalance = u;
      } catch (_) { /* unbalance lookup failure must not break enforcement */ }
    }
    return entry;
  });

  const activeBlock = deps.getActiveBlock(inverter) || null;
  // Slice κ.9 — solar-window deferral context. inSolarWindow + the latched
  // pending row let decideBlockAction arm/defer/convert/disarm.
  const pendingBlock = (typeof deps.getPendingBlock === "function")
    ? (deps.getPendingBlock(inverter) || null)
    : null;
  const action = decideBlockAction({
    inverter,
    slaves: slavePatterns,
    activeBlock,
    pendingBlock,
    inSolarWindow: deps.inSolarWindow === true,
    now,
  });

  if (action.kind === "noop" || action.kind === "skip_reenforce") {
    return { inverter, action };
  }

  // Slice κ.9 — arm a deferred block: pattern + sustained imbalance confirmed
  // while the inverter is producing, STOP held until the solar window closes.
  // NO STOP and NO manual-write lock here (pending rows are excluded from the
  // active-block queries that gate /api/write).
  if (action.kind === "arm_pending") {
    deps.armPending?.({
      inverter,
      pattern_key:   action.pattern.key,
      pattern_hex:   action.pattern.hex,
      pattern_label: action.pattern.label,
      triggering_slave:  action.triggering_slave,
      count_in_window:   action.count_in_window,
      latest_episode_ts: action.latest_episode_ts,
      armed_at_ms:       now,
      unbalance_latched: action.unbalance,
    });
    deps.logAction?.({
      kind: "critical_block_armed_pending",
      inverter,
      pattern: action.pattern,
      triggering_slave: action.triggering_slave,
      count_in_window:  action.count_in_window,
      unbalance: action.unbalance,
    });
    return { inverter, action };
  }

  // Slice κ.9 — pattern resolved before the solar window closed: the deferred
  // STOP must NOT execute. Drop the armed row (kept acked for forensics).
  if (action.kind === "disarm_pending") {
    deps.disarmPending?.(inverter, action.reason);
    deps.logAction?.({
      kind: "critical_block_disarmed",
      inverter,
      reason: action.reason,
    });
    return { inverter, action };
  }

  // Slice κ.8 — pattern recurred but the physical-measurement gate
  // didn't pass. Surface the situation in the audit trail so an operator
  // can investigate the precursor, but do NOT open a block or issue STOP.
  if (action.kind === "gated_pending_unbalance") {
    deps.logAction?.({
      kind: "critical_block_gated_pending_unbalance",
      inverter,
      pattern: action.pattern,
      triggering_slave: action.triggering_slave,
      count_in_window:  action.count_in_window,
      unbalance: action.unbalance,
    });
    return { inverter, action };
  }

  // promote_block: existing active block carries a less-severe pattern than
  // what's currently critical. Update the row in place, broadcast, audit —
  // but do NOT re-issue STOP (the inverter is already stopped by the
  // earlier open_block). This is a pure UI/forensic promotion.
  if (action.kind === "promote_block") {
    const prevKey = activeBlock?.pattern_key || "";
    deps.promoteBlock?.(activeBlock.id, {
      pattern_key:   action.pattern.key,
      pattern_hex:   action.pattern.hex,
      pattern_label: action.pattern.label,
      triggering_slave:  action.triggering_slave,
      count_in_window:   action.count_in_window,
      latest_episode_ts: action.latest_episode_ts,
    }, now);
    deps.logAction?.({
      kind: "critical_block_promoted",
      inverter, blockId: activeBlock.id,
      pattern: action.pattern,
      from_pattern_key: prevKey,
      triggering_slave: action.triggering_slave,
      count_in_window:  action.count_in_window,
    });
    return { inverter, action, blockId: activeBlock.id };
  }

  // open_block: insert row first so the UI sees the block even if STOP fails.
  let blockId = activeBlock?.id || null;
  if (action.kind === "open_block") {
    if (action.from_pending && pendingBlock && typeof deps.activatePending === "function") {
      // Slice κ.9 — convert the armed (pending) row in place so its id
      // stays stable for the operator (the UI showed it as "armed").
      const converted = deps.activatePending(pendingBlock.id, now);
      if (converted === 0) {
        // Defensive: the pending row was acked/removed between the read and
        // the convert (operator dismissed it, or a concurrent tick). Open a
        // fresh active row so the SAFETY intent (STOP + write-lock) still
        // engages rather than silently no-op'ing.
        blockId = deps.openBlock({
          inverter,
          created_at_ms: now,
          pattern_key:   action.pattern.key,
          pattern_hex:   action.pattern.hex,
          pattern_label: action.pattern.label,
          triggering_slave:  action.triggering_slave,
          count_in_window:   action.count_in_window,
          latest_episode_ts: action.latest_episode_ts,
          stop_issued_at_ms: null,
          stop_result:       null,
          last_reenforced_ms: null,
        });
      } else {
        blockId = pendingBlock.id;
      }
      deps.logAction?.({
        kind: "critical_block_opened",
        inverter, blockId, pattern: action.pattern,
        triggering_slave: action.triggering_slave,
        count_in_window:  action.count_in_window,
        reason: converted === 0 ? "deferred_after_solar_reopened" : "deferred_after_solar",
      });
    } else {
      blockId = deps.openBlock({
        inverter,
        created_at_ms: now,
        pattern_key:   action.pattern.key,
        pattern_hex:   action.pattern.hex,
        pattern_label: action.pattern.label,
        triggering_slave:  action.triggering_slave,
        count_in_window:   action.count_in_window,
        latest_episode_ts: action.latest_episode_ts,
        stop_issued_at_ms: null,
        stop_result:       null,
        last_reenforced_ms: null,
      });
      deps.logAction?.({
        kind: "critical_block_opened",
        inverter, blockId, pattern: action.pattern,
        triggering_slave: action.triggering_slave,
        count_in_window:  action.count_in_window,
      });
    }
  }

  // Issue STOP to every configured slave of this inverter. Best-effort:
  // failures don't roll back the block (the block represents the SAFETY
  // intent; if the STOP failed we still want manual control gated).
  //
  // Slice κ.5 — graceful sequence. A configurable settle delay between
  // slaves (deps.stopPerSlaveDelayMs ?? STOP_PER_SLAVE_DELAY_MS, default
  // 1500 ms) keeps the K1 contactors from opening in lockstep and lets
  // each gate driver complete its soft-shutdown ramp before the next
  // slave is commanded. The block row is already in the DB and the UI
  // overlay is already up — the delays are about HARDWARE quiescence,
  // not user-visible responsiveness.
  const stopDelay = (typeof deps?.stopPerSlaveDelayMs === "number")
    ? deps.stopPerSlaveDelayMs
    : STOP_PER_SLAVE_DELAY_MS;
  const stopResults = [];
  let firstSlave = true;
  for (const s of slaves) {
    if (!firstSlave && stopDelay > 0) await _sleep(stopDelay);
    firstSlave = false;
    try {
      const result = await deps.issueStop(inverter, s, `critical_pattern:${action.pattern.key}`);
      stopResults.push(`s${s}=${result || "ok"}`);
    } catch (err) {
      stopResults.push(`s${s}=err:${err?.message || String(err)}`);
    }
  }
  const stopResultStr = stopResults.join(",");

  if (action.kind === "open_block") {
    deps.markReenforced(blockId, now, stopResultStr);
  } else if (action.kind === "reenforce") {
    deps.markReenforced(blockId, now, stopResultStr);
    deps.logAction?.({
      kind: "critical_block_reenforced",
      inverter, blockId,
      reenforce_count: (activeBlock?.reenforce_count || 0) + 1,
    });
  }

  return { inverter, action, stopResult: stopResultStr, blockId };
}

module.exports = {
  RE_ENFORCEMENT_INTERVAL_MS,
  STOP_PER_SLAVE_DELAY_MS,
  decideBlockAction,
  summarizeBlockForApi,
  enforceOne,
};
