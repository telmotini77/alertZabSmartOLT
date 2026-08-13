// Real-Time Interactive NAP Map Client Logic

let map;
let napsData = [];
let markers = {}; // Maps NAP name -> Leaflet marker object
let socket;
let userMarker = null; // Pulsing GPS user location marker
let activeStatusFilter = null;
let markerClusterGroup; // Leaflet marker cluster group
let opticalChart = null; // Chart.js instance for optical history

// Base Map Layers
let baseLayers = {};
let activeLayerName = 'google_hybrid';

// Topology State
let topologyLayerGroup = null;
let topologyEnabled = false;

// Draggable Pins State
let draggablePinsEnabled = false;

// Ruler Measurement State
let rulerEnabled = false;
let rulerPoints = [];
let rulerPolylines = [];
let rulerMarkers = [];
let rulerTempPolyline = null; // to show line following the mouse

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
  setupMapControls();
  
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
 * Initialize the Leaflet map with multiple base layers and topology group.
 */
function initMap() {
  // Default center at [0,0] (will auto-adjust when data is loaded)
  map = L.map('map').setView([0, 0], 2);

  // Define base map tile layers
  baseLayers = {
    google_hybrid: L.tileLayer('https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', {
      attribution: '&copy; Google Maps',
      maxZoom: 20
    }),
    cartodb_dark: L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
      maxZoom: 20
    }),
    google_road: L.tileLayer('https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', {
      attribution: '&copy; Google Maps',
      maxZoom: 20
    }),
    osm: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19
    })
  };

  // Restore saved map layer or default to Google Hybrid
  const savedLayer = localStorage.getItem('map_active_layer') || 'google_hybrid';
  activeLayerName = baseLayers[savedLayer] ? savedLayer : 'google_hybrid';
  baseLayers[activeLayerName].addTo(map);

  // Initialize Topology Layer Group
  topologyLayerGroup = L.layerGroup().addTo(map);

  // Initialize Marker Cluster Group
  markerClusterGroup = L.markerClusterGroup({
    maxClusterRadius: 50,
    showCoverageOnHover: false,
    spiderfyOnMaxZoom: true
  });
  map.addLayer(markerClusterGroup);

  // Add Scale Control (bottom-left)
  L.control.scale({ position: 'bottomleft' }).addTo(map);

  // Attach click listener to GPS geolocation button
  document.getElementById('btn-geolocation').addEventListener('click', locateUser);

  // Bind dynamic diagnostics events inside popup opening
  map.on('popupopen', (e) => {
    const container = e.popup.getElement();
    if (!container) return;
    const diagBtns = container.querySelectorAll('.btn-diagnostic-onu');
    diagBtns.forEach(btn => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const sn = btn.dataset.sn;
        showOnuDiagnostics(sn);
      });
    });
  });
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
  
  // Clear existing markers from cluster group
  if (markerClusterGroup) {
    markerClusterGroup.clearLayers();
  }
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
        className: `nap-marker marker-${nap.status}`,
        draggable: draggablePinsEnabled
      });

      marker.napName = nap.name;

      marker.on('dragend', async (e) => {
        const { lat, lng } = e.target.getLatLng();
        console.log(`📌 Marker ${marker.napName} dragged to [${lat}, ${lng}]. Saving...`);
        try {
          const response = await fetch('/webhook/naps/coordinates', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              name: marker.napName,
              latitude: lat,
              longitude: lng
            })
          });
          if (!response.ok) {
            throw new Error('Failed to update drag coordinates on backend');
          }
          const resData = await response.json();
          console.log(`✅ Position updated for ${marker.napName}:`, resData);
        } catch (err) {
          console.error(`❌ Drag coordinates error for ${marker.napName}:`, err);
          alert(`Error al actualizar la ubicación de ${marker.napName}: ${err.message}`);
          loadNapsData();
        }
      });

      // Bind detail popup
      marker.bindPopup(() => getPopupContent(nap));
      if (markerClusterGroup) {
        markerClusterGroup.addLayer(marker);
      } else {
        marker.addTo(map);
      }
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
  
  // Re-draw topology lines if enabled
  drawTopologyLines();
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
        <div class="map-popup-client-info">
          <span class="client-status-dot ${statusClass}"></span>
          <span class="client-name" title="${c.name}">${c.name}</span>
        </div>
        <button class="btn-diagnostic-onu" data-sn="${c.sn}" title="⚡ Diagnóstico Óptico en Vivo">
          <i class="fa-solid fa-gauge-high"></i>
        </button>
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
      } else if (payload.event === 'status_history_deleted' && payload.data) {
        handleDeletedHistoryEvent(payload.data.id);
      } else if (payload.event === 'status_history_cleared' && payload.data) {
        handleClearedHistoryEvent(payload.data.mode);
      } else if (payload.event === 'status_history_updated' && payload.data) {
        handleUpdatedHistoryEvent(payload.data);
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
    if (markerClusterGroup) {
      markerClusterGroup.addLayer(newMarker);
    } else {
      newMarker.addTo(map);
    }
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

  const clearBtn = document.getElementById('btn-clear-history');

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

  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      const pendingCount = historyData.filter(i => !i.resolved).length;
      const msg = pendingCount > 0
        ? `¿Qué deseas borrar del historial?\n\n• Cancelar: No hacer nada\n• Aceptar: Se eliminarán los eventos del historial.`
        : '¿Estás seguro de que deseas limpiar el historial de notificaciones?';
      
      if (confirm(msg)) {
        clearHistoryNotifications('all');
      }
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
    const res = await fetch('/webhook/history?limit=500');
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
    const pendingCount = historyData.filter(i => !i.resolved).length;
    badge.textContent = pendingCount > 0 ? pendingCount : historyData.length;
    if (pendingCount > 0) {
      badge.style.background = '#EF4444';
      badge.style.color = '#FFFFFF';
    } else {
      badge.style.background = 'var(--accent-color)';
      badge.style.color = 'var(--bg-primary)';
    }
  }
}

