//! OC Transpo GTFS-RT client.
//!
//! Message types are a hand-written subset of the official `gtfs-realtime.proto`
//! (same field tags), so no protoc/build step is needed. Unknown fields are skipped
//! by prost, and enums are decoded as raw `i32` so unexpected values never fail.

use std::time::{Duration, Instant};

use anyhow::{Context, anyhow};
use prost::Message;
use tokio::sync::Mutex;
use std::sync::Arc;

// OC Transpo GTFS-RT endpoints (Azure developer portal)
pub const TRIP_UPDATES_URL: &str =
    "https://nextrip-public-api.azure-api.net/octranspo/gtfs-rt-tp/beta/v1/TripUpdates";
pub const VEHICLE_POSITIONS_URL: &str =
    "https://nextrip-public-api.azure-api.net/octranspo/gtfs-rt-vp/beta/v1/VehiclePositions";

/// Feeds are shared between every request for this long, so the 3D map polling
/// and the homepage never hammer the OC Transpo API.
const FEED_CACHE_TTL: Duration = Duration::from_secs(10);

#[derive(Clone, PartialEq, Message)]
pub struct FeedMessage {
    #[prost(message, optional, tag = "1")]
    pub header: Option<FeedHeader>,
    #[prost(message, repeated, tag = "2")]
    pub entity: Vec<FeedEntity>,
}

#[derive(Clone, PartialEq, Message)]
pub struct FeedHeader {
    #[prost(string, optional, tag = "1")]
    pub gtfs_realtime_version: Option<String>,
    #[prost(uint64, optional, tag = "3")]
    pub timestamp: Option<u64>,
}

#[derive(Clone, PartialEq, Message)]
pub struct FeedEntity {
    #[prost(string, optional, tag = "1")]
    pub id: Option<String>,
    #[prost(message, optional, tag = "3")]
    pub trip_update: Option<TripUpdate>,
    #[prost(message, optional, tag = "4")]
    pub vehicle: Option<VehiclePosition>,
}

#[derive(Clone, PartialEq, Message)]
pub struct TripUpdate {
    #[prost(message, optional, tag = "1")]
    pub trip: Option<TripDescriptor>,
    #[prost(message, repeated, tag = "2")]
    pub stop_time_update: Vec<StopTimeUpdate>,
    #[prost(message, optional, tag = "3")]
    pub vehicle: Option<VehicleDescriptor>,
    #[prost(uint64, optional, tag = "4")]
    pub timestamp: Option<u64>,
}

#[derive(Clone, PartialEq, Message)]
pub struct StopTimeUpdate {
    #[prost(uint32, optional, tag = "1")]
    pub stop_sequence: Option<u32>,
    #[prost(message, optional, tag = "2")]
    pub arrival: Option<StopTimeEvent>,
    #[prost(message, optional, tag = "3")]
    pub departure: Option<StopTimeEvent>,
    #[prost(string, optional, tag = "4")]
    pub stop_id: Option<String>,
    #[prost(int32, optional, tag = "5")]
    pub schedule_relationship: Option<i32>,
}

#[derive(Clone, PartialEq, Message)]
pub struct StopTimeEvent {
    #[prost(int32, optional, tag = "1")]
    pub delay: Option<i32>,
    #[prost(int64, optional, tag = "2")]
    pub time: Option<i64>,
}

#[derive(Clone, PartialEq, Message)]
pub struct VehiclePosition {
    #[prost(message, optional, tag = "1")]
    pub trip: Option<TripDescriptor>,
    #[prost(message, optional, tag = "2")]
    pub position: Option<Position>,
    #[prost(uint64, optional, tag = "5")]
    pub timestamp: Option<u64>,
    #[prost(string, optional, tag = "7")]
    pub stop_id: Option<String>,
    #[prost(message, optional, tag = "8")]
    pub vehicle: Option<VehicleDescriptor>,
    #[prost(int32, optional, tag = "9")]
    pub occupancy_status: Option<i32>,
}

