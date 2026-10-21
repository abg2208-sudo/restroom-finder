# Waypoint

Find nearby public restrooms while traveling. A tiny static web app: plain HTML/CSS/JS, no backend, no API keys, no login.

- Uses your location (or a typed city/address, or Midtown Manhattan by default)
- Restroom data from [Refuge Restrooms](https://www.refugerestrooms.org/), falling back to OpenStreetMap (Overpass) if it fails
- Map by [Leaflet](https://leafletjs.com/) + OpenStreetMap tiles; address search via Nominatim
- Sorted list with distance, accessible/unisex tags, filters, and Google Maps walking directions

## Run locally

    python3 -m http.server 8000

then open http://localhost:8000 (geolocation works on `localhost` and HTTPS).

## Deploy

Import the repo in Vercel with the default settings (Framework: Other, no build command, no output directory). Vercel serves the repo root as static files over HTTPS.
