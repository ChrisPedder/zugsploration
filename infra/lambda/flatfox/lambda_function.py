import json
import urllib.request
import urllib.parse

FLATFOX_PIN_URL = "https://flatfox.ch/api/v1/pin/"
BBOX = {"north": 47.30, "south": 47.00, "east": 8.70, "west": 8.25}


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

        listings = []
        for pin in raw:
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
                "price_unit": pin.get("price_unit", ""),
            }

            if price is not None:
                try:
                    listing["price"] = int(float(price))
                except (ValueError, TypeError):
                    listing["price"] = None
            else:
                listing["price"] = None

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
