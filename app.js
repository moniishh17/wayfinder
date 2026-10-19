const CHENNAI = [13.0827, 80.2707];
const $ = (id) => document.getElementById(id);
const map = L.map('map', { scrollWheelZoom: false }).setView(CHENNAI, 13);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>'
}).addTo(map);

const layers = { stops: L.layerGroup().addTo(map), metro: L.layerGroup().addTo(map), endpoints: L.layerGroup().addTo(map), route: L.layerGroup().addTo(map) };
let data, stopById = new Map(), routesByStop = new Map(), routeIndex = new WeakMap();
let endpoints = null, currentOptions = [], selectedOption = null, footSteps = [], stepCursor = 0;
let audioMode = false, recognizer = null, cameraStream = null, detector = null, detecting = false;
let previousAlert = '', previousAlertAt = 0, lastProximityWarningAt = 0, toastTimer = 0;

function vibrate(pattern) {
  const enabled = $('haptic-toggle')?.checked ?? true;
  if (enabled && 'vibrate' in navigator) {
    try { navigator.vibrate(pattern); } catch {}
  }
}

function toast(message) {
  const node = $('toast'); node.textContent = message; node.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => node.classList.remove('show'), 3200);
}
function say(message) {
  if (!('speechSynthesis' in window)) { toast('Speech output is unavailable in this browser.'); return; }
  speechSynthesis.cancel(); const utterance = new SpeechSynthesisUtterance(message); utterance.lang = 'en-IN'; utterance.rate = 0.94; speechSynthesis.speak(utterance);
}
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }
function distanceKm(a, b) {
  const rad = n => n * Math.PI / 180, dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
function point(lat, lon) { return { lat: Number(lat), lon: Number(lon) }; }
function accessLabel(stop) {
  if (stop.wheelchair === '1') return { label: 'GTFS lists step-free boarding', cls: 'good' };
  if (stop.wheelchair === '2') return { label: 'GTFS marks boarding inaccessible', cls: 'bad' };
  return { label: 'Boarding access unknown in GTFS', cls: 'unknown' };
}
function feedWarnings() {
  const end = data.feedDateRange?.end || 'not supplied';
  const start = data.feedDateRange?.start || 'not supplied';
  $('data-status').textContent = `Loaded ${data.stops.length.toLocaleString()} Chennai stops and ${data.routes.length.toLocaleString()} MTC route patterns. The community GTFS feed states ${start} to ${end}, so route patterns are historical references, not a current service promise. No live arrival feed is connected.`;
}
function indexTransit() {
  data.stops.forEach(stop => stopById.set(stop.id, stop));
  data.routes.forEach(route => {
    const indexes = new Map();
    route.stops.forEach((id, i) => {
      if (!indexes.has(id)) indexes.set(id, i);
      if (!routesByStop.has(id)) routesByStop.set(id, []);
      routesByStop.get(id).push(route);
    });
    routeIndex.set(route, indexes);
  });
}
function renderMetroStations() {
  layers.metro.clearLayers();
  (data.metroLines || []).forEach(line => line.stations.forEach(station => {
    const marker = L.circleMarker([station.lat, station.lon], { radius: 5, color: '#fff', weight: 1, fillColor: line.id === 'blue' ? '#2876a6' : '#397c58', fillOpacity: .95 });
    marker.bindPopup(`<strong>${escapeHtml(station.name)} Metro</strong><br>${line.name}<br><small>CMRL station coordinates from Chennai GTFS</small>`).addTo(layers.metro);
  }));
}
function renderNearbyStops(center = point(...CHENNAI), limit = 130) {
  layers.stops.clearLayers();
  const centers = Array.isArray(center) ? center : [center];
  data.stops.map(stop => ({ stop, d: Math.min(...centers.map(point => distanceKm(point, stop))) })).filter(x => x.d < 2.2).sort((a, b) => a.d - b.d).slice(0, limit).forEach(({stop}) => {
    const marker = L.circleMarker([stop.lat, stop.lon], { radius: 4, color: '#286e58', weight: 1, fillColor: '#55a787', fillOpacity: .84 });
    marker.bindPopup(`<strong>${escapeHtml(stop.name)}</strong><br>${escapeHtml(accessLabel(stop).label)}<br><small>Community GTFS · MTC</small>`);
    marker.addTo(layers.stops);
  });
}
function nearestStops(location, limit = 8, maxKm = 2.5) {
  return data.stops.map(stop => ({ stop, d: distanceKm(location, stop) }))
    .filter(item => item.d <= maxKm).sort((a, b) => a.d - b.d).slice(0, limit);
}
function addOption(segments, start, end) {
  const transfers = segments.length - 1;
  const walkKm = start.d + end.d;
  const routeKey = segments.map(s => s.route.id + ':' + s.board.id + ':' + s.alight.id).join('|');
  if (currentOptions.some(option => option.key === routeKey)) return;
  const stopsStatus = segments.flatMap(s => [s.board, s.alight]).map(accessLabel);
  const hasKnownBarrier = stopsStatus.some(status => status.cls === 'bad');
  if (hasKnownBarrier && $('access-profile').value === 'stepfree') return;
  currentOptions.push({ key: routeKey, segments, transfers, walkKm, score: walkKm + transfers * .45, statuses: stopsStatus, hasKnownBarrier });
}
function findBusOptions(from, to) {
  currentOptions = [];
  const starts = nearestStops(from, 6, 2.5), ends = nearestStops(to, 8, 2.5);
  const endIds = new Set(ends.map(x => x.stop.id));
  for (const origin of starts) {
    const routes = (routesByStop.get(origin.stop.id) || []).slice(0, 45);
    for (const route of routes) {
      const idx = routeIndex.get(route), boardIndex = idx?.get(origin.stop.id);
      if (boardIndex === undefined) continue;
      for (const dest of ends) {
        const alightIndex = idx.get(dest.stop.id);
        if (alightIndex !== undefined && alightIndex > boardIndex) addOption([{ route, board: origin.stop, alight: dest.stop, boardIndex, alightIndex }], origin, dest);
      }
    }
  }
  const transferStarts = starts.slice(0, 4);
  outer: for (const origin of transferStarts) {
    const firstRoutes = (routesByStop.get(origin.stop.id) || []).slice(0, 32);
    for (const first of firstRoutes) {
      const firstIdx = routeIndex.get(first), boardIndex = firstIdx?.get(origin.stop.id);
      if (boardIndex === undefined) continue;
      for (let i = boardIndex + 1; i < first.stops.length; i++) {
        const transfer = stopById.get(first.stops[i]);
        if (!transfer) continue;
        const nextRoutes = routesByStop.get(transfer.id) || [];
        for (const second of nextRoutes.slice(0, 16)) {
          if (second.id === first.id) continue;
          const secondIdx = routeIndex.get(second), transferIndex = secondIdx?.get(transfer.id);
          if (transferIndex === undefined) continue;
          for (const dest of ends) {
            const endIndex = secondIdx.get(dest.stop.id);
            if (endIndex !== undefined && endIndex > transferIndex) {
              addOption([
                { route: first, board: origin.stop, alight: transfer, boardIndex, alightIndex: i },
                { route: second, board: transfer, alight: dest.stop, boardIndex: transferIndex, alightIndex: endIndex }
              ], origin, dest);
              if (currentOptions.length >= 18) break outer;
            }
          }
        }
      }
    }
  }
  currentOptions.sort((a, b) => a.score - b.score || a.transfers - b.transfers);
  currentOptions = currentOptions.slice(0, 5);
  return currentOptions;
}
function findMetroOptions(from, to) {
  const lines = data.metroLines || [], starts = lines.flatMap(line => line.stations.map((station, index) => ({ line, station, index, d: distanceKm(from, station) }))).filter(item => item.d <= 5).sort((a, b) => a.d - b.d).slice(0, 5);
  const ends = lines.flatMap(line => line.stations.map((station, index) => ({ line, station, index, d: distanceKm(to, station) }))).filter(item => item.d <= 5).sort((a, b) => a.d - b.d).slice(0, 5);
  const options = [], seen = new Set();
  const add = (legs, start, end) => {
    const stationSequence = legs.flatMap((leg, index) => leg.stations.filter((station, stationIndex) => index === 0 || stationIndex > 0).map(station => normalizePlace(station.name)));
    const key = stationSequence.join('>');
    if (seen.has(key)) return; seen.add(key);
    const stationCount = legs.reduce((sum, leg) => sum + leg.stations.length - 1, 0);
    options.push({ kind: 'metro', legs, startDistance: start.d, endDistance: end.d, score: start.d + end.d + Math.max(0, legs.length - 1) * .5 + stationCount * .06, transfers: legs.length - 1 });
  };
  for (const start of starts) for (const end of ends) {
    if (start.line.id === end.line.id) {
      const step = end.index >= start.index ? 1 : -1;
      const stations = start.line.stations.slice(Math.min(start.index, end.index), Math.max(start.index, end.index) + 1);
      if (step < 0) stations.reverse();
      add([{ line: start.line, stations }], start, end);
    } else {
      for (let i = 0; i < start.line.stations.length; i++) {
        const interchange = start.line.stations[i];
        const otherIndex = end.line.stations.findIndex(station => station.name === interchange.name);
        if (otherIndex < 0) continue;
        const firstStep = i >= start.index ? 1 : -1, secondStep = end.index >= otherIndex ? 1 : -1;
        const first = start.line.stations.slice(Math.min(i, start.index), Math.max(i, start.index) + 1); if (firstStep < 0) first.reverse();
        const second = end.line.stations.slice(Math.min(otherIndex, end.index), Math.max(otherIndex, end.index) + 1); if (secondStep < 0) second.reverse();
        add([{ line: start.line, stations: first }, { line: end.line, stations: second }], start, end);
      }
    }
  }
  return options.sort((a, b) => a.score - b.score).slice(0, 3);
}
function selectMetroOption(option, card) {
  document.querySelectorAll('.route-card').forEach(node => node.classList.toggle('selected', node === card));
  layers.route.clearLayers(); const bounds = [];
  option.legs.forEach(leg => {
    const latlngs = leg.stations.map(station => [station.lat, station.lon]);
    L.polyline(latlngs, { color: leg.line.id === 'blue' ? '#2776a6' : '#3b835c', weight: 6, opacity: .88, dashArray: '6 4' }).addTo(layers.route);
    leg.stations.forEach(station => {
      const marker = L.circleMarker([station.lat, station.lon], { radius: 6, color: '#fff', weight: 2, fillColor: leg.line.id === 'blue' ? '#2776a6' : '#3b835c', fillOpacity: 1 });
      marker.bindPopup(`<strong>${escapeHtml(station.name)} Metro</strong><br>${leg.line.name}<br>${escapeHtml(accessLabel(station).label)}`).addTo(layers.route); bounds.push([station.lat, station.lon]);
    });
  });
  if (bounds.length) map.fitBounds(bounds, { padding: [45, 45], maxZoom: 14 });
  const detail = $('route-detail'); detail.hidden = false;
  detail.innerHTML = `<h3>Chennai Metro station sequence</h3><ol>${option.legs.map(leg => `<li>${leg.line.name}: ${leg.stations.map(station => escapeHtml(station.name)).join(' → ')}. Boarding access is unverified in this dataset.</li>`).join('')}</ol><p class="smallprint">Station order is from CMRL’s official Phase I station lists; coordinates are from the community GTFS extract. The line shown is a station-to-station schematic, not the track path. Check current train times, fares, elevator status, and station access with <a href="https://travelplanner.chennaimetrorail.org/" target="_blank" rel="noreferrer">CMRL’s official planner</a>.</p>`;
  if (audioMode) say(option.legs.map(leg => `${leg.line.name}, ${leg.stations.length} stations: ${leg.stations.map(station => station.name).join(', ')}.`).join(' Transfer at the interchange. '));
}
function renderMetroOptions(from, to) {
  const options = findMetroOptions(from, to);
  options.forEach((option, index) => {
    const card = document.createElement('button'); card.type = 'button'; card.className = 'route-card';
    const lineNames = option.legs.map(leg => leg.line.name).join(' → '), board = option.legs[0].stations[0], alight = option.legs.at(-1).stations.at(-1);
    const stations = option.legs.reduce((total, leg) => total + leg.stations.length - 1, 0);
    card.innerHTML = `<div class="route-card-head"><h3>Chennai Metro · ${escapeHtml(lineNames)}</h3><span class="route-type">CMRL Phase I</span></div><p>Board ${escapeHtml(board.name)} · alight ${escapeHtml(alight.name)} · ${stations} station intervals${option.transfers ? ` · ${option.transfers} interchange` : ''}</p><p class="smallprint">${(option.startDistance * 1000).toFixed(0)} m and ${(option.endDistance * 1000).toFixed(0)} m approximate straight-line access. No live train times or verified step-free station access.</p>`;
    card.addEventListener('click', () => selectMetroOption(option, card)); $('route-results').appendChild(card);
  });
  return options.length;
}
function segmentName(segment) {
  const route = segment.route;
  const routeLabel = route.short && route.short !== 'CMRL' ? `Route ${route.short}` : route.name || 'MTC bus';
  return `${routeLabel}${route.name ? ` — ${route.name}` : ''}`;
}
function optionAccessibility(option) {
  if (option.hasKnownBarrier) return 'GTFS marks at least one boarding stop inaccessible';
  if (option.statuses.every(status => status.cls === 'good')) return 'GTFS marks all listed stops as step-free';
  return 'Accessibility not confirmed for every boarding stop';
}
function renderTransitCards() {
  const results = $('route-results'); results.innerHTML = '';
  if (!currentOptions.length) return false;
  currentOptions.forEach((option, index) => {
    const card = document.createElement('button'); card.type = 'button'; card.className = 'route-card'; card.dataset.index = index;
    const heading = option.transfers ? `${option.segments.length} MTC buses · ${option.transfers} transfer` : `MTC bus · direct ride`;
    const lineNames = option.segments.map(segmentName).join(' → ');
    card.innerHTML = `<div class="route-card-head"><h3>${escapeHtml(heading)}</h3><span class="route-type">Historic GTFS pattern</span></div><p>${escapeHtml(lineNames)}</p><p>Board ${escapeHtml(option.segments[0].board.name)} · alight ${escapeHtml(option.segments.at(-1).alight.name)}</p><p class="smallprint">${escapeHtml(optionAccessibility(option))}. About ${(option.walkKm * 1000).toFixed(0)} m straight-line access walk, plus the ride.</p>`;
    card.addEventListener('click', () => selectOption(index)); results.appendChild(card);
  });
  return true;
}
function getChennaiWalkAdvisories(route, steps) {
  const advisories = [];
  const roadNames = steps.map(s => s.name || '').filter(Boolean).join(' ').toLowerCase();
  const arterialCorridors = [
    { pattern: /\b(anna salai|mount road)\b/i, name: 'Anna Salai (Mount Road)' },
    { pattern: /\b(poonamallee|evr periyar|evp)\b/i, name: 'Poonamallee High Road (EVR Periyar Salai)' },
    { pattern: /\b(gst|grand southern trunk)\b/i, name: 'GST Road' },
    { pattern: /\b(omr|old mahabalipuram|rajiv gandhi)\b/i, name: 'OMR (Rajiv Gandhi Salai)' },
    { pattern: /\b(100 feet|inner ring|jawaharlal nehru)\b/i, name: '100 Feet Road / Inner Ring Road' },
    { pattern: /\b(sardar patel)\b/i, name: 'Sardar Patel Road' },
    { pattern: /\b(kamarajar|marina)\b/i, name: 'Kamarajar Promenade' }
  ];
  const matchedArterials = arterialCorridors.filter(c => c.pattern.test(roadNames)).map(c => c.name);
  if (matchedArterials.length > 0) {
    advisories.push(`Intersects arterial corridor (${matchedArterials.join(', ')}). Heavy vehicular flow; prioritize footbridges or signalized pedestrian crossings.`);
  }
  if (route.distance > 1200) {
    advisories.push(`Extended walking distance (${formatDistance(route.distance)}) in Chennai climate. Consider MTC feeder or Metro connections.`);
  }
  advisories.push('Chennai street reality: watch for open storm-water drain (SWD) slabs, uneven curb cuts, and parked two-wheelers on pedestrian paths.');
  return advisories;
}

function renderDirections(route) {
  const steps = (route.legs || []).flatMap(leg => leg.steps || []).filter(step => step.distance > 8);
  footSteps = steps.map(step => {
    const name = step.name ? ` on ${step.name}` : '';
    const maneuver = step.maneuver?.instruction || step.maneuver?.type || 'Continue';
    return `${maneuver}${name} for ${formatDistance(step.distance)}.`;
  });
  if (!footSteps.length) footSteps = [`Walk ${formatDistance(route.distance)} along the pedestrian route shown on the map.`];
  const advisories = getChennaiWalkAdvisories(route, steps);
  const detail = $('route-detail'); detail.hidden = false;
  detail.innerHTML = `<h3>OpenStreetMap pedestrian route · ${formatDistance(route.distance)}</h3>
    <ol>${footSteps.slice(0, 6).map(step => `<li>${escapeHtml(step)}</li>`).join('')}</ol>
    <div class="advisory-box">
      <strong>⚠️ Chennai Pedestrian Safety Insights:</strong>
      <ul>${advisories.map(adv => `<li>${escapeHtml(adv)}</li>`).join('')}</ul>
    </div>
    <p class="smallprint">Pedestrian routing follows mapped foot-accessible streets; sidewalk, curb, slope, and obstacle conditions are not verified. Route timing is an estimate from the routing service.</p>
    <button type="button" class="outline-button" id="read-walk">Read walking directions aloud</button>`;
  $('read-walk').onclick = () => { stepCursor = 0; say(footSteps.slice(0, 6).join(' ')); };
}
function selectOption(index) {
  selectedOption = index; document.querySelectorAll('.route-card').forEach(card => card.classList.toggle('selected', Number(card.dataset.index) === index));
  const option = currentOptions[index]; if (!option) return;
  layers.route.clearLayers();
  const bounds = [];
  option.segments.forEach((segment, i) => {
    [segment.board, segment.alight].forEach((stop, j) => {
      const marker = L.circleMarker([stop.lat, stop.lon], { radius: 7, color: '#fff', weight: 2, fillColor: i ? '#9662a4' : (j ? '#cf8e33' : '#176b55'), fillOpacity: 1 });
      marker.bindPopup(`<strong>${escapeHtml(stop.name)}</strong><br>${escapeHtml(accessLabel(stop).label)}`).addTo(layers.route); bounds.push([stop.lat, stop.lon]);
    });
  });
  if (bounds.length) map.fitBounds(bounds, { padding: [45, 45], maxZoom: 14 });
  $('route-detail').hidden = false;
  $('route-detail').innerHTML = `<h3>Bus connection details</h3><ol>${option.segments.map((segment, i) => `<li>${escapeHtml(segmentName(segment))}: board at <strong>${escapeHtml(segment.board.name)}</strong>, leave at <strong>${escapeHtml(segment.alight.name)}</strong>. ${i < option.segments.length - 1 ? `Transfer at ${escapeHtml(segment.alight.name)}.` : ''} ${escapeHtml(accessLabel(segment.board).label)}; ${escapeHtml(accessLabel(segment.alight).label)}.</li>`).join('')}</ol><p class="smallprint">These route patterns are from an expired static feed; this app has no live bus positions, arrival estimates, service alerts, or confirmed ramp availability. Check <a href="https://mtcbus.tn.gov.in/Home/busservices" target="_blank" rel="noreferrer">official MTC services and tracking</a> before travel.</p>`;
  if (audioMode) say(option.segments.map(s => `${segmentName(s)}. Board at ${s.board.name}. Leave at ${s.alight.name}.`).join(' '));
}
function addEndpointMarkers(from, to) {
  layers.endpoints.clearLayers(); layers.route.clearLayers();
  const a = L.marker([from.lat, from.lon]).bindPopup(`<strong>Start:</strong> ${escapeHtml(from.name)}`).addTo(layers.endpoints);
  const b = L.marker([to.lat, to.lon]).bindPopup(`<strong>Destination:</strong> ${escapeHtml(to.name)}`).addTo(layers.endpoints);
  map.fitBounds(L.featureGroup([a, b]).getBounds().pad(.18)); renderNearbyStops([from, to]);
}
function normalizePlace(value) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim()
    .replace(/\b(chennai|tamil nadu|india|metro station|metro|railway station|station|bus terminus|bus stand)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
function resolveTransitPlace(query) {
  const normalized = normalizePlace(query);
  const aliases = [
    [/\b(central|mgr central|puratchi thalaivar.*central)\b/, 'Puratchi Thalaivar Dr. M.G. Ramachandran Central'],
    [/\b(airport|chennai international airport)\b/, 'Chennai International Airport'],
    [/\b(cmbt|koyambedu bus terminus)\b/, 'Puratchi Thalaivi Dr. J. Jayalalithaa CMBT']
  ];
  let target = normalized;
  for (const [pattern, stationName] of aliases) {
    if (pattern.test(normalized)) { target = normalizePlace(stationName); break; }
  }
  const stations = (data?.metroLines || []).flatMap(line => line.stations.map(station => ({
    ...station, label: `${station.name} Metro`, source: 'CMRL station'
  })));
  const stops = (data?.stops || []).map(stop => ({ ...stop, source: 'MTC stop' }));
  const candidates = [...stations, ...stops].map(place => {
    const label = normalizePlace(place.label || place.name);
    const exact = label === target;
    const contains = label.includes(target) || target.includes(label);
    const queryTokens = target.split(' ').filter(token => token.length > 2);
    const placeTokens = new Set(label.split(' '));
    const overlap = queryTokens.filter(token => placeTokens.has(token)).length;
    return { place, exact, contains, overlap, score: overlap / Math.max(queryTokens.length, 1) };
  }).filter(item => item.exact || item.contains || (item.overlap >= 2 && item.score >= .66))
    .sort((a, b) => Number(b.exact) - Number(a.exact) || Number(b.contains) - Number(a.contains) || b.score - a.score);
  const match = candidates[0]?.place;
  return match ? { lat: Number(match.lat), lon: Number(match.lon), name: `${match.name} · ${match.source}` } : null;
}
async function geocode(query) {
  const localMatch = resolveTransitPlace(query);
  if (localMatch) return localMatch;
  const response = await fetch(`/api/geocode?q=${encodeURIComponent(query)}`);
  if (!response.ok) throw new Error((await response.json()).error || 'Place search failed.');
  const matches = await response.json();
  if (!matches.length) throw new Error(`Could not find “${query}” inside the Chennai search area. Try a nearby landmark or transit stop.`);
  const match = matches[0]; return { lat: Number(match.lat), lon: Number(match.lon), name: match.display_name.split(',').slice(0, 3).join(',') };
}
async function requestFootRoute(from, to) {
  const query = new URLSearchParams({ fromLat: from.lat, fromLon: from.lon, toLat: to.lat, toLon: to.lon });
  const response = await fetch(`/api/pedestrian-route?${query}`);
  if (!response.ok) throw new Error((await response.json()).error || 'Pedestrian route unavailable.');
  const result = await response.json();
  if (!result.routes?.length) throw new Error('The pedestrian router found no route for this pair of places.');
  return result.routes[0];
}
async function planTrip(event) {
  event?.preventDefault(); const button = $('plan-button'); button.disabled = true; button.textContent = 'Looking up Chennai data…';
  $('result-count').textContent = 'Searching'; $('route-results').innerHTML = '<div class="empty-state"><strong>Searching real map and transit data…</strong><p>Place lookups are sent to OpenStreetMap. MTC route patterns are read from the bundled GTFS extract.</p></div>'; $('route-detail').hidden = true;
  try {
    const originText = $('origin').value.trim(), destinationText = $('destination').value.trim();
    if (!originText || !destinationText) throw new Error('Enter both a start and destination.');
    const from = await geocode(originText); const to = await geocode(destinationText);
    endpoints = { from, to }; addEndpointMarkers(from, to);
    const [walkResult, busOptions] = await Promise.allSettled([requestFootRoute(from, to), Promise.resolve(findBusOptions(from, to))]);
    const renderedBus = renderTransitCards();
    const metroCount = renderMetroOptions(from, to);
    if (walkResult.status === 'fulfilled') {
      const route = walkResult.value; const geometry = L.geoJSON(route.geometry, { style: { color: '#176da0', weight: 5, opacity: .88 } }).addTo(layers.route);
      map.fitBounds(geometry.getBounds().pad(.14));
      const walk = document.createElement('button'); walk.type = 'button'; walk.className = 'route-card'; walk.dataset.index = 'walk'; walk.innerHTML = `<div class="route-card-head"><h3>Pedestrian route · ${formatDistance(route.distance)}</h3><span class="route-type">OSM foot network</span></div><p>${Math.round(route.duration / 60)} min estimated by the pedestrian router. Wheelchair access, sidewalk quality, and crossings have not been verified.</p><p class="smallprint">No curb, sidewalk width, slope, surface, crossing, or live obstacle data in the route response.</p>`;
      walk.addEventListener('click', () => { document.querySelectorAll('.route-card').forEach(c => c.classList.toggle('selected', c === walk)); renderDirections(route); }); $('route-results').appendChild(walk);
    } else {
      const err = document.createElement('p'); err.className = 'smallprint'; err.textContent = `Pedestrian route unavailable: ${walkResult.reason.message}`; $('route-results').appendChild(err);
    }
    // Put current map-based options ahead of the expired MTC pattern examples.
    [...$('route-results').querySelectorAll('.route-card')]
      .filter(card => card.querySelector('.route-type')?.textContent.includes('Historic GTFS'))
      .forEach(card => $('route-results').appendChild(card));
    $('result-count').textContent = `${(renderedBus ? currentOptions.length : 0) + metroCount + (walkResult.status === 'fulfilled' ? 1 : 0)} choices`;
    $('map-caption').textContent = 'Mapped stops, selected route, and OSM pedestrian path';
    if (audioMode) say(`Found ${currentOptions.length} MTC route patterns, ${metroCount} metro options${walkResult.status === 'fulfilled' ? ', and a pedestrian route' : ''}. The bus feed is historical and there are no live arrivals in this app.`);
  } catch (error) {
    $('route-results').innerHTML = `<div class="empty-state"><strong>${escapeHtml(error.message)}</strong><p>Search is restricted to the Chennai region. Check the place name and try again.</p></div>`; $('result-count').textContent = 'No results'; if (audioMode) say(error.message);
  } finally { button.disabled = false; button.innerHTML = 'Find routes <span>→</span>'; }
}

async function loadTransit() {
  try {
    const response = await fetch('data/chennai-transit.json'); if (!response.ok) throw new Error('Transit data file could not be loaded.');
    data = await response.json(); indexTransit(); feedWarnings(); renderNearbyStops(); renderMetroStations();
  } catch (error) { $('data-status').textContent = `${error.message} Start the app with npm start from its project folder.`; }
}
$('route-form').addEventListener('submit', planTrip);
$('swap-locations').addEventListener('click', () => { const a = $('origin').value; $('origin').value = $('destination').value; $('destination').value = a; });
$('use-location').addEventListener('click', () => {
  if (!navigator.geolocation) return toast('Location is unavailable in this browser.');
  navigator.geolocation.getCurrentPosition(position => {
    const { latitude, longitude } = position.coords;
    if (latitude < 12.3 || latitude > 13.6 || longitude < 79.7 || longitude > 80.8) return toast('Your location is outside the Chennai demo area.');
    $('origin').value = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`; toast('Current location added as the start.');
  }, () => toast('Location permission was not granted.'), { enableHighAccuracy: true, timeout: 10000 });
});
$('locate-map').addEventListener('click', () => map.setView(CHENNAI, 13));

function startVoice() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) { say('Voice input is not supported in this browser. Use Chrome or enter places with the keyboard.'); return; }
  if (recognizer) { try { recognizer.stop(); } catch {} }
  recognizer = new SpeechRecognition(); recognizer.lang = 'en-IN'; recognizer.interimResults = false; recognizer.maxAlternatives = 1;
  $('voice-listen').textContent = 'Listening…'; $('voice-status').textContent = 'Listening for a command.';
  recognizer.onresult = event => handleVoice(event.results[0][0].transcript);
  recognizer.onerror = event => { $('voice-status').textContent = event.error === 'not-allowed' ? 'Microphone permission was denied.' : 'Voice input failed. You can still use the keyboard.'; say($('voice-status').textContent); };
  recognizer.onend = () => { $('voice-listen').textContent = '🎙 Speak'; };
  try { recognizer.start(); } catch { $('voice-listen').textContent = '🎙 Speak'; }
}
function handleVoice(raw) {
  const phrase = raw.toLowerCase().trim(); $('voice-status').textContent = `Heard: ${raw}`;
  if (phrase.includes('help')) {
    say('Commands available: say from start to destination, or say walk, bus, metro, repeat, next step, start camera, stop camera, or test vibration.');
    return;
  }
  if (phrase.includes('vibrat') || phrase.includes('buzz')) {
    vibrate([120, 60, 120]);
    say('Vibration test triggered.');
    return;
  }
  if (phrase.includes('repeat')) { say(footSteps[stepCursor] || 'No route instruction to repeat yet. Say start and destination, then plan.'); return; }
  if (phrase.includes('next step') || phrase === 'next') { stepCursor = Math.min(stepCursor + 1, footSteps.length - 1); say(footSteps[stepCursor] || 'No pedestrian directions are available yet.'); return; }
  if (phrase.includes('plan route') || phrase.startsWith('from ')) {
    const match = raw.match(/from (.+?) to (.+)/i);
    if (match) { $('origin').value = match[1].trim(); $('destination').value = match[2].trim(); planTrip(); }
    else say('Say, from a place to a destination.'); return;
  }
  if (phrase.includes('start camera')) { startCamera(); return; }
  if (phrase.includes('stop camera')) { stopCamera(); say('Camera stopped.'); return; }
  if (phrase.includes('walk')) { const button = [...document.querySelectorAll('.route-card')].find(card => card.textContent.includes('Pedestrian route')); if (button) button.click(); else say('Plan a trip first to request a pedestrian route.'); return; }
  if (phrase.includes('metro') || phrase.includes('train')) { const button = [...document.querySelectorAll('.route-card')].find(card => card.textContent.includes('Chennai Metro')); if (button) button.click(); else say('No Chennai Metro option is available near both places.'); return; }
  if (phrase.includes('bus')) { const button = document.querySelector('.route-card:not([data-index="walk"])'); if (button) button.click(); else say('No MTC route candidate is available for this trip.'); return; }
  if (phrase.includes('start') || phrase.includes('search')) { planTrip(); return; }
  $('destination').value = raw; say(`Destination set to ${raw}. Say plan route from your start to this place.`);
}
$('blind-mode').addEventListener('click', () => {
  audioMode = !audioMode; document.body.classList.toggle('audio-only', audioMode); $('blind-mode').setAttribute('aria-pressed', String(audioMode)); $('audio-panel').hidden = !audioMode;
  if (audioMode) { say('Audio-first mode is on. Enter a route by voice, then say bus or walk. Say repeat or next step for directions. Say start camera to use the webcam object detector. This is not a safety system.'); $('voice-listen').focus(); }
  else { recognizer?.stop(); speechSynthesis?.cancel(); }
});
$('voice-listen').addEventListener('click', startVoice);
document.addEventListener('keydown', event => {
  if (audioMode && event.code === 'Space' && !['INPUT', 'TEXTAREA', 'BUTTON'].includes(event.target.tagName)) { event.preventDefault(); startVoice(); }
  if (event.key === 'Escape' && 'speechSynthesis' in window) speechSynthesis.cancel();
});

async function listCameras() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices(), cams = devices.filter(device => device.kind === 'videoinput'), chosen = $('camera-select').value;
    $('camera-select').innerHTML = '<option value="">Default camera</option>';
    cams.forEach((device, index) => { const option = document.createElement('option'); option.value = device.deviceId; option.textContent = device.label || `Camera ${index + 1}`; $('camera-select').appendChild(option); });
    if (chosen && cams.some(camera => camera.deviceId === chosen)) $('camera-select').value = chosen;
  } catch {}
}
async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) { toast('Camera needs a supported browser and localhost or HTTPS.'); if (audioMode) say('Camera access is unavailable in this browser context.'); return; }
  try {
    if (cameraStream) stopCamera();
    const deviceId = $('camera-select').value;
    cameraStream = await navigator.mediaDevices.getUserMedia({ audio: false, video: deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' }, width: { ideal: 640 }, height: { ideal: 480 } } });
    const video = $('camera-video'); video.srcObject = cameraStream; await video.play(); $('camera-frame').classList.add('on'); $('camera-state').textContent = 'ON'; $('camera-state').classList.add('on'); $('camera-start').disabled = true; $('camera-stop').disabled = false;
    await listCameras(); if (deviceId) $('camera-select').value = deviceId;
    $('detections').textContent = 'Loading on-device object model…';
    if (!window.cocoSsd) throw new Error('TensorFlow.js model library did not load. Check internet access and reload.');
    detector ||= await cocoSsd.load({ base: 'lite_mobilenet_v2' });
    detecting = true; detectFrame(); if (audioMode) say('Camera connected. The on-device model labels common objects; it does not assess path safety.');
  } catch (error) { $('detections').textContent = error.name === 'NotAllowedError' ? 'Camera permission was denied.' : error.message; toast('Could not start camera. Check browser permission and network.'); if (audioMode) say($('detections').textContent); stopCamera(false); }
}
function stopCamera(clearMessage = true) {
  detecting = false;
  if (cameraStream) cameraStream.getTracks().forEach(track => track.stop());
  cameraStream = null;
  $('camera-video').srcObject = null;
  $('camera-frame').classList.remove('on');
  $('camera-state').textContent = 'OFF';
  $('camera-state').classList.remove('on');
  $('camera-start').disabled = false;
  $('camera-stop').disabled = true;
  const banner = $('proximity-banner');
  if (banner) { banner.hidden = true; banner.textContent = ''; }
  const canvas = $('camera-canvas'), ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (clearMessage) $('detections').textContent = 'Object detection stopped.';
}

const MOBILITY_OBSTACLES = new Set(['person', 'bicycle', 'car', 'motorcycle', 'bus', 'truck', 'dog', 'bench', 'chair', 'fire hydrant', 'stop sign']);

async function detectFrame() {
  if (!detecting || !detector || !$('camera-video').videoWidth) {
    if (detecting) setTimeout(detectFrame, 300);
    return;
  }
  if (document.hidden) {
    if (detecting) setTimeout(detectFrame, 1200);
    return;
  }
  const scanRate = Number($('vision-speed')?.value || 750);
  const video = $('camera-video'), canvas = $('camera-canvas'), ctx = canvas.getContext('2d');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const frameArea = canvas.width * canvas.height;

  try {
    const predictions = await detector.detect(video, 8, 0.52);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    let closestObstacle = null;
    let maxProximityScore = 0;

    predictions.forEach(item => {
      const [x, y, w, h] = item.bbox;
      const areaRatio = (w * h) / frameArea;
      const heightRatio = h / canvas.height;
      const centerX = x + w / 2;
      const dir = centerX < canvas.width * 0.35 ? 'left' : (centerX > canvas.width * 0.65 ? 'right' : 'center');
      const isMobility = MOBILITY_OBSTACLES.has(item.class);
      const isClose = (areaRatio > 0.14) || (heightRatio > 0.42 && areaRatio > 0.07);
      const isModerate = (areaRatio > 0.05) || (heightRatio > 0.28);

      const proximityScore = areaRatio * (dir === 'center' ? 1.5 : 1.0);
      if (isMobility && proximityScore > maxProximityScore) {
        maxProximityScore = proximityScore;
        closestObstacle = { class: item.class, dir, isClose, isModerate, score: item.score, areaRatio };
      }

      if (isClose && isMobility) {
        ctx.strokeStyle = '#e63946';
        ctx.lineWidth = Math.max(3, canvas.width / 160);
        ctx.strokeRect(x, y, w, h);
        ctx.fillStyle = '#e63946ee';
        ctx.fillRect(x, Math.max(0, y - 24), Math.min(w, item.class.length * 9 + 85), 23);
        ctx.fillStyle = 'white';
        ctx.font = `bold ${Math.max(12, canvas.width / 50)}px sans-serif`;
        ctx.fillText(`⚠️ ${item.class} CLOSE (${dir})`, x + 4, Math.max(16, y - 7));
      } else if (isModerate && isMobility) {
        ctx.strokeStyle = '#f4a261';
        ctx.lineWidth = Math.max(2, canvas.width / 220);
        ctx.strokeRect(x, y, w, h);
        ctx.fillStyle = '#f4a261ee';
        ctx.fillRect(x, Math.max(0, y - 22), Math.min(w, item.class.length * 8 + 60), 21);
        ctx.fillStyle = '#172523';
        ctx.font = `${Math.max(11, canvas.width / 55)}px sans-serif`;
        ctx.fillText(`${item.class} (${dir})`, x + 4, Math.max(15, y - 7));
      } else {
        ctx.strokeStyle = '#a9efc8';
        ctx.lineWidth = Math.max(1.5, canvas.width / 260);
        ctx.strokeRect(x, y, w, h);
        ctx.fillStyle = '#173c2fdd';
        ctx.fillRect(x, Math.max(0, y - 20), Math.min(w, item.class.length * 8 + 42), 19);
        ctx.fillStyle = 'white';
        ctx.font = `${Math.max(11, canvas.width / 58)}px sans-serif`;
        ctx.fillText(`${item.class} ${Math.round(item.score * 100)}%`, x + 4, Math.max(14, y - 6));
      }
    });

    const banner = $('proximity-banner');
    if (closestObstacle && closestObstacle.isClose) {
      if (banner) {
        banner.hidden = false;
        banner.className = 'proximity-banner warning';
        banner.textContent = `⚠️ Proximity Warning: ${closestObstacle.class} directly ${closestObstacle.dir === 'center' ? 'ahead in path' : 'on ' + closestObstacle.dir}!`;
      }
      if (closestObstacle.dir === 'center') {
        vibrate([120, 60, 120]);
      } else {
        vibrate(80);
      }
      if (Date.now() - lastProximityWarningAt > 4500) {
        lastProximityWarningAt = Date.now();
        if (audioMode) say(`Warning: ${closestObstacle.class} ${closestObstacle.dir === 'center' ? 'directly ahead' : 'on ' + closestObstacle.dir}, close.`);
      }
    } else if (closestObstacle && closestObstacle.isModerate) {
      if (banner) {
        banner.hidden = false;
        banner.className = 'proximity-banner caution';
        banner.textContent = `Caution: ${closestObstacle.class} detected ${closestObstacle.dir === 'center' ? 'ahead' : 'on ' + closestObstacle.dir}.`;
      }
    } else {
      if (banner) {
        banner.hidden = true;
        banner.textContent = '';
      }
    }

    const labels = [...new Set(predictions.map(p => p.class))];
    $('detections').textContent = labels.length
      ? `Model labels in view: ${labels.join(', ')} (${scanRate < 600 ? '2.5 FPS' : scanRate < 1000 ? '1.3 FPS' : '0.8 FPS saver'}). Proximity alerts active.`
      : 'No COCO-SSD object labels in this frame; does not confirm clear path.';
  } catch (error) {
    $('detections').textContent = `Detection paused: ${error.message}`;
  }

  if (detecting) setTimeout(detectFrame, scanRate);
}

$('camera-start').addEventListener('click', startCamera);
$('camera-stop').addEventListener('click', stopCamera);
$('camera-select').addEventListener('change', () => { if (cameraStream) startCamera(); });
$('test-haptic')?.addEventListener('click', () => {
  if ('vibrate' in navigator) {
    vibrate([120, 60, 120]);
    toast('Vibration triggered! (Double pulse)');
  } else {
    toast('Vibration API not supported on this device/browser.');
  }
});
navigator.mediaDevices?.addEventListener?.('devicechange', listCameras);
window.addEventListener('beforeunload', stopCamera);

// PWA Service Worker Registration & offline pill handling
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then(() => {
      const pill = $('offline-pill');
      if (pill) {
        const updateStatus = () => {
          pill.hidden = false;
          pill.innerHTML = navigator.onLine ? '<i></i> Offline-ready (PWA)' : '<i style="background:#e76f51"></i> Offline mode';
        };
        updateStatus();
        window.addEventListener('online', updateStatus);
        window.addEventListener('offline', updateStatus);
      }
    }).catch(() => {});
  });
}

loadTransit(); listCameras();
