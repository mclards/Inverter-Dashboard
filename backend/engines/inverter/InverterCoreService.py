import sys
from pathlib import Path
import asyncio

# Ensure local engine directory is in sys.path
sys.path.insert(0, str(Path(__file__).resolve().parent))

try:
    from inverter_engine import main
except ImportError:
    from services.inverter_engine import main

if __name__ == "__main__":
    asyncio.run(main())