/**
 * Handle a real-time incoming status history event from WebSocket.
 */
function handleNewHistoryEvent(newEvent) {
  // If recovery event, mark matching previous items as resolved
  if (newEvent.failureType === 'recovery' && newEvent.sn) {
    const targetSn = newEvent.sn.toUpperCase();
    historyData.forEach(item => {
      if (item.sn && item.sn.toUpperCase() === targetSn) {
        item.resolved = true;
      }
    });
  }

  historyData.unshift(newEvent);
  if (historyData.length > 5000) historyData.pop();
  
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
 * Handle single history item deleted via WebSocket.
 */
function handleDeletedHistoryEvent(id) {
  historyData = historyData.filter(item => item.id !== id);
  updateHistoryBadge();
  renderHistoryList();
}

/**
 * Handle cleared history via WebSocket.
 */
function handleClearedHistoryEvent(mode) {
  if (mode === 'resolved') {
    historyData = historyData.filter(item => !item.resolved);
  } else {
    historyData = [];
  }
  updateHistoryBadge();
  renderHistoryList();
}

/**
 * Handle updated/resolved history item via WebSocket.
 */
function handleUpdatedHistoryEvent(updated) {
  const index = historyData.findIndex(item => item.id === updated.id);
  if (index !== -1) {
    historyData[index] = updated;
    updateHistoryBadge();
    renderHistoryList();
  }
}

/**
 * Delete a specific notification from history via API.
 */
async function deleteHistoryNotification(id) {
  try {
    const res = await fetch(`/webhook/history/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    historyData = historyData.filter(i => i.id !== id);
    updateHistoryBadge();
    renderHistoryList();
  } catch (err) {
    console.error('Error deleting history notification:', err);
    alert('No se pudo eliminar la notificación: ' + err.message);
  }
}

/**
 * Mark a notification as resolved/solved via API.
 */
async function resolveHistoryNotification(id) {
  try {
    const res = await fetch(`/webhook/history/${encodeURIComponent(id)}/resolve`, { method: 'PATCH' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const item = historyData.find(i => i.id === id);
    if (item) {
      item.resolved = true;
      item.resolvedAt = new Date().toISOString();
      updateHistoryBadge();
      renderHistoryList();
    }
  } catch (err) {
    console.error('Error resolving history notification:', err);
    alert('No se pudo marcar como solucionado: ' + err.message);
  }
}

/**
 * Clear history notifications via API.
 */
async function clearHistoryNotifications(mode = 'all') {
  try {
    const res = await fetch(`/webhook/history?mode=${encodeURIComponent(mode)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (mode === 'resolved') {
      historyData = historyData.filter(i => !i.resolved);
    } else {
      historyData = [];
    }
    updateHistoryBadge();
    renderHistoryList();
  } catch (err) {
    console.error('Error clearing history:', err);
    alert('No se pudo limpiar el historial: ' + err.message);
  }
}

/**
 * Render the history timeline cards inside the Drawer.
 */
function renderHistoryList() {
  const listContainer = document.getElementById('history-list');
  if (!listContainer) return;

  const filtered = historyData.filter(item => {
    // 1. Filter by category / resolution chip
    if (activeHistoryFilter === 'pending') {
      if (item.resolved) return false;
    } else if (activeHistoryFilter === 'resolved') {
      if (!item.resolved) return false;
    } else if (activeHistoryFilter !== 'all') {
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
    listContainer.innerHTML = '<li class="no-results">No hay eventos en el historial con este filtro.</li>';
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
    const isResolved = Boolean(item.resolved);

    li.innerHTML = `
      <div class="history-item-top">
        <span class="history-type-badge ${item.failureType}">
          ${iconHtml} ${item.failureLabel}
        </span>
        <div style="display: flex; align-items: center; gap: 8px;">
          ${isResolved ? '<span class="history-resolved-tag"><i class="fa-solid fa-circle-check"></i> Solucionado</span>' : '<span class="history-pending-tag"><i class="fa-solid fa-bell"></i> Activo</span>'}
          <span class="history-timestamp" title="${item.formattedTime}">
            <i class="fa-regular fa-clock"></i> ${timeAgo}
          </span>
        </div>
      </div>
      <div class="history-main-info">
        <div class="history-nap-row">
          <span class="history-nap-tag">
            <i class="fa-solid fa-box-archive"></i>
            ${item.napName}
          </span>
        </div>
        <div class="history-client-tag">
          👤 <b>${item.onuName}</b> (<code>${item.sn}</code>)
        </div>
        <div class="history-status-transition">
          <b>Transición:</b> <span>${item.previousStatus} ➔ <b>${item.newStatus}</b></span>
        </div>
        ${item.reason ? `<div class="history-reason-text">📝 ${item.reason}</div>` : ''}
      </div>
      <div class="history-card-actions">
        <div class="history-card-btns">
          ${(item.latitude !== null && item.longitude !== null) ? `
            <button class="btn-locate-history" data-nap="${item.napName}" data-lat="${item.latitude}" data-lng="${item.longitude}" title="Centrar en el mapa">
              <i class="fa-solid fa-location-dot"></i> Ver en mapa
            </button>
          ` : ''}
          ${!isResolved ? `
            <button class="btn-resolve-history" data-id="${item.id}" title="Marcar como solucionado">
              <i class="fa-solid fa-check"></i> Solucionar
            </button>
          ` : ''}
        </div>
        <button class="btn-delete-history" data-id="${item.id}" title="Borrar notificación del historial">
          <i class="fa-solid fa-trash-can"></i> Borrar
        </button>
      </div>
    `;

    const locateBtn = li.querySelector('.btn-locate-history');
    if (locateBtn) {
      locateBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        focusNapOnMap(item.napName, item.latitude, item.longitude);
      });
    }

    const resolveBtn = li.querySelector('.btn-resolve-history');
    if (resolveBtn) {
      resolveBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        resolveHistoryNotification(item.id);
      });
    }

    const deleteBtn = li.querySelector('.btn-delete-history');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteHistoryNotification(item.id);
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

// ==========================================
// Map Controls & Advanced Features Setup
// ==========================================

function setupMapControls() {
  // 1. Layer Selector Dropdown Click Toggle
  const layerDropdownBtn = document.getElementById('btn-layer-dropdown');
  const layerDropdownContent = document.getElementById('layer-dropdown-content');

  if (layerDropdownBtn && layerDropdownContent) {
    layerDropdownBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      layerDropdownContent.classList.toggle('hidden');
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('.map-layer-selector')) {
        layerDropdownContent.classList.add('hidden');
      }
    });

    // Layer option click handler
    const options = layerDropdownContent.querySelectorAll('.layer-option');
    options.forEach(opt => {
      opt.addEventListener('click', () => {
        const layerName = opt.dataset.layer;
        switchBaseLayer(layerName);
        layerDropdownContent.classList.add('hidden');
      });
    });

    // Select initial active option class
    const savedLayer = localStorage.getItem('map_active_layer') || 'google_hybrid';
    options.forEach(opt => {
      if (opt.dataset.layer === savedLayer) {
        opt.classList.add('active');
      } else {
        opt.classList.remove('active');
      }
    });
  }

  // 2. Topology PON Toggle
  const topologyBtn = document.getElementById('btn-topology-toggle');
  if (topologyBtn) {
    // Restore state from localStorage if preset
    const savedTopology = localStorage.getItem('map_topology_enabled');
    topologyEnabled = savedTopology === 'true';
    if (topologyEnabled) {
      topologyBtn.classList.add('active-control');
    }

    topologyBtn.addEventListener('click', () => {
      topologyEnabled = !topologyEnabled;
      localStorage.setItem('map_topology_enabled', topologyEnabled);
      topologyBtn.classList.toggle('active-control', topologyEnabled);
      drawTopologyLines();
    });
  }

  // 3. Draggable Pins Toggle
  const dragBtn = document.getElementById('btn-drag-toggle');
  if (dragBtn) {
    dragBtn.addEventListener('click', () => {
      draggablePinsEnabled = !draggablePinsEnabled;
      dragBtn.classList.toggle('active-control', draggablePinsEnabled);
      
      const icon = dragBtn.querySelector('i');
      if (icon) {
        icon.className = draggablePinsEnabled ? 'fa-solid fa-lock-open' : 'fa-solid fa-lock';
      }

      setupDraggableMarkers();
    });
  }

  // 4. Ruler Distance Measurement Toggle
  const rulerBtn = document.getElementById('btn-ruler-toggle');
  const rulerOverlay = document.getElementById('ruler-overlay');
  const cancelRulerBtn = document.getElementById('cancel-ruler');
  const clearRulerBtn = document.getElementById('clear-ruler');

  if (rulerBtn) {
    rulerBtn.addEventListener('click', () => {
      rulerEnabled = !rulerEnabled;
      rulerBtn.classList.toggle('active-control', rulerEnabled);
      
      if (rulerEnabled) {
        if (placingNapName) stopManualPlacement();
        rulerOverlay.classList.remove('hidden');
        document.getElementById('map').style.cursor = 'crosshair';
        map.on('click', handleRulerMapClick);
        map.on('mousemove', handleRulerMouseMove);
      } else {
        disableRulerMode();
      }
    });
  }

  if (cancelRulerBtn) {
    cancelRulerBtn.addEventListener('click', () => {
      rulerEnabled = false;
      if (rulerBtn) rulerBtn.classList.remove('active-control');
      disableRulerMode();
    });
  }

  if (clearRulerBtn) {
    clearRulerBtn.addEventListener('click', clearRuler);
  }

  // 5. Diagnostics Modal Close Handlers
  const diagnosticModal = document.getElementById('diagnostic-modal');
  const closeDiagBtn = document.getElementById('btn-close-diagnostic');
  if (diagnosticModal && closeDiagBtn) {
    closeDiagBtn.addEventListener('click', () => {
      diagnosticModal.classList.add('hidden');
    });

    // Close on outside click
    diagnosticModal.addEventListener('click', (e) => {
      if (e.target === diagnosticModal) {
        diagnosticModal.classList.add('hidden');
      }
    });
  }
}

