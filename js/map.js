/**
 * Leaflet map setup, layers, and interaction logic.
 */

let map;
let municipalityLayer;
let cyclingNetworkLayer;
let flatfoxLayer = null;
let routeLayers = { primary: null, alt1: null, alt2: null };
let startMarker = null;
let officeMarker = null;
let routeHighlightMarker = null;
let currentProfile = "safety";
let currentRouteData = [null, null, null];
let municipalityGeoJSON = null;
let cyclingGeoJSON = null;

function initMap() {
  map = L.map("map", {
    center: [47.1724, 8.5170],
    zoom: 12,
    zoomControl: true,
  });

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors | Routing: <a href="https://brouter.de">BRouter</a>',
    maxZoom: 18,
  }).addTo(map);

  const officeIcon = L.divIcon({
    className: "office-marker",
    html: `<div style="
      background: #1e40af;
      width: 32px; height: 32px;
      border-radius: 50% 50% 50% 0;
      transform: rotate(-45deg);
      border: 3px solid white;
      box-shadow: 0 2px 6px rgba(0,0,0,0.3);
      display: flex; align-items: center; justify-content: center;
    "><span style="transform: rotate(45deg); color: white; font-size: 14px;">&#9873;</span></div>`,
    iconSize: [32, 32],
    iconAnchor: [16, 32],
    popupAnchor: [0, -34],
  });

  map.createPane("flatfoxPane");
  map.getPane("flatfoxPane").style.zIndex = 450;

  officeMarker = L.marker([OFFICE.lat, OFFICE.lon], { icon: officeIcon })
    .addTo(map)
    .bindPopup(`<strong>${OFFICE.label}</strong><br>Destination`);

  map.on("click", onMapClick);
}

async function loadMunicipalities() {
  try {
    const resp = await fetch("data/municipalities.geojson");
    municipalityGeoJSON = await resp.json();
    renderMunicipalities();
  } catch (e) {
    console.warn("Could not load municipalities.geojson — using fallback circles.", e);
    renderFallbackMunicipalities();
  }
}

function renderMunicipalities() {
  if (municipalityLayer) map.removeLayer(municipalityLayer);

  municipalityLayer = L.geoJSON(municipalityGeoJSON, {
    style: featureMunicipalityStyle,
    onEachFeature: (feature, layer) => {
      const name = feature.properties.name;
      layer.on("click", function (e) {
        L.DomEvent.stopPropagation(e);
        const latlng = e.latlng;
        const content = buildMunicipalityPopup(name, latlng);
        L.popup().setLatLng(latlng).setContent(content).openOn(map);
      });
      layer.on("mouseover", function () { this.setStyle({ weight: 3, fillOpacity: 0.7 }); });
      layer.on("mouseout", function () { municipalityLayer.resetStyle(this); });
    },
  }).addTo(map);
}

function renderFallbackMunicipalities() {
  if (municipalityLayer) map.removeLayer(municipalityLayer);

  const group = L.layerGroup();
  for (const [name, info] of Object.entries(MUNICIPALITY_CENTRES)) {
    const rental = getRentalInfo(name);
    const median = rental ? rental.median : 1500;
    const colour = getRentColour(median);

    L.circle([info.lat, info.lon], {
      radius: 800,
      color: colour,
      fillColor: colour,
      fillOpacity: 0.5,
      weight: 2,
    })
      .bindPopup(() => buildMunicipalityPopup(name))
      .bindTooltip(name, { permanent: true, direction: "center", className: "municipality-label" })
      .addTo(group);
  }
  municipalityLayer = group;
  municipalityLayer.addTo(map);
}

function featureMunicipalityStyle(feature) {
  const name = feature.properties.name;
  const rental = getRentalInfo(name);
  const median = rental ? rental.median : null;

  if (median === null) {
    return { color: "#9ca3af", fillColor: "#e5e7eb", fillOpacity: 0.3, weight: 1.5 };
  }

  const colour = getRentColour(median);

  const maxRent = getFilterValue("maxRent");
  const maxTime = getFilterValue("maxTime");

  const centre = MUNICIPALITY_CENTRES[name];
  let greyed = false;
  if (median > maxRent) greyed = true;
  if (centre) {
    const dist = estimateCyclingDistance(centre.lat, centre.lon);
    const time = estimateCyclingTime(dist, Math.abs((centre.elevation || 425) - 425));
    if (time > maxTime) greyed = true;
  }

  return {
    color: greyed ? "#d1d5db" : colour,
    fillColor: greyed ? "#f3f4f6" : colour,
    fillOpacity: greyed ? 0.15 : 0.45,
    weight: greyed ? 1 : 1.5,
  };
}

