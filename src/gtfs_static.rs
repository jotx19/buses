//! OC Transpo static GTFS schedule: stops, routes, trips (headsigns) and shapes.
//!
//! The export zip is downloaded at runtime, the files we need are extracted into
//! `data/`, and the parsed result is kept in memory. `stop_times.txt` (~220 MB) is
//! never extracted — live arrival times come from GTFS-RT TripUpdates instead.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::{Duration, SystemTime};

use anyhow::{Context, anyhow};
use serde::Serialize;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

pub const GTFS_ZIP_URL: &str =
    "https://oct-gtfs-emasagcnfmcgeham.z01.azurefd.net/public-access/GTFSExport.zip";
const GTFS_CACHE_DIR: &str = "data";
const GTFS_MAX_AGE: Duration = Duration::from_secs(24 * 3600);
const GTFS_FILES: [&str; 4] = ["stops.txt", "routes.txt", "trips.txt", "shapes.txt"];
/// Built from stop_times.txt during extraction (see patterns.rs).
const PATTERNS_FILE: &str = "patterns.json";
/// Stops this close together count as one place for transfers.
const TRANSFER_RADIUS_M: f64 = 250.0;
pub const EARTH_RADIUS_M: f64 = 6_371_000.0;

#[derive(Clone, Debug, Serialize)]
pub struct Stop {
    pub id: String,
    pub code: String,
    pub name: String,
    pub lat: f64,
    pub lon: f64,
}

#[derive(Clone, Debug)]
pub struct NearbyStop {
    pub stop: Stop,
    pub distance_m: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct Route {
    pub id: String,
    pub short_name: String,
    pub long_name: String,
    /// `#RRGGBB`
    pub color: String,
    pub text_color: String,
    /// GTFS route_type (0 = light rail / O-Train, 3 = bus)
    pub route_type: u16,
    pub sort_order: i32,
}

#[derive(Clone, Debug)]
pub struct Trip {
    pub route_id: String,
    pub headsign: String,
    pub direction_id: Option<u8>,
    pub shape_id: String,
}

/// A route direction's ordered stops (stop indices) with typical seconds from the first stop.
pub struct Pattern {
    pub route_id: String,
    pub direction_id: Option<u8>,
    pub headsign: String,
    pub shape_id: String,
    pub stops: Vec<usize>,
    pub offsets: Vec<u32>,
    pub trips: u32,
}

pub struct StaticData {
    pub stops: Vec<Stop>,
    stop_index: HashMap<String, usize>,
    pub routes: HashMap<String, Route>,
    pub trips: HashMap<String, Trip>,
    /// shape_id → ordered `[lon, lat]` points
    pub shapes: HashMap<String, Vec<[f64; 2]>>,
    /// route_id → the most-used shape per direction, for drawing route context
    pub route_shapes: HashMap<String, Vec<String>>,
    /// (route_id, direction_id) → most-used shape, for live trips missing from the schedule
    pub route_dir_shape: HashMap<(String, Option<u8>), String>,
    /// Trip planner data
    pub patterns: Vec<Pattern>,
    /// stop index → (pattern index, position in pattern)
    pub stop_patterns: Vec<Vec<(u32, u16)>>,
    /// stop index → stops within walking transfer distance (incl. itself), metres
    pub stop_neighbors: Vec<Vec<(u32, f32)>>,
    pub loaded_at: SystemTime,
}

impl StaticData {
    pub fn stop(&self, id: &str) -> Option<&Stop> {
        self.stop_index.get(id).map(|&i| &self.stops[i])
    }

    /// Shape a live trip runs on: its scheduled shape, else the route's usual shape
    /// for that direction (added / detour trips are not in the schedule).
    pub fn shape_for(&self, trip_id: Option<&str>, route_id: &str, direction: Option<u32>) -> Option<&str> {
        if let Some(t) = trip_id.and_then(|t| self.trips.get(t)).filter(|t| !t.shape_id.is_empty()) {
            return Some(&t.shape_id);
        }
        let dir = direction.and_then(|d| u8::try_from(d).ok());
        self.route_dir_shape
            .get(&(route_id.to_string(), dir))
            .or_else(|| self.route_shapes.get(route_id).and_then(|v| v.first()))
            .map(String::as_str)
    }

