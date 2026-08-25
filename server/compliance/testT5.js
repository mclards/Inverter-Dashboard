"use strict";

/**
 * testT5.js — PGC 2016 GCR 4.4.4.6 Active Power Control sweep.
 *
 * Plan: plans/2026-05-10-modbus-registers-official-revamp.md §4 Slice θ.2
 *
 * Drives a setpoint ramp 100→75→50→25→75→100 % (default; configurable) on one
 * or more nodes, holding each plateau for `holdSec` (default 120 s). The
 * orchestrator records per-step deviation (achieved vs target) and per-tick
 * telemetry samples for the report generator.
 *
 * Pure orchestration: I/O is delegated to two callers:
 *   - sendSetpointPct(ip, slave, pct) → Promise<boolean>   (HTTP into our APC layer)
 *   - sampleNode(ip, slave) → { ts_ms, pac_w, ... }         (snapshot of live frame)
 *
 * Pass criteria per [docs/NGCP_Grid_Compliance_Implementation.docx](../../docs/NGCP_Grid_Compliance_Implementation.docx) §2.5:
 *   • Time-to-95%-target ≤ 30 s
 *   • Steady-state error  ≤ ±2 %
 */

const DEFAULT_RAMP = [100, 75, 50, 25, 75, 100];

function _clampPct(p) {
  const v = Number(p);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, v));
}

function defaultParams(overrides = {}) {
  return {
    ramp_pct:        Array.isArray(overrides.ramp_pct) && overrides.ramp_pct.length > 0
                       ? overrides.ramp_pct.map(_clampPct)
                       : DEFAULT_RAMP,
    hold_sec:        Math.max(30, Math.min(900,  Number(overrides.hold_sec)   || 120)),
    sample_period_s: Math.max(1,  Math.min(60,   Number(overrides.sample_period_s) || 2)),
    settle_sec:      Math.max(5,  Math.min(120,  Number(overrides.settle_sec) || 30)),
    tolerance_pct:   Math.max(0.5,Math.min(10,   Number(overrides.tolerance_pct) || 2)),
  };
}

/**
 * runApcSweep(orchRun, ratedKwPerNode, fns)
 *
 * Drives the entire ramp end-to-end. Honours abort signal, flushes samples
 * to DB on each plateau end, and finalizes the orchestrator with summary.
 */