function buildMunicipalityPopup(name, clickLatLng) {
  const rental = getRentalInfo(name);
  const centre = MUNICIPALITY_CENTRES[name];

  let html = `<h3>${name}</h3><dl class="popup-stats">`;

  if (centre) {
    const dist = estimateCyclingDistance(centre.lat, centre.lon);
    const elevGain = Math.abs((centre.elevation || 425) - 425);
    const time = estimateCyclingTime(dist, elevGain);
    const winter = winterRating(centre.elevation || 425, elevGain);

    html += `<dt>Cycling distance (est.)</dt><dd>${dist} km</dd>`;
    html += `<dt>Cycling time (est.)</dt><dd>${time} min</dd>`;
    html += `<dt>Elevation</dt><dd>${centre.elevation || "—"} m</dd>`;
    html += `<dt>Winter</dt><dd><span class="winter-badge ${winter.cssClass}">${winter.label}</span></dd>`;
  }

  if (rental) {
    html += `<dt>Median 2-room rent</dt><dd>CHF ${rental.median.toLocaleString()}/month</dd>`;
    html += `<dt>Rent range</dt><dd>CHF ${rental.min.toLocaleString()} – ${rental.max.toLocaleString()}</dd>`;
    html += `<dt>Canton</dt><dd>${rental.canton}</dd>`;
  }

  html += `</dl>`;

  const routeLat = clickLatLng ? clickLatLng.lat : (centre ? centre.lat : null);
  const routeLon = clickLatLng ? clickLatLng.lng : (centre ? centre.lon : null);
  if (routeLat !== null) {
    html += `<button class="popup-route-btn" onclick="routeFromPoint(${routeLat}, ${routeLon})">Route from here</button>`;
  }

  return html;
}

async function loadCyclingNetwork() {
  try {
    const resp = await fetch("data/cycling-network.geojson");
    cyclingGeoJSON = await resp.json();
    renderCyclingNetwork();
  } catch (e) {
    console.warn("Could not load cycling-network.geojson. Toggle will be inactive.", e);
  }
}

function renderCyclingNetwork() {
  if (cyclingNetworkLayer) map.removeLayer(cyclingNetworkLayer);

  const highwayColours = {
    cycleway: "#2563eb",
    path: "#7c3aed",
    residential: "#6b7280",
    living_street: "#6b7280",
    service: "#9ca3af",
    tertiary: "#d97706",
    unclassified: "#059669",
    track: "#7c3aed",
  };

  cyclingNetworkLayer = L.geoJSON(cyclingGeoJSON, {
    style: (feature) => {
      const hw = feature.properties.highway || "";
      return {
        color: highwayColours[hw] || "#9ca3af",
        weight: hw === "cycleway" ? 2.5 : 1.5,
        opacity: 0.6,
      };
    },
    onEachFeature: (feature, layer) => {
      const p = feature.properties;
      const parts = [p.highway];
      if (p.name) parts.push(p.name);
      if (p.surface) parts.push(`surface: ${p.surface}`);
      layer.bindTooltip(parts.join(" — "));
    },
  });
}

/* --- Click-to-route --- */

function onMapClick(e) {
  placeStartMarker(e.latlng.lat, e.latlng.lng);
  fetchAndDisplayRoutes(e.latlng.lat, e.latlng.lng);
}

function placeStartMarker(lat, lon) {
  if (startMarker) {
    startMarker.setLatLng([lat, lon]);
  } else {
    startMarker = L.marker([lat, lon], { draggable: true })
      .addTo(map)
      .bindPopup("Drag me or click elsewhere");

    startMarker.on("dragend", () => {
      const pos = startMarker.getLatLng();
      fetchAndDisplayRoutes(pos.lat, pos.lng);
    });
  }
}

