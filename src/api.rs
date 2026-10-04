//! Original endpoints (nearby / bus JSON API, Siri plain text, legacy /next_bus page).
//! Response bodies match the Go implementation field for field.

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::{StatusCode, header};
use axum::response::{Html, IntoResponse, Response};
use serde::Serialize;
use serde_json::json;

use crate::AppState;
use crate::transit::{self, Arrival};

pub const DEFAULT_STOP_ID: i64 = 1095;
pub const DEFAULT_BUS_NUMBER: &str = "68";
const DEFAULT_RADIUS_M: f64 = 500.0;
const DEFAULT_NEARBY_N: usize = 12;
const DEFAULT_ARRIVAL_N: usize = 2;
const DEFAULT_VEHICLE_N: usize = 20;
const VEHICLE_RADIUS_M: f64 = 1200.0;
/// Siri: if a route has no stop within the normal radius, look this far before
/// falling back to describing where its buses are.
const SIRI_WIDE_RADIUS_M: f64 = 1500.0;

const SOURCE_TRIP_UPDATES: &str = "OC Transpo GTFS-RT TripUpdates";
const SOURCE_VEHICLE_POSITIONS: &str = "OC Transpo GTFS-RT VehiclePositions";

type Params = Query<HashMap<String, String>>;

pub fn json_response(status: StatusCode, body: impl Serialize) -> Response {
    (status, [(header::CACHE_CONTROL, "no-store")], axum::Json(body)).into_response()
}

pub fn json_error(status: StatusCode, msg: impl ToString) -> Response {
    json_response(status, json!({ "error": msg.to_string() }))
}

fn text(status: StatusCode, body: impl Into<String>) -> Response {
    (
        status,
        [
            (header::CONTENT_TYPE, "text/plain; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        body.into(),
    )
        .into_response()
}

pub fn home_location() -> Option<(f64, f64)> {
    let lat = std::env::var("HOME_LAT").ok()?.parse().ok()?;
    let lon = std::env::var("HOME_LON").ok()?.parse().ok()?;
    Some((lat, lon))
}

fn param<'a>(q: &'a HashMap<String, String>, key: &str) -> &'a str {
    q.get(key).map(String::as_str).unwrap_or("")
}

/// Route number from what a person typed or Siri dictated:
/// "110", "110.", "Route 110", "bus #110", " 75 " → "110" / "75".
/// Non-numeric input (e.g. future lettered routes) is passed through trimmed.
fn route_query(raw: &str) -> String {
    let digits: String = raw
        .chars()
        .skip_while(|c| !c.is_ascii_digit())
        .take_while(|c| c.is_ascii_digit())
        .collect();
    if !digits.is_empty() {
        let trimmed = digits.trim_start_matches('0');
        return if trimmed.is_empty() { digits } else { trimmed.to_string() };
    }
    raw.trim().trim_end_matches(['.', '?', '!']).to_string()
}

fn parse_location(q: &HashMap<String, String>) -> Result<(f64, f64), &'static str> {
    let (mut lat_s, mut lon_s) = (param(q, "lat").to_string(), param(q, "lon").to_string());
    if lat_s.is_empty() || lon_s.is_empty() {
        lat_s = std::env::var("HOME_LAT").unwrap_or_default();
        lon_s = std::env::var("HOME_LON").unwrap_or_default();
    }
    if lat_s.is_empty() || lon_s.is_empty() {
        return Err("missing lat/lon (allow location in the browser, or set HOME_LAT and HOME_LON)");
    }
    match (lat_s.trim().parse(), lon_s.trim().parse()) {
        (Ok(lat), Ok(lon)) => Ok((lat, lon)),
        _ => Err("invalid lat/lon"),
    }
}

fn parse_radius(q: &HashMap<String, String>, fallback: f64) -> f64 {
    param(q, "radius").parse::<f64>().ok().filter(|v| *v > 0.0).unwrap_or(fallback)
}

#[derive(Serialize)]
struct BusView {
    time: String,
    minutes: i64,
}

pub async fn next_bus(State(app): State<Arc<AppState>>, Query(q): Params) -> Response {
    let bus = match param(&q, "bus") {
        "" => DEFAULT_BUS_NUMBER.to_string(),
        b => b.to_string(),
    };
    let stop_id = param(&q, "stop").parse().unwrap_or(DEFAULT_STOP_ID);

    let mut error = String::new();
    let mut buses = Vec::new();
    match app.rt.trip_updates().await {
        Err(err) => error = err.to_string(),
        Ok(feed) => {
            let stat = app.stat.try_get();
            for a in transit::arrivals_for_stop_route(&feed, stat.as_deref(), &bus, stop_id, DEFAULT_ARRIVAL_N) {
                buses.push(BusView { time: a.time_text, minutes: a.minutes });
            }
        }
    }
    let ctx = minijinja::context! { error, buses, bus_number => bus, stop_id };
    match app.templates.get_template("bus.html").and_then(|t| t.render(ctx)) {
        Ok(html) => Html(html).into_response(),
        Err(err) => (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()).into_response(),
    }
}

