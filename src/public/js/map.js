// Real-Time Interactive NAP Map Client Logic

let map;
let napsData = [];
let markers = {}; // Maps NAP name -> Leaflet marker object
let socket;
let userMarker = null; // Pulsing GPS user location marker
let activeStatusFilter = null;

let darkLayer;
let googleSatelliteLayer;

// History State
let historyData = [];
let activeHistoryFilter = 'all';
let historySearchQuery = '';

// Color mapping based on status
const statusColors = {
  online: '#10B981',   // Green
  partial: '#F59E0B',  // Yellow/Amber
  offline: '#EF4444'   // Red
};

document.addEventListener('DOMContentLoaded', () => {
  initMap();
  loadNapsData();
  setupWebSocket();
  setupSearch();
  setupStatsFilter();
  setupHistoryDrawer();
  loadHistoryData();
  
  // Attach cancel manual placement handler
  document.getElementById('cancel-placement').addEventListener('click', stopManualPlacement);

  // Import coordinates modal listeners
  const importModal = document.getElementById('import-modal');
  document.getElementById('btn-import-trigger').addEventListener('click', () => {
    // Reset modal inputs and preview
    document.getElementById('file-input').value = '';
    document.getElementById('import-preview').classList.add('hidden');
    document.getElementById('btn-apply-import').disabled = true;
    pendingImportUpdates = [];
    importModal.classList.remove('hidden');
  });

  const closeModal = () => importModal.classList.add('hidden');
  document.getElementById('btn-close-modal').addEventListener('click', closeModal);
  document.getElementById('btn-cancel-import').addEventListener('click', closeModal);

  // Apply bulk import handler
  document.getElementById('btn-apply-import').addEventListener('click', applyBulkImport);

  // Setup file drag and drop
  setupFileImport();
});

/**
 * Initialize the Leaflet map with a premium dark mode layer and Google Satellite Earth layer.
 */
function initMap() {
  // Default center at [0,0] (will auto-adjust when data is loaded)
  map = L.map('map').setView([0, 0], 2);

  // CartoDB Positron Dark theme tiles
  darkLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 20
  });

  // Google Satellite/Hybrid (Google Earth style with street names)
  googleSatelliteLayer = L.tileLayer('https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', {
    attribution: '&copy; Google Maps',
    maxZoom: 20
  });

  // Add default dark theme
  darkLayer.addTo(map);

  // Layer control toggle (top-right switcher)
  const baseMaps = {
    "Mapa Oscuro": darkLayer,
    "Google Earth Satélite": googleSatelliteLayer
  };
  L.control.layers(baseMaps, null, { position: 'topright' }).addTo(map);

  // Add Scale Control (bottom-left)
  L.control.scale({ position: 'bottomleft' }).addTo(map);

  // Attach click listener to GPS geolocation button
  document.getElementById('btn-geolocation').addEventListener('click', locateUser);
}

/**
 * Geolocate the user and plot their position on the map.
 */
