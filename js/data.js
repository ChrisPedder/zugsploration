/**
 * Municipality metadata and rental data management.
 * Coordinates are approximate centres for each municipality.
 */

const OFFICE = { lat: 47.1761, lon: 8.5121, label: "Office — Landis+Gyr-Strasse" };

const MUNICIPALITY_CENTRES = {
  "Zug":                { lat: 47.1724, lon: 8.5170, elevation: 425 },
  "Baar":               { lat: 47.1960, lon: 8.5280, elevation: 443 },
  "Cham":               { lat: 47.1820, lon: 8.4620, elevation: 440 },
  "Steinhausen":        { lat: 47.1950, lon: 8.4880, elevation: 442 },
  "Hünenberg":          { lat: 47.1760, lon: 8.4310, elevation: 445 },
  "Risch":              { lat: 47.1430, lon: 8.4530, elevation: 420 },
  "Rotkreuz":           { lat: 47.1420, lon: 8.4310, elevation: 419 },
  "Menzingen":          { lat: 47.1780, lon: 8.5930, elevation: 800 },
  "Unterägeri":         { lat: 47.1380, lon: 8.5830, elevation: 724 },
  "Oberägeri":          { lat: 47.1300, lon: 8.6200, elevation: 737 },
  "Neuheim":            { lat: 47.2040, lon: 8.5800, elevation: 620 },
  "Walchwil":           { lat: 47.1040, lon: 8.5200, elevation: 500 },
  "Küssnacht (SZ)":    { lat: 47.0860, lon: 8.4400, elevation: 440 },
  "Arth":               { lat: 47.0630, lon: 8.5230, elevation: 423 },
  "Schwyz":             { lat: 47.0210, lon: 8.6530, elevation: 517 },
  "Steinerberg":        { lat: 47.0500, lon: 8.5800, elevation: 590 },
  "Sattel":             { lat: 47.0800, lon: 8.6300, elevation: 790 },
  "Lauerz":             { lat: 47.0350, lon: 8.5850, elevation: 460 },
  "Root":               { lat: 47.1140, lon: 8.3930, elevation: 420 },
  "Gisikon":            { lat: 47.1060, lon: 8.4100, elevation: 413 },
  "Honau":              { lat: 47.1020, lon: 8.4190, elevation: 415 },
  "Meggen":             { lat: 47.0460, lon: 8.3750, elevation: 440 },
  "Adligenswil":        { lat: 47.0680, lon: 8.3610, elevation: 530 },
  "Horw":               { lat: 47.0180, lon: 8.3100, elevation: 436 },
  "Ebikon":             { lat: 47.0800, lon: 8.3400, elevation: 430 },
  "Buchrain":           { lat: 47.0960, lon: 8.3500, elevation: 435 },
  "Dierikon":           { lat: 47.1030, lon: 8.3690, elevation: 430 },
  "Udligenswil":        { lat: 47.0790, lon: 8.3950, elevation: 540 },
  "Meierskappel":       { lat: 47.0990, lon: 8.4350, elevation: 520 },
  "Sins":               { lat: 47.1950, lon: 8.3950, elevation: 400 },
  "Muri (AG)":          { lat: 47.2750, lon: 8.3400, elevation: 460 },
  "Merenschwand":       { lat: 47.2600, lon: 8.3750, elevation: 395 },
  "Dietwil":            { lat: 47.1510, lon: 8.3970, elevation: 410 },
  "Mühlau":             { lat: 47.2310, lon: 8.3930, elevation: 393 },
  "Abtwil":             { lat: 47.1720, lon: 8.4000, elevation: 400 },
  "Oberrüti":           { lat: 47.1580, lon: 8.3760, elevation: 410 },
  "Maschwanden":        { lat: 47.2350, lon: 8.4350, elevation: 400 },
  "Kappel am Albis":    { lat: 47.2280, lon: 8.5300, elevation: 560 },
  "Hausen am Albis":    { lat: 47.2380, lon: 8.5350, elevation: 600 },
  "Affoltern am Albis": { lat: 47.2780, lon: 8.4530, elevation: 494 },
  "Luzern":             { lat: 47.0502, lon: 8.3093, elevation: 436 },
  "Inwil":              { lat: 47.1200, lon: 8.3500, elevation: 415 },
  "Hagendorn":          { lat: 47.1610, lon: 8.4500, elevation: 430 },
};

let rentalData = null;

async function loadRentalData() {
  const resp = await fetch("data/rental-data.json");
  rentalData = await resp.json();
  return rentalData;
}

function getRentalInfo(municipalityName) {
  if (!rentalData) return null;
  return rentalData.municipalities[municipalityName] || null;
}

function getRentColour(median) {
  const minRent = 1000;
  const maxRent = 2400;
  const t = Math.max(0, Math.min(1, (median - minRent) / (maxRent - minRent)));

  // green -> yellow -> red
  let r, g, b;
  if (t < 0.5) {
    const s = t / 0.5;
    r = Math.round(76 + s * (234 - 76));
    g = Math.round(175 + s * (179 - 175));
    b = Math.round(80 + s * (8 - 80));
  } else {
    const s = (t - 0.5) / 0.5;
    r = Math.round(234 + s * (220 - 234));
    g = Math.round(179 - s * (179 - 38));
    b = Math.round(8 + s * (38 - 8));
  }
  return `rgb(${r},${g},${b})`;
}

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function estimateCyclingDistance(lat, lon) {
  const straight = haversineDistance(lat, lon, OFFICE.lat, OFFICE.lon);
  return Math.round(straight * 1.3 * 10) / 10;
}

function estimateCyclingTime(distanceKm, elevationGain) {
  const speed = elevationGain > 200 ? 12 : 15;
  return Math.round(distanceKm / speed * 60);
}

function winterRating(maxElevation, elevationGain) {
  if (maxElevation < 600 && elevationGain < 150) {
    return { label: "Year-round", cssClass: "year-round" };
  }
  return { label: "Seasonal (hilly)", cssClass: "seasonal" };
}
