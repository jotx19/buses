//! JSON endpoints that power the 3D live map at `/map`.
//!
//! Live vehicles come from GTFS-RT VehiclePositions, joined with TripUpdates
//! (next stop / upcoming stops) and static GTFS (route colours, headsigns, shapes).

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use serde_json::json;

use crate::AppState;
use crate::api::{home_location, json_error, json_response};
use crate::gtfs_rt::{FeedEntity, FeedMessage, TRIP_CANCELED, TripUpdate};
use crate::gtfs_static::{Route, StaticData};
use crate::transit::{clock_text, local_time, now_local};

/// Downtown Ottawa (Parliament Hill), used when HOME_LAT/HOME_LON are not set.
const DEFAULT_CENTER: (f64, f64) = (45.4236, -75.7009);
const MAX_STOPS_IN_VIEW: usize = 800;
const MAX_UPCOMING_STOPS: usize = 40;
const MAX_STOP_ARRIVALS: usize = 10;
const FALLBACK_COLOR: &str = "#5B6770";

#[derive(Serialize)]
struct RouteInfo {
    id: String,
    short_name: String,
    long_name: String,
    color: String,
    text_color: String,
    route_type: u16,
}

impl RouteInfo {
    fn lookup(stat: Option<&StaticData>, route_id: &str) -> Self {
        match stat.and_then(|s| s.routes.get(route_id)) {
            Some(r) => Self::from(r),
            None => Self {
                id: route_id.to_string(),
                short_name: route_id.to_string(),
                long_name: String::new(),
                color: FALLBACK_COLOR.to_string(),
                text_color: "#FFFFFF".to_string(),
                route_type: 3,
            },
        }
    }
}

impl From<&Route> for RouteInfo {
    fn from(r: &Route) -> Self {
        Self {
            id: r.id.clone(),
            short_name: r.short_name.clone(),
            long_name: r.long_name.clone(),
            color: r.color.clone(),
            text_color: r.text_color.clone(),
            route_type: r.route_type,
        }
    }
}

#[derive(Serialize)]
struct NextStop {
    id: String,
    name: String,
    minutes: i64,
    time: String,
}

#[derive(Serialize)]
struct MapVehicle {
    id: String,
    in_service: bool,
    route: Option<RouteInfo>,
    trip_id: Option<String>,
    /// Route geometry this vehicle runs on (`/api/map/shape/{id}`), used to animate along the road
    shape_id: Option<String>,
    headsign: Option<String>,
    direction_id: Option<u32>,
    lat: f64,
    lon: f64,
    bearing: Option<f64>,
    speed_kmh: Option<f64>,
    /// Unix seconds of the GPS fix
    timestamp: Option<u64>,
    next_stop: Option<NextStop>,
}

#[derive(Serialize)]
struct UpcomingStop {
    id: String,
    code: String,
    name: String,
    lat: f64,
    lon: f64,
    minutes: i64,
    time: String,
}

/// Index of TripUpdates by vehicle id and by trip id.
struct TripIndex<'a> {
    by_vehicle: HashMap<&'a str, &'a TripUpdate>,
    by_trip: HashMap<&'a str, &'a TripUpdate>,
}

impl<'a> TripIndex<'a> {
    fn new(feed: &'a FeedMessage) -> Self {
        let mut by_vehicle = HashMap::new();
        let mut by_trip = HashMap::new();
        for tu in feed.entity.iter().filter_map(|e| e.trip_update.as_ref()) {
            let canceled = tu.trip.as_ref().and_then(|t| t.schedule_relationship) == Some(TRIP_CANCELED);
            if canceled {
                continue;
            }
            if let Some(v) = tu.vehicle.as_ref().and_then(|v| v.id.as_deref()) {
                by_vehicle.insert(v, tu);
            }
            if let Some(t) = tu.trip.as_ref().and_then(|t| t.trip_id.as_deref()) {
                by_trip.insert(t, tu);
            }
        }
        Self { by_vehicle, by_trip }
    }

    fn find(&self, vehicle_id: &str, trip_id: Option<&str>) -> Option<&'a TripUpdate> {
        trip_id
            .and_then(|t| self.by_trip.get(t))
            .or_else(|| self.by_vehicle.get(vehicle_id))
            .copied()
    }
}

