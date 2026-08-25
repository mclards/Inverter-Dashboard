"""Inspect a saved Toolkit HTML dump to find where pv_estimate data lives."""
import re
import sys

path = sys.argv[1] if len(sys.argv) > 1 else None
if not path:
    print("usage: python inspect_toolkit_html.py <path-to-html>")
    sys.exit(1)

with open(path, encoding="utf-8") as f:
    html = f.read()

print(f"Total HTML length: {len(html)}")

scripts = re.findall(r"<script[^>]*>([\s\S]*?)</script>", html, re.IGNORECASE)
print(f"script tags: {len(scripts)}")
for i, s in enumerate(scripts):
    stripped = s.strip()
    preview = stripped[:180].replace("\n", " ").replace("\r", "")
    has_pv = "pv_estimate" in s
    has_ghi = "ghi" in s
    has_cloud = "cloud" in s
    print(f"  [{i}] len={len(s)}  pv_estimate={has_pv}  ghi={has_ghi}  cloud={has_cloud}")
    if len(s) > 0:
        print(f"       preview: {preview}")

# Find all "xxx = [" or "xxx = JSON.parse(" assignments
assigns = re.findall(r"(?:var|let|const)?\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\[|JSON\.parse\(|\{)", html)
print(f"\nAll JS assignments with array/JSON.parse/object RHS:")
seen = set()
for name, kind in assigns:
    key = (name, kind)
    if key in seen:
        continue
    seen.add(key)
    print(f"  {name} = {kind}...")

# Locate pv_estimate first hit and show context
hits = [m.start() for m in re.finditer("pv_estimate", html)]
print(f"\npv_estimate hit count: {len(hits)}")
if hits:
    first = hits[0]
    ctx = html[max(0, first - 200) : first + 300]
    print("First pv_estimate context:")
    print(repr(ctx))

# Look for JSON.parse with long strings
json_parses = re.findall(
    r"""([A-Za-z_][A-Za-z0-9_]*)\s*=\s*JSON\.parse\((['"])((?:\\.|(?!\2).){0,200000})\2\)""",
    html,
)
print(f"\nJSON.parse assignments: {len(json_parses)}")
for name, q, data in json_parses[:10]:
    preview = data[:200].replace("\\n", " ")
    print(f"  {name}: len={len(data)}  preview={preview}")

# Grep for weather-related raw tokens anywhere in HTML
print("\nRaw weather-keyword frequencies in HTML:")
for kw in ("ghi", "dni", "dhi", "cloud_opacity", "air_temp", "temperature",
           "radiation", "irradiance", "humidity", "wind_speed",
           "forecasts", "estActuals", "pv_estimate", "pv_estimate10", "pv_estimate90"):
    print(f"  {kw}: {html.lower().count(kw.lower())}")
