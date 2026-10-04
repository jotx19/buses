//! Place search for the trip planner, proxied to Photon (OpenStreetMap data,
//! https://photon.komoot.io) and limited to the Ottawa–Gatineau region.
//! Results are cached briefly so typing doesn't hammer the free service.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::Response;
use serde::Serialize;
use serde_json::{Value, json};

use crate::AppState;
use crate::api::{json_error, json_response};

const PHOTON_URL: &str = "https://photon.komoot.io/api/";
/// west,south,east,north around OC Transpo's service area
const BBOX: &str = "-76.36,44.96,-75.24,45.62";
const CACHE_TTL: Duration = Duration::from_secs(600);
const CACHE_MAX: usize = 2000;

#[derive(Serialize, Clone)]
struct PlaceResult {
    name: String,
    label: String,
    lat: f64,
    lon: f64,
}

fn cache() -> &'static Mutex<HashMap<String, (Instant, Vec<PlaceResult>)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (Instant, Vec<PlaceResult>)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn to_result(f: &Value) -> Option<PlaceResult> {
    let p = f.get("properties")?;
    let c = f.pointer("/geometry/coordinates")?.as_array()?;
    let (lon, lat) = (c.first()?.as_f64()?, c.get(1)?.as_f64()?);
    let s = |k: &str| p.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let street = match (s("housenumber"), s("street")) {
        (n, st) if !n.is_empty() && !st.is_empty() => format!("{n} {st}"),
        (_, st) => st,
    };
    let name = if s("name").is_empty() { street.clone() } else { s("name") };
    if name.is_empty() {
        return None;
    }
    let area = [s("district"), s("locality"), s("city")]
        .into_iter()
        .find(|v| !v.is_empty())
        .unwrap_or_default();
    let label = [street, area]
        .into_iter()
        .filter(|v| !v.is_empty() && *v != name)
        .collect::<Vec<_>>()
        .join(", ");
    Some(PlaceResult { name, label, lat, lon })
}

pub async fn geocode(State(app): State<Arc<AppState>>, Query(q): Query<HashMap<String, String>>) -> Response {
    let query = q.get("q").map(|s| s.trim().to_string()).unwrap_or_default();
    if query.chars().count() < 2 {
        return json_response(StatusCode::OK, json!({ "results": [] }));
    }
    let key = query.to_lowercase();
    if let Some((at, hit)) = cache().lock().unwrap().get(&key) {
        if at.elapsed() < CACHE_TTL {
            return json_response(StatusCode::OK, json!({ "results": hit }));
        }
    }

    // Bias toward the caller's position when given, else downtown Ottawa.
    let lat = q.get("lat").cloned().unwrap_or_else(|| "45.4215".into());
    let lon = q.get("lon").cloned().unwrap_or_else(|| "-75.6972".into());
    let resp = app
        .http
        .get(PHOTON_URL)
        .query(&[("q", query.as_str()), ("limit", "7"), ("lang", "en"), ("bbox", BBOX), ("lat", &lat), ("lon", &lon)])
        .timeout(Duration::from_secs(8))
        .send()
        .await;
    let body: Value = match resp {
        Ok(r) if r.status().is_success() => match r.json().await {
            Ok(v) => v,
            Err(err) => return json_error(StatusCode::BAD_GATEWAY, format!("place search failed: {err}")),
        },
        Ok(r) => return json_error(StatusCode::BAD_GATEWAY, format!("place search returned {}", r.status())),
        Err(err) => return json_error(StatusCode::BAD_GATEWAY, format!("place search failed: {err}")),
    };

    let mut results: Vec<PlaceResult> = body
        .get("features")
        .and_then(Value::as_array)
        .map(|fs| fs.iter().filter_map(to_result).collect())
        .unwrap_or_default();
    results.dedup_by(|a, b| a.name == b.name && a.label == b.label);

    let mut c = cache().lock().unwrap();
    if c.len() > CACHE_MAX {
        c.clear();
    }
    c.insert(key, (Instant::now(), results.clone()));
    json_response(StatusCode::OK, json!({ "results": results }))
}