function locateUser() {
  if (!navigator.geolocation) {
    alert("Tu navegador no soporta geolocalización de GPS.");
    return;
  }

  const geoButton = document.getElementById('btn-geolocation');
  geoButton.style.color = '#F59E0B'; // Amber while loading
  const icon = geoButton.querySelector('i');
  icon.className = 'fa-solid fa-spinner fa-spin';

  navigator.geolocation.getCurrentPosition(
    (position) => {
      const lat = position.coords.latitude;
      const lng = position.coords.longitude;

      console.log(`📡 User located at [${lat}, ${lng}]`);

      // Reset button icon
      geoButton.style.color = '';
      icon.className = 'fa-solid fa-crosshairs';

      // Plot user marker
      const userGpsIcon = L.divIcon({
        className: 'user-location-marker',
        html: '<div class="user-gps-dot"></div>',
        iconSize: [14, 14]
      });

      if (userMarker) {
        map.removeLayer(userMarker);
      }

      userMarker = L.marker([lat, lng], { icon: userGpsIcon }).addTo(map);

      // Smooth cinematic flight transition to user location
      map.flyTo([lat, lng], 17, { animate: true, duration: 1.5 });
    },
    (err) => {
      console.warn("⚠️ Geolocalización fallida:", err.message);
      geoButton.style.color = '';
      icon.className = 'fa-solid fa-crosshairs';
      alert(`No se pudo obtener tu ubicación GPS: ${err.message}`);
    },
    { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
  );
}

/**
 * Fetch initial NAP status from the Express API endpoint.
 */
async function loadNapsData() {
  try {
    const response = await fetch('/webhook/naps');
    if (!response.ok) throw new Error('Failed to load NAP data');
    
    napsData = await response.json();
    renderNapsAndMarkers();
    updateGlobalStats();
    autoCenterMap();
    checkUrlQueryParams();
  } catch (error) {
    console.error('❌ Error loading initial NAP data:', error);
    document.getElementById('naps-list').innerHTML = `
      <li class="no-results">
        <i class="fa-solid fa-triangle-exclamation"></i>
        Error cargando datos de cajas NAP
      </li>
    `;
  }
}

/**
 * Render NAPs in the sidebar list and draw markers on the map.
 */
function renderNapsAndMarkers(filterQuery = '') {
  const listContainer = document.getElementById('naps-list');
  listContainer.innerHTML = '';
  
  // Clear existing markers from map
  Object.values(markers).forEach(m => map.removeLayer(m));
  markers = {};

  const query = filterQuery.toLowerCase().trim();
  let matchCount = 0;
  const matchingNaps = [];

  napsData.forEach(nap => {
    // Search filter check (match NAP name or any client name/SN)
    const matchesName = nap.name.toLowerCase().includes(query);
    const matchesClients = nap.clients.some(c => 
      c.name.toLowerCase().includes(query) || 
      c.sn.toLowerCase().includes(query)
    );

    if (query && !matchesName && !matchesClients) return;

    // Status filter check (online, partial, offline)
    if (activeStatusFilter && nap.status !== activeStatusFilter) return;

    matchCount++;
    matchingNaps.push(nap);

    // 1. Draw premium custom DivIcon Marker on map if it has valid coordinates
    if (nap.latitude !== null && nap.longitude !== null) {
      const markerIcon = L.divIcon({
        className: `custom-pin-marker marker-${nap.status}`,
        html: `
          <div class="pin-marker-container">
            <div class="pin-marker-glow"></div>
            <div class="pin-marker-dot">
              <i class="fa-solid fa-network-wired"></i>
            </div>
          </div>
        `,
        iconSize: [24, 24],
        iconAnchor: [12, 12]
      });
      
      const marker = L.marker([nap.latitude, nap.longitude], {
        icon: markerIcon,
        className: `nap-marker marker-${nap.status}`
      });

      // Bind detail popup
      marker.bindPopup(() => getPopupContent(nap));
      marker.addTo(map);
      markers[nap.name] = marker;
    }

    // 2. Add Item to Sidebar list
    const li = document.createElement('li');
    // Add placing-active class if this NAP is being placed right now
    const isPlacing = placingNapName === nap.name;
    li.className = `nap-item ${nap.status} ${isPlacing ? 'placing-active' : ''}`;
    li.dataset.name = nap.name;
    
    // Status text label
    const statusLabel = nap.status === 'online' ? 'Online' : (nap.status === 'partial' ? 'Parcial' : 'Caído');
    
    // Percent bar values
    const onlinePct = nap.totalClients > 0 ? (nap.onlineClients / nap.totalClients) * 100 : 0;
    const offlinePct = nap.totalClients > 0 ? (nap.offlineClients / nap.totalClients) * 100 : 0;

    li.innerHTML = `
      <div class="nap-item-header">
        <span class="nap-name">
          <i class="fa-solid fa-box-archive"></i>
          ${nap.name}
        </span>
        <span class="nap-badge">${statusLabel}</span>
      </div>
      <div class="nap-details">
        <span><b>OLT:</b> ${nap.olt_name} (Port ${nap.board}/${nap.port})</span>
        <span><b>Clientes:</b> 🟢 ${nap.onlineClients} | 🔴 ${nap.offlineClients} (Total: ${nap.totalClients})</span>
        ${nap.latitude === null ? `
          <span>⚠️ <i>Sin coordenadas de GPS</i></span>
          <button class="btn-locate" data-nap="${nap.name}">
            <i class="fa-solid fa-map-pin"></i> Ubicar en mapa
          </button>
        ` : ''}
      </div>
      <div class="nap-clients-bar">
        <div class="client-segment-online" style="width: ${onlinePct}%"></div>
        <div class="client-segment-offline" style="width: ${offlinePct}%"></div>
      </div>
    `;

    // Click handler to zoom/pan to marker
    li.addEventListener('click', () => {
      if (nap.latitude !== null && nap.longitude !== null) {
        // Smooth cinematic zoom transition
        map.flyTo([nap.latitude, nap.longitude], 17, { animate: true, duration: 1.5 });
        markers[nap.name].openPopup();
      } else {
        // If no coordinates, automatically prompt manual positioning mode!
        startManualPlacement(nap.name, li);
      }
    });

    // Attach listener for the manual placement button
    const locateBtn = li.querySelector('.btn-locate');
    if (locateBtn) {
      locateBtn.addEventListener('click', (e) => {
        e.stopPropagation(); // Avoid triggering list item's default click handler
        startManualPlacement(nap.name, li);
      });
    }

    listContainer.appendChild(li);
  });

  if (matchCount === 0) {
    listContainer.innerHTML = '<li class="no-results">No se encontraron resultados</li>';
  } else {
    autoCenterMap(matchingNaps);
  }
}

/**
 * Generate HTML layout for Leaflet Popups, including navigational shortcuts.
 */
function getPopupContent(nap) {
  const statusLabel = nap.status === 'online' ? '🟢 ONLINE' : (nap.status === 'partial' ? '🟡 PARCIAL' : '🔴 CAÍDA');
  
  const clientRows = nap.clients.map(c => {
    const isOnline = c.status.toLowerCase() === 'online' || c.status.toLowerCase() === 'active';
    const statusClass = isOnline ? 'online' : 'offline';
    return `
      <div class="map-popup-client-item">
        <span>
          <span class="client-status-dot ${statusClass}"></span>
          ${c.name}
        </span>
        <code>${c.sn}</code>
      </div>
    `;
  }).join('');

  // Google Maps and Street View integrations for field engineers
  const googleMapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${nap.latitude},${nap.longitude}`;
  const streetViewUrl = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${nap.latitude},${nap.longitude}`;

  // Recent history for this specific NAP
  const napHistory = historyData.filter(h => (h.napName || '').toUpperCase() === nap.name.toUpperCase()).slice(0, 3);
  let historySection = '';
  if (napHistory.length > 0) {
    const historyRows = napHistory.map(h => {
      const dot = h.failureType === 'recovery' ? '🟢' : (h.failureType === 'power_fail' ? '⚡' : '🔴');
      return `
        <li class="popup-history-item">
          <span>${dot} <b>${h.failureLabel}</b> (${h.onuName})</span>
          <span style="color:#94A3B8; font-size:10px">${formatTimeAgo(new Date(h.timestamp))}</span>
        </li>
      `;
    }).join('');

    historySection = `
      <div class="popup-history-container">
        <div class="popup-history-title"><i class="fa-solid fa-clock-rotate-left"></i> Historial Reciente de esta NAP</div>
        <ul class="popup-history-list">${historyRows}</ul>
      </div>
    `;
  }

  return `
    <div class="map-popup-container">
      <div class="map-popup-header">
        <h3>${nap.name}</h3>
        <span class="nap-badge" style="color: ${statusColors[nap.status]}">${statusLabel}</span>
      </div>
      <div class="map-popup-details">
        <b>OLT:</b> ${nap.olt_name}<br>
        <b>Puerto:</b> Slot ${nap.board} | Pon ${nap.port}<br>
        <b>Clientes Activos:</b> ${nap.onlineClients} de ${nap.totalClients}
      </div>
      <div class="map-popup-clients">
        ${clientRows}
      </div>
      ${historySection}
      <div class="map-popup-actions">
        <a href="${googleMapsUrl}" target="_blank" class="btn-popup-nav">
          <i class="fa-solid fa-compass"></i> Cómo llegar
        </a>
        <a href="${streetViewUrl}" target="_blank" class="btn-popup-nav">
          <i class="fa-solid fa-street-view"></i> Street View
        </a>
      </div>
    </div>
  `;
}

/**
 * Auto-center and fit map bounds to cover all plotted NAPs.
 */
function autoCenterMap(filteredNaps = napsData) {
  const validCoords = filteredNaps
    .filter(nap => nap.latitude !== null && nap.longitude !== null)
    .map(nap => [nap.latitude, nap.longitude]);

  if (validCoords.length > 0) {
    map.fitBounds(validCoords, { padding: [50, 50], maxZoom: 15 });
  }
}

/**
 * Re-calculate global statistics in the header cards.
 */
function updateGlobalStats() {
  let okCount = 0;
  let partialCount = 0;
  let downCount = 0;

  napsData.forEach(nap => {
    if (nap.status === 'online') okCount++;
    else if (nap.status === 'partial') partialCount++;
    else if (nap.status === 'offline') downCount++;
  });

  document.getElementById('stat-ok-count').textContent = okCount;
  document.getElementById('stat-partial-count').textContent = partialCount;
  document.getElementById('stat-down-count').textContent = downCount;
}

/**
 * Initialize WebSockets for real-time push updates.
 */
function setupWebSocket() {
  const statusBadge = document.getElementById('connection-status');
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;

  console.log(`🔌 Connecting to WebSockets at ${wsUrl}`);
  
  socket = new WebSocket(wsUrl);

  socket.onopen = () => {
    console.log('✅ WebSocket connection established.');
    statusBadge.className = 'status-badge connected';
    statusBadge.querySelector('.status-text').textContent = 'Conectado (Tiempo Real)';
  };

  socket.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      console.log('📥 WebSocket message received:', payload);

      if (payload.event === 'nap_status_update' && payload.data) {
        handleNapUpdate(payload.data);
      } else if (payload.event === 'status_history_event' && payload.data) {
        handleNewHistoryEvent(payload.data);
      }
    } catch (err) {
      console.error('❌ Error parsing WebSocket message:', err);
    }
  };

  socket.onclose = () => {
    console.warn('❌ WebSocket connection closed. Attempting reconnect in 5s...');
    statusBadge.className = 'status-badge disconnected';
    statusBadge.querySelector('.status-text').textContent = 'Desconectado. Reintentando...';
    setTimeout(setupWebSocket, 5000);
  };
}

