# Overhead

**The live Earth: every satellite, plane and earthquake on one 3D globe, and what's above you right now.**

A globe drawn from scratch with WebGL, fed by real data:

| Layer | What you get | Source |
|---|---|---|
| The Earth | Yesterday's real satellite photo of the whole planet, clouds included, with city lights glowing on the night side. Or a clean map with country borders | NASA GIBS: NOAA-20 VIIRS, Blue Marble, Black Marble |
| Satellites | All ~16,000 active satellites moving in real time. Click one for height, speed, the country below it, who owns it, when and where it was launched, what it's for, its size, whether it's in sunlight, its orbit and ground track, and when it next passes over you | CelesTrak orbits and catalogue, positions computed in your browser with SGP4 written from scratch |
| Planes | ~5,000 to 11,000 aircraft in the air (it depends on the time of day), pointing the way they fly and coloured by height. Click one for the aircraft type, registration, airline, route with progress, a photo, the path it has flown drawn on the globe, and height and speed charts | The OpenSky Network, adsbdb, airport-data.com photos |
| Earthquakes | Everything from the last 24 hours, sized by magnitude, coloured by depth; the last hour pulses | USGS real-time feed |
| Volcanoes | Volcanoes in this week's eruption report, with the report text | Smithsonian Global Volcanism Program and USGS |
| Launches | The next 20 rocket launches worldwide on their launch pads, with countdown, rocket, mission and orbit | The Space Devs' Launch Library |
| Aurora | NOAA's 30-minute aurora forecast glowing on the night side, plus the Kp index and your own chance of seeing one | NOAA Space Weather Prediction Center |
| Above you | A chart of your sky right now with every satellite and plane above you, bright satellites you can see tonight, space station passes, and the nearest planes | Worked out on your device; your location never leaves it |
| Stats | Who owns the satellites, what they're for, how high they orbit, planes by height, the busiest skies right now, quakes by size | All of the above, live |
| Time | Live, or fast-forward ×60 and ×600: satellites race round, the day/night line sweeps across | |

## How it's built

- **Zooming in stays sharp.** The whole-Earth photo is about 10 km per pixel. When you zoom in and stop, the app asks for a close-up of just that area: today's NASA photo (a few hundred metres per pixel) for the clouds, and when you're close, the Sentinel-2 cloud-free photo of the ground at 10 m per pixel. Clouds fade out as you zoom right in, like Google Earth. City lights and the coastline and border layer get close-ups too. Closer still, below about 20 km, it switches to street-level aerial and satellite photos (down to about 0.3 m per pixel in cities), fetched as map tiles for just what you're looking at, so you can find your own building. Near the ground the globe uses camera-relative maths so the picture stays rock steady.
- **Paths are real thick lines.** Browsers only draw 1-pixel WebGL lines, so flight paths and orbits are built from triangles in the shader, with a soft glow. Clicking a flight frames the whole route between the panels, labels both airports, and draws the path still to fly as a dashed line.
- **The globe** isn't a mesh. For every pixel, the graphics card works out where a ray from your eye hits a sphere, then shades it: land and country borders from Natural Earth, glowing coastlines, a lat/long grid, sun glint on the oceans, the real day/night line from the sun's position, an atmosphere and a star field.
- **Satellites** run in a background worker. Orbit maths (SGP4) is written from scratch and checked against the official published test results to within a metre. The worker computes all ~16,000 positions once a second (about 10 ms), and the graphics card glides each satellite smoothly between those snapshots. A satellite is hidden only when the Earth is actually in the way.
- **Pass predictions** use the satellite's position from where you stand, plus the sun: a pass is "visible" when your sky is dark but the station is still in sunlight.
- **Planes** come as one radar snapshot every 20 minutes (the free OpenSky limit). Between snapshots the graphics card moves each plane along its heading at its speed, and the app says so ("radar fix 6 min ago, estimated since"). Plane icons are drawn by the shader, not images.
- **The server** (`server/`) is Node's standard library. It serves the app, strips TypeScript on the fly, and proxies the data feeds: it caches each one (in memory and on disk, so a restart doesn't re-download), respects each source's limits, gzips them, trims the plane feed to just what's needed, refuses anything that isn't valid data, and keeps serving the last good copy if a source goes down.
- **Security**: a strict Content Security Policy, no `innerHTML`, every name from the feeds is inserted as plain text, links only to the sources' own pages, and path-traversal and prototype-pollution checks, all under test.
- **Zero dependencies.**

## Run

```bash
npm start   # http://localhost:5200
npm test
```

Node 22.13 or newer.

## Data

- Satellite orbits and catalogue: [CelesTrak](https://celestrak.org). They publish new orbits every 2 hours and ask that each copy is downloaded only once, so the server caches orbits for 2 hours and the catalogue for a day.
- Planes and flight paths: [The OpenSky Network](https://opensky-network.org), free for non-commercial use. Aircraft and routes: [adsbdb](https://www.adsbdb.com). Photos: airport-data.com.
- Earth photos: NASA's Global Imagery Browse Services (GIBS). Close-up ground: Sentinel-2 cloudless by EOX IT Services GmbH (contains modified Copernicus Sentinel data), free for non-commercial use with attribution.
- Earthquakes: USGS Earthquake Hazards Program (public domain).
- Volcanoes: Smithsonian Institution Global Volcanism Program and USGS weekly report.
- Launches: [The Space Devs](https://thespacedevs.com) Launch Library 2.
- Aurora and Kp index: NOAA Space Weather Prediction Center (public domain).
- Street level: Esri World Imagery (Esri, Vantor, Earthstar Geographics, and the GIS User Community).
- Map: Natural Earth via world-atlas (public domain).

Plane lookups are cached and capped at 60 per minute, so clicking around never floods the free services.
