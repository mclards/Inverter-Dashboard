"use strict";

/**
 * testT3.js — PGC 2016 GCR 4.4.4.1 Reactive Power / Q-V Capability sweep.
 *
 * Plan: plans/2026-05-10-modbus-registers-official-revamp.md §4 Slice θ.4
 * Reference: docs/Inverter-Modbus-Reference.md §6 (cmd 1 / cmd 9 / read-back 41006-41010)
 *
 * Drives a power-factor sweep across the operator-friendly NGCP envelope:
 *   1.00 → 0.95 lag → 1.00 → 0.95 lead → 1.00  (default 21 steps × 60 s = 21 min)
 *
 * Per step:
 *   1. Convert (PF, sign) → tan(φ) → Int16 raw via Slice ζ math
 *   2. Send cmd 1 (set_phi_tangent) to every target node
 *   3. Hold for `hold_sec`; first `settle_sec` is excluded from steady-state averaging
 *   4. Sample P, Q, V, observed PF every `sample_period_s` from live frames
 *   5. Compute steady-state deviation (observed PF vs target PF) over post-settle samples
 *
 * Pass criterion (θ-3): observed PF within ±5 % of target capability curve.
 * Restoration: on completion or abort the runner sends cmd 11 (disable_reactive)
 *              to every target so the plant is never left mid-sweep.
 *
 * Pure orchestration: I/O is delegated to:
 *   - sendPhiTangent(ip, slave, phi_raw) → Promise<boolean>      (cmd 1)
 *   - disableReactive(ip, slave)         → Promise<boolean>      (cmd 11 — restoration)
 *   - sampleNode(ip, slave)              → { ts_ms, pac_w, qac_var, vac_avg_v, cosphi, ... }
 *
 * Optional clock injection (`nowFn`) lets unit tests run instantly.
 */

const DEFAULT_PF_SWEEP = [
  { pf: 1.00, sign: "0"   },
  { pf: 0.99, sign: "lag" },
  { pf: 0.98, sign: "lag" },
  { pf: 0.97, sign: "lag" },
  { pf: 0.96, sign: "lag" },
  { pf: 0.95, sign: "lag" },
  { pf: 0.96, sign: "lag" },
  { pf: 0.97, sign: "lag" },
  { pf: 0.98, sign: "lag" },
  { pf: 0.99, sign: "lag" },
  { pf: 1.00, sign: "0"   },
  { pf: 0.99, sign: "lead" },
  { pf: 0.98, sign: "lead" },
  { pf: 0.97, sign: "lead" },
  { pf: 0.96, sign: "lead" },
  { pf: 0.95, sign: "lead" },
  { pf: 0.96, sign: "lead" },
  { pf: 0.97, sign: "lead" },
  { pf: 0.98, sign: "lead" },
  { pf: 0.99, sign: "lead" },
  { pf: 1.00, sign: "0"   },
];

// PDF cmd 1 absolute limit: ±15870 raw = ±0.484 tan(φ) ≈ PF 0.90.
const PHI_RAW_MAX = 15870;

function _clampPf(p) {
  const v = Number(p);
  if (!Number.isFinite(v)) return 1.0;
  return Math.max(0.90, Math.min(1.00, v));
}

function _normalizeSign(s) {
  const v = String(s || "0").trim().toLowerCase();
  if (v === "lag" || v === "lead") return v;
  return "0";
}

/** Convert (PF, sign) → Int16 phi_raw the Modbus wire expects.
 *  Mirror of `_pfToPhiRaw` in the client UI. tan(φ) = sqrt(1/PF² − 1).
 *  Sign convention: lag = positive (inductive), lead = negative (capacitive). */