/**
 * Apply live update for a NAP without rebuilding the full view.
 */
function handleNapUpdate(updatedNap) {
  // 1. Update the local client memory array
  const index = napsData.findIndex(n => n.name === updatedNap.name);
  if (index !== -1) {
    napsData[index] = updatedNap;
  } else {
    napsData.push(updatedNap);
  }

  // 2. Recalculate stats card
  updateGlobalStats();

  // 3. Update the marker visual color on the map dynamically
  const marker = markers[updatedNap.name];
  if (marker) {
    // Recreate the divIcon to reflect new status color
    const markerIcon = L.divIcon({
      className: `custom-pin-marker marker-${updatedNap.status}`,
      html: `
        <div class="pin-marker-container">
          <div class="pin-marker-glow"></div>
          <div class="pin-marker-dot">
            <i class="fa-solid fa-network-wired"></i>
          </div>
        </div>
      `,
      iconSize: [24, 24],
      iconAnchor: [12, 12]
    });
    marker.setIcon(markerIcon);
    
    // Refresh its popup content if it's currently open
    if (marker.isPopupOpen()) {
      marker.setPopupContent(getPopupContent(updatedNap));
    }
  } else if (updatedNap.latitude !== null && updatedNap.longitude !== null) {
    // Create new custom divIcon marker
    const markerIcon = L.divIcon({
      className: `custom-pin-marker marker-${updatedNap.status}`,
      html: `
        <div class="pin-marker-container">
          <div class="pin-marker-glow"></div>
          <div class="pin-marker-dot">
            <i class="fa-solid fa-network-wired"></i>
          </div>
        </div>
      `,
      iconSize: [24, 24],
      iconAnchor: [12, 12]
    });
    
    const newMarker = L.marker([updatedNap.latitude, updatedNap.longitude], {
      icon: markerIcon
    });
    newMarker.bindPopup(() => getPopupContent(updatedNap));
    newMarker.addTo(map);
    markers[updatedNap.name] = newMarker;
  }

  // 4. Re-draw current sidebar lists with active search query preserved
  const searchQuery = document.getElementById('nap-search').value;
  renderNapsAndMarkers(searchQuery);
}

