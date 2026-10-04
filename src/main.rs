mod api;
mod geocode;
mod gtfs_rt;
mod gtfs_static;
mod map_api;
mod patterns;
mod planner;
mod transit;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::http::{HeaderValue, header};
use axum::routing::get;
use tower_http::compression::CompressionLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;

use gtfs_rt::RtClient;
use gtfs_static::StaticStore;

pub struct AppState {
    pub http: reqwest::Client,
    pub rt: RtClient,
    pub stat: StaticStore,
    pub templates: minijinja::Environment<'static>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _ = dotenvy::dotenv();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,hyper=warn,reqwest=warn".into()),
        )
        .init();

    let http = reqwest::Client::builder()
        .user_agent(concat!("oc-next/", env!("CARGO_PKG_VERSION")))
        .build()?;

    let mut templates = minijinja::Environment::new();
    templates.add_template("bus.html", include_str!("../templates/bus.html"))?;

    let app = Arc::new(AppState {
        rt: RtClient::new(http.clone()),
        stat: StaticStore::new(http.clone()),
        http,
        templates,
    });

    // Preload the schedule, then keep it fresh (OC Transpo publishes it daily).
    tokio::spawn({
        let app = app.clone();
        async move {
            loop {
                if let Err(err) = app.stat.refresh_if_stale().await {
                    tracing::warn!("could not load GTFS schedule: {err:#}");
                }
                tokio::time::sleep(Duration::from_secs(3600)).await;
            }
        }
    });

    // React 3D map build output (web/ → static/map). Hashed assets are cached hard,
    // and unknown /map/* paths fall back to index.html for client-side routing.
    let map_dir = PathBuf::from(std::env::var("MAP_DIST_DIR").unwrap_or_else(|_| "static/map".into()));
    let map_index = map_dir.join("index.html");
    let home_page = map_dir.join("home.html");
    if !map_index.exists() || !home_page.exists() {
        tracing::warn!("{} not built — run `npm run build` in web/ for the homepage and /map", map_dir.display());
    }
    let map_assets = Router::new()
        .nest_service("/map/assets", ServeDir::new(map_dir.join("assets")))
        .layer(SetResponseHeaderLayer::overriding(
            header::CACHE_CONTROL,
            HeaderValue::from_static("public, max-age=31536000, immutable"),
        ));
    let map_pages = Router::new()
        .route_service("/", ServeFile::new(&home_page))
        .route_service("/map", ServeFile::new(&map_index))
        .nest_service("/map/", ServeDir::new(&map_dir).fallback(ServeFile::new(&map_index)))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-cache"),
        ));

    let router = Router::new()
        .route("/next_bus", get(api::next_bus))
        .route("/api/nearby", get(api::api_nearby))
        .route("/api/bus", get(api::api_bus))
        .route("/api/vehicles", get(api::api_vehicles))
        .route("/siri/nearby", get(api::siri_nearby))
        .route("/siri/bus", get(api::siri_bus))
        .route("/api/map/config", get(map_api::config))
        .route("/api/map/live", get(map_api::live))
        .route("/api/map/vehicle/{id}", get(map_api::vehicle))
        .route("/api/map/routes", get(map_api::routes))
        .route("/api/map/shape/{id}", get(map_api::shape))
        .route("/api/map/route/{id}", get(map_api::route))
        .route("/api/map/stops", get(map_api::stops))
        .route("/api/map/stop/{id}", get(map_api::stop))
        .route("/api/plan", get(planner::plan))
        .route("/api/geocode", get(geocode::geocode))
        .with_state(app)
        .merge(map_assets)
        .merge(map_pages)
        // Like the original Go mux, any other path renders the homepage.
        .fallback_service(ServeFile::new(&home_page))
        .layer(CompressionLayer::new());

    let port = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8080u16);
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    tracing::info!("Server running on http://localhost:{port}  (3D map: /map)");
    if api::home_location().is_some() {
        tracing::info!("Home location configured for Siri/HomePod");
    }
    axum::serve(listener, router).await?;
    Ok(())
}