function pfToPhiRaw(pf, sign) {
  const pfNum = _clampPf(pf);
  const tanPhi = Math.sqrt(Math.max(0, 1 / (pfNum * pfNum) - 1));
  const signedTan = _normalizeSign(sign) === "lead" ? -tanPhi
                  : _normalizeSign(sign) === "lag"  ? tanPhi
                  : 0;
  // PDF: phi_raw = tan(φ) × 32767. Cross-check NGCP PF 0.95 → ±10780.
  const raw = Math.round(signedTan * 32767);
  return Math.max(-PHI_RAW_MAX, Math.min(PHI_RAW_MAX, raw));
}

/** Convert observed P + Q (both watts) → unsigned PF estimate.
 *  PF = |P| / sqrt(P² + Q²). Returns null when apparent power is ~0. */
function pqToPf(pacW, qacVar) {
  const p = Number(pacW);
  const q = Number(qacVar);
  if (!Number.isFinite(p) || !Number.isFinite(q)) return null;
  const s = Math.sqrt(p * p + q * q);
  if (s < 1) return null;
  return Math.abs(p) / s;
}

function defaultParams(overrides = {}) {
  let pf_steps = Array.isArray(overrides.pf_steps) && overrides.pf_steps.length > 0
    ? overrides.pf_steps.map((step) => ({
        pf: _clampPf(step?.pf),
        sign: _normalizeSign(step?.sign),
      }))
    : DEFAULT_PF_SWEEP.slice();
  return {
    pf_steps,
    hold_sec:        Math.max(20, Math.min(900,  Number(overrides.hold_sec)        || 60)),
    sample_period_s: Math.max(1,  Math.min(60,   Number(overrides.sample_period_s) || 2)),
    settle_sec:      Math.max(5,  Math.min(120,  Number(overrides.settle_sec)      || 15)),
    tolerance_pct:   Math.max(1,  Math.min(20,   Number(overrides.tolerance_pct)   || 5)),
  };
}

/**
 * runQvSweep(orchRun, fns)
 *
 * Drives the entire PF sweep end-to-end. Honours abort signal, flushes samples
 * to DB on each plateau end, restores reactive control on exit, and finalizes
 * the orchestrator with summary.
 */