    pub fn nearby_stops(&self, lat: f64, lon: f64, radius_m: f64) -> Vec<NearbyStop> {
        let mut out: Vec<NearbyStop> = self
            .stops
            .iter()
            .filter_map(|s| {
                let d = haversine_meters(lat, lon, s.lat, s.lon);
                (d <= radius_m).then(|| NearbyStop { stop: s.clone(), distance_m: d })
            })
            .collect();
        out.sort_by(|a, b| a.distance_m.total_cmp(&b.distance_m));
        out
    }
}

/// Lazily loaded, daily-refreshed static GTFS. The first caller blocks until the
/// data is ready (same behaviour as the original Go `sync.Once`), but a failed load
/// is retried on the next call instead of being remembered forever.
pub struct StaticStore {
    http: reqwest::Client,
    data: RwLock<Option<Arc<StaticData>>>,
    load_lock: Mutex<()>,
}

impl StaticStore {
    pub fn new(http: reqwest::Client) -> Self {
        Self { http, data: RwLock::new(None), load_lock: Mutex::new(()) }
    }

    pub fn try_get(&self) -> Option<Arc<StaticData>> {
        self.data.read().unwrap().clone()
    }

    pub async fn get(&self) -> anyhow::Result<Arc<StaticData>> {
        if let Some(d) = self.try_get() {
            return Ok(d);
        }
        let _guard = self.load_lock.lock().await;
        if let Some(d) = self.try_get() {
            return Ok(d);
        }
        self.reload().await
    }

    /// Re-download (if stale) and re-parse. Called at startup and by the daily refresher.
    pub async fn refresh_if_stale(&self) -> anyhow::Result<()> {
        let _guard = self.load_lock.lock().await;
        if self.try_get().is_some() && !cache_is_stale() {
            return Ok(());
        }
        self.reload().await.map(|_| ())
    }

    async fn reload(&self) -> anyhow::Result<Arc<StaticData>> {
        fs::create_dir_all(GTFS_CACHE_DIR).context("create data dir")?;
        if cache_is_stale() {
            tracing::info!("downloading OC Transpo GTFS schedule...");
            if let Err(err) = self.download_and_extract().await {
                if !cache_complete() {
                    return Err(err);
                }
                tracing::warn!("GTFS refresh failed, using cached files: {err:#}");
            }
        }
        let data = tokio::task::spawn_blocking(parse_all).await??;
        tracing::info!(
            "loaded {} stops, {} routes, {} trips, {} shapes, {} patterns",
            data.stops.len(),
            data.routes.len(),
            data.trips.len(),
            data.shapes.len(),
            data.patterns.len()
        );
        let data = Arc::new(data);
        *self.data.write().unwrap() = Some(data.clone());
        Ok(data)
    }

    async fn download_and_extract(&self) -> anyhow::Result<()> {
        let zip_path = cache_path("GTFSExport.zip");
        let mut resp = self
            .http
            .get(GTFS_ZIP_URL)
            .timeout(Duration::from_secs(180))
            .send()
            .await
            .context("download GTFS zip")?;
        if !resp.status().is_success() {
            return Err(anyhow!("GTFS zip returned {}", resp.status()));
        }
        let mut out = tokio::fs::File::create(&zip_path).await?;
        while let Some(chunk) = resp.chunk().await? {
            out.write_all(&chunk).await?;
        }
        out.flush().await?;
        drop(out);

        let result = tokio::task::spawn_blocking({
            let zip_path = zip_path.clone();
            move || extract_files(&zip_path)
        })
        .await?;
        let _ = fs::remove_file(&zip_path);
        result
    }
}

fn cache_path(name: &str) -> PathBuf {
    Path::new(GTFS_CACHE_DIR).join(name)
}

fn cache_files() -> impl Iterator<Item = &'static str> {
    GTFS_FILES.into_iter().chain([PATTERNS_FILE])
}

fn cache_complete() -> bool {
    cache_files().all(|f| cache_path(f).exists())
}

fn cache_is_stale() -> bool {
    cache_files().any(|f| {
        fs::metadata(cache_path(f))
            .and_then(|m| m.modified())
            .map(|t| t.elapsed().unwrap_or_default() > GTFS_MAX_AGE)
            .unwrap_or(true)
    })
}

fn extract_files(zip_path: &Path) -> anyhow::Result<()> {
    let mut archive = zip::ZipArchive::new(File::open(zip_path)?).context("open GTFS zip")?;
    for wanted in GTFS_FILES {
        let index = (0..archive.len())
            .find(|&i| {
                archive
                    .by_index(i)
                    .ok()
                    .and_then(|f| {
                        Path::new(f.name()).file_name().map(|n| n == wanted)
                    })
                    .unwrap_or(false)
            })
            .ok_or_else(|| anyhow!("{wanted} not found in GTFS zip"))?;
        let mut entry = archive.by_index(index)?;
        let dest = cache_path(wanted);
        let tmp = dest.with_extension("txt.tmp");
        let mut f = File::create(&tmp)?;
        if let Err(err) = io::copy(&mut entry, &mut f) {
            let _ = fs::remove_file(&tmp);
            return Err(err.into());
        }
        fs::rename(&tmp, &dest)?;
    }

    // Stop patterns for the trip planner, streamed from stop_times.txt inside the zip.
    let index = (0..archive.len())
        .find(|&i| {
            archive
                .by_index(i)
                .ok()
                .and_then(|f| Path::new(f.name()).file_name().map(|n| n == "stop_times.txt"))
                .unwrap_or(false)
        })
        .ok_or_else(|| anyhow!("stop_times.txt not found in GTFS zip"))?;
    let entry = archive.by_index(index)?;
    let patterns = crate::patterns::build(File::open(cache_path("trips.txt"))?, io::BufReader::new(entry))?;
    tracing::info!("built {} stop patterns", patterns.len());
    let dest = cache_path(PATTERNS_FILE);
    let tmp = dest.with_extension("json.tmp");
    serde_json::to_writer(io::BufWriter::new(File::create(&tmp)?), &patterns)?;
    fs::rename(&tmp, &dest)?;
    Ok(())
}