function fetchAndDisplayRoutes(lat, lon) {
  showLoading("Calculating route...");

  debouncedFetchRoutes(lat, lon, currentProfile, (err, routes) => {
    hideLoading();
    if (err || !routes) {
      showRoutePanelError("Could not calculate route — try a nearby location or try again shortly.");
      return;
    }
    currentRouteData = routes;
    displayRoutes(routes);
    updateRoutePanel(routes, lat, lon);
  });
}

function displayRoutes(routes) {
  clearRoutes();

  if (routes[0]) {
    routeLayers.primary = L.geoJSON(routes[0], {
      style: { color: "#2563eb", weight: 4, opacity: 0.9 },
    }).addTo(map);
  }

  if (routes[1]) {
    routeLayers.alt1 = L.geoJSON(routes[1], {
      style: { color: "#6b7280", weight: 3, opacity: 0.5, dashArray: "8,6" },
    }).addTo(map);
  }

  if (routes[2]) {
    routeLayers.alt2 = L.geoJSON(routes[2], {
      style: { color: "#6b7280", weight: 3, opacity: 0.5, dashArray: "8,6" },
    }).addTo(map);
  }
}

function clearRoutes() {
  Object.values(routeLayers).forEach(l => { if (l) map.removeLayer(l); });
  routeLayers = { primary: null, alt1: null, alt2: null };
  if (routeHighlightMarker) {
    map.removeLayer(routeHighlightMarker);
    routeHighlightMarker = null;
  }
}

function updateRoutePanel(routes, lat, lon) {
  const panel = document.getElementById("route-panel");
  const primary = routes[0] ? parseRouteStats(routes[0]) : null;

  if (!primary) {
    showRoutePanelError("No route found.");
    return;
  }

  const municipality = findNearestMunicipality(lat, lon);
  const rental = municipality ? getRentalInfo(municipality) : null;

  document.getElementById("route-distance").textContent = primary.distance;
  document.getElementById("route-time").textContent = primary.time;
  document.getElementById("route-elev-gain").textContent = primary.elevGain;
  document.getElementById("route-elev-loss").textContent = primary.elevLoss;
  document.getElementById("route-max-elev").textContent = primary.maxElev;
  document.getElementById("route-profile-name").textContent = BROUTER_PROFILES[currentProfile].label;

  const winterEl = document.getElementById("route-winter");
  winterEl.textContent = primary.winter.label;
  winterEl.className = `winter-badge ${primary.winter.cssClass}`;

  const metaEl = document.getElementById("route-meta");
  let metaHtml = "";
  if (municipality) {
    metaHtml += `<strong>Nearest municipality:</strong> ${municipality}<br>`;
  }
  if (rental) {
    metaHtml += `<strong>Median 2-room rent:</strong> CHF ${rental.median.toLocaleString()}/month`;
  }
  metaEl.innerHTML = metaHtml;

  renderElevationChart(primary.elevProfile, primary.coords);

  const alt1Stats = routes[1] ? parseRouteStats(routes[1]) : null;
  const alt2Stats = routes[2] ? parseRouteStats(routes[2]) : null;
  updateAltRouteLabels(alt1Stats, alt2Stats);

  panel.classList.add("active");
}

function showRoutePanelError(msg) {
  const panel = document.getElementById("route-panel");
  document.getElementById("route-distance").textContent = "—";
  document.getElementById("route-time").textContent = "—";
  document.getElementById("route-elev-gain").textContent = "—";
  document.getElementById("route-elev-loss").textContent = "—";
  document.getElementById("route-max-elev").textContent = "—";
  document.getElementById("route-meta").textContent = msg;
  document.getElementById("route-winter").textContent = "—";
  document.getElementById("route-winter").className = "winter-badge";
  panel.classList.add("active");
}

function updateAltRouteLabels(alt1, alt2) {
  const label1 = document.getElementById("alt1-label");
  const label2 = document.getElementById("alt2-label");
  label1.textContent = alt1 ? `Alternative 1 (${alt1.distance} km, ${alt1.time} min)` : "Alternative 1 (unavailable)";
  label2.textContent = alt2 ? `Alternative 2 (${alt2.distance} km, ${alt2.time} min)` : "Alternative 2 (unavailable)";
}

