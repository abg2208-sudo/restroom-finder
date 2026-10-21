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
let capped = false;

const REFUGE = 'https://www.refugerestrooms.org/api/v1/restrooms/by_location';
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const RADIUS_M = 1500;
const MAX_RESULTS = 50;

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

// Refuge listings are user-submitted; drop ones carrying links or HTML (spam).
const SPAM_RE = /\bhttps?\b|\bwww\.|<\/|<[a-z]/i;
const isSpam = (r) => [r.name, r.directions, r.comment].some((s) => typeof s === 'string' && SPAM_RE.test(s));

// Coordinates come from third-party JSON and end up in a URL and map calls: force real numbers.
function withValidCoords(list) {
  return list
    .map((r) => ({ ...r, lat: Number(r.lat), lng: Number(r.lng) }))
    .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng) && Math.abs(r.lat) <= 90 && Math.abs(r.lng) <= 180);
}

async function fromRefuge(lat, lng) {
  const data = await fetchJson(`${REFUGE}?lat=${lat}&lng=${lng}&per_page=100&offset=0`);
  return withValidCoords(data.filter((r) => r.latitude != null && r.longitude != null && !isSpam(r)).map((r) => ({
    id: 'r' + r.id,
    name: r.name || 'Restroom',
    lat: r.latitude,
    lng: r.longitude,
    accessible: !!r.accessible,
    unisex: !!r.unisex,
    up: Number(r.upvote) || 0,
    down: Number(r.downvote) || 0,
    note: String(r.directions || r.comment || '').trim(),
    hours: '',
    changing: !!r.changing_table,
  })));
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
      return withValidCoords(data.elements.map((el) => {
        const t = el.tags || {};
        return {
          id: el.type[0] + el.id,
          name: t.name || t.operator || 'Public restroom',
          lat: el.lat ?? el.center?.lat,
          lng: el.lon ?? el.center?.lon,
          accessible: t.wheelchair === 'yes',
          unisex: t.unisex === 'yes' || t.gender_neutral === 'yes',
          up: 0,
          down: 0,
          note: '',
          hours: t.opening_hours || '',
          changing: t.changing_table === 'yes',
        };
      }).filter((r) => r.lat != null && r.lng != null));
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// Merge same-name listings within 50 m (e.g. Refuge + chain duplicates), OR-ing their tags.
function dedupe(list) {
  const norm = (n) => n.trim().toLowerCase().replace(/\s+/g, ' ');
  const out = [];
  for (const r of list) {
    const dup = out.find((o) => norm(o.name) === norm(r.name) && haversine(o.lat, o.lng, r.lat, r.lng) <= 50);
    if (dup) {
      dup.accessible ||= r.accessible;
      dup.unisex ||= r.unisex;
      dup.up += r.up;
      dup.down += r.down;
      dup.note ||= r.note;
      dup.hours ||= r.hours;
      dup.changing ||= r.changing;
    } else {
      out.push({ ...r });
    }
  }
  return out;
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
  list = dedupe(list);
  for (const r of list) r.distance = haversine(lat, lng, r.lat, r.lng);
  list.sort((a, b) => a.distance - b.distance);
  return { list: list.slice(0, MAX_RESULTS), capped: list.length > MAX_RESULTS };
}

function trim120(s, max = 120) {
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  return cut.slice(0, cut.lastIndexOf(' ') > 60 ? cut.lastIndexOf(' ') : max).trimEnd() + '…';
}

function formatDistance(m) {
  const ft = m * 3.28084;
  return ft < 1000 ? Math.round(ft / 10) * 10 + ' ft' : (m / 1609.344).toFixed(1) + ' mi';
}

const resultsEl = $('results');
const countEl = $('count');
const pinLayer = L.layerGroup().addTo(map);
const markers = new Map();

const filters = { accessible: false, unisex: false, changing: false };

function visible() {
  return restrooms.filter((r) => (!filters.accessible || r.accessible) && (!filters.unisex || r.unisex) && (!filters.changing || r.changing));
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
  countEl.textContent = !restrooms.length ? '' : capped ? `Showing the ${MAX_RESULTS} closest` : `${restrooms.length} restroom${restrooms.length === 1 ? '' : 's'} nearby`;
  if (restrooms.length && shown.length !== restrooms.length) countEl.textContent += ` · ${shown.length} match filters`;
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
    for (const [on, text] of [[r.accessible, 'Accessible'], [r.unisex, 'Unisex'], [r.changing, 'Changing table']]) {
      if (!on) continue;
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = text;
      meta.append(tag);
    }
    if (r.up + r.down > 0) {
      const votes = document.createElement('span');
      votes.className = 'votes';
      votes.textContent = `👍 ${r.up} · 👎 ${r.down}`;
      meta.append(votes);
    }
    info.append(name);
    if (r.note) {
      const note = document.createElement('div');
      note.className = 'note';
      const full = r.note.replace(/\s+/g, ' ').trim();
      const short = trim120(full);
      const text = document.createElement('span');
      text.textContent = short;
      note.append(text);
      if (short !== full) {
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'link';
        toggle.textContent = 'more';
        toggle.setAttribute('aria-expanded', 'false');
        toggle.addEventListener('click', (e) => {
          e.stopPropagation();
          const open = toggle.getAttribute('aria-expanded') !== 'true';
          text.textContent = open ? full : short;
          toggle.textContent = open ? 'less' : 'more';
          toggle.setAttribute('aria-expanded', open);
        });
        note.append(' ', toggle);
      }
      info.append(note);
    }
    if (r.hours) {
      const hours = document.createElement('span');
      hours.className = 'hours';
      hours.textContent = '🕒 ' + r.hours;
      meta.append(hours);
    }
    info.append(meta);
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
  if (scroll) resultsEl.querySelector(`[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  else markers.get(id)?.openTooltip();
}

let loadToken = 0;
async function loadRestrooms(lat, lng, label) {
  const token = ++loadToken;
  statusEl.textContent = label + ' · searching for restrooms…';
  try {
    const res = await fetchRestrooms(lat, lng);
    if (token !== loadToken) return;
    restrooms = res.list;
    capped = res.capped;
    render();
    statusEl.textContent = `${label} · ${restrooms.length} found (${source})`;
  } catch {
    if (token !== loadToken) return;
    restrooms = [];
    capped = false;
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

const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

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
  if (isIOS()) reason += '. Check that Precise Location is on for Safari';
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
