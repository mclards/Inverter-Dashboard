# -*- mode: python ; coding: utf-8 -*-
import os
from PyInstaller.utils.hooks import collect_all

SPEC_PATH = os.path.abspath(
    globals().get("__file__", os.path.join(os.getcwd(), "services", "CalibratorService.spec"))
)
BASE_DIR = os.path.abspath(os.path.dirname(SPEC_PATH))
ROOT_DIR = os.path.abspath(os.path.join(BASE_DIR, ".."))

datas = [
    (os.path.join(BASE_DIR, 'calibration_core.py'), 'services'),
    (os.path.join(BASE_DIR, 'calibration_io.py'), 'services'),
    (os.path.join(BASE_DIR, 'calibration_decoder.py'), 'services'),
    # Utility Tool L2 config tabs (B/C/D/I) — read values + write encoder.
    # Without these the packaged build silently loses the decoded values
    # (decode_full_settings -> available:false) and every config-write 500s
    # ("cfg_trif_map unavailable" / cfg_block_write ImportError).
    (os.path.join(BASE_DIR, 'cfg_trif_map.py'), 'services'),
    (os.path.join(BASE_DIR, 'cfg_block_write.py'), 'services'),
    (os.path.join(ROOT_DIR, 'drivers'), 'drivers'),
]
binaries = []
hiddenimports = ['services.calibrator_app', 'services.calibration_core', 'services.calibration_io', 'services.calibration_decoder', 'services.cfg_trif_map', 'services.cfg_block_write', 'drivers.modbus_tcp', 'drivers.modbus_rtu', 'uvicorn.loops.asyncio', 'uvicorn.lifespan.off', 'uvicorn.protocols.http.h11_impl', 'anyio._backends._asyncio', 'pydantic.v1.datetime_parse',
                 'serial', 'serial.tools', 'serial.tools.list_ports', 'serial.tools.list_ports_windows', 'serial.serialwin32', 'serial.serialutil']
tmp_ret = collect_all('pymodbus')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect_all('serial')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]


a = Analysis(
    [os.path.join(BASE_DIR, 'calibrator_app.py')],
    pathex=[ROOT_DIR],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='CalibratorService',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
