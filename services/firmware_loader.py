"""INGECON inverter firmware S-record loader — Phase 1a (pure, no I/O).

EXPERIMENTAL / GATED FEATURE. This module is the **brick-safe foundation**
for the Inverter Calibration Tool's firmware-upgrade feature: it only reads
a Motorola S-record file and builds an in-memory model of what would be
flashed. It performs **no Modbus, no socket, no inverter contact whatsoever**
— it cannot brick anything. Frame construction (Phase 1b), the wire state
machine + dry-run simulator (Phase 1c) and the heavily-gated live transport
(Phase 2) are separate modules layered on top, each independently proven
before any byte reaches a real inverter.

Why this matters: a firmware flash is irreversible. The single largest brick
vector is *our* port being subtly wrong vs the vendor tool. So every routine
here is a byte-for-byte port of INGECON SUN Manager's `Cargador`, decoded
from .NET IL of `_ism/FV.IngeBLL.dll`
(`FV.IngeBLL.InternalTools.Firmware.Cargador`). Full protocol reference:
`audits/2026-05-18/ism-per-node-firmware-upgrade.md`.

Ported routines (ISM name → here):
  ValidaLineaDeSFile        → valida_linea_de_sfile   (SREC checksum)
  CargaMapaFlashDSP80x      → build_flash_map         (DSP807/DSP803 banks)
  DirFlash_2_IndexFlashstruct → dir_flash_2_index
  RellenaDatosFlash         → rellena_datos_flash     (S3 → flash words)
  ImportSFile (file half)   → load_srec               (parse + trim)
  CalculaCantidadTramas     → calcula_cantidad_tramas (frame count)

The user's INGECON SUN PowerMax three-phase units are FreescaleDSP56F /
DSP807-class (`arg_dsp` ∈ {1, 6} → the DSP807 flash map). See
`memory/project_ism_firmware_upgrade_protocol.md` and
`memory/project_inverter_dsp_architecture.md`.

This module is pure — no I/O beyond reading the given S-record file path.
"""
from __future__ import annotations

import os
import re
import time
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Protocol, runtime_checkable

# ─── targetDSP enum (ISM FV.IngeBLL.InternalTools.Firmware.targetDSP) ───────
# Values observed in ImportSFile branching (IL):
#   3  → internal flash      (_FlagFlashExterna = 0)
#   2  → "2005 or older"     (rejected — use ISM v1.2 AAX1001_D)
#   4,5→ Texas / CortexM3    (".s" not supported → NotImplementedException)
#   else (incl. DSP807/DSP803 micro codes) → external flash
# `arg_dsp` here is the inverter micro selector that also picks the flash
# map: CargaMapaFlashDSP80x uses the DSP807 map for arg_dsp ∈ {1, 6} and the
# DSP803 map otherwise.
TARGET_DSP_INTERNAL_FLASH = 3
TARGET_DSP_2005_OR_OLDER = 2
TARGET_DSP_UNSUPPORTED_S = (4, 5)

_BLANK_WORD = 0xFFFF
_X_FLASH_ADDR_BASE = 0x200000  # addr ≥ this ⇒ X (data) flash; subtract it

# Defensive cap on the .S file. A real INGECON image is ~270 KB; anything
# far larger is corrupt/hostile and must not be slurped into RAM. Caller
# (Phase 2) still does its own path/allowlist validation — this is a
# last-resort guard so even a mis-wired call can't memory-exhaust.
MAX_SREC_BYTES = 8 * 1024 * 1024  # 8 MiB

class FirmwareError(Exception):
    """Raised on any firmware-file / flash-model error.

    Mirrors ISM `CargaDeFirmwareException`. Message text is kept verbatim
    from ISM where the operator-facing wording matters.
    """

class TransportError(FirmwareError):
    """A live/dry transport failed to deliver/receive a frame.

    `flash_node` treats this (and the stdlib network/timeout errors) as a
    recoverable "no reply" and retries within `num_intentos`. Programming
    errors (AttributeError/TypeError/…) are deliberately NOT caught — they
    must surface, never be silently masked as a missing reply on a live
    flash where masking a real bug could brick a unit.
    """

@runtime_checkable
class Transport(Protocol):
    """Structural contract for the object `flash_node` drives.

    Phase 1 only ever passes the in-process `MockDSP` (dry-run). Phase 2's
    gated live Modbus transport must satisfy exactly this and nothing wider
    — keep the surface minimal so the gating layer can't be bypassed.
    """

    def query(self, frame: bytes, timeout_s: float) -> bytes:
        """Send one framed PDU, return the raw response bytes.

        Must raise `TransportError` (or a stdlib OSError/TimeoutError) on
        no-reply / link failure — never return a partial silently.
        """
        ...

# ─── SREC line checksum (ISM Cargador.ValidaLineaDeSFile) ──────────────────

