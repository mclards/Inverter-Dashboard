# -*- mode: python ; coding: utf-8 -*-

import os
from pathlib import Path
import subprocess
import sys


service_dir = Path(SPECPATH).resolve()
repo_root = service_dir.parent
forecast_source = service_dir / 'forecast_engine.py'
build_info = service_dir / 'forecast-build-info.json'
build_info_generator = repo_root / 'scripts' / 'generate_build_info.py'

# Direct PyInstaller invocations must not silently freeze stale identity data.
# The supported build wrapper generates this file immediately before invoking
# PyInstaller; this check also protects developers who invoke the spec by hand.
check_args = [
    sys.executable,
    str(build_info_generator),
    '--repo-root',
    str(repo_root),
    '--output',
    str(build_info),
    '--check',
    '--build-channel',
    os.environ.get('ADSI_FORECAST_BUILD_CHANNEL', 'development'),
]
if os.environ.get('ADSI_REQUIRE_PROMOTION_ELIGIBLE') == '1':
    check_args.extend(('--require-promotion-eligible', '--require-release-ready'))
check_result = subprocess.run(check_args, cwd=repo_root, check=False)
if check_result.returncode != 0:
    raise SystemExit(
        'Forecast build identity preflight failed. Run '
        '`python scripts/generate_build_info.py` immediately before PyInstaller.'
    )

a = Analysis(
    [str(forecast_source)],
    pathex=[str(service_dir)],
    binaries=[],
    # In a one-file build this is extracted into sys._MEIPASS, which is also
    # Path(forecast_engine.__file__).parent. This matches the runtime resolver.
    datas=[(str(build_info), '.')],
    hiddenimports=[],
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
    name='ForecastCoreService',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