#[derive(Clone, PartialEq, Message)]
pub struct Position {
    #[prost(float, optional, tag = "1")]
    pub latitude: Option<f32>,
    #[prost(float, optional, tag = "2")]
    pub longitude: Option<f32>,
    #[prost(float, optional, tag = "3")]
    pub bearing: Option<f32>,
    #[prost(float, optional, tag = "5")]
    pub speed: Option<f32>,
}

#[derive(Clone, PartialEq, Message)]
pub struct TripDescriptor {
    #[prost(string, optional, tag = "1")]
    pub trip_id: Option<String>,
    #[prost(string, optional, tag = "2")]
    pub start_time: Option<String>,
    #[prost(string, optional, tag = "3")]
    pub start_date: Option<String>,
    #[prost(int32, optional, tag = "4")]
    pub schedule_relationship: Option<i32>,
    #[prost(string, optional, tag = "5")]
    pub route_id: Option<String>,
    #[prost(uint32, optional, tag = "6")]
    pub direction_id: Option<u32>,
}

#[derive(Clone, PartialEq, Message)]
pub struct VehicleDescriptor {
    #[prost(string, optional, tag = "1")]
    pub id: Option<String>,
    #[prost(string, optional, tag = "2")]
    pub label: Option<String>,
}

/// TripDescriptor.ScheduleRelationship.CANCELED
pub const TRIP_CANCELED: i32 = 3;

struct CachedFeed {
    fetched: Instant,
    feed: Arc<FeedMessage>,
}

/// One cached feed URL. The mutex is held during the upstream request so
/// concurrent callers share a single fetch instead of stampeding.
struct FeedSlot {
    url: &'static str,
    cache: Mutex<Option<CachedFeed>>,
}

pub struct RtClient {
    http: reqwest::Client,
    trip_updates: FeedSlot,
    vehicle_positions: FeedSlot,
}

impl RtClient {
    pub fn new(http: reqwest::Client) -> Self {
        Self {
            http,
            trip_updates: FeedSlot { url: TRIP_UPDATES_URL, cache: Mutex::new(None) },
            vehicle_positions: FeedSlot { url: VEHICLE_POSITIONS_URL, cache: Mutex::new(None) },
        }
    }

    pub async fn trip_updates(&self) -> anyhow::Result<Arc<FeedMessage>> {
        self.fetch(&self.trip_updates).await
    }

    pub async fn vehicle_positions(&self) -> anyhow::Result<Arc<FeedMessage>> {
        self.fetch(&self.vehicle_positions).await
    }

    async fn fetch(&self, slot: &FeedSlot) -> anyhow::Result<Arc<FeedMessage>> {
        let mut cache = slot.cache.lock().await;
        if let Some(c) = cache.as_ref() {
            if c.fetched.elapsed() < FEED_CACHE_TTL {
                return Ok(c.feed.clone());
            }
        }
        let feed = Arc::new(self.fetch_uncached(slot.url).await?);
        *cache = Some(CachedFeed { fetched: Instant::now(), feed: feed.clone() });
        Ok(feed)
    }

    async fn fetch_uncached(&self, url: &str) -> anyhow::Result<FeedMessage> {
        let sub_key = std::env::var("OCTRANSPO_SUBSCRIPTION_KEY").unwrap_or_default();
        if sub_key.is_empty() {
            return Err(anyhow!(
                "missing OCTRANSPO_SUBSCRIPTION_KEY (set it in .env or export it)"
            ));
        }
        let resp = self
            .http
            .get(url)
            .header("Ocp-Apim-Subscription-Key", sub_key)
            .header("Cache-Control", "no-cache")
            .timeout(Duration::from_secs(15))
            .send()
            .await?;
        let status = resp.status();
        if !status.is_success() {
            return Err(anyhow!("OC Transpo API returned {status}"));
        }
        let body = resp.bytes().await?;
        FeedMessage::decode(body).context("failed to parse GTFS-RT protobuf")
    }
}
