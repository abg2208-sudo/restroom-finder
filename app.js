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

function setLocation({ lat, lng, label }) {
  map.setView([lat, lng], 16);
  if (youMarker) youMarker.remove();
  youMarker = L.circleMarker([lat, lng], {
    radius: 8, color: '#fff', weight: 3, fillColor: '#0b5fff', fillOpacity: 1,
  }).addTo(map).bindTooltip('You are here');
  statusEl.textContent = label;
  // step 3 hooks in here: load restrooms for (lat, lng)
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
