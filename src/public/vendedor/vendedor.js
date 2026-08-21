/* Mapa comercial: solo cajas NAP y ubicación del vendedor. */

let map;
let naps = [];
let napCluster;
let baseLayers = {};
let activeLayer = 'hybrid';
let sellerPosition = null;
let sellerMarker = null;
let searchCircle = null;
let closestNapId = null;
let pickLocationMode = false;
let rulerEnabled = false;
let rulerPoints = [];
let rulerLines = [];
let rulerMarkers = [];
let markerByNapId = new Map();

const els = {};

document.addEventListener('DOMContentLoaded', () => {
  Object.assign(els, {
    sidebar: document.querySelector('.sales-sidebar'),
    locate: document.getElementById('btn-locate'),
    pick: document.getElementById('btn-pick-location'),
    locationStatus: document.getElementById('location-status'),
    locationHelp: document.getElementById('location-help'),
    radius: document.getElementById('search-radius'),
    nearbySummary: document.getElementById('nearby-summary'),
    nearbyList: document.getElementById('nearby-list'),
    locatedCount: document.getElementById('located-count'),
    search: document.getElementById('nap-search'),
    clearSearch: document.getElementById('clear-search'),
    searchResults: document.getElementById('nap-search-results'),
    showAll: document.getElementById('btn-show-all'),
    ruler: document.getElementById('btn-ruler'),
    rulerInfo: document.getElementById('ruler-info'),
    rulerDistance: document.getElementById('ruler-distance'),
    clearRuler: document.getElementById('btn-clear-ruler'),
    closeRuler: document.getElementById('btn-close-ruler'),
    layers: document.getElementById('btn-layers'),
    layerOptions: document.getElementById('layer-options'),
    mobileToggle: document.getElementById('mobile-panel-toggle')
  });

  initialiseMap();
  registerControls();
  loadNaps();
});

function initialiseMap() {
  map = L.map('map', { zoomControl: false, preferCanvas: true }).setView([-2.9001, -79.0059], 12);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  L.control.scale({ position: 'bottomleft', imperial: false }).addTo(map);

  baseLayers = {
    hybrid: L.tileLayer('https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', {
      attribution: '&copy; Google Maps', maxZoom: 20
    }),
    streets: L.tileLayer('https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', {
      attribution: '&copy; Google Maps', maxZoom: 20
    }),
    dark: L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OpenStreetMap contributors &copy; CARTO', maxZoom: 20
    }),
    osm: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors', maxZoom: 19
    })
  };
  const savedLayer = localStorage.getItem('seller_map_layer');
  activeLayer = baseLayers[savedLayer] ? savedLayer : 'hybrid';
  baseLayers[activeLayer].addTo(map);

  napCluster = L.markerClusterGroup({
    maxClusterRadius: 48,
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
    chunkedLoading: true
  }).addTo(map);

  map.on('click', handleMapClick);
}

function registerControls() {
  els.locate.addEventListener('click', requestGpsLocation);
  els.pick.addEventListener('click', togglePickLocation);
  els.radius.addEventListener('change', updateNearbyResults);
  els.search.addEventListener('input', renderSearchResults);
  els.clearSearch.addEventListener('click', () => {
    els.search.value = '';
    renderSearchResults();
    els.search.focus();
  });
  els.showAll.addEventListener('click', fitAllNaps);
  els.ruler.addEventListener('click', toggleRuler);
  els.clearRuler.addEventListener('click', clearRuler);
  els.closeRuler.addEventListener('click', disableRuler);
  els.layers.addEventListener('click', () => {
    const willOpen = els.layerOptions.hidden;
    els.layerOptions.hidden = !willOpen;
    els.layers.setAttribute('aria-expanded', String(willOpen));
  });
  els.layerOptions.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-layer]');
    if (button) setBaseLayer(button.dataset.layer);
  });
  els.mobileToggle.addEventListener('click', () => {
    const collapsed = els.sidebar.classList.toggle('collapsed');
    els.mobileToggle.setAttribute('aria-expanded', String(!collapsed));
    window.setTimeout(() => map.invalidateSize(), 260);
  });
}

