"""Unit tests for services/firmware_buslock.py — the cross-process
firmware-flash bus lock that stops the dashboard poller contending on an
inverter the calibrator is flashing.

Invariants (non-negotiable — a wrong call here either lets two Modbus
masters collide and brick a flash, or silently silences live polling):
  • claim -> active_ips lists the inverter; release removes it.
  • a claim expires on its own (hard TTL backstop for a crashed job).
  • heartbeat extends the expiry.
  • FAIL-OPEN: a missing / empty / corrupt marker yields NO active claims.
  • serial flashes (inverter_ip falsy) never write a claim.
  • the writer is atomic (no torn read mid-write).
"""

import json
import os
import tempfile
import unittest

from services import firmware_buslock as bl

class FirmwareBusLockTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.mkdtemp(prefix="fwlock-test-")
        self._prev = os.environ.get("PROGRAMDATA")
        os.environ["PROGRAMDATA"] = self._tmp  # _marker_path() reads this live

    def tearDown(self):
        if self._prev is None:
            os.environ.pop("PROGRAMDATA", None)
        else:
            os.environ["PROGRAMDATA"] = self._prev

    def test_claim_then_active_then_release(self):
        self.assertEqual(bl.active_ips(), set())
        bl.claim("192.168.1.101", 1, 1, "job-a", ttl_s=120)
        self.assertEqual(bl.active_ips(), {"192.168.1.101"})
        bl.release("job-a")
        self.assertEqual(bl.active_ips(), set())

    def test_expiry_is_honoured(self):
        bl.claim("10.0.0.5", 2, 2, "job-b", ttl_s=120)
        now = bl._now_ms()
        self.assertIn("10.0.0.5", bl.active_ips(now))
        # 121 s later the claim is stale even without an explicit release.
        self.assertEqual(bl.active_ips(now + 121_000), set())

    def test_heartbeat_extends_expiry(self):
        bl.claim("10.0.0.9", 1, 1, "job-c", ttl_s=120)
        bl.heartbeat("10.0.0.9", 1, 1, "job-c", ttl_s=120)
        raw = json.load(open(bl._marker_path(), encoding="utf-8"))
        self.assertEqual(len(raw["claims"]), 1)  # heartbeat replaces, not dupes
        self.assertIn("10.0.0.9", bl.active_ips())

    def test_serial_flash_writes_no_claim(self):
        bl.claim(None, 1, 1, "job-serial", ttl_s=120)   # link_host None
        bl.claim("", 1, 1, "job-serial2", ttl_s=120)     # empty
        self.assertEqual(bl.active_ips(), set())

    def test_two_inverters_independent(self):
        bl.claim("10.0.0.1", 1, 1, "j1", ttl_s=120)
        bl.claim("10.0.0.2", 1, 1, "j2", ttl_s=120)
        self.assertEqual(bl.active_ips(), {"10.0.0.1", "10.0.0.2"})
        bl.release("j1")
        self.assertEqual(bl.active_ips(), {"10.0.0.2"})

    def test_fail_open_on_corrupt_marker(self):
        with open(bl._marker_path(), "w", encoding="utf-8") as fh:
            fh.write("{ this is not json ")
        self.assertEqual(bl.active_ips(), set())          # no crash, no claims
        # and a subsequent claim still works (overwrites the garbage).
        bl.claim("10.0.0.7", 1, 1, "jx", ttl_s=120)
        self.assertEqual(bl.active_ips(), {"10.0.0.7"})

    def test_fail_open_on_missing_marker(self):
        p = bl._marker_path()
        if os.path.exists(p):
            os.unlink(p)
        self.assertEqual(bl.active_ips(), set())

    def test_filter_active_pure(self):
        now = 1_000_000
        raw = {"claims": [
            {"inverter_ip": "a", "expires_ms": now + 1},     # active
            {"inverter_ip": "b", "expires_ms": now - 1},     # expired
            {"inverter_ip": "", "expires_ms": now + 9},      # no ip -> drop
            {"expires_ms": now + 9},                          # no ip key
            "not-a-dict",
        ]}
        ips = {c["inverter_ip"] for c in bl.filter_active(raw, now)}
        self.assertEqual(ips, {"a"})
        # Non-dict / missing structure -> [] (never raises).
        self.assertEqual(bl.filter_active(None, now), [])
        self.assertEqual(bl.filter_active({"claims": "x"}, now), [])
        self.assertEqual(bl.filter_active({}, now), [])

if __name__ == "__main__":
    unittest.main()
