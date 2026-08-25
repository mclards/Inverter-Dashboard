"""Phase 1a proof: services.firmware_loader vs the REAL firmware S-record.

These tests are the brick-safety gate for the parse/flash-map half of the
firmware feature. They validate the byte-for-byte ISM port against
`docs/AAV1003IJK01BC_InverterFirmware.S` and against an INDEPENDENT
reference decode written here from scratch (different code path than the
module under test) — plus the facts independently derived in
`audits/2026-05-18/ism-per-node-firmware-upgrade.md`.

No inverter, no socket, no Modbus. Pure file + math.
"""
import os
import unittest

from services import firmware_loader as fw

_FW = os.path.join(
    os.path.dirname(__file__), "..", "..", "docs",
    "AAV1003IJK01BC_InverterFirmware.S",
)

def _read_lines():
    with open(_FW, "r", encoding="latin-1") as fh:
        return [ln.strip() for ln in fh if ln.strip()]

class TestSrecChecksum(unittest.TestCase):
    """valida_linea_de_sfile must accept every line of the intact file and
    reject tampering — this is the file-integrity guard."""

    def test_every_line_in_real_file_is_valid(self):
        bad = [ln[:20] for ln in _read_lines() if not fw.valida_linea_de_sfile(ln)]
        self.assertEqual(bad, [], f"{len(bad)} SREC lines failed checksum")

    def test_tampered_data_byte_is_rejected(self):
        lines = _read_lines()
        s3 = next(ln for ln in lines if ln.startswith("S3"))
        # Flip one data nibble; checksum must now fail.
        i = 14
        flipped = s3[:i] + ("0" if s3[i] != "0" else "1") + s3[i + 1:]
        self.assertTrue(fw.valida_linea_de_sfile(s3))
        self.assertFalse(fw.valida_linea_de_sfile(flipped))

    def test_length_mismatch_rejected(self):
        s3 = next(ln for ln in _read_lines() if ln.startswith("S3"))
        self.assertFalse(fw.valida_linea_de_sfile(s3 + "AA"))  # extra pair

class TestAuditDerivedFacts(unittest.TestCase):
    """Cross-check against the independent figures in the 2026-05-18 audit."""

    def test_record_counts_and_entry(self):
        lines = _read_lines()
        self.assertEqual(sum(ln.startswith("S0") for ln in lines), 1)
        self.assertEqual(sum(ln.startswith("S3") for ln in lines), 1624)
        self.assertEqual(sum(ln.startswith("S7") for ln in lines), 1)
        img = fw.load_srec(_FW, arg_dsp=1, arg_longitud_trama=512)
        self.assertIn("PROGRAM&DATA", img.s0_header)
        self.assertEqual(img.s7_entry, 0x0000B153)

class TestFlashMap(unittest.TestCase):
    """build_flash_map = CargaMapaFlashDSP80x port."""

    def test_dsp807_map_shape(self):
        b = fw.build_flash_map(1)               # arg_dsp 1 → DSP807 map
        self.assertEqual(len(b), 5)
        self.assertEqual((b[0].flash_start, b[0].flash_end), (0x2000, 0x3FFF))
        self.assertEqual(b[0].program_memory, 0)               # X-flash
        self.assertEqual((b[1].flash_start, b[1].flash_end), (0x0004, 0x7FFF))
        self.assertEqual((b[2].flash_start, b[2].flash_end), (0x8000, 0xEFFF))
        self.assertEqual((b[3].flash_start, b[3].flash_end), (0xF800, 0xFFFF))
        self.assertEqual((b[4].flash_start, b[4].flash_end), (0x0000, 0x0003))
        # bank[4] shares interface_address 0x1380 with bank[3] ⇒ duplicate.
        self.assertEqual(b[3].interface_address, 0x1380)
        self.assertEqual(b[4].interface_address, 0x1380)
        self.assertEqual(b[4].duplicate, 1)
        self.assertEqual(b[3].duplicate, 0)
        self.assertEqual(len(b[3].page_erase_map), 129)        # non-dup
        self.assertEqual(len(b[4].page_erase_map), 1)          # dup
        self.assertEqual(b[4].page_erase_map[0], 3)            # master idx
        for bank in b:
            self.assertEqual(len(bank.data),
                             bank.flash_end - bank.flash_start + 1)
            self.assertTrue(all(w == 0xFFFF for w in bank.data))

    def test_dsp803_map_differs(self):
        b = fw.build_flash_map(99)              # not in {1,6} → DSP803 map
        self.assertEqual((b[0].flash_start, b[0].flash_end), (0x1000, 0x1FFF))
        self.assertEqual((b[1].flash_start, b[1].flash_end), (0x0004, 0x7DFF))
        self.assertEqual(b[4].interface_address, 0x0F80)

    def test_dir_flash_2_index(self):
        b = fw.build_flash_map(1)
        # 0xEFFF is in P-flash bank[2] (0x8000..0xEFFF, program_memory=1).
        self.assertEqual(fw.dir_flash_2_index(b, 0xEFFF, 1), 2)
        # 0x2500 X-flash (program_memory=0) → bank[0].
        self.assertEqual(fw.dir_flash_2_index(b, 0x2500, 0), 0)
        # No match → returns len(banks) (callers guard with < len).
        self.assertEqual(fw.dir_flash_2_index(b, 0x9999, 0), len(b))