/**
 * Listen and apply search filter typing.
 */
function setupSearch() {
  const searchInput = document.getElementById('nap-search');
  searchInput.addEventListener('input', (e) => {
    if (e.target.value.trim() !== '') {
      activeStatusFilter = null;
      document.querySelectorAll('.stat-card').forEach(c => c.classList.remove('active-filter'));
    }
    renderNapsAndMarkers(e.target.value);
  });
}

// ==========================================
// Manual Placement / Positioning Logic
// ==========================================

let placingNapName = null;

/**
 * Enable Manual Placement mode on the map for a given NAP name.
 */
function startManualPlacement(napName, liElement) {
  // If already placing another NAP, cancel it first
  if (placingNapName) {
    stopManualPlacement();
  }

  placingNapName = napName;
  
  // Show placement UI overlay
  const overlay = document.getElementById('placement-overlay');
  document.getElementById('placement-nap-name').textContent = napName;
  overlay.classList.remove('hidden');
  
  // Refresh sidebar highlights
  renderNapsAndMarkers(document.getElementById('nap-search').value);

  // Change cursor to crosshairs on the map
  document.getElementById('map').style.cursor = 'crosshair';

  // Listen to single click event on the Leaflet map
  map.once('click', handleMapPlacementClick);
}

/**
 * Disable Manual Placement mode and restore cursor.
 */
function stopManualPlacement() {
  if (!placingNapName) return;

  // Hide overlay
  const overlay = document.getElementById('placement-overlay');
  overlay.classList.add('hidden');

  // Reset active classes in list
  placingNapName = null;
  renderNapsAndMarkers(document.getElementById('nap-search').value);

  // Reset cursor style
  document.getElementById('map').style.cursor = '';

  // Remove map click listener if any remains
  map.off('click', handleMapPlacementClick);
}

/**
 * Handle coordinates selection on click.
 */
async function handleMapPlacementClick(e) {
  const lat = e.latlng.lat;
  const lng = e.latlng.lng;
  const napName = placingNapName;

  console.log(`📍 Map clicked for ${napName}: [${lat}, ${lng}]. Sending to backend...`);

  try {
    const response = await fetch('/webhook/naps/coordinates', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: napName,
        latitude: lat,
        longitude: lng
      })
    });

    if (!response.ok) {
      throw new Error('Failed to save coordinates on backend');
    }

    const data = await response.json();
    console.log('✅ Location saved successfully:', data);
  } catch (err) {
    console.error('❌ Error saving coordinates:', err);
    alert(`Error guardando las coordenadas de ${napName}: ${err.message}`);
  } finally {
    stopManualPlacement();
  }
}

// ==========================================
// KML / CSV Bulk Coordinates Import Logic
// ==========================================

let pendingImportUpdates = [];

/**
 * Configure drag-and-drop / file selector listeners for bulk upload.
 */
function setupFileImport() {
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('file-input');

  // Trigger file browser on dropzone click
  dropzone.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      parseAndPreviewFile(e.target.files[0]);
    }
  });

  // Drag and drop event styling
  ['dragenter', 'dragover'].forEach(eventName => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.add('dragover');
    }, false);
  });

  ['dragleave', 'dragend', 'drop'].forEach(eventName => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove('dragover');
    }, false);
  });

  dropzone.addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    const files = dt.files;
    if (files.length > 0) {
      fileInput.files = files;
      parseAndPreviewFile(files[0]);
    }
  }, false);
}

/**
 * Read the file and update the import preview logging panel.
 */
