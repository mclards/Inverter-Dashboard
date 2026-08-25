"""Slice ζ grid-control bench validator.

Resolves the address-space conflict between:
  • PDF spec (docs/IngeconSunPMax-Modbus-pg15.txt + pg16.txt) — claims
    41001 = Command Code (RW), 41006-41010 = Power-reduction Q15,
    Phi-tangent target, Reactive target, (reserved), Restrictive Freq Limits.
  • Operator's parameter map (docs/INGECON_Parameter_Map.docx) — claims
    41001-41006 = RTC (Year/Month/Day/Hour/Minute/Second),
    41007 = Starting Vin V (586),
    41008 = Starting Vin time (60 s),
    41009 = Stopping Vin V (528),
    41010 = (reserved 0).

Both interpretations cannot apply to the same FC + address pair. This
script tests which one is correct on the live inverter.

Phase 1 — READ-ONLY (always safe):
  Reads holding registers 41001-41020 via FC 0x03 and prints the bytes
  decoded under BOTH interpretations side by side. The operator can read
  the verdict directly: if reg 41001 == 2026 (year) and 41007 == 586
  (Starting Vin V), the docx is right. If 41001 ∈ [0, 12] and 41007 is
  any signed Int16 within ±15870, the PDF is right.

Phase 2 — WRITE+RESTORE (operator-approved only):
  Issues cmd 1 (set phi-tangent target) with a small distinctive raw
  value (default ±100 → ≈ ±0.003 tan(φ) → PF ≈ 1.000), waits 2 s, reads
  41006-41010 again, then issues cmd 11 (disable_reactive) to restore
  the inverter's default. Confirms whether the PDF command interface
  takes effect at this address.

Usage:
  # Read-only — always safe to run
  python services/_spike/grid_control_validate.py --ip 192.168.1.101 --slave 1

  # With write-test phase (asks for explicit y/N confirmation):
  python services/_spike/grid_control_validate.py --ip 192.168.1.101 --slave 1 --phase 2

The script does NOT touch the dashboard's poller, the SQLite DB, or any
audit_log row. It opens a fresh pymodbus client just for this test, runs,
and exits. Output is plain stdout for operator inspection.
"""

import argparse
import sys
import time

try:
    from pymodbus.client.sync import ModbusTcpClient
except ImportError:
    from pymodbus.client import ModbusTcpClient  # pymodbus 3.x

# Address constants per PDF §3 (page 15-16).
ADDR_CMD_CODE   = 1000   # = reg 41001 (PDF: Command Code RW)
ADDR_CMD_DATA   = 1001   # = reg 41002 (PDF: Command Data RW)
ADDR_GC_BASE    = 1005   # = reg 41006 (PDF: Power Reduction Target R)
ADDR_GC_COUNT   = 5       # 41006-41010
CMD_PHI_TANGENT     = 0x0001
CMD_DISABLE_REACTIVE = 0x000B

# Docx Section 2 + 3 + 4 expected values for a healthy operator inverter
# (Country Code 42 / Philippines profile, exported 2026-05-10).
DOCX_EXPECTED = {
    1000: ("Year (RTC)",                 lambda v: 2020 <= v <= 2099),
    1001: ("Month (RTC)",                lambda v: 1 <= v <= 12),
    1002: ("Day (RTC)",                  lambda v: 1 <= v <= 31),
    1003: ("Hour (RTC)",                 lambda v: 0 <= v <= 23),
    1004: ("Minute (RTC)",               lambda v: 0 <= v <= 59),
    1005: ("Second (RTC)",               lambda v: 0 <= v <= 59),
    1006: ("Starting input voltage V",   lambda v: 400 <= v <= 800),    # docx: 586
    1007: ("Starting Vin time s",        lambda v: 1 <= v <= 600),       # docx: 60
    1008: ("Stopping input voltage V",   lambda v: 300 <= v <= 700),     # docx: 528
    1009: ("(reserved)",                 lambda v: v == 0),
    1010: ("Minimum phase voltage V",    lambda v: 30 <= v <= 200),      # docx: 63
    1011: ("Maximum phase voltage V",    lambda v: 200 <= v <= 300),     # docx: 230
    1012: ("Min output freq cHz",        lambda v: 5000 <= v <= 6000),   # docx: 5759
    1013: ("Max output freq cHz",        lambda v: 6000 <= v <= 7000),   # docx: 6240
    1014: ("Phi tangent (config) thou.", lambda v: -15870 <= _s16(v) <= 15870),
    1015: ("Phi tangent sign (config)",  lambda v: v in (0, 1)),
    1016: ("Night power supply",         lambda v: v in (0, 1)),
    1017: ("Nominal Power kW×100",       lambda v: 10000 <= v <= 30000), # docx: 22673
    1018: ("Maximum Power kW×100",       lambda v: 10000 <= v <= 30000), # docx: 24941
}