async function loadNaps() {
  setLocatedCount('Cargando');
  try {
    const response = await fetch('/webhook/sales/naps', { cache: 'no-store' });
    if (!response.ok) throw new Error(`No se pudieron cargar las NAPs (${response.status})`);
    const payload = await response.json();
    naps = Array.isArray(payload.naps) ? payload.naps.filter(hasCoordinates) : [];
    drawNapMarkers();
    setLocatedCount(`${naps.length} NAP`);
    fitAllNaps();
  } catch (error) {
    console.error('NAP seller map:', error);
    setLocatedCount('Sin conexión');
    els.nearbySummary.textContent = 'No se pudieron cargar las ubicaciones de las NAP.';
  }
}

function hasCoordinates(nap) {
  return Number.isFinite(Number(nap?.latitude)) && Number.isFinite(Number(nap?.longitude));
}

function drawNapMarkers() {
  napCluster.clearLayers();
  markerByNapId = new Map();
  naps.forEach((nap) => {
    const marker = L.marker([nap.latitude, nap.longitude], { icon: makeNapIcon(nap.id === closestNapId) });
    marker.bindPopup(() => makeNapPopup(nap));
    marker.on('click', () => markClosest(nap.id, false));
    markerByNapId.set(nap.id, marker);
    napCluster.addLayer(marker);
  });
  renderSearchResults();
}

function makeNapIcon(isClosest = false) {
  return L.divIcon({
    className: `seller-nap-marker${isClosest ? ' closest' : ''}`,
    html: '<div><i class="fa-solid fa-box-archive"></i></div>',
    iconSize: [33, 33],
    iconAnchor: [16, 31],
    popupAnchor: [0, -28]
  });
}

function makeNapPopup(nap) {
  const distance = sellerPosition ? formatDistance(map.distance(sellerPosition, [nap.latitude, nap.longitude])) : null;
  const directions = `https://www.google.com/maps/dir/?api=1&destination=${nap.latitude},${nap.longitude}`;
  return `
    <div class="nap-popup-title"><i class="fa-solid fa-box-archive"></i> ${escapeHtml(nap.name)}</div>
    <p class="nap-popup-text">${distance ? `A <strong>${distance}</strong> de tu ubicación.` : 'Caja NAP disponible en esta ubicación.'}</p>
    <a class="nap-popup-link" href="${directions}" target="_blank" rel="noopener"><i class="fa-solid fa-diamond-turn-right"></i> Cómo llegar</a>
  `;
}

function requestGpsLocation() {
  if (!navigator.geolocation) {
    setLocationMessage('Este dispositivo no permite GPS. Usa “Elegir en mapa”.', 'error');
    return;
  }
  els.locate.disabled = true;
  els.locate.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Buscando GPS';
  setLocationMessage('Buscando tu ubicación…', 'loading');
  navigator.geolocation.getCurrentPosition(
    (position) => {
      setSellerPosition([position.coords.latitude, position.coords.longitude], 'GPS actual');
      els.locate.disabled = false;
      els.locate.innerHTML = '<i class="fa-solid fa-crosshairs"></i> Actualizar GPS';
    },
    (error) => {
      console.warn('Seller GPS error:', error.message);
      setLocationMessage('No se pudo usar el GPS. Selecciona el punto en el mapa.', 'error');
      els.locate.disabled = false;
      els.locate.innerHTML = '<i class="fa-solid fa-crosshairs"></i> Usar mi GPS';
    },
    { enableHighAccuracy: true, timeout: 12_000, maximumAge: 30_000 }
  );
}

function togglePickLocation() {
  pickLocationMode = !pickLocationMode;
  if (pickLocationMode) disableRuler();
  els.pick.classList.toggle('active', pickLocationMode);
  els.pick.innerHTML = pickLocationMode
    ? '<i class="fa-solid fa-xmark"></i> Cancelar punto'
    : '<i class="fa-solid fa-hand-pointer"></i> Elegir en mapa';
  map.getContainer().style.cursor = pickLocationMode ? 'crosshair' : '';
  if (pickLocationMode) setLocationMessage('Toca el mapa en el lugar donde está el vendedor.', 'loading');
}

