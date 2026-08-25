"""Independent Solcast TOOLKIT probe — does the authenticated Toolkit page
expose any weather fields (GHI, cloud, air_temp) in addition to PV power?

This script does NOT import any dashboard modules. It reads credentials
read-only from the SQLite settings table, mimics the Toolkit browser login,
fetches the data page, and inspects the HTML for weather indicators.

Usage:
    python scripts/probe_solcast_toolkit_weather.py
"""
import json
import os
import re
import sqlite3
import sys
import tempfile
import time
import hmac
import hashlib
import base64
import struct
from urllib.parse import urlparse

import requests

DB_PATH = r"C:\ProgramData\InverterDashboard\db\adsi.db"
SETTINGS_KEYS = (
    "solcastBaseUrl",
    "solcastAccessMode",
    "solcastToolkitEmail",
    "solcastToolkitPassword",
    "solcastToolkitTotpSecret",
    "solcastToolkitSiteRef",
    "solcastToolkitPeriod",
    "plantLatitude",
    "plantLongitude",
)

def get_totp_token(secret: str) -> str:
    if not secret:
        return ""
    padding = '=' * ((8 - len(secret) % 8) % 8)
    try:
        key = base64.b32decode(secret + padding, casefold=True)
    except Exception:
        return ""
    timestamp = int(time.time()) // 30
    msg = struct.pack(">Q", timestamp)
    h = hmac.new(key, msg, hashlib.sha1).digest()
    o = h[19] & 15
    token = (struct.unpack(">I", h[o:o+4])[0] & 0x7fffffff) % 1000000
    return f"{token:06d}"

def read_settings():
    uri = f"file:{DB_PATH}?mode=ro"
    conn = sqlite3.connect(uri, uri=True, timeout=5.0)
    try:
        conn.row_factory = sqlite3.Row
        placeholders = ",".join("?" * len(SETTINGS_KEYS))
        rows = conn.execute(
            f"SELECT key, value FROM settings WHERE key IN ({placeholders})",
            SETTINGS_KEYS,
        ).fetchall()
        return {r["key"]: r["value"] for r in rows}
    finally:
        conn.close()

def extract_js_array_literal(html: str, name: str) -> str:
    """Extract `name = [ ... ]` from JS, returning the raw literal string.
    Handles nested brackets and string escapes, same as server/index.js.
    """
    pattern = re.compile(rf"\b{re.escape(name)}\b\s*=\s*\[")
    m = pattern.search(html)
    if not m:
        return ""
    start = html.find("[", m.start())
    if start < 0:
        return ""
    depth = 0
    quote = ""
    escaped = False
    i = start
    while i < len(html):
        ch = html[i]
        if quote:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == quote:
                quote = ""
        else:
            if ch in ("'", '"', "`"):
                quote = ch
            elif ch == "[":
                depth += 1
            elif ch == "]":
                depth -= 1
                if depth == 0:
                    return html[start : i + 1]
        i += 1
    return ""

def scan_keywords(html: str, keywords):
    results = {}
    lower = html.lower()
    for kw in keywords:
        results[kw] = lower.count(kw.lower())
    return results

def summarize_first_record(literal: str, label: str):
    """Try to pull the first record's field names out of a JS array literal.
    The literal may not be strict JSON (could have unquoted keys), so we use
    a shallow regex-based approach as a fallback.
    """
    if not literal:
        print(f"  ({label}: literal not found)")
        return
    # First try strict JSON
    try:
        parsed = json.loads(literal)
        if isinstance(parsed, list) and parsed:
            first = parsed[0]
            if isinstance(first, dict):
                keys = sorted(first.keys())
                print(f"  {label} strict-JSON keys ({len(keys)}): {keys}")
                return
    except Exception:
        pass
    # Fallback: regex-scan the first record between the first `{` and matching `}`
    open_brace = literal.find("{")
    if open_brace < 0:
        print(f"  {label}: no object in literal")
        return
    depth = 0
    end = -1
    for j in range(open_brace, len(literal)):
        if literal[j] == "{":
            depth += 1
        elif literal[j] == "}":
            depth -= 1
            if depth == 0:
                end = j
                break
    if end < 0:
        print(f"  {label}: unbalanced object")
        return
    first_rec = literal[open_brace : end + 1]
    # Extract keys via regex: `key:` or `"key":`
    keys = set(re.findall(r'["\']?([A-Za-z_][A-Za-z0-9_]*)["\']?\s*:', first_rec))
    keys = sorted(keys)
    print(f"  {label} inferred keys ({len(keys)}): {keys}")
    preview = first_rec[:400].replace("\n", " ")
    print(f"  {label} first-record preview: {preview}")

