import sys
import os
from pathlib import Path

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
    from forecast_engine import main, parse_cli_args, run_cli_generation
except ImportError:
    from services.forecast_engine import main, parse_cli_args, run_cli_generation

if __name__ == "__main__":
    args = parse_cli_args()
    code = run_cli_generation(args)
    if code >= 0:
        raise SystemExit(code)
    main()
