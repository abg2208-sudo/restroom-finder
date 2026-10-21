const MIDTOWN = { lat: 40.7549, lng: -73.984, label: 'Midtown Manhattan' };

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const form = $('place-form');

const map = L.map('map').setView([MIDTOWN.lat, MIDTOWN.lng], 15);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

let youMarker = null;
let origin = MIDTOWN;
let restrooms = [];
let source = '';

const REFUGE = 'https://www.refugerestrooms.org/api/v1/restrooms/by_location';
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const RADIUS_M = 1500;

function haversine(lat1, lng1, lat2, lng2) {
  const rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lng2 - lng1) * rad) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(a));
}

async function fetchJson(url, opts = {}, timeoutMs = 8000) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(url + ' ' + res.status);
  return res.json();
}

async function fromRefuge(lat, lng) {
  const data = await fetchJson(`${REFUGE}?lat=${lat}&lng=${lng}&per_page=50&offset=0`);
  return data.filter((r) => r.latitude != null && r.longitude != null).map((r) => ({
    id: 'r' + r.id,
    name: r.name || 'Restroom',
    lat: r.latitude,
    lng: r.longitude,
    accessible: !!r.accessible,
    unisex: !!r.unisex,
  }));
}

async function fromOverpass(lat, lng) {
  const q = `[out:json][timeout:15];nwr["amenity"="toilets"](around:${RADIUS_M},${lat},${lng});out center tags;`;
  let lastErr;
  for (const endpoint of OVERPASS) {
    try {
      const data = await fetchJson(endpoint, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(q),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }, 20000);
      return data.elements.map((el) => {
        const t = el.tags || {};
        return {
          id: el.type[0] + el.id,
          name: t.name || t.operator || 'Public restroom',
          lat: el.lat ?? el.center?.lat,
          lng: el.lon ?? el.center?.lon,
          accessible: t.wheelchair === 'yes',
          unisex: t.unisex === 'yes' || t.gender_neutral === 'yes',
        };
      }).filter((r) => r.lat != null && r.lng != null);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

async function fetchRestrooms(lat, lng) {
  let list;
  try {
    list = await fromRefuge(lat, lng);
    source = 'Refuge Restrooms';
    if (!list.length) throw new Error('empty');
  } catch {
    list = await fromOverpass(lat, lng);
    source = 'OpenStreetMap';
  }
  for (const r of list) r.distance = haversine(lat, lng, r.lat, r.lng);
  return list.sort((a, b) => a.distance - b.distance);
}

function formatDistance(m) {
  const ft = m * 3.28084;
  return ft < 1000 ? Math.round(ft / 10) * 10 + ' ft' : (m / 1609.344).toFixed(1) + ' mi';
}

const resultsEl = $('results');
const pinLayer = L.layerGroup().addTo(map);
const markers = new Map();

const filters = { accessible: false, unisex: false };

function visible() {
  return restrooms.filter((r) => (!filters.accessible || r.accessible) && (!filters.unisex || r.unisex));
}

for (const key of Object.keys(filters)) {
  const btn = $('f-' + key);
  btn.addEventListener('click', () => {
    filters[key] = !filters[key];
    btn.setAttribute('aria-pressed', filters[key]);
    render();
  });
}

function render() {
  pinLayer.clearLayers();
  markers.clear();
  resultsEl.replaceChildren();
  const shown = visible();
  if (!shown.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = restrooms.length ? 'No restrooms match these filters.' : 'No restrooms found nearby.';
    resultsEl.append(li);
    return;
  }
  for (const r of shown) {
    const marker = L.marker([r.lat, r.lng], { title: r.name }).addTo(pinLayer);
    marker.on('click', () => highlight(r.id, true));
    markers.set(r.id, marker);

    const li = document.createElement('li');
    li.className = 'item';
    li.dataset.id = r.id;
    const info = document.createElement('div');
    info.className = 'info';
    const name = document.createElement('strong');
    name.textContent = r.name;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = formatDistance(r.distance);
    for (const [on, text] of [[r.accessible, 'Accessible'], [r.unisex, 'Unisex']]) {
      if (!on) continue;
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = text;
      meta.append(tag);
    }
    info.append(name, meta);
    const dir = document.createElement('a');
    dir.className = 'btn';
    dir.textContent = 'Directions';
    dir.target = '_blank';
    dir.rel = 'noopener';
    dir.href = 'https://www.google.com/maps/dir/?api=1&travelmode=walking' +
      `&origin=${origin.lat},${origin.lng}&destination=${r.lat},${r.lng}`;
    dir.addEventListener('click', (e) => e.stopPropagation());
    li.append(info, dir);
    li.addEventListener('click', () => {
      highlight(r.id, false);
      map.panTo([r.lat, r.lng]);
    });
    resultsEl.append(li);
  }
}

function highlight(id, scroll) {
  for (const li of resultsEl.querySelectorAll('.item')) li.classList.toggle('active', li.dataset.id === id);
  if (scroll) resultsEl.querySelector(`[data-id="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  else markers.get(id)?.openTooltip();
}

let loadToken = 0;
async function loadRestrooms(lat, lng, label) {
  const token = ++loadToken;
  statusEl.textContent = label + ' · searching for restrooms…';
  try {
    const list = await fetchRestrooms(lat, lng);
    if (token !== loadToken) return;
    restrooms = list;
    render();
    statusEl.textContent = `${label} · ${list.length} found (${source})`;
  } catch {
    if (token !== loadToken) return;
    restrooms = [];
    render();
    statusEl.textContent = label + ' · couldn’t load restrooms. Try again.';
  }
}

function setLocation({ lat, lng, label }) {
  origin = { lat, lng };
  map.setView([lat, lng], 16);
  if (youMarker) youMarker.remove();
  youMarker = L.circleMarker([lat, lng], {
    radius: 8, color: '#fff', weight: 3, fillColor: '#0b5fff', fillOpacity: 1,
  }).addTo(map).bindTooltip('You are here');
  statusEl.textContent = label;
  loadRestrooms(lat, lng, label);
}

const GEO_ERRORS = {
  1: 'Location blocked. Allow it in your browser or iOS Settings → Privacy → Location Services',
  2: 'Your device couldn’t determine its location',
  3: 'Location timed out',
};

function getPosition(options) {
  return new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, options));
}

// Low accuracy first (fast, cached OK). iOS often times out or reports "unavailable" with
// high accuracy, so only retry with it if the first attempt timed out or had no fix.
async function getLocation() {
  try {
    return await getPosition({ enableHighAccuracy: false, timeout: 15000, maximumAge: 300000 });
  } catch (err) {
    if (err.code === 1) throw err;
    statusEl.textContent = 'Still looking for your location…';
    return getPosition({ enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
  }
}

async function locate() {
  if (!navigator.geolocation) return failLocate('Location isn’t supported in this browser');
  statusEl.textContent = 'Finding your location…';
  try {
    const pos = await getLocation();
    setLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude, label: 'Near your location' });
  } catch (err) {
    const base = GEO_ERRORS[err.code] || 'Couldn’t get your location';
    failLocate(err.message && err.code !== 1 ? `${base} (${err.message})` : base);
  }
}

function failLocate(reason) {
  setLocation({ ...MIDTOWN, label: `${reason}. Showing Midtown Manhattan` });
}

async function geocode(query) {
  const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(query);
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('geocode ' + res.status);
  const [hit] = await res.json();
  return hit && { lat: +hit.lat, lng: +hit.lon, label: hit.display_name.split(',').slice(0, 2).join(',') };
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('place').value.trim();
  if (!q) return;
  statusEl.textContent = 'Searching…';
  try {
    const place = await geocode(q);
    if (place) setLocation(place);
    else statusEl.textContent = 'No match for "' + q + '". Try another place.';
  } catch {
    statusEl.textContent = 'Search failed. Check your connection.';
  }
});

$('use-location').addEventListener('click', locate);

locate();
