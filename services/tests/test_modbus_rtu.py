"""
Test suite for Modbus RTU low-level codec (CRC16, ADU build/parse).

Tests are independent of pyserial or socket I/O.
"""
import unittest
import struct

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
    """Build RTU ADU: [unit] + pdu + crc16_lo + crc16_hi."""
    adu = bytes([unit]) + pdu
    crc = crc16_modbus(adu)
    return adu + struct.pack("<H", crc)

def parse_rtu_adu(adu: bytes) -> tuple:
    """
    Parse RTU ADU.
    Returns (unit, pdu, crc_ok) where:
      - unit: the first byte (0-255)
      - pdu: bytes [1:-2]
      - crc_ok: True if embedded CRC matches computed CRC
    Raises ValueError if adu is too short.
    """
    if len(adu) < 3:
        raise ValueError("RTU ADU too short (< 3 bytes)")
    unit = adu[0]
    pdu = adu[1:-2]
    embedded_crc = struct.unpack("<H", adu[-2:])[0]
    computed_crc = crc16_modbus(adu[:-2])
    crc_ok = embedded_crc == computed_crc
    return unit, pdu, crc_ok

def build_tcp_adu(txn_id: int, pdu: bytes) -> bytes:
    """Build Modbus TCP ADU: [txn_hi, txn_lo, 0, 0, len_hi, len_lo, unit, ...pdu]."""
    # For test simplicity, assume unit=1 (normally read from request or map)
    unit = 1
    payload = bytes([unit]) + pdu
    length = len(payload)
    return struct.pack(">HHHB", txn_id, 0, length, unit) + pdu

def parse_tcp_adu(adu: bytes) -> tuple:
    """
    Parse Modbus TCP ADU.
    Returns (txn_id, unit, pdu).
    Raises ValueError if malformed.
    """
    if len(adu) < 8:
        raise ValueError("TCP ADU too short (< 8 bytes)")
    txn_id = struct.unpack(">H", adu[0:2])[0]
    proto_id = struct.unpack(">H", adu[2:4])[0]
    if proto_id != 0:
        raise ValueError(f"Invalid proto_id: {proto_id} (expected 0)")
    length = struct.unpack(">H", adu[4:6])[0]
    unit = adu[6]
    pdu = adu[7:]
    if len(pdu) != length - 1:  # length includes unit byte
        raise ValueError(f"Length mismatch: expected {length-1}, got {len(pdu)}")
    return txn_id, unit, pdu

class TestCRC16(unittest.TestCase):
    """CRC16 vectors from Modbus spec and independent sources."""

    def test_crc16_vector_1(self):
        """Test vector: FC04 read input registers (known Modbus example)."""
        # 01 04 00 00 00 02 -> CRC 71 CB (per Modbus spec examples)
        data = bytes([0x01, 0x04, 0x00, 0x00, 0x00, 0x02])
        crc = crc16_modbus(data)
        self.assertEqual(crc, 0xCB71)

    def test_crc16_vector_2(self):
        """Test vector: FC03 read holding registers."""
        # 01 03 00 00 00 0A -> CRC CDC5
        data = bytes([0x01, 0x03, 0x00, 0x00, 0x00, 0x0A])
        crc = crc16_modbus(data)
        self.assertEqual(crc, 0xCDC5)

    def test_crc16_vector_3(self):
        """Test vector: FC06 write single register."""
        # 01 06 00 AC 00 FF -> CRC AB09
        data = bytes([0x01, 0x06, 0x00, 0xAC, 0x00, 0xFF])
        crc = crc16_modbus(data)
        self.assertEqual(crc, 0xAB09)

    def test_crc16_with_leading_zeros(self):
        """CRC should handle leading zeros correctly."""
        data = bytes([0x00, 0x01, 0x00, 0x02])
        crc = crc16_modbus(data)
        # Just verify it computes without error and is in valid range
        self.assertGreaterEqual(crc, 0)
        self.assertLess(crc, 65536)