function handleMapClick(event) {
  if (pickLocationMode) {
    setSellerPosition(event.latlng, 'Punto elegido en mapa');
    togglePickLocation();
    return;
  }
  if (rulerEnabled) addRulerPoint(event.latlng);
}

function setSellerPosition(latlng, sourceLabel) {
  sellerPosition = L.latLng(latlng);
  const userIcon = L.divIcon({
    className: 'seller-location-marker', html: '<div></div>', iconSize: [20, 20], iconAnchor: [10, 10]
  });
  if (sellerMarker) sellerMarker.setLatLng(sellerPosition);
  else sellerMarker = L.marker(sellerPosition, { icon: userIcon, zIndexOffset: 900 }).addTo(map).bindTooltip('Ubicación del vendedor', { direction: 'top' });

  if (searchCircle) searchCircle.setLatLng(sellerPosition);
  else searchCircle = L.circle(sellerPosition, {
    radius: Number(els.radius.value), color: '#38bdf8', weight: 2, fillColor: '#38bdf8', fillOpacity: 0.08, interactive: false
  }).addTo(map);
  searchCircle.setRadius(Number(els.radius.value));

  setLocationMessage(`${sourceLabel} confirmada. Calculando NAPs cercanas…`, 'ready');
  map.flyTo(sellerPosition, Math.max(map.getZoom(), 15), { animate: true, duration: .7 });
  updateNearbyResults();
}

function updateNearbyResults() {
  if (!sellerPosition) return;
  const radius = Number(els.radius.value);
  if (searchCircle) searchCircle.setRadius(radius);
  const ranked = naps
    .map((nap) => ({ ...nap, distance: map.distance(sellerPosition, [nap.latitude, nap.longitude]) }))
    .sort((a, b) => a.distance - b.distance);
  const closest = ranked[0];
  markClosest(closest?.id, false);
  const inside = ranked.filter((nap) => nap.distance <= radius).slice(0, 10);

  els.nearbyList.replaceChildren();
  if (!closest) {
    els.nearbySummary.textContent = 'No existen NAPs con coordenadas disponibles.';
    return;
  }
  const summary = inside.length
    ? `<strong>NAP más cercana: ${escapeHtml(closest.name)}</strong> a ${formatDistance(closest.distance)}. ${inside.length} dentro de ${formatDistance(radius)}.`
    : `<strong>NAP más cercana: ${escapeHtml(closest.name)}</strong> a ${formatDistance(closest.distance)}. No hay NAP dentro de ${formatDistance(radius)}.`;
  els.nearbySummary.innerHTML = summary;

  const results = inside.length ? inside : [closest];
  results.forEach((nap, index) => els.nearbyList.appendChild(makeNearbyEntry(nap, index + 1)));
}

function makeNearbyEntry(nap, rank) {
  const item = document.createElement('li');
  item.className = 'nearby-entry';
  item.tabIndex = 0;
  item.innerHTML = `
    <span class="nearby-rank">${rank}</span>
    <span class="nearby-content"><span class="nearby-name">${escapeHtml(nap.name)}</span><span class="nearby-distance">${formatDistance(nap.distance)}</span></span>
    <a class="nearby-nav" href="https://www.google.com/maps/dir/?api=1&destination=${nap.latitude},${nap.longitude}" target="_blank" rel="noopener" title="Cómo llegar"><i class="fa-solid fa-diamond-turn-right"></i></a>`;
  const openNap = (event) => {
    if (event.target.closest('a')) return;
    focusNap(nap, true);
  };
  item.addEventListener('click', openNap);
  item.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') openNap(event); });
  return item;
}

function markClosest(napId, openPopup) {
  if (closestNapId === napId && !openPopup) return;
  const previous = markerByNapId.get(closestNapId);
  if (previous) previous.setIcon(makeNapIcon(false));
  closestNapId = napId || null;
  const marker = markerByNapId.get(closestNapId);
  if (marker) {
    marker.setIcon(makeNapIcon(true));
    if (openPopup) marker.openPopup();
  }
}