function parseAndPreviewFile(file) {
  const reader = new FileReader();

  reader.onload = (e) => {
    const text = e.target.result;
    let records = [];

    if (file.name.toLowerCase().endsWith('.kml')) {
      records = parseKml(text);
    } else if (file.name.toLowerCase().endsWith('.csv')) {
      records = parseCsv(text);
    } else {
      alert('Formato de archivo no soportado. Selecciona un archivo .kml o .csv.');
      return;
    }

    console.log(`Parsed ${records.length} records from uploaded file.`);

    // Perform case-insensitive cross matching with current NAPs list
    const updates = [];
    const logList = document.getElementById('preview-log');
    logList.innerHTML = '';

    let matchCount = 0;

    records.forEach((rec) => {
      // Look for a match in napsData (case-insensitive substring check)
      const matched = napsData.find(n => 
        n.name.toUpperCase() === rec.name.toUpperCase() ||
        n.name.toUpperCase().includes(rec.name.toUpperCase()) ||
        rec.name.toUpperCase().includes(n.name.toUpperCase())
      );

      const li = document.createElement('li');
      if (matched) {
        matchCount++;
        updates.push({ name: matched.name, latitude: rec.latitude, longitude: rec.longitude });
        li.className = 'success';
        li.innerHTML = `<i class="fa-solid fa-circle-check"></i> Caja <b>${matched.name}</b> vinculada &rarr; [${rec.latitude.toFixed(6)}, ${rec.longitude.toFixed(6)}]`;
      } else {
        li.className = 'info';
        li.innerHTML = `<i class="fa-solid fa-circle-info"></i> Omitido: "${rec.name}" (No coincide con ninguna NAP)`;
      }
      logList.appendChild(li);
    });

    // Update preview summary metrics
    document.getElementById('preview-total-read').textContent = records.length;
    document.getElementById('preview-matched').textContent = matchCount;

    pendingImportUpdates = updates;

    // Enable/disable Apply button
    const applyBtn = document.getElementById('btn-apply-import');
    applyBtn.disabled = (updates.length === 0);

    // Display preview list panel
    document.getElementById('import-preview').classList.remove('hidden');
  };

  reader.readAsText(file);
}

/**
 * Parse Google Earth KML XML structure.
 * Supports both standard <coordinates> and MyMaps ExtendedData/SimpleData formats.
 */
function parseKml(text) {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(text, 'text/xml');
  const placemarks = xmlDoc.getElementsByTagName('Placemark');
  const results = [];

  for (let i = 0; i < placemarks.length; i++) {
    const p = placemarks[i];
    let name = '';
    let lat = NaN;
    let lng = NaN;

    // 1. Try to extract from SimpleData (ExtendedData)
    const simpleDatas = p.getElementsByTagName('SimpleData');
    if (simpleDatas.length > 0) {
      for (let j = 0; j < simpleDatas.length; j++) {
        const sd = simpleDatas[j];
        const attrName = sd.getAttribute('name');
        if (attrName === 'Nombre' || attrName === 'name') {
          name = sd.textContent.trim();
        } else if (attrName === 'Latitud' || attrName === 'latitude' || attrName === 'lat') {
          lat = parseFloat(sd.textContent.trim());
        } else if (attrName === 'Longitud' || attrName === 'longitude' || attrName === 'lng' || attrName === 'lon') {
          lng = parseFloat(sd.textContent.trim());
        }
      }
    }

    // 2. If name is not found in SimpleData, check standard <name> node
    if (!name) {
      const nameNode = p.getElementsByTagName('name')[0];
      name = nameNode ? nameNode.textContent.trim() : '';
    }

    // 3. If lat/lng are not found, check standard <coordinates> node
    if (isNaN(lat) || isNaN(lng)) {
      const coordNode = p.getElementsByTagName('coordinates')[0];
      if (coordNode) {
        const coordStr = coordNode.textContent.trim();
        const parts = coordStr.split(/[\s,]+/);
        if (parts.length >= 2) {
          lng = parseFloat(parts[0]);
          lat = parseFloat(parts[1]);
        }
      }
    }

    if (name && !isNaN(lat) && !isNaN(lng) && lat !== 0 && lng !== 0) {
      results.push({ name, latitude: lat, longitude: lng });
    }
  }
  return results;
}

/**
 * Parse CSV files, looking for Name, Latitude, Longitude columns.
 * Supports header-based column mapping dynamically.
 */
