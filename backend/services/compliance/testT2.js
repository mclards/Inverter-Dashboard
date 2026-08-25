"use strict";

/**
 * testT2.js — PGC 2016 GCR 4.4.4.3 Frequency Withstand observation.
 *
 * Plan: plans/2026-05-10-modbus-registers-official-revamp.md §4 Slice θ.5
 *
 * **Observation-only.** We cannot inject grid frequency from the inverter
 * side; this test runs while a witness uses an external grid simulator (or
 * during a natural grid event). The orchestrator captures
 *   • per-tick frequency (Fac, reg 30020)
 *   • inverter state (reg 30074)
 *   • alarm bitmap (reg 30007-30008)
 * for the configured duration (default 30 min).
 *
 * NGCP envelope (Country Code 42 = Philippines, per [docs/Grid_Compliance_Testing_Manual_PGC2016.docx](../../docs/Grid_Compliance_Testing_Manual_PGC2016.docx)):
 *   • Continuous-stable band: 59.7–60.3 Hz
 *   • Withstand band:         58.2–61.8 Hz (no disconnect, ≥ 1 hour)
 *   • Trip-allowed:           ≤ 57.6 Hz after 5 s; 61.8–62.4 Hz with ≥ 5 min ride-through
 */

const NGCP_CONTINUOUS_LO = 59.7;
const NGCP_CONTINUOUS_HI = 60.3;
const NGCP_WITHSTAND_LO  = 58.2;
const NGCP_WITHSTAND_HI  = 61.8;

function defaultParams(overrides = {}) {
  return {
    duration_sec:    Math.max(60, Math.min(7200, Number(overrides.duration_sec)    || 1800)),
    // v2.11.x — clamp range widened from 1-10s → 1-60s. The earlier 10s
    // ceiling silently throttled operator inputs (e.g. 30s requested →
    // actual 10s applied) and showed misleading sample-cadence in the
    // live feed. 60s upper bound still gives ≥ 1 sample/min for the
    // shortest legal duration (60s), so the orchestrator never returns
    // a zero-sample run.
    sample_period_s: Math.max(1,  Math.min(60,   Number(overrides.sample_period_s) || 2)),
  };
}

/**
 * runFrequencyObservation(orchRun, fns)
 * @param {object} fns
 * @param {function(ip,slave):Promise<{ts_ms,freq_hz,state_raw,alarm_32,...}>} fns.sampleNode
 */
