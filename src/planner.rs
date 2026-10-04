//! Trip planner: walk → bus → (walk / transfer → bus) → walk.
//!
//! Uses the schedule's stop patterns for "which buses connect these places and
//! how long the ride takes", and live TripUpdates for "when does the next one
//! actually leave". Options are ranked by door-to-door time including the wait.

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::Response;
use serde::Serialize;
use serde_json::json;

use crate::AppState;
use crate::api::{json_error, json_response};
use crate::gtfs_rt::{FeedMessage, TRIP_CANCELED};
use crate::gtfs_static::{Pattern, StaticData, haversine_meters};
use crate::transit::{clock_text, local_time, now_local};

const WALK_M_PER_MIN: f64 = 78.0; // ~4.7 km/h
const WALK_DETOUR: f64 = 1.25; // streets aren't straight lines
const ACCESS_RADIUS_M: f64 = 900.0;
const ACCESS_RADIUS_WIDE_M: f64 = 1600.0;
const TRANSFER_PENALTY_MIN: f64 = 5.0;
const NO_LIVE_WAIT_MIN: f64 = 10.0; // assumed wait when no live departure is known
const MAX_RIDE_STOPS: usize = 90;
const MAX_OPTIONS: usize = 5;

#[derive(Serialize, Clone)]
struct Place {
    name: String,
    lat: f64,
    lon: f64,
}

#[derive(Serialize, Clone)]
struct StopRef {
    id: String,
    code: String,
    name: String,
    lat: f64,
    lon: f64,
}

