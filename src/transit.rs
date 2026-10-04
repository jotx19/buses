//! Arrival / nearby / vehicle logic and the spoken text for Siri — a direct port
//! of the original Go `feed.go`, producing identical JSON shapes.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, TimeZone, Utc};
use chrono_tz::{America::Toronto, Tz};
use serde::Serialize;

use crate::gtfs_rt::FeedMessage;
use crate::gtfs_static::{NearbyStop, StaticData, haversine_meters};

pub const TIME_ZONE: Tz = Toronto;

#[derive(Clone, Debug, Serialize)]
pub struct Arrival {
    pub route_id: String,
    pub stop_id: String,
    pub stop_name: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub stop_code: String,
    #[serde(rename = "time")]
    pub time_text: String,
    pub minutes: i64,
    #[serde(skip_serializing_if = "is_zero")]
    pub distance_m: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct NearbyRoute {
    pub route_id: String,
    pub stop_id: String,
    pub stop_name: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub stop_code: String,
    pub distance_m: f64,
    pub minutes: i64,
    #[serde(rename = "time")]
    pub time_text: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub spoken: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct LiveVehicle {
    pub route_id: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub vehicle_id: String,
    pub lat: f64,
    pub lon: f64,
    #[serde(skip_serializing_if = "is_zero")]
    pub bearing: f64,
    pub distance_m: f64,
    #[serde(skip_serializing_if = "is_zero")]
    pub speed_kmh: f64,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub updated: String,
}

fn is_zero(v: &f64) -> bool {
    *v == 0.0
}

pub fn now_local() -> DateTime<Tz> {
    Utc::now().with_timezone(&TIME_ZONE)
}

pub fn local_time(unix: i64) -> DateTime<Tz> {
    TIME_ZONE.timestamp_opt(unix, 0).single().unwrap_or_else(now_local)
}

pub fn clock_text(t: &DateTime<Tz>) -> String {
    t.format("%I:%M %p").to_string()
}

pub fn minutes_until(now: &DateTime<Tz>, t: &DateTime<Tz>) -> i64 {
    let m = (*t - *now).num_milliseconds() / 60_000;
    m.max(0)
}

/// Every future (stop_id, arrival) pair for trips on `route_id`, or on any route if `None`.
fn future_arrivals<'a>(
    feed: &'a FeedMessage,
    now: &'a DateTime<Tz>,
) -> impl Iterator<Item = (&'a str, &'a str, DateTime<Tz>)> + 'a {
    feed.entity.iter().filter_map(|e| e.trip_update.as_ref()).flat_map(move |tu| {
        let route_id = tu.trip.as_ref().and_then(|t| t.route_id.as_deref());
        tu.stop_time_update.iter().filter_map(move |stu| {
            let route_id = route_id?;
            let stop_id = stu.stop_id.as_deref()?;
            let t = local_time(stu.arrival.as_ref()?.time?);
            (t >= *now).then_some((route_id, stop_id, t))
        })
    })
}

pub fn arrivals_for_stop_route(
    feed: &FeedMessage,
    stat: Option<&StaticData>,
    route_id: &str,
    stop_id: i64,
    limit: usize,
) -> Vec<Arrival> {
    let now = now_local();
    let stop_str = stop_id.to_string();
    let mut times: Vec<DateTime<Tz>> = future_arrivals(feed, &now)
        .filter(|(r, s, _)| *r == route_id && *s == stop_str)
        .map(|(_, _, t)| t)
        .collect();
    times.sort();
    times.truncate(limit);

    let (stop_name, stop_code) = match stat.and_then(|s| s.stop(&stop_str)) {
        Some(s) => (s.name.clone(), s.code.clone()),
        None => (stop_str.clone(), String::new()),
    };
    times
        .iter()
        .map(|t| Arrival {
            route_id: route_id.to_string(),
            stop_id: stop_str.clone(),
            stop_name: stop_name.clone(),
            stop_code: stop_code.clone(),
            time_text: clock_text(t),
            minutes: minutes_until(&now, t),
            distance_m: 0.0,
        })
        .collect()
}

pub fn nearby_routes(feed: &FeedMessage, nearby: &[NearbyStop], limit: usize) -> Vec<NearbyRoute> {
    let now = now_local();
    let by_id: HashMap<&str, &NearbyStop> = nearby.iter().map(|s| (s.stop.id.as_str(), s)).collect();

    let mut best: HashMap<&str, NearbyRoute> = HashMap::new();
    for (route_id, stop_id, t) in future_arrivals(feed, &now) {
        let Some(ns) = by_id.get(stop_id) else { continue };
        let candidate = NearbyRoute {
            route_id: route_id.to_string(),
            stop_id: ns.stop.id.clone(),
            stop_name: ns.stop.name.clone(),
            stop_code: ns.stop.code.clone(),
            distance_m: ns.distance_m,
            minutes: minutes_until(&now, &t),
            time_text: clock_text(&t),
            spoken: String::new(),
        };
        match best.get(route_id) {
            Some(prev) if !better_nearby(&candidate, prev) => {}
            _ => {
                best.insert(route_id, candidate);
            }
        }
    }

    let mut out: Vec<NearbyRoute> = best
        .into_values()
        .map(|mut r| {
            r.spoken = format!(
                "Route {} at {}, next in {}",
                r.route_id,
                speak_stop_name(&r.stop_name),
                speak_minutes(r.minutes)
            );
            r
        })
        .collect();
    out.sort_by(|a, b| a.minutes.cmp(&b.minutes).then(a.distance_m.total_cmp(&b.distance_m)));
    out.truncate(limit);
    out
}

