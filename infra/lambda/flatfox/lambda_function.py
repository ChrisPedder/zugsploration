import json
import os
import time
import urllib.request
import urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

import boto3

FLATFOX_PIN_URL = "https://flatfox.ch/api/v1/pin/"
FLATFOX_DETAIL_URL = "https://flatfox.ch/api/v1/public-listing/"
BBOX = {"north": 47.45, "south": 46.95, "east": 8.80, "west": 8.10}

TILE_LAT_STEP = 0.10
TILE_LON_STEP = 0.15
TILE_OVERLAP = 0.005

BATCH_SIZE = 10
BATCH_DELAY = 0.5
MAX_RETRIES = 3
INITIAL_BACKOFF = 1.0


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
                time.sleep(INITIAL_BACKOFF * (2 ** attempt))
                continue
            return None
        except Exception:
            if attempt < MAX_RETRIES - 1:
                time.sleep(INITIAL_BACKOFF * (2 ** attempt))
                continue
            return None
    return None


def fetch_details_batched(pks):
    results = {}
    for i in range(0, len(pks), BATCH_SIZE):
        batch = pks[i : i + BATCH_SIZE]
        with ThreadPoolExecutor(max_workers=BATCH_SIZE) as pool:
            futures = {pool.submit(fetch_detail, pk): pk for pk in batch}
            for future in as_completed(futures):
                pk = futures[future]
                results[pk] = future.result()
        if i + BATCH_SIZE < len(pks):
            time.sleep(BATCH_DELAY)
    return results


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


def fetch_all_pins():
    tiles = generate_tiles(BBOX)
    seen_pks = set()
    all_pins = []
    queue = list(tiles)
    while queue:
        tile = queue.pop(0)
        try:
            raw = fetch_tile(tile)
            if len(raw) >= 200:
                queue = subdivide_tile(tile) + queue
                continue
            for pin in raw:
                pk = pin.get("pk")
                if pk is None or pk in seen_pks:
                    continue
                lat = pin.get("latitude")
                lon = pin.get("longitude")
                if lat is None or lon is None:
                    continue
                seen_pks.add(pk)
                all_pins.append({
                    "pk": pk, "lat": lat, "lon": lon,
                    "price": pin.get("price_display"),
                    "price_unit": pin.get("price_unit", ""),
                })
            time.sleep(0.3)
        except Exception:
            continue
    return all_pins


def do_scrape():
    pins = fetch_all_pins()
    details = fetch_details_batched([p["pk"] for p in pins])

    listings = []
    for pin in pins:
        listing = {
            "id": pin["pk"],
            "lat": pin["lat"],
            "lon": pin["lon"],
            "url": f"https://flatfox.ch/{pin['pk']}/",
            "price_unit": pin["price_unit"],
        }

        price = pin["price"]
        if price is not None:
            try:
                listing["price"] = int(float(price))
            except (ValueError, TypeError):
                listing["price"] = None
        else:
            listing["price"] = None

        detail = details.get(pin["pk"])
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


def handler(event, context):
    is_async = event.get("async_scrape", False)

    if is_async:
        try:
            listings = do_scrape()
            output = {
                "fetchedAt": datetime.now(timezone.utc).isoformat(),
                "source": "Flatfox public API (pin + public-listing endpoints)",
                "bbox": BBOX,
                "count": len(listings),
                "listings": listings,
            }
            s3 = boto3.client("s3")
            s3.put_object(
                Bucket=os.environ["SITE_BUCKET"],
                Key="data/flatfox-listings.json",
                Body=json.dumps(output, ensure_ascii=False),
                ContentType="application/json",
            )
            cf = boto3.client("cloudfront")
            cf.create_invalidation(
                DistributionId=os.environ["DISTRIBUTION_ID"],
                InvalidationBatch={
                    "Paths": {"Quantity": 1, "Items": ["/data/flatfox-listings.json"]},
                    "CallerReference": str(time.time()),
                },
            )
            return {"status": "done", "count": len(listings)}
        except Exception as e:
            return {"status": "error", "error": str(e)}

    try:
        lambda_client = boto3.client("lambda")
        lambda_client.invoke(
            FunctionName=context.function_name,
            InvocationType="Event",
            Payload=json.dumps({"async_scrape": True}),
        )
        return {
            "statusCode": 202,
            "headers": {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
            },
            "body": json.dumps({"status": "started", "message": "Scrape triggered. Poll data/flatfox-listings.json for results."}),
        }
    except Exception as e:
        return {
            "statusCode": 500,
            "headers": {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
            },
            "body": json.dumps({"error": str(e)}),
        }