class TestTargetDspGates(unittest.TestCase):
    def test_unsupported_s(self):
        for d in (4, 5):
            with self.assertRaises(fw.FirmwareError) as e:
                fw.load_srec(_FW, arg_dsp=d, arg_longitud_trama=512)
            self.assertIn('".s"', str(e.exception))

    def test_2005_or_older(self):
        with self.assertRaises(fw.FirmwareError) as e:
            fw.load_srec(_FW, arg_dsp=2, arg_longitud_trama=512)
        self.assertIn("2005 or older", str(e.exception))

def _independent_decode(lines):
    """Reference S3 decoder written from scratch (NOT using the module) so a
    bug shared with the module can't hide. Returns {(tipo, addr): word}
    where tipo 1 = P-flash, 0 = X-flash (addr already de-based)."""
    mem = {}
    for ln in lines:
        if not ln.startswith("S3"):
            continue
        count = int(ln[2:4], 16)
        addr = int(ln[4:12], 16)
        nwords = (count - 5) // 2
        if addr > 0x200000:
            addr -= 0x200000
            tipo = 0
        else:
            tipo = 1
        for k in range(nwords):
            lo = int(ln[12 + 4 * k:14 + 4 * k], 16)
            hi = int(ln[14 + 4 * k:16 + 4 * k], 16)
            mem[(tipo, addr + k)] = (lo + hi * 256) & 0xFFFF
    return mem

