#!/usr/bin/env python3
"""
Fetch municipality boundaries and cycling network from OpenStreetMap
via the Overpass API, saving results as GeoJSON in data/.

Usage:
    python scripts/fetch-osm-data.py

Rate-limits requests to respect the public Overpass API.
"""

import json
import time
import sys
import urllib.request
import urllib.parse
import urllib.error
from pathlib import Path

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
ZUG_LAT = 47.1724
ZUG_LON = 8.5170
RADIUS_KM = 20
RADIUS_M = RADIUS_KM * 1000

DATA_DIR = Path(__file__).resolve().parent.parent / "data"


def query_overpass(query: str, description: str) -> dict:
    """Send a query to the Overpass API with retries and rate limiting."""
    print(f"Fetching {description}...")
    encoded = urllib.parse.urlencode({"data": query}).encode("utf-8")

    for attempt in range(3):
        try:
            req = urllib.request.Request(OVERPASS_URL, data=encoded)
            req.add_header("User-Agent", "ZugCommutePlanner/1.0")
            with urllib.request.urlopen(req, timeout=120) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            print(f"  Got {len(data.get('elements', []))} elements")
            return data
        except urllib.error.HTTPError as e:
            if e.code == 429 or e.code >= 500:
                wait = 30 * (attempt + 1)
                print(f"  Server returned {e.code}, retrying in {wait}s...")
                time.sleep(wait)
            else:
                raise
        except urllib.error.URLError as e:
            wait = 15 * (attempt + 1)
            print(f"  Connection error: {e}, retrying in {wait}s...")
            time.sleep(wait)

    print(f"  FAILED after 3 attempts: {description}")
    sys.exit(1)


def fetch_municipalities():
    """Fetch admin_level=8 boundaries within radius of Zug."""
    query = f"""
[out:json][timeout:90];
(
  relation["boundary"="administrative"]["admin_level"="8"]
    (around:{RADIUS_M},{ZUG_LAT},{ZUG_LON});
);
out body;
>;
out skel qt;
"""
    return query_overpass(query, "municipality boundaries")


def fetch_cycling_network():
    """Fetch the permitted cycling road network within radius of Zug."""
    query = f"""
[out:json][timeout:120];
(
  way["highway"="residential"](around:{RADIUS_M},{ZUG_LAT},{ZUG_LON});
  way["highway"="living_street"](around:{RADIUS_M},{ZUG_LAT},{ZUG_LON});
  way["highway"="cycleway"](around:{RADIUS_M},{ZUG_LAT},{ZUG_LON});
  way["highway"="path"]["bicycle"~"yes|designated"](around:{RADIUS_M},{ZUG_LAT},{ZUG_LON});
  way["highway"="track"]["bicycle"~"yes|designated"](around:{RADIUS_M},{ZUG_LAT},{ZUG_LON});
  way["highway"="service"](around:{RADIUS_M},{ZUG_LAT},{ZUG_LON});
  way["highway"="tertiary"](around:{RADIUS_M},{ZUG_LAT},{ZUG_LON});
  way["highway"="unclassified"](around:{RADIUS_M},{ZUG_LAT},{ZUG_LON});
);
out body;
>;
out skel qt;
"""
    return query_overpass(query, "cycling network")


def osm_to_geojson_ways(data: dict) -> dict:
    """Convert Overpass JSON (ways + nodes) to a GeoJSON FeatureCollection of LineStrings."""
    nodes = {}
    for el in data["elements"]:
        if el["type"] == "node":
            nodes[el["id"]] = (el["lon"], el["lat"])

    features = []
    for el in data["elements"]:
        if el["type"] != "way":
            continue
        coords = []
        for nid in el.get("nodes", []):
            if nid in nodes:
                coords.append(list(nodes[nid]))
        if len(coords) < 2:
            continue
        features.append({
            "type": "Feature",
            "properties": {
                "id": el["id"],
                "highway": el.get("tags", {}).get("highway", ""),
                "name": el.get("tags", {}).get("name", ""),
                "bicycle": el.get("tags", {}).get("bicycle", ""),
                "surface": el.get("tags", {}).get("surface", ""),
            },
            "geometry": {
                "type": "LineString",
                "coordinates": coords,
            },
        })

    return {"type": "FeatureCollection", "features": features}