/// Load patterns.json and build the planner indexes.
fn load_patterns(
    stops: &[Stop],
    stop_index: &HashMap<String, usize>,
) -> (Vec<Pattern>, Vec<Vec<(u32, u16)>>, Vec<Vec<(u32, f32)>>) {
    let raw: Vec<crate::patterns::RawPattern> = File::open(cache_path(PATTERNS_FILE))
        .ok()
        .and_then(|f| serde_json::from_reader(io::BufReader::new(f)).ok())
        .unwrap_or_else(|| {
            tracing::warn!("no {PATTERNS_FILE}; trip planning disabled until the next schedule download");
            Vec::new()
        });

    let mut patterns = Vec::with_capacity(raw.len());
    let mut stop_patterns: Vec<Vec<(u32, u16)>> = vec![Vec::new(); stops.len()];
    for p in raw {
        let Some(idx) = p.stops.iter().map(|id| stop_index.get(id).copied()).collect::<Option<Vec<_>>>() else {
            continue;
        };
        let pi = patterns.len() as u32;
        for (pos, &si) in idx.iter().enumerate() {
            stop_patterns[si].push((pi, pos as u16));
        }
        patterns.push(Pattern {
            route_id: p.route_id,
            direction_id: p.direction_id,
            headsign: p.headsign,
            shape_id: p.shape_id,
            stops: idx,
            offsets: p.offsets,
            trips: p.trips,
        });
    }

    // Neighbouring stops via a ~250 m grid.
    let cell = 0.003;
    let mut grid: HashMap<(i32, i32), Vec<usize>> = HashMap::new();
    for (i, s) in stops.iter().enumerate() {
        grid.entry(((s.lat / cell) as i32, (s.lon / cell) as i32)).or_default().push(i);
    }
    let stop_neighbors = stops
        .iter()
        .map(|s| {
            let (gy, gx) = ((s.lat / cell) as i32, (s.lon / cell) as i32);
            let mut out = Vec::new();
            for dy in -1..=1 {
                for dx in -1..=1 {
                    for &j in grid.get(&(gy + dy, gx + dx)).into_iter().flatten() {
                        let d = haversine_meters(s.lat, s.lon, stops[j].lat, stops[j].lon);
                        if d <= TRANSFER_RADIUS_M {
                            out.push((j as u32, d as f32));
                        }
                    }
                }
            }
            out
        })
        .collect();
    (patterns, stop_patterns, stop_neighbors)
}

/// CSV reader that tolerates a UTF-8 BOM and looks columns up by header name.
struct Table {
    reader: csv::Reader<File>,
    cols: HashMap<String, usize>,
}

impl Table {
    fn open(name: &str, required: &[&str]) -> anyhow::Result<Self> {
        let mut reader = csv::ReaderBuilder::new()
            .flexible(true)
            .from_path(cache_path(name))
            .with_context(|| format!("open {name}"))?;
        let cols: HashMap<String, usize> = reader
            .headers()?
            .iter()
            .enumerate()
            .map(|(i, h)| (h.trim_start_matches('\u{feff}').trim().to_string(), i))
            .collect();
        for col in required {
            if !cols.contains_key(*col) {
                return Err(anyhow!("{name} missing column {col}"));
            }
        }
        Ok(Self { reader, cols })
    }

    fn rows(&mut self) -> impl Iterator<Item = Row<'_>> + '_ {
        let cols = &self.cols;
        self.reader.records().filter_map(Result::ok).map(move |rec| Row { rec, cols })
    }
}

struct Row<'a> {
    rec: csv::StringRecord,
    cols: &'a HashMap<String, usize>,
}

impl Row<'_> {
    fn get(&self, col: &str) -> &str {
        self.cols.get(col).and_then(|&i| self.rec.get(i)).unwrap_or("").trim()
    }
}

