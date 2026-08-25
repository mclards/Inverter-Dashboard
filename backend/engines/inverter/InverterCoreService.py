import sys
import os
from pathlib import Path
import asyncio

if sys.stdout is None:
    sys.stdout = open(os.devnull, 'w')
if sys.stderr is None:
    sys.stderr = open(os.devnull, 'w')

try:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# Ensure local engine directory is in sys.path
sys.path.insert(0, str(Path(__file__).resolve().parent))

try:
    from inverter_engine import main
except ImportError:
    from services.inverter_engine import main

if __name__ == "__main__":
    asyncio.run(main())