/// Future stop times of a trip update as (stop_id, unix time). A small grace window
/// keeps the stop the bus is currently serving.
fn upcoming(tu: &TripUpdate) -> impl Iterator<Item = (&str, i64)> + '_ {
    let cutoff = now_local().timestamp() - 30;
    tu.stop_time_update.iter().filter_map(move |stu| {
        let t = stu
            .arrival
            .as_ref()
            .and_then(|e| e.time)
            .or_else(|| stu.departure.as_ref().and_then(|e| e.time))?;
        (t >= cutoff).then_some((stu.stop_id.as_deref()?, t))
    })
}

/// GPS fixes arrive as f32; trim the float noise from the f64 widening.
fn round6(v: f64) -> f64 {
    (v * 1e6).round() / 1e6
}

fn minutes_from_now(unix: i64) -> i64 {
    ((unix - now_local().timestamp()) / 60).max(0)
}

fn stop_name(stat: Option<&StaticData>, id: &str) -> String {
    stat.and_then(|s| s.stop(id)).map(|s| s.name.clone()).unwrap_or_else(|| id.to_string())
}

fn vehicle_id(entity: &FeedEntity) -> Option<String> {
    entity
        .vehicle
        .as_ref()
        .and_then(|v| v.vehicle.as_ref())
        .and_then(|d| d.id.clone())
        .or_else(|| entity.id.clone())
}

fn build_vehicle(
    entity: &FeedEntity,
    stat: Option<&StaticData>,
    trips: &TripIndex,
) -> Option<MapVehicle> {
    let v = entity.vehicle.as_ref()?;
    let pos = v.position.as_ref()?;
    let (lat, lon) = (round6(pos.latitude? as f64), round6(pos.longitude? as f64));
    let id = vehicle_id(entity)?;

    let trip = v.trip.as_ref();
    let route_id = trip.and_then(|t| t.route_id.as_deref()).filter(|r| !r.is_empty());
    let trip_id = trip.and_then(|t| t.trip_id.as_deref()).filter(|t| !t.is_empty());
    let static_trip = trip_id.and_then(|t| stat?.trips.get(t));
    let tu = route_id.and_then(|_| trips.find(&id, trip_id));

    let next = tu.and_then(|tu| upcoming(tu).next());
    let last_stop = tu.and_then(|tu| upcoming(tu).last());
    let headsign = static_trip
        .map(|t| t.headsign.clone())
        .filter(|h| !h.is_empty())
        .or_else(|| last_stop.map(|(s, _)| stop_name(stat, s)));

    let direction_id = trip
        .and_then(|t| t.direction_id)
        .or_else(|| static_trip.and_then(|t| t.direction_id.map(u32::from)));
    let shape_id = route_id
        .and_then(|r| stat?.shape_for(trip_id, r, direction_id))
        .map(str::to_string);

    Some(MapVehicle {
        in_service: route_id.is_some(),
        shape_id,
        route: route_id.map(|r| RouteInfo::lookup(stat, r)),
        trip_id: trip_id.map(str::to_string),
        headsign,
        direction_id,
        lat,
        lon,
        bearing: pos.bearing.map(|b| (b as f64).round()),
        speed_kmh: pos.speed.map(|s| (s as f64 * 36.0).round() / 10.0),
        timestamp: v.timestamp,
        next_stop: next.map(|(stop, t)| NextStop {
            id: stop.to_string(),
            name: stop_name(stat, stop),
            minutes: minutes_from_now(t),
            time: clock_text(&local_time(t)),
        }),
        id,
    })
}

/// Fetch both feeds concurrently. TripUpdates are optional enrichment, so a
/// failure there only drops next-stop info instead of failing the whole map.
async fn feeds(app: &AppState) -> Result<(Arc<FeedMessage>, Option<Arc<FeedMessage>>), Response> {
    let (vp, tp) = tokio::join!(app.rt.vehicle_positions(), app.rt.trip_updates());
    match vp {
        Ok(vp) => Ok((vp, tp.ok())),
        Err(err) => Err(json_error(StatusCode::BAD_GATEWAY, err)),
    }
}

