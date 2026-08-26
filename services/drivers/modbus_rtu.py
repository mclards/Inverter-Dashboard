"""
Modbus RTU transport layer for RS485-USB bridge.

Provides low-level RTU codec functions:
  - CRC16-Modbus (poly 0xA001, init 0xFFFF)
  - ADU build/parse helpers
  - SerialClient factory (thin wrapper around pymodbus 2.5.3 sync API)

No socket I/O — only frame formatting. Designed for use in rs485_bridge.py.
"""

import struct
import time
try:
    from pymodbus.client import ModbusSerialClient
except ImportError:
    from pymodbus.client.sync import ModbusSerialClient

def crc16_modbus(data: bytes) -> int:
    """
    Calculate Modbus CRC16 (polynomial 0xA001, init 0xFFFF).
    Returns the 16-bit CRC as an integer (0-65535).
    """
    crc = 0xFFFF
    for byte in data:
        crc ^= byte
        for _ in range(8):
            if crc & 1:
                crc = (crc >> 1) ^ 0xA001
            else:
                crc >>= 1
    return crc

def build_rtu_adu(unit: int, pdu: bytes) -> bytes:
    """
    Build Modbus RTU ADU: [unit] + pdu + crc16_lo + crc16_hi.

    Args:
        unit: Modbus slave unit ID (0-247)
        pdu: Protocol Data Unit (function code + payload)

    Returns:
        Complete RTU ADU (including CRC).
    """
    adu = bytes([unit]) + pdu
    crc = crc16_modbus(adu)
    return adu + struct.pack("<H", crc)

def parse_rtu_adu(adu: bytes) -> tuple:
    """
    Parse Modbus RTU ADU.

    Args:
        adu: RTU ADU bytes [unit, ...pdu..., crc_lo, crc_hi]

    Returns:
        Tuple of (unit, pdu, crc_ok) where:
          - unit: slave unit ID (0-247)
          - pdu: Protocol Data Unit (bytes)
          - crc_ok: True if embedded CRC matches computed CRC

    Raises:
        ValueError: if adu is too short (< 3 bytes)
    """
    if len(adu) < 3:
        raise ValueError("RTU ADU too short (< 3 bytes)")
    unit = adu[0]
    pdu = adu[1:-2]
    embedded_crc = struct.unpack("<H", adu[-2:])[0]
    computed_crc = crc16_modbus(adu[:-2])
    crc_ok = embedded_crc == computed_crc
    return unit, pdu, crc_ok

def create_serial_client(port: str, baudrate: int = 9600, parity: str = "N",
                         stopbits: int = 1, bytesize: int = 8,
                         timeout: float = 1.0) -> ModbusSerialClient:
    """
    Create a persistent Modbus RTU serial client (pymodbus 2.5.3 sync API).

    Args:
        port: Serial port name (e.g., "COM3", "/dev/ttyUSB0")
        baudrate: Baud rate (1200-115200)
        parity: "N" (none), "E" (even), "O" (odd)
        stopbits: 1 or 2
        bytesize: 7 or 8
        timeout: Read timeout in seconds

    Returns:
        ModbusSerialClient instance (connection is lazy).
    """
    client = ModbusSerialClient(
        method="rtu",
        port=port,
        baudrate=baudrate,
        parity=parity,
        stopbits=stopbits,
        bytesize=bytesize,
        timeout=timeout,
        retry_on_empty=False,
    )
    return client

def close_quietly(client):
    """Close a serial client without raising exceptions."""
    try:
        client.close()
    except Exception:
        pass