function parseCsv(text) {
  const lines = text.split(/\r?\n/);
  const results = [];
  if (lines.length === 0) return results;

  // Split helper respecting quotes
  const splitLine = (line) => {
    const cols = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        cols.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    cols.push(current.trim());
    return cols;
  };

  // Detect column mapping if header exists
  const firstLine = lines[0].toLowerCase();
  let nameIdx = -1;
  let latIdx = -1;
  let lngIdx = -1;

  if (firstLine.includes('nombre') || firstLine.includes('name') || firstLine.includes('latitud') || firstLine.includes('latitude') || firstLine.includes('lat')) {
    const headers = splitLine(lines[0]);
    headers.forEach((h, idx) => {
      const headerName = h.toLowerCase().replace(/['"]/g, '').trim();
      if (headerName === 'nombre' || headerName === 'name') {
        nameIdx = idx;
      } else if (headerName === 'latitud' || headerName === 'latitude' || headerName === 'lat') {
        latIdx = idx;
      } else if (headerName === 'longitud' || headerName === 'longitude' || headerName === 'lng' || headerName === 'lon') {
        lngIdx = idx;
      }
    });
  }

  const startLine = (nameIdx !== -1 || latIdx !== -1 || lngIdx !== -1) ? 1 : 0;

  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const cols = splitLine(line);
    if (cols.length < 3) continue;

    let name = '';
    let lat = NaN;
    let lng = NaN;

    if (nameIdx !== -1 && latIdx !== -1 && lngIdx !== -1) {
      name = cols[nameIdx] ? cols[nameIdx].replace(/['"]/g, '').trim() : '';
      lat = parseFloat(cols[latIdx]);
      lng = parseFloat(cols[lngIdx]);
    } else {
      // Fallback defaults
      // Try default order 1: name, latitude, longitude
      name = cols[0].replace(/['"]/g, '').trim();
      lat = parseFloat(cols[1]);
      lng = parseFloat(cols[2]);

      if (!name || isNaN(lat) || isNaN(lng)) {
        // Try default order 2: latitude, longitude, name
        lat = parseFloat(cols[0]);
        lng = parseFloat(cols[1]);
        name = cols[2].replace(/['"]/g, '').trim();
      }
    }

    if (name && !isNaN(lat) && !isNaN(lng) && lat !== 0 && lng !== 0) {
      results.push({ name, latitude: lat, longitude: lng });
    }
  }

  return results;
}

/**
 * Submit pending bulk coordinate updates to the backend.
 */
async function applyBulkImport() {
  if (pendingImportUpdates.length === 0) return;

  const applyBtn = document.getElementById('btn-apply-import');
  applyBtn.disabled = true;
  applyBtn.textContent = 'Importando...';

  try {
    const response = await fetch('/webhook/naps/coordinates/bulk', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        updates: pendingImportUpdates
      })
    });

    if (!response.ok) {
      throw new Error('Failed to save bulk coordinates');
    }

    const data = await response.json();
    console.log('✅ Bulk coordinates saved successfully:', data);

    // Close modal
    document.getElementById('import-modal').classList.add('hidden');
    alert(`Importación completada. Se ubicaron ${data.updated_count} cajas NAP en el mapa.`);
  } catch (err) {
    console.error('❌ Bulk import failed:', err);
    alert(`Error al importar coordenadas masivamente: ${err.message}`);
  } finally {
    applyBtn.textContent = 'Aplicar Coordenadas';
    applyBtn.disabled = false;
  }
}

/**
 * Listen to clicks on the network stats summary cards and toggle filters.
 */
function setupStatsFilter() {
  const cards = {
    online: document.querySelector('.stat-card.online'),
    partial: document.querySelector('.stat-card.partial'),
    offline: document.querySelector('.stat-card.offline')
  };

  Object.entries(cards).forEach(([status, card]) => {
    if (!card) return;
    card.addEventListener('click', () => {
      if (activeStatusFilter === status) {
        activeStatusFilter = null;
        card.classList.remove('active-filter');
      } else {
        Object.values(cards).forEach(c => c && c.classList.remove('active-filter'));
        activeStatusFilter = status;
        card.classList.add('active-filter');
      }
      
      const searchInput = document.getElementById('nap-search');
      renderNapsAndMarkers(searchInput ? searchInput.value : '');
    });
  });
}

/**
 * Check if the URL contains a 'nap' query parameter, and zoom/focus on it if valid.
 */
function checkUrlQueryParams() {
  const urlParams = new URLSearchParams(window.location.search);
  const napParam = urlParams.get('nap');
  
  if (napParam) {
    const cleanNapParam = napParam.trim().toUpperCase();
    console.log(`🎯 URL query parameter 'nap' detected: ${cleanNapParam}`);
    
    const nap = napsData.find(n => n.name.toUpperCase() === cleanNapParam);
    if (nap) {
      if (nap.latitude !== null && nap.longitude !== null) {
        setTimeout(() => {
          map.flyTo([nap.latitude, nap.longitude], 17, { animate: true, duration: 1.5 });
          if (markers[nap.name]) {
            markers[nap.name].openPopup();
          }
        }, 500);
      } else {
        console.warn(`NAP ${cleanNapParam} has no coordinates plotted.`);
      }
    }
  }
}

// ─── History Drawer & Timeline Management ────────────────────────────────────

/**
 * Setup History Drawer toggles, filter chips, search and refresh buttons.
 */
function setupHistoryDrawer() {
  const drawer = document.getElementById('history-drawer');
  const toggleBtn = document.getElementById('btn-history-toggle');
  const closeBtn = document.getElementById('btn-close-history');
  const refreshBtn = document.getElementById('btn-refresh-history');
  const searchInput = document.getElementById('history-search-input');
  const filterChips = document.querySelectorAll('.history-filters .filter-chip');

  const controlsContainer = document.querySelector('.map-top-controls');

  // Restore saved floating position
  if (controlsContainer) {
    const savedPos = localStorage.getItem('history_btn_pos');
    if (savedPos) {
      try {
        const { left, top } = JSON.parse(savedPos);
        const btnWidth = controlsContainer.offsetWidth || 220;
        const btnHeight = controlsContainer.offsetHeight || 45;
        const maxLeft = Math.max(0, window.innerWidth - btnWidth);
        const maxTop = Math.max(0, window.innerHeight - btnHeight);
        const clampLeft = Math.max(0, Math.min(left, maxLeft));
        const clampTop = Math.max(0, Math.min(top, maxTop));

        controlsContainer.style.position = 'fixed';
        controlsContainer.style.left = `${clampLeft}px`;
        controlsContainer.style.top = `${clampTop}px`;
        controlsContainer.style.right = 'auto';
        controlsContainer.style.bottom = 'auto';
      } catch (e) {
        console.warn('Error restoring history button position:', e);
      }
    }
  }

  // Draggable Floating Logic across any part of the screen
  if (toggleBtn && controlsContainer) {
    let isDragging = false;
    let hasMoved = false;
    let shiftX = 0;
    let shiftY = 0;

    const onPointerDown = (e) => {
      // Allow only primary mouse button or touch/stylus
      if (e.button !== undefined && e.button !== 0) return;

      isDragging = true;
      hasMoved = false;

      const rect = controlsContainer.getBoundingClientRect();
      shiftX = e.clientX - rect.left;
      shiftY = e.clientY - rect.top;

      toggleBtn.classList.add('is-dragging');
      document.body.style.userSelect = 'none';

      window.addEventListener('pointermove', onPointerMove, { passive: false });
      window.addEventListener('pointerup', onPointerUp, { passive: false });
      window.addEventListener('pointercancel', onPointerUp, { passive: false });
    };

    const onPointerMove = (e) => {
      if (!isDragging) return;
      e.preventDefault();

      hasMoved = true;

      const btnWidth = controlsContainer.offsetWidth;
      const btnHeight = controlsContainer.offsetHeight;

      let newLeft = e.clientX - shiftX;
      let newTop = e.clientY - shiftY;

      // Keep within screen viewport
      const maxLeft = window.innerWidth - btnWidth;
      const maxTop = window.innerHeight - btnHeight;

      newLeft = Math.max(0, Math.min(newLeft, maxLeft));
      newTop = Math.max(0, Math.min(newTop, maxTop));

      controlsContainer.style.position = 'fixed';
      controlsContainer.style.left = `${newLeft}px`;
      controlsContainer.style.top = `${newTop}px`;
      controlsContainer.style.right = 'auto';
      controlsContainer.style.bottom = 'auto';
    };

    const onPointerUp = (e) => {
      if (!isDragging) return;
      isDragging = false;
      toggleBtn.classList.remove('is-dragging');
      document.body.style.userSelect = '';

      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);

      if (hasMoved) {
        const rect = controlsContainer.getBoundingClientRect();
        localStorage.setItem('history_btn_pos', JSON.stringify({ left: rect.left, top: rect.top }));
      }
    };

    toggleBtn.addEventListener('pointerdown', onPointerDown);

    toggleBtn.addEventListener('click', (e) => {
      if (hasMoved) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (drawer) {
        drawer.classList.toggle('hidden');
      }
    });
  }

  // Ensure button stays inside viewport on window resize
  window.addEventListener('resize', () => {
    if (controlsContainer && controlsContainer.style.position === 'fixed') {
      const rect = controlsContainer.getBoundingClientRect();
      const maxLeft = window.innerWidth - controlsContainer.offsetWidth;
      const maxTop = window.innerHeight - controlsContainer.offsetHeight;
      if (rect.left > maxLeft || rect.top > maxTop) {
        controlsContainer.style.left = `${Math.max(0, Math.min(rect.left, maxLeft))}px`;
        controlsContainer.style.top = `${Math.max(0, Math.min(rect.top, maxTop))}px`;
      }
    }
  });

  if (closeBtn && drawer) {
    closeBtn.addEventListener('click', () => {
      drawer.classList.add('hidden');
    });
  }

  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      const icon = refreshBtn.querySelector('i');
      if (icon) icon.classList.add('fa-spin');
      loadHistoryData().finally(() => {
        setTimeout(() => {
          if (icon) icon.classList.remove('fa-spin');
        }, 600);
      });
    });
  }

  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      historySearchQuery = e.target.value.trim().toLowerCase();
      renderHistoryList();
    });
  }

  filterChips.forEach(chip => {
    chip.addEventListener('click', () => {
      filterChips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      activeHistoryFilter = chip.dataset.filter || 'all';
      renderHistoryList();
    });
  });
}

