"""Single-attempt Solcast trial probe — independent from dashboard code.

Calls /data/forecast/radiation_and_weather exactly ONCE with the provided
API key. Saves the full raw JSON response to disk so we never need to
re-fetch. Prints record count, field coverage, and first 3 records.

NO retries. NO fallbacks. NO speculative calls. One attempt, period.

Key resolution order (first match wins):
    1. --api-key <KEY>   (command line, not recommended — visible in ps)
    2. $SOLCAST_API_KEY  (environment variable)
    3. $SOLCAST_KEY_FILE (path to a file containing just the key)
    4. C:\\Users\\User\\.solcast_trial_key.txt (default file)
    5. settings table in C:\\ProgramData\\InverterDashboard\\db\\adsi.db

Usage:
    python scripts/probe_solcast_trial.py                # default: forecast
    python scripts/probe_solcast_trial.py forecast
    python scripts/probe_solcast_trial.py live           # if you explicitly want live
"""
import argparse
import json
import os
import sqlite3
import sys
import time
import urllib.parse
import urllib.request
import urllib.error

# --- Fixed parameters (edit only if the user confirms) -----------------------
LAT = 6.772269
LON = 125.284455
HOURS = 336
PERIOD = "PT60M"
OUTPUT_PARAMETERS = [
    "ghi",
    "dni",
    "dhi",
    "cloud_opacity",
    "air_temp",
    "relative_humidity",
    "wind_speed_10m",
    "precipitation_rate",
]
BASE_URL = "https://api.solcast.com.au"
DB_PATH = r"C:\ProgramData\InverterDashboard\db\adsi.db"
DEFAULT_KEY_FILE = r"C:\Users\User\.solcast_trial_key.txt"

# Where to save the raw response (so we never re-probe to re-read it)
RESPONSE_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "private"
)

def load_api_key(cli_key: str | None) -> tuple[str, str]:
    """Return (key, source-label). Raises RuntimeError if none found."""
    if cli_key:
        return cli_key.strip(), "command line"
    env_key = os.environ.get("SOLCAST_API_KEY", "").strip()
    if env_key:
        return env_key, "$SOLCAST_API_KEY"
    key_file = os.environ.get("SOLCAST_KEY_FILE", "").strip() or DEFAULT_KEY_FILE
    if key_file and os.path.isfile(key_file):
        try:
            with open(key_file, "r", encoding="utf-8") as f:
                k = f.read().strip()
            if k:
                return k, f"file: {key_file}"
        except Exception as e:
            print(f"warning: could not read {key_file}: {e}", file=sys.stderr)
    # Last resort: dashboard settings DB
    try:
        uri = f"file:{DB_PATH}?mode=ro"
        conn = sqlite3.connect(uri, uri=True, timeout=5.0)
        try:
            row = conn.execute(
                "SELECT value FROM settings WHERE key = ?", ("solcastApiKey",)
            ).fetchone()
            if row and row[0]:
                return str(row[0]).strip(), "adsi.db settings.solcastApiKey"
        finally:
            conn.close()
    except Exception as e:
        print(f"warning: could not read settings DB: {e}", file=sys.stderr)
    raise RuntimeError(
        "No API key found. Set SOLCAST_API_KEY env var, create "
        f"{DEFAULT_KEY_FILE}, or pass --api-key."
    )

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "endpoint",
        nargs="?",
        default="forecast",
        choices=("forecast", "live"),
        help="Which Solcast endpoint to call (default: forecast)",
    )
    parser.add_argument("--api-key", default=None, help="API key (not recommended)")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the request but do NOT send it. Costs 0 attempts.",
    )
    args = parser.parse_args()

    print("=" * 72)
    print(f"Solcast Trial Probe — endpoint={args.endpoint}")
    print("=" * 72)

    try:
        api_key, key_source = load_api_key(args.api_key)
    except RuntimeError as e:
        print(f"ERROR: {e}")
        return 2

    masked = f"{api_key[:4]}...{api_key[-4:]}" if len(api_key) >= 8 else "(short)"
    print(f"API key source: {key_source}")
    print(f"API key        : {masked}  (length {len(api_key)})")
    print(f"latitude       : {LAT}")
    print(f"longitude      : {LON}")
    print(f"hours          : {HOURS}")
    print(f"period         : {PERIOD}")
    print(f"output_params  : {','.join(OUTPUT_PARAMETERS)}")

    params = {
        "latitude": LAT,
        "longitude": LON,
        "hours": HOURS,
        "output_parameters": ",".join(OUTPUT_PARAMETERS),
        "period": PERIOD,
        "format": "json",
    }
    qs = urllib.parse.urlencode(params)
    url = f"{BASE_URL}/data/{args.endpoint}/radiation_and_weather?{qs}"
    print(f"\nFull URL:\n  {url}\n")

    if args.dry_run:
        print("DRY RUN: not sending request. 0 attempts consumed.")
        return 0

    # Confirm one more time before consuming an attempt
    print(">>> About to send ONE authenticated request. This consumes 1 attempt.")
    print(">>> No retries will be attempted on any failure.")

    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Accept": "application/json",
            "User-Agent": "ADSI-Dashboard trial probe/1.0",
        },
    )

    os.makedirs(RESPONSE_DIR, exist_ok=True)
    ts = time.strftime("%Y%m%dT%H%M%S")
    out_path = os.path.join(
        RESPONSE_DIR, f"solcast_{args.endpoint}_{ts}.json"
    )

    started = time.time()
    status = None
    body_text = ""
    try:
        with urllib.request.urlopen(req, timeout=30.0) as resp:
            status = resp.status
            body_text = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        status = e.code
        try:
            body_text = e.read().decode("utf-8", errors="replace")
        except Exception:
            body_text = ""
    except Exception as e:
        print(f"\nTRANSPORT ERROR (attempt likely NOT consumed): {e}")
        return 3

    elapsed = time.time() - started
    print(f"\nHTTP {status}  ({elapsed:.2f}s)  body length={len(body_text)}")

    # Always save the raw body, even on error — it's diagnostic gold
    try:
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(body_text)
        print(f"Saved raw body -> {out_path}")
    except Exception as e:
        print(f"WARNING: could not save response: {e}")

    if status != 200:
        print("\nNon-200 response body (truncated):")
        print(body_text[:1500])
        return 4

    # Parse + summarize
    try:
        data = json.loads(body_text)
    except Exception as e:
        print(f"\nJSON parse failed: {e}")
        print("First 800 chars of body:")
        print(body_text[:800])
        return 5

    rows = data.get("forecasts") or data.get("estimated_actuals") or []
    print(f"\nRecord count : {len(rows)}")
    if not rows:
        print("Top-level keys:", list(data.keys()))
        return 6

    # Field coverage across all rows
    all_keys: set[str] = set()
    for r in rows:
        if isinstance(r, dict):
            all_keys.update(r.keys())
    print(f"Fields present : {sorted(all_keys)}")

    # Which requested params actually came back?
    print("\nRequested param coverage:")
    for p in OUTPUT_PARAMETERS:
        present = p in all_keys
        n_valid = (
            sum(1 for r in rows if isinstance(r.get(p), (int, float)))
            if present
            else 0
        )
        status_str = f"{n_valid}/{len(rows)} valid" if present else "MISSING"
        print(f"  {'OK ' if present else '-- '} {p:25s} {status_str}")

    print("\nFirst 3 records:")
    print(json.dumps(rows[:3], indent=2))

    print()
    print("=" * 72)
    print(f"SUCCESS — response saved at {out_path}")
    print("=" * 72)
    return 0

if __name__ == "__main__":
    sys.exit(main())
