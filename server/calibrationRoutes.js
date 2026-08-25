// Field Calibration routes — Phases 1-4.
//
// Phase 1: read-only (state, full-config, fleet-summary, feature-status)
// Phase 2: session lifecycle + single-register write + audit log
// Phase 3: consign-mode (10/20/60/70 % via cmd-3 APC) under active session
// Phase 4: bulk copy with hardware-fingerprint match
//
// Plan: plans/2026-05-12-inverter-calibration-tool.md
//
// All write surfaces are gated by:
//   • calibrationWritesEnabled feature flag (default OFF)
//   • topology-auth (adsiM/adsiMM) for session start/end
//   • adsiMM bulk auth per write call
//   • active calibration_session_id whose target matches the write target
//   • critical-block check on the target inverter
//   • range guard (≤ 50 % delta unless operator overrides)
//   • read-back verify with sentinel preservation check
//
// Phase 1 endpoints stay open as before (topology auth only — read-only).

"use strict";

const calibrationSession = require("./calibrationSession");
const calibrationSafety = require("./calibrationSafety");

// TrinPM20 writable offsets — used to pre-compute writability map.
const WRITABLE_OFFSETS = [81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94];

// Non-bypassable display-only calibration offsets (force_safety_gate
// cannot override). This is a live-Modbus tool; the set is the hard
// backstop. CORRECTION HISTORY (audits/2026-05-17/...reactive-blink-logic.md
// §15–§16, operator directives):
//   • 90 Per. Vacio — removed: ISM CfgTrifAU classifies it a writable
//     scale factor; editable, 0 %-consign band gate (bypassable).
//   • 91 Pot. Reactiv_X1 / 94 Comp. Reacti_Y2 — removed: the operator
//     found large fleet-anomaly drift on these (suspected bad prior
//     edits) and decided to enable writes for in-field correction. They
//     keep their consign-band SAFETY gate in calibrationSafety.js
//     (91 @20 %, 94 @70 %, same as Y1/X2, bypassable) — just no longer
//     NON-bypassably refused.
// The set is now EMPTY: every writable offset (81-94) is gated only by
// the bypassable per-offset consign/state gate. The guard below is kept
// (defensive, re-populatable) but currently never fires.
const CALIB_DISPLAY_ONLY_OFFSETS = new Set([]);

const KNOWN_INVERTERS_MAX = 27;
const KNOWN_NODES_PER_INV = [1, 2, 3, 4];

