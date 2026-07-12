# OC Next — OC Transpo live nearby buses

Interactive Go web app using [OC Transpo GTFS-RT](https://www.octranspo.com/en/plan-your-trip/travel-tools/developers):

- **TripUpdates** — next arrivals in minutes
- **VehiclePositions** — live buses near you
- **GTFS schedule `stops.txt`** — nearby stop lookup
- Browser **geolocation** + **Speak**
- **Siri / HomePod** plain-text endpoints for Apple Shortcuts

## Quick start

```bash
# .env
OCTRANSPO_SUBSCRIPTION_KEY=your_key
HOME_LAT=45.4215
HOME_LON=-75.6972

go run .
```

Open http://localhost:8080 → **Use my location**.

## Endpoints

| Path | Description |
|------|-------------|
| `/` | Interactive UI (location, nearby minutes, live vehicles, speak) |
| `/api/nearby?lat=&lon=` | JSON nearby routes + spoken text |
| `/api/bus?bus=&lat=&lon=` | JSON arrivals for a route near you |
| `/api/vehicles?lat=&lon=` | JSON live VehiclePositions nearby |
| `/siri/nearby` | Plain text for Siri Speak Text |
| `/siri/bus?bus=` | Plain text arrivals after user picks a bus |
| `/next_bus?bus=&stop=` | Legacy HTML arrivals |

See [SIRI.md](SIRI.md) for HomePod Shortcuts setup.
