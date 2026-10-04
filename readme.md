# OC Next — OC Transpo live nearby buses

Rust (axum) web app using [OC Transpo GTFS-RT](https://www.octranspo.com/en/plan-your-trip/travel-tools/developers):

- **TripUpdates** — next arrivals in minutes
- **VehiclePositions** — live buses near you
- **GTFS schedule `stops.txt`** — nearby stop lookup
- Browser **geolocation** + **Speak**
- **Siri / HomePod** plain-text endpoints for Apple Shortcuts
- **3D live map** at `/map` (React + MapLibre: 3D buildings, terrain, live buses, routes, stops)

## Quick start

```bash
# .env
OCTRANSPO_SUBSCRIPTION_KEY=your_key
HOME_LAT=45.4215
HOME_LON=-75.6972

# build the 3D map once (output → static/map)
cd web && npm install && npm run build && cd ..

cargo run --release
```

Open http://localhost:8080 → **Use my location**, or http://localhost:8080/map for the 3D map.

Map development with hot reload: run `cargo run` and `cd web && npm run dev` (Vite proxies `/api` to :8080).

## Deploy (Render)

The `Dockerfile` builds the React pages and the Rust server into one small image.

New → **Web Service** → connect this repo, then:

| Field | Value |
|------|-------|
| Language / Runtime | **Docker** |
| Branch | `main` |
| Root Directory | *(empty)* |
| Dockerfile Path | `./Dockerfile` |
| Docker Build Context Directory | `.` |
| Docker Command | *(empty — the image runs `./bus-service`)* |
| Health Check Path | `/api/map/config` |
| Environment | `OCTRANSPO_SUBSCRIPTION_KEY`, `HOME_LAT`, `HOME_LON` |

Render sets `PORT` itself; the server listens on it. The OC Transpo schedule is
downloaded on startup (~5 s) and refreshed daily.

## Endpoints

| Path | Description |
|------|-------------|
| `/` | Homepage (React, `web/home.html`): plan a route, detect location, nearby arrivals |
| `/api/nearby?lat=&lon=` | JSON nearby routes + spoken text |
| `/api/bus?bus=&lat=&lon=` | JSON arrivals for a route near you |
| `/api/vehicles?lat=&lon=` | JSON live VehiclePositions nearby |
| `/siri/nearby` | Plain text for Siri Speak Text |
| `/siri/bus?bus=` | Plain text arrivals after user picks a bus |
| `/next_bus?bus=&stop=` | Legacy HTML arrivals |
| `/map` | 3D live map (React app from `web/`) |
| `/api/map/live` | All live vehicles + route colour, destination, next stop |
| `/api/map/vehicle/{id}` | One vehicle: upcoming stops with ETAs + route shape |
| `/api/map/route/{id}` | Route shapes |
| `/api/map/shape/{id}` | One route shape (buses are animated along it) |
| `/api/map/stops?bbox=w,s,e,n` | Stops in view |
| `/api/map/stop/{id}` | Live arrivals at a stop |
| `/api/plan?from=lat,lon&to=lat,lon` | Trip options (walk + bus, up to one transfer) with live departures |
| `/api/geocode?q=` | Place search in Ottawa (proxied to [Photon](https://photon.komoot.io), OpenStreetMap data) |

See [SIRI.md](SIRI.md) for HomePod Shortcuts setup.