/**
 * Load state change history from /webhook/history.
 */
async function loadHistoryData() {
  const historyList = document.getElementById('history-list');
  try {
    const res = await fetch('/webhook/history?limit=150');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    historyData = data.history || [];
    updateHistoryBadge();
    renderHistoryList();
  } catch (err) {
    console.error('Error loading history data:', err);
    if (historyList) {
      historyList.innerHTML = `<li class="no-results">No se pudo cargar el historial: ${err.message}</li>`;
    }
  }
}

/**
 * Update the numeric badge in the history toggle button.
 */
function updateHistoryBadge() {
  const badge = document.getElementById('history-badge');
  if (badge) {
    badge.textContent = historyData.length;
  }
}

/**
 * Handle a real-time incoming status history event from WebSocket.
 */
function handleNewHistoryEvent(newEvent) {
  historyData.unshift(newEvent);
  if (historyData.length > 250) historyData.pop();
  
  updateHistoryBadge();
  renderHistoryList();

  // Flash the button with a glow color
  const toggleBtn = document.getElementById('btn-history-toggle');
  if (toggleBtn) {
    const glowColor = newEvent.failureType === 'recovery' ? 'rgba(16, 185, 129, 0.6)' : (newEvent.failureType === 'power_fail' ? 'rgba(245, 158, 11, 0.6)' : 'rgba(239, 68, 68, 0.6)');
    toggleBtn.style.boxShadow = `0 0 20px ${glowColor}`;
    setTimeout(() => {
      toggleBtn.style.boxShadow = '';
    }, 2500);
  }
}