function registerCalibrationRoutes(app, deps) {
  const {
    isRemoteMode,
    proxyToRemote,
    requireTopologyAuth,
    callPython,
    loadIpConfigFromDb,
    getConfiguredNodeSet,
    isAuthorizedPlantWideControl,
    getActiveCriticalBlock,
    isCalibrationWritesEnabled,    // feature-flag getter (default false)
    setSetting,                     // settings persister (calibration-feature toggle)
    insertCalibrationSnapshot,
    getLatestCalibrationSnapshot,
    listCalibrationSnapshots,
    getCalibrationSnapshotById,
    deleteCalibrationSnapshotById,
    insertCalibrationWriteLog,
    listCalibrationWriteLog,
    insertCalibrationSession,
    updateCalibrationSessionEnd,
    getCalibrationSession,
    listRecentCalibrationSessions,
    insertAuditLogRow,
    broadcastUpdate,                // WS push for session banner
    setActivePowerPct,               // existing cmd-3 wrapper (Python POST /write)
  } = deps;

  // ── Helpers ──────────────────────────────────────────────────────────

  function resolveIp(inv) {
    const cfg = loadIpConfigFromDb();
    return cfg?.inverters?.[inv] || cfg?.inverters?.[String(inv)] || null;
  }

  function validateInvSlave(req, res) {
    const inv = Number(req.params.inverter);
    const slave = Number(req.params.slave);
    if (!Number.isInteger(inv) || inv < 1 || inv > KNOWN_INVERTERS_MAX) {
      res.status(400).json({ ok: false, error: `inverter must be 1..${KNOWN_INVERTERS_MAX}` });
      return null;
    }
    if (!KNOWN_NODES_PER_INV.includes(slave)) {
      res.status(400).json({ ok: false, error: `slave must be one of ${KNOWN_NODES_PER_INV.join(",")}` });
      return null;
    }
    const ip = resolveIp(inv);
    if (!ip) {
      res.status(404).json({ ok: false, error: `no IP configured for inverter ${inv}` });
      return null;
    }
    return { inv, slave, ip };
  }

  function requireWritesEnabled(req, res, next) {
    if (typeof isCalibrationWritesEnabled === "function" && !isCalibrationWritesEnabled()) {
      return res.status(503).json({
        ok: false,
        error: "Calibration writes are disabled. Set `calibrationWritesEnabled` in Settings after sign-off.",
      });
    }
    next();
  }

  function requireBulkAuth(req, res, next) {
    if (typeof isAuthorizedPlantWideControl !== "function" || !isAuthorizedPlantWideControl(req.body || {}, req)) {
      return res.status(403).json({ ok: false, error: "Authorization required (adsiMM)." });
    }
    next();
  }

  function requireActiveSession(req, res, next) {
    if (!calibrationSession.isActive()) {
      return res.status(409).json({ ok: false, error: "No active calibration session. Start one first." });
    }
    const body = req.body || {};
    const sid = String(body.session_id || "").trim();
    const cur = calibrationSession.currentSession();
    if (!sid || sid !== cur.session_id) {
      return res.status(409).json({ ok: false, error: "Session id mismatch — heartbeat may have expired." });
    }
    req._session = cur;
    next();
  }

  function checkCriticalBlock(inv) {
    if (typeof getActiveCriticalBlock !== "function") return null;
    try {
      const blk = getActiveCriticalBlock(inv);
      if (blk && !blk.acked_at_ms) {
        return {
          status: 423,
          error: `Inverter ${inv} is critically-blocked (${blk.pattern_hex}). Acknowledge the block first.`,
          pattern_hex: blk.pattern_hex,
          pattern_key: blk.pattern_key,
        };
      }
    } catch (_) {}
    return null;
  }

  // v2.11.0-beta.6 Slice κ.10 — TrinPM20 per-offset safety gate.
  //
  // Fetches a fresh state+pct_of_pn snapshot from Python and runs each
  // proposed write through `evaluateWriteSafety`. Returns null when every
  // offset clears the gate (or when the caller passed
  // `force_safety_gate=true` and we should warn-only); returns a 409-shaped
  // error object when at least one gate fires.
  async function checkTrinPmSafetyGates(ip, slave, offsets, opts) {
    // NON-BYPASSABLE backstop — refuse any offset in
    // CALIB_DISPLAY_ONLY_OFFSETS before anything else, so force_safety_gate
    // cannot override. That set is currently EMPTY (2026-05-17: 90, 91 and
    // 94 were all re-enabled by operator directive — see the set's comment
    // + audit §15/§16); every writable offset is now governed only by the
    // bypassable consign/state gate in calibrationSafety.js. This guard is
    // retained defensively so re-restricting an offset is a one-line change.
    const _DO_NAMES = { 90: "Per. Vacio", 91: "Pot. Reactiv_X1",
      92: "Comp. Reacti_Y1", 93: "Pot. Reactiv_X2", 94: "Comp. Reacti_Y2" };
    const _doName = (o) => _DO_NAMES[o] || `offset ${o}`;
    const lockedHit = (offsets || [])
      .map(Number)
      .filter((o) => CALIB_DISPLAY_ONLY_OFFSETS.has(o));
    if (lockedHit.length) {
      return {
        status: 409,
        error: "Calibration parameter(s) refused (non-bypassable, "
          + "display-only by configuration): "
          + lockedHit.map((o) => `${_doName(o)} (offset ${o})`).join(", ")
          + ".",
        gates: lockedHit.map((o) => ({
          offset: o,
          ok: false,
          severity: "block",
          reason: `Offset ${o} (${_doName(o)}) is configured display-only `
            + "— write refused, non-bypassable.",
        })),
        non_bypassable: true,
      };
    }
    const force = !!(opts && (opts.force_safety_gate === true
      || opts.force_safety_gate === "1" || opts.force_safety_gate === 1));
    let state;
    try {
      state = await callPython(
        `/calibration/state/${encodeURIComponent(ip)}/${slave}`, "GET",
      );
    } catch (err) {
      return {
        status: 502,
        error: `safety preflight read failed: ${err?.message || err}`,
      };
    }
    if (!state?.ok || !state.live) {
      return { status: 424, error: "safety preflight returned no live snapshot" };
    }
    const verdicts = offsets.map((off) =>
      calibrationSafety.evaluateWriteSafety(off, state.live));
    const blocking = verdicts.filter((v) => !v.ok && v.severity === "block");
    if (!blocking.length) return { ok: true, verdicts, live: state.live };
    if (force) {
      // Caller explicitly overrode — return verdicts so caller can audit
      // the reasons, but don't block the write.
      return { ok: true, verdicts, live: state.live, forced: true,
               blocking_reasons: blocking.map((v) => v.reason) };
    }
    return {
      status: 409,
      error: "TrinPM20 safety gate refused write — see `gates`.",
      gates: blocking,
      live: state.live,
    };
  }

  function broadcastSessionState(eventKind = "update") {
    if (typeof broadcastUpdate !== "function") return;
    try {
      broadcastUpdate({
        type: "calibration_session",
        kind: eventKind,
        active: calibrationSession.isActive(),
        session: calibrationSession.currentSession(),
        at_ms: Date.now(),
      });
    } catch (_) {}
  }

  // Push lockdown state to the Python service on every lifecycle event
  // so the auto-reset loop (and any future Python guards) can suspend
  // their tick against the target inverter.
  async function _pushLockdown(active, session) {
    try {
      await callPython("/calibration/lockdown", "POST", active ? {
        active: true,
        inverter: session?.inverter,
        slave:    session?.slave,
        session_id: session?.session_id,
      } : { active: false });
    } catch (err) {
      console.warn("[calibration] lockdown push failed:", err?.message);
    }
  }

  // Auto-broadcast session lifecycle events from the session module.
  calibrationSession.subscribe((ev) => {
    broadcastSessionState(ev.kind);
    if (ev.kind === "begin") {
      _pushLockdown(true, ev.session);
    } else if (ev.kind === "end" || ev.kind === "abort" || ev.kind === "auto_end") {
      _pushLockdown(false, null);
    }
  });

  // ── PHASE 1: read endpoints ──────────────────────────────────────────

  // v2.11.x — read-only Modbus probe. Operator preference (2026-05-13):
  // diagnostic reads should never trigger the auth modal — same trust
  // level as the IGBT/Contactor live telemetry. Only state-CHANGING
  // routes (write/restore/copy/consign/session/feature-toggle) gate on
  // topology auth from here on.
  app.get("/api/calibration/state/:inverter/:slave", async (req, res) => {
    if (isRemoteMode()) return proxyToRemote(req, res);
    const t = validateInvSlave(req, res); if (!t) return;
    try {
      const result = await callPython(
        `/calibration/state/${encodeURIComponent(t.ip)}/${t.slave}`, "GET");
      if (result?.ok) result.inverter = t.inv;
      // If session is active for this target, surface session state so the
      // UI doesn't have to make a second call.
      result.session = calibrationSession.isTargetUnderCalibration(t.inv, t.slave)
        ? calibrationSession.currentSession()
        : null;
      // v2.11.0-beta.6 Slice κ.10 — per-offset writability verdict so the
      // UI can render Write buttons green/amber/red before the operator
      // clicks. Mirrors the TrinPM20 PDF gates (state, Pac/Pn band).
      if (result?.ok && result.live) {
        result.writability = calibrationSafety.buildWriteSafetyMap(
          result.live, WRITABLE_OFFSETS,
        );
      }
      return res.json(result);
    } catch (err) {
      return res.status(502).json({ ok: false, error: err?.message || String(err) });
    }
  });

  // Read-only — see comment on /state. PUBLIC: static field map (offsets/
  // kinds/groups/labels/units) used by the Utility Tool to render the
  // tab LAYOUT before any Modbus Read. No transport / no inverter needed.
  app.get("/api/calibration/cfg-map", async (req, res) => {
    if (isRemoteMode()) return proxyToRemote(req, res);
    try {
      const result = await callPython("/calibration/cfg-map", "GET");
      return res.json(result);
    } catch (err) {
      return res.status(502).json({ ok: false, error: err?.message || String(err) });
    }
  });

  // Read-only — see comment on /state.
  app.get("/api/calibration/full-config/:inverter/:slave", async (req, res) => {
    if (isRemoteMode()) return proxyToRemote(req, res);
    const t = validateInvSlave(req, res); if (!t) return;
    try {
      const result = await callPython(
        `/calibration/full-config/${encodeURIComponent(t.ip)}/${t.slave}`, "GET");
      if (result?.ok) result.inverter = t.inv;
      return res.json(result);
    } catch (err) {
      return res.status(502).json({ ok: false, error: err?.message || String(err) });
    }
  });

  // v2.11.x — fleet-scan hardening (operator-visible polling + graceful
  // failure handling). The scan is a long-running probe that:
  //   • runs N concurrent worker tasks against /calibration/state for
  //     every (inv, slave) pair in ipConfig — fan-out kept modest (4) so
  //     the shared Modbus bus isn't hammered;
  //   • applies a per-node soft timeout (8 s) so one hung inverter cannot
  //     stall the whole scan — the slow node gets recorded as a failure
  //     with reason="timeout" and the scan moves on;
  //   • categorises failures into {timeout, http_error, py_error,
  //     modbus_error} so the operator can triage quickly;
  //   • exposes live progress via the in-memory `_fleetScanProgress`
  //     object the renderer polls through /feature-status (extended).
  // v2.11.x — operator preference (2026-05-13): scanning was too aggressive.
  // Slow inverters were timing out at 8 s and the bus contention from 4
  // parallel workers caused cascading timeouts. Loosened to:
  //   • 20 s per-node soft timeout (matches what per-node Read tolerates)
  //   • 2 concurrent workers (gentle on the shared Modbus bus)
  //   • 250 ms inter-task delay between worker pickups (rate-limit politeness)
  //   • round-robin queue + per-IP lock — eliminates the bug where two
  //     workers both pulled tasks for the same IP, contending on the
  //     single-master Modbus TCP socket and timing out one of them.
  //     Symptom that exposed it: nodes that "failed" in the fleet scan
  //     scanned successfully via per-node Read because the per-node path
  //     was un-contended.
  const FLEET_SCAN_NODE_TIMEOUT_MS = 20000;
  const FLEET_SCAN_CONCURRENCY     = 2;
  const FLEET_SCAN_INTER_TASK_MS   = 250;
  let _fleetScanInFlight = false;
  // Per-IP serialisation map — `Promise` per IP that the next worker
  // hitting that IP must `await` before firing its own probe. Cleared
  // when each scan completes.
  const _fleetScanIpLocks = new Map();
  let _fleetScanProgress = { total: 0, done: 0, failed: 0, started_at_ms: 0, current: null };

  function _withNodeTimeout(promise, ms, ip, slave) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const e = new Error(`node ${ip}/${slave} timed out after ${ms} ms`);
          e.code = "timeout";
          reject(e);
        }, ms);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  // v2.11.x — fleet-summary is a READ-ONLY diagnostic that scans every
  // configured node's calibration block and reports outliers vs the fleet
  // median. Operator preference (2026-05-13): this is "look-don't-touch"
  // analytics — same trust level as the IGBT/Contactor fleet table — so
  // it does NOT require the topology key. The data it returns reveals no
  // secrets (just the same scale-factor values the per-node Read button
  // shows) and the scan workload is gated by the in-flight singleton +
  // 4-worker concurrency cap, so it can't be abused for DoS.
  app.get("/api/calibration/fleet-summary", async (req, res) => {
    if (isRemoteMode()) return proxyToRemote(req, res);
    if (_fleetScanInFlight) {
      return res.status(429).json({
        ok: false, error: "fleet scan already running",
        progress: { ..._fleetScanProgress },
      });
    }
    _fleetScanInFlight = true;
    _fleetScanProgress = { total: 0, done: 0, failed: 0, started_at_ms: Date.now(), current: null };
    try {
      const cfg = loadIpConfigFromDb();
      const inverters = cfg?.inverters || {};
      const units = cfg?.units || {};
      // Build a per-inverter queue first, then INTERLEAVE so the final
      // queue rotates through inverters one-slave-at-a-time:
      //   [inv1/s1, inv2/s1, inv3/s1, ..., inv1/s2, inv2/s2, ...]
      // With 2 concurrent workers this guarantees they pull tasks against
      // DIFFERENT IPs at the same time — no Modbus bus contention.
      const perInv = [];
      const sortedInvs = Object.keys(inverters).map(Number)
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= KNOWN_INVERTERS_MAX)
        .sort((a, b) => a - b);
      for (const inv of sortedInvs) {
        const ip = inverters[inv] || inverters[String(inv)];
        if (!ip) continue;
        const unitsRaw = units?.[inv] ?? units?.[String(inv)] ?? KNOWN_NODES_PER_INV;
        const unitList = Array.isArray(unitsRaw)
          ? unitsRaw.map(Number).filter((n) => KNOWN_NODES_PER_INV.includes(n))
          : KNOWN_NODES_PER_INV.slice();
        const tasks = unitList.map((slave) => ({ inverter: inv, slave, ip }));
        if (tasks.length) perInv.push(tasks);
      }
      // Interleave by index — round-robin merge of the per-inverter lists.
      const queue = [];
      const maxLen = Math.max(0, ...perInv.map((arr) => arr.length));
      for (let i = 0; i < maxLen; i++) {
        for (const arr of perInv) if (i < arr.length) queue.push(arr[i]);
      }
      _fleetScanProgress.total = queue.length;
      _fleetScanIpLocks.clear();

      const perNode = [];
      const failures = [];
      let qIdx = 0;
      // Pop tasks off the shared queue index — `qIdx++` is atomic in V8's
      // single-threaded event loop, so workers never collide on a task.
      // Probe one node, with one automatic retry on transient errors
      // (py_error / timeout). Most "py_error" failures we've seen in the
      // field are transient — a Modbus poll racing with a slow inverter
      // recovery. Retrying after a short delay drops the failure rate
      // dramatically without a meaningful wall-clock cost (only applies
      // to the small set of nodes that actually fail).
      // Per-IP serialisation: queue this task behind any in-flight probe
      // for the SAME IP. The interleaved queue makes collisions rare, but
      // edge cases (e.g. an inverter has more nodes than there are workers
      // worth of other inverters in flight) can still happen — the lock
      // keeps the Modbus bus single-master-per-IP no matter what.
      async function probeOnce(task) {
        const prev = _fleetScanIpLocks.get(task.ip) || Promise.resolve();
        let release;
        const next = new Promise((r) => { release = r; });
        _fleetScanIpLocks.set(task.ip, prev.then(() => next));
        try {
          await prev;   // wait for any earlier probe on this IP to finish
          return await _withNodeTimeout(
            callPython(`/calibration/state/${encodeURIComponent(task.ip)}/${task.slave}`, "GET"),
            FLEET_SCAN_NODE_TIMEOUT_MS, task.ip, task.slave,
          );
        } finally {
          release();
          // Trim the chain when this is the last task for that IP — keeps
          // the map from growing unboundedly mid-scan.
          if (_fleetScanIpLocks.get(task.ip) === prev.then(() => next)) {
            _fleetScanIpLocks.delete(task.ip);
          }
        }
      }
      function categorise(err) {
        const msg = err?.message || String(err);
        return {
          category:
            err?.code === "timeout"      ? "timeout" :
            /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/i.test(msg) ? "http_error" :
            /modbus|illegal data|exception code/i.test(msg)  ? "modbus_error" :
            "py_error",
          msg,
        };
      }

      async function worker() {
        for (;;) {
          const task = queue[qIdx++];
          if (!task) return;
          _fleetScanProgress.current = `inv ${task.inverter}/${task.slave}`;
          // Politeness delay between successive Modbus probes from the
          // same worker — keeps live polling on other dashboard panes
          // responsive while the scan runs in the background.
          if (qIdx > FLEET_SCAN_CONCURRENCY) {
            await new Promise((r) => setTimeout(r, FLEET_SCAN_INTER_TASK_MS));
          }
          let r = null;
          let lastErr = null;
          let lastCategory = null;
          // Up to 2 attempts (1 retry). Don't retry on http_error
          // (network unreachable — won't recover in 800 ms).
          for (let attempt = 1; attempt <= 2; attempt++) {
            try {
              r = await probeOnce(task);
              if (r?.ok) { lastErr = null; break; }
              // Soft Python-layer error — retry once unless the error
              // explicitly says the slave is missing.
              if (/no.*slave|slave.*not.*found|invalid.*unit/i.test(r?.error || "")) {
                lastErr = new Error(r.error);
                lastCategory = "missing_slave";
                break;
              }
              lastErr = new Error(r?.error || "py_error");
              lastCategory = "py_error";
            } catch (err) {
              lastErr = err;
              const cat = categorise(err);
              lastCategory = cat.category;
              if (cat.category === "http_error") break;  // don't retry network failure
            }
            if (attempt < 2) {
              // Brief backoff before retry — the inverter may have just
              // missed the first poll because of a competing operation.
              await new Promise((rr) => setTimeout(rr, 800));
            }
          }
          try {
            if (r?.ok) {
              perNode.push({
                inverter: task.inverter, slave: task.slave, ip: task.ip,
                calibration: r.calibration, read_at_ms: r.read_at_ms,
              });
            } else {
              const msg = lastErr?.message || String(lastErr || "unknown");
              failures.push({
                inverter: task.inverter, slave: task.slave, ip: task.ip,
                category: lastCategory || "py_error",
                error: msg,
              });
              _fleetScanProgress.failed += 1;
            }
          } finally {
            _fleetScanProgress.done += 1;
          }
        }
      }
      // Spin up `FLEET_SCAN_CONCURRENCY` workers and wait for the queue
      // to drain. Each worker is a separate async chain pulling from the
      // shared `queue` index.
      const workers = [];
      const n = Math.min(FLEET_SCAN_CONCURRENCY, queue.length || 1);
      for (let i = 0; i < n; i++) workers.push(worker());
      await Promise.all(workers);

      const summary = _aggregateFleet(perNode);
      // Tally failure categories so the renderer can show a one-line
      // breakdown ("3 timeouts, 1 modbus_error") without re-scanning.
      const failureBreakdown = failures.reduce((acc, f) => {
        acc[f.category] = (acc[f.category] || 0) + 1;
        return acc;
      }, {});
      return res.json({
        ok: true,
        scanned: perNode.length,
        failed:  failures.length,
        medians: summary.medians,
        per_node: summary.per_node,
        failures,
        failure_breakdown: failureBreakdown,
        duration_ms: Date.now() - _fleetScanProgress.started_at_ms,
        completed_at_ms: Date.now(),
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err?.message || String(err) });
    } finally {
      _fleetScanInFlight = false;
      _fleetScanProgress.current = null;
    }
  });

  // Lightweight progress probe — renderer polls this every 1 s during a
  // scan to update the progress bar without re-running the whole scan.
  app.get("/api/calibration/fleet-progress", (req, res) => {
    if (isRemoteMode()) return proxyToRemote(req, res);
    res.json({ ok: true, busy: _fleetScanInFlight, progress: { ..._fleetScanProgress } });
  });

  // Utility Tool fleet scan route removed 2026-05-20 — broken (duplicate
  // button id with Parameters Fleet Anomalies; the Utility Tool button
  // could never receive clicks). The Parameters page Fleet Anomalies scan
  // above is unrelated and remains in place.

  app.get("/api/calibration/feature-status", (req, res) => {
    if (isRemoteMode()) return proxyToRemote(req, res);
    const writesEnabled = typeof isCalibrationWritesEnabled === "function"
      ? !!isCalibrationWritesEnabled() : false;
    res.json({
      ok: true,
      phase: writesEnabled ? "writes-enabled" : "read-only",
      writes_enabled: writesEnabled,
      session_active: calibrationSession.isActive(),
      session: calibrationSession.currentSession(),
      fleet_scan_busy: _fleetScanInFlight,
    });
  });

  // Toggle `calibrationWritesEnabled` from the Field Calibration page.
  // Gateway-only (remote mode proxies). Topology-auth gated. Refuses
  // disable while a session is active.
  app.post("/api/calibration/feature-toggle", requireTopologyAuth, (req, res) => {
    if (isRemoteMode()) return proxyToRemote(req, res);
    if (typeof setSetting !== "function") {
      return res.status(500).json({ ok: false, error: "setSetting_unavailable" });
    }
    const enable = req.body?.enable === true || req.body?.enable === "1" || req.body?.enable === 1;
    if (!enable && calibrationSession.isActive()) {
      return res.status(409).json({ ok: false, error: "session_active" });
    }
    setSetting("calibrationWritesEnabled", enable ? "1" : "0");
    try {
      if (typeof insertAuditLogRow === "function") {
        insertAuditLogRow({
          actor: "operator",
          action: enable ? "calib_writes_enabled" : "calib_writes_disabled",
          detail: JSON.stringify({ via: "field_calibration_page" }),
        });
      }
    } catch (_) {}
    res.json({ ok: true, writes_enabled: enable });
  });

  // Read-only audit log — same trust as audit page.
  app.get("/api/calibration/audit-log", (req, res) => {
    if (isRemoteMode()) return proxyToRemote(req, res);
    try {
      const filters = {
        session_id: req.query?.session_id,
        inverter_id: req.query?.inverter ? Number(req.query.inverter) : undefined,
        slave: req.query?.slave ? Number(req.query.slave) : undefined,
        limit: req.query?.limit ? Number(req.query.limit) : 100,
      };
      const rows = listCalibrationWriteLog(filters);
      const sessions = listRecentCalibrationSessions(20);
      res.json({ ok: true, rows, sessions });
    } catch (err) {
      res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
  });

  // ── BACKUP / RESTORE ─────────────────────────────────────────────────
  //
  // Snapshot lifecycle:
  //   1. Session start → auto baseline snapshot (already wired)
  //   2. Session end   → auto post-write snapshot (already wired)
  //   3. Operator clicks "Backup Now" → manual snapshot (this section)
  //   4. Operator clicks "Restore" on a row → replays the 14 values via
  //      bulk write (requires active session + adsiMM auth).
  //
  // Snapshots are kept for 5 years (DB retention policy) and surfaced
  // per (inverter, slave) so the operator can compare or roll back at
  // any point.

  // Decode the space-delimited `reg_block_hex` field (15 decimal UInt16
  // values for offsets 80..94, stored in ascending-offset order) back
  // into a writable list of (offset, value) pairs for offsets 81..94.
  // Offset 80 (ValidCfgCode) is intentionally excluded — it's a sentinel,
  // not a writable scale factor.
  function _decodeSnapshotWrites(reg_block_hex) {
    const tokens = String(reg_block_hex || "")
      .split(/\s+/).filter(Boolean);
    if (tokens.length < 15) return [];
    const writes = [];
    for (let i = 0; i < 15; i++) {
      const off = 80 + i;
      if (off === 80) continue;            // skip ValidCfgCode
      const raw = Number(tokens[i]);
      if (!Number.isFinite(raw)) continue;
      const u16 = raw & 0xFFFF;
      // Re-decode signed offsets (92, 94) so the Python write path
      // sign-encodes them correctly. Mirrors calibration_decoder.SIGNED.
      const signed = (off === 92 || off === 94)
        ? (u16 >= 0x8000 ? u16 - 0x10000 : u16) : u16;
      writes.push({ offset: off, value: signed });
    }
    return writes;
  }

  // GET — list snapshots for one (inverter, slave). Topology-auth gated.
  // Read-only snapshot listing — same trust as audit page.
  app.get("/api/calibration/snapshots/:inverter/:slave",
    (req, res) => {
      if (isRemoteMode()) return proxyToRemote(req, res);
      const inv = Number(req.params.inverter);
      const slave = Number(req.params.slave);
      if (!Number.isInteger(inv) || !KNOWN_NODES_PER_INV.includes(slave)) {
        return res.status(400).json({ ok: false, error: "invalid inverter/slave" });
      }
      try {
        const rows = listCalibrationSnapshots(inv, slave,
          Number(req.query?.limit) || 50);
        const decoded = rows.map((r) => ({
          ...r,
          writes_preview: _decodeSnapshotWrites(r.reg_block_hex),
        }));
        res.json({ ok: true, snapshots: decoded });
      } catch (err) {
        res.status(500).json({ ok: false, error: err?.message || String(err) });
      }
    });

  // POST — capture an on-demand backup of the current calibration block.
  // Read-only Modbus probe + DB row insert. NO topology auth required —
  // taking a snapshot of the current values is a SAFER-than-default
  // action (gives the operator a rollback point) and never modifies the
  // inverter. Operator preference: routine backup capture should be one
  // click, not three.
  app.post("/api/calibration/snapshot/:inverter/:slave",
    async (req, res) => {
      if (isRemoteMode()) return proxyToRemote(req, res);
      const inv = Number(req.params.inverter);
      const slave = Number(req.params.slave);
      if (!Number.isInteger(inv) || !KNOWN_NODES_PER_INV.includes(slave)) {
        return res.status(400).json({ ok: false, error: "invalid inverter/slave" });
      }
      const ip = resolveIp(inv);
      if (!ip) return res.status(404).json({ ok: false, error: `no IP for inverter ${inv}` });
      const note = String((req.body && req.body.note) || "").slice(0, 200);

      let preflight;
      try {
        preflight = await callPython(`/calibration/preflight/${encodeURIComponent(ip)}/${slave}`, "GET");
      } catch (err) {
        return res.status(502).json({ ok: false, error: `preflight failed: ${err?.message || err}` });
      }
      if (!preflight?.ok || !preflight.by_offset) {
        return res.status(424).json({
          ok: false,
          error: `read failed: ${preflight?.error || "unknown"}`,
        });
      }
      const regBlockHex = Object.keys(preflight.by_offset)
        .sort((a, b) => Number(a) - Number(b))
        .map((k) => String(preflight.by_offset[k] & 0xFFFF).padStart(4, "0"))
        .join(" ");

      // Best-effort: enrich with model/firmware if available via full-config.
      let model_code = null, firmware_main = null, serial = null;
      try {
        const fc = await callPython(`/calibration/full-config/${encodeURIComponent(ip)}/${slave}`, "GET");
        if (fc?.ok && fc.decoded?.context) {
          // Pull whatever the context block exposes — names match
          // calibration_decoder.CONTEXT_FIELDS.
          for (const c of fc.decoded.context) {
            if (c.field === "CountryCode") model_code = String(c.value || "");
          }
        }
      } catch (_) { /* metadata is best-effort */ }

      // ── Dedup: don't stack byte-identical snapshots ────────────────────
      // A snapshot only exists to be restored, and restore replays the
      // 14-register block. If the freshly-read block is identical to the
      // most recent snapshot for this (inverter, node), a new row would
      // preserve nothing new — it just clutters the list. Skip the insert
      // and return the existing snapshot so the UI can say "no change".
      // (Compared against the latest of ANY source — baseline/post/manual —
      // since restore semantics are source-agnostic.)
      try {
        const latest = typeof getLatestCalibrationSnapshot === "function"
          ? getLatestCalibrationSnapshot(inv, slave)
          : null;
        if (latest && String(latest.reg_block_hex || "") === regBlockHex) {
          try {
            insertAuditLogRow?.({
              ts: Date.now(),
              operator: String((req.body && req.body.operator) || "operator"),
              inverter: inv, node: slave,
              action: "calibration.snapshot.dedup",
              scope: "calibration", result: "skipped", ip,
              reason: `identical to snapshot id=${latest.id} (no config change)`,
            });
          } catch (_) {}
          return res.json({
            ok: true,
            deduped: true,
            id: latest.id,
            ts_utc: latest.ts_utc,
            source: latest.source,
            inverter: inv, slave,
            valid_cfg_code: preflight.sentinel,
            message: "No configuration change since the last backup — existing snapshot kept (not duplicated).",
            writes_preview: _decodeSnapshotWrites(regBlockHex),
          });
        }
      } catch (_) { /* dedup is best-effort; fall through to insert */ }

      try {
        const id = insertCalibrationSnapshot({
          ts_utc: Date.now(),
          inverter_id: inv, inverter_ip: ip, slave,
          source: "manual",
          session_id: calibrationSession.isActive() && calibrationSession.isTargetUnderCalibration(inv, slave)
            ? calibrationSession.currentSession().session_id
            : null,
          reg_block_hex: regBlockHex,
          valid_cfg_code: preflight.sentinel,
          model_code, firmware_main, serial,
          notes: note || null,
        });
        try {
          insertAuditLogRow?.({
            ts: Date.now(),
            operator: String((req.body && req.body.operator) || "operator"),
            inverter: inv, node: slave,
            action: "calibration.snapshot.manual",
            scope: "calibration", result: "ok", ip,
            reason: `manual snapshot id=${id}${note ? ` note="${note}"` : ""}`,
          });
        } catch (_) {}
        res.json({
          ok: true, id, ts_utc: Date.now(), source: "manual",
          inverter: inv, slave, valid_cfg_code: preflight.sentinel,
          writes_preview: _decodeSnapshotWrites(regBlockHex),
        });
      } catch (err) {
        res.status(500).json({ ok: false, error: err?.message || String(err) });
      }
    });

  // POST — restore a snapshot by id. Replays the 14 scale-factor writes
  // through the same bulk-write pipeline used by the operator-facing
  // Write button (UNLOCK → WRITE → 1 s settle → VERIFY per register).
  //
  // Gated identically to a normal bulk write:
  //   • calibrationWritesEnabled feature flag
  //   • adsiMM bulk-control auth
  //   • active calibration_session on the target (inverter, slave)
  //   • critical-block check on target
  //   • range guard (configurable via body.max_delta_pct; null disables)
  app.post("/api/calibration/restore",
    requireWritesEnabled,
    require("express").json(),
    requireBulkAuth,
    requireActiveSession,
    async (req, res) => {
      if (isRemoteMode()) return proxyToRemote(req, res);
      const body = req.body || {};
      const cur = req._session;
      const snapshotId = Number(body.snapshot_id);
      if (!Number.isInteger(snapshotId) || snapshotId <= 0) {
        return res.status(400).json({ ok: false, error: "snapshot_id required" });
      }
      const snap = typeof getCalibrationSnapshotById === "function"
        ? getCalibrationSnapshotById(snapshotId) : null;
      if (!snap) {
        return res.status(404).json({ ok: false, error: "snapshot not found" });
      }
      // The active session's target must match the snapshot's target,
      // otherwise restoring would write the wrong electronic block.
      if (Number(snap.inverter_id) !== Number(cur.inverter) ||
          Number(snap.slave) !== Number(cur.slave)) {
        return res.status(409).json({
          ok: false,
          error: `Snapshot belongs to Inv ${snap.inverter_id}/Node ${snap.slave} but session is on Inv ${cur.inverter}/Node ${cur.slave}.`,
        });
      }
      if (snap.valid_cfg_code != null && Number(snap.valid_cfg_code) !== 0x1F1F) {
        return res.status(424).json({
          ok: false,
          error: `Snapshot ValidCfgCode = 0x${Number(snap.valid_cfg_code).toString(16).toUpperCase()} (expected 0x1F1F). Refusing to restore.`,
        });
      }
      const writes = _decodeSnapshotWrites(snap.reg_block_hex);
      if (!writes.length) {
        return res.status(424).json({ ok: false, error: "snapshot reg_block_hex unreadable" });
      }
      const ip = resolveIp(cur.inverter);
      if (!ip) return res.status(404).json({ ok: false, error: `no IP for inverter ${cur.inverter}` });
      const cb = checkCriticalBlock(cur.inverter);
      if (cb) return res.status(cb.status).json({ ok: false, ...cb });

      // TrinPM20 safety gates also apply to snapshot restore. Operator can
      // override via body.force_safety_gate=true after explicit ack.
      const restoreOffsets = writes.map((w) => Number(w?.offset)).filter(Number.isFinite);
      const gate = await checkTrinPmSafetyGates(ip, cur.slave, restoreOffsets, body);
      if (gate?.status) {
        return res.status(gate.status).json({ ok: false, ...gate });
      }

      try {
        const result = await callPython("/calibration/write-bulk", "POST", {
          ip, slave: cur.slave, writes,
          // Restores can move by more than 50 % vs current if the live
          // state has drifted significantly; allow caller to widen the
          // guard via body.max_delta_pct=null when they're confident.
          max_delta_pct: body.max_delta_pct === null
            ? null
            : (body.max_delta_pct == null ? 50.0 : Number(body.max_delta_pct)),
          verify_delay_s: 1.0,
        });
        try {
          for (const w of (result?.writes || [])) {
            insertCalibrationWriteLog({
              ts_utc: Date.now(),
              session_id: cur.session_id,
              inverter_id: cur.inverter, inverter_ip: ip, slave: cur.slave,
              reg_offset: w.offset, param_name: w.field || "",
              value_before: w.value_before,
              value_requested: w.value_requested,
              value_after: w.value_after,
              verify_ok: w.verify_ok ? 1 : 0,
              operator: cur.operator,
              auth_method: gate?.forced
                ? "adsiMM+session+restore+force_safety"
                : "adsiMM+session+restore",
              error_detail: result?.error || null,
              notes: gate?.forced
                ? `restore from snapshot id=${snapshotId} (${snap.source}); TrinPM20 gate forced: ${gate.blocking_reasons.join(" | ")}`
                : `restore from snapshot id=${snapshotId} (${snap.source})`,
            });
            if (w.verify_ok) calibrationSession.incrementWrite();
          }
          insertAuditLogRow?.({
            ts: Date.now(),
            operator: cur.operator,
            inverter: cur.inverter, node: cur.slave,
            action: "calibration.snapshot.restore",
            scope: "calibration", result: result?.ok ? "ok" : "partial", ip,
            reason: gate?.forced
              ? `snapshot id=${snapshotId} source=${snap.source} writes=${writes.length} FORCED gates=${gate.blocking_reasons.length}`
              : `snapshot id=${snapshotId} source=${snap.source} writes=${writes.length}`,
          });
        } catch (e) {
          console.warn("[calibration] restore log failed:", e?.message);
        }
        return res.json({ ...result, snapshot_id: snapshotId });
      } catch (err) {
        return res.status(502).json({ ok: false, error: err?.message || String(err) });
      }
    });

  // DELETE — remove a snapshot. Topology-auth gated. Refuses to delete
  // baseline/post-write snapshots that are tied to a session — only
  // manual snapshots are operator-removable.
  app.delete("/api/calibration/snapshot/:id",
    requireTopologyAuth, (req, res) => {
      if (isRemoteMode()) return proxyToRemote(req, res);
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ ok: false, error: "id required" });
      }
      const snap = typeof getCalibrationSnapshotById === "function"
        ? getCalibrationSnapshotById(id) : null;
      if (!snap) return res.status(404).json({ ok: false, error: "snapshot not found" });
      if (snap.source !== "manual") {
        return res.status(409).json({
          ok: false,
          error: `Cannot delete ${snap.source} snapshot — it's part of the session audit trail.`,
        });
      }
      try {
        const changes = deleteCalibrationSnapshotById(id);
        res.json({ ok: true, deleted: changes });
      } catch (err) {
        res.status(500).json({ ok: false, error: err?.message || String(err) });
      }
    });

  // ── PHASE 2: session lifecycle ───────────────────────────────────────

  app.post("/api/calibration/session/start", requireTopologyAuth, async (req, res) => {
    if (isRemoteMode()) return proxyToRemote(req, res);
    const body = req.body || {};
    const inv = Number(body.inverter);
    const slave = Number(body.slave);
    if (!Number.isInteger(inv) || inv < 1 || inv > KNOWN_INVERTERS_MAX) {
      return res.status(400).json({ ok: false, error: "inverter required" });
    }
    if (!KNOWN_NODES_PER_INV.includes(slave)) {
      return res.status(400).json({ ok: false, error: "slave required" });
    }
    const ip = resolveIp(inv);
    if (!ip) return res.status(404).json({ ok: false, error: `no IP for inverter ${inv}` });
    if (calibrationSession.isActive()) {
      // Auto-recover from a stuck/abandoned session in two safe cases:
      //   (a) the existing session targets the SAME (inverter, slave) — treat
      //       this as the operator restarting the same session (e.g. they
      //       navigated away and came back, or the page reloaded). End it
      //       cleanly and fall through to start a fresh one.
      //   (b) the existing session is past its idle window — the heartbeat
      //       has gone silent so the watchdog will end it within ≤5 s anyway.
      //       Don't make the operator wait; force-end now.
      // Anything else (session active for a DIFFERENT live target with a
      // recent heartbeat) still rejects, since concurrent calibration on two
      // inverters is unsafe.
      const cur = calibrationSession.currentSession() || {};
      const sameTarget = Number(cur.inverter) === inv && Number(cur.slave) === slave;
      const idleMs = Number(cur.idle_ms || 0);
      const idleLimit = Number(cur.idle_timeout_ms || 30_000);
      const stale = idleMs > idleLimit;
      if (sameTarget || stale) {
        calibrationSession.abortAll(sameTarget ? "operator_restart" : "stale_takeover");
      } else {
        return res.status(409).json({
          ok: false,
          error: `Another calibration session is already active on Inverter ${cur.inverter}/${cur.slave} (operator: ${cur.operator || "?"}).`,
          active: cur,
        });
      }
    }
    const cb = checkCriticalBlock(inv);
    if (cb) return res.status(cb.status).json({ ok: false, ...cb });

    // Capture baseline snapshot via Python preflight
    let baseline = null;
    try {
      baseline = await callPython(`/calibration/preflight/${encodeURIComponent(ip)}/${slave}`, "GET");
    } catch (err) {
      return res.status(502).json({ ok: false, error: `preflight failed: ${err?.message || err}` });
    }
    if (!baseline?.ok) {
      return res.status(424).json({
        ok: false,
        error: `Preflight failed: ${baseline?.error || "unknown"}. Cannot start session.`,
      });
    }

    const operator = String(body.operator || "operator").slice(0, 64);
    let session;
    try {
      session = calibrationSession.begin({
        inverter: inv, slave, operator,
        idle_timeout_ms: Number(body.idle_timeout_ms) || undefined,
        hard_ceiling_ms: Number(body.hard_ceiling_ms) || undefined,
      });
    } catch (err) {
      return res.status(409).json({ ok: false, error: err?.message || String(err) });
    }

    // Persist baseline snapshot + session row
    try {
      const regBlockHex = Object.keys(baseline.by_offset).sort((a, b) => Number(a) - Number(b))
        .map((k) => String(baseline.by_offset[k] & 0xFFFF).padStart(4, "0"))
        .join(" ");
      insertCalibrationSnapshot({
        ts_utc: Date.now(),
        inverter_id: inv, inverter_ip: ip, slave,
        source: "baseline", session_id: session.session_id,
        reg_block_hex: regBlockHex,
        valid_cfg_code: baseline.sentinel,
      });
      insertCalibrationSession({
        session_id: session.session_id,
        inverter_id: inv, slave, operator,
        started_at_ms: Date.now(),
      });
      insertAuditLogRow?.({
        ts: Date.now(),
        operator,
        inverter: inv, node: slave,
        action: "calibration.session.start",
        scope: "calibration", result: "ok",
        ip,
        reason: `session ${session.session_id} baseline snapshot captured`,
      });
    } catch (err) {
      console.warn("[calibration] persist session-start failed:", err?.message);
    }

    return res.json({
      ok: true,
      session_id: session.session_id,
      idle_timeout_ms: session.idle_timeout_ms,
      hard_ceiling_ms: session.hard_ceiling_ms,
      baseline,
      session: calibrationSession.currentSession(),
    });
  });

  app.post("/api/calibration/session/heartbeat", (req, res) => {
    if (isRemoteMode()) return proxyToRemote(req, res);
    const sid = String((req.body && req.body.session_id) || "").trim();
    if (!sid) return res.status(400).json({ ok: false, error: "session_id required" });
    const r = calibrationSession.heartbeat(sid);
    return res.json(r);
  });

  app.post("/api/calibration/session/end", requireTopologyAuth, async (req, res) => {
    if (isRemoteMode()) return proxyToRemote(req, res);
    const body = req.body || {};
    const sid = String(body.session_id || "").trim();
    if (!sid) return res.status(400).json({ ok: false, error: "session_id required" });
    if (!calibrationSession.isActive()) {
      return res.status(404).json({ ok: false, error: "no active session" });
    }
    const cur = calibrationSession.currentSession();
    if (cur.session_id !== sid) {
      return res.status(409).json({ ok: false, error: "session_id mismatch" });
    }
    // Release consign (return to 100 %) if any consign writes happened.
    if (cur.consign_writes > 0 && typeof setActivePowerPct === "function") {
      try {
        const ip = resolveIp(cur.inverter);
        if (ip) await setActivePowerPct(ip, cur.slave, 100);
      } catch (err) {
        console.warn(`[calibration] release-consign on end failed: ${err?.message}`);
      }
    }
    // Capture post-session snapshot
    try {
      const ip = resolveIp(cur.inverter);
      if (ip) {
        const post = await callPython(`/calibration/preflight/${encodeURIComponent(ip)}/${cur.slave}`, "GET");
        if (post?.ok) {
          const hex = Object.keys(post.by_offset).sort((a, b) => Number(a) - Number(b))
            .map((k) => String(post.by_offset[k] & 0xFFFF).padStart(4, "0"))
            .join(" ");
          insertCalibrationSnapshot({
            ts_utc: Date.now(),
            inverter_id: cur.inverter, inverter_ip: ip, slave: cur.slave,
            source: "post-write", session_id: sid,
            reg_block_hex: hex, valid_cfg_code: post.sentinel,
          });
        }
      }
    } catch (err) {
      console.warn("[calibration] post-session snapshot failed:", err?.message);
    }

    const ended = calibrationSession.end(sid, body.reason || "operator");
    // v2.11.x — operator preference: calibration writes must NEVER stay
    // armed when the session ends. We auto-disable the
    // `calibrationWritesEnabled` setting at session-end on the server, so
    // the client doesn't have to chain a separate POST (which was racy
    // and required a still-cached topology key). Idempotent — a no-op
    // when writes are already disabled.
    let writesAutoDisabled = false;
    try {
      if (typeof setSetting === "function") {
        setSetting("calibrationWritesEnabled", "0");
        writesAutoDisabled = true;
      }
    } catch (_) {}
    try {
      updateCalibrationSessionEnd(sid, ended.end_reason, {
        write_count: ended.write_count,
        consign_writes: ended.consign_writes,
      });
      insertAuditLogRow?.({
        ts: Date.now(),
        operator: cur.operator,
        inverter: cur.inverter, node: cur.slave,
        action: "calibration.session.end",
        scope: "calibration",
        result: "ok",
        reason: `reason=${ended.end_reason} writes=${ended.write_count} consign=${ended.consign_writes} dur_s=${(ended.duration_ms/1000)|0}${writesAutoDisabled ? " writes_auto_disabled=1" : ""}`,
      });
      if (writesAutoDisabled) {
        insertAuditLogRow?.({
          ts: Date.now(),
          actor: "system",
          action: "calib_writes_disabled",
          detail: JSON.stringify({ via: "session_end", reason: ended.end_reason }),
        });
      }
    } catch (_) {}
    return res.json({ ok: true, ...ended, writes_auto_disabled: writesAutoDisabled });
  });

  // v2.11.x — page-leave beacon. The renderer fires this when the operator
  // navigates away from the Field Calibration page. It auto-disables the
  // `calibrationWritesEnabled` setting unconditionally and ends any active
  // session. NO topology auth required — the renderer can't always carry
  // the cached key during a page transition (cache may have rolled), and
  // disabling writes is a SAFE-by-default action that we WANT to succeed
  // even when authorization has lapsed. Localhost / same-origin only via
  // standard browser CORS — no abuse vector beyond turning OFF a feature
  // flag the operator could turn off themselves.
  app.post("/api/calibration/page-leave-cleanup", (req, res) => {
    if (isRemoteMode()) return proxyToRemote(req, res);
    let sessionEnded = false;
    try {
      if (calibrationSession.isActive()) {
        calibrationSession.abortAll("page_leave");
        sessionEnded = true;
      }
    } catch (_) {}
    let writesDisabled = false;
    try {
      if (typeof setSetting === "function") {
        setSetting("calibrationWritesEnabled", "0");
        writesDisabled = true;
      }
    } catch (_) {}
    try {
      if (writesDisabled || sessionEnded) {
        insertAuditLogRow?.({
          ts: Date.now(),
          actor: "system",
          action: "calib_page_leave_cleanup",
          detail: JSON.stringify({
            session_ended: sessionEnded,
            writes_disabled: writesDisabled,
          }),
        });
      }
    } catch (_) {}
    return res.json({ ok: true, session_ended: sessionEnded, writes_disabled: writesDisabled });
  });

  // ── PHASE 2: write paths ─────────────────────────────────────────────

  app.post("/api/calibration/write",
    requireWritesEnabled,
    require("express").json(),
    requireBulkAuth,
    requireActiveSession,
    async (req, res) => {
      if (isRemoteMode()) return proxyToRemote(req, res);
      const body = req.body || {};
      const cur = req._session;
      // Force target to match the active session — operator can't write to a
      // different inverter without ending the session first.
      const inv = cur.inverter, slave = cur.slave;
      const ip = resolveIp(inv);
      if (!ip) return res.status(404).json({ ok: false, error: `no IP for inverter ${inv}` });
      const cb = checkCriticalBlock(inv);
      if (cb) return res.status(cb.status).json({ ok: false, ...cb });

      const offset = Number(body.offset);
      const value = Number(body.value);
      if (!Number.isInteger(offset)) {
        return res.status(400).json({ ok: false, error: "offset required" });
      }
      if (!Number.isFinite(value)) {
        return res.status(400).json({ ok: false, error: "value required" });
      }

      // TrinPM20 safety gates (Slice κ.10) — refuse writes that violate
      // the PDF preconditions. Operator can pass `force_safety_gate=true`
      // to override after explicit acknowledgement.
      const gate = await checkTrinPmSafetyGates(ip, slave, [offset], body);
      if (gate?.status) {
        return res.status(gate.status).json({ ok: false, ...gate });
      }
      try {
        const result = await callPython("/calibration/write", "POST", {
          ip, slave, offset, value: Math.trunc(value),
          // CRITICAL: distinguish "operator explicitly forced via Force
          // toggle" (body.max_delta_pct === null) from "client didn't set
          // the field" (undefined). The operator's Force-armed write
          // sends explicit null and MUST disable the guard. Using `== null`
          // here would conflate undefined and null and silently re-apply
          // the 50 % guard — exactly the bug the Force toggle exists to
          // bypass. See /restore at line ~660 for the same three-way logic.
          max_delta_pct: body.max_delta_pct === null
            ? null
            : (body.max_delta_pct === undefined ? 50.0 : Number(body.max_delta_pct)),
          verify_delay_s: 1.0,
        });
        if (gate?.forced && gate.blocking_reasons?.length) {
          result.safety_forced = true;
          result.safety_reasons = gate.blocking_reasons;
        }
        try {
          insertCalibrationWriteLog({
            ts_utc: Date.now(),
            session_id: cur.session_id,
            inverter_id: inv, inverter_ip: ip, slave,
            reg_offset: offset,
            param_name: result?.field || "",
            value_before: result?.value_before,
            value_requested: Math.trunc(value),
            value_after: result?.value_after,
            verify_ok: result?.verify_ok ? 1 : 0,
            operator: cur.operator,
            auth_method: gate?.forced ? "adsiMM+session+force_safety" : "adsiMM+session",
            error_detail: result?.error || null,
            notes: gate?.forced ? `TrinPM20 gate forced: ${gate.blocking_reasons.join(" | ")}` : null,
          });
          if (result?.verify_ok) calibrationSession.incrementWrite();
        } catch (e) {
          console.warn("[calibration] write log failed:", e?.message);
        }
        return res.json(result);
      } catch (err) {
        return res.status(502).json({ ok: false, error: err?.message || String(err) });
      }
    });

  app.post("/api/calibration/write-bulk",
    requireWritesEnabled,
    require("express").json(),
    requireBulkAuth,
    requireActiveSession,
    async (req, res) => {
      if (isRemoteMode()) return proxyToRemote(req, res);
      const body = req.body || {};
      const cur = req._session;
      const inv = cur.inverter, slave = cur.slave;
      const ip = resolveIp(inv);
      if (!ip) return res.status(404).json({ ok: false, error: `no IP for inverter ${inv}` });
      const cb = checkCriticalBlock(inv);
      if (cb) return res.status(cb.status).json({ ok: false, ...cb });

      const writes = Array.isArray(body.writes) ? body.writes : null;
      if (!writes || !writes.length) {
        return res.status(400).json({ ok: false, error: "writes (non-empty list) required" });
      }

      // TrinPM20 safety gates (Slice κ.10) — check each proposed offset
      // against the live state + Pac/Pn snapshot before unlocking.
      const writeOffsets = writes.map((w) => Number(w?.offset)).filter(Number.isFinite);
      const gate = await checkTrinPmSafetyGates(ip, slave, writeOffsets, body);
      if (gate?.status) {
        return res.status(gate.status).json({ ok: false, ...gate });
      }
      try {
        const result = await callPython("/calibration/write-bulk", "POST", {
          ip, slave, writes,
          // CRITICAL: distinguish "operator explicitly forced via Force
          // toggle" (body.max_delta_pct === null) from "client didn't set
          // the field" (undefined). The operator's Force-armed write
          // sends explicit null and MUST disable the guard. Using `== null`
          // here would conflate undefined and null and silently re-apply
          // the 50 % guard — exactly the bug the Force toggle exists to
          // bypass. See /restore at line ~660 for the same three-way logic.
          max_delta_pct: body.max_delta_pct === null
            ? null
            : (body.max_delta_pct === undefined ? 50.0 : Number(body.max_delta_pct)),
          verify_delay_s: 1.0,
        });
        if (gate?.forced && gate.blocking_reasons?.length) {
          result.safety_forced = true;
          result.safety_reasons = gate.blocking_reasons;
        }
        try {
          for (const w of (result?.writes || [])) {
            insertCalibrationWriteLog({
              ts_utc: Date.now(),
              session_id: cur.session_id,
              inverter_id: inv, inverter_ip: ip, slave,
              reg_offset: w.offset, param_name: w.field || "",
              value_before: w.value_before,
              value_requested: w.value_requested,
              value_after: w.value_after,
              verify_ok: w.verify_ok ? 1 : 0,
              operator: cur.operator,
              auth_method: gate?.forced ? "adsiMM+session+bulk+force_safety" : "adsiMM+session+bulk",
              error_detail: result?.error || null,
              notes: gate?.forced ? `TrinPM20 gate forced: ${gate.blocking_reasons.join(" | ")}` : null,
            });
            if (w.verify_ok) calibrationSession.incrementWrite();
          }
        } catch (e) {
          console.warn("[calibration] bulk write log failed:", e?.message);
        }
        return res.json(result);
      } catch (err) {
        return res.status(502).json({ ok: false, error: err?.message || String(err) });
      }
    });

  // ── Utility Tool: L2 config-block write (groups B/C/D/I) ─────────────
  //
  // Distinct from /api/calibration/write above (which targets the
  // calibration scale-factor window 81-94 under an active session). This
  // route is for the Utility Tool's editable settings tabs and uses the
  // broader cfg_trif_map.FIELDS whitelist. Auth = adsiMM (operator
  // preference: one prompt per page visit, cached client-side). Does
  // NOT require an active calibration session — this is a config-write
  // flow, not a calibration session.
  //
  // Body: { inverter, slave, field, value }
  app.post("/api/calibration/config-write",
    require("express").json(),
    requireBulkAuth,
    async (req, res) => {
      if (isRemoteMode()) return proxyToRemote(req, res);
      const body = req.body || {};
      const inv = Number(body.inverter);
      const slave = Number(body.slave);
      // Normalise field name to ASCII-identifier-safe so a unicode-
      // lookalike "ValidCfgCode" can't slip past the encoder's
      // NON_WRITABLE_FIELDS check. The cfg_trif_map field names are
      // all [A-Za-z0-9_], so a strict regex here is fine.
      const fieldRaw = String(body.field || "").trim();
      const field = /^[A-Za-z0-9_]+$/.test(fieldRaw) ? fieldRaw : "";
      if (!Number.isInteger(inv) || inv < 1 || inv > KNOWN_INVERTERS_MAX) {
        return res.status(400).json({
          ok: false,
          error: `inverter must be 1..${KNOWN_INVERTERS_MAX}`,
        });
      }
      if (!Number.isInteger(slave) || slave < 1 || slave > 247) {
        return res.status(400).json({
          ok: false, error: "slave must be 1..247",
        });
      }
      if (!field) {
        return res.status(400).json({
          ok: false,
          error: "field required and must be an ASCII identifier",
        });
      }
      if (!Object.prototype.hasOwnProperty.call(body, "value")) {
        return res.status(400).json({ ok: false, error: "value required" });
      }
      // Reject obviously wrong value types up-front. Numbers, booleans,
      // and strings are all valid (the encoder parses each); arrays and
      // plain objects are not — they'd hit the encoder's stringify path
      // and produce a useless "[object Object]" range error.
      const vt = typeof body.value;
      if (
        vt !== "number" && vt !== "string" && vt !== "boolean"
      ) {
        return res.status(400).json({
          ok: false,
          error: "value must be a number, string, or boolean",
        });
      }
      const ip = resolveIp(inv);
      if (!ip) {
        return res.status(404).json({
          ok: false, error: `no IP for inverter ${inv}`,
        });
      }
      const cb = checkCriticalBlock(inv);
      if (cb) {
        // Critical block — audit the rejection so forensic visibility is
        // not lost on a refused write.
        try {
          insertAuditLogRow?.({
            actor: "operator",
            action: "utility_config_write_refused",
            detail: JSON.stringify({
              inverter: inv, slave, ip, field,
              reason: "critical_block",
              pattern_hex: cb.pattern_hex || null,
            }),
          });
        } catch (_) { /* fail-open on audit */ }
        return res.status(cb.status).json({ ok: false, ...cb });
      }

      let result = null;
      let pythonError = null;
      try {
        result = await callPython("/calibration/config-write", "POST", {
          ip, slave, field, value: body.value,
          verify_delay_s: 1.0,
        });
      } catch (err) {
        pythonError = err?.message || String(err);
      }
      // Audit every attempt — success, refusal, transport error, or
      // encoder rejection. Without this, fuzz-style probing leaves no
      // forensic record.
      try {
        if (typeof insertAuditLogRow === "function") {
          insertAuditLogRow({
            actor: "operator",
            action: pythonError
              ? "utility_config_write_error"
              : (result?.ok ? "utility_config_write" : "utility_config_write_refused"),
            detail: JSON.stringify({
              inverter: inv, slave, ip, field,
              kind: result?.kind || null,
              value_requested: body.value,
              value_before_raw: result?.value_before_raw ?? null,
              value_after_raw: result?.value_after_raw ?? null,
              raw_to_write: result?.raw_to_write ?? null,
              status: result?.status || null,
              verify_ok: !!result?.verify_ok,
              error: result?.error || pythonError || null,
            }),
          });
        }
      } catch (e) {
        console.warn("[utility] config-write audit failed:", e?.message);
      }
      if (pythonError) {
        return res.status(502).json({ ok: false, error: pythonError });
      }
      return res.json(result);
    });

  // ── PHASE 3: consign mode (drive APC cmd-3 under active session) ────

  // Tracks last consign timestamp per inverter for the dwell timer.
  const _consignDwell = new Map();   // `${inv}/${slave}` -> { pct, ts_ms }
  const CONSIGN_MIN_DWELL_MS = 10_000;

  app.post("/api/calibration/consign",
    requireWritesEnabled,
    require("express").json(),
    requireBulkAuth,
    requireActiveSession,
    async (req, res) => {
      if (isRemoteMode()) return proxyToRemote(req, res);
      const body = req.body || {};
      const cur = req._session;
      const inv = cur.inverter, slave = cur.slave;
      const ip = resolveIp(inv);
      if (!ip) return res.status(404).json({ ok: false, error: `no IP for inverter ${inv}` });
      const cb = checkCriticalBlock(inv);
      if (cb) return res.status(cb.status).json({ ok: false, ...cb });

      const pct = Number(body.percent);
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
        return res.status(400).json({ ok: false, error: "percent must be 0..100" });
      }

      // Dwell guard: between distinct setpoints we require 10 s minimum so the
      // PAC has time to settle before the operator does the next measurement.
      // RELEASE (100 % / full output) is ALWAYS exempt — restoring the
      // inverter to full power must never be delayed or refused, no matter
      // how recently another setpoint was applied. Treat pct >= 100 as
      // release so a clamped/over-100 value can't accidentally re-arm the
      // guard either.
      const key = `${inv}/${slave}`;
      const isRelease = pct >= 100;
      const last = _consignDwell.get(key);
      if (last && !isRelease && last.pct !== pct) {
        const since = Date.now() - last.ts_ms;
        if (since < CONSIGN_MIN_DWELL_MS) {
          return res.status(429).json({
            ok: false,
            error: `Wait ${Math.ceil((CONSIGN_MIN_DWELL_MS - since) / 1000)} s for the previous setpoint to settle.`,
            since_last_ms: since,
            min_dwell_ms: CONSIGN_MIN_DWELL_MS,
          });
        }
      }

      try {
        if (typeof setActivePowerPct !== "function") {
          return res.status(500).json({ ok: false, error: "consign path not wired (setActivePowerPct missing)" });
        }
        const r = await setActivePowerPct(ip, slave, pct);
        if (r?.ok) {
          _consignDwell.set(key, { pct, ts_ms: Date.now() });
          calibrationSession.incrementConsign();
          insertAuditLogRow?.({
            ts: Date.now(), operator: cur.operator,
            inverter: inv, node: slave,
            action: "calibration.consign",
            scope: "calibration", result: "ok",
            ip,
            reason: `pct=${pct} session=${cur.session_id}`,
          });
        }
        return res.json(r);
      } catch (err) {
        return res.status(502).json({ ok: false, error: err?.message || String(err) });
      }
    });

  // ── PHASE 4: bulk copy with hardware-fingerprint match ──────────────

  app.post("/api/calibration/copy",
    requireWritesEnabled,
    require("express").json(),
    requireBulkAuth,
    requireActiveSession,
    async (req, res) => {
      if (isRemoteMode()) return proxyToRemote(req, res);
      const body = req.body || {};
      const cur = req._session;
      const dstInv = cur.inverter, dstSlave = cur.slave;
      const srcInv = Number(body.source_inverter);
      const srcSlave = Number(body.source_slave);
      if (!Number.isInteger(srcInv) || !KNOWN_NODES_PER_INV.includes(srcSlave)) {
        return res.status(400).json({ ok: false, error: "source_inverter + source_slave required" });
      }
      if (srcInv === dstInv && srcSlave === dstSlave) {
        return res.status(400).json({ ok: false, error: "source and destination are identical" });
      }
      const dstIp = resolveIp(dstInv);
      const srcIp = resolveIp(srcInv);
      if (!srcIp || !dstIp) {
        return res.status(404).json({ ok: false, error: "source or destination IP not configured" });
      }
      const cb = checkCriticalBlock(dstInv);
      if (cb) return res.status(cb.status).json({ ok: false, ...cb });

      // Read both sides
      let srcState, dstState;
      try {
        [srcState, dstState] = await Promise.all([
          callPython(`/calibration/state/${encodeURIComponent(srcIp)}/${srcSlave}`, "GET"),
          callPython(`/calibration/state/${encodeURIComponent(dstIp)}/${dstSlave}`, "GET"),
        ]);
      } catch (err) {
        return res.status(502).json({ ok: false, error: err?.message || String(err) });
      }
      if (!srcState?.ok || !dstState?.ok) {
        return res.status(424).json({ ok: false, error: "could not read source and/or destination state" });
      }
      if (!srcState?.calibration?.valid_cfg_code_ok || !dstState?.calibration?.valid_cfg_code_ok) {
        return res.status(424).json({ ok: false, error: "ValidCfgCode sentinel not 0x1F1F on one side; refusing copy" });
      }

      // Hardware fingerprint check: verify source and destination are the
      // same inverter model + firmware before copying scale factors. A
      // calibration block from a different module would silently produce
      // wrong readings. Caller can pass `force_fingerprint=true` to
      // bypass after explicit operator acknowledgment (e.g. after
      // confirming both modules are physically identical).
      const forceFingerprint = body.force_fingerprint === true
        || body.force_fingerprint === "1" || body.force_fingerprint === 1;
      if (!forceFingerprint) {
        try {
          const [srcFc, dstFc] = await Promise.all([
            callPython(`/calibration/full-config/${encodeURIComponent(srcIp)}/${srcSlave}`, "GET"),
            callPython(`/calibration/full-config/${encodeURIComponent(dstIp)}/${dstSlave}`, "GET"),
          ]);
          const fpOf = (fc) => {
            const ctx = fc?.decoded?.context || [];
            const pick = (name) => ctx.find((c) => c.field === name)?.value ?? null;
            return {
              country:        pick("CountryCode"),
              nominal_power:  pick("PotenciaNominal"),
              vac_min:        pick("Vacmin"),
              vac_max:        pick("Vacmax"),
              fac_min:        pick("Facmin"),
              fac_max:        pick("Facmax"),
            };
          };
          const srcFp = fpOf(srcFc);
          const dstFp = fpOf(dstFc);
          const mismatched = Object.keys(srcFp).filter((k) => {
            return srcFp[k] != null && dstFp[k] != null && String(srcFp[k]) !== String(dstFp[k]);
          });
          if (mismatched.length) {
            return res.status(409).json({
              ok: false,
              error: `Hardware fingerprint mismatch on: ${mismatched.join(", ")}. Pass force_fingerprint=true to override after confirming the modules are identical.`,
              source_fingerprint: srcFp,
              dest_fingerprint: dstFp,
              mismatched_fields: mismatched,
            });
          }
        } catch (err) {
          return res.status(502).json({
            ok: false,
            error: `Fingerprint read failed: ${err?.message || err}. Pass force_fingerprint=true to skip the check.`,
          });
        }
      }

      // Build writes — only fields where source ≠ destination, to minimize bus traffic.
      const writes = [];
      for (const sf of (srcState.calibration.fields || [])) {
        const dfMatch = (dstState.calibration.fields || []).find((d) => d.offset === sf.offset);
        if (!dfMatch) continue;
        const srcVal = sf.is_signed ? sf.signed : sf.raw_u16;
        const dstVal = dfMatch.is_signed ? dfMatch.signed : dfMatch.raw_u16;
        if (srcVal !== dstVal) writes.push({ offset: sf.offset, value: srcVal });
      }
      if (!writes.length) {
        return res.json({ ok: true, status: "noop", writes: [], note: "source and destination already identical" });
      }

      // TrinPM20 safety gates apply to bulk-copy targets too. Same override
      // path (body.force_safety_gate=true).
      const copyOffsets = writes.map((w) => Number(w?.offset)).filter(Number.isFinite);
      const copyGate = await checkTrinPmSafetyGates(dstIp, dstSlave, copyOffsets, body);
      if (copyGate?.status) {
        return res.status(copyGate.status).json({ ok: false, ...copyGate });
      }

      try {
        const result = await callPython("/calibration/write-bulk", "POST", {
          ip: dstIp, slave: dstSlave, writes,
          // CRITICAL: distinguish "operator explicitly forced via Force
          // toggle" (body.max_delta_pct === null) from "client didn't set
          // the field" (undefined). The operator's Force-armed write
          // sends explicit null and MUST disable the guard. Using `== null`
          // here would conflate undefined and null and silently re-apply
          // the 50 % guard — exactly the bug the Force toggle exists to
          // bypass. See /restore at line ~660 for the same three-way logic.
          max_delta_pct: body.max_delta_pct === null
            ? null
            : (body.max_delta_pct === undefined ? 50.0 : Number(body.max_delta_pct)),
          verify_delay_s: 1.0,
        });
        try {
          for (const w of (result?.writes || [])) {
            insertCalibrationWriteLog({
              ts_utc: Date.now(),
              session_id: cur.session_id,
              inverter_id: dstInv, inverter_ip: dstIp, slave: dstSlave,
              reg_offset: w.offset, param_name: w.field || "",
              value_before: w.value_before,
              value_requested: w.value_requested,
              value_after: w.value_after,
              verify_ok: w.verify_ok ? 1 : 0,
              operator: cur.operator,
              auth_method: copyGate?.forced
                ? "adsiMM+session+copy+force_safety"
                : "adsiMM+session+copy",
              error_detail: result?.error || null,
              notes: copyGate?.forced
                ? `copied from inv ${srcInv} / node ${srcSlave}; TrinPM20 gate forced: ${copyGate.blocking_reasons.join(" | ")}`
                : `copied from inv ${srcInv} / node ${srcSlave}`,
            });
            if (w.verify_ok) calibrationSession.incrementWrite();
          }
        } catch (e) {
          console.warn("[calibration] copy log failed:", e?.message);
        }
        return res.json({ ...result, source: { inverter: srcInv, slave: srcSlave } });
      } catch (err) {
        return res.status(502).json({ ok: false, error: err?.message || String(err) });
      }
    });
}

