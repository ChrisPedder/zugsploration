#!/usr/bin/env python3
"""
Fetch current rental listings from the Flatfox public API (pin endpoint),
enrich each with room/address details from the public-listing endpoint,
and save as JSON in data/.

Usage:
    python scripts/fetch-flatfox.py
"""

import json
import sys
import time
import urllib.request
import urllib.parse
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

FLATFOX_PIN_URL = "https://flatfox.ch/api/v1/pin/"
FLATFOX_DETAIL_URL = "https://flatfox.ch/api/v1/public-listing/"

BBOX = {
    "north": 47.45,
    "south": 46.95,
    "east": 8.80,
    "west": 8.10,
}

TILE_LAT_STEP = 0.10
TILE_LON_STEP = 0.15
TILE_OVERLAP = 0.005

BATCH_SIZE = 10
BATCH_DELAY = 0.5
MAX_RETRIES = 3
INITIAL_BACKOFF = 1.0

DATA_DIR = Path(__file__).resolve().parent.parent / "data"


def generate_tiles(bbox):
    tiles = []
    south = bbox["south"]
    while south < bbox["north"]:
        north = min(south + TILE_LAT_STEP, bbox["north"])
        west = bbox["west"]
        while west < bbox["east"]:
            east = min(west + TILE_LON_STEP, bbox["east"])
            tiles.append({
                "north": north + TILE_OVERLAP,
                "south": south - TILE_OVERLAP,
                "east": east + TILE_OVERLAP,
                "west": west - TILE_OVERLAP,
            })
            west += TILE_LON_STEP
        south += TILE_LAT_STEP
    return tiles


def fetch_tile(tile):
    params = {
        "north": tile["north"],
        "south": tile["south"],
        "east": tile["east"],
        "west": tile["west"],
        "object_category": "APARTMENT",
        "offer_type": "RENT",
        "count": 500,
    }

    url = FLATFOX_PIN_URL + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url)
    req.add_header("User-Agent", "ZugCommutePlanner/1.0")
    req.add_header("Accept", "application/json")

    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def subdivide_tile(tile):
    mid_lat = (tile["north"] + tile["south"]) / 2
    mid_lon = (tile["east"] + tile["west"]) / 2
    return [
        {"south": tile["south"], "north": mid_lat + TILE_OVERLAP, "west": tile["west"], "east": mid_lon + TILE_OVERLAP},
        {"south": tile["south"], "north": mid_lat + TILE_OVERLAP, "west": mid_lon - TILE_OVERLAP, "east": tile["east"]},
        {"south": mid_lat - TILE_OVERLAP, "north": tile["north"], "west": tile["west"], "east": mid_lon + TILE_OVERLAP},
        {"south": mid_lat - TILE_OVERLAP, "north": tile["north"], "west": mid_lon - TILE_OVERLAP, "east": tile["east"]},
    ]


def fetch_pins():
    tiles = generate_tiles(BBOX)
    print(f"Fetching pins from Flatfox across {len(tiles)} initial tiles...")

    seen_pks = set()
    all_pins = []
    tile_num = 0

    queue = list(tiles)
    while queue:
        tile = queue.pop(0)
        tile_num += 1
        try:
            pins = fetch_tile(tile)
            new_pins = [p for p in pins if p.get("pk") not in seen_pks]
            for p in new_pins:
                seen_pks.add(p["pk"])
            all_pins.extend(new_pins)

            if len(pins) >= 200:
                subtiles = subdivide_tile(tile)
                queue = subtiles + queue
                print(f"  Tile {tile_num}: {len(pins)} pins, {len(new_pins)} new [AT CAP - subdividing into 4]")
            else:
                print(f"  Tile {tile_num}: {len(pins)} pins, {len(new_pins)} new")

            time.sleep(0.3)
        except urllib.error.HTTPError as e:
            print(f"  Tile {tile_num}: HTTP error {e.code} {e.reason}")
        except urllib.error.URLError as e:
            print(f"  Tile {tile_num}: Connection error: {e}")

    print(f"  Total unique pins: {len(all_pins)}")
    return all_pins


