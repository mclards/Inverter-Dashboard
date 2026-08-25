"""Phase 2 proof: the GATED live transport + orchestrator.

Zero real network: a FakeSocket bridges MBAP↔MockDSP so the live path is
exercised end-to-end without touching an inverter. The bulk of these tests
assert that the safety gates REFUSE an unsafe live flash before any I/O.
"""
import os
import struct
import unittest

from services import firmware_loader as fw
from services import firmware_transport as ft

_FW = os.path.join(os.path.dirname(__file__), "..", "..", "docs",
                   "AAV1003IJK01BC_InverterFirmware.S")

class _SlaveId:
    """Minimal duck of vendor_pdu.SlaveIdInfo for the compat gate.

    `model_code` is the AUTHORITATIVE running firmware (AAV1003xx) — the field
    the compat/downgrade gate actually uses. `firmware_main` defaults to a
    realistic AAS aux string (FC11 bytes [70:79]) precisely to prove it does
    NOT drive the decision.
    """
    def __init__(self, model_code="AAV1003BA", firmware_main="AAS1091AA"):
        self.model_code = model_code
        self.firmware_main = firmware_main

class _FakeSocket:
    """Emulates the transparent MBAP→RTU gateway + DSP, in memory."""
    def __init__(self, dsp):
        self._dsp = dsp
        self._out = b""

    def settimeout(self, _t):  # noqa: D401
        pass

    def sendall(self, wire):
        txn, proto, length, unit = struct.unpack(">HHHB", wire[:7])
        pdu = wire[7:7 + length - 1]
        frame = bytes([unit]) + pdu                  # rebuild RTU view
        resp = self._dsp.query(frame, 1.0)           # [node,func,status,...]
        body = bytes(resp[1:])                        # gateway drops unit
        self._out += struct.pack(">HHHB", txn, proto, len(body) + 1,
                                 resp[0]) + body

    def recv(self, n):
        if not self._out:
            raise OSError("no data")
        chunk, self._out = self._out[:n], self._out[n:]
        return chunk

    def close(self):
        pass

class _Lock:
    def __init__(self):
        self.entered = self.exited = False
    def __enter__(self):
        self.entered = True
        return self
    def __exit__(self, *a):
        self.exited = True
        return False

class TestVerifyFirmwareFile(unittest.TestCase):
    def test_accepts_real_file_and_returns_sha(self):
        d = ft.verify_firmware_file(_FW)
        self.assertEqual(len(d), 64)
        # Deterministic — second call identical.
        self.assertEqual(d, ft.verify_firmware_file(_FW))

    def test_sha_allowlist_mismatch_rejected(self):
        with self.assertRaises(ft.FlashGateError) as e:
            ft.verify_firmware_file(_FW, expected_sha256="deadbeef")
        self.assertIn("SHA-256", str(e.exception))

    def test_missing_non_s_empty_oversize_badname_rejected(self):
        import tempfile
        with self.assertRaises(ft.FlashGateError):
            ft.verify_firmware_file("d:/nope.S")
        with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as t:
            t.write("AAV1003")
            p_txt = t.name
        with tempfile.NamedTemporaryFile("w", suffix=".S", delete=False) as t:
            p_empty = t.name                          # 0 bytes
        with tempfile.NamedTemporaryFile("w", suffix=".S", delete=False) as t:
            t.write("S00600")
            p_badname = t.name                        # base name not LLLnnnn
        try:
            with self.assertRaises(ft.FlashGateError):
                ft.verify_firmware_file(p_txt)        # not .S
            with self.assertRaises(ft.FlashGateError):
                ft.verify_firmware_file(p_empty)      # empty
            with self.assertRaises(ft.FlashGateError):
                ft.verify_firmware_file(_FW, max_bytes=16)   # oversize
            with self.assertRaises(ft.FlashGateError):
                ft.verify_firmware_file(p_badname)    # filename rule
        finally:
            for p in (p_txt, p_empty, p_badname):
                os.unlink(p)

    def test_allowed_dir_confines_path(self):
        good_dir = os.path.dirname(_FW)
        self.assertTrue(ft.verify_firmware_file(_FW, allowed_dir=good_dir))
        with self.assertRaises(ft.FlashGateError):
            ft.verify_firmware_file(_FW, allowed_dir="d:/ADSI-Dashboard/server")