async function runQvSweep(orchRun, fns) {
  if (!orchRun) throw new Error("runQvSweep: orchRun required");
  const { sendPhiTangent, disableReactive, sampleNode, sleepMs, nowFn } = fns || {};
  if (typeof sendPhiTangent  !== "function") throw new Error("sendPhiTangent fn required");
  if (typeof disableReactive !== "function") throw new Error("disableReactive fn required");
  if (typeof sampleNode      !== "function") throw new Error("sampleNode fn required");
  const wait = typeof sleepMs === "function" ? sleepMs : ((ms) => new Promise(r => setTimeout(r, ms)));
  // Optional virtual clock — same pattern as testT5 / testT2 so unit tests
  // with `sleepMs: () => Promise.resolve()` don't busy-spin wall time.
  let virtualNow = typeof nowFn === "function" ? nowFn() : null;
  const clock = (typeof nowFn === "function") ? () => virtualNow : Date.now;
  const advanceClock = (typeof nowFn === "function") ? (ms) => { virtualNow += Number(ms) || 0; } : () => {};

  const p = defaultParams(orchRun.params);
  const targets = Array.isArray(orchRun.target_inverters) ? orchRun.target_inverters : [];
  if (targets.length === 0) {
    console.error(`[compliance][T3] run_id=${orchRun.run_id || "?"} aborted: no target inverters`);
    orchRun.finalize({ status: "failed", error: new Error("no target inverters") });
    return { ok: false };
  }

  console.log(
    `[compliance][T3] run_id=${orchRun.run_id || "?"} starting ${p.pf_steps.length}-step PF sweep ` +
    `on ${targets.length} target(s) — hold=${p.hold_sec}s settle=${p.settle_sec}s tol=±${p.tolerance_pct}pp`,
  );

  const stepResults = [];
  try {
    for (let i = 0; i < p.pf_steps.length; i++) {
      if (orchRun.abortRequested) {
        console.warn(`[compliance][T3] run_id=${orchRun.run_id || "?"} abort requested at step ${i}/${p.pf_steps.length}`);
        break;
      }
      const stepSpec = p.pf_steps[i];
      const phi_raw = pfToPhiRaw(stepSpec.pf, stepSpec.sign);
      const stepName = `pf_${stepSpec.pf.toFixed(2)}_${stepSpec.sign}`;
      console.log(`[compliance][T3] step ${i + 1}/${p.pf_steps.length} → target PF ${stepSpec.pf} ${stepSpec.sign} (phi_raw=${phi_raw})`);
      const step = orchRun.beginStep({
        step_idx: i,
        step_name: stepName,
        target_value: stepSpec.pf,
        target_meta: { sign: stepSpec.sign, phi_raw },
      });

      // Send cmd 1 (set_phi_tangent) to every target node.
      let writeOk = true;
      for (const t of targets) {
        try {
          const ok = await sendPhiTangent(t.ip, t.slave, phi_raw);
          if (!ok) writeOk = false;
        } catch (e) {
          writeOk = false;
        }
      }
      if (!writeOk) {
        console.error(`[compliance][T3] step ${i + 1} write failed (phi_raw=${phi_raw}); marking FAIL and continuing`);
        orchRun.endStep(step, { pass: false, notes: `phi_tangent write failed (raw=${phi_raw})` });
        stepResults.push({ ...stepSpec, phi_raw, observedPf: null, deviation: null, pass: false });
        continue;
      }

      // Sample throughout the hold window. First settle_sec is excluded from
      // steady-state averaging.
      const holdMs = p.hold_sec * 1000;
      const tickMs = p.sample_period_s * 1000;
      const startedAt = clock();
      const settleMs = p.settle_sec * 1000;
      const acks = []; // post-settle samples used for steady-state averaging

      while (clock() - startedAt < holdMs) {
        if (orchRun.abortRequested) break;
        const tick = clock();
        for (const t of targets) {
          try {
            const sample = await sampleNode(t.ip, t.slave);
            if (sample) {
              orchRun.pushSample({ ...sample, ts_ms: tick, inverter_ip: t.ip, slave: t.slave });
              if (tick - startedAt >= settleMs) {
                acks.push({
                  ts: tick,
                  pac_w:   sample.pac_w,
                  qac_var: sample.qac_var,
                  vac_avg_v: sample.vac_avg_v,
                  cosphi:  sample.cosphi,
                  ip: t.ip, slave: t.slave,
                });
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

      // Steady-state PF estimate from post-settle samples. Prefer cosphi when
      // it's a reasonable value (0.50–1.00 absolute); otherwise derive from P+Q.
      let sumPf = 0, nPf = 0, sumP = 0, sumQ = 0, sumV = 0, nV = 0;
      for (const a of acks) {
        const cosphi = Number(a.cosphi);
        if (Number.isFinite(cosphi) && Math.abs(cosphi) >= 0.50 && Math.abs(cosphi) <= 1.00) {
          sumPf += Math.abs(cosphi); nPf += 1;
        } else {
          const derived = pqToPf(a.pac_w, a.qac_var);
          if (derived != null) { sumPf += derived; nPf += 1; }
        }
        if (a.pac_w   != null) sumP += Number(a.pac_w);
        if (a.qac_var != null) sumQ += Number(a.qac_var);
        if (a.vac_avg_v != null) { sumV += Number(a.vac_avg_v); nV += 1; }
      }
      const observedPf  = nPf > 0 ? (sumPf / nPf) : null;
      const observedP_w = acks.length > 0 ? (sumP / acks.length) : null;
      const observedQ_var = acks.length > 0 ? (sumQ / acks.length) : null;
      const observedV   = nV > 0 ? (sumV / nV) : null;
      // Deviation expressed as percentage points (PF * 100). Tolerance default 5 %.
      const deviation = observedPf == null ? null : Math.abs((observedPf - stepSpec.pf) * 100);
      const pass = deviation == null ? null : deviation <= p.tolerance_pct;

      orchRun.endStep(step, {
        achieved_value: observedPf,
        deviation_pct: deviation,
        pass,
        observed_meta: {
          observed_pf:    observedPf,
          observed_p_w:   observedP_w,
          observed_q_var: observedQ_var,
          observed_v_avg: observedV,
          samples_after_settle: acks.length,
        },
        notes: nPf > 0
          ? `${nPf} PF samples after settle (target ${stepSpec.pf} ${stepSpec.sign})`
          : "no usable PF samples post-settle",
      });
      const passLbl = pass === true ? "PASS" : pass === false ? "FAIL" : "SKIP";
      console.log(
        `[compliance][T3] step ${i + 1} ${passLbl} — observed PF ${observedPf == null ? "—" : observedPf.toFixed(3)} ` +
        `(dev ${deviation == null ? "—" : deviation.toFixed(2) + "pp"}, ${acks.length} post-settle samples)`,
      );
      stepResults.push({
        ...stepSpec, phi_raw,
        observedPf, observedP_w, observedQ_var, observedV,
        deviation, pass,
      });
    }
  } catch (err) {
    console.error(`[compliance][T3] run_id=${orchRun.run_id || "?"} CRASHED mid-sweep: ${err.message} — attempting reactive restoration`);
    // Best-effort restore even on mid-sweep crash.
    try {
      for (const t of targets) await disableReactive(t.ip, t.slave);
      console.log(`[compliance][T3] restoration after crash OK (${targets.length} target(s) released)`);
    } catch (rErr) {
      console.error(`[compliance][T3] restoration FAILED after crash: ${rErr.message} — operator intervention required`);
    }
    orchRun.finalize({ status: "failed", error: err });
    return { ok: false, error: err.message };
  }

  // Always restore reactive control to default (cmd 11) on exit so we never
  // leave the plant in a curtailed PF state.
  let restoreOk = true;
  try {
    for (const t of targets) {
      const ok = await disableReactive(t.ip, t.slave);
      if (!ok) restoreOk = false;
    }
  } catch (rErr) {
    restoreOk = false;
    console.error(`[compliance][T3] restoration error: ${rErr.message}`);
  }
  if (!restoreOk) {
    console.error(`[compliance][T3] restoration partially failed — operator must verify holding 41008 reads 0 on all ${targets.length} target(s)`);
  }

  const passes = stepResults.filter(r => r.pass === true).length;
  const fails  = stepResults.filter(r => r.pass === false).length;
  // Restoration failure is a SAFETY issue (plant left mid-sweep PF); do not
  // present it as a clean "completed" run even if every measured step passed.
  // The status the operator sees in the UI must surface the unsafe end-state.
  const stepsClean = fails === 0 && passes > 0;
  const status = orchRun.abortRequested ? "aborted"
               : (!restoreOk ? "completed_with_warnings"
               : (stepsClean ? "completed" : "failed"));
  console.log(
    `[compliance][T3] run_id=${orchRun.run_id || "?"} ${status.toUpperCase()} — ` +
    `${passes} pass / ${fails} fail / ${stepResults.length - passes - fails} skip; restoration=${restoreOk ? "ok" : "PARTIAL"}`,
  );

  orchRun.finalize({
    status,
    summary: {
      steps: stepResults.length,
      passes, fails,
      params: p,
      // Q-V capability series for the report chart: (V, Q) per step.
      qv_series: stepResults
        .filter(r => r.observedV != null && r.observedQ_var != null)
        .map(r => ({
          target_pf: r.pf,
          sign: r.sign,
          v: Number(r.observedV.toFixed(2)),
          q_var: Number(r.observedQ_var.toFixed(0)),
          observed_pf: r.observedPf == null ? null : Number(r.observedPf.toFixed(4)),
        })),
    },
  });
  return { ok: true, status, steps: stepResults };
}

module.exports = {
  runQvSweep,
  defaultParams,
  pfToPhiRaw,
  pqToPf,
  DEFAULT_PF_SWEEP,
  PHI_RAW_MAX,
};
