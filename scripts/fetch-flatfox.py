#!/usr/bin/env python3
"""
Fetch current rental listings from the Flatfox public API (pin endpoint)
and save as JSON in data/.

Usage:
    python scripts/fetch-flatfox.py
    python scripts/fetch-flatfox.py --min-rooms 2 --max-rooms 3.5
"""

import argparse
import json
import sys
import urllib.request
import urllib.parse
import urllib.error
from datetime import datetime, timezone
from pathlib import Path

FLATFOX_PIN_URL = "https://flatfox.ch/api/v1/pin/"

# Bounding box covering the map area (~20km around Zug)
BBOX = {
    "north": 47.30,
    "south": 47.00,
    "east": 8.70,
    "west": 8.25,
}

DATA_DIR = Path(__file__).resolve().parent.parent / "data"


def fetch_listings(min_rooms=None, max_rooms=None, min_price=None, max_price=None):
    params = {
        "north": BBOX["north"],
        "south": BBOX["south"],
        "east": BBOX["east"],
        "west": BBOX["west"],
        "object_category": "APARTMENT",
        "offer_type": "RENT",
        "count": 500,
    }

    if min_rooms is not None:
        params["min_rooms"] = min_rooms
    if max_rooms is not None:
        params["max_rooms"] = max_rooms
    if min_price is not None:
        params["min_price"] = min_price
    if max_price is not None:
        params["max_price"] = max_price

    url = FLATFOX_PIN_URL + "?" + urllib.parse.urlencode(params)
    print(f"Fetching listings from Flatfox...")
    print(f"  URL: {url}")

    req = urllib.request.Request(url)
    req.add_header("User-Agent", "ZugCommutePlanner/1.0")
    req.add_header("Accept", "application/json")

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        print(f"  HTTP error: {e.code} {e.reason}")
        sys.exit(1)
    except urllib.error.URLError as e:
        print(f"  Connection error: {e}")
        sys.exit(1)

    print(f"  Got {len(data)} listings")
    return data


def transform_listings(raw_listings):
    listings = []
    for pin in raw_listings:
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

        price_unit = pin.get("price_unit", "")
        listing["price_unit"] = price_unit

        listings.append(listing)

    return listings


def main():
    parser = argparse.ArgumentParser(description="Fetch Flatfox rental listings")
    parser.add_argument("--min-rooms", type=float, help="Minimum number of rooms")
    parser.add_argument("--max-rooms", type=float, help="Maximum number of rooms")
    parser.add_argument("--min-price", type=int, help="Minimum monthly rent (CHF)")
    parser.add_argument("--max-price", type=int, help="Maximum monthly rent (CHF)")
    args = parser.parse_args()

    print("=" * 60)
    print("Zug Commute Map — Flatfox Listings Fetcher")
    print("=" * 60)

    raw = fetch_listings(
        min_rooms=args.min_rooms,
        max_rooms=args.max_rooms,
        min_price=args.min_price,
        max_price=args.max_price,
    )

    listings = transform_listings(raw)
    with_price = [l for l in listings if l["price"] is not None]
    print(f"  {len(with_price)} listings have a price")

    if with_price:
        prices = [l["price"] for l in with_price]
        print(f"  Price range: CHF {min(prices)} – {max(prices)}/month")

    output = {
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
        "source": "Flatfox public API (pin endpoint)",
        "bbox": BBOX,
        "count": len(listings),
        "listings": listings,
    }

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    out_path = DATA_DIR / "flatfox-listings.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f"\nWrote {len(listings)} listings to {out_path}")
    print("Run this script again to refresh with current listings.")


if __name__ == "__main__":
    main()