// Fleet aggregation (pure) — same as Phase 1.
function _aggregateFleet(perNode) {
  const byField = new Map();
  for (const st of perNode) {
    const fields = st?.calibration?.fields || [];
    for (const f of fields) {
      const arr = byField.get(f.field) || [];
      arr.push(Number(f.signed ?? f.raw_u16));
      byField.set(f.field, arr);
    }
  }
  const medians = {};
  for (const [k, vals] of byField) {
    const sorted = vals.slice().sort((a, b) => a - b);
    const n = sorted.length;
    if (!n) continue;
    medians[k] = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  }
  const out = [];
  for (const st of perNode) {
    const fields = st?.calibration?.fields || [];
    const deltas = {};
    const factors = {};
    for (const f of fields) {
      const v = Number(f.signed ?? f.raw_u16);
      factors[f.field] = v;
      const med = medians[f.field];
      if (med == null || med === 0) {
        deltas[f.field] = null;
      } else {
        deltas[f.field] = Number((((v - med) / med) * 100).toFixed(3));
      }
    }
    out.push({
      inverter:           st.inverter,
      slave:              st.slave,
      ip:                 st.ip,
      // Surface raw factor values too — the renderer's per-cell tooltip
      // shows "factor: 1128 (median 1140)" so the operator doesn't have
      // to back-compute from the delta percentage.
      factors_u16:        factors,
      deltas_pct:         deltas,
      valid_cfg_code_hex: st?.calibration?.valid_cfg_code_hex ?? null,
      valid_cfg_code_ok:  st?.calibration?.valid_cfg_code_ok ?? null,
    });
  }
  return { medians, per_node: out };
}

module.exports = { registerCalibrationRoutes };