fn parse_all() -> anyhow::Result<StaticData> {
    // stops.txt
    let mut stops = Vec::with_capacity(6000);
    let mut stop_index = HashMap::with_capacity(6000);
    let mut t = Table::open("stops.txt", &["stop_id", "stop_name", "stop_lat", "stop_lon"])?;
    for row in t.rows() {
        let (Ok(lat), Ok(lon)) = (row.get("stop_lat").parse(), row.get("stop_lon").parse())
        else {
            continue;
        };
        let stop = Stop {
            id: row.get("stop_id").to_string(),
            code: row.get("stop_code").to_string(),
            name: row.get("stop_name").to_string(),
            lat,
            lon,
        };
        stop_index.insert(stop.id.clone(), stops.len());
        stops.push(stop);
    }

    // routes.txt
    let mut routes = HashMap::new();
    let mut t = Table::open("routes.txt", &["route_id"])?;
    for row in t.rows() {
        let id = row.get("route_id").to_string();
        let short = row.get("route_short_name");
        let color = row.get("route_color");
        let text_color = row.get("route_text_color");
        routes.insert(
            id.clone(),
            Route {
                short_name: if short.is_empty() { id.clone() } else { short.to_string() },
                long_name: row.get("route_long_name").to_string(),
                color: format!("#{}", if color.is_empty() { "5B6770" } else { color }),
                text_color: format!("#{}", if text_color.is_empty() { "FFFFFF" } else { text_color }),
                route_type: row.get("route_type").parse().unwrap_or(3),
                sort_order: row.get("route_sort_order").parse().unwrap_or(i32::MAX),
                id,
            },
        );
    }

    // trips.txt — also count shape usage per (route, direction) to pick representative shapes
    let mut trips = HashMap::with_capacity(120_000);
    let mut shape_use: HashMap<(String, Option<u8>), HashMap<String, u32>> = HashMap::new();
    let mut t = Table::open("trips.txt", &["route_id", "trip_id"])?;
    for row in t.rows() {
        let trip = Trip {
            route_id: row.get("route_id").to_string(),
            headsign: row.get("trip_headsign").to_string(),
            direction_id: row.get("direction_id").parse().ok(),
            shape_id: row.get("shape_id").to_string(),
        };
        if !trip.shape_id.is_empty() {
            *shape_use
                .entry((trip.route_id.clone(), trip.direction_id))
                .or_default()
                .entry(trip.shape_id.clone())
                .or_default() += 1;
        }
        trips.insert(row.get("trip_id").to_string(), trip);
    }
    let mut route_shapes: HashMap<String, Vec<String>> = HashMap::new();
    let mut route_dir_shape = HashMap::new();
    for ((route_id, dir), counts) in shape_use {
        if let Some((shape, _)) = counts.into_iter().max_by_key(|(id, n)| (*n, id.clone())) {
            route_shapes.entry(route_id.clone()).or_default().push(shape.clone());
            route_dir_shape.insert((route_id, dir), shape);
        }
    }

    // shapes.txt
    let mut raw: HashMap<String, Vec<(u32, [f64; 2])>> = HashMap::new();
    let mut t = Table::open(
        "shapes.txt",
        &["shape_id", "shape_pt_lat", "shape_pt_lon", "shape_pt_sequence"],
    )?;
    for row in t.rows() {
        let (Ok(lat), Ok(lon), Ok(seq)) = (
            row.get("shape_pt_lat").parse::<f64>(),
            row.get("shape_pt_lon").parse::<f64>(),
            row.get("shape_pt_sequence").parse::<u32>(),
        ) else {
            continue;
        };
        raw.entry(row.get("shape_id").to_string()).or_default().push((seq, [lon, lat]));
    }
    let shapes = raw
        .into_iter()
        .map(|(id, mut pts)| {
            pts.sort_by_key(|(seq, _)| *seq);
            (id, pts.into_iter().map(|(_, p)| p).collect())
        })
        .collect();

    let (patterns, stop_patterns, stop_neighbors) = load_patterns(&stops, &stop_index);

    Ok(StaticData {
        patterns,
        stop_patterns,
        stop_neighbors,
        stops,
        stop_index,
        routes,
        trips,
        shapes,
        route_shapes,
        route_dir_shape,
        loaded_at: SystemTime::now(),
    })
}

pub fn haversine_meters(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let to_rad = std::f64::consts::PI / 180.0;
    let d_lat = (lat2 - lat1) * to_rad;
    let d_lon = (lon2 - lon1) * to_rad;
    let a = (d_lat / 2.0).sin().powi(2)
        + (lat1 * to_rad).cos() * (lat2 * to_rad).cos() * (d_lon / 2.0).sin().powi(2);
    2.0 * EARTH_RADIUS_M * a.sqrt().asin()
}