fn better_nearby(a: &NearbyRoute, b: &NearbyRoute) -> bool {
    if a.minutes != b.minutes {
        return a.minutes < b.minutes;
    }
    a.distance_m < b.distance_m
}

pub fn arrivals_for_route_nearby(
    feed: &FeedMessage,
    route_id: &str,
    nearby: &[NearbyStop],
    limit: usize,
) -> Vec<Arrival> {
    let now = now_local();
    let by_id: HashMap<&str, &NearbyStop> = nearby.iter().map(|s| (s.stop.id.as_str(), s)).collect();

    let mut hits: Vec<(&NearbyStop, DateTime<Tz>)> = future_arrivals(feed, &now)
        .filter(|(r, _, _)| *r == route_id)
        .filter_map(|(_, s, t)| by_id.get(s).map(|ns| (*ns, t)))
        .collect();
    if hits.is_empty() {
        return Vec::new();
    }
    hits.sort_by(|a, b| a.1.cmp(&b.1).then(a.0.distance_m.total_cmp(&b.0.distance_m)));
    let chosen = hits[0].0;

    let mut seen = HashSet::new();
    let mut times: Vec<DateTime<Tz>> = hits
        .iter()
        .filter(|(s, _)| s.stop.id == chosen.stop.id)
        .filter(|(_, t)| seen.insert(t.timestamp()))
        .map(|(_, t)| *t)
        .collect();
    times.sort();
    times.truncate(limit);

    times
        .iter()
        .map(|t| Arrival {
            route_id: route_id.to_string(),
            stop_id: chosen.stop.id.clone(),
            stop_name: chosen.stop.name.clone(),
            stop_code: chosen.stop.code.clone(),
            distance_m: chosen.distance_m,
            time_text: clock_text(t),
            minutes: minutes_until(&now, t),
        })
        .collect()
}

pub fn nearby_vehicles(feed: &FeedMessage, lat: f64, lon: f64, radius_m: f64, limit: usize) -> Vec<LiveVehicle> {
    let mut out: Vec<LiveVehicle> = feed
        .entity
        .iter()
        .filter_map(|entity| {
            let v = entity.vehicle.as_ref()?;
            let pos = v.position.as_ref()?;
            let v_lat = pos.latitude? as f64;
            let v_lon = pos.longitude? as f64;
            let d = haversine_meters(lat, lon, v_lat, v_lon);
            if d > radius_m {
                return None;
            }
            let route_id = v.trip.as_ref().and_then(|t| t.route_id.clone()).unwrap_or_default();
            let vehicle_id = v
                .vehicle
                .as_ref()
                .and_then(|d| d.id.clone())
                .or_else(|| entity.id.clone())
                .unwrap_or_default();
            Some(LiveVehicle {
                route_id,
                vehicle_id,
                lat: v_lat,
                lon: v_lon,
                bearing: pos.bearing.unwrap_or(0.0) as f64,
                distance_m: d,
                speed_kmh: pos.speed.map(|s| s as f64 * 3.6).unwrap_or(0.0),
                updated: v
                    .timestamp
                    .map(|ts| local_time(ts as i64).format("%I:%M:%S %p").to_string())
                    .unwrap_or_default(),
            })
        })
        .collect();
    out.sort_by(|a, b| a.distance_m.total_cmp(&b.distance_m));
    out.truncate(limit);
    out
}

pub fn speak_nearby(routes: &[NearbyRoute], radius_m: f64) -> String {
    if routes.is_empty() {
        return format!(
            "I could not find any buses arriving within {radius_m:.0} metres of your location right now."
        );
    }
    let parts: Vec<String> = routes
        .iter()
        .map(|r| {
            format!(
                "route {} at {}, next in {}",
                r.route_id,
                speak_stop_name(&r.stop_name),
                speak_minutes(r.minutes)
            )
        })
        .collect();
    format!("Nearby buses: {}.", join_speech(&parts))
}

pub fn speak_arrivals(route_id: &str, arrivals: &[Arrival]) -> String {
    let Some(a0) = arrivals.first() else {
        return format!("I could not find upcoming arrivals for route {route_id} near you.");
    };
    let mut msg = format!(
        "Route {} at {}: arriving in {} at {}",
        route_id,
        speak_stop_name(&a0.stop_name),
        speak_minutes(a0.minutes),
        a0.time_text
    );
    if let Some(a1) = arrivals.get(1) {
        msg += &format!(", then in {} at {}", speak_minutes(a1.minutes), a1.time_text);
    }
    msg + "."
}

pub fn speak_minutes(m: i64) -> String {
    match m {
        ..=0 => "less than a minute".to_string(),
        1 => "1 minute".to_string(),
        _ => format!("{m} minutes"),
    }
}

fn speak_stop_name(name: &str) -> &str {
    if name.is_empty() { "the stop" } else { name }
}

fn join_speech(parts: &[String]) -> String {
    match parts {
        [] => String::new(),
        [only] => only.clone(),
        [init @ .., last] => format!("{}, and {}", init.join(", "), last),
    }
}
