#!/usr/bin/env python3
"""
Development server that serves static files and proxies Flatfox API requests
to avoid CORS issues.

Usage:
    python scripts/server.py [--port 8080]
"""

import argparse
import json
import urllib.request
import urllib.parse
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent

FLATFOX_PIN_URL = "https://flatfox.ch/api/v1/pin/"
BBOX = {"north": 47.30, "south": 47.00, "east": 8.70, "west": 8.25}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PROJECT_ROOT), **kwargs)

    def do_GET(self):
        if self.path.startswith("/api/flatfox"):
            self.handle_flatfox_proxy()
        else:
            super().do_GET()

    def handle_flatfox_proxy(self):
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
                    "url": f"https://flatfox.ch/en/flat/{pk}/",
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

            body = json.dumps({"count": len(listings), "listings": listings}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", len(body))
            self.end_headers()
            self.wfile.write(body)

        except Exception as e:
            body = json.dumps({"error": str(e)}).encode("utf-8")
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", len(body))
            self.end_headers()
            self.wfile.write(body)


def main():
    parser = argparse.ArgumentParser(description="Zug Commute Map dev server")
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()

    server = HTTPServer(("", args.port), Handler)
    print(f"Serving at http://localhost:{args.port}")
    print(f"Flatfox proxy at http://localhost:{args.port}/api/flatfox")
    print("Press Ctrl+C to stop.")
    server.serve_forever()


if __name__ == "__main__":
    main()