def osm_to_geojson_boundaries(data: dict) -> dict:
    """Convert Overpass JSON (relations + ways + nodes) to GeoJSON polygons for admin boundaries."""
    nodes = {}
    ways = {}

    for el in data["elements"]:
        if el["type"] == "node":
            nodes[el["id"]] = (el["lon"], el["lat"])
        elif el["type"] == "way":
            ways[el["id"]] = el.get("nodes", [])

    features = []
    for el in data["elements"]:
        if el["type"] != "relation":
            continue

        tags = el.get("tags", {})
        name = tags.get("name", f"Relation {el['id']}")

        outer_ways = []
        for member in el.get("members", []):
            if member["type"] == "way" and member.get("role") == "outer":
                outer_ways.append(member["ref"])

        rings = []
        for wid in outer_ways:
            if wid not in ways:
                continue
            coords = []
            for nid in ways[wid]:
                if nid in nodes:
                    coords.append(list(nodes[nid]))
            if len(coords) >= 2:
                rings.append(coords)

        if not rings:
            continue

        merged = merge_rings(rings)

        for ring in merged:
            if len(ring) >= 4:
                features.append({
                    "type": "Feature",
                    "properties": {
                        "id": el["id"],
                        "name": name,
                        "canton": tags.get("ISO3166-2", ""),
                        "admin_level": tags.get("admin_level", ""),
                        "wikidata": tags.get("wikidata", ""),
                    },
                    "geometry": {
                        "type": "Polygon",
                        "coordinates": [ring],
                    },
                })

    return {"type": "FeatureCollection", "features": features}


def merge_rings(segments):
    """Merge way segments into closed rings where possible."""
    if not segments:
        return []

    remaining = list(segments)
    merged = []

    while remaining:
        current = list(remaining.pop(0))
        changed = True
        while changed:
            changed = False
            for i, seg in enumerate(remaining):
                if not seg:
                    continue
                if coords_match(current[-1], seg[0]):
                    current.extend(seg[1:])
                    remaining.pop(i)
                    changed = True
                    break
                elif coords_match(current[-1], seg[-1]):
                    current.extend(reversed(seg[:-1]))
                    remaining.pop(i)
                    changed = True
                    break
                elif coords_match(current[0], seg[-1]):
                    current = list(seg[:-1]) + current
                    remaining.pop(i)
                    changed = True
                    break
                elif coords_match(current[0], seg[0]):
                    current = list(reversed(seg[1:])) + current
                    remaining.pop(i)
                    changed = True
                    break
        merged.append(current)

    return merged


def coords_match(a, b, tol=1e-7):
    """Check if two coordinate pairs match within tolerance."""
    return abs(a[0] - b[0]) < tol and abs(a[1] - b[1]) < tol


def main():
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    print("=" * 60)
    print("Zug Commute Map — OSM Data Fetcher")
    print("=" * 60)
    print(f"Centre: {ZUG_LAT}, {ZUG_LON}")
    print(f"Radius: {RADIUS_KM} km")
    print()

    muni_data = fetch_municipalities()
    print("  Waiting 10s before next query (rate limiting)...")
    time.sleep(10)

    cycling_data = fetch_cycling_network()

    print()
    print("Converting to GeoJSON...")

    muni_geojson = osm_to_geojson_boundaries(muni_data)
    muni_path = DATA_DIR / "municipalities.geojson"
    with open(muni_path, "w", encoding="utf-8") as f:
        json.dump(muni_geojson, f, ensure_ascii=False)
    print(f"  Wrote {len(muni_geojson['features'])} municipality boundaries to {muni_path}")

    cycling_geojson = osm_to_geojson_ways(cycling_data)
    cycling_path = DATA_DIR / "cycling-network.geojson"
    with open(cycling_path, "w", encoding="utf-8") as f:
        json.dump(cycling_geojson, f, ensure_ascii=False)
    print(f"  Wrote {len(cycling_geojson['features'])} cycling ways to {cycling_path}")

    print()
    print("Done. Run this script again to refresh the data.")


if __name__ == "__main__":
    main()
