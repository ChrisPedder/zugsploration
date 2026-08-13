/**
 * BRouter integration for cycling route calculation.
 */

const BROUTER_BASE = "https://brouter.de/brouter";

const BROUTER_PROFILES = {
  safety:   { label: "Quiet roads", description: "Avoids main roads, prefers residential streets and cycle paths" },
  trekking: { label: "Balanced",    description: "Balances speed with comfort, uses minor roads where practical" },
  fastbike: { label: "Fastest",     description: "Prefers direct paved routes, may include busier roads" },
};

let routeDebounceTimer = null;

function buildBRouterUrl(startLon, startLat, endLon, endLat, profile, altIdx, format) {
  return `${BROUTER_BASE}?lonlats=${startLon},${startLat}|${endLon},${endLat}` +
         `&profile=${profile}&alternativeidx=${altIdx}&format=${format}`;
}

async function fetchRoute(startLat, startLon, profile, altIdx = 0) {
  const url = buildBRouterUrl(
    startLon.toFixed(6), startLat.toFixed(6),
    OFFICE.lon.toFixed(6), OFFICE.lat.toFixed(6),
    profile, altIdx, "geojson"
  );

  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`BRouter returned ${resp.status}`);
  }
  return resp.json();
}

async function fetchAllRoutes(startLat, startLon, profile) {
  const results = await Promise.allSettled([
    fetchRoute(startLat, startLon, profile, 0),
    fetchRoute(startLat, startLon, profile, 1),
    fetchRoute(startLat, startLon, profile, 2),
  ]);

  return results.map(r => r.status === "fulfilled" ? r.value : null);
}

function parseRouteStats(geojson) {
  if (!geojson || !geojson.features || geojson.features.length === 0) return null;

  const feature = geojson.features[0];
  const coords = feature.geometry.coordinates;
  const props = feature.properties || {};

  let totalDistance = 0;
  let elevGain = 0;
  let elevLoss = 0;
  let maxElev = -Infinity;
  let minElev = Infinity;
  const elevProfile = [];
  let cumulDist = 0;

  for (let i = 0; i < coords.length; i++) {
    const elev = coords[i][2] || 0;
    if (elev > maxElev) maxElev = elev;
    if (elev < minElev) minElev = elev;

    if (i > 0) {
      const segDist = haversineDistance(
        coords[i - 1][1], coords[i - 1][0],
        coords[i][1], coords[i][0]
      );
      totalDistance += segDist;
      cumulDist += segDist;

      const prevElev = coords[i - 1][2] || 0;
      const diff = elev - prevElev;
      if (diff > 0) elevGain += diff;
      else elevLoss += Math.abs(diff);
    }

    elevProfile.push({ dist: cumulDist, elev: elev });
  }

  if (props["track-length"]) {
    totalDistance = parseFloat(props["track-length"]) / 1000;
  }

  const speed = elevGain > 200 ? 12 : 15;
  const timeMin = Math.round(totalDistance / speed * 60);

  const winter = winterRating(maxElev, elevGain);

  return {
    distance: Math.round(totalDistance * 10) / 10,
    time: timeMin,
    elevGain: Math.round(elevGain),
    elevLoss: Math.round(elevLoss),
    maxElev: Math.round(maxElev),
    minElev: Math.round(minElev),
    winter,
    elevProfile,
    coords,
  };
}

function debouncedFetchRoutes(startLat, startLon, profile, callback) {
  clearTimeout(routeDebounceTimer);
  routeDebounceTimer = setTimeout(async () => {
    try {
      const routes = await fetchAllRoutes(startLat, startLon, profile);
      callback(null, routes);
    } catch (err) {
      callback(err, null);
    }
  }, 500);
}

async function exportGpx(startLat, startLon, profile) {
  const url = buildBRouterUrl(
    startLon.toFixed(6), startLat.toFixed(6),
    OFFICE.lon.toFixed(6), OFFICE.lat.toFixed(6),
    profile, 0, "gpx"
  );

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`GPX export failed: ${resp.status}`);
  const gpxText = await resp.text();

  const blob = new Blob([gpxText], { type: "application/gpx+xml" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `commute-route-${profile}.gpx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(a.href);
}