pub async fn api_nearby(State(app): State<Arc<AppState>>, Query(q): Params) -> Response {
    let stat = match app.stat.get().await {
        Ok(s) => s,
        Err(err) => return json_error(StatusCode::SERVICE_UNAVAILABLE, err),
    };
    let (lat, lon) = match parse_location(&q) {
        Ok(v) => v,
        Err(msg) => return json_error(StatusCode::BAD_REQUEST, msg),
    };
    let radius = parse_radius(&q, DEFAULT_RADIUS_M);
    let nearby = stat.nearby_stops(lat, lon, radius);
    let feed = match app.rt.trip_updates().await {
        Ok(f) => f,
        Err(err) => return json_error(StatusCode::BAD_GATEWAY, err),
    };
    let routes = transit::nearby_routes(&feed, &nearby, DEFAULT_NEARBY_N);
    json_response(
        StatusCode::OK,
        json!({
            "lat": lat,
            "lon": lon,
            "radius_m": radius,
            "stop_count": nearby.len(),
            "spoken": transit::speak_nearby(&routes, radius),
            "buses": routes,
            "source": SOURCE_TRIP_UPDATES,
        }),
    )
}

pub async fn api_bus(State(app): State<Arc<AppState>>, Query(q): Params) -> Response {
    let bus = route_query(param(&q, "bus"));
    if bus.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "missing bus query param");
    }
    let feed = match app.rt.trip_updates().await {
        Ok(f) => f,
        Err(err) => return json_error(StatusCode::BAD_GATEWAY, err),
    };

    let stop_str = param(&q, "stop");
    if !stop_str.is_empty() {
        let Ok(stop_id) = stop_str.parse::<i64>() else {
            return json_error(StatusCode::BAD_REQUEST, "invalid stop");
        };
        let stat = app.stat.try_get();
        let arrivals = transit::arrivals_for_stop_route(&feed, stat.as_deref(), &bus, stop_id, DEFAULT_ARRIVAL_N);
        return json_response(
            StatusCode::OK,
            json!({
                "bus": bus,
                "stop": stop_id,
                "spoken": transit::speak_arrivals(&bus, &arrivals),
                "arrivals": arrivals,
                "source": SOURCE_TRIP_UPDATES,
            }),
        );
    }

    let stat = match app.stat.get().await {
        Ok(s) => s,
        Err(err) => return json_error(StatusCode::SERVICE_UNAVAILABLE, err),
    };
    let (lat, lon) = match parse_location(&q) {
        Ok(v) => v,
        Err(msg) => return json_error(StatusCode::BAD_REQUEST, msg),
    };
    let radius = parse_radius(&q, DEFAULT_RADIUS_M);
    let nearby = stat.nearby_stops(lat, lon, radius);
    let arrivals: Vec<Arrival> = transit::arrivals_for_route_nearby(&feed, &bus, &nearby, DEFAULT_ARRIVAL_N);
    json_response(
        StatusCode::OK,
        json!({
            "bus": bus,
            "lat": lat,
            "lon": lon,
            "radius_m": radius,
            "spoken": transit::speak_arrivals(&bus, &arrivals),
            "arrivals": arrivals,
            "source": SOURCE_TRIP_UPDATES,
        }),
    )
}

pub async fn api_vehicles(State(app): State<Arc<AppState>>, Query(q): Params) -> Response {
    let (lat, lon) = match parse_location(&q) {
        Ok(v) => v,
        Err(msg) => return json_error(StatusCode::BAD_REQUEST, msg),
    };
    let radius = parse_radius(&q, VEHICLE_RADIUS_M);
    let feed = match app.rt.vehicle_positions().await {
        Ok(f) => f,
        Err(err) => return json_error(StatusCode::BAD_GATEWAY, err),
    };
    let vehicles = transit::nearby_vehicles(&feed, lat, lon, radius, DEFAULT_VEHICLE_N);
    json_response(
        StatusCode::OK,
        json!({
            "lat": lat,
            "lon": lon,
            "radius_m": radius,
            "count": vehicles.len(),
            "vehicles": vehicles,
            "source": SOURCE_VEHICLE_POSITIONS,
        }),
    )
}

