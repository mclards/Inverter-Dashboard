#!/usr/bin/env python3
"""
convert_afd_to_s.py — Ingeteam Advanced Firmware Data (.afd) to Motorola S-Record (.S) Converter

Converts Ingeteam .afd binary firmware containers (extracted from .ipk packages) into
standard Motorola S-record (.S) files fully compatible with Ingecon Sun Manager (ISM)
for per-node DSP firmware upgrades over RS-485 / Modbus.

Supported Architectures:
  - Freescale DSP56807 / DSP56800E (INGECON SUN Power Max X, 100kW - 1MW+)
"""

import os
import sys
import argparse
import struct

def parse_afd_header(buf: bytes) -> dict:
    """Parses the Ingeteam .afd container header fields."""
    if len(buf) < 256:
        raise ValueError("File is too small to be a valid Ingeteam .afd container.")
    
    arch = buf[0:32].split(b'\x00')[0].decode('latin1', errors='ignore')
    desc = buf[36:96].split(b'\x00')[0].decode('latin1', errors='ignore')
    serial_regex = buf[100:132].split(b'\x00')[0].decode('latin1', errors='ignore')
    proto = buf[132:164].split(b'\x00')[0].decode('latin1', errors='ignore')
    dsp = buf[164:196].split(b'\x00')[0].decode('latin1', errors='ignore')
    fw_name = buf[196:228].split(b'\x00')[0].decode('latin1', errors='ignore')
    boot_req = buf[228:260].split(b'\x00')[0].decode('latin1', errors='ignore').lstrip('\x01')
    
    return {
        "arch": arch,
        "description": desc,
        "serial_regex": serial_regex,
        "protocol": proto,
        "dsp": dsp,
        "firmware_name": fw_name,
        "bootloader_req": boot_req,
    }

def make_s3(addr: int, data: bytes) -> str:
    """Formats an S3 record (32-bit address) with Motorola one's complement checksum."""
    count = 4 + len(data) + 1
    addr_bytes = addr.to_bytes(4, 'big')
    raw = bytes([count]) + addr_bytes + data
    csum = (~sum(raw)) & 0xFF
    return f"S3{count:02X}{addr_bytes.hex().upper()}{data.hex().upper()}{csum:02X}\r\n"

def convert_afd_to_s(afd_path: str, reference_s_path: str, output_s_path: str, entry_point: int = 0x0000B153) -> bool:
    """
    Converts .afd binary to .S Motorola S-records.
    reference_s_path is used to preserve the factory bootloader (0x0000F800) and RAM loader (0x00200040)
    required by Ingecon Sun Manager (ISM) validation routines.
    """
    print(f"Reading .afd container: {afd_path}")
    with open(afd_path, 'rb') as f:
        afd_buf = f.read()

    meta = parse_afd_header(afd_buf)
    print(f"  Target Architecture : {meta['arch']}")
    print(f"  Inverter Platform   : {meta['description']}")
    print(f"  DSP Microcontroller : {meta['dsp']}")
    print(f"  Firmware Revision   : {meta['firmware_name']}")
    print(f"  Serial Number Match : {meta['serial_regex']}")
    print(f"  Boot Requirement    : {meta['bootloader_req']}")

    # Parse 0x91 records from .afd
    records = []
    pos = 0
    while True:
        idx = afd_buf.find(b'\x01\x91', pos)
        if idx == -1:
            break
        addr, nwords = struct.unpack('>HH', afd_buf[idx+2:idx+6])
        datalen = nwords * 2
        raw_data = afd_buf[idx+6:idx+6+datalen]
        records.append((addr, nwords, raw_data))
        pos = idx + 6 + datalen

    if not records:
        raise ValueError("No 0x91 firmware data frames found in .afd container.")

    print(f"  Parsed {len(records)} binary frames from .afd.")

    # Partition records: PFlash (Program) vs XFlash (Data)
    # PFlash records are sequentially contiguous starting at 0x0004
    pflash_records = []
    xflash_records = []
    
    for r in records:
        addr = r[0]
        if addr >= 0x2000:
            xflash_records.append(r)
        else:
            pflash_records.append(r)

    # Convert PFlash 16-bit words (little-endian -> big-endian)
    pflash_data = bytearray()
    for r in pflash_records:
        raw = r[2]
        for i in range(0, len(raw), 2):
            pflash_data.append(raw[i+1])
            pflash_data.append(raw[i])

    # Convert XFlash 16-bit words (little-endian -> big-endian)
    xflash_data = bytearray()
    for r in xflash_records:
        raw = r[2]
        for i in range(0, len(raw), 2):
            xflash_data.append(raw[i+1])
            xflash_data.append(raw[i])

    print(f"  Program Flash (PFlash) : {len(pflash_data)//2} words ({len(pflash_data)} bytes)")
    print(f"  Data Flash (XFlash)    : {len(xflash_data)//2} words ({len(xflash_data)} bytes)")

    # Read reference bootloader / RAM table
    mid_lines = []
    if reference_s_path and os.path.isfile(reference_s_path):
        print(f"  Reading bootloader/RAM sections from: {reference_s_path}")
        with open(reference_s_path, 'r', encoding='latin1') as ref_f:
            for line in ref_f:
                line = line.strip()
                if line.startswith('S3'):
                    addr = int(line[4:12], 16)
                    # PFlash2 (0x0000F800 .. 0x0000FE00) and RAM (0x00200000 .. 0x00201FFF)
                    if (0x0000F800 <= addr <= 0x0000FE00) or (0x00200000 <= addr < 0x00202000):
                        mid_lines.append(line + '\r\n')
        print(f"  Preserved {len(mid_lines)} bootloader/RAM S-records.")
    else:
        print("  Warning: No reference .S supplied; bootloader sections omitted.")

    # Assemble complete Motorola S-record
    out_lines = ['S0110000000050524F4752414D264441544196\r\n']

    # 1. PFlash (38 words / 76 bytes per line)
    cur_addr = 0x00000004
    step = 76
    for i in range(0, len(pflash_data), step):
        chunk = pflash_data[i:i+step]
        out_lines.append(make_s3(cur_addr, bytes(chunk)))
        cur_addr += len(chunk) // 2

    # 2. Bootloader & RAM sections
    out_lines.extend(mid_lines)

    # 3. XFlash (38 words / 76 bytes per line)
    cur_addr = 0x00202000
    for i in range(0, len(xflash_data), step):
        chunk = xflash_data[i:i+step]
        out_lines.append(make_s3(cur_addr, bytes(chunk)))
        cur_addr += len(chunk) // 2

    # 4. S7 Execution Start Record
    count = 5
    addr_bytes = entry_point.to_bytes(4, 'big')
    raw = bytes([count]) + addr_bytes
    csum = (~sum(raw)) & 0xFF
    out_lines.append(f"S7{count:02X}{addr_bytes.hex().upper()}{csum:02X}\r\n")

    os.makedirs(os.path.dirname(os.path.abspath(output_s_path)), exist_ok=True)
    with open(output_s_path, 'w', newline='', encoding='ascii') as out_f:
        out_f.writelines(out_lines)

    total_bytes = sum(len(l) for l in out_lines)
    print(f"[SUCCESS] Wrote {len(out_lines)} records ({total_bytes} bytes) to {output_s_path}")
    return True

