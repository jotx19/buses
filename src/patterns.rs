//! Stop patterns: for each distinct (route, direction, ordered stop list) in the
//! schedule, the stops in order and typical seconds from the first stop.
//!
//! Built once per schedule download by streaming `stop_times.txt` (~4.4 M rows,
//! ~220 MB) straight out of the GTFS zip, so that file never touches the disk.
//! The result (`data/patterns.json`, a few hundred KB) powers the trip planner.

use std::collections::HashMap;
use std::io::Read;

use anyhow::{Context, anyhow};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RawPattern {
    pub route_id: String,
    pub direction_id: Option<u8>,
    pub headsign: String,
    pub shape_id: String,
    pub stops: Vec<String>,
    /// seconds from the first stop's arrival, per stop
    pub offsets: Vec<u32>,
    /// scheduled trips using this pattern (popularity, for tie-breaking)
    pub trips: u32,
}

struct TripInfo {
    route_id: String,
    direction_id: Option<u8>,
    headsign: String,
    shape_id: String,
}

fn parse_hms(s: &str) -> Option<u32> {
    let mut it = s.trim().split(':');
    let h: u32 = it.next()?.parse().ok()?;
    let m: u32 = it.next()?.parse().ok()?;
    let sec: u32 = it.next()?.parse().ok()?;
    Some(h * 3600 + m * 60 + sec)
}

fn header_index(headers: &csv::StringRecord, name: &str) -> anyhow::Result<usize> {
    headers
        .iter()
        .position(|h| h.trim_start_matches('\u{feff}').trim() == name)
        .ok_or_else(|| anyhow!("missing column {name}"))
}

fn load_trips(trips_csv: impl Read) -> anyhow::Result<HashMap<String, TripInfo>> {
    let mut r = csv::ReaderBuilder::new().flexible(true).from_reader(trips_csv);
    let h = r.headers()?.clone();
    let (ti, ri) = (header_index(&h, "trip_id")?, header_index(&h, "route_id")?);
    let di = header_index(&h, "direction_id").ok();
    let hi = header_index(&h, "trip_headsign").ok();
    let si = header_index(&h, "shape_id").ok();
    let mut out = HashMap::new();
    for rec in r.records().filter_map(Result::ok) {
        let get = |i: Option<usize>| i.and_then(|i| rec.get(i)).unwrap_or("").trim().to_string();
        out.insert(
            get(Some(ti)),
            TripInfo {
                route_id: get(Some(ri)),
                direction_id: get(di).parse().ok(),
                headsign: get(hi),
                shape_id: get(si),
            },
        );
    }
    Ok(out)
}

/// Stream `stop_times.txt` (rows grouped by trip) into deduplicated patterns.
pub fn build(trips_csv: impl Read, stop_times_csv: impl Read) -> anyhow::Result<Vec<RawPattern>> {
    let trips = load_trips(trips_csv).context("read trips for patterns")?;
    let mut r = csv::ReaderBuilder::new().flexible(true).from_reader(stop_times_csv);
    let h = r.headers()?.clone();
    let ti = header_index(&h, "trip_id")?;
    let ai = header_index(&h, "arrival_time")?;
    let di = header_index(&h, "departure_time")?;
    let si = header_index(&h, "stop_id")?;
    let qi = header_index(&h, "stop_sequence")?;

    let mut patterns: Vec<RawPattern> = Vec::new();
    let mut index: HashMap<(String, Option<u8>, Vec<String>), usize> = HashMap::new();
    let mut cur_trip = String::new();
    let mut rows: Vec<(u32, String, Option<u32>)> = Vec::new();

    let mut flush = |trip_id: &str, rows: &mut Vec<(u32, String, Option<u32>)>| {
        let Some(info) = trips.get(trip_id) else {
            rows.clear();
            return;
        };
        rows.sort_by_key(|r| r.0);
        if rows.len() < 2 {
            rows.clear();
            return;
        }
        let stops: Vec<String> = rows.iter().map(|r| r.1.clone()).collect();
        let key = (info.route_id.clone(), info.direction_id, stops);
        if let Some(&i) = index.get(&key) {
            patterns[i].trips += 1;
        } else {
            // Fill missing times by carrying the last known one forward.
            let t0 = rows.iter().find_map(|r| r.2).unwrap_or(0);
            let mut last = t0;
            let offsets = rows
                .iter()
                .map(|r| {
                    if let Some(t) = r.2 {
                        last = t.max(last);
                    }
                    last - t0
                })
                .collect();
            index.insert(key.clone(), patterns.len());
            patterns.push(RawPattern {
                route_id: info.route_id.clone(),
                direction_id: info.direction_id,
                headsign: info.headsign.clone(),
                shape_id: info.shape_id.clone(),
                stops: key.2,
                offsets,
                trips: 1,
            });
        }
        rows.clear();
    };

    let mut rec = csv::StringRecord::new();
    while r.read_record(&mut rec)? {
        let trip = rec.get(ti).unwrap_or("");
        if trip != cur_trip {
            if !cur_trip.is_empty() {
                flush(&cur_trip, &mut rows);
            }
            cur_trip.clear();
            cur_trip.push_str(trip);
        }
        let seq = rec.get(qi).and_then(|s| s.trim().parse().ok()).unwrap_or(0);
        let time = rec
            .get(ai)
            .and_then(parse_hms)
            .or_else(|| rec.get(di).and_then(parse_hms));
        rows.push((seq, rec.get(si).unwrap_or("").trim().to_string(), time));
    }
    if !cur_trip.is_empty() {
        flush(&cur_trip, &mut rows);
    }
    Ok(patterns)
}