/**
 * Switch base map tile layer.
 */
function switchBaseLayer(layerName) {
  if (!baseLayers[layerName]) return;

  // Remove current layer
  map.removeLayer(baseLayers[activeLayerName]);
  
  // Add new layer
  baseLayers[layerName].addTo(map);
  activeLayerName = layerName;
  
  localStorage.setItem('map_active_layer', layerName);
}

/**
 * Enable/disable draggable status on all markers.
 */
function setupDraggableMarkers() {
  Object.entries(markers).forEach(([name, marker]) => {
    if (draggablePinsEnabled) {
      marker.dragging.enable();
      // Add a CSS class or visual indicator to show pins are movable
      const element = marker.getElement();
      if (element) element.classList.add('movable-pin');
    } else {
      marker.dragging.disable();
      const element = marker.getElement();
      if (element) element.classList.remove('movable-pin');
    }
  });

  // Change cursor style on map
  const mapContainer = document.getElementById('map');
  if (draggablePinsEnabled) {
    mapContainer.classList.add('pins-draggable');
  } else {
    mapContainer.classList.remove('pins-draggable');
  }
}

/**
 * Draw topology lines connecting NAPs on the same PON port.
 */
function drawTopologyLines() {
  if (!topologyLayerGroup) return;

  // Clear existing lines
  topologyLayerGroup.clearLayers();

  if (!topologyEnabled) return;

  // Group NAPs by OLT & Slot/Port
  const groups = {};
  napsData.forEach(nap => {
    if (nap.latitude === null || nap.longitude === null) return;
    const key = `${nap.olt_name || 'unknown'}_${nap.board || '0'}_${nap.port || '0'}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(nap);
  });

  // Draw lines within each group
  Object.entries(groups).forEach(([key, naps]) => {
    if (naps.length < 2) return;

    // Sort NAPs sequentially by longitude (makes a nice span sequence)
    naps.sort((a, b) => a.longitude - b.longitude);

    const color = getPonColor(naps[0].olt_name, naps[0].board, naps[0].port);

    for (let i = 0; i < naps.length - 1; i++) {
      const napA = naps[i];
      const napB = naps[i + 1];

      const latlngs = [
        [napA.latitude, napA.longitude],
        [napB.latitude, napB.longitude]
      ];

      const polyline = L.polyline(latlngs, {
        color: color,
        weight: 5,
        dashArray: '12, 10',
        opacity: 0.85,
        className: `pon-line line-${napA.olt_name.replace(/\s+/g, '-')}-${napA.board}-${napA.port}`
      });

      // Show PON port details on hover
      polyline.bindTooltip(
        `<b>Enlace de Fibra PON</b><br>` +
        `🏢 <b>OLT:</b> ${napA.olt_name}<br>` +
        `🔌 <b>Puerto:</b> Slot ${napA.board} | Pon ${napA.port}<br>` +
        `📦 <b>Tramo:</b> ${napA.name} &harr; ${napB.name}`,
        { sticky: true, className: 'topology-tooltip' }
      );

      // Highlights lines of the same port when hovered
      polyline.on('mouseover', () => {
        polyline.setStyle({ weight: 8, opacity: 1, dashArray: null });
      });

      polyline.on('mouseout', () => {
        polyline.setStyle({ weight: 5, opacity: 0.85, dashArray: '12, 10' });
      });

      topologyLayerGroup.addLayer(polyline);
    }
  });
}

/**
 * Generate a deterministic HSL color based on OLT + PON port string.
 */
function getPonColor(oltName, board, port) {
  const str = `${oltName}_${board}_${port}`;
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = Math.abs(hash % 360);
  return `hsl(${h}, 85%, 60%)`;
}

// ─── Ruler Measurement Mechanics ─────────────────────────────────────────────

function disableRulerMode() {
  rulerEnabled = false;
  document.getElementById('ruler-overlay').classList.add('hidden');
  document.getElementById('map').style.cursor = '';
  map.off('click', handleRulerMapClick);
  map.off('mousemove', handleRulerMouseMove);
  clearRuler();
}

function handleRulerMapClick(e) {
  const latlng = e.latlng;
  rulerPoints.push(latlng);

  // Draw point marker
  const marker = L.circleMarker(latlng, {
    radius: 6,
    color: 'var(--accent-color)',
    fillColor: '#FFFFFF',
    fillOpacity: 1,
    weight: 2
  }).addTo(map);
  
  rulerMarkers.push(marker);

  // If there's a previous point, draw polyline
  if (rulerPoints.length > 1) {
    const prevPoint = rulerPoints[rulerPoints.length - 2];
    const segmentDistance = prevPoint.distanceTo(latlng);
    const totalDistance = calculateRulerTotalDistance();

    const polyline = L.polyline([prevPoint, latlng], {
      color: 'var(--accent-color)',
      weight: 3,
      dashArray: '5, 5'
    }).addTo(map);

    rulerPolylines.push(polyline);

    // Bind tooltip showing segment length
    let distText = segmentDistance < 1000 ? `${segmentDistance.toFixed(1)} m` : `${(segmentDistance/1000).toFixed(2)} km`;
    let accumText = totalDistance < 1000 ? `${totalDistance.toFixed(1)} m` : `${(totalDistance/1000).toFixed(2)} km`;
    
    polyline.bindTooltip(`Segmento: ${distText}<br>Acumulado: ${accumText}`, { permanent: false, sticky: true });
    
    // Update marker tooltip
    marker.bindTooltip(`Punto ${rulerPoints.length}<br>Distancia: ${accumText}`, { permanent: true, direction: 'top' });
  } else {
    marker.bindTooltip(`Inicio`, { permanent: true, direction: 'top' });
  }

  // Reset mousemove temp polyline
  if (rulerTempPolyline) {
    map.removeLayer(rulerTempPolyline);
    rulerTempPolyline = null;
  }

  updateRulerDistanceUI();
}

function handleRulerMouseMove(e) {
  if (rulerPoints.length === 0) return;

  const lastPoint = rulerPoints[rulerPoints.length - 1];
  const currentMouse = e.latlng;

  if (rulerTempPolyline) {
    rulerTempPolyline.setLatLngs([lastPoint, currentMouse]);
  } else {
    rulerTempPolyline = L.polyline([lastPoint, currentMouse], {
      color: 'var(--accent-color)',
      weight: 2,
      dashArray: '3, 6',
      opacity: 0.6
    }).addTo(map);
  }
}

function calculateRulerTotalDistance() {
  let total = 0;
  for (let i = 0; i < rulerPoints.length - 1; i++) {
    total += rulerPoints[i].distanceTo(rulerPoints[i + 1]);
  }
  return total;
}

function updateRulerDistanceUI() {
  const total = calculateRulerTotalDistance();
  const uiEl = document.getElementById('ruler-total-distance');
  if (uiEl) {
    uiEl.textContent = total < 1000 ? `${total.toFixed(1)} m` : `${(total / 1000).toFixed(2)} km`;
  }
}

function clearRuler() {
  rulerPoints = [];
  
  rulerPolylines.forEach(line => map.removeLayer(line));
  rulerPolylines = [];
  
  rulerMarkers.forEach(m => map.removeLayer(m));
  rulerMarkers = [];
  
  if (rulerTempPolyline) {
    map.removeLayer(rulerTempPolyline);
    rulerTempPolyline = null;
  }

  const uiEl = document.getElementById('ruler-total-distance');
  if (uiEl) uiEl.textContent = '0 m';
}

// ─── Real-Time ONU Optical Signal Diagnostics Panel ─────────────────────────

async function showOnuDiagnostics(sn) {
  const modal = document.getElementById('diagnostic-modal');
  const body = document.getElementById('diagnostic-body');

  if (!modal || !body) return;

  // Show Modal
  modal.classList.remove('hidden');

  // Loading spinner
  body.innerHTML = `
    <div class="diagnostic-loading">
      <i class="fa-solid fa-spinner fa-spin"></i>
      <p>Consultando potencia óptica en tiempo real...</p>
      <span style="font-size:11px; color:var(--text-muted)">SN: <code>${sn}</code></span>
    </div>
  `;

  try {
    const res = await fetch(`/webhook/onu/sn/${sn}/status`);
    if (!res.ok) {
      const errData = await res.json();
      throw new Error(errData.error || `HTTP Error ${res.status}`);
    }

    const data = await res.json();
    console.log('📡 Live diagnostic data received:', data);

    const live = data.live || {};
    const rx = parseFloat(live.rx_power);
    const tx = parseFloat(live.tx_power);
    const oltRx = parseFloat(live.olt_rx_power);
    
    // Color categorization of signal levels
    let rxClass = 'good';
    let rxLabel = 'Excelente';
    if (isNaN(rx) || rx === 0) {
      rxClass = 'critical';
      rxLabel = 'Sin señal';
    } else if (rx < -30) {
      rxClass = 'critical';
      rxLabel = 'Falla Grave';
    } else if (rx < -27) {
      rxClass = 'warning';
      rxLabel = 'Señal Baja';
    }

    // Format metrics
    const formattedRx = isNaN(rx) || rx === 0 ? 'N/A' : `${rx.toFixed(2)} dBm`;
    const formattedTx = isNaN(tx) || tx === 0 ? 'N/A' : `${tx.toFixed(2)} dBm`;
    const formattedOltRx = isNaN(oltRx) || oltRx === 0 ? 'N/A' : `${oltRx.toFixed(2)} dBm`;
    const temp = live.temperature ? `${parseFloat(live.temperature).toFixed(1)} °C` : 'N/A';
    const volt = live.voltage ? `${parseFloat(live.voltage).toFixed(2)} V` : 'N/A';
    const bias = live.bias_current ? `${parseFloat(live.bias_current).toFixed(1)} mA` : 'N/A';
    const dist = live.distance ? `${live.distance} m` : 'N/A';

    const lastDown = live.last_down_time || 'N/A';
    const downReason = live.last_down_reason || 'N/A';

    const statusDot = live.status.toLowerCase() === 'online' || live.status.toLowerCase() === 'active' ? '🟢' : '🔴';

    body.innerHTML = `
      <div class="diagnostic-panel-content">
        <!-- Client header -->
        <div class="diag-header-info">
          <h3>${data.name}</h3>
          <span>SN: <code>${data.sn}</code></span>
        </div>

        <div class="diag-status-badge">
          <span>OLT Hardware Status:</span>
          <b>${statusDot} ${live.status.toUpperCase()}</b>
        </div>

        <!-- Connection details -->
        <div class="diag-meta-grid">
          <div><b>OLT:</b> ${data.olt_name}</div>
          <div><b>Puerto PON:</b> Slot ${data.board} | Pon ${data.port}</div>
          <div><b>ONU ID:</b> ${data.onu_id}</div>
          <div><b>Caja NAP:</b> ${data.address || 'N/A'}</div>
        </div>

        <!-- Optical Power Progress Visualizer -->
        <div class="optical-level-card ${rxClass}">
          <div class="optical-level-header">
            <span>Potencia Óptica de Recepción (Rx Power)</span>
            <strong class="rx-val">${formattedRx}</strong>
          </div>
          ${getSignalProgressBarHtml(rx)}
          <span class="optical-level-label">Categoría: <b>${rxLabel}</b> (Rango sugerido: -15 a -27 dBm)</span>
        </div>

        <!-- Metric details grid -->
        <div class="metrics-grid">
          <div class="metric-item">
            <span class="m-label"><i class="fa-solid fa-cloud-arrow-up"></i> Potencia Tx ONU</span>
            <span class="m-val">${formattedTx}</span>
          </div>
          <div class="metric-item">
            <span class="m-label"><i class="fa-solid fa-server"></i> Potencia Rx OLT</span>
            <span class="m-val">${formattedOltRx}</span>
          </div>
          <div class="metric-item">
            <span class="m-label"><i class="fa-solid fa-thermometer"></i> Temperatura</span>
            <span class="m-val">${temp}</span>
          </div>
          <div class="metric-item">
            <span class="m-label"><i class="fa-solid fa-bolt"></i> Voltaje</span>
            <span class="m-val">${volt}</span>
          </div>
          <div class="metric-item">
            <span class="m-label"><i class="fa-solid fa-gauge"></i> Corriente Bias</span>
            <span class="m-val">${bias}</span>
          </div>
          <div class="metric-item">
            <span class="m-label"><i class="fa-solid fa-road"></i> Distancia OLT</span>
            <span class="m-val">${dist}</span>
          </div>
        </div>

        <!-- Connection history / failure log -->
        <div class="diag-history-box">
          <h4><i class="fa-solid fa-clock-rotate-left"></i> Registro de Desconexión</h4>
          <div class="diag-history-row">
            <span>Última Caída:</span>
            <b><code>${lastDown}</code></b>
          </div>
          <div class="diag-history-row">
            <span>Motivo Caída:</span>
            <b><span class="reason-tag">${downReason}</span></b>
          </div>
        </div>

        <!-- Optical Power History Chart -->
        <div class="diag-chart-box" style="margin-top: 15px;">
          <h4 style="font-size: 11px; color: var(--text-muted); text-transform: uppercase; margin-bottom: 8px; font-weight: 600; display: flex; align-items: center; gap: 6px; margin: 0 0 8px 0;">
            <i class="fa-solid fa-chart-line"></i> Historial de Niveles Ópticos (Rx)
          </h4>
          <div style="position: relative; height: 180px; width: 100%;">
            <canvas id="optical-history-chart"></canvas>
          </div>
        </div>

        <div class="diag-footer" style="margin-top: 15px;">
          <button id="btn-refresh-diag" data-sn="${sn}" class="btn-primary">
            <i class="fa-solid fa-arrows-rotate"></i> Actualizar
          </button>
        </div>
      </div>
    `;

    // Render historical optical chart
    renderOpticalHistoryChart(sn);

    // Bind refresh button click
    document.getElementById('btn-refresh-diag').addEventListener('click', () => {
      showOnuDiagnostics(sn);
    });

  } catch (err) {
    console.error('Diagnostic error:', err);
    body.innerHTML = `
      <div class="diagnostic-error">
        <i class="fa-solid fa-triangle-exclamation"></i>
        <p>No se pudo completar el diagnóstico en vivo.</p>
        <span class="err-details">${err.message}</span>
        <button id="btn-retry-diag" data-sn="${sn}" class="btn-primary" style="margin-top:15px">
          <i class="fa-solid fa-arrows-rotate"></i> Reintentar
        </button>
      </div>
    `;

    document.getElementById('btn-retry-diag').addEventListener('click', () => {
      showOnuDiagnostics(sn);
    });
  }
}

/**
 * Format HTML progress bar representing signal intensity.
 */
function getSignalProgressBarHtml(rx) {
  if (isNaN(rx) || rx === 0 || rx > 0) {
    return `<div class="diag-progress-bar"><div class="bar-fill" style="width: 0%"></div></div>`;
  }

  // Map -40 dBm (0%) to -10 dBm (100%)
  const minVal = -40;
  const maxVal = -10;
  let pct = ((rx - minVal) / (maxVal - minVal)) * 100;
  pct = Math.max(0, Math.min(pct, 100));

  return `
    <div class="diag-progress-bar">
      <div class="bar-fill" style="width: ${pct}%"></div>
    </div>
  `;
}

/**
 * Fetch and render the Chart.js optical history graph.
 */
async function renderOpticalHistoryChart(sn) {
  try {
    const res = await fetch(`/webhook/onu/sn/${sn}/optical-history`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const history = data.history || [];

    const ctx = document.getElementById('optical-history-chart');
    if (!ctx) return;

    if (opticalChart) {
      opticalChart.destroy();
      opticalChart = null;
    }

    if (history.length === 0) {
      // Draw a "no data" message inside canvas
      const ctx2d = ctx.getContext('2d');
      ctx2d.font = '12px Outfit, sans-serif';
      ctx2d.fillStyle = 'rgba(255,255,255,0.4)';
      ctx2d.textAlign = 'center';
      ctx2d.textBaseline = 'middle';
      ctx2d.fillText('No hay historial de potencia óptica registrado.', ctx.width / 2, ctx.height / 2);
      return;
    }

    const labels = history.map(item => {
      const date = new Date(item.timestamp);
      return date.toLocaleDateString('es-EC', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    });
    
    const rxData = history.map(item => item.rx_power);

    // Create Line Chart
    opticalChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{
          label: 'Potencia Rx (dBm)',
          data: rxData,
          borderColor: '#38BDF8',
          backgroundColor: 'rgba(56, 189, 248, 0.15)',
          fill: true,
          tension: 0.3,
          borderWidth: 2,
          pointBackgroundColor: '#FFFFFF',
          pointBorderColor: '#38BDF8',
          pointRadius: 4,
          pointHoverRadius: 6
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: function(context) {
                return ` Rx: ${context.parsed.y.toFixed(2)} dBm`;
              }
            }
          }
        },
        scales: {
          x: {
            ticks: { color: 'rgba(255,255,255,0.4)', font: { size: 9, family: 'Outfit' } },
            grid: { color: 'rgba(255,255,255,0.05)' }
          },
          y: {
            ticks: { color: 'rgba(255,255,255,0.4)', font: { size: 9, family: 'Outfit' } },
            grid: { color: 'rgba(255,255,255,0.05)' },
            suggestedMin: -35,
            suggestedMax: -15
          }
        }
      }
    });
  } catch (err) {
    console.error('Error rendering optical chart:', err);
  }
}

