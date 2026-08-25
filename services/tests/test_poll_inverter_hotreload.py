"""
Regression test for the v2.11.0-beta.6 fix that hardens `poll_inverter` so
node-list / poll-interval changes take effect WITHOUT a service restart.

Bug:
    The fast-poll coroutine captured `units = await detect_units_async(ip)`
    once per outer iteration. The inner `while True` loop iterated over that
    cached list forever while the client stayed up, so a newly-configured
    node never received a `read_fast_async` call and the dashboard table
    row remained "-" until the operator restarted the service.

Fix:
    Refresh `units` from `static_units[ip]` AND `interval` from `intervals[ip]`
    on every inner-loop cycle. Reading the dicts directly (instead of calling
    `detect_units_async`) avoids the helper's 4-probe auto-detect path and its
    5 s probe-failure throttle — both of which would have penalised the
    hot-reload path on every cycle when no static override is configured.

This test mutates the module globals that `rebuild_global_maps` would
otherwise write to, and asserts the running poll loop picks up the change
within a few cycles.
"""

import asyncio
import unittest

import services.inverter_engine as engine

class PollInverterHotReloadTests(unittest.IsolatedAsyncioTestCase):
    """Lock the contract: ipconfig unit-list changes propagate without restart."""

    async def asyncSetUp(self):
        # Snapshot module globals so the test cannot leak state into others.
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
        }

        self.ip = "10.0.0.1"
        self.inv_num = 1
        self.read_log = []   # (ip, unit) tuples — appended by mock read

        # --- Mocks ---
        async def fake_detect_units_async(ip):
            # Mirror the production helper: static override wins. Used only
            # for the initial detect at the top of the outer iter; the inner
            # loop now reads static_units directly.
            return list(engine.static_units.get(ip) or []) if ip == self.ip else []

        async def fake_read_fast_async(client, unit, ip):
            self.read_log.append((ip, unit))
            return {
                "pac": 1000, "alarm": 0, "on_off": 1, "kwh": 0.0, "day": 1,
                "rtc_valid": True, "rtc_drift_s": 0.0, "year": 2026,
            }

        def fake_is_write_pending(ip):
            return False

        def fake_inverter_number_from_ip(ip):
            return self.inv_num if ip == self.ip else None

        async def fake_handle_auto_reset(*args, **kwargs):
            return None

        engine.detect_units_async = fake_detect_units_async
        engine.read_fast_async = fake_read_fast_async
        engine.is_write_pending = fake_is_write_pending
        engine.inverter_number_from_ip = fake_inverter_number_from_ip
        engine.handle_auto_reset = fake_handle_auto_reset

        engine.clients.clear()
        engine.clients[self.ip] = object()
        engine.shared.clear()
        engine.intervals.clear()
        engine.intervals[self.ip] = 0.01
        engine.ip_map.clear()
        engine.ip_map[str(self.inv_num)] = self.ip
        engine.static_units.clear()
        engine.static_units[self.ip] = [1, 2]
        engine.auto_reset_state.clear()

    async def asyncTearDown(self):
        engine.detect_units_async = self._orig["detect_units_async"]
        engine.read_fast_async = self._orig["read_fast_async"]
        engine.is_write_pending = self._orig["is_write_pending"]
        engine.inverter_number_from_ip = self._orig["inverter_number_from_ip"]
        engine.handle_auto_reset = self._orig["handle_auto_reset"]
        engine.clients.clear()
        engine.clients.update(self._orig["clients"])
        engine.shared.clear()
        engine.shared.update(self._orig["shared"])
        engine.intervals.clear()
        engine.intervals.update(self._orig["intervals"])
        engine.ip_map.clear()
        engine.ip_map.update(self._orig["ip_map"])
        engine.static_units.clear()
        engine.static_units.update(self._orig["static_units"])
        engine.auto_reset_state.clear()
        engine.auto_reset_state.update(self._orig["auto_reset_state"])

    async def _drain_for(self, seconds):
        await asyncio.sleep(seconds)

    async def test_unit_added_mid_flight_is_polled_without_restart(self):
        task = asyncio.create_task(engine.poll_inverter(self.ip))
        try:
            await self._drain_for(0.15)
            units_seen = {u for (ip, u) in self.read_log if ip == self.ip}
            self.assertEqual(
                units_seen, {1, 2},
                f"before config change, only units 1 & 2 should be polled, got {units_seen}",
            )

            # Operator adds nodes 3 & 4. rebuild_global_maps rebinds
            # static_units[ip] atomically — simulate that here.
            pre_change_count = len(self.read_log)
            engine.static_units[self.ip] = [1, 2, 3, 4]
            await self._drain_for(0.15)

            new_reads = self.read_log[pre_change_count:]
            new_units_seen = {u for (ip, u) in new_reads if ip == self.ip}
            self.assertTrue(
                {3, 4}.issubset(new_units_seen),
                f"after config change, units 3 & 4 must be polled without "
                f"restart; saw {new_units_seen} in {len(new_reads)} reads",
            )
        finally:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    async def test_unit_removed_mid_flight_stops_being_polled(self):
        engine.static_units[self.ip] = [1, 2, 3, 4]
        task = asyncio.create_task(engine.poll_inverter(self.ip))
        try:
            await self._drain_for(0.15)
            seen_before = {u for (ip, u) in self.read_log if ip == self.ip}
            self.assertEqual(seen_before, {1, 2, 3, 4})

            engine.static_units[self.ip] = [1, 2]
            self.read_log.clear()
            await self._drain_for(0.15)

            seen_after = {u for (ip, u) in self.read_log if ip == self.ip}
            self.assertEqual(
                seen_after, {1, 2},
                f"after trim, units 3 & 4 must stop being polled; saw {seen_after}",
            )
        finally:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    async def test_empty_static_units_keeps_last_good_list(self):
        """If `static_units[ip]` is cleared to None/[] (auto-detect path), the
        inner loop must NOT blank the live unit list — keep polling the last
        known-good list rather than going dark."""
        task = asyncio.create_task(engine.poll_inverter(self.ip))
        try:
            await self._drain_for(0.15)
            self.assertTrue(self.read_log, "polling should have started")

            engine.static_units[self.ip] = []  # operator cleared override
            self.read_log.clear()
            await self._drain_for(0.10)

            seen = {u for (ip, u) in self.read_log if ip == self.ip}
            self.assertEqual(
                seen, {1, 2},
                f"empty override must not blank the unit list; saw {seen}",
            )
        finally:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    async def test_poll_interval_change_is_picked_up_without_restart(self):
        """Operator retunes poll_interval mid-flight. The fix re-reads
        `intervals[ip]` each cycle, so a longer interval slows the read
        cadence without requiring a service restart.

        `MIN_POLL_INTERVAL` floors the value at ~0.05 s so the fast-cadence
        sample is dominated by that floor; the slow phase drops cycles to
        near-zero. Compare the rates rather than relying on absolute counts.
        """
        engine.intervals[self.ip] = 0.01  # clamped up to MIN_POLL_INTERVAL
        task = asyncio.create_task(engine.poll_inverter(self.ip))
        try:
            await self._drain_for(0.40)
            fast_reads = len(self.read_log)
            self.assertGreater(
                fast_reads, 3,
                f"fast cadence should produce multiple cycles; got {fast_reads}",
            )

            engine.intervals[self.ip] = 0.5
            self.read_log.clear()
            await self._drain_for(0.20)

            slow_reads = len(self.read_log)
            # Per-cycle reads = len(units) = 2; with 0.5 s sleep we should
            # see at most ~1 cycle in 0.2 s. The fast phase ran for 0.4 s at
            # ~0.05 s/cycle so should be materially higher per unit time.
            fast_rate = fast_reads / 0.40
            slow_rate = slow_reads / 0.20
            self.assertLess(
                slow_rate, fast_rate / 2.0,
                f"interval bump should at least halve read rate; "
                f"fast_rate={fast_rate:.1f}/s slow_rate={slow_rate:.1f}/s",
            )
        finally:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

if __name__ == "__main__":
    unittest.main()