# PDF §3 Section 3 expected ranges/types.
PDF_EXPECTED = {
    1000: ("Command Code",                lambda v: 0 <= v <= 12),
    1001: ("Command Data",                lambda v: True),  # any value
    1002: ("(reserved)",                  lambda v: True),
    1003: ("(reserved)",                  lambda v: True),
    1004: ("(reserved)",                  lambda v: True),
    1005: ("Power Reduction Target Q15",  lambda v: 0 <= v <= 32767),
    1006: ("Phi Tangent Target Int16",    lambda v: -15870 <= _s16(v) <= 15870),
    1007: ("Reactive Target Int16",       lambda v: -32767 <= _s16(v) <= 32767),
    1008: ("(reserved)",                  lambda v: True),
    1009: ("Restrictive Freq Limits",     lambda v: v in (0, 1)),
}

def _s16(u16):
    u = int(u16) & 0xFFFF
    return u - 0x10000 if u & 0x8000 else u

def _read(client, addr, count, slave):
    try:
        # pymodbus 2.x: unit=, pymodbus 3.x: slave=
        try:
            r = client.read_holding_registers(address=addr, count=count, unit=slave)
        except TypeError:
            r = client.read_holding_registers(address=addr, count=count, slave=slave)
    except Exception as e:
        return None, f"transport error: {e}"
    if r is None:
        return None, "null response"
    if hasattr(r, "isError") and r.isError():
        return None, f"modbus error: {r}"
    regs = list(r.registers) if hasattr(r, "registers") else []
    if len(regs) < count:
        return None, f"short frame: got {len(regs)}/{count}"
    return regs, None

def _write(client, addr, values, slave):
    try:
        try:
            r = client.write_registers(address=addr, values=values, unit=slave)
        except TypeError:
            r = client.write_registers(address=addr, values=values, slave=slave)
    except Exception as e:
        return False, f"transport error: {e}"
    if r is None or (hasattr(r, "isError") and r.isError()):
        return False, f"modbus error: {r}"
    return True, None

def _classify(regs, expected_map, base_addr):
    """Score how well a given expected_map matches the observed registers.
    Returns (score, hits_total, per_addr_lines)."""
    hits = 0
    total = 0
    lines = []
    for offset, val in enumerate(regs):
        addr = base_addr + offset
        if addr not in expected_map:
            continue
        name, predicate = expected_map[addr]
        total += 1
        ok = False
        try:
            ok = bool(predicate(val))
        except Exception:
            ok = False
        if ok:
            hits += 1
        marker = "✓" if ok else "✗"
        lines.append(f"    {marker} reg {addr+40001} (idx {addr-1000:3d}) = {val:6d} (0x{val:04X})  {name}")
    score = hits / total if total else 0.0
    return score, hits, total, lines

def phase1_readonly(client, slave):
    print("\n" + "=" * 72)
    print(f"  PHASE 1 — READ-ONLY validation against slave {slave}")
    print("=" * 72)

    # Read 41001-41020 (covers both PDF cmd window and docx config window 0..19).
    regs, err = _read(client, 1000, 20, slave)
    if err:
        print(f"  FAIL: {err}")
        return None
    print(f"\n  Raw 41001..41020:")
    for i, v in enumerate(regs):
        print(f"    reg {1001+i:5d} (idx {i:3d}) = {v:6d} (0x{v:04X})")

    print(f"\n  Scoring against PDF §3 spec (Command Code at 41001):")
    pdf_score, pdf_hits, pdf_total, pdf_lines = _classify(regs, PDF_EXPECTED, 1000)
    for line in pdf_lines:
        print(line)
    print(f"    → {pdf_hits}/{pdf_total} predicates pass ({pdf_score*100:.0f}%)")

    print(f"\n  Scoring against docx parameter map (RTC + DC startup at 41001):")
    docx_score, docx_hits, docx_total, docx_lines = _classify(regs, DOCX_EXPECTED, 1000)
    for line in docx_lines:
        print(line)
    print(f"    → {docx_hits}/{docx_total} predicates pass ({docx_score*100:.0f}%)")

    print()
    print("  VERDICT")
    if docx_score >= 0.7 and docx_score > pdf_score:
        print("    DOCX semantics apply to FC 0x03 reads at this address range.")
        print("    → Slice ζ READ-back is reading the wrong registers.")
        print("    → server/index.js _hwBaselineUsePacFallback unaffected; only")
        print("      Slice ζ /api/grid-control/state response is bogus.")
        print("    Recommended: defer Slice ζ until the correct read addresses are")
        print("    found (likely a different bank — try address=1500 / 2000 etc).")
        return "docx"
    if pdf_score >= 0.7 and pdf_score > docx_score:
        print("    PDF semantics apply to FC 0x03 reads at this address range.")
        print("    → Slice ζ READ-back is correct as currently coded.")
        print("    → Cleared to proceed with bench-test of Phase 2 if desired.")
        return "pdf"
    print("    INCONCLUSIVE — neither map fits cleanly. Inspect raw values above.")
    return "inconclusive"