fn static_or_kick(app: &Arc<AppState>) -> Option<Arc<StaticData>> {
    let stat = app.stat.try_get();
    if stat.is_none() {
        // Never make the live map wait on the ~45 MB schedule download.
        let app = app.clone();
        tokio::spawn(async move {
            let _ = app.stat.get().await;
        });
    }
    stat
}

pub async fn config() -> Response {
    let home = home_location().map(|(lat, lon)| json!({ "lat": lat, "lon": lon }));
    let (lat, lon) = home_location().unwrap_or(DEFAULT_CENTER);
    json_response(
        StatusCode::OK,
        json!({
            "home": home,
            "center": { "lat": lat, "lon": lon },
            "poll_seconds": 10,
        }),
    )
}

pub async fn live(State(app): State<Arc<AppState>>) -> Response {
    let stat = static_or_kick(&app);
    let (vp, tp) = match feeds(&app).await {
        Ok(f) => f,
        Err(resp) => return resp,
    };
    let empty = FeedMessage::default();
    let trips = TripIndex::new(tp.as_deref().unwrap_or(&empty));
    let vehicles: Vec<MapVehicle> = vp
        .entity
        .iter()
        .filter_map(|e| build_vehicle(e, stat.as_deref(), &trips))
        .collect();
    json_response(
        StatusCode::OK,
        json!({
            "server_time": now_local().timestamp(),
            "feed_time": vp.header.as_ref().and_then(|h| h.timestamp),
            "static_ready": stat.is_some(),
            "count": vehicles.len(),
            "vehicles": vehicles,
            "source": "OC Transpo GTFS-RT VehiclePositions + TripUpdates",
        }),
    )
}

pub async fn vehicle(State(app): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    let stat = static_or_kick(&app);
    let stat = stat.as_deref();
    let (vp, tp) = match feeds(&app).await {
        Ok(f) => f,
        Err(resp) => return resp,
    };
    let empty = FeedMessage::default();
    let trips = TripIndex::new(tp.as_deref().unwrap_or(&empty));
    let Some(entity) = vp.entity.iter().find(|e| e.vehicle.is_some() && vehicle_id(e).as_deref() == Some(&id))
    else {
        return json_error(StatusCode::NOT_FOUND, format!("bus {id} is not in the live feed"));
    };
    let Some(vehicle) = build_vehicle(entity, stat, &trips) else {
        return json_error(StatusCode::NOT_FOUND, format!("bus {id} has no position"));
    };

    let tu = vehicle.route.as_ref().and_then(|_| trips.find(&vehicle.id, vehicle.trip_id.as_deref()));
    let upcoming: Vec<UpcomingStop> = tu
        .map(|tu| {
            upcoming(tu)
                .filter_map(|(sid, t)| {
                    let s = stat?.stop(sid)?;
                    Some(UpcomingStop {
                        id: s.id.clone(),
                        code: s.code.clone(),
                        name: s.name.clone(),
                        lat: s.lat,
                        lon: s.lon,
                        minutes: minutes_from_now(t),
                        time: clock_text(&local_time(t)),
                    })
                })
                .take(MAX_UPCOMING_STOPS)
                .collect()
        })
        .unwrap_or_default();

    let shape = stat.and_then(|s| s.shapes.get(vehicle.shape_id.as_deref()?));

    json_response(
        StatusCode::OK,
        json!({
            "vehicle": vehicle,
            "upcoming": upcoming,
            "shape": shape,
            "server_time": now_local().timestamp(),
        }),
    )
}

pub async fn shape(State(app): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    let stat = match app.stat.get().await {
        Ok(s) => s,
        Err(err) => return json_error(StatusCode::SERVICE_UNAVAILABLE, err),
    };
    let Some(points) = stat.shapes.get(&id) else {
        return json_error(StatusCode::NOT_FOUND, format!("unknown shape {id}"));
    };
    // Shapes only change with the daily schedule, so browsers may cache them.
    (
        [(axum::http::header::CACHE_CONTROL, "public, max-age=3600")],
        axum::Json(json!({ "id": id, "points": points })),
    )
        .into_response()
}