def fetch_detail(pk):
    url = f"{FLATFOX_DETAIL_URL}{pk}/"
    for attempt in range(MAX_RETRIES):
        try:
            req = urllib.request.Request(url)
            req.add_header("User-Agent", "ZugCommutePlanner/1.0")
            req.add_header("Accept", "application/json")
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            return {
                "rooms": data.get("number_of_rooms"),
                "surface": data.get("surface_living"),
                "address": data.get("street"),
                "city": data.get("city"),
            }
        except urllib.error.HTTPError as e:
            if e.code == 429 or e.code >= 500:
                wait = INITIAL_BACKOFF * (2 ** attempt)
                print(f"    Rate limited/server error for {pk} (HTTP {e.code}), retrying in {wait}s...")
                time.sleep(wait)
                continue
            print(f"    Failed to fetch detail for {pk}: HTTP {e.code}")
            return None
        except Exception as e:
            if attempt < MAX_RETRIES - 1:
                time.sleep(INITIAL_BACKOFF * (2 ** attempt))
                continue
            print(f"    Failed to fetch detail for {pk}: {e}")
            return None
    return None


def fetch_details_batched(pks):
    results = {}
    total = len(pks)
    for i in range(0, total, BATCH_SIZE):
        batch = pks[i : i + BATCH_SIZE]
        batch_num = i // BATCH_SIZE + 1
        total_batches = (total + BATCH_SIZE - 1) // BATCH_SIZE
        print(f"  Fetching details batch {batch_num}/{total_batches} ({len(batch)} listings)...")
        with ThreadPoolExecutor(max_workers=BATCH_SIZE) as pool:
            futures = {pool.submit(fetch_detail, pk): pk for pk in batch}
            for future in as_completed(futures):
                pk = futures[future]
                results[pk] = future.result()
        if i + BATCH_SIZE < total:
            time.sleep(BATCH_DELAY)
    return results


def transform_listings(raw_pins, details):
    listings = []
    for pin in raw_pins:
        lat = pin.get("latitude")
        lon = pin.get("longitude")
        pk = pin.get("pk")
        price = pin.get("price_display")

        if lat is None or lon is None or pk is None:
            continue

        listing = {
            "id": pk,
            "lat": lat,
            "lon": lon,
            "url": f"https://flatfox.ch/{pk}/",
        }

        if price is not None:
            try:
                listing["price"] = int(float(price))
            except (ValueError, TypeError):
                listing["price"] = None
        else:
            listing["price"] = None

        listing["price_unit"] = pin.get("price_unit", "")

        detail = details.get(pk)
        if detail:
            rooms = detail.get("rooms")
            if rooms is not None:
                try:
                    listing["rooms"] = float(rooms)
                except (ValueError, TypeError):
                    pass
            surface = detail.get("surface")
            if surface is not None:
                listing["surface"] = surface
            if detail.get("address"):
                listing["address"] = detail["address"]
            if detail.get("city"):
                listing["city"] = detail["city"]

        listings.append(listing)

    return listings


def main():
    print("=" * 60)
    print("Zug Commute Map — Flatfox Listings Fetcher")
    print("=" * 60)

    raw = fetch_pins()
    pks = [p["pk"] for p in raw if p.get("pk") is not None]

    print(f"\nEnriching {len(pks)} listings with room/address details...")
    details = fetch_details_batched(pks)
    enriched = sum(1 for v in details.values() if v is not None)
    print(f"  Successfully enriched {enriched}/{len(pks)} listings")

    listings = transform_listings(raw, details)
    with_price = [l for l in listings if l["price"] is not None]
    with_rooms = [l for l in listings if l.get("rooms") is not None]
    print(f"\n  {len(with_price)} listings have a price")
    print(f"  {len(with_rooms)} listings have room count")

    if with_price:
        prices = [l["price"] for l in with_price]
        print(f"  Price range: CHF {min(prices)} – {max(prices)}/month")

    if with_rooms:
        rooms = sorted(set(l["rooms"] for l in with_rooms))
        print(f"  Room counts: {', '.join(str(r) for r in rooms)}")

    output = {
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
        "source": "Flatfox public API (pin + public-listing endpoints)",
        "bbox": BBOX,
        "count": len(listings),
        "listings": listings,
    }

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    out_path = DATA_DIR / "flatfox-listings.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f"\nWrote {len(listings)} listings to {out_path}")


if __name__ == "__main__":
    main()