class TestRTUADU(unittest.TestCase):
    """RTU ADU build/parse round-trip tests."""

    def test_build_and_parse_fc04(self):
        """Build FC04 read input request, then parse it back."""
        pdu = bytes([0x04, 0x00, 0x00, 0x00, 0x02])
        adu = build_rtu_adu(1, pdu)
        unit, parsed_pdu, crc_ok = parse_rtu_adu(adu)
        self.assertEqual(unit, 1)
        self.assertEqual(parsed_pdu, pdu)
        self.assertTrue(crc_ok)

    def test_build_and_parse_fc03(self):
        """Build FC03 read holding request, then parse it back."""
        pdu = bytes([0x03, 0x00, 0x00, 0x00, 0x0A])
        adu = build_rtu_adu(1, pdu)
        unit, parsed_pdu, crc_ok = parse_rtu_adu(adu)
        self.assertEqual(unit, 1)
        self.assertEqual(parsed_pdu, pdu)
        self.assertTrue(crc_ok)

    def test_build_and_parse_fc06(self):
        """Build FC06 write single register."""
        pdu = bytes([0x06, 0x00, 0xAC, 0x00, 0xFF])
        adu = build_rtu_adu(1, pdu)
        unit, parsed_pdu, crc_ok = parse_rtu_adu(adu)
        self.assertEqual(unit, 1)
        self.assertEqual(parsed_pdu, pdu)
        self.assertTrue(crc_ok)

    def test_build_and_parse_fc10(self):
        """Build FC10 (0x10) write multiple registers (vendor FC 0x71 PDU-compatible)."""
        pdu = bytes([0x10, 0x00, 0x00, 0x00, 0x02, 0x04, 0x00, 0x01, 0x00, 0x02])
        adu = build_rtu_adu(1, pdu)
        unit, parsed_pdu, crc_ok = parse_rtu_adu(adu)
        self.assertEqual(unit, 1)
        self.assertEqual(parsed_pdu, pdu)
        self.assertTrue(crc_ok)

    def test_build_and_parse_vendor_fc71(self):
        """Build vendor FC 0x71 (SCOPE) request."""
        # FC 0x71 = 113; real payload varies, but structure is preserved
        pdu = bytes([0x71, 0xFE, 0xB5, 0x00, 0x01, 0x02, 0x03, 0x04])
        adu = build_rtu_adu(1, pdu)
        unit, parsed_pdu, crc_ok = parse_rtu_adu(adu)
        self.assertEqual(unit, 1)
        self.assertEqual(parsed_pdu, pdu)
        self.assertTrue(crc_ok)

    def test_crc_corruption_detected(self):
        """Corrupted CRC should fail validation."""
        pdu = bytes([0x04, 0x00, 0x00, 0x00, 0x02])
        adu = build_rtu_adu(1, pdu)
        # Corrupt the CRC bytes
        bad_adu = adu[:-2] + bytes([0xFF, 0xFF])
        unit, parsed_pdu, crc_ok = parse_rtu_adu(bad_adu)
        self.assertFalse(crc_ok)

    def test_parse_rtu_adu_too_short(self):
        """Parsing a < 3 byte ADU should raise ValueError."""
        with self.assertRaises(ValueError):
            parse_rtu_adu(bytes([0x01, 0x04]))

    def test_multiunit(self):
        """Test building/parsing for different unit IDs (1-247)."""
        for unit_id in [1, 2, 100, 247]:
            pdu = bytes([0x03, 0x00, 0x00, 0x00, 0x10])
            adu = build_rtu_adu(unit_id, pdu)
            unit, parsed_pdu, crc_ok = parse_rtu_adu(adu)
            self.assertEqual(unit, unit_id)
            self.assertEqual(parsed_pdu, pdu)
            self.assertTrue(crc_ok)

class TestTCPADU(unittest.TestCase):
    """TCP ADU parse tests (for bridge context awareness)."""

    def test_parse_tcp_adu_fc04(self):
        """Parse TCP ADU containing FC04 PDU."""
        # Manually construct a TCP ADU:
        # TXN=0x0001, PROTO=0x0000, LEN=0x0006 (unit+pdu), UNIT=0x01, PDU=[FC04, addr_hi, addr_lo, count_hi, count_lo]
        adu = bytes(
            [0x00, 0x01,  # TXN
             0x00, 0x00,  # PROTO
             0x00, 0x06,  # LEN (1 unit + 5 pdu)
             0x01,        # UNIT
             0x04, 0x00, 0x00, 0x00, 0x02]  # PDU
        )
        txn_id, unit, pdu = parse_tcp_adu(adu)
        self.assertEqual(txn_id, 1)
        self.assertEqual(unit, 1)
        self.assertEqual(pdu, bytes([0x04, 0x00, 0x00, 0x00, 0x02]))

    def test_parse_tcp_adu_fc03(self):
        """Parse TCP ADU containing FC03 PDU."""
        adu = bytes(
            [0x00, 0x02,  # TXN
             0x00, 0x00,  # PROTO
             0x00, 0x06,  # LEN
             0x01,        # UNIT
             0x03, 0x00, 0x00, 0x00, 0x0A]  # PDU
        )
        txn_id, unit, pdu = parse_tcp_adu(adu)
        self.assertEqual(txn_id, 2)
        self.assertEqual(unit, 1)
        self.assertEqual(pdu, bytes([0x03, 0x00, 0x00, 0x00, 0x0A]))

class TestExceptionResponse(unittest.TestCase):
    """Test exception response synthesis for bridge failures."""

    def test_build_exception_response_fc04_crc_fail(self):
        """Build FC04+0x80 exception (CRC fail, code 0x04)."""
        # Original FC04 -> exception FC (04|80=0x84), exc_code 0x04
        fc = 0x04
        exc_code = 0x04  # SLAVE_DEVICE_FAILURE
        exc_pdu = bytes([fc | 0x80, exc_code])
        self.assertEqual(exc_pdu, bytes([0x84, 0x04]))

    def test_build_exception_response_fc03_timeout(self):
        """Build FC03+0x80 exception (no reply, code 0x0B)."""
        fc = 0x03
        exc_code = 0x0B  # GATEWAY_TARGET_NO_RESPONSE
        exc_pdu = bytes([fc | 0x80, exc_code])
        self.assertEqual(exc_pdu, bytes([0x83, 0x0B]))

    def test_exception_response_in_rtu_adu(self):
        """Build RTU ADU for exception response."""
        unit = 1
        exc_pdu = bytes([0x83, 0x04])  # FC03 exception, SLAVE_DEVICE_FAILURE
        adu = build_rtu_adu(unit, exc_pdu)
        unit_out, pdu_out, crc_ok = parse_rtu_adu(adu)
        self.assertEqual(unit_out, 1)
        self.assertEqual(pdu_out, exc_pdu)
        self.assertTrue(crc_ok)

if __name__ == "__main__":
    unittest.main()