#[derive(Serialize, Clone)]
struct Departure {
    minutes: i64,
    time: String,
    vehicle_id: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Leg {
    Walk {
        from: Place,
        to: Place,
        meters: f64,
        minutes: f64,
    },
    Bus {
        route: serde_json::Value,
        headsign: String,
        shape_id: String,
        board: StopRef,
        alight: StopRef,
        stops: usize,
        ride_minutes: f64,
        departures: Vec<Departure>,
    },
}

#[derive(Serialize)]
struct TripOption {
    /// door-to-door minutes including the first wait
    total_minutes: f64,
    /// minutes until the first bus leaves (live), if known
    leaves_in: Option<i64>,
    transfers: usize,
    walk_meters: f64,
    route_ids: Vec<String>,
    legs: Vec<Leg>,
}

fn walk_min(m: f64) -> f64 {
    m * WALK_DETOUR / WALK_M_PER_MIN
}

fn ride_min(p: &Pattern, from: usize, to: usize) -> f64 {
    (p.offsets[to].saturating_sub(p.offsets[from])) as f64 / 60.0
}

fn stop_ref(stat: &StaticData, idx: usize) -> StopRef {
    let s = &stat.stops[idx];
    StopRef { id: s.id.clone(), code: s.code.clone(), name: s.name.clone(), lat: s.lat, lon: s.lon }
}

fn place_of(stat: &StaticData, idx: usize) -> Place {
    let s = &stat.stops[idx];
    Place { name: s.name.clone(), lat: s.lat, lon: s.lon }
}

/// Live departures of `route_id` (going `direction`) from `stop_id`, soonest first.
fn live_departures(
    feed: Option<&FeedMessage>,
    stat: &StaticData,
    route_id: &str,
    direction: Option<u8>,
    stop_id: &str,
) -> Vec<Departure> {
    let Some(feed) = feed else { return Vec::new() };
    let now = now_local().timestamp();
    let mut out: Vec<(i64, Departure)> = feed
        .entity
        .iter()
        .filter_map(|e| e.trip_update.as_ref())
        .filter_map(|tu| {
            let trip = tu.trip.as_ref()?;
            if trip.route_id.as_deref() != Some(route_id) || trip.schedule_relationship == Some(TRIP_CANCELED) {
                return None;
            }
            let dir = trip
                .direction_id
                .and_then(|d| u8::try_from(d).ok())
                .or_else(|| stat.trips.get(trip.trip_id.as_deref()?).and_then(|t| t.direction_id));
            if direction.is_some() && dir.is_some() && dir != direction {
                return None;
            }
            let t = tu.stop_time_update.iter().find_map(|stu| {
                (stu.stop_id.as_deref() == Some(stop_id))
                    .then(|| stu.departure.as_ref().and_then(|e| e.time).or(stu.arrival.as_ref()?.time))
                    .flatten()
            })?;
            (t >= now - 30).then(|| {
                (
                    t,
                    Departure {
                        minutes: ((t - now) / 60).max(0),
                        time: clock_text(&local_time(t)),
                        vehicle_id: tu.vehicle.as_ref().and_then(|v| v.id.clone()),
                    },
                )
            })
        })
        .collect();
    out.sort_by_key(|(t, _)| *t);
    out.dedup_by_key(|(t, _)| *t);
    out.into_iter().take(3).map(|(_, d)| d).collect()
}

struct Candidate {
    cost: f64,
    /// (pattern, board pos, alight pos) per bus leg
    rides: Vec<(usize, usize, usize)>,
    walk_start: f64,
    walk_end: f64,
    /// transfer walk metres between ride 1 and 2
    walk_mid: f64,
}

fn search(stat: &StaticData, from: (f64, f64), to: (f64, f64), radius: f64) -> Vec<Candidate> {
    let near = |p: (f64, f64)| -> Vec<(usize, f64)> {
        stat.stops
            .iter()
            .enumerate()
            .filter_map(|(i, s)| {
                let d = haversine_meters(p.0, p.1, s.lat, s.lon);
                (d <= radius).then_some((i, d))
            })
            .collect()
    };
    let origin = near(from);
    let dest = near(to);

    // Best way to reach the destination from each (pattern) → (position, walk metres)
    let mut dest_best: HashMap<u32, Vec<(u16, f64)>> = HashMap::new();
    for &(si, d) in &dest {
        for &(pi, pos) in &stat.stop_patterns[si] {
            dest_best.entry(pi).or_default().push((pos, d));
        }
    }
    // Best boarding per pattern from the origin
    let mut board_best: HashMap<u32, (u16, f64)> = HashMap::new();
    for &(si, d) in &origin {
        for &(pi, pos) in &stat.stop_patterns[si] {
            let e = board_best.entry(pi).or_insert((pos, d));
            if walk_min(d) - stat.patterns[pi as usize].offsets[pos as usize] as f64 / 60.0
                < walk_min(e.1) - stat.patterns[pi as usize].offsets[e.0 as usize] as f64 / 60.0
            {
                *e = (pos, d);
            }
        }
    }

    let mut out: Vec<Candidate> = Vec::new();
    // transfers: best candidate per (first pattern, second pattern) pair
    let mut transfers: HashMap<(u32, u32), Candidate> = HashMap::new();
    for (&pa, &(i, wd)) in &board_best {
        let a = &stat.patterns[pa as usize];
        let i = i as usize;

        // Direct
        if let Some(ends) = dest_best.get(&pa) {
            for &(j, wd2) in ends {
                let j = j as usize;
                if j > i && j - i <= MAX_RIDE_STOPS {
                    out.push(Candidate {
                        cost: walk_min(wd) + ride_min(a, i, j) + walk_min(wd2),
                        rides: vec![(pa as usize, i, j)],
                        walk_start: wd,
                        walk_end: wd2,
                        walk_mid: 0.0,
                    });
                }
            }
        }

        // One transfer: ride A to stop k, walk to a nearby stop t, ride B to the destination
        for k in (i + 1)..a.stops.len().min(i + 1 + MAX_RIDE_STOPS) {
            for &(t, tw) in &stat.stop_neighbors[a.stops[k]] {
                for &(pb, m) in &stat.stop_patterns[t as usize] {
                    let b = &stat.patterns[pb as usize];
                    if b.route_id == a.route_id {
                        continue;
                    }
                    let Some(ends) = dest_best.get(&pb) else { continue };
                    for &(j, wd2) in ends {
                        let (m, j) = (m as usize, j as usize);
                        if j <= m || j - m > MAX_RIDE_STOPS {
                            continue;
                        }
                        let cost = walk_min(wd)
                            + ride_min(a, i, k)
                            + walk_min(tw as f64)
                            + TRANSFER_PENALTY_MIN
                            + ride_min(b, m, j)
                            + walk_min(wd2);
                        if transfers.get(&(pa, pb)).is_some_and(|c| c.cost <= cost) {
                            continue;
                        }
                        transfers.insert(
                            (pa, pb),
                            Candidate {
                                cost,
                                rides: vec![(pa as usize, i, k), (pb as usize, m, j)],
                                walk_start: wd,
                                walk_end: wd2,
                                walk_mid: tw as f64,
                            },
                        );
                    }
                }
            }
        }
    }
    out.extend(transfers.into_values());
    out
}

pub async fn plan(State(app): State<Arc<AppState>>, Query(q): Query<HashMap<String, String>>) -> Response {
    let parse = |key: &str| -> Option<(f64, f64)> {
        let v = q.get(key)?;
        let (a, b) = v.split_once(',')?;
        Some((a.trim().parse().ok()?, b.trim().parse().ok()?))
    };
    let (Some(from), Some(to)) = (parse("from"), parse("to")) else {
        return json_error(StatusCode::BAD_REQUEST, "from and to must be lat,lon");
    };
    let from_name = q.get("from_name").cloned().unwrap_or_else(|| "Start".into());
    let to_name = q.get("to_name").cloned().unwrap_or_else(|| "Destination".into());

    let stat = match app.stat.get().await {
        Ok(s) => s,
        Err(err) => return json_error(StatusCode::SERVICE_UNAVAILABLE, err),
    };
    if stat.patterns.is_empty() {
        return json_error(StatusCode::SERVICE_UNAVAILABLE, "trip planning data is still loading");
    }
    let feed = app.rt.trip_updates().await.ok();

    let direct_m = haversine_meters(from.0, from.1, to.0, to.1);
    let mut candidates = search(&stat, from, to, ACCESS_RADIUS_M);
    if candidates.is_empty() {
        candidates = search(&stat, from, to, ACCESS_RADIUS_WIDE_M);
    }
    candidates.sort_by(|a, b| a.cost.total_cmp(&b.cost));

    // Keep the best candidate per route combination, then add live waits and re-rank.
    let mut seen = std::collections::HashSet::new();
    let start_place = Place { name: from_name, lat: from.0, lon: from.1 };
    let end_place = Place { name: to_name, lat: to.0, lon: to.1 };
    let mut options: Vec<TripOption> = Vec::new();
    for c in candidates {
        let routes: Vec<String> = c.rides.iter().map(|r| stat.patterns[r.0].route_id.clone()).collect();
        if !seen.insert(routes.clone()) {
            continue;
        }
        if seen.len() > 25 {
            break;
        }

        let mut legs = Vec::new();
        let mut leaves_in = None;
        let mut prev_place = start_place.clone();
        let mut prev_walk = c.walk_start;
        for (n, &(pi, i, j)) in c.rides.iter().enumerate() {
            let p = &stat.patterns[pi];
            let board = p.stops[i];
            let walk_to = if n == 0 { c.walk_start } else { c.walk_mid };
            if walk_to > 1.0 || n == 0 {
                legs.push(Leg::Walk {
                    from: prev_place.clone(),
                    to: place_of(&stat, board),
                    meters: walk_to.round(),
                    minutes: walk_min(walk_to).ceil(),
                });
            }
            let departures = live_departures(feed.as_deref(), &stat, &p.route_id, p.direction_id, &stat.stops[board].id);
            if n == 0 {
                // first live bus you can still walk to in time
                let walk_first = walk_min(c.walk_start).floor() as i64;
                leaves_in = departures.iter().find(|d| d.minutes >= walk_first).map(|d| d.minutes);
            }
            let route = stat
                .routes
                .get(&p.route_id)
                .map(|r| json!(r))
                .unwrap_or_else(|| json!({ "id": p.route_id, "short_name": p.route_id, "long_name": "", "color": "#5B6770", "text_color": "#FFFFFF", "route_type": 3 }));
            legs.push(Leg::Bus {
                route,
                headsign: p.headsign.clone(),
                shape_id: p.shape_id.clone(),
                board: stop_ref(&stat, board),
                alight: stop_ref(&stat, p.stops[j]),
                stops: j - i,
                ride_minutes: ride_min(p, i, j).round(),
                departures,
            });
            prev_place = place_of(&stat, p.stops[j]);
            prev_walk = c.walk_end;
        }
        legs.push(Leg::Walk {
            from: prev_place,
            to: end_place.clone(),
            meters: prev_walk.round(),
            minutes: walk_min(prev_walk).ceil(),
        });

        // Can't make it to the stop in time for the first live bus? use the next one.
        let walk_first = walk_min(c.walk_start);
        let wait = leaves_in.map(|m| (m as f64 - walk_first).max(0.0)).unwrap_or(NO_LIVE_WAIT_MIN);
        options.push(TripOption {
            total_minutes: (c.cost + wait).round(),
            leaves_in,
            transfers: c.rides.len() - 1,
            walk_meters: (c.walk_start + c.walk_mid + c.walk_end).round(),
            route_ids: routes,
            legs,
        });
    }
    options.sort_by(|a, b| a.total_minutes.total_cmp(&b.total_minutes));
    options.truncate(MAX_OPTIONS);

    json_response(
        StatusCode::OK,
        json!({
            "from": start_place,
            "to": end_place,
            "walk_only_minutes": walk_min(direct_m).ceil(),
            "options": options,
        }),
    )
}