class TestFlashImageEquivalence(unittest.TestCase):
    """Strongest proof: every written word in the real file must land in the
    loader's banks at the right address with the right value, and blank
    words stay 0xFFFF — verified against the independent decoder."""

    @classmethod
    def setUpClass(cls):
        cls.lines = _read_lines()
        cls.ref = _independent_decode(cls.lines)
        cls.img = fw.load_srec(_FW, arg_dsp=1, arg_longitud_trama=512)

    def test_loader_runs_clean_on_real_file(self):
        self.assertEqual(self.img.flag_flash_externa, 1)   # arg_dsp 1 ≠ 3
        self.assertIn(self.img.dir_flash_init, (0xEFFF, 0x7FFF))

    def test_every_reference_word_present_in_banks(self):
        banks = self.img.banks
        checked = 0
        for (tipo, addr), word in self.ref.items():
            idx = fw.dir_flash_2_index(banks, addr, tipo)
            if idx >= len(banks):
                # Address outside any DSP807 bank: ISM also drops it
                # (idx >= len guard). Acceptable, but assert it's rare.
                continue
            b = banks[idx]
            self.assertEqual(
                b.data[addr - b.flash_start], word,
                f"mismatch tipo={tipo} addr=0x{addr:04X} "
                f"bank[{idx}] exp=0x{word:04X}",
            )
            checked += 1
        # The vast majority of words must have mapped into a bank.
        self.assertGreater(checked, len(self.ref) * 0.9,
                           f"only {checked}/{len(self.ref)} words mapped")

    def test_blank_words_remain_ffff(self):
        banks = self.img.banks
        for tipo in (0, 1):
            for idx, b in enumerate(banks):
                if b.program_memory != tipo:
                    continue
                # Sample 200 evenly-spaced offsets; unwritten ⇒ 0xFFFF.
                step = max(1, len(b.data) // 200)
                for off in range(0, len(b.data), step):
                    addr = b.flash_start + off
                    if (tipo, addr) not in self.ref:
                        self.assertEqual(
                            b.data[off], 0xFFFF,
                            f"bank[{idx}] off {off} should be blank")

    def test_frame_counts_consistent(self):
        c = self.img.counts
        self.assertGreater(c.num_tramas_pflash, 0)        # program flash written
        if c.flag_flash_externa:
            self.assertEqual(
                c.num_tramas_total,
                c.num_tramas_pflash + c.num_tramas_pflash2 + c.num_tramas_xflash)
        else:
            self.assertEqual(
                c.num_tramas_total,
                c.num_tramas_pflash + c.num_tramas_xflash)
        # Smaller frame length ⇒ at least as many frames.
        big = fw.load_srec(_FW, arg_dsp=1, arg_longitud_trama=1024)
        self.assertGreaterEqual(c.num_tramas_total, big.counts.num_tramas_total)

    def test_corrupted_s3_line_raises(self):
        # Build a temp file with one S3 checksum byte flipped.
        import tempfile
        out = []
        flipped_once = False
        for ln in self.lines:
            if ln.startswith("S3") and not flipped_once:
                ln = ln[:-2] + ("00" if ln[-2:] != "00" else "01")
                flipped_once = True
            out.append(ln)
        with tempfile.NamedTemporaryFile("w", suffix=".S", delete=False,
                                         encoding="latin-1") as tf:
            tf.write("\n".join(out))
            tmp = tf.name
        try:
            with self.assertRaises(fw.FirmwareError) as e:
                fw.load_srec(tmp, arg_dsp=1, arg_longitud_trama=512)
            self.assertIn("S3 line", str(e.exception))
        finally:
            os.unlink(tmp)

class TestPhase1bFrameBuilders(unittest.TestCase):
    """Frame builders = CrearTrama0x90/91/92 + AvanzaFlash + global checksum.

    The decisive test reconstructs the flash image from the *generated
    frames* and asserts it equals the Phase-1a banks — which TestFlashImage
    Equivalence already proved equal to the real .S via an independent
    decoder. Transitively: frames → real firmware bytes.
    """

    @classmethod
    def setUpClass(cls):
        cls.img = fw.load_srec(_FW, arg_dsp=1, arg_longitud_trama=512)
        cls.frames = fw.build_all_frames(cls.img, node=4, legacy50=False)

    def test_hardcoded_offsets_equal_bank_starts(self):
        # ISM uses literal bank-base constants; assert they really equal the
        # DSP807 bank flash_start values (defence-in-depth vs map drift).
        b = self.img.banks
        self.assertEqual(fw._PFLASH_BASE, b[1].flash_start)
        self.assertEqual(fw._PFLASH2_BASE, b[2].flash_start)
        self.assertEqual(fw._XFLASH_BASE_807, b[0].flash_start)
        self.assertEqual(fw.build_flash_map(99)[0].flash_start,
                         fw._XFLASH_BASE_803)

    def test_envelope_shape(self):
        fr = self.frames
        self.assertEqual(len(fr), self.img.counts.num_tramas_total + 2)
        self.assertEqual(len(fr[0]), 6)
        self.assertEqual(fr[0][0], 4)            # node
        self.assertEqual(fr[0][1], 0x90)         # START modern
        self.assertEqual(fr[-1][1], 0x92)        # END modern
        for f in fr[1:-1]:
            self.assertEqual(f[0], 4)
            self.assertEqual(f[1], 0x91)         # DATA modern

    def test_every_frame_xor_checksum_self_consistent(self):
        # If the trailing XOR is wrong the DSP NACKs (status 1) — but a bug
        # that is *self-consistent yet wrong vs ISM* would still brick, so we
        # also pin the exact algorithm in test_known_vectors below.
        for n, f in enumerate(self.frames):
            if f[1] in (0x90, 0x96):
                continue  # 6-byte fixed frames carry no checksum byte
            self.assertEqual(
                f[-1], fw.xor_checksum(list(f[:-1])),
                f"frame {n} func=0x{f[1]:02X} checksum mismatch")

    def test_known_vectors(self):
        # Pin the primitive algorithms with hand-computed vectors so a
        # regression can't silently change the wire format.
        self.assertEqual(fw.crear_trama_0x90(4, False), bytes([4, 0x90, 0, 0, 0, 0]))
        self.assertEqual(fw.crear_trama_0x90(4, True), bytes([4, 0x50, 0, 0, 0, 0]))
        self.assertEqual(fw.crear_trama_0x96(7), bytes([7, 0x96, 0, 0, 0, 0]))
        # XOR%256 of [0x04,0x91,0x00,0x04,0x02,0x00] = 0x97
        self.assertEqual(fw.xor_checksum([0x04, 0x91, 0x00, 0x04, 0x02, 0x00]),
                         0x04 ^ 0x91 ^ 0x00 ^ 0x04 ^ 0x02 ^ 0x00)

    def test_legacy_pre2009_opcodes(self):
        fr = fw.build_all_frames(self.img, node=4, legacy50=True)
        self.assertEqual(fr[0][1], 0x50)
        self.assertEqual(fr[1][1], 0x51)
        self.assertEqual(fr[-1][1], 0x52)

    def test_end_frame_global_checksum(self):
        # Recompute the global checksum with a fully independent XOR loop
        # (not calling the module's calculo_checksum_global) and assert the
        # 0x92 frame carries it.
        b = self.img.banks
        chk = 0
        for i in range(0, b[0].flash_end - b[0].flash_start - 256 + 1):
            chk ^= b[0].data[i]
        # external (arg_dsp 1 ≠ 3): banks 1 then 2
        for i in range(0, b[1].flash_end - b[1].flash_start + 1):
            chk ^= b[1].data[i]
        for i in range(0, b[2].flash_end - b[2].flash_start - 2 + 1):
            chk ^= b[2].data[i]
        chk = (chk + 2) & 0xFFFF
        end = self.frames[-1]
        self.assertEqual(end[2], (chk // 256) & 0xFF)
        self.assertEqual(end[3], chk % 256)
        self.assertEqual(end[4], fw.xor_checksum(list(end[:4])))

    def test_frames_reconstruct_phase1a_banks(self):
        """Replay the frame stream into fresh banks and assert it equals the
        Phase-1a image (proven == real .S). Bank selection here is an
        INDEPENDENT threshold model, not a call into avanza_flash."""
        img = self.img
        recon = fw.build_flash_map(1)            # fresh 0xFFFF banks
        c = img.counts
        n_p, n_p2, n_x = (c.num_tramas_pflash, c.num_tramas_pflash2,
                          c.num_tramas_xflash)
        xbase = 8192                              # DSP807
        data_frames = self.frames[1:-1]
        for ordinal, f in enumerate(data_frames, start=1):  # tramas_creadas
            dir_flash = (f[2] << 8) | f[3]
            byte_count = (f[4] << 8) | f[5]
            payload = f[6:-1]                     # drop memtype + xor? NO:
            # frame = hdr(6) + 2*byte_count data + memtype + xor
            words = []
            for k in range(byte_count):
                words.append((payload[2 * k] << 8) | payload[2 * k + 1])
            # Independent bank selector (threshold model from the protocol):
            if img.flag_flash_externa:
                if ordinal <= n_p:
                    bi, base = 1, fw._PFLASH_BASE
                elif ordinal <= n_p + n_p2:
                    bi, base = 2, fw._PFLASH2_BASE
                else:
                    bi, base = 0, xbase
            else:
                if ordinal <= n_p:
                    bi, base = 1, fw._PFLASH_BASE
                else:
                    bi, base = 0, xbase
            idx = dir_flash - base
            for w in words:
                if 0 <= idx < len(recon[bi].data):
                    recon[bi].data[idx] = w
                idx += 1
        # SAFETY PROPERTY: only banks 0 (X-data), 1 (app P-flash low) and
        # 2 (app P-flash high) are ever transmitted. Bank 3 (0xF800-0xFFFF
        # bootloader) and bank 4 (0x0000-0x0003 reset vector) are loaded
        # into the model from the .S but ISM deliberately NEVER sends them,
        # so a failed application flash leaves the bootloader intact and the
        # node is re-flashable. Assert exactly that.
        for bi in (0, 1, 2):
            self.assertEqual(
                recon[bi].data, img.banks[bi].data,
                f"reconstructed bank[{bi}] != phase-1a bank[{bi}]")
        # Bank 3 carries real boot data in the image (from the .S)…
        self.assertTrue(any(w != 0xFFFF for w in img.banks[3].data),
                        "expected boot data in image bank[3]")
        # …but the frame stream must NOT have written it (stays erased).
        self.assertTrue(all(w == 0xFFFF for w in recon[3].data),
                        "bootloader bank[3] must never be transmitted")
        self.assertTrue(all(w == 0xFFFF for w in recon[4].data),
                        "reset-vector bank[4] must never be transmitted")

class TestPhase1cDryRun(unittest.TestCase):
    """End-to-end hardware-free flash: parse → frames → state machine →
    MockDSP receiver. If every layer is internally consistent against the
    real .S, the MockDSP's flash equals the image and the global checksum
    matches. Also exercises the retry/abort paths via fault injection."""

    @classmethod
    def setUpClass(cls):
        cls.img = fw.load_srec(_FW, arg_dsp=1, arg_longitud_trama=512)

    def test_clean_dry_run_matches_image(self):
        msgs = []
        res, dsp = fw.dry_run(self.img, node=4,
                              on_progress=lambda m, p: msgs.append(m))
        self.assertTrue(res.ok)
        self.assertTrue(dsp.global_checksum_ok)
        self.assertEqual(res.no_replies, 0)
        self.assertEqual(res.frame_chk_errors, 0)
        self.assertEqual(res.flash_errors, 0)
        self.assertEqual(res.frames_acked, self.img.counts.num_tramas_total)
        self.assertIn("Firmware loaded correctly", res.message)
        self.assertTrue(any("Firmware loaded correctly" in m for m in msgs))
        for bi in (0, 1, 2):
            self.assertEqual(dsp.received_banks[bi].data,
                             self.img.banks[bi].data,
                             f"MockDSP bank[{bi}] != image bank[{bi}]")
        # Bootloader / reset-vector never received.
        self.assertTrue(all(w == 0xFFFF for w in dsp.received_banks[3].data))
        self.assertTrue(all(w == 0xFFFF for w in dsp.received_banks[4].data))

    def test_legacy_dry_run_ok(self):
        res, dsp = fw.dry_run(self.img, node=4, legacy50=True)
        self.assertTrue(res.ok and dsp.global_checksum_ok)

    def test_recoverable_nack_then_success(self):
        res, dsp = fw.dry_run(self.img, node=4, faults={5: "nack"})
        self.assertTrue(res.ok)
        self.assertEqual(res.frame_chk_errors, 1)
        self.assertTrue(dsp.global_checksum_ok)
        for bi in (0, 1, 2):
            self.assertEqual(dsp.received_banks[bi].data,
                             self.img.banks[bi].data)

    def test_recoverable_err2_then_success(self):
        res, _ = fw.dry_run(self.img, node=4, faults={3: "err2"})
        self.assertTrue(res.ok)
        self.assertEqual(res.flash_errors, 1)

    def test_recoverable_timeout_then_success(self):
        res, _ = fw.dry_run(self.img, node=4, faults={2: "timeout"})
        self.assertTrue(res.ok)
        self.assertGreaterEqual(res.no_replies, 1)

    def test_first_frame_wait_is_before_first_data_send(self):
        """Regression: the extra mass-erase-margin pause for the first
        0x91 frame must be emitted BEFORE that frame is put on the wire
        (ISM step 5), not after its reply — otherwise it never covers
        the timeout it exists for."""
        events = []
        SENTINEL = 5.0

        class Rec:
            def query(self, frame, t):
                events.append(("q", frame[1]))           # record func
                return bytes([frame[0], frame[1], 0])    # ACK everything

        frames = fw.build_all_frames(self.img, 4, False)
        fw.flash_node(
            frames, Rec(), node=4,
            sleep=lambda s: events.append(("s", s)),
            erase_wait_s=0, first_frame_wait_s=SENTINEL,
            finalize_wait_s=0, nack_wait_s=0, err2_wait_s=0,
            noreply_wait_s=0,
        )
        first_wait = next(k for k, e in enumerate(events)
                          if e == ("s", SENTINEL))
        first_data_q = next(k for k, e in enumerate(events)
                            if e[0] == "q" and e[1] == fw.FUNC_DATA_MODERN)
        self.assertLess(
            first_wait, first_data_q,
            "first-frame erase-margin wait must precede the first 0x91 send")

    def test_fatal_status_3_raises(self):
        with self.assertRaises(fw.FirmwareError) as e:
            fw.dry_run(self.img, node=4, faults={6: "fatal"})
        self.assertIn("error 3", str(e.exception))

    def test_start_never_answered_raises(self):
        class Dead:
            def query(self, frame, t):
                raise TimeoutError("no reply")
        frames = fw.build_all_frames(self.img, node=4)
        with self.assertRaises(fw.FirmwareError) as e:
            fw.flash_node(frames, Dead(), node=4, num_intentos=3,
                          sleep=lambda _s: None)
        self.assertIn("did not reply to firmware update request",
                      str(e.exception))

    def test_global_checksum_rejected_raises(self):
        class BadEnd:
            def __init__(self): self.n = 0
            def query(self, frame, t):
                fn = frame[1]
                if fn == fw.FUNC_END_MODERN:
                    return bytes([frame[0], fn, 3])     # reject checksum
                return bytes([frame[0], fn, 0])
        frames = fw.build_all_frames(self.img, node=4)
        with self.assertRaises(fw.GlobalChecksumError) as e:
            fw.flash_node(frames, BadEnd(), node=4, sleep=lambda _s: None)
        self.assertIn("Global checksum error", str(e.exception))

    def test_data_frame_exhausts_retries_raises_with_diag(self):
        class AlwaysNack:
            def query(self, frame, t):
                fn = frame[1]
                if fn == fw.FUNC_DATA_MODERN:
                    return bytes([frame[0], fn, 1])     # perpetual NACK
                return bytes([frame[0], fn, 0])
        frames = fw.build_all_frames(self.img, node=4)
        with self.assertRaises(fw.FirmwareError) as e:
            fw.flash_node(frames, AlwaysNack(), node=4, num_intentos=3,
                          sleep=lambda _s: None)
        self.assertIn("FrameCHKErrors:", str(e.exception))

class TestPhase1Hardening(unittest.TestCase):
    """Regression locks for the post-review hardening (size guard,
    truncated-frame NACK, narrowed exception handling)."""

    def test_oversize_file_rejected(self):
        import tempfile
        orig = fw.MAX_SREC_BYTES
        try:
            fw.MAX_SREC_BYTES = 64
            with tempfile.NamedTemporaryFile("w", suffix=".S", delete=False,
                                             encoding="latin-1") as tf:
                tf.write("S0" + "0" * 200)
                tmp = tf.name
            with self.assertRaises(fw.FirmwareError) as e:
                fw.load_srec(tmp, arg_dsp=1, arg_longitud_trama=512)
            self.assertIn("too large", str(e.exception))
        finally:
            fw.MAX_SREC_BYTES = orig
            os.unlink(tmp)

    def test_empty_file_rejected(self):
        import tempfile
        with tempfile.NamedTemporaryFile("w", suffix=".S", delete=False) as tf:
            tmp = tf.name                     # zero bytes
        try:
            with self.assertRaises(fw.FirmwareError) as e:
                fw.load_srec(tmp, arg_dsp=1, arg_longitud_trama=512)
            self.assertIn("Unexpected error while reading firmware file!",
                          str(e.exception))
        finally:
            os.unlink(tmp)

    def test_missing_file_rejected_cleanly(self):
        with self.assertRaises(fw.FirmwareError) as e:
            fw.load_srec("d:/nope/does_not_exist.S", 1, 512)
        self.assertIn("cannot stat firmware file", str(e.exception))

    def test_mockdsp_nacks_truncated_data_frame(self):
        img = fw.load_srec(_FW, arg_dsp=1, arg_longitud_trama=512)
        frames = fw.build_all_frames(img, node=4)
        dsp = fw.MockDSP(img, node=4)
        dsp.query(frames[0], 1.0)                  # 0x90 start (ordinal 0)
        good = frames[1]                            # first 0x91
        truncated = good[:10]                       # header says big payload
        resp = dsp.query(truncated, 1.0)
        self.assertEqual(resp[2], 1)                # NACK, not a crash
        self.assertEqual(dsp._ordinal, 0)           # write pointer NOT moved
        # The correct frame still applies cleanly afterwards.
        self.assertEqual(dsp.query(good, 1.0)[2], 0)
        self.assertEqual(dsp._ordinal, 1)

    def test_transport_protocol_satisfied_by_mockdsp(self):
        img = fw.load_srec(_FW, arg_dsp=1, arg_longitud_trama=512)
        # MockDSP must structurally satisfy the Transport protocol.
        self.assertIsInstance(fw.MockDSP(img, 4), fw.Transport)

    def test_programming_error_in_transport_propagates(self):
        # A bug in the transport (AttributeError) must NOT be masked as a
        # no-reply/retry — it has to surface (brick-safety).
        class BuggyTransport:
            def query(self, frame, t):
                raise AttributeError("transport bug")
        frames = fw.build_all_frames(
            fw.load_srec(_FW, arg_dsp=1, arg_longitud_trama=512), node=4)
        with self.assertRaises(AttributeError):
            fw.flash_node(frames, BuggyTransport(), node=4, num_intentos=2,
                          sleep=lambda _s: None)

if __name__ == "__main__":
    unittest.main()