function findNearestMunicipality(lat, lon) {
  let nearest = null;
  let minDist = Infinity;
  for (const [name, info] of Object.entries(MUNICIPALITY_CENTRES)) {
    const d = haversineDistance(lat, lon, info.lat, info.lon);
    if (d < minDist) {
      minDist = d;
      nearest = name;
    }
  }
  return nearest;
}

/* --- Elevation chart --- */

function renderElevationChart(profile, coords) {
  const container = document.getElementById("elevation-chart");
  container.innerHTML = "";

  if (!profile || profile.length < 2) return;

  const width = 300;
  const height = 120;
  const padL = 35;
  const padR = 5;
  const padT = 10;
  const padB = 20;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const maxDist = profile[profile.length - 1].dist;
  const elevs = profile.map(p => p.elev);
  const minE = Math.min(...elevs) - 10;
  const maxE = Math.max(...elevs) + 10;

  const xScale = d => padL + (d / maxDist) * plotW;
  const yScale = e => padT + plotH - ((e - minE) / (maxE - minE)) * plotH;

  let pathD = `M ${xScale(profile[0].dist)} ${yScale(profile[0].elev)}`;
  for (let i = 1; i < profile.length; i += Math.max(1, Math.floor(profile.length / 200))) {
    pathD += ` L ${xScale(profile[i].dist)} ${yScale(profile[i].elev)}`;
  }
  const last = profile[profile.length - 1];
  pathD += ` L ${xScale(last.dist)} ${yScale(last.elev)}`;

  const fillD = pathD + ` L ${xScale(last.dist)} ${padT + plotH} L ${padL} ${padT + plotH} Z`;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", height);

  svg.innerHTML = `
    <rect x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="#f9fafb" />
    <path d="${fillD}" fill="rgba(37,99,235,0.15)" />
    <path d="${pathD}" fill="none" stroke="#2563eb" stroke-width="1.5" />
    <text x="${padL - 4}" y="${padT + 4}" text-anchor="end" font-size="9" fill="#6b7280">${Math.round(maxE)}m</text>
    <text x="${padL - 4}" y="${padT + plotH}" text-anchor="end" font-size="9" fill="#6b7280">${Math.round(minE)}m</text>
    <text x="${padL}" y="${height - 2}" font-size="9" fill="#6b7280">0 km</text>
    <text x="${padL + plotW}" y="${height - 2}" text-anchor="end" font-size="9" fill="#6b7280">${maxDist.toFixed(1)} km</text>
    <line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="#d1d5db" stroke-width="0.5" />
    <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" stroke="#d1d5db" stroke-width="0.5" />
    <rect class="elev-hover-zone" x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="transparent" />
  `;

  container.appendChild(svg);

  const hoverZone = svg.querySelector(".elev-hover-zone");
  hoverZone.addEventListener("mousemove", (e) => {
    const rect = svg.getBoundingClientRect();
    const svgX = (e.clientX - rect.left) / rect.width * width;
    const dist = ((svgX - padL) / plotW) * maxDist;

    let closest = profile[0];
    for (const p of profile) {
      if (Math.abs(p.dist - dist) < Math.abs(closest.dist - dist)) closest = p;
    }

    const idx = profile.indexOf(closest);
    if (idx >= 0 && idx < coords.length) {
      highlightRoutePoint(coords[idx][1], coords[idx][0], closest.elev, closest.dist);
    }
  });

  hoverZone.addEventListener("mouseleave", () => {
    if (routeHighlightMarker) {
      map.removeLayer(routeHighlightMarker);
      routeHighlightMarker = null;
    }
  });
}

function highlightRoutePoint(lat, lon, elev, dist) {
  if (routeHighlightMarker) {
    routeHighlightMarker.setLatLng([lat, lon]);
    routeHighlightMarker.setTooltipContent(`${Math.round(elev)}m at ${dist.toFixed(1)}km`);
  } else {
    routeHighlightMarker = L.circleMarker([lat, lon], {
      radius: 6,
      color: "#2563eb",
      fillColor: "#fff",
      fillOpacity: 1,
      weight: 2,
    })
      .addTo(map)
      .bindTooltip(`${Math.round(elev)}m at ${dist.toFixed(1)}km`, { permanent: true, direction: "top" });
  }
}