def phase2_write_restore(client, slave, signature_raw=100):
    print("\n" + "=" * 72)
    print(f"  PHASE 2 — WRITE + RESTORE signature test (slave {slave})")
    print("=" * 72)
    print(f"  Will issue cmd 1 with phi-tangent raw = {signature_raw}")
    print(f"  (≈ tan(φ) {signature_raw/32767:.5f}, PF ≈ {1/((1+(signature_raw/32767)**2)**0.5):.5f})")
    print(f"  Then read 41006-41010 to see if 41006 (PDF Phi Tangent Target) reflects it.")
    print(f"  Then cmd 11 (disable_reactive) to restore default.")
    confirm = input("\n  Type 'GO' to proceed (anything else aborts): ").strip()
    if confirm != "GO":
        print("  ABORTED by operator.")
        return False

    # Snapshot before
    before, err = _read(client, 1005, 5, slave)
    if err:
        print(f"  FAIL pre-read: {err}")
        return False
    print(f"\n  41006-41010 BEFORE write:")
    for i, v in enumerate(before):
        print(f"    reg {1006+i:5d} = {v:6d} (signed {_s16(v):6d})")

    # Write cmd
    raw_word = signature_raw & 0xFFFF
    print(f"\n  Writing FC 0x10 to addr 1000 = [cmd={CMD_PHI_TANGENT}, data={raw_word}]")
    ok, err = _write(client, 1000, [CMD_PHI_TANGENT, raw_word], slave)
    if not ok:
        print(f"  FAIL write: {err}")
        return False
    print("  Write accepted by inverter.")

    time.sleep(2.0)

    after, err = _read(client, 1005, 5, slave)
    if err:
        print(f"  FAIL post-read: {err}")
    else:
        print(f"\n  41006-41010 AFTER write:")
        for i, v in enumerate(after):
            arrow = " <-- CHANGED" if v != before[i] else ""
            print(f"    reg {1006+i:5d} = {v:6d} (signed {_s16(v):6d}){arrow}")

    # Restore
    print(f"\n  Restoring via cmd 11 (disable_reactive):")
    ok, err = _write(client, 1000, [CMD_DISABLE_REACTIVE, 0], slave)
    if not ok:
        print(f"  FAIL restore: {err}  ⚠️  MANUAL OPERATOR INTERVENTION MAY BE NEEDED.")
        return False
    print("  Restore accepted.")

    time.sleep(1.0)
    final, err = _read(client, 1005, 5, slave)
    if not err:
        print(f"\n  41006-41010 AFTER restore:")
        for i, v in enumerate(final):
            print(f"    reg {1006+i:5d} = {v:6d} (signed {_s16(v):6d})")

    # Verdict
    if not err:
        idx_phi_pdf = 1   # 41007 in 41006-base = offset 1 (PDF Phi Tangent Target)
        if abs(_s16(after[idx_phi_pdf]) - signature_raw) <= 5:
            print("\n  VERDICT: 41007 reflects the written value — PDF semantics CONFIRMED.")
            print("  Slice ζ command + readback are wired correctly.")
            return True
        if any(v != b for v, b in zip(after, before)):
            print("\n  VERDICT: SOMETHING changed but not 41007. Inspect output above.")
            return False
        print("\n  VERDICT: Nothing in 41006-41010 changed after write. PDF interpretation")
        print("  for read-back may be wrong, OR the inverter rejected cmd 1 silently.")
    return False

def main(argv):
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--ip", required=True, help="Inverter IP address")
    p.add_argument("--slave", type=int, default=1, help="Modbus slave id (1..4)")
    p.add_argument("--phase", type=int, default=1, choices=[1, 2],
                   help="1 = read-only (default, safe); 2 = read + write-restore")
    p.add_argument("--signature", type=int, default=100,
                   help="Phase 2 only: phi-tangent raw value to write (default 100 ≈ PF 0.99995)")
    p.add_argument("--port", type=int, default=502, help="Modbus TCP port (default 502)")
    args = p.parse_args(argv)

    print(f"Connecting to {args.ip}:{args.port} slave {args.slave}...")
    client = ModbusTcpClient(args.ip, port=args.port, timeout=3)
    if not client.connect():
        print("FAIL: cannot connect")
        return 2

    try:
        verdict = phase1_readonly(client, args.slave)
        if args.phase >= 2:
            phase2_write_restore(client, args.slave, signature_raw=args.signature)
        return 0 if verdict in ("pdf", "docx") else 1
    finally:
        try: client.close()
        except Exception: pass

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
