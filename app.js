const MIDTOWN = { lat: 40.7549, lng: -73.984 };

const map = L.map('map').setView([MIDTOWN.lat, MIDTOWN.lng], 15);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

document.getElementById('status').textContent = 'Midtown Manhattan';