/* --- Flatfox listings layer --- */

function renderFlatfoxListings() {
  if (flatfoxLayer) map.removeLayer(flatfoxLayer);
  if (!flatfoxListings || flatfoxListings.length === 0) return;

  const maxPrice = getFilterValue("maxListingPrice");
  const minRooms = getFilterFloat("minRooms");
  const petsFilter = document.querySelector('input[name="petsFilter"]:checked');
  const requirePets = petsFilter && petsFilter.value === "yes";
  const group = L.layerGroup();
  let shown = 0;

  for (const listing of flatfoxListings) {
    if (listing.price === null) continue;
    if (listing.price > maxPrice) continue;
    if (minRooms > 1 && (listing.rooms == null || listing.rooms < minRooms)) continue;
    if (requirePets && !listing.pets_allowed) continue;

    const colour = getRentColour(listing.price);

    const marker = L.circleMarker([listing.lat, listing.lon], {
      radius: 7,
      color: "#fff",
      weight: 1.5,
      fillColor: colour,
      fillOpacity: 0.85,
      pane: "flatfoxPane",
    });

    marker.on("click", function (e) {
      L.DomEvent.stopPropagation(e);
      const content = buildListingPopup(listing);
      L.popup().setLatLng([listing.lat, listing.lon]).setContent(content).openOn(map);
    });

    const tipParts = [`CHF ${listing.price.toLocaleString()}/mo`];
    if (listing.rooms != null) tipParts.push(`${listing.rooms} rm`);
    marker.bindTooltip(tipParts.join(" · "), {
      direction: "top",
      offset: [0, -6],
    });

    marker.addTo(group);
  }

  flatfoxLayer = group;
  if (document.getElementById("toggle-flatfox").checked) {
    flatfoxLayer.addTo(map);
  }
}

function buildListingPopup(listing) {
  let html = `<h3>CHF ${listing.price.toLocaleString()}/month</h3>`;
  html += `<dl class="popup-stats">`;

  if (listing.rooms != null) {
    html += `<dt>Rooms</dt><dd>${listing.rooms}</dd>`;
  }
  if (listing.surface != null) {
    html += `<dt>Area</dt><dd>${listing.surface} m&sup2;</dd>`;
  }
  if (listing.address || listing.city) {
    const addr = [listing.address, listing.city].filter(Boolean).join(", ");
    html += `<dt>Address</dt><dd>${addr}</dd>`;
  }
  html += `<dt>Pets allowed</dt><dd>${listing.pets_allowed ? "Yes" : "No"}</dd>`;

  const municipality = findNearestMunicipality(listing.lat, listing.lon);
  const dist = estimateCyclingDistance(listing.lat, listing.lon);
  const centre = municipality ? MUNICIPALITY_CENTRES[municipality] : null;
  const elevGain = centre ? Math.abs((centre.elevation || 425) - 425) : 0;
  const time = estimateCyclingTime(dist, elevGain);
  html += `<dt>Cycling distance (est.)</dt><dd>${dist} km</dd>`;
  html += `<dt>Cycling time (est.)</dt><dd>${time} min</dd>`;

  html += `</dl>`;
  html += `<a href="${listing.url}" target="_blank" rel="noopener" class="popup-link-btn">View on Flatfox</a> `;
  html += `<button class="popup-route-btn" onclick="routeFromPoint(${listing.lat}, ${listing.lon})">Route to office</button>`;

  return html;
}

function refreshFlatfoxListings() {
  if (flatfoxLayer) map.removeLayer(flatfoxLayer);
  renderFlatfoxListings();
}

/* --- Helpers --- */

function routeFromPoint(lat, lon) {
  map.closePopup();
  placeStartMarker(lat, lon);
  fetchAndDisplayRoutes(lat, lon);
}

function getFilterValue(id) {
  const el = document.getElementById(id);
  return el ? parseInt(el.value, 10) : Infinity;
}

function getFilterFloat(id) {
  const el = document.getElementById(id);
  return el ? parseFloat(el.value) : 0;
}

function showLoading(msg) {
  const el = document.getElementById("loading");
  el.querySelector("span").textContent = msg;
  el.classList.add("active");
}

function hideLoading() {
  document.getElementById("loading").classList.remove("active");
}
