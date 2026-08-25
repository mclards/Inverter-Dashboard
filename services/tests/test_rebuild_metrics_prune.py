"""
Regression test for the 2026-05-29 metrics_state reclamation in
`rebuild_global_maps` (PY-POLL-002).

Contract locked here:
  • Removing an inverter from ipconfig purges its per-node entries from ALL
    five metrics_state dicts (pacEnergy / pdcData / uiAlarm / lastUpdate /
    pacEnergyHistory) — no memory leak, no stale rows in /metrics.
  • An inverter whose NUMBER stays configured (operator merely corrected its
    IP) keeps its accumulators intact — a re-cabling must never silently reset
    a live node's today-energy.
  • The prune derives the live set from slots 1..27 of ip_map, so a malformed
    config key can never raise inside rebuild_global_maps.
"""

import asyncio
import unittest

import services.inverter_engine as engine

def _mk_metrics(*nks):
    """Seed every metrics_state dict with the given node keys."""
    engine.metrics_state["pacEnergy"].clear()
    engine.metrics_state["pdcData"].clear()
    engine.metrics_state["uiAlarm"].clear()
    engine.metrics_state["lastUpdate"].clear()
    engine.metrics_state["pacEnergyHistory"].clear()
    for nk in nks:
        engine.metrics_state["pacEnergy"][nk] = {"totalWh": 1.0, "lastTime": 0,
                                                 "lastPacRaw": 0, "lastPacChangeTime": 0,
                                                 "date": "2026-05-29"}
        engine.metrics_state["pdcData"][nk] = {"lastPdcRaw": 0}
        engine.metrics_state["uiAlarm"][nk] = {"AlarmValue": 0, "AlarmText": "00000H"}
        engine.metrics_state["lastUpdate"][nk] = 0
        engine.metrics_state["pacEnergyHistory"][nk] = {"2026-05-29": 1.0}

def _all_nks():
    return set(engine.metrics_state["pacEnergy"].keys())

class RebuildMetricsPruneTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self._orig = {
            "create_client": engine.create_client,
            "ip_map": dict(engine.ip_map),
            "inverters": list(engine.inverters),
            "clients": dict(engine.clients),
            "thread_locks": dict(engine.thread_locks),
            "write_queues": dict(engine.write_queues),
            "write_threads": dict(engine.write_threads),
            "write_pending": dict(engine.write_pending),
            "intervals": dict(engine.intervals),
            "static_units": dict(engine.static_units),
            "shared": dict(engine.shared),
            "metrics": {k: dict(v) for k, v in engine.metrics_state.items()},
        }
        # Cheap fake client so rebuild's executor call returns instantly and the
        # teardown's .close() is harmless.
        class _FakeClient:
            def close(self):
                pass
        engine.create_client = lambda ip, port=502, timeout=1.0: _FakeClient()

        # Start state: inverter 1 -> A, inverter 2 -> B, both live with metrics.
        engine.ip_map.clear(); engine.ip_map.update({"1": "10.0.0.1", "2": "10.0.0.2"})
        engine.inverters[:] = ["10.0.0.1", "10.0.0.2"]
        engine.clients.clear()
        engine.thread_locks.clear()
        engine.write_queues.clear()
        engine.write_threads.clear()
        engine.write_pending.clear()
        engine.intervals.clear()
        engine.static_units.clear()
        engine.shared.clear()
        _mk_metrics("1_1", "1_2", "2_1")

    async def asyncTearDown(self):
        # Stop any write-worker threads rebuild may have started, and WAIT for
        # them to exit before restoring module globals (THREAD-001) — a still-
        # draining daemon thread could otherwise touch the next test's state.
        for q in list(engine.write_queues.values()):
            try:
                q.put_nowait(None)
            except Exception:
                pass
        for t in list(engine.write_threads.values()):
            try:
                t.join(timeout=1.0)
            except Exception:
                pass
        engine.create_client = self._orig["create_client"]
        for name in ("ip_map", "clients", "thread_locks", "write_queues",
                     "write_threads", "write_pending", "intervals",
                     "static_units", "shared"):
            d = getattr(engine, name)
            d.clear()
            d.update(self._orig[name])
        engine.inverters[:] = self._orig["inverters"]
        for k, v in self._orig["metrics"].items():
            engine.metrics_state[k].clear()
            engine.metrics_state[k].update(v)

    async def test_removed_inverter_metrics_are_reclaimed(self):
        # Operator removes inverter 2.
        cfg = engine._sanitize_ipconfig({"inverters": {"1": "10.0.0.1", "2": ""}})
        await engine.rebuild_global_maps(cfg)
        nks = _all_nks()
        self.assertIn("1_1", nks)
        self.assertIn("1_2", nks)
        self.assertNotIn("2_1", nks, "removed inverter 2's metrics must be reclaimed")
        # Every dict reclaimed in lock-step.
        for sub in ("pacEnergy", "pdcData", "uiAlarm", "lastUpdate", "pacEnergyHistory"):
            self.assertNotIn("2_1", engine.metrics_state[sub], f"{sub} still holds 2_1")

    async def test_ip_change_same_number_keeps_metrics(self):
        # Operator only corrects inverter 2's IP (number 2 stays configured).
        cfg = engine._sanitize_ipconfig({"inverters": {"1": "10.0.0.1", "2": "10.0.0.99"}})
        await engine.rebuild_global_maps(cfg)
        nks = _all_nks()
        self.assertIn("2_1", nks, "an IP-only correction must NOT reset a live node's metrics")
        self.assertIn("1_1", nks)

    async def test_malformed_config_key_does_not_crash(self):
        # A non-numeric inverters key must not throw inside rebuild (the prune
        # probes slots 1..27 rather than int()-ing arbitrary keys). Inject the
        # bad key AFTER sanitisation to simulate a future caller passing raw cfg.
        cfg = engine._sanitize_ipconfig({"inverters": {"1": "10.0.0.1", "2": "10.0.0.2"}})
        cfg["inverters"]["garbage"] = "not-an-ip"
        try:
            await engine.rebuild_global_maps(cfg)
        except Exception as e:  # pragma: no cover - failure path
            self.fail(f"rebuild_global_maps raised on a malformed key: {e!r}")
        # Both real inverters survive.
        self.assertTrue({"1_1", "2_1"}.issubset(_all_nks()))

    async def test_unit_count_shrink_reclaims_dropped_units(self):
        # Operator reduces inverter 1 from 4 units to [1,2]; the high units'
        # metrics must be reclaimed while the kept units survive.
        _mk_metrics("1_1", "1_2", "1_3", "1_4", "2_1")
        cfg = engine._sanitize_ipconfig({
            "inverters": {"1": "10.0.0.1", "2": "10.0.0.2"},
            "units": {"1": [1, 2]},
        })
        await engine.rebuild_global_maps(cfg)
        nks = _all_nks()
        self.assertIn("1_1", nks)
        self.assertIn("1_2", nks)
        self.assertNotIn("1_3", nks, "dropped unit 1_3 must be reclaimed on unit-shrink")
        self.assertNotIn("1_4", nks, "dropped unit 1_4 must be reclaimed on unit-shrink")
        self.assertIn("2_1", nks, "untouched inverter 2 must keep its metrics")
        # Lock-step across all five dicts.
        for sub in ("pacEnergy", "pdcData", "uiAlarm", "lastUpdate", "pacEnergyHistory"):
            self.assertNotIn("1_4", engine.metrics_state[sub], f"{sub} still holds 1_4")

if __name__ == "__main__":
    unittest.main()
