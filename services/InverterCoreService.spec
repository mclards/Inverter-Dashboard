# -*- mode: python ; coding: utf-8 -*-
import os
from PyInstaller.utils.hooks import collect_all

SPEC_PATH = os.path.abspath(
    globals().get("__file__", os.path.join(os.getcwd(), "services", "InverterCoreService.spec"))
)
BASE_DIR = os.path.abspath(os.path.dirname(SPEC_PATH))
ROOT_DIR = os.path.abspath(os.path.join(BASE_DIR, ".."))

datas = [
    (os.path.join(ROOT_DIR, 'drivers'), 'drivers'),
    (os.path.join(BASE_DIR, 'shared_data.py'), '.'),
    # ipconfig.json is intentionally NOT bundled — it would leak a stale
    # dev default into the EXE and every update would ship that stale copy
    # on the fallback path, silently overwriting user customizations.
    # Runtime config comes from the DB (authoritative) with a mirror file
    # under DATA_DIR preserved across updates.
]
binaries = []
hiddenimports = ['drivers.modbus_tcp', 'drivers.modbus_rtu', 'uvicorn.loops.asyncio', 'uvicorn.lifespan.off', 'uvicorn.protocols.http.h11_impl', 'anyio._backends._asyncio', 'pydantic.v1.datetime_parse',
                 'serial', 'serial.tools', 'serial.tools.list_ports', 'serial.tools.list_ports_windows', 'serial.serialwin32', 'serial.serialutil']
tmp_ret = collect_all('pymodbus')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect_all('serial')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]


a = Analysis(
    [os.path.join(BASE_DIR, 'inverter_engine.py')],
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
    name='InverterCoreService',
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