function focusNap(nap, openPopup = true) {
  markClosest(nap.id, false);
  map.flyTo([nap.latitude, nap.longitude], 17, { animate: true, duration: .65 });
  const marker = markerByNapId.get(nap.id);
  if (openPopup && marker) window.setTimeout(() => marker.openPopup(), 700);
}

function renderSearchResults() {
  const query = els.search?.value.trim().toLocaleLowerCase('es') || '';
  els.clearSearch.hidden = !query;
  els.searchResults.replaceChildren();
  if (!query) return;
  const matches = naps.filter((nap) => nap.name.toLocaleLowerCase('es').includes(query)).slice(0, 8);
  if (matches.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'search-empty';
    empty.textContent = 'No se encontró una caja NAP con ese código.';
    els.searchResults.appendChild(empty);
    return;
  }
  matches.forEach((nap) => {
    const item = document.createElement('li');
    item.className = 'search-result';
    item.textContent = nap.name;
    item.addEventListener('click', () => focusNap(nap));
    els.searchResults.appendChild(item);
  });
}

function fitAllNaps() {
  if (naps.length === 0) return;
  map.fitBounds(naps.map((nap) => [nap.latitude, nap.longitude]), { padding: [45, 45], maxZoom: 14, animate: true });
}

function setBaseLayer(layerName) {
  if (!baseLayers[layerName] || layerName === activeLayer) {
    els.layerOptions.hidden = true;
    return;
  }
  map.removeLayer(baseLayers[activeLayer]);
  activeLayer = layerName;
  baseLayers[activeLayer].addTo(map);
  localStorage.setItem('seller_map_layer', activeLayer);
  els.layerOptions.querySelectorAll('button').forEach((button) => button.classList.toggle('active', button.dataset.layer === activeLayer));
  els.layerOptions.hidden = true;
  els.layers.setAttribute('aria-expanded', 'false');
}

function toggleRuler() {
  rulerEnabled = !rulerEnabled;
  if (rulerEnabled && pickLocationMode) togglePickLocation();
  els.ruler.classList.toggle('active', rulerEnabled);
  els.rulerInfo.hidden = !rulerEnabled;
  map.getContainer().style.cursor = rulerEnabled ? 'crosshair' : '';
}

function disableRuler() {
  rulerEnabled = false;
  els.ruler.classList.remove('active');
  els.rulerInfo.hidden = true;
  map.getContainer().style.cursor = '';
}

function addRulerPoint(latlng) {
  const current = L.latLng(latlng);
  rulerPoints.push(current);
  const marker = L.marker(current, {
    icon: L.divIcon({ className: 'ruler-point', html: String(rulerPoints.length), iconSize: [20, 20], iconAnchor: [10, 10] }),
    interactive: false
  }).addTo(map);
  rulerMarkers.push(marker);
  if (rulerPoints.length > 1) {
    const previous = rulerPoints[rulerPoints.length - 2];
    const line = L.polyline([previous, current], { color: '#fbbf24', weight: 3, dashArray: '7 5' }).addTo(map);
    rulerLines.push(line);
  }
  const total = rulerPoints.slice(1).reduce((sum, point, index) => sum + rulerPoints[index].distanceTo(point), 0);
  els.rulerDistance.textContent = formatDistance(total);
}

function clearRuler() {
  rulerMarkers.forEach((marker) => map.removeLayer(marker));
  rulerLines.forEach((line) => map.removeLayer(line));
  rulerPoints = [];
  rulerMarkers = [];
  rulerLines = [];
  els.rulerDistance.textContent = '0 m';
}

function setLocationMessage(message, state) {
  els.locationHelp.textContent = message;
  els.locationStatus.textContent = state === 'ready' ? 'Ubicación lista' : state === 'loading' ? 'Ubicando…' : 'Revisar GPS';
  els.locationStatus.className = `status-chip${state === 'ready' ? ' ready' : state === 'loading' ? ' loading' : ''}`;
}

function setLocatedCount(value) { els.locatedCount.textContent = value; }

function formatDistance(meters) {
  return meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(meters < 10_000 ? 2 : 1)} km`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[character]));
}