async function runApcSweep(orchRun, ratedKwPerNode, fns) {
  if (!orchRun) throw new Error("runApcSweep: orchRun required");
  const { sendSetpointPct, sampleNode, sleepMs, nowFn } = fns || {};
  if (typeof sendSetpointPct !== "function") throw new Error("sendSetpointPct fn required");
  if (typeof sampleNode      !== "function") throw new Error("sampleNode fn required");
  const wait = typeof sleepMs === "function" ? sleepMs : ((ms) => new Promise(r => setTimeout(r, ms)));
  // Optional clock injection so tests with `sleepMs: () => Promise.resolve()`
  // don't busy-spin waiting for wall time. When provided, every Date.now()
  // call below is replaced and `wait(tickMs)` advances it by tickMs.
  let virtualNow = typeof nowFn === "function" ? nowFn() : null;
  const clock = (typeof nowFn === "function")
    ? () => virtualNow
    : Date.now;
  const advanceClock = (typeof nowFn === "function")
    ? (ms) => { virtualNow += Number(ms) || 0; }
    : () => {};

  const p = defaultParams(orchRun.params);
  const targets = Array.isArray(orchRun.target_inverters) ? orchRun.target_inverters : [];
  if (targets.length === 0) {
    console.error(`[compliance][T5] run_id=${orchRun.run_id || "?"} aborted: no target inverters`);
    orchRun.finalize({ status: "failed", error: new Error("no target inverters") });
    return { ok: false };
  }

  console.log(
    `[compliance][T5] run_id=${orchRun.run_id || "?"} starting ${p.ramp_pct.length}-step ramp ` +
    `[${p.ramp_pct.join("→")}]% on ${targets.length} target(s) — hold=${p.hold_sec}s settle=${p.settle_sec}s tol=±${p.tolerance_pct}%`,
  );

  const stepResults = [];
  try {
    for (let i = 0; i < p.ramp_pct.length; i++) {
      if (orchRun.abortRequested) {
        console.warn(`[compliance][T5] run_id=${orchRun.run_id || "?"} abort requested at step ${i}/${p.ramp_pct.length}`);
        break;
      }
      const targetPct = p.ramp_pct[i];
      console.log(`[compliance][T5] step ${i + 1}/${p.ramp_pct.length} → ${targetPct}%`);
      const step = orchRun.beginStep({ step_idx: i, step_name: `ramp_${targetPct}pct`, target_value: targetPct });

      // Send setpoint to every target node.
      let writeOk = true;
      for (const t of targets) {
        try {
          const ok = await sendSetpointPct(t.ip, t.slave, targetPct);
          if (!ok) writeOk = false;
        } catch (e) {
          writeOk = false;
        }
      }
      if (!writeOk) {
        console.error(`[compliance][T5] step ${i + 1} setpoint write failed (target ${targetPct}%); marking FAIL and continuing`);
        orchRun.endStep(step, { pass: false, notes: "setpoint write failed" });
        continue;
      }

      // Sample throughout the hold window. First settle_sec is excluded
      // from steady-state averaging.
      const holdMs = p.hold_sec * 1000;
      const tickMs = p.sample_period_s * 1000;
      const startedAt = clock();
      const settleMs = p.settle_sec * 1000;
      const acks = [];

      while (clock() - startedAt < holdMs) {
        if (orchRun.abortRequested) break;
        const tick = clock();
        for (const t of targets) {
          try {
            const sample = await sampleNode(t.ip, t.slave);
            if (sample) {
              orchRun.pushSample({ ...sample, ts_ms: tick, inverter_ip: t.ip, slave: t.slave });
              if (tick - startedAt >= settleMs) {
                acks.push({ ts: tick, pac_w: sample.pac_w, ip: t.ip, slave: t.slave });
              }
            }
          } catch (e) {
            // soft-fail per tick
          }
        }
        await wait(tickMs);
        advanceClock(tickMs);
      }
      orchRun.flushSamples();

      // Compute steady-state achieved % per target.
      const ratedW = (ratedKwPerNode || 0) * 1000 * targets.length;
      let sumW = 0, n = 0;
      for (const a of acks) {
        if (a.pac_w == null) continue;
        sumW += Number(a.pac_w);
        n += 1;
      }
      const observedW = n > 0 ? (sumW / n) * targets.length : 0;
      const observedPct = ratedW > 0 ? (observedW / ratedW) * 100 : null;
      const deviationPct = observedPct == null ? null : Math.abs(observedPct - targetPct);
      const pass = deviationPct == null ? null : deviationPct <= p.tolerance_pct;

      orchRun.endStep(step, {
        achieved_value: observedPct,
        deviation_pct: deviationPct,
        pass,
        notes: n > 0 ? `${n} samples after settle` : "no post-settle samples",
      });
      const passLbl = pass === true ? "PASS" : pass === false ? "FAIL" : "SKIP";
      console.log(
        `[compliance][T5] step ${i + 1} ${passLbl} — observed ${observedPct == null ? "—" : observedPct.toFixed(2) + "%"} ` +
        `(dev ${deviationPct == null ? "—" : deviationPct.toFixed(2) + "%"}, ${n} post-settle samples)`,
      );
      stepResults.push({ targetPct, observedPct, deviationPct, pass });
    }

    // Restore inverters to 100 % on completion (or on abort) so we never
    // leave the plant artificially curtailed.
    let restoreOk = true;
    try {
      for (const t of targets) {
        const ok = await sendSetpointPct(t.ip, t.slave, 100);
        if (!ok) restoreOk = false;
      }
    } catch (rErr) {
      restoreOk = false;
      console.error(`[compliance][T5] restoration error: ${rErr.message}`);
    }
    if (!restoreOk) {
      console.error(`[compliance][T5] restoration to 100% partially failed — operator must verify holding 41006 reads 32767 on all ${targets.length} target(s)`);
    }

    const passes = stepResults.filter(r => r.pass === true).length;
    const fails  = stepResults.filter(r => r.pass === false).length;
    // Restoration failure means the plant is held below 100% after the test
    // (e.g. last commanded setpoint was 50% and the restore-to-100 write
    // failed). Surface this as 'completed_with_warnings' instead of a
    // clean 'completed' so the operator sees the unsafe end-state.
    const stepsClean = fails === 0 && passes > 0;
    const status = orchRun.abortRequested ? "aborted"
                 : (!restoreOk ? "completed_with_warnings"
                 : (stepsClean ? "completed" : "failed"));
    console.log(
      `[compliance][T5] run_id=${orchRun.run_id || "?"} ${status.toUpperCase()} — ` +
      `${passes} pass / ${fails} fail / ${stepResults.length - passes - fails} skip; restoration=${restoreOk ? "ok" : "PARTIAL"}`,
    );

    orchRun.finalize({
      status,
      summary: {
        steps: stepResults.length,
        passes, fails,
        params: p,
      },
    });
    return { ok: true, status, steps: stepResults };
  } catch (err) {
    console.error(`[compliance][T5] run_id=${orchRun.run_id || "?"} CRASHED: ${err.message}`);
    orchRun.finalize({ status: "failed", error: err });
    return { ok: false, error: err.message };
  }
}

module.exports = { runApcSweep, defaultParams, DEFAULT_RAMP };
