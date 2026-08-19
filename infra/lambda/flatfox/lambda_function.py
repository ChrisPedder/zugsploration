import json
import time
import urllib.request
import urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed

FLATFOX_PIN_URL = "https://flatfox.ch/api/v1/pin/"
FLATFOX_DETAIL_URL = "https://flatfox.ch/api/v1/public-listing/"
BBOX = {"north": 47.30, "south": 47.00, "east": 8.70, "west": 8.25}

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


def handler(event, context):
    params = {
        "north": BBOX["north"],
        "south": BBOX["south"],
        "east": BBOX["east"],
        "west": BBOX["west"],
        "object_category": "APARTMENT",
        "offer_type": "RENT",
        "count": 500,
    }

    url = FLATFOX_PIN_URL + "?" + urllib.parse.urlencode(params)

    try:
        req = urllib.request.Request(url)
        req.add_header("User-Agent", "ZugCommutePlanner/1.0")
        req.add_header("Accept", "application/json")

        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = json.loads(resp.read().decode("utf-8"))

        pins = []
        for pin in raw:
            lat = pin.get("latitude")
            lon = pin.get("longitude")
            pk = pin.get("pk")
            price = pin.get("price_display")
            if lat is None or lon is None or pk is None:
                continue
            pins.append({"pk": pk, "lat": lat, "lon": lon, "price": price, "price_unit": pin.get("price_unit", "")})

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

        return {
            "statusCode": 200,
            "headers": {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
            },
            "body": json.dumps({"count": len(listings), "listings": listings}),
        }

    except Exception as e:
        return {
            "statusCode": 502,
            "headers": {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
            },
            "body": json.dumps({"error": str(e)}),
        }