/**
 * Render the history timeline cards inside the Drawer.
 */
function renderHistoryList() {
  const listContainer = document.getElementById('history-list');
  if (!listContainer) return;

  const filtered = historyData.filter(item => {
    // 1. Filter by category chip
    if (activeHistoryFilter !== 'all') {
      if (item.failureType !== activeHistoryFilter) return false;
    }

    // 2. Filter by search query
    if (historySearchQuery) {
      const matchNap = (item.napName || '').toLowerCase().includes(historySearchQuery);
      const matchClient = (item.onuName || '').toLowerCase().includes(historySearchQuery);
      const matchSn = (item.sn || '').toLowerCase().includes(historySearchQuery);
      const matchReason = (item.reason || '').toLowerCase().includes(historySearchQuery);
      if (!matchNap && !matchClient && !matchSn && !matchReason) return false;
    }

    return true;
  });

  if (filtered.length === 0) {
    listContainer.innerHTML = '<li class="no-results">No hay eventos que coincidan con los filtros.</li>';
    return;
  }

  listContainer.innerHTML = '';
  filtered.forEach(item => {
    const li = document.createElement('li');
    li.className = `history-item ${item.failureType}`;

    let iconHtml = '<i class="fa-solid fa-circle-exclamation"></i>';
    if (item.failureType === 'power_fail') {
      iconHtml = '<i class="fa-solid fa-bolt"></i>';
    } else if (item.failureType === 'loss') {
      iconHtml = '<i class="fa-solid fa-triangle-exclamation"></i>';
    } else if (item.failureType === 'recovery') {
      iconHtml = '<i class="fa-solid fa-circle-check"></i>';
    }

    const timeAgo = formatTimeAgo(new Date(item.timestamp));

    li.innerHTML = `
      <div class="history-item-top">
        <span class="history-type-badge ${item.failureType}">
          ${iconHtml} ${item.failureLabel}
        </span>
        <span class="history-timestamp" title="${item.formattedTime}">
          <i class="fa-regular fa-clock"></i> ${timeAgo}
        </span>
      </div>
      <div class="history-main-info">
        <div class="history-nap-row">
          <span class="history-nap-tag">
            <i class="fa-solid fa-box-archive"></i>
            ${item.napName}
          </span>
          ${(item.latitude !== null && item.longitude !== null) ? `
            <button class="btn-locate-history" data-nap="${item.napName}" data-lat="${item.latitude}" data-lng="${item.longitude}">
              <i class="fa-solid fa-location-dot"></i> Ver en mapa
            </button>
          ` : ''}
        </div>
        <div class="history-client-tag">
          👤 <b>${item.onuName}</b> (<code>${item.sn}</code>)
        </div>
        <div class="history-status-transition">
          <b>Transición:</b> <span>${item.previousStatus} ➔ <b>${item.newStatus}</b></span>
        </div>
        ${item.reason ? `<div class="history-reason-text">📝 ${item.reason}</div>` : ''}
      </div>
    `;

    const locateBtn = li.querySelector('.btn-locate-history');
    if (locateBtn) {
      locateBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        focusNapOnMap(item.napName, item.latitude, item.longitude);
      });
    }

    li.addEventListener('click', () => {
      if (item.latitude !== null && item.longitude !== null) {
        focusNapOnMap(item.napName, item.latitude, item.longitude);
      }
    });

    listContainer.appendChild(li);
  });
}

/**
 * Focus and smooth-zoom map to a specific NAP marker.
 */
function focusNapOnMap(napName, lat, lng) {
  if (lat !== null && lng !== null) {
    map.flyTo([lat, lng], 18, { animate: true, duration: 1.2 });
    if (markers[napName]) {
      markers[napName].openPopup();
    }
  }
}

/**
 * Format relative time (e.g. "hace 3 min").
 */
function formatTimeAgo(date) {
  if (isNaN(date.getTime())) return 'reciente';
  const seconds = Math.floor((new Date() - date) / 1000);
  if (seconds < 60) return 'hace un momento';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `hace ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours}h`;
  const days = Math.floor(hours / 24);
  return `hace ${days}d`;
}