def try_view(session: requests.Session, base_url: str, site_type: str, site_id: str,
             view: str, hours: int, period: str, dump_dir: str):
    url = (
        f"{base_url}/{site_type}/{site_id}/recent"
        f"?view={view}&theme=light&hours={hours}&period={period}"
    )
    print()
    print("-" * 72)
    print(f"GET {url}")
    try:
        r = session.get(url, timeout=25, allow_redirects=True)
    except Exception as e:
        print(f"transport error: {e}")
        return None
    print(f"HTTP {r.status_code}  content-length={len(r.text)}")
    if r.status_code != 200:
        print("body (truncated):", r.text[:400])
        return None
    html = r.text
    # Save full HTML to disk so we can inspect if needed
    safe_view = re.sub(r"[^A-Za-z0-9_.-]", "_", view)
    dump_path = os.path.join(dump_dir, f"toolkit_{safe_view}.html")
    try:
        with open(dump_path, "w", encoding="utf-8", errors="replace") as f:
            f.write(html)
        print(f"saved raw HTML -> {dump_path}")
    except Exception as e:
        print(f"could not save HTML: {e}")

    # Also dump chartData literal so we can inspect its schema
    for varname in ("chartData", "farray", "result", "results"):
        lit = extract_js_array_literal(html, varname)
        if lit:
            print(f"\n{varname} literal length: {len(lit)}")
            summarize_first_record(lit, varname)

    # Keyword scan
    counts = scan_keywords(html, [
        "forecasts", "estActuals", "pv_estimate",
        "ghi", "dni", "dhi", "cloud", "cloud_opacity",
        "air_temp", "temperature", "weather", "radiation",
        "irradiance", "humidity", "wind_speed",
    ])
    present = [k for k, v in counts.items() if v > 0]
    print(f"keyword hits: {counts}")

    # Pull the forecasts + estActuals literals and enumerate keys
    forecasts_literal = extract_js_array_literal(html, "forecasts")
    estactuals_literal = extract_js_array_literal(html, "estActuals")
    print(f"forecasts literal length : {len(forecasts_literal)}")
    print(f"estActuals literal length: {len(estactuals_literal)}")
    summarize_first_record(forecasts_literal, "forecasts")
    summarize_first_record(estactuals_literal, "estActuals")

    # Also scan for any other `<name> = [` arrays we haven't looked at
    other_arrays = re.findall(r"\b([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\[", html)
    unique_arrays = sorted(set(other_arrays))
    print(f"all JS array names seen in HTML: {unique_arrays}")

    return {"url": url, "html_path": dump_path, "keyword_hits": counts}

def main():
    print("=" * 72)
    print("Solcast TOOLKIT Weather Probe (independent)")
    print("=" * 72)

    try:
        settings = read_settings()
    except Exception as e:
        print(f"FAIL: cannot read settings DB: {e}")
        return 2

    base_url = (settings.get("solcastBaseUrl") or "https://api.solcast.com.au").strip().rstrip("/")
    email = (settings.get("solcastToolkitEmail") or "").strip()
    password = (settings.get("solcastToolkitPassword") or "").strip()
    totp_secret = (settings.get("solcastToolkitTotpSecret") or "").strip()
    site_ref = (settings.get("solcastToolkitSiteRef") or "").strip()
    period = (settings.get("solcastToolkitPeriod") or "PT5M").strip() or "PT5M"

    print(f"base_url     : {base_url}")
    print(f"email        : {email or '(EMPTY)'}")
    print(f"password     : {'set (' + str(len(password)) + ' chars)' if password else '(EMPTY)'}")
    print(f"site_ref     : {site_ref or '(EMPTY)'}")
    print(f"period       : {period}")

    if not (email and password and site_ref):
        print("Missing toolkit credentials or site_ref — cannot probe.")
        return 3

    # Figure out site type — existing code defaults to utility_scale_sites if the
    # ref is a bare id. Ours is "d3d7-4edb-585f-8db9" — bare id.
    site_type = "utility_scale_sites"
    site_id = site_ref
    origin = urlparse(base_url).scheme + "://" + urlparse(base_url).netloc

    page_url = (
        f"{origin}/{site_type}/{site_id}/recent"
        f"?view=Toolkit&theme=light&hours=48&period={period}"
    )

    session = requests.Session()
    session.headers.update({
        "User-Agent": "Mozilla/5.0 (independent probe)",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    })

    # Step 1: landing
    print()
    print("-" * 72)
    print("STEP 1: landing GET (for cookies)")
    print("-" * 72)
    print(f"GET {page_url}")
    r1 = session.get(page_url, timeout=25, allow_redirects=True)
    print(f"HTTP {r1.status_code}")
    print(f"cookies after landing: {list(session.cookies.keys())}")

    # Step 2: login
    print()
    print("-" * 72)
    print("STEP 2: POST /auth/credentials")
    print("-" * 72)
    auth_url = f"{origin}/auth/credentials"
    auth_body = {
        "userName": email,
        "password": password,
        "rememberMe": "false",
        "continue": page_url,
    }
    if totp_secret:
        auth_body["meta"] = {"TwoFactorCode": get_totp_token(totp_secret)}

    r2 = session.post(
        auth_url,
        json=auth_body,
        timeout=25,
        allow_redirects=False,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Referer": page_url,
        },
    )
    print(f"HTTP {r2.status_code}")
    print(f"cookies after login:   {list(session.cookies.keys())}")
    if r2.status_code >= 400:
        print("login body (truncated):", r2.text[:400])
        return 4

    # Dump dir for HTML
    dump_dir = tempfile.mkdtemp(prefix="solcast_probe_")
    print(f"HTML dump dir: {dump_dir}")

    # Try the default "Toolkit" view
    try_view(session, origin, site_type, site_id, "Toolkit", 48, period, dump_dir)

    # Speculative probes — see if the Toolkit exposes weather/radiation views
    for alt_view in ("Weather", "Irradiance", "Radiation", "Live", "History"):
        try_view(session, origin, site_type, site_id, alt_view, 48, period, dump_dir)

    print()
    print("=" * 72)
    print("Probe complete. HTML dumps saved to:")
    print(f"  {dump_dir}")
    print("=" * 72)
    return 0

if __name__ == "__main__":
    sys.exit(main())