pub async fn siri_nearby(State(app): State<Arc<AppState>>, Query(q): Params) -> Response {
    let Ok(stat) = app.stat.get().await else {
        return text(StatusCode::SERVICE_UNAVAILABLE, "Sorry, bus stop data is unavailable right now.");
    };
    let (lat, lon) = match parse_location(&q) {
        Ok(v) => v,
        Err(msg) => return text(StatusCode::BAD_REQUEST, format!("Sorry, {msg}.")),
    };
    let radius = parse_radius(&q, DEFAULT_RADIUS_M);
    let nearby = stat.nearby_stops(lat, lon, radius);
    let Ok(feed) = app.rt.trip_updates().await else {
        return text(StatusCode::BAD_GATEWAY, "Sorry, I could not reach OC Transpo right now.");
    };
    let routes = transit::nearby_routes(&feed, &nearby, DEFAULT_NEARBY_N);
    text(StatusCode::OK, transit::speak_nearby(&routes, radius))
}

pub async fn siri_bus(State(app): State<Arc<AppState>>, Query(q): Params) -> Response {
    let bus = route_query(param(&q, "bus"));
    if bus.is_empty() {
        return text(StatusCode::BAD_REQUEST, "Sorry, I need a bus number. Try saying a route like 68.");
    }
    let Ok(feed) = app.rt.trip_updates().await else {
        return text(StatusCode::BAD_GATEWAY, "Sorry, I could not reach OC Transpo right now.");
    };

    let stop_str = param(&q, "stop");
    if !stop_str.is_empty() {
        let Ok(stop_id) = stop_str.parse::<i64>() else {
            return text(StatusCode::BAD_REQUEST, "Sorry, that stop number looks invalid.");
        };
        let stat = app.stat.try_get();
        let arrivals = transit::arrivals_for_stop_route(&feed, stat.as_deref(), &bus, stop_id, DEFAULT_ARRIVAL_N);
        return text(StatusCode::OK, transit::speak_arrivals(&bus, &arrivals));
    }

    let Ok(stat) = app.stat.get().await else {
        return text(StatusCode::SERVICE_UNAVAILABLE, "Sorry, bus stop data is unavailable right now.");
    };
    let (lat, lon) = match parse_location(&q) {
        Ok(v) => v,
        Err(msg) => return text(StatusCode::BAD_REQUEST, format!("Sorry, {msg}.")),
    };
    let radius = parse_radius(&q, DEFAULT_RADIUS_M);
    // Try the usual walking radius, then a wider one, before giving up on stops.
    for r in [radius, radius.max(SIRI_WIDE_RADIUS_M)] {
        let nearby = stat.nearby_stops(lat, lon, r);
        let arrivals = transit::arrivals_for_route_nearby(&feed, &bus, &nearby, DEFAULT_ARRIVAL_N);
        if !arrivals.is_empty() {
            return text(StatusCode::OK, transit::speak_arrivals(&bus, &arrivals));
        }
    }

    // The route doesn't stop near you: describe where its buses are instead.
    let vehicles = app.rt.vehicle_positions().await.ok();
    text(StatusCode::OK, describe_route_buses(vehicles.as_deref(), &stat, &bus, lat, lon))
}

/// "Route 110 doesn't stop near you right now. 4 buses are running on it; the
/// closest is 3.2 kilometres away, heading to Kanata."
fn describe_route_buses(
    feed: Option<&crate::gtfs_rt::FeedMessage>,
    stat: &crate::gtfs_static::StaticData,
    route: &str,
    lat: f64,
    lon: f64,
) -> String {
    let route_id = stat
        .routes
        .values()
        .find(|r| r.short_name == route)
        .map(|r| r.id.as_str())
        .unwrap_or(route);
    let mut buses: Vec<(f64, Option<String>)> = feed
        .map(|f| f.entity.as_slice())
        .unwrap_or_default()
        .iter()
        .filter_map(|e| {
            let v = e.vehicle.as_ref()?;
            let trip = v.trip.as_ref()?;
            if trip.route_id.as_deref() != Some(route_id) {
                return None;
            }
            let p = v.position.as_ref()?;
            let d = crate::gtfs_static::haversine_meters(lat, lon, p.latitude? as f64, p.longitude? as f64);
            let headsign = trip
                .trip_id
                .as_deref()
                .and_then(|t| stat.trips.get(t))
                .map(|t| t.headsign.clone())
                .filter(|h| !h.is_empty());
            Some((d, headsign))
        })
        .collect();
    buses.sort_by(|a, b| a.0.total_cmp(&b.0));

    let Some((d, headsign)) = buses.first() else {
        return format!("Route {route} doesn't stop near you, and no route {route} buses are running right now.");
    };
    let distance = if *d < 1000.0 {
        format!("{} metres", (d / 10.0).round() * 10.0)
    } else {
        format!("{:.1} kilometres", d / 1000.0)
    };
    let heading = headsign.as_ref().map(|h| format!(", heading to {h}")).unwrap_or_default();
    let count = match buses.len() {
        1 => "1 bus is".to_string(),
        n => format!("{n} buses are"),
    };
    format!("Route {route} doesn't stop near you right now. {count} running on it; the closest is {distance} away{heading}.")
}
