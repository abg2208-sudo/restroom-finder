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

let loadToken = 0;
async function loadRestrooms(lat, lng, label) {
  const token = ++loadToken;
  statusEl.textContent = label + ' · searching for restrooms…';
  try {
    const list = await fetchRestrooms(lat, lng);
    if (token !== loadToken) return;
    restrooms = list;
    statusEl.textContent = `${label} · ${list.length} found (${source})`;
  } catch {
    if (token !== loadToken) return;
    restrooms = [];
    statusEl.textContent = label + ' · couldn’t load restrooms. Try again.';
  }
}

function setLocation({ lat, lng, label }) {
  map.setView([lat, lng], 16);
  if (youMarker) youMarker.remove();
  youMarker = L.circleMarker([lat, lng], {
    radius: 8, color: '#fff', weight: 3, fillColor: '#0b5fff', fillOpacity: 1,
  }).addTo(map).bindTooltip('You are here');
  statusEl.textContent = label;
  loadRestrooms(lat, lng, label);
}

function askForPlace(reason) {
  statusEl.textContent = reason;
  form.hidden = false;
  map.invalidateSize();
}

function locate() {
  if (!navigator.geolocation) return askForPlace('Location unavailable. Enter a place:');
  statusEl.textContent = 'Finding your location…';
  navigator.geolocation.getCurrentPosition(
    (pos) => setLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude, label: 'Near your location' }),
    () => {
      askForPlace('Location denied. Enter a place or use Midtown:');
      setLocation({ ...MIDTOWN, label: 'Location denied. Showing Midtown Manhattan' });
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
  );
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

$('use-default').addEventListener('click', () => setLocation(MIDTOWN));

locate();