async function runFrequencyObservation(orchRun, fns) {
  if (!orchRun) throw new Error("runFrequencyObservation: orchRun required");
  const { sampleNode, sleepMs, nowFn } = fns || {};
  if (typeof sampleNode !== "function") throw new Error("sampleNode fn required");
  const wait = typeof sleepMs === "function" ? sleepMs : ((ms) => new Promise(r => setTimeout(r, ms)));
  let virtualNow = typeof nowFn === "function" ? nowFn() : null;
  const clock = (typeof nowFn === "function") ? () => virtualNow : Date.now;
  const advanceClock = (typeof nowFn === "function") ? (ms) => { virtualNow += Number(ms) || 0; } : () => {};

  const p = defaultParams(orchRun.params);
  const targets = Array.isArray(orchRun.target_inverters) ? orchRun.target_inverters : [];
  if (targets.length === 0) {
    console.error(`[compliance][T2] run_id=${orchRun.run_id || "?"} aborted: no target inverters`);
    orchRun.finalize({ status: "failed", error: new Error("no target inverters") });
    return { ok: false };
  }

  console.log(
    `[compliance][T2] run_id=${orchRun.run_id || "?"} starting ${Math.round(p.duration_sec / 60)}-min ` +
    `frequency-withstand observation on ${targets.length} target(s) (sample every ${p.sample_period_s}s, ` +
    `NGCP envelope continuous=${NGCP_CONTINUOUS_LO}-${NGCP_CONTINUOUS_HI}Hz withstand=${NGCP_WITHSTAND_LO}-${NGCP_WITHSTAND_HI}Hz)`,
  );

  const startedAt = clock();
  const endsAt = startedAt + p.duration_sec * 1000;
  const tickMs = p.sample_period_s * 1000;
  // Heartbeat at most once per minute so a long observation doesn't go silent.
  let lastHeartbeatMs = startedAt;
  const HEARTBEAT_MS = 60_000;

  // We don't carve up the run into discrete steps — it's a continuous
  // observation. We still record one logical "observation" step to keep
  // the report generator's per-step shape happy.
  const step = orchRun.beginStep({
    step_idx: 0, step_name: "frequency_observation",
    target_value: 60.0,
  });

  const tally = {
    samples: 0,
    inContinuous: 0,
    inWithstand: 0,
    outsideWithstand: 0,
    // unitMismatch: samples whose freq_hz fell outside the plausible 45..65
    // Hz envelope. Indicates a transducer reporting cHz (×100) rather than
    // an actual grid excursion. Surfaced in the run summary so the
    // operator notices the bad data path instead of misreading it as a
    // grid event.
    unitMismatch: 0,
    minHz: null, maxHz: null, sumHz: 0, nFreq: 0,
    excursionStartTs: null,
    longestExcursionMs: 0,
    alarmEvents: 0,
    stateChanges: 0,
    lastStateRaw: new Map(),
  };

  try {
    while (clock() < endsAt) {
      if (orchRun.abortRequested) break;
      const tick = clock();
      let inExcursionThisTick = false;
      for (const t of targets) {
        try {
          const sample = await sampleNode(t.ip, t.slave);
          if (!sample) continue;
          orchRun.pushSample({ ...sample, ts_ms: tick, inverter_ip: t.ip, slave: t.slave });
          tally.samples += 1;

          // Sanity-clamp freq_hz to a plausible Hz range (45..65) before
          // bucketing. Some firmware revisions or comm boards have been
          // observed reporting cHz (×100) instead of Hz; without this
          // gate, a 60 Hz reading at cHz scale (6000) would land in
          // "outsideWithstand" and false-fail the test even though the
          // grid is healthy. Out-of-range values get counted as
          // unitMismatch so the operator can spot the bad transducer
          // instead of silently inflating the outside-envelope tally.
          const f = Number(sample.freq_hz);
          if (Number.isFinite(f) && f > 0) {
            if (f < 45 || f > 65) {
              tally.unitMismatch = (tally.unitMismatch || 0) + 1;
            } else {
              if (f >= NGCP_CONTINUOUS_LO && f <= NGCP_CONTINUOUS_HI) tally.inContinuous += 1;
              else if (f >= NGCP_WITHSTAND_LO && f <= NGCP_WITHSTAND_HI) {
                tally.inWithstand += 1;
                inExcursionThisTick = true;
              } else {
                tally.outsideWithstand += 1;
                inExcursionThisTick = true;
              }
              tally.minHz = tally.minHz == null ? f : Math.min(tally.minHz, f);
              tally.maxHz = tally.maxHz == null ? f : Math.max(tally.maxHz, f);
              tally.sumHz += f; tally.nFreq += 1;
            }
          }

          // Track state changes (decoded raw differs from last seen).
          const key = `${t.ip}/${t.slave}`;
          const prev = tally.lastStateRaw.get(key);
          if (prev != null && Number.isFinite(Number(sample.state_raw)) && Number(sample.state_raw) !== prev) {
            tally.stateChanges += 1;
          }
          tally.lastStateRaw.set(key, Number(sample.state_raw));

          // Alarm transition counts.
          if (Number(sample.alarm_32) > 0) tally.alarmEvents += 1;
        } catch (_) { /* soft per-tick */ }
      }

      // Excursion timing
      if (inExcursionThisTick) {
        if (tally.excursionStartTs == null) tally.excursionStartTs = tick;
      } else if (tally.excursionStartTs != null) {
        const dur = tick - tally.excursionStartTs;
        if (dur > tally.longestExcursionMs) tally.longestExcursionMs = dur;
        tally.excursionStartTs = null;
      }

      // Flush to SQLite every 10 ticks so the persisted-sample count
      // visible to the operator (compliance_run_sample table + /status
      // endpoint) keeps up even when the chosen sample_period_s is high.
      // At 30 s cadence the earlier `% 100` rule meant 50 min between
      // flushes — operators saw "samples_persisted=0" for most of the run.
      if (tally.samples % 10 === 0) orchRun.flushSamples();

      // Heartbeat every minute so a 30-min observation isn't silent. Only logs
      // when at least HEARTBEAT_MS has elapsed since the last heartbeat.
      if (clock() - lastHeartbeatMs >= HEARTBEAT_MS) {
        lastHeartbeatMs = clock();
        const elapsedMin = Math.round((clock() - startedAt) / 60000);
        const remainingMin = Math.max(0, Math.round((endsAt - clock()) / 60000));
        const meanHzNow = tally.nFreq > 0 ? (tally.sumHz / tally.nFreq).toFixed(3) : "—";
        console.log(
          `[compliance][T2] heartbeat — ${elapsedMin}min elapsed (${remainingMin}min left), ` +
          `${tally.samples} samples, mean ${meanHzNow}Hz, alarms=${tally.alarmEvents}, excursions ms=${tally.longestExcursionMs}`,
        );
      }

      await wait(tickMs);
      advanceClock(tickMs);
    }

    if (orchRun.abortRequested) {
      console.warn(`[compliance][T2] run_id=${orchRun.run_id || "?"} abort requested mid-observation`);
    }

    orchRun.flushSamples();

    // Close any open excursion at end of run.
    if (tally.excursionStartTs != null) {
      const dur = clock() - tally.excursionStartTs;
      if (dur > tally.longestExcursionMs) tally.longestExcursionMs = dur;
    }

    const meanHz = tally.nFreq > 0 ? tally.sumHz / tally.nFreq : null;
    const allInContinuous = tally.outsideWithstand === 0 && tally.inWithstand === 0;
    orchRun.endStep(step, {
      achieved_value: meanHz,
      deviation_pct: meanHz == null ? null : Math.abs((meanHz - 60.0) / 60.0) * 100,
      pass: allInContinuous,
      notes: `samples=${tally.samples}, alarms=${tally.alarmEvents}, state_changes=${tally.stateChanges}, longest_excursion_ms=${tally.longestExcursionMs}`,
    });

    const finalStatus = orchRun.abortRequested ? "aborted" : "completed";
    const unitMismatchNote = tally.unitMismatch > 0
      ? `, unit_mismatch=${tally.unitMismatch} (freq outside 45..65 Hz — check transducer scaling)`
      : "";
    console.log(
      `[compliance][T2] run_id=${orchRun.run_id || "?"} ${finalStatus.toUpperCase()} — ` +
      `${tally.samples} samples, mean ${meanHz == null ? "—" : meanHz.toFixed(3) + "Hz"}, ` +
      `min/max ${tally.minHz ?? "—"}/${tally.maxHz ?? "—"}, ` +
      `${tally.inContinuous} in-continuous / ${tally.inWithstand} in-withstand / ${tally.outsideWithstand} outside, ` +
      `pass=${allInContinuous}${unitMismatchNote}`,
    );

    orchRun.finalize({
      status: finalStatus,
      summary: {
        samples: tally.samples,
        in_continuous_band: tally.inContinuous,
        in_withstand_band: tally.inWithstand,
        outside_withstand_band: tally.outsideWithstand,
        unit_mismatch_samples: tally.unitMismatch,
        min_hz: tally.minHz,
        max_hz: tally.maxHz,
        mean_hz: meanHz,
        longest_excursion_ms: tally.longestExcursionMs,
        alarm_events: tally.alarmEvents,
        state_changes: tally.stateChanges,
        ngcp_envelope: {
          continuous: [NGCP_CONTINUOUS_LO, NGCP_CONTINUOUS_HI],
          withstand:  [NGCP_WITHSTAND_LO,  NGCP_WITHSTAND_HI],
        },
      },
    });
    return { ok: true };
  } catch (err) {
    console.error(`[compliance][T2] run_id=${orchRun.run_id || "?"} CRASHED: ${err.message}`);
    orchRun.finalize({ status: "failed", error: err });
    return { ok: false, error: err.message };
  }
}

module.exports = {
  runFrequencyObservation,
  defaultParams,
  NGCP_CONTINUOUS_LO, NGCP_CONTINUOUS_HI,
  NGCP_WITHSTAND_LO,  NGCP_WITHSTAND_HI,
};
