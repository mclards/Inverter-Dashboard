"""Root-level shim for CalibratorService.
Allows Electron and local scripts to invoke `python CalibratorService.py`
with the repository root on sys.path.
"""
import sys
import os
import asyncio
from pathlib import Path

# Ensure repo root is on sys.path
sys.path.insert(0, str(Path(__file__).resolve().parent))

from services.calibrator_app import main

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