pub async fn routes(State(app): State<Arc<AppState>>) -> Response {
    let stat = match app.stat.get().await {
        Ok(s) => s,
        Err(err) => return json_error(StatusCode::SERVICE_UNAVAILABLE, err),
    };
    let mut list: Vec<&Route> = stat.routes.values().collect();
    list.sort_by(|a, b| a.sort_order.cmp(&b.sort_order).then_with(|| a.short_name.cmp(&b.short_name)));
    let list: Vec<RouteInfo> = list.into_iter().map(RouteInfo::from).collect();
    json_response(StatusCode::OK, json!({ "routes": list }))
}

pub async fn route(State(app): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    let stat = match app.stat.get().await {
        Ok(s) => s,
        Err(err) => return json_error(StatusCode::SERVICE_UNAVAILABLE, err),
    };
    let Some(r) = stat.routes.get(&id) else {
        return json_error(StatusCode::NOT_FOUND, format!("unknown route {id}"));
    };
    let shapes: Vec<&Vec<[f64; 2]>> = stat
        .route_shapes
        .get(&id)
        .map(|ids| ids.iter().filter_map(|sid| stat.shapes.get(sid)).collect())
        .unwrap_or_default();
    json_response(StatusCode::OK, json!({ "route": RouteInfo::from(r), "shapes": shapes }))
}

pub async fn stops(State(app): State<Arc<AppState>>, Query(q): Query<HashMap<String, String>>) -> Response {
    let bbox: Vec<f64> = q
        .get("bbox")
        .map(|b| b.split(',').filter_map(|v| v.trim().parse().ok()).collect())
        .unwrap_or_default();
    let [west, south, east, north] = bbox[..] else {
        return json_error(StatusCode::BAD_REQUEST, "bbox must be west,south,east,north");
    };
    let Some(stat) = static_or_kick(&app) else {
        return json_response(StatusCode::OK, json!({ "stops": [], "static_ready": false }));
    };
    let list: Vec<_> = stat
        .stops
        .iter()
        .filter(|s| s.lon >= west && s.lon <= east && s.lat >= south && s.lat <= north)
        .take(MAX_STOPS_IN_VIEW)
        .collect();
    json_response(StatusCode::OK, json!({ "stops": list, "static_ready": true }))
}

pub async fn stop(State(app): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    let stat = match app.stat.get().await {
        Ok(s) => s,
        Err(err) => return json_error(StatusCode::SERVICE_UNAVAILABLE, err),
    };
    let Some(s) = stat.stop(&id) else {
        return json_error(StatusCode::NOT_FOUND, format!("unknown stop {id}"));
    };
    let feed = match app.rt.trip_updates().await {
        Ok(f) => f,
        Err(err) => return json_error(StatusCode::BAD_GATEWAY, err),
    };

    let mut arrivals: Vec<(i64, serde_json::Value)> = feed
        .entity
        .iter()
        .filter_map(|e| e.trip_update.as_ref())
        .filter(|tu| tu.trip.as_ref().and_then(|t| t.schedule_relationship) != Some(TRIP_CANCELED))
        .filter_map(|tu| {
            let trip = tu.trip.as_ref()?;
            let route_id = trip.route_id.as_deref()?;
            let (_, t) = upcoming(tu).find(|(sid, _)| *sid == id)?;
            let headsign = trip
                .trip_id
                .as_deref()
                .and_then(|tid| stat.trips.get(tid))
                .map(|t| t.headsign.clone())
                .filter(|h| !h.is_empty())
                .or_else(|| upcoming(tu).last().map(|(sid, _)| stop_name(Some(&stat), sid)));
            Some((
                t,
                json!({
                    "route": RouteInfo::lookup(Some(&stat), route_id),
                    "headsign": headsign,
                    "vehicle_id": tu.vehicle.as_ref().and_then(|v| v.id.clone()),
                    "minutes": minutes_from_now(t),
                    "time": clock_text(&local_time(t)),
                }),
            ))
        })
        .collect();
    arrivals.sort_by_key(|(t, _)| *t);
    arrivals.truncate(MAX_STOP_ARRIVALS);
    let arrivals: Vec<_> = arrivals.into_iter().map(|(_, a)| a).collect();

    json_response(StatusCode::OK, json!({ "stop": s, "arrivals": arrivals }))
}