def verify_s_file(s_path: str) -> bool:
    """Validates line checksums and extracts version info from a Motorola .S file."""
    if not os.path.isfile(s_path):
        print(f"Error: File not found: {s_path}")
        return False

    with open(s_path, 'r', encoding='latin1') as f:
        lines = [l.strip() for l in f if l.strip()]

    print(f"Verifying {s_path} ({len(lines)} lines)...")
    errors = 0
    version_str = None
    for i, line in enumerate(lines):
        if not line.startswith('S'):
            errors += 1
            continue
        try:
            payload = bytes.fromhex(line[2:])
            csum = sum(payload) & 0xFF
            if csum != 0xFF:
                errors += 1
                if errors <= 5:
                    print(f"  Line {i+1}: Checksum mismatch!")
        except Exception as e:
            errors += 1
            if errors <= 5:
                print(f"  Line {i+1}: Hex parse error: {e}")

        if line.startswith('S35100202000'):
            # Data Flash banner (AAV1003 Bx)
            data_bytes = bytes.fromhex(line[12:-2])
            words = [chr(data_bytes[j+1]) + chr(data_bytes[j]) for j in range(0, min(16, len(data_bytes)), 2)]
            version_str = ''.join(words).strip('\x00')

    if errors == 0:
        print(f"  [OK] All {len(lines)} records passed Motorola S-record checksum verification.")
        if version_str:
            print(f"  [OK] Detected Internal Inverter Firmware Banner: '{version_str}'")
        return True
    else:
        print(f"  [FAIL] Found {errors} errors in {s_path}!")
        return False

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description="Convert Ingeteam .afd binary to Motorola .S S-record.")
    parser.add_argument("--afd", help="Path to input .afd file", default=r"D:\Inverter-Dashboard\firmware\AAV1003BD\AAV1003BD.DSP807.afd")
    parser.add_argument("--ref", help="Path to reference .S file for bootloader/RAM preservation", default=r"D:\Inverter-Dashboard\firmware\AAV1003BC.s")
    parser.add_argument("--out", help="Path to output .S file", default=r"D:\Inverter-Dashboard\firmware\AAV1003BD\AAV1003IJK01BD.S")
    parser.add_argument("--verify", help="Verify existing .S file", action="store_true")

    args = parser.parse_args()

    if args.verify:
        target = args.out if os.path.isfile(args.out) else args.ref
        success = verify_s_file(target)
        sys.exit(0 if success else 1)

    success = convert_afd_to_s(args.afd, args.ref, args.out)
    if success:
        verify_s_file(args.out)