def valida_linea_de_sfile(line: str) -> bool:
    """Return True if the S-record `line` is well-formed and checksum-valid.

    Byte-for-byte port of `ValidaLineaDeSFile` (returns 0 = OK in ISM; here
    we invert to a bool for Pythonic call sites). Logic:

      declared = u8(line[2:4])                       # byte-count field
      pairs    = (len(line) - 4) // 2                 # actual data pairs
      if pairs != declared: return False             # length mismatch
      s = Σ u8(line[2i:2i+2]) for the count+addr+data bytes
      checksum = (255 - (s % 256)) & 0xFF
      return checksum == u8(line[-2:])

    The S-record checksum covers the byte-count + address + data bytes (i.e.
    everything after the 2-char record type, excluding the trailing checksum
    byte itself) — standard Motorola SREC one's-complement checksum.
    """
    if line is None or len(line) < 4:
        return False
    try:
        declared = int(line[2:4], 16)
    except ValueError:
        return False
    pairs = (len(line) - 4) // 2
    if pairs != declared:
        return False
    # Sum bytes from offset 2 up to (but excluding) the final checksum byte.
    last_pair_index = (len(line) // 2) - 2  # ISM: loc6 = len/2 - 2
    s = 0
    try:
        for i in range(1, last_pair_index + 1):  # ISM loop loc2 = 1 .. loc6
            s += int(line[2 * i:2 * i + 2], 16)
    except ValueError:
        return False
    checksum = 255 - (s % 256)
    try:
        actual = int(line[len(line) - 2:], 16)
    except ValueError:
        return False
    return (checksum & 0xFF) == (actual & 0xFF)

# ─── Flash bank model (ISM Cargador+flash_constants struct) ────────────────

@dataclass
class FlashBank:
    """One flash region. Field names/semantics mirror ISM `flash_constants`.

    `data` holds one 16-bit word per address in [flash_start, flash_end],
    initialised to 0xFFFF (erased). `page_erase_map` length 129 (non-dup)
    or 1 (duplicate → [0] = index of the master bank sharing its
    interface_address).
    """
    page_erase: int
    flash_start: int
    flash_end: int
    program_memory: int
    interface_address: int
    duplicate: int = 0
    page_erase_map: List[int] = field(default_factory=list)
    data: List[int] = field(default_factory=list)
    # Computed by compute_start_addr_data_count (ISM ImportSFile IL_013A..):
    start_addr: int = 0
    data_count: int = 0

    @property
    def size_words(self) -> int:
        """Inclusive span = flash_end − flash_start (ISM uses this exact
        expression repeatedly; the allocated `data` length is +1)."""
        return self.flash_end - self.flash_start

# CargaMapaFlashDSP80x map strings, verbatim from IL. Token layout
# (split on space/tab): [_, Page_Erase(dec), Flash_start(hex), Flash_end(hex),
# Program_memory(dec), Interface_address(hex), <8 ignored>].
_FLASH_MAP_DSP807 = (
    "0 1 0x2000 0x3fff 0 0x1360 0x0002 0x0006 0x001A 0x0033 0x0066 0x001A 0x019A 0x0006",
    "0 0 0x0004 0x7fff 1 0x1340 0x0002 0x0006 0x001A 0x0033 0x0066 0x001A 0x019A 0x0006",
    "0 0 0x8000 0xeffF 1 0x1420 0x0002 0x0006 0x001A 0x0033 0x0066 0x001A 0x019A 0x0006",
    "0 0 0xf800 0xffff 1 0x1380 0x0002 0x0006 0x001A 0x0033 0x0066 0x001A 0x019A 0x0006",
    "0 0 0x0000 0x0003 1 0x1380 0x0002 0x0006 0x001A 0x0033 0x0066 0x001A 0x019A 0x0006",
)
_FLASH_MAP_DSP803 = (
    "0 1 0x1000 0x1fff 0 0x0f60 0x0002 0x0006 0x001A 0x0033 0x0066 0x001A 0x019A 0x0006",
    "0 0 0x0004 0x7dff 1 0x0f40 0x0002 0x0006 0x001A 0x0033 0x0066 0x001A 0x019A 0x0006",
    "0 0 0x8000 0xeffF 1 0x1420 0x0002 0x0006 0x001A 0x0033 0x0066 0x001A 0x019A 0x0006",
    "0 0 0xf800 0xffff 1 0x0f80 0x0002 0x0006 0x001A 0x0033 0x0066 0x001A 0x019A 0x0006",
    "0 0 0x0000 0x0003 1 0x0f80 0x0002 0x0006 0x001A 0x0033 0x0066 0x001A 0x019A 0x0006",
)
# arg_dsp values that select the DSP807 map (ISM: `argDSP == 1 || argDSP == 6`).
_DSP807_ARG_DSP = (1, 6)

def _conv_u16(token: str, base: int) -> int:
    """ISM Convert.ToUInt16 — base 10 or 16; accepts a 0x prefix at base 16.

    ISM passes hex tokens like "0x2000" / "0xeffF" through
    Convert.ToUInt16(s, 16); .NET accepts the 0x prefix and is
    case-insensitive. Python int() with base 16 does too.
    """
    return int(token, base) & 0xFFFF

def build_flash_map(arg_dsp: int) -> List[FlashBank]:
    """Build the FLASH_STRUCT bank list — port of `CargaMapaFlashDSP80x`.

    Bank index order is insertion order (ISM Array.Resize + append), which
    later code depends on:
      [0] X-flash data bank   (program_memory = 0)
      [1] P-flash 0x0004..    (program_memory = 1)
      [2] P-flash 0x8000..
      [3] P-flash 0xf800..0xffff
      [4] P-flash 0x0000..0x0003   (duplicate of [3] — same iface addr)
    """
    rows = _FLASH_MAP_DSP807 if arg_dsp in _DSP807_ARG_DSP else _FLASH_MAP_DSP803
    banks: List[FlashBank] = []
    for row in rows:
        # ISM splits on {' ', '\t'} (chars 0x20, 0x09).
        tok = row.replace("\t", " ").split()
        bank = FlashBank(
            page_erase=_conv_u16(tok[1], 10),
            flash_start=_conv_u16(tok[2], 16),
            flash_end=_conv_u16(tok[3], 16),
            program_memory=_conv_u16(tok[4], 10),
            interface_address=_conv_u16(tok[5], 16),
        )
        idx = len(banks)
        # Duplicate detection: any earlier bank with same interface_address.
        for j in range(idx):
            if banks[j].interface_address == bank.interface_address:
                bank.duplicate = 1
                break
        if not bank.duplicate:
            bank.page_erase_map = [0] * 129
        else:
            # page_erase_map length 1; [0] = index of first earlier bank
            # sharing the interface_address (ISM IL_023F..029C).
            bank.page_erase_map = [0]
            for j in range(idx):
                if banks[j].interface_address == bank.interface_address:
                    bank.page_erase_map[0] = j
                    break
        banks.append(bank)
    # After all banks declared: allocate data[] = (end-start+1) words = 0xFFFF.
    for b in banks:
        b.data = [_BLANK_WORD] * (b.flash_end - b.flash_start + 1)
    return banks

# ─── Address → bank index (ISM Cargador.DirFlash_2_IndexFlashstruct) ───────

def dir_flash_2_index(banks: List[FlashBank], dir_datos: int, tipo_flash: int) -> int:
    """Return the bank index whose program_memory == tipo_flash and whose
    [flash_start, flash_end] contains dir_datos. Port of
    `DirFlash_2_IndexFlashstruct`; if none match it returns len(banks)
    (callers guard with `idx < len(banks)`, exactly as ISM does)."""
    n = len(banks)
    i = 0
    while i < n:
        b = banks[i]
        if (tipo_flash == b.program_memory
                and not (dir_datos < b.flash_start)
                and not (dir_datos > b.flash_end)):
            break
        i += 1
    return i

# ─── S3 record → flash words (ISM Cargador.RellenaDatosFlash) ──────────────

def rellena_datos_flash(line: str, banks: List[FlashBank]) -> None:
    """Decode one S3 line into the flash banks. Port of `RellenaDatosFlash`.

    S3 layout: "S3" + count(2 hex) + address(8 hex) + data + checksum(2).
    nWords = (count − 5) // 2  (count − 4 addr bytes − 1 checksum, /2 per
    16-bit word). Each word's two file bytes are little-endian:
        word = u8(line[12+4k : +2]) + u8(line[14+4k : +2]) * 256
    Address ≥ 0x200000 ⇒ X (data) flash with addr −= 0x200000 and
    tipo_flash = 0; else P (program) flash, tipo_flash = 1.
    """
    addr = int(line[4:12], 16) & 0xFFFFFFFF          # 32-bit S3 address
    count = int(line[2:4], 16) & 0xFFFF              # byte-count field
    n_words = (count - 5) // 2
    words = [0] * n_words
    for k in range(n_words):
        lo = int(line[12 + 4 * k:14 + 4 * k], 16)
        hi = int(line[14 + 4 * k:16 + 4 * k], 16)
        words[k] = (lo + hi * 256) & 0xFFFF

    # IL-FAITHFUL: ISM uses `ble.un` (addr <= 0x200000 ⇒ P-flash), so the
    # X-flash branch is strictly `addr > 0x200000`. Do NOT "fix" to `>=`
    # — that would diverge from the vendor and is a brick risk.
    if addr > _X_FLASH_ADDR_BASE:
        addr -= _X_FLASH_ADDR_BASE
        tipo_flash = 0          # X (data) flash
    else:
        tipo_flash = 1          # P (program) flash

    base = addr
    end = addr + n_words
    pos = base
    while pos < end:
        idx = dir_flash_2_index(banks, pos, tipo_flash)
        if idx < len(banks):
            b = banks[idx]
            b.data[pos - b.flash_start] = words[pos - base] & 0xFFFF
            if not b.duplicate:
                # Mark the 256-word page for erase (ISM stores 2).
                # IL-FAITHFUL: the `% 65536` is exactly ISM's `rem 65536`;
                # it is a no-op for our ≤16-bit addrs but kept verbatim so
                # the port can't silently drift from the vendor.
                page = (pos % 65536 - b.flash_start) // 256
                if 0 <= page < len(b.page_erase_map):
                    b.page_erase_map[page] = 2
        pos += 1

# ─── Start_addr / Data_count trim (ISM ImportSFile IL_013A..0247) ──────────

def compute_start_addr_data_count(banks: List[FlashBank]) -> None:
    """For every bank, trim leading/trailing 0xFFFF (erased) words to derive
    `start_addr` (first non-blank word offset) and `data_count` (span of
    written words). Exact port of the ImportSFile post-parse loop."""
    for b in banks:
        size = b.flash_end - b.flash_start          # inclusive span
        # First non-0xFFFF word from the start.
        s = 0
        while s <= size and b.data[s] == _BLANK_WORD:
            s += 1
        b.start_addr = s & 0xFFFF
        # Last non-0xFFFF word from the end.
        e = size
        while e >= 0 and b.data[e] == _BLANK_WORD:
            e -= 1
        span = e - b.start_addr + 1
        b.data_count = (span & 0xFFFF) if span > 0 else 0

# ─── Frame-count math (ISM Cargador.CalculaCantidadTramas) ─────────────────

def _ceil_div(n: int, d: int) -> int:
    """ISM pattern: q = n / d (unsigned); if n % d != 0: q += 1."""
    q = n // d
    if n % d != 0:
        q += 1
    return q

@dataclass
class FrameCounts:
    num_tramas_pflash: int       # banks[1] (P-flash 0x0004..)
    num_tramas_pflash2: int      # banks[2] (P-flash 0x8000..)
    num_tramas_xflash: int       # banks[0] (X data flash)
    flag_flash_externa: int
    num_tramas_total: int

def calcula_cantidad_tramas(banks: List[FlashBank], arg_longitud_trama: int,
                            arg_dsp: int) -> FrameCounts:
    """Port of `CalculaCantidadTramas`.

      num_tramas_pflash  = ceil(banks[1].data_count / frame_len)
      num_tramas_pflash2 = ceil(banks[2].data_count / frame_len)
      num_tramas_xflash  = ceil(banks[0].data_count / frame_len)
      flag_flash_externa = 0 if (num_tramas_pflash2 == 0 or arg_dsp == 3) else 1
      total = pflash + (pflash2 if external) + xflash
    """
    if arg_longitud_trama <= 0:
        raise FirmwareError(f"invalid frame length: {arg_longitud_trama}")
    n_p = _ceil_div(banks[1].data_count, arg_longitud_trama)
    n_p2 = _ceil_div(banks[2].data_count, arg_longitud_trama)
    n_x = _ceil_div(banks[0].data_count, arg_longitud_trama)
    flag_externa = 0 if (n_p2 == 0 or arg_dsp == TARGET_DSP_INTERNAL_FLASH) else 1
    if flag_externa:
        total = n_p + n_p2 + n_x
    else:
        total = n_p + n_x
    return FrameCounts(n_p, n_p2, n_x, flag_externa, total)

# ─── ImportSFile (file-ingest half) ────────────────────────────────────────

@dataclass
class FirmwareImage:
    """Result of load_srec — the in-memory flash model + frame plan.

    This is what a (future) frame builder + state machine would transmit.
    It is inert data; constructing it touches no inverter.
    """
    path: str
    arg_dsp: int
    arg_longitud_trama: int
    s0_header: str
    s7_entry: int
    banks: List[FlashBank]
    counts: FrameCounts
    flag_flash_externa: int
    dir_flash_init: int          # ISM _dirFlash seed (0xEFFF or 0x7FFF)

def load_srec(path: str, arg_dsp: int, arg_longitud_trama: int) -> FirmwareImage:
    """Parse + validate an S-record and build the flash model.

    Port of the file-ingest half of ISM `Cargador.ImportSFile` (everything
    up to — but NOT including — frame construction or any inverter I/O).
    Raises FirmwareError with ISM-verbatim wording on bad input.

    targetDSP gate (ISM): 4/5 reject (.s unsupported), 2 reject (2005 or
    older), 3 → internal flash, else external.
    """
    if arg_dsp in TARGET_DSP_UNSUPPORTED_S:
        raise FirmwareError('Target DSP not supported for ".s" files')
    if arg_dsp == TARGET_DSP_2005_OR_OLDER:
        raise FirmwareError(
            "Unsupported inverter, 2005 or older. Please use Ingecon Sun "
            "Manager v1.2 (AAX1001_D) "
        )
    flag_flash_externa = 0 if arg_dsp == TARGET_DSP_INTERNAL_FLASH else 1

    # Defensive size guard BEFORE opening — a corrupt/hostile file must not
    # be slurped into RAM. (Phase 2 also validates the path/allowlist.)
    try:
        fsize = os.path.getsize(path)
    except OSError as exc:
        raise FirmwareError(f"cannot stat firmware file: {exc}") from exc
    if fsize > MAX_SREC_BYTES:
        raise FirmwareError(
            f"firmware file too large: {fsize} bytes "
            f"(max {MAX_SREC_BYTES})")
    if fsize == 0:
        raise FirmwareError("Unexpected error while reading firmware file!")

    banks = build_flash_map(arg_dsp)

    s0_header = ""
    s7_entry = -1
    with open(path, "r", encoding="latin-1") as fh:
        line = fh.readline()
        # readline() yields "" only at EOF (size==0 already rejected above);
        # an unreadable first line is still handled by the S0 check below.
        if not line:
            raise FirmwareError("Unexpected error while reading firmware file!")
        line = line.strip()
        if line[0:2] == "S0":
            if not valida_linea_de_sfile(line):
                raise FirmwareError("Error in S0 line")
            # S0 payload: 2-byte addr then ASCII (ISM keeps the raw line;
            # we decode the human-readable name for the verify step).
            try:
                s0_header = bytes.fromhex(line[8:len(line) - 2]).decode(
                    "latin-1", "replace")
            except ValueError:
                s0_header = ""
        else:
            raise FirmwareError("Unexpected error while reading firmware file!")

        while True:
            line = fh.readline()
            if line == "":
                # EOF before S7 — ISM relies on S7 terminating the loop;
                # treat missing S7 as a hard error (cannot trust the image).
                raise FirmwareError("Error in S? line")
            line = line.strip()
            if not line:
                continue
            head = line[0:2]
            if head == "S7":
                if not valida_linea_de_sfile(line):
                    raise FirmwareError("Error in S? line")
                try:
                    s7_entry = int(line[4:12], 16)
                except ValueError:
                    s7_entry = -1
                break
            if head == "S3":
                if not valida_linea_de_sfile(line):
                    raise FirmwareError("Error in S3 line")
                rellena_datos_flash(line, banks)
            else:
                if not valida_linea_de_sfile(line):
                    raise FirmwareError("Error in S? line")

    compute_start_addr_data_count(banks)
    counts = calcula_cantidad_tramas(banks, arg_longitud_trama, arg_dsp)

    # ISM seeds _dirFlash = 0xEFFF, then if that bank has no data falls back
    # to 0x7FFF. We mirror the decision (the frame builder, Phase 1b, will
    # consume it).
    idx = dir_flash_2_index(banks, 0xEFFF, 1)
    dir_flash_init = 0xEFFF
    if idx >= len(banks) or banks[idx].data_count == 0:
        dir_flash_init = 0x7FFF

    return FirmwareImage(
        path=path,
        arg_dsp=arg_dsp,
        arg_longitud_trama=arg_longitud_trama,
        s0_header=s0_header,
        s7_entry=s7_entry,
        banks=banks,
        counts=counts,
        flag_flash_externa=flag_flash_externa,
        dir_flash_init=dir_flash_init,
    )

# ─── Embedded firmware-code verification (ISM VerificaFicheroFirmware) ──────
#
# ISM's primary anti-"wrong file" guard. Before flashing, ISM opens the .S,
# finds the S-record line at a DSP-class-specific flash address, and asserts
# the firmware code embedded THERE matches the code derived from the filename
# — so a renamed or corrupted image (right name, wrong contents, or vice
# versa) is refused with "Invalid firmware" BEFORE any byte hits the wire.
#
# Decoded byte-for-byte from FV.IngeBLL IL (2026-05-31):
#   FreescaleDSP56F.VerificaFicheroFirmware (base get_Posicion… throws
#   NotImplementedException — the constant lives in the DSP807/DSP803
#   overrides), plus the FV.Common.Utiles transforms and
#   FV.idinormasHelper.CodigoFirmware.RemoveIJKcode. Proven to PASS the real
#   docs/AAV1003IJK01BC_InverterFirmware.S (its line at 0x202000 carries
#   `41413156303042332043` = endian-inverted ASCII of "AAV1003BC ").

# The S-record line whose 32-bit address field holds the embedded firmware
# code, per DSP class (ISM DSP807/DSP803 get_PosicionDelCodigoFirmwareEnFichero):
#   DSP807 (arg_dsp ∈ {1,6}) → S3 record at byte-address 0x00202000
#   DSP803 (else)            → S3 record at byte-address 0x00201000
# (0x20xxxx ⇒ X-data flash; this is the start of X-flash bank B, §1.)
_FW_CODE_POS_DSP807 = "S35100202000"
_FW_CODE_POS_DSP803 = "S35100201000"

_RE_IJK = re.compile(r"ijk[0-9][0-9]", re.IGNORECASE)   # ISM RemoveIJKcode

def fw_code_from_filename(path: str) -> str:
    """`AAV1003IJK01BC_InverterFirmware.S` → `AAV1003IJK01BC` (upper, the bare
    code before any `_` suffix). Shared so the embedded-code check and the
    model-prefix compat check derive the filename code identically."""
    stem = os.path.splitext(os.path.basename(path))[0].upper()
    return stem.split("_")[0]

def _remove_ijk_code(name: str) -> str:
    """Port of ISM CodigoFirmware.RemoveIJKcode — strip every `ijkNN`
    (case-insensitive) group. `AAV1003IJK01BC` → `AAV1003BC`."""
    if not name:
        raise FirmwareError("Empty Codfirmware")
    return _RE_IJK.sub("", name)

def _invierte_endianness(s: str) -> str:
    """Port of ISM Utiles.InvierteEndianness — swap adjacent character pairs
    (the DSP56F 16-bit-word byte-swap): out[2k]=in[2k+1], out[2k+1]=in[2k]."""
    a = list(s)
    out = list(a)
    for i in range(0, len(a) - 1, 2):
        out[i], out[i + 1] = a[i + 1], a[i]
    return "".join(out)

def _string_to_hex(s: str) -> str:
    """Port of ISM Utiles.String2HexString — each char → 2 uppercase hex
    digits of its ASCII byte. .NET ASCIIEncoding maps non-ASCII to '?'
    (0x3F); our inputs are ASCII firmware codes so that never triggers."""
    return "".join("{:02X}".format(ord(c) if ord(c) <= 0x7F else 0x3F)
                   for c in s)

def _embedded_code_position(arg_dsp: int) -> str:
    return (_FW_CODE_POS_DSP807 if arg_dsp in _DSP807_ARG_DSP
            else _FW_CODE_POS_DSP803)

def verify_embedded_firmware_code(path: str, arg_dsp: int) -> str:
    """Port of ISM FreescaleDSP56F.VerificaFicheroFirmware.

    Opens the .S, finds the S-record line at the DSP-class flash position,
    and asserts the firmware code embedded there matches the filename-derived
    code. Raises FirmwareError("Invalid firmware") (ISM-verbatim) on any
    mismatch / missing line. Returns the verified code on success.

    Catches a renamed or corrupted image whose embedded version code no
    longer matches its filename — exactly ISM's primary pre-flash protection,
    and a layer the SHA/filename/FC11 gates do not cover. Proven to PASS the
    real docs/AAV1003IJK01BC_InverterFirmware.S.
    """
    code = _remove_ijk_code(fw_code_from_filename(path))   # AAV1003IJK01BC→AAV1003BC
    if len(code) == 10:
        pass
    elif len(code) == 9:
        code = code + " "                                  # ISM pads to 10
    elif len(code) == 8:
        raise FirmwareError(
            "Invalid firmware: filename code is 8 chars after IJK removal "
            "(boot-file naming) — not a main-app image for this flash path")
    else:
        raise FirmwareError(
            "Invalid firmware: cannot derive a 10-char code from filename "
            f"{os.path.basename(path)!r} (got {code.strip()!r})")
    expected_hex = _string_to_hex(_invierte_endianness(code))   # 20 hex chars
    loc5 = expected_hex[0:16]       # first 8 bytes
    loc6 = expected_hex[18:20]      # byte 9 (byte 8 = pad, skipped — as ISM)
    position = _embedded_code_position(arg_dsp)

    try:
        with open(path, "r", encoding="latin-1") as fh:
            for raw in fh:
                line = raw.strip()
                if position not in line:
                    continue
                # The S-record line at the firmware-code flash address.
                if loc5 in line:
                    idx = line.index(loc5)
                    if line[idx + 18:idx + 20] == loc6:
                        return code.strip()        # embedded code matches
                # Position line present but the embedded code mismatches the
                # filename → wrong / renamed / corrupt image.
                raise FirmwareError("Invalid firmware")
    except OSError as exc:
        raise FirmwareError(f"cannot read firmware file: {exc}") from exc
    # No S-record carried the firmware-code at the expected flash address.
    raise FirmwareError("Invalid firmware")

# ════════════════════════════════════════════════════════════════════════════
#  Phase 1b — frame construction (still pure: builds byte[] frames in RAM,
#  sends NOTHING). Byte-for-byte port of ISM Cargador.CrearTrama0x90/91/92/96,
#  AvanzaFlash, Calculo_CheckSum_Global and the ImportSFile frame-build loop.
#  A wrong byte here is the single largest brick vector, so this mirrors the
#  IL exactly — including ISM's hard-coded bank-base offsets (4 / 0x8000 /
#  0x2000|0x1000) rather than "cleaner" equivalents. Frame wire layout and
#  the ACK/error protocol: audits/2026-05-18/ism-per-node-firmware-upgrade.md.
# ════════════════════════════════════════════════════════════════════════════

# Function codes. Modern ≥2009 vs legacy pre-2009 ("Before 2009 three-phase
# models" checkbox → Set50Trama / FlagParcheTrama50).
FUNC_START_MODERN, FUNC_START_LEGACY = 0x90, 0x50   # CrearTrama0x90
FUNC_DATA_MODERN, FUNC_DATA_LEGACY = 0x91, 0x51     # CrearTrama0x91
FUNC_END_MODERN, FUNC_END_LEGACY = 0x92, 0x52       # CrearTrama0x92
FUNC_SPEED = 0x96                                   # CrearTrama0x96

# AvanzaFlash hard-coded bank-base offsets, keyed by arg_dsp (ISM uses the
# literal constants; they equal bank.flash_start — asserted in tests).
_PFLASH_BASE = 4            # bank[1] flash_start (0x0004)
_PFLASH2_BASE = 32768       # bank[2] flash_start (0x8000)
_XFLASH_BASE_807 = 8192     # bank[0] flash_start, DSP807 (0x2000)
_XFLASH_BASE_803 = 4096     # bank[0] flash_start, DSP803 (0x1000)

def _xflash_base(arg_dsp: int) -> int:
    return _XFLASH_BASE_807 if arg_dsp in _DSP807_ARG_DSP else _XFLASH_BASE_803

def xor_checksum(frame_so_far) -> int:
    """ISM trailing checksum: UInt16 XOR-accumulate every byte, then % 256.

    `loc4 = 0; for b in list: loc4 = (loc4 ^ u16(b)) & 0xFFFF;
     list.Add(loc4 % 256)`  (CrearTrama0x91 IL_055B..0597 / 0x92 IL_006F..).
    """
    acc = 0
    for b in frame_so_far:
        acc = (acc ^ (b & 0xFFFF)) & 0xFFFF
    return acc % 256

def calculo_checksum_global(banks: List[FlashBank], flag_flash_externa: int) -> int:
    """Port of `Calculo_CheckSum_Global` — 16-bit XOR over flashed words with
    ISM's exact per-bank end offsets, returns (xor + 2) & 0xFFFF.

      chk = 0
      for i in 0 .. (b0.end-b0.start-256) incl : chk ^= b0.data[i]
      if external:
          for i in 0 .. (b1.end-b1.start)    incl : chk ^= b1.data[i]
          for i in 0 .. (b2.end-b2.start-2)  incl : chk ^= b2.data[i]
      else:
          for i in 0 .. (b1.end-b1.start-2)  incl : chk ^= b1.data[i]
      return (chk + 2) & 0xFFFF
    """
    chk = 0
    end0 = banks[0].flash_end - banks[0].flash_start - 256
    for i in range(0, end0 + 1):
        chk = (chk ^ banks[0].data[i]) & 0xFFFF
    if flag_flash_externa:
        end1 = banks[1].flash_end - banks[1].flash_start
        for i in range(0, end1 + 1):
            chk = (chk ^ banks[1].data[i]) & 0xFFFF
        end2 = banks[2].flash_end - banks[2].flash_start - 2
        for i in range(0, end2 + 1):
            chk = (chk ^ banks[2].data[i]) & 0xFFFF
    else:
        end1b = banks[1].flash_end - banks[1].flash_start - 2
        for i in range(0, end1b + 1):
            chk = (chk ^ banks[1].data[i]) & 0xFFFF
    return (chk + 2) & 0xFFFF

class _CargadorState:
    """Runtime mirror of the ISM Cargador fields used during frame build.

    Constructed from a FirmwareImage; carries the mutable cursor
    (_dir_flash, byte_count, num_struct, tipo_memoria, tramas_creadas)
    that AvanzaFlash and CrearTrama0x91 read/write.
    """

    def __init__(self, image: FirmwareImage, node: int):
        self.banks = image.banks
        self.arg_dsp = image.arg_dsp
        self.arg_longitud_trama = image.arg_longitud_trama
        self.arg_inv = node & 0xFF
        self.flag_flash_externa = image.flag_flash_externa
        c = image.counts
        self.num_tramas_pflash = c.num_tramas_pflash
        self.num_tramas_pflash2 = c.num_tramas_pflash2
        self.num_tramas_xflash = c.num_tramas_xflash
        self.num_tramas_total = c.num_tramas_total
        # Mutable cursor (ISM defaults: _dirFlash seeded then AvanzaFlash
        # overrides on frame 1; tramas_creadas tracks frames built).
        self.dir_flash = image.dir_flash_init
        self.byte_count = 0
        self.num_struct = 0
        self.tipo_memoria = 0
        self.tramas_creadas = 0

def crear_trama_0x90(node: int, legacy: bool) -> bytes:
    """START frame — 6 bytes `[node, 0x50|0x90, 0,0,0,0]` (ISM new Byte[6])."""
    f = bytearray(6)
    f[0] = node & 0xFF
    f[1] = FUNC_START_LEGACY if legacy else FUNC_START_MODERN
    return bytes(f)

def crear_trama_0x96(node: int) -> bytes:
    """SPEED-probe frame — 6 bytes `[node, 0x96, 0,0,0,0]`."""
    f = bytearray(6)
    f[0] = node & 0xFF
    f[1] = FUNC_SPEED
    return bytes(f)

def _emit_words(out: list, data: List[int], lo_idx: int, hi_idx: int) -> None:
    """Append data[lo_idx..hi_idx] inclusive, each 16-bit word big-endian
    (word // 256 then word % 256) — ISM CrearTrama0x91 inner loop."""
    for i in range(lo_idx, hi_idx + 1):
        w = data[i] & 0xFFFF
        out.append(w // 256)
        out.append(w % 256)

def crear_trama_0x91(st: _CargadorState, legacy: bool) -> bytes:
    """DATA frame — exact port of CrearTrama0x91.

    Header: [node, 0x51|0x91, dir/256, dir%256, bc/256, bc%256]
    Body  : data words from the active bank, indexed (_dir_flash - base),
            big-endian; then TipoMemoria byte; then XOR%256 checksum.
    """
    out: list = []
    out.append(st.arg_inv)
    out.append(FUNC_DATA_LEGACY if legacy else FUNC_DATA_MODERN)
    out.append((st.dir_flash // 256) & 0xFF)
    out.append((st.dir_flash % 256) & 0xFF)
    out.append((st.byte_count // 256) & 0xFF)
    out.append((st.byte_count % 256) & 0xFF)

    bc = st.byte_count
    tc = st.tramas_creadas
    n_p = st.num_tramas_pflash
    n_p2 = st.num_tramas_pflash2
    n_x = st.num_tramas_xflash
    xbase = _xflash_base(st.arg_dsp)

    if st.flag_flash_externa:
        if tc == 1:
            _emit_words(out, st.banks[1].data, 0, bc - 1)
        elif tc > 1 and not (tc > n_p):
            lo = st.dir_flash - _PFLASH_BASE
            _emit_words(out, st.banks[1].data, lo, lo + bc - 1)
        elif tc > n_p and not (tc > n_p + n_p2):
            lo = st.dir_flash - _PFLASH2_BASE
            _emit_words(out, st.banks[2].data, lo, lo + bc - 1)
        elif tc > n_p + n_p2 and not (tc > n_p + n_p2 + n_x):
            lo = st.dir_flash - xbase
            _emit_words(out, st.banks[0].data, lo, lo + bc - 1)
        # else: header-only (matches ISM falling straight to the tail)
    else:
        if tc == 1:
            _emit_words(out, st.banks[1].data, 0, bc - 1)
        elif tc > 1 and not (tc > n_p):
            lo = st.dir_flash - _PFLASH_BASE
            _emit_words(out, st.banks[1].data, lo, lo + bc - 1)
        elif tc > n_p and not (tc > n_p + n_x):
            lo = st.dir_flash - xbase
            _emit_words(out, st.banks[0].data, lo, lo + bc - 1)

    out.append(st.tipo_memoria & 0xFFFF)
    out.append(xor_checksum(out))
    return bytes(b & 0xFF for b in out)

def crear_trama_0x92(st: _CargadorState, legacy: bool) -> bytes:
    """END frame — `[node, 0x52|0x92, gck/256, gck%256, XOR%256]`."""
    gck = calculo_checksum_global(st.banks, st.flag_flash_externa)
    out: list = []
    out.append(st.arg_inv)
    out.append(FUNC_END_LEGACY if legacy else FUNC_END_MODERN)
    out.append((gck // 256) & 0xFF)     # ISM Convert.ToByte(gck/256)
    out.append((gck % 256) & 0xFF)
    out.append(xor_checksum(out))
    return bytes(b & 0xFF for b in out)

def avanza_flash(st: _CargadorState) -> None:
    """Port of `AvanzaFlash` — advance the bank cursor between data frames.

    Sets num_struct / tipo_memoria / dir_flash / byte_count at each bank
    boundary; no-op (carry the ImportSFile `dir_flash += frame_len`) for
    interior frames. External and internal-flash variants kept separate to
    mirror the IL exactly.
    """
    tc = st.tramas_creadas
    n_p = st.num_tramas_pflash
    n_p2 = st.num_tramas_pflash2
    n_x = st.num_tramas_xflash
    L = st.arg_longitud_trama
    b = st.banks

    if st.flag_flash_externa:
        if tc == 1:
            st.num_struct = 1
            st.tipo_memoria = b[1].program_memory
            st.dir_flash = 4
            st.byte_count = L - 4
        elif tc == 2:
            st.byte_count = L
            st.dir_flash = L
        elif tc == n_p + 1:
            st.num_struct = 2
            st.tipo_memoria = b[2].program_memory
            st.dir_flash = 32768
            st.byte_count = L
        elif tc == n_p + n_p2:
            st.byte_count = (b[st.num_struct].data_count
                             - (n_p2 - 1) * L
                             + b[st.num_struct].start_addr)
        elif tc == n_p + n_p2 + 1:
            st.num_struct = 0
            st.tipo_memoria = b[0].program_memory
            st.dir_flash = 8192 if st.arg_dsp in _DSP807_ARG_DSP else 4096
            st.byte_count = L
        elif tc == n_p + n_p2 + n_x:
            st.byte_count = b[st.num_struct].data_count - (n_x - 1) * L
        # else: no change (interior frame)
    else:
        if tc == 1:
            st.num_struct = 1
            st.tipo_memoria = b[1].program_memory
            st.dir_flash = 4
            st.byte_count = L - 4
        elif tc == 2:
            st.byte_count = L
            st.dir_flash = L
        elif tc == n_p + 1:
            st.num_struct = 0
            st.tipo_memoria = b[0].program_memory
            st.dir_flash = 8192 if st.arg_dsp in _DSP807_ARG_DSP else 4096
            st.byte_count = L
        elif tc == n_p + n_x:
            if n_x != 0:
                st.byte_count = b[st.num_struct].data_count - (n_x - 1) * L
            else:
                st.byte_count = b[st.num_struct].data_count - (n_p - 1) * L
        # else: no change

def build_all_frames(image: FirmwareImage, node: int,
                      legacy50: bool = False) -> List[bytes]:
    """Pre-build the full frame sequence — port of ImportSFile's frame loop.

      add CrearTrama0x90;  tramas_creadas = 1
      while tramas_creadas <= num_tramas_total:
          AvanzaFlash(); add CrearTrama0x91; dir_flash += frame_len;
          tramas_creadas += 1
      add CrearTrama0x92

    Returns [start, data×N, end]. Inert bytes — sending is Phase 2 only.
    """
    st = _CargadorState(image, node)
    frames: List[bytes] = []
    frames.append(crear_trama_0x90(st.arg_inv, legacy50))
    st.tramas_creadas = 1
    # Guard against a pathological frame plan producing an unbounded loop.
    max_frames = st.num_tramas_total + 4
    while st.tramas_creadas <= st.num_tramas_total:
        avanza_flash(st)
        frames.append(crear_trama_0x91(st, legacy50))
        st.dir_flash += st.arg_longitud_trama
        st.tramas_creadas += 1
        if len(frames) > max_frames:        # defensive; never hit in tests
            raise FirmwareError("frame plan did not terminate")
    frames.append(crear_trama_0x92(st, legacy50))
    return frames

# ════════════════════════════════════════════════════════════════════════════
#  Phase 1c — wire state machine + MockDSP bootloader emulator.
#
#  flash_node() is a faithful port of the FreescaleDSP56F path of
#  CargarYTalVezCambiaElBirtate (the serial-only 0x96 baud-bump is omitted
#  because the gated feature is TCP-only). It is transport-agnostic: the
#  caller injects a `transport.query(frame, timeout) -> response` and a
#  `sleep` function. With the injected MockDSP transport this performs a
#  COMPLETE end-to-end flash with ZERO hardware — the demonstrable, safe
#  dry-run that backs the UI's default mode.
#
#  Response convention (decoded from ISM bTramaRx handling):
#    resp[0]=node echo, resp[1]=func echo, resp[2]=status
#    status: 0=ACK, 1=frame-checksum NACK (resend), 2=DSP busy/err2 (retry),
#            3=fatal. Empty/short/None response = no reply.
# ════════════════════════════════════════════════════════════════════════════

class GlobalChecksumError(FirmwareError):
    """ISM GlobalChecksumException — END frame rejected / unanswered."""

@dataclass
class FlashResult:
    ok: bool
    frames_total: int
    frames_acked: int
    no_replies: int
    frame_chk_errors: int
    flash_errors: int
    rx_frame_errors: int
    message: str

    def diag(self) -> str:
        # ISM verbatim diagnostic string.
        return (f"NoReplies:{self.no_replies}   "
                f"FrameCHKErrors:{self.frame_chk_errors}   "
                f"FlashErrors:{self.flash_errors}   "
                f"RXFrameError:{self.rx_frame_errors}")

# Default protocol delays (seconds) — decoded from ISM Thread.Sleep calls.
ERASE_WAIT_S = 5.0          # after 0x90 accept (DSP mass-erase)
FIRST_FRAME_WAIT_S = 5.0    # extra pause after first 0x91 (erase completion)
FINALIZE_WAIT_S = 3.0       # after "Firmware loaded correctly"
NACK_WAIT_S = 0.6           # status 1 backoff
ERR2_WAIT_S = 0.4           # status 2 backoff
NOREPLY_WAIT_S = 1.0        # timeout backoff
DEFAULT_QUERY_TIMEOUT_S = 4.0

def _resp_status(resp: Optional[bytes]):
    """Return (node, func, status) or None if the reply is missing/short."""
    if resp is None or len(resp) < 3:
        return None
    return resp[0], resp[1], resp[2]

def flash_node(frames: List[bytes], transport: Transport, *, node: int,
                legacy: bool = False, num_intentos: int = 4,
                sleep: Callable[[float], None] = time.sleep,
                on_progress: Optional[Callable[[str, int], None]] = None,
                erase_wait_s: float = ERASE_WAIT_S,
                first_frame_wait_s: float = FIRST_FRAME_WAIT_S,
                finalize_wait_s: float = FINALIZE_WAIT_S,
                nack_wait_s: float = NACK_WAIT_S,
                err2_wait_s: float = ERR2_WAIT_S,
                noreply_wait_s: float = NOREPLY_WAIT_S,
                query_timeout_s: float = DEFAULT_QUERY_TIMEOUT_S) -> FlashResult:
    """Drive the firmware load for ONE node. Port of the DSP56F/TCP path of
    CargarYTalVezCambiaElBirtate. Raises FirmwareError / GlobalChecksumError
    on unrecoverable failure (matching ISM wording); returns FlashResult on
    success. Performs no I/O itself — `transport.query` does.
    """
    f_start = FUNC_START_LEGACY if legacy else FUNC_START_MODERN
    f_data = FUNC_DATA_LEGACY if legacy else FUNC_DATA_MODERN
    f_end = FUNC_END_LEGACY if legacy else FUNC_END_MODERN

    no_replies = chk_errors = flash_errors = rx_errors = 0

    def prog(msg: str, pct: int = 0):
        if on_progress:
            on_progress(msg, pct)

    if len(frames) < 3:
        raise FirmwareError("frame plan too short (need 0x90 + data + 0x92)")
    total = len(frames)

    # ── 1) START (0x90) ───────────────────────────────────────────────────
    accepted = False
    for attempt in range(num_intentos):
        prog("Starting load. Retrying " if attempt else "Starting load", 0)
        try:
            resp = transport.query(frames[0], query_timeout_s)
        except (TransportError, OSError):
            # OSError covers TimeoutError/ConnectionError/socket.error.
            # Anything else (bug in the transport) propagates by design.
            no_replies += 1
            sleep(noreply_wait_s)
            continue
        rs = _resp_status(resp)
        if rs is None:
            no_replies += 1
            sleep(noreply_wait_s)
            continue
        rnode, rfunc, status = rs
        if rnode != (node & 0xFF):
            rx_errors += 1
            prog("Node ID mismatch!", 0)
            continue
        if rfunc != f_start:
            rx_errors += 1
            continue
        if status == 0:
            accepted = True
            break
        if status == 1 and attempt == num_intentos - 1:
            # Lead with ISM's verbatim "error code 1" wording (precise),
            # then the actionable next step (graceful).
            raise FirmwareError(
                "Firmware load start (0x90) error code 1 — the inverter DSP "
                "rejected the start frame (checksum or format). Confirm the "
                "target node/slave address and that the firmware image "
                "matches this unit, then retry.")
        if status == 2 and attempt == num_intentos - 1:
            # status==2 is the DSP's own 'busy / will not enter load' byte
            # (ISM Cargador bTramaRx[2]==2), NOT a transport/socket error.
            # The realistic field causes are a running inverter or a second
            # Modbus master on the line — surface both as the next action.
            # Multi-PC poller and per-IP/per-RS-485 reality are called out
            # explicitly because operators routinely disable only the target
            # node on a second dashboard, which does not free the bus. Lead
            # with ISM's verbatim "error code 2" wording (precise).
            raise FirmwareError(
                "Firmware load start (0x90) error code 2 — the inverter DSP "
                "will not enter firmware-load mode. The inverter itself "
                "reported this; it is NOT a network or cable error. "
                "To retry, ALL of the following must be true: "
                "(1) the inverter is STOPPED — not running, not "
                "grid-connected; "
                "(2) no other Modbus master is talking to this gateway IP — "
                "stop ISM, any SCADA/DAS, and every other dashboard or "
                "poller, INCLUDING instances running on OTHER PCs on the "
                "LAN; "
                "(3) on each of those other dashboards, disable the WHOLE "
                "inverter IP — not just one node. Every node behind this "
                "gateway shares one RS-485 bus, so polls to ANY node on "
                "the same IP keep the bus busy and the DSP will keep "
                "refusing. "
                "Note: the built-in bus lock only suppresses pollers on "
                "THIS PC; it cannot reach a dashboard on a different "
                "machine.")
    if not accepted:
        raise FirmwareError("Target did not reply to firmware update request")

    prog("Target accepted firmware update request.. ", 0)
    prog("Waiting for 5 seconds.. ", 0)
    sleep(erase_wait_s)

    # ── 2) DATA loop (0x91) ───────────────────────────────────────────────
    acked = 0
    for i in range(1, total - 1):
        frame = frames[i]
        if i == 1:
            # First data frame: the DSP may still be completing the
            # mass-erase kicked off by 0x90. ISM step 5 waits an extra
            # Thread.Sleep(5000) here — and it must be BEFORE the send so
            # the erase has margin to finish and the ACK comes back inside
            # query_timeout_s. (Sleeping AFTER the query would never help:
            # if the DSP is still erasing the query times out first, and
            # if it replied the wait is pointless.)
            prog("First frame requires longer pause to allow complete "
                 "flash erase", 0)
            sleep(first_frame_wait_s)
        done = False
        for attempt in range(num_intentos):
            prog("Sending frame", int(100 * i / total))
            try:
                resp = transport.query(frame, query_timeout_s)
            except (TransportError, OSError):
                no_replies += 1
                sleep(noreply_wait_s)
                continue
            rs = _resp_status(resp)
            if rs is None:
                no_replies += 1
                sleep(noreply_wait_s)
                continue
            rnode, rfunc, status = rs
            if rnode != (node & 0xFF) or rfunc != f_data:
                rx_errors += 1
                continue
            if status == 0:
                done = True
                acked += 1
                break
            if status == 1:
                chk_errors += 1
                prog("NACK - frame checksum error", 0)
                sleep(nack_wait_s)
                continue                       # resend SAME frame
            if status == 2:
                flash_errors += 1
                prog("DSP 'error 2' processing frame ", 0)
                sleep(err2_wait_s)
                continue
            if status == 3:
                raise FirmwareError("Unexpected 'error 3' in firmware load")
        if not done:
            r = FlashResult(False, total, acked, no_replies, chk_errors,
                            flash_errors, rx_errors, "data frame failed")
            raise FirmwareError(r.diag())

    # ── 3) END / global checksum (0x92) ───────────────────────────────────
    prog("Sending Global Checksum", 99)
    end_ok = False
    for attempt in range(num_intentos):
        try:
            resp = transport.query(frames[-1], query_timeout_s)
        except (TransportError, OSError):
            no_replies += 1
            sleep(noreply_wait_s)
            continue
        rs = _resp_status(resp)
        if rs is None:
            no_replies += 1
            sleep(noreply_wait_s)
            continue
        rnode, rfunc, status = rs
        if rnode != (node & 0xFF) or rfunc != f_end:
            rx_errors += 1
            continue
        if status == 0:
            end_ok = True
            break
        if status == 1:
            chk_errors += 1
            sleep(nack_wait_s)
            continue
        if status == 2:
            flash_errors += 1
            sleep(err2_wait_s)
            continue
        if status == 3:
            raise GlobalChecksumError("Global checksum error")
    if not end_ok:
        raise GlobalChecksumError(
            "Target did not reply to end-of-firmware request")

    prog("Firmware loaded correctly .... ", 100)
    sleep(finalize_wait_s)
    return FlashResult(True, total, acked, no_replies, chk_errors,
                       flash_errors, rx_errors, "Firmware loaded correctly")

class MockDSP:
    """In-process emulator of the INGECON DSP bootloader for dry-runs.

    Faithfully models the receive side: validates the trailing XOR on each
    0x91, writes words into its own flash banks (independent threshold bank
    selector — NOT a call into avanza_flash, so a shared bug can't hide),
    verifies the global checksum on 0x92. Optional fault injection exercises
    the NACK / err2 / timeout / fatal retry paths.

    After a dry-run, `received_banks[0..2]` must equal the image's banks
    0..2 — proving the whole pipeline (parse → frames → state machine →
    receiver) is internally consistent end-to-end against the real file.
    Pure: no sockets, no inverter, cannot brick anything.
    """

    def __init__(self, image: FirmwareImage, node: int,
                 faults: Optional[Dict[int, str]] = None):
        self._img = image
        self._node = node & 0xFF
        self._legacy = False
        self.received_banks = build_flash_map(image.arg_dsp)
        self._ordinal = 0                       # data-frame counter
        self._faults = dict(faults or {})       # {data_ordinal: 'nack'|'err2'
                                                #  |'timeout'|'fatal'}
        self._fault_done = set()
        self.global_checksum_ok: Optional[bool] = None

    # transport.query interface used by flash_node().
    def query(self, frame: bytes, timeout_s: float) -> bytes:
        func = frame[1]
        node = frame[0]
        if func in (FUNC_START_MODERN, FUNC_START_LEGACY):
            self._legacy = (func == FUNC_START_LEGACY)
            self._ordinal = 0
            return bytes([node, func, 0])
        if func in (FUNC_DATA_MODERN, FUNC_DATA_LEGACY):
            # The DSP only advances its write pointer on an ACCEPTED frame.
            # A NACK / err2 / timeout (host resends the SAME frame) must NOT
            # consume an ordinal — model the prospective ordinal and commit
            # only on success, so resends land at the correct address.
            nxt = self._ordinal + 1
            inj = self._faults.get(nxt)
            if inj and nxt not in self._fault_done:
                self._fault_done.add(nxt)
                if inj == "timeout":
                    raise TimeoutError("MockDSP injected timeout")
                if inj == "nack":
                    return bytes([node, func, 1])
                if inj == "err2":
                    return bytes([node, func, 2])
                if inj == "fatal":
                    return bytes([node, func, 3])
            # Frame-integrity: a real DSP NACKs a truncated frame rather
            # than mis-parsing it. Require header(6) + 2*byte_count body +
            # memtype(1) + xor(1). Defends the receiver against a corrupt
            # / malformed frame instead of raising IndexError.
            if len(frame) >= 6:
                declared = ((frame[4] << 8) | frame[5])
                if len(frame) < 6 + 2 * declared + 2:
                    return bytes([node, func, 1])  # short frame → NACK
            else:
                return bytes([node, func, 1])
            # Verify the trailing XOR%256 exactly as the real DSP would.
            if frame[-1] != xor_checksum(list(frame[:-1])):
                return bytes([node, func, 1])    # checksum NACK, no advance
            self._ordinal = nxt                  # commit: frame accepted
            self._receive_data(frame)
            return bytes([node, func, 0])
        if func in (FUNC_END_MODERN, FUNC_END_LEGACY):
            gck = calculo_checksum_global(self.received_banks,
                                          self._img.flag_flash_externa)
            sent = (frame[2] << 8) | frame[3]
            self.global_checksum_ok = (gck == sent)
            return bytes([node, func, 0 if self.global_checksum_ok else 3])
        if func == FUNC_SPEED:
            return bytes([node, func, 1])        # decline higher bitrate
        return bytes([node, func, 3])

    def _receive_data(self, frame: bytes) -> None:
        img = self._img
        c = img.counts
        n_p, n_p2, n_x = (c.num_tramas_pflash, c.num_tramas_pflash2,
                          c.num_tramas_xflash)
        xbase = _xflash_base(img.arg_dsp)
        dir_flash = (frame[2] << 8) | frame[3]
        byte_count = (frame[4] << 8) | frame[5]
        o = self._ordinal
        if img.flag_flash_externa:
            if o <= n_p:
                bi, base = 1, _PFLASH_BASE
            elif o <= n_p + n_p2:
                bi, base = 2, _PFLASH2_BASE
            else:
                bi, base = 0, xbase
        else:
            if o <= n_p:
                bi, base = 1, _PFLASH_BASE
            else:
                bi, base = 0, xbase
        idx = dir_flash - base
        body = frame[6:6 + 2 * byte_count]
        bank = self.received_banks[bi].data
        # Defensive: never read past the actual payload even if byte_count
        # over-declares (query() already NACKs short frames; this is a
        # second guard so a logic regression can't IndexError-crash).
        usable = min(byte_count, len(body) // 2)
        for k in range(usable):
            w = (body[2 * k] << 8) | body[2 * k + 1]
            if 0 <= idx < len(bank):
                bank[idx] = w
            idx += 1

def dry_run(image: FirmwareImage, node: int, *, legacy50: bool = False,
            faults: Optional[Dict[int, str]] = None,
            on_progress: Optional[Callable[[str, int], None]] = None
            ) -> tuple:
    """Full hardware-free flash against a MockDSP. Returns (result, dsp).
    Zero real delays. This is what the UI runs in its default Dry-Run mode.
    """
    frames = build_all_frames(image, node, legacy50)
    dsp = MockDSP(image, node, faults=faults)
    res = flash_node(frames, dsp, node=node, legacy=legacy50,
                     sleep=lambda _s: None, on_progress=on_progress,
                     erase_wait_s=0, first_frame_wait_s=0, finalize_wait_s=0,
                     nack_wait_s=0, err2_wait_s=0, noreply_wait_s=0)
    return res, dsp
