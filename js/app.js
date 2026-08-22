/**
 * Main application — wires up UI controls and initialises layers.
 */

document.addEventListener("DOMContentLoaded", async () => {
  initMap();
  await Promise.all([loadRentalData(), loadFlatfoxListings()]);
  loadMunicipalities();
  loadCyclingNetwork();
  renderFlatfoxListings();
  setupControls();
});

function setupControls() {
  // Layer toggles
  document.getElementById("toggle-municipalities").addEventListener("change", (e) => {
    if (!municipalityLayer) return;
    e.target.checked ? map.addLayer(municipalityLayer) : map.removeLayer(municipalityLayer);
  });

  document.getElementById("toggle-cycling").addEventListener("change", (e) => {
    if (!cyclingNetworkLayer) return;
    e.target.checked ? map.addLayer(cyclingNetworkLayer) : map.removeLayer(cyclingNetworkLayer);
  });

  document.getElementById("toggle-flatfox").addEventListener("change", (e) => {
    if (!flatfoxLayer) return;
    e.target.checked ? map.addLayer(flatfoxLayer) : map.removeLayer(flatfoxLayer);
  });

  // Filter sliders
  const maxRentSlider = document.getElementById("maxRent");
  const maxRentLabel = document.getElementById("maxRent-value");
  maxRentSlider.addEventListener("input", () => {
    maxRentLabel.textContent = `CHF ${parseInt(maxRentSlider.value).toLocaleString()}`;
    refreshMunicipalityStyles();
  });

  const maxTimeSlider = document.getElementById("maxTime");
  const maxTimeLabel = document.getElementById("maxTime-value");
  maxTimeSlider.addEventListener("input", () => {
    maxTimeLabel.textContent = `${maxTimeSlider.value} min`;
    refreshMunicipalityStyles();
  });

  const maxListingPriceSlider = document.getElementById("maxListingPrice");
  const maxListingPriceLabel = document.getElementById("maxListingPrice-value");
  maxListingPriceSlider.addEventListener("input", () => {
    maxListingPriceLabel.textContent = `CHF ${parseInt(maxListingPriceSlider.value).toLocaleString()}`;
    refreshFlatfoxListings();
  });

  const minRoomsSlider = document.getElementById("minRooms");
  const minRoomsLabel = document.getElementById("minRooms-value");
  minRoomsSlider.addEventListener("input", () => {
    minRoomsLabel.textContent = minRoomsSlider.value;
    refreshFlatfoxListings();
  });

  // Pets filter
  document.querySelectorAll('input[name="petsFilter"]').forEach(radio => {
    radio.addEventListener("change", () => refreshFlatfoxListings());
  });

  // Route profile selector
  document.getElementById("route-profile").addEventListener("change", (e) => {
    currentProfile = e.target.value;
    if (startMarker) {
      const pos = startMarker.getLatLng();
      fetchAndDisplayRoutes(pos.lat, pos.lng);
    }
  });

  // Alt route toggles
  document.getElementById("toggle-alt1").addEventListener("change", (e) => {
    if (routeLayers.alt1) {
      e.target.checked ? map.addLayer(routeLayers.alt1) : map.removeLayer(routeLayers.alt1);
    }
  });

  document.getElementById("toggle-alt2").addEventListener("change", (e) => {
    if (routeLayers.alt2) {
      e.target.checked ? map.addLayer(routeLayers.alt2) : map.removeLayer(routeLayers.alt2);
    }
  });

  // Close route panel
  document.getElementById("close-route-panel").addEventListener("click", () => {
    document.getElementById("route-panel").classList.remove("active");
    clearRoutes();
    if (startMarker) {
      map.removeLayer(startMarker);
      startMarker = null;
    }
  });

  // Scrape fresh Flatfox listings
  document.getElementById("scrape-flatfox").addEventListener("click", async () => {
    const btn = document.getElementById("scrape-flatfox");
    const status = document.getElementById("scrape-status");
    btn.disabled = true;
    btn.textContent = "Fetching...";
    status.textContent = "";
    status.className = "scrape-status";
    try {
      await refreshFlatfoxFromAPI((msg) => { status.textContent = msg; });
      renderFlatfoxListings();
      status.textContent = `${flatfoxListings.length} listings loaded`;
      status.classList.add("success");
    } catch (err) {
      status.textContent = err.message;
      status.classList.add("error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Refresh listings";
    }
  });

  // Export GPX
  document.getElementById("export-gpx").addEventListener("click", () => {
    if (!startMarker) return;
    const pos = startMarker.getLatLng();
    exportGpx(pos.lat, pos.lng, currentProfile).catch(err => {
      alert("GPX export failed: " + err.message);
    });
  });
}

function refreshMunicipalityStyles() {
  if (municipalityLayer && municipalityLayer.eachLayer) {
    municipalityLayer.eachLayer(layer => {
      if (layer.feature) {
        layer.setStyle(featureMunicipalityStyle(layer.feature));
      }
    });
  }
}
