# Zug Bike Commute & Rental Map

Interactive map for finding affordable housing within cycling distance of Zug, Switzerland. Shows municipality boundaries colour-coded by rental cost, with click-to-route cycling directions via BRouter.

## Quick start

1. Serve the project locally (any static file server works):

   ```bash
   python3 -m http.server 8090
   ```

2. Open `http://localhost:8090` in a browser.

## Features

- **Choropleth map** of ~120 municipalities within 20 km of Zug, coloured by median 2-Zimmer-Wohnung rent (green = cheapest, red = most expensive)
- **Click anywhere** on the map to get a cycling route to the office (Landis+Gyr-Strasse) via BRouter
- **Three route alternatives** with distance, time, elevation gain/loss, max elevation, and winter feasibility rating
- **Elevation profile chart** for each route with hover-to-highlight on the map
- **Route profile selector** — quiet roads (safety), balanced (trekking), or fastest (fastbike)
- **Draggable start marker** — drag to recalculate the route in real time
- **Municipality popups** with rent data, estimated commute stats, and a "Route from here" button
- **Filter sliders** for maximum rent and maximum cycling time — municipalities outside your criteria are greyed out
- **Cycling network overlay** (toggle on) showing residential streets, cycleways, paths, and tertiary roads from OSM
- **GPX export** to load routes onto a bike computer

## Refreshing OSM data

The map uses pre-fetched GeoJSON files for fast loading. To refresh:

```bash
python3 scripts/fetch-osm-data.py
```

This queries the Overpass API for municipality boundaries (`admin_level=8`) and the permitted cycling network within 20 km of Zug, saving results to `data/municipalities.geojson` and `data/cycling-network.geojson`. The script includes rate limiting and retries.

## Updating rental data

Edit `data/rental-data.json`. Each municipality entry has `min`, `max`, `median`, and `canton` fields. The `median` value is what the choropleth displays. Replace the placeholder estimates with real figures from Homegate, Comparis, or Wüest Partner.

## Project structure

```
├── index.html              # Main page
├── css/style.css           # All styles
├── js/
│   ├── app.js              # Initialisation and UI controls
│   ├── data.js             # Rental data, municipality centres, colour scale
│   ├── map.js              # Leaflet map, layers, routing display, elevation chart
│   └── routing.js          # BRouter API integration and GPX export
├── data/
│   ├── rental-data.json    # Editable rent estimates per municipality
│   ├── municipalities.geojson  # OSM admin boundaries (fetched)
│   └── cycling-network.geojson # OSM cycling roads (fetched)
└── scripts/
    └── fetch-osm-data.py   # Overpass API data fetcher
```

## Notes

- Distances shown in municipality popups are straight-line × 1.3 estimates. Click-to-route distances from BRouter are accurate.
- Winter feasibility is flagged as "Year-round" when max elevation stays below 600 m and total climb is under 150 m.
- Cycling time assumes 15 km/h average, or 12 km/h when elevation gain exceeds 200 m.
- The cycling network GeoJSON is ~16 MB — toggling it on takes a moment to render.
- BRouter requests are debounced (500 ms) during marker drag to respect the public API.