class TestCompatGate(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.img = fw.load_srec(_FW, 1, 512)

    def test_none_identity_blocks(self):
        with self.assertRaises(ft.FlashGateError):
            ft.verify_inverter_compatible(None, self.img, _FW)

    def test_model_mismatch_blocks(self):
        with self.assertRaises(ft.FlashGateError) as e:
            ft.verify_inverter_compatible(_SlaveId(model_code="ZZZ9999"),
                                          self.img, _FW)
        self.assertIn("not for this unit", str(e.exception))

    def test_compatible_passes(self):
        ft.verify_inverter_compatible(_SlaveId(), self.img, _FW)  # no raise

    def test_downgrade_blocked_unless_forced(self):
        # Downgrade is judged on model_code (authoritative AAV1003xx), not
        # firmware_main. File version is "BC"; unit version "ZZ" > "BC".
        newer = _SlaveId(model_code="AAV1003ZZ")
        with self.assertRaises(ft.FlashGateError):
            ft.verify_inverter_compatible(newer, self.img, _FW)
        ft.verify_inverter_compatible(newer, self.img, _FW,
                                      allow_downgrade=True)  # no raise

    def test_downgrade_ignores_aux_firmware_main(self):
        # firmware_main (AAS aux) is a different namespace than the AAV file
        # code and must NEVER trigger a false downgrade block (the old bug:
        # comparing firmware_main vs the filename code).
        unit = _SlaveId(model_code="AAV1003BA", firmware_main="AAS9999ZZ")
        ft.verify_inverter_compatible(unit, self.img, _FW)  # no raise

    def test_upgrade_direction_classified(self):
        # ISM QueHableAhoraOCalleParaSiempre equivalent.
        self.assertEqual(
            ft.firmware_upgrade_direction(_SlaveId(model_code="AAV1003BA"),
                                          _FW)["direction"], "upgrade")
        self.assertEqual(
            ft.firmware_upgrade_direction(_SlaveId(model_code="AAV1003ZZ"),
                                          _FW)["direction"], "downgrade")
        self.assertEqual(
            ft.firmware_upgrade_direction(_SlaveId(model_code="AAV1003BC"),
                                          _FW)["direction"], "same")

class TestEmbeddedFirmwareCode(unittest.TestCase):
    """ISM VerificaFicheroFirmware — embedded-code-vs-filename guard."""

    def test_real_file_passes(self):
        self.assertEqual(fw.verify_embedded_firmware_code(_FW, 1), "AAV1003BC")
        self.assertEqual(fw.verify_embedded_firmware_code(_FW, 6), "AAV1003BC")

    def test_renamed_file_rejected(self):
        import shutil
        import tempfile
        d = tempfile.mkdtemp()
        try:
            bad = os.path.join(d, "AAV1003IJK01ZZ_InverterFirmware.S")
            shutil.copy(_FW, bad)               # rename BC->ZZ, contents same
            with self.assertRaises(fw.FirmwareError) as e:
                fw.verify_embedded_firmware_code(bad, 1)
            self.assertIn("Invalid firmware", str(e.exception))
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_orchestrator_rejects_renamed_in_dryrun(self):
        # The orchestrator runs the embedded-code check for dry-run too, so a
        # renamed image can never be dry-run-blessed and then flashed.
        import shutil
        import tempfile
        d = tempfile.mkdtemp()
        try:
            bad = os.path.join(d, "AAV1003IJK01ZZ_InverterFirmware.S")
            shutil.copy(_FW, bad)
            with self.assertRaises(fw.FirmwareError):
                ft.flash_inverter_node(firmware_path=bad, node=4)
        finally:
            shutil.rmtree(d, ignore_errors=True)

class TestTransportFraming(unittest.TestCase):
    def test_mbap_roundtrip_via_fakesocket(self):
        img = fw.load_srec(_FW, 1, 512)
        dsp = fw.MockDSP(img, node=4)
        tr = ft.ModbusVendorTcpTransport("10.0.0.9")
        tr._socket_factory = lambda h, p, to: _FakeSocket(dsp)
        tr.connect()
        start = fw.crear_trama_0x90(4, False)          # [4,0x90,0,0,0,0]
        resp = tr.query(start, 1.0)
        self.assertEqual(resp[0], 4)                   # node echo
        self.assertEqual(resp[1], 0x90)                # func echo
        self.assertEqual(resp[2], 0)                   # accepted
        tr.close()

    def test_host_required(self):
        with self.assertRaises(ft.FlashGateError):
            ft.ModbusVendorTcpTransport("")

class TestOrchestratorDryRun(unittest.TestCase):
    def test_dry_run_default_never_touches_socket(self):
        res, dsp = ft.flash_inverter_node(firmware_path=_FW, node=4)
        self.assertTrue(res.ok)
        self.assertTrue(dsp.global_checksum_ok)

    def test_unknown_mode_rejected(self):
        with self.assertRaises(ft.FlashGateError):
            ft.flash_inverter_node(firmware_path=_FW, node=4, mode="yolo")

class TestLiveGates(unittest.TestCase):
    """Every gate must refuse BEFORE any wire I/O."""

    @classmethod
    def setUpClass(cls):
        cls.good_dry, _ = ft.flash_inverter_node(firmware_path=_FW, node=4)

    def _base(self, **over):
        kw = dict(firmware_path=_FW, node=4, mode="live", host="10.0.0.9",
                  confirm_irreversible=True, dry_run_result=self.good_dry,
                  bus_lock=_Lock(), audit=lambda e, d: None,
                  slave_id=_SlaveId(), transport=_DummyOK())
        kw.update(over)
        return kw

    def test_happy_live_path_with_injected_transport(self):
        events = []
        lock = _Lock()
        res = ft.flash_inverter_node(**self._base(
            bus_lock=lock, audit=lambda e, d: events.append(e),
            transport=_DspTransport(fw.load_srec(_FW, 1, 512), 4)))
        self.assertTrue(res.ok)
        self.assertTrue(lock.entered and lock.exited)
        # ISM emits the upgrade/downgrade direction just before the start.
        self.assertEqual(events[0], "firmware.pre_flash.direction")
        self.assertEqual(events[1], "firmware.live.start")
        self.assertEqual(events[-1], "firmware.live.ok")

    def test_confirm_required(self):
        with self.assertRaises(ft.FlashGateError):
            ft.flash_inverter_node(**self._base(confirm_irreversible=False))

    def test_broadcast_node_rejected(self):
        with self.assertRaises(ft.FlashGateError):
            ft.flash_inverter_node(**self._base(node=0))
        with self.assertRaises(ft.FlashGateError):
            ft.flash_inverter_node(**self._base(node=300))

    def test_host_required_live(self):
        with self.assertRaises(ft.FlashGateError):
            ft.flash_inverter_node(**self._base(host=None))

    def test_prior_dry_run_required(self):
        with self.assertRaises(ft.FlashGateError):
            ft.flash_inverter_node(**self._base(dry_run_result=None))
        bad = fw.FlashResult(False, 0, 0, 0, 0, 0, 0, "x")
        with self.assertRaises(ft.FlashGateError):
            ft.flash_inverter_node(**self._base(dry_run_result=bad))

    def test_bus_lock_required(self):
        with self.assertRaises(ft.FlashGateError) as e:
            ft.flash_inverter_node(**self._base(bus_lock=None))
        self.assertIn("poller-lockout", str(e.exception))

    def test_audit_required(self):
        with self.assertRaises(ft.FlashGateError):
            ft.flash_inverter_node(**self._base(audit=None))

    def test_identity_required(self):
        with self.assertRaises(ft.FlashGateError):
            ft.flash_inverter_node(**self._base(slave_id=None))

    # ── RS485 / serial link gate ────────────────────────────────────────
    def test_serial_happy_path_with_injected_rtu(self):
        events = []
        lock = _Lock()
        res = ft.flash_inverter_node(**self._base(
            host=None, serial_port="COM9", bus_lock=lock,
            audit=lambda e, d: events.append((e, d)),
            transport=_DspTransport(fw.load_srec(_FW, 1, 512), 4)))
        self.assertTrue(res.ok)
        self.assertTrue(lock.entered and lock.exited)
        self.assertEqual(events[0][0], "firmware.pre_flash.direction")
        self.assertEqual(events[1][0], "firmware.live.start")
        # Audit records the serial link, not a phantom host.
        self.assertEqual(events[1][1]["host"], "serial:COM9")
        self.assertEqual(events[-1][0], "firmware.live.ok")

    def test_serial_requires_injected_transport(self):
        # serial_port set but no transport injected → refuse (caller owns
        # the COM port; flash_inverter_node won't build a serial one).
        kw = self._base(host=None, serial_port="COM9")
        kw.pop("transport")
        with self.assertRaises(ft.FlashGateError):
            ft.flash_inverter_node(**kw)

    def test_serial_and_host_both_rejected(self):
        with self.assertRaises(ft.FlashGateError):
            ft.flash_inverter_node(**self._base(host="10.0.0.9",
                                                serial_port="COM9"))

    def test_neither_host_nor_serial_rejected(self):
        with self.assertRaises(ft.FlashGateError):
            ft.flash_inverter_node(**self._base(host=None,
                                                serial_port=None))

class _DummyOK:
    """Transport that ACKs everything — only reached if gates PASS, so used
    by negative tests via _base() (they raise before query)."""
    def query(self, frame, t):
        return bytes([frame[0], frame[1], 0])

class _DspTransport:
    """Transport adapter wrapping a MockDSP for the happy-path live test."""
    def __init__(self, image, node):
        self._dsp = fw.MockDSP(image, node)
    def connect(self):
        pass
    def close(self):
        pass
    def query(self, frame, t):
        return self._dsp.query(frame, t)

class _FakeSerial:
    """In-memory pyserial stand-in: bridges RTU ADU ↔ MockDSP, zero
    hardware. Mirrors _FakeSocket but for the serial wire (CRC16, no
    MBAP). `corrupt` flips a reply byte to exercise the CRC gate."""
    def __init__(self, dsp, corrupt=False):
        self._dsp = dsp
        self._corrupt = corrupt
        self._buf = b""
        self.timeout = 1.0

    def reset_input_buffer(self):
        self._buf = b""

    def flush(self):
        pass

    def write(self, adu):
        # adu = [node] + pdu + crc16(le). Strip CRC → firmware frame
        # [node,func,…,xor] (the RTU view MockDSP expects).
        frame = bytes(adu[:-2])
        resp = self._dsp.query(frame, 1.0)            # [node,func,status,…]
        body = bytes(resp)
        data = body + struct.pack("<H", ft._modbus_crc16(body))
        if self._corrupt:
            # Flip a byte AFTER the CRC is appended so the embedded CRC
            # no longer matches (exercises the transport's CRC gate).
            data = bytes([data[0] ^ 0xFF]) + data[1:]
        self._buf += data
        return len(adu)

    def read(self, n):
        chunk, self._buf = self._buf[:n], self._buf[n:]
        return chunk

    def close(self):
        pass

class _CannedSerial(_FakeSerial):
    """Returns a fixed FC11 ADU so report_slave_id parsing/CRC is proven
    without a MockDSP FC11 implementation."""
    def __init__(self, payload):
        super().__init__(dsp=None)
        self._payload = payload          # the post-byte_count payload

    def write(self, adu):
        node = adu[0]
        body = bytes([node, 0x11, len(self._payload)]) + self._payload
        self._buf += body + struct.pack("<H", ft._modbus_crc16(body))
        return len(adu)

class TestRtuTransport(unittest.TestCase):
    def test_port_required(self):
        with self.assertRaises(ft.FlashGateError):
            ft.ModbusVendorRtuTransport("")

    def test_rtu_roundtrip_via_fakeserial(self):
        img = fw.load_srec(_FW, 1, 512)
        dsp = fw.MockDSP(img, node=4)
        tr = ft.ModbusVendorRtuTransport("COM9")
        tr._serial_factory = lambda *a: _FakeSerial(dsp)
        tr.connect()
        start = fw.crear_trama_0x90(4, False)          # [4,0x90,0,0,0,0]
        resp = tr.query(start, 1.0)
        self.assertEqual(resp[0], 4)                    # node echo
        self.assertEqual(resp[1], 0x90)                 # func echo
        self.assertEqual(resp[2], 0)                    # accepted
        tr.close()

    def test_rtu_crc_mismatch_raises(self):
        img = fw.load_srec(_FW, 1, 512)
        tr = ft.ModbusVendorRtuTransport("COM9")
        tr._serial_factory = lambda *a: _FakeSerial(fw.MockDSP(img, 4),
                                                    corrupt=True)
        tr.connect()
        with self.assertRaises(ft.TransportError):
            tr.query(fw.crear_trama_0x90(4, False), 1.0)

    def test_rtu_full_dry_equivalent_flash(self):
        # Drive the WHOLE state machine over the fake serial wire.
        img = fw.load_srec(_FW, 1, 512)
        tr = ft.ModbusVendorRtuTransport("COM9")
        tr._serial_factory = lambda *a: _FakeSerial(fw.MockDSP(img, 4))
        tr.connect()
        frames = fw.build_all_frames(img, 4, False)
        res = fw.flash_node(frames, tr, node=4, sleep=lambda _s: None)
        self.assertTrue(res.ok)
        tr.close()

    def test_rtu_report_slave_id_parses(self):
        # 102-byte INGECON-shaped payload: serial @2..13, model @34..43.
        payload = bytearray(102)
        payload[0:2] = b"\x7d\xff"
        payload[2:14] = b"400152A17R52"
        payload[34:44] = b"AAV1003BA "
        tr = ft.ModbusVendorRtuTransport("COM9")
        tr._serial_factory = lambda *a: _CannedSerial(bytes(payload))
        tr.connect()
        sid = tr.report_slave_id(4, timeout_s=1.0)
        self.assertEqual(sid.model_code, "AAV1003BA")
        self.assertEqual(sid.serial, "400152A17R52")
        tr.close()

if __name__ == "__main__":
    unittest.main()
