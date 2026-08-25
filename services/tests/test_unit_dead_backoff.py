"""
Regression test for the 2026-05-29 per-unit dead-node backoff in
`poll_inverter`.

Bug:
    All units behind one inverter IP share ONE TCP socket and ONE per-IP lock,
    and `poll_inverter` reads them sequentially. When a single slave stopped
    answering, `read_fast_async`/`safe_read` paid a full shared-socket
    reconnect + double read-timeout (~2.5 s) on EVERY poll cycle for that dead
    unit. Because the socket is shared and the loop is sequential, that penalty
    dragged the inverter's HEALTHY sibling nodes down with it — their dashboard
    refresh collapsed from sub-second to multi-second and the connection they
    depend on was torn down/rebuilt every cycle.

Fix:
    Once a unit misses `UNIT_DEAD_FAIL_THRESHOLD` consecutive reads it is
    "throttled" and re-probed only every `UNIT_DEAD_REPROBE_S` instead of every
    cycle. The healthy siblings keep their fast cadence; recovery is detected on
    the next re-probe and the unit returns to fast polling immediately.

These tests use an INSTANT mock read (so they can't reproduce the real 2.5 s
penalty) — instead they lock the *mechanism* that removes the penalty: a dead
unit is probed far less often than its healthy siblings, the siblings are NOT
slowed, and recovery restores fast polling.
"""

import asyncio
import unittest

import services.inverter_engine as engine

class UnitDeadBackoffTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self._orig = {
            "detect_units_async": engine.detect_units_async,
            "read_fast_async": engine.read_fast_async,
            "is_write_pending": engine.is_write_pending,
            "inverter_number_from_ip": engine.inverter_number_from_ip,
            "handle_auto_reset": engine.handle_auto_reset,
            "clients": dict(engine.clients),
            "shared": dict(engine.shared),
            "intervals": dict(engine.intervals),
            "ip_map": dict(engine.ip_map),
            "static_units": dict(engine.static_units),
            "auto_reset_state": dict(engine.auto_reset_state),
            "unit_health": dict(engine._unit_health),
            "FAIL_THRESHOLD": engine.UNIT_DEAD_FAIL_THRESHOLD,
            "REPROBE_S": engine.UNIT_DEAD_REPROBE_S,
            "DISABLE": engine.DISABLE_UNIT_DEAD_BACKOFF,
        }

        self.ip = "10.0.0.1"
        self.inv_num = 1
        self.read_log = []        # (ip, unit) for EVERY read attempt that ran
        self.dead_units = set()   # units whose mock read returns None (no answer)

        async def fake_detect_units_async(ip):
            return list(engine.static_units.get(ip) or []) if ip == self.ip else []

        async def fake_read_fast_async(client, unit, ip):
            self.read_log.append((ip, unit))
            if unit in self.dead_units:
                return None  # simulate an absent / faulted slave
            return {
                "pac": 1000, "alarm": 0, "on_off": 1, "kwh": 0.0, "day": 1,
                "rtc_valid": True, "rtc_drift_s": 0.0, "year": 2026,
            }

        engine.detect_units_async = fake_detect_units_async
        engine.read_fast_async = fake_read_fast_async
        engine.is_write_pending = lambda ip: False
        engine.inverter_number_from_ip = (
            lambda ip: self.inv_num if ip == self.ip else None
        )

        async def fake_handle_auto_reset(*a, **k):
            return None

        engine.handle_auto_reset = fake_handle_auto_reset

        engine.clients.clear()
        engine.clients[self.ip] = object()
        engine.shared.clear()
        engine.intervals.clear()
        engine.intervals[self.ip] = 0.01
        engine.ip_map.clear()
        engine.ip_map[str(self.inv_num)] = self.ip
        engine.static_units.clear()
        engine.static_units[self.ip] = [1, 2, 3, 4]
        engine.auto_reset_state.clear()
        engine._unit_health.clear()

        # Tight, deterministic backoff for the test.
        engine.DISABLE_UNIT_DEAD_BACKOFF = False
        engine.UNIT_DEAD_FAIL_THRESHOLD = 3
        engine.UNIT_DEAD_REPROBE_S = 0.2

    async def asyncTearDown(self):
        engine.detect_units_async = self._orig["detect_units_async"]
        engine.read_fast_async = self._orig["read_fast_async"]
        engine.is_write_pending = self._orig["is_write_pending"]
        engine.inverter_number_from_ip = self._orig["inverter_number_from_ip"]
        engine.handle_auto_reset = self._orig["handle_auto_reset"]
        for name in ("clients", "shared", "intervals", "ip_map",
                     "static_units", "auto_reset_state"):
            d = getattr(engine, name)
            d.clear()
            d.update(self._orig[name])
        engine._unit_health.clear()
        engine._unit_health.update(self._orig["unit_health"])
        engine.UNIT_DEAD_FAIL_THRESHOLD = self._orig["FAIL_THRESHOLD"]
        engine.UNIT_DEAD_REPROBE_S = self._orig["REPROBE_S"]
        engine.DISABLE_UNIT_DEAD_BACKOFF = self._orig["DISABLE"]

    def _counts(self):
        c = {1: 0, 2: 0, 3: 0, 4: 0}
        for (ip, u) in self.read_log:
            if ip == self.ip:
                c[u] = c.get(u, 0) + 1
        return c

    async def test_dead_unit_is_throttled_while_siblings_keep_fast_cadence(self):
        """A single dead node must NOT drag down its healthy siblings."""
        self.dead_units = {2}
        task = asyncio.create_task(engine.poll_inverter(self.ip))
        try:
            # Phase 1 — let the throttle engage (3 consecutive misses).
            await asyncio.sleep(0.4)
            h = engine._unit_health.get((self.ip, 2))
            self.assertIsNotNone(h, "dead unit should have a health entry")
            self.assertTrue(h.get("throttled"), "dead unit should be throttled")
            for u in (1, 3, 4):
                self.assertNotIn(
                    (self.ip, u), engine._unit_health,
                    f"healthy sibling {u} must carry no throttle state",
                )

            # Phase 2 — measure cadence with the throttle already in effect, so
            # the result is independent of the one-off initial-fail transient and
            # robust to scheduler jitter (no boundary math). The contract: every
            # healthy sibling out-polls the throttled unit, and the window is
            # large enough to be meaningful.
            self.read_log.clear()
            await asyncio.sleep(0.6)
            c = self._counts()
            self.assertGreater(
                c[1], 3, f"test window should yield several poll cycles; unit1={c[1]}",
            )
            for u in (1, 3, 4):
                self.assertGreater(
                    c[u], c[2],
                    f"healthy sibling {u} ({c[u]}) must out-poll throttled unit 2 ({c[2]})",
                )
        finally:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    async def test_throttled_unit_resumes_fast_polling_on_recovery(self):
        """When a dead node answers again, it returns to fast cadence at once."""
        self.dead_units = {2}
        task = asyncio.create_task(engine.poll_inverter(self.ip))
        try:
            await asyncio.sleep(0.4)
            self.assertTrue(
                engine._unit_health.get((self.ip, 2), {}).get("throttled"),
                "unit 2 should be throttled after sustained failure",
            )
            # Node recovers. Allow > REPROBE_S (0.2 s) so the first re-probe
            # fires and clears the throttle.
            self.dead_units = set()
            await asyncio.sleep(0.3)
            self.assertNotIn(
                (self.ip, 2), engine._unit_health,
                "recovered unit must have its throttle state cleared",
            )
            # Then measure that it polls at the SAME fast cadence as a healthy
            # sibling (relative — robust to scheduler jitter).
            self.read_log.clear()
            await asyncio.sleep(0.4)
            c = self._counts()
            self.assertGreater(
                c[2], c[1] * 0.6,
                f"recovered unit 2 ({c[2]}) should poll ~as fast as healthy unit 1 ({c[1]})",
            )
        finally:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    async def test_transient_single_miss_does_not_throttle(self):
        """A one-off miss below the threshold must not throttle a live unit."""
        self.dead_units = {2}
        task = asyncio.create_task(engine.poll_inverter(self.ip))
        try:
            # Let unit 2 miss once or twice (below threshold of 3), then recover
            # before the throttle would arm.
            await asyncio.sleep(0.02)
            self.dead_units = set()
            await asyncio.sleep(0.05)
            # Unit 2 must not be throttled by a brief sub-threshold miss.
            h = engine._unit_health.get((self.ip, 2))
            self.assertFalse(
                bool(h and h.get("throttled")),
                f"a brief miss must not throttle a recovering unit; health={h}",
            )
            # And it keeps the same fast cadence as a healthy sibling (relative —
            # robust to scheduler jitter, no magic count).
            self.read_log.clear()
            await asyncio.sleep(0.3)
            c = self._counts()
            self.assertGreater(
                c[2], c[1] * 0.6,
                f"unit 2 ({c[2]}) should poll ~as fast as unit 1 ({c[1]}) after a transient miss",
            )
        finally:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    async def test_disable_flag_restores_every_cycle_probe(self):
        """With the kill-switch set, a dead unit is probed every cycle (legacy)."""
        engine.DISABLE_UNIT_DEAD_BACKOFF = True
        self.dead_units = {2}
        task = asyncio.create_task(engine.poll_inverter(self.ip))
        try:
            await asyncio.sleep(0.4)
            c = self._counts()
            # Legacy behaviour: unit 2 attempted on (nearly) every cycle, so its
            # read count tracks the healthy units instead of being throttled.
            self.assertGreater(
                c[2], c[1] / 2.0,
                f"with backoff disabled unit 2 should be probed every cycle; "
                f"unit2={c[2]} unit1={c[1]}",
            )
            self.assertEqual(
                engine._unit_health.get((self.ip, 2)), None,
                "disabled backoff must not populate the health map",
            )
        finally:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    async def test_all_units_dead_throttle_and_recover(self):
        """Whole inverter unreachable: every unit throttles (no per-cycle
        socket thrashing), the map stays bounded, and recovery works when a
        node answers again."""
        self.dead_units = {1, 2, 3, 4}
        task = asyncio.create_task(engine.poll_inverter(self.ip))
        try:
            # All four units should throttle after their consecutive misses.
            await asyncio.sleep(0.5)
            for u in (1, 2, 3, 4):
                h = engine._unit_health.get((self.ip, u))
                self.assertTrue(
                    bool(h and h.get("throttled")),
                    f"unit {u} should throttle when the whole inverter is dead; health={h}",
                )
            # Health map is bounded to exactly the configured units (no growth).
            self.assertEqual(
                len([k for k in engine._unit_health if k[0] == self.ip]), 4,
                "health map must hold exactly one entry per configured unit",
            )
            # Once throttled, the per-cycle probe rate collapses — measure that
            # the total read attempts over a window stay low (no thrashing).
            self.read_log.clear()
            await asyncio.sleep(0.6)
            attempts = len([1 for (ip, _u) in self.read_log if ip == self.ip])
            # 4 units × ~3 reprobes (0.6s / 0.2s) ≈ 12 max; a non-throttled loop
            # would attempt 4 units × ~12 cycles ≈ 48. Assert well under that.
            self.assertLess(
                attempts, 24,
                f"throttled all-dead inverter must not thrash the bus; attempts={attempts}",
            )
            # One unit recovers → its throttle clears, it polls fast again.
            self.dead_units = {1, 2, 3}
            await asyncio.sleep(0.3)
            self.assertNotIn(
                (self.ip, 4), engine._unit_health,
                "recovered unit 4 must clear its throttle",
            )
        finally:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

if __name__ == "__main__":
    unittest.main()
