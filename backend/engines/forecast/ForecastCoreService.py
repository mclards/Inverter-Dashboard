import sys
from pathlib import Path

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
