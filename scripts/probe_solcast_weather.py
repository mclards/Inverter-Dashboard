"""Independent Solcast weather-endpoint probe.

Does NOT import any dashboard modules. Reads credentials read-only
from the live SQLite settings table and calls Solcast directly.
"""
import json
import sqlite3
import sys
import urllib.parse
import urllib.request

DB_PATH = r"C:\ProgramData\InverterDashboard\db\adsi.db"
SETTINGS_KEYS = (
    "solcastApiKey",
    "solcastResourceId",
    "solcastBaseUrl",
    "solcastAccessMode",
    "solcastToolkitEmail",
    "solcastToolkitSiteRef",
    "plantLatitude",
    "plantLongitude",
)

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

def http_get(url: str, headers: dict, timeout: float = 25.0):
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8", errors="replace")
        except Exception:
            pass
        return e.code, body
    except Exception as e:
        return -1, f"transport error: {e}"

def main():
    print("=" * 72)
    print("Solcast Weather Endpoint Probe (independent)")
    print("=" * 72)

    try:
        settings = read_settings()
    except Exception as e:
        print(f"FAIL: cannot read settings DB: {e}")
        return 2

    api_key = (settings.get("solcastApiKey") or "").strip()
    resource_id = (settings.get("solcastResourceId") or "").strip()
    base_url = (settings.get("solcastBaseUrl") or "https://api.solcast.com.au").strip().rstrip("/")
    access_mode = (settings.get("solcastAccessMode") or "").strip()
    toolkit_email = (settings.get("solcastToolkitEmail") or "").strip()
    toolkit_site_ref = (settings.get("solcastToolkitSiteRef") or "").strip()
    lat = (settings.get("plantLatitude") or "").strip()
    lon = (settings.get("plantLongitude") or "").strip()

    print(f"DB path         : {DB_PATH}")
    print(f"base_url        : {base_url}")
    print(f"access_mode     : {access_mode or '(unset)'}")
    print(f"api_key         : {'set (' + str(len(api_key)) + ' chars)' if api_key else '(EMPTY)'}")
    print(f"resource_id     : {resource_id or '(empty)'}")
    print(f"toolkit_email   : {toolkit_email or '(empty)'}")
    print(f"toolkit_site    : {toolkit_site_ref or '(empty)'}")
    print(f"plant lat/lon   : {lat}, {lon}")
    print()

    if not api_key:
        print("No api_key configured — cannot test Rooftop/Utility weather endpoint with Bearer auth.")
        print("This probe does NOT attempt the Toolkit login flow.")
        return 3

    if not lat or not lon:
        print("Plant lat/lon not set in settings — using fallback 15.48 / 120.71 for the probe.")
        lat = lat or "15.48"
        lon = lon or "120.71"

    # --- Test 1: Lat/Lon weather endpoint (the one we actually want) ------------
    print("-" * 72)
    print("TEST 1: /data/forecast/radiation_and_weather  (lat/lon, weather fields)")
    print("-" * 72)
    params = urllib.parse.urlencode({
        "latitude": lat,
        "longitude": lon,
        "output_parameters": "air_temp,ghi,dni,dhi,cloud_opacity",
        "period": "PT30M",
        "hours": "48",
        "format": "json",
    })
    url = f"{base_url}/data/forecast/radiation_and_weather?{params}"
    print(f"GET {url}")
    status, body = http_get(url, {
        "Authorization": f"Bearer {api_key}",
        "Accept": "application/json",
    })
    print(f"HTTP {status}")
    if status == 200:
        try:
            data = json.loads(body)
            rows = data.get("forecasts") or []
            print(f"Records: {len(rows)}")
            print("First 3 records:")
            print(json.dumps(rows[:3], indent=2))
            keys_found = set()
            for r in rows[:20]:
                keys_found.update(r.keys())
            print()
            print(f"Fields present: {sorted(keys_found)}")
            for want in ("ghi", "dni", "dhi", "cloud_opacity", "air_temp"):
                ok = any(isinstance(r.get(want), (int, float)) for r in rows)
                print(f"  {'OK' if ok else 'MISSING'}  {want}")
        except Exception as e:
            print(f"parse error: {e}")
            print(body[:800])
    else:
        print("Body (truncated):")
        print(body[:1200])

    # --- Test 2: Resource_id PV-power endpoint (sanity check on auth) -----------
    if resource_id:
        print()
        print("-" * 72)
        print("TEST 2: /rooftop_sites/{id}/forecasts  (sanity check — PV power, already used)")
        print("-" * 72)
        url2 = f"{base_url}/rooftop_sites/{urllib.parse.quote(resource_id)}/forecasts?format=json"
        print(f"GET {url2}")
        status2, body2 = http_get(url2, {
            "Authorization": f"Bearer {api_key}",
            "Accept": "application/json",
        })
        print(f"HTTP {status2}")
        if status2 == 200:
            try:
                data2 = json.loads(body2)
                rows2 = data2.get("forecasts") or []
                print(f"Records: {len(rows2)}")
                if rows2:
                    print("First record keys:", sorted(rows2[0].keys()))
                    print("First record:", json.dumps(rows2[0], indent=2))
            except Exception as e:
                print(f"parse error: {e}")
                print(body2[:800])
        else:
            print("Body (truncated):")
            print(body2[:1200])
    else:
        print()
        print("(TEST 2 skipped — no resource_id configured)")

    print()
    print("=" * 72)
    print("Probe complete.")
    print("=" * 72)
    return 0

if __name__ == "__main__":
    sys.exit(main())
