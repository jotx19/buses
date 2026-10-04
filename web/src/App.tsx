import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type LngLat,
  type MapConfig,
  type PlanPlace,
  type PlanResponse,
  type RouteInfo,
  type StopDetail as StopData,
  type Vehicle,
  type VehicleDetail,
} from "./api";
import { BusDetail } from "./components/BusDetail";
import { MapControls } from "./components/MapControls";
import { NearbyList } from "./components/NearbyList";
import { Sidebar } from "./components/Sidebar";
import { StopDetail } from "./components/StopDetail";
import { TripView } from "./components/TripView";
import { cx, glass } from "./components/ui";
import { IconBack } from "./components/Icons";
import { distanceM } from "./map/fleet";
import { routeLines, upcomingStopFeatures } from "./map/features";
import { planFeatures } from "./map/plan";
import { EMPTY_FC, type Theme } from "./map/scene";
import { useTransitMap, type UserPosition } from "./map/useTransitMap";

const DEFAULT_POLL_MS = 10_000;
const STOP_POLL_MS = 20_000;
const THEME_KEY = "oc-next-theme"; // shared with the homepage
const TERRAIN_KEY = "oc-next-map-terrain";
const SIDEBAR_PX = 404; // sidebar width + gutter, kept clear of camera focus
const PLAN_REFRESH_MS = 30_000;

/** Trip request from the homepage: /map?from=lat,lon&from_name=…&to=lat,lon&to_name=… */
function readTripParams(): { from: PlanPlace; to: PlanPlace } | null {
  const q = new URLSearchParams(window.location.search);
  const place = (key: string, fallback: string): PlanPlace | null => {
    const [lat, lon] = (q.get(key) ?? "").split(",").map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return null;
    return { lat, lon, name: q.get(`${key}_name`) || fallback };
  };
  const from = place("from", "Start");
  const to = place("to", "Destination");
  return from && to ? { from, to } : null;
}

function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode — preference just isn't remembered */
  }
}

function useIsMobile() {
  const query = "(max-width: 767px)";
  const [mobile, setMobile] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMobile(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return mobile;
}

export default function App() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [theme, setTheme] = useState<Theme>(() => (readPref(THEME_KEY) === "light" ? "light" : "dark"));
  const [terrain, setTerrain] = useState(() => readPref(TERRAIN_KEY) !== "off");
  const [config, setConfig] = useState<MapConfig | null>(null);

  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [allRoutes, setAllRoutes] = useState<RouteInfo[]>([]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<VehicleDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  /** follow mode: only this bus is drawn and the camera tracks it */
  const [following, setFollowing] = useState(false);
  /** camera currently locked onto the bus (a drag releases it) */
  const [cameraLocked, setCameraLocked] = useState(false);
  const [chase, setChase] = useState(false);

  const [filterRoute, setFilterRoute] = useState<RouteInfo | null>(null);
  const [filterShapes, setFilterShapes] = useState<LngLat[][]>([]);

  const [stopId, setStopId] = useState<string | null>(null);
  const [stopDetail, setStopDetail] = useState<StopData | null>(null);
  const [stopError, setStopError] = useState<string | null>(null);

  const [trip, setTrip] = useState(readTripParams);
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [activeOption, setActiveOption] = useState(0);

  const [user, setUser] = useState<UserPosition | null>(null);
  const [locating, setLocating] = useState(false);
  const [mapCenter, setMapCenter] = useState<{ lat: number; lon: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const mobile = useIsMobile();
  /** phones: bottom sheet minimised, and its measured height (for map padding / toasts) */
  const [sheetCollapsed, setSheetCollapsed] = useState(false);
  const [sheetHeight, setSheetHeight] = useState(0);

  const { map, styleReady, fleet, controls } = useTransitMap(
    containerRef,
    { theme, terrain },
    {
      onVehicleClick: (id) => selectVehicle(id),
      onStopClick: (id) => selectStop(id),
      onEmptyClick: () => {},
      onFollowChange: setCameraLocked,
    },
  );

  // ---- clock + notices ----
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4500);
    return () => clearTimeout(t);
  }, [notice]);

  // ---- config + intro camera ----
  useEffect(() => {
    api.config().then(setConfig).catch(() => setConfig(null));
    api.routes().then((r) => setAllRoutes(r.routes)).catch(() => {});
  }, []);

  const introDone = useRef(false);
  useEffect(() => {
    if (!map || !styleReady || !config || introDone.current) return;
    introDone.current = true;
    if (trip) return; // the trip is framed instead
    map.flyTo({
      center: [config.center.lon, config.center.lat],
      zoom: 15.6,
      pitch: 62,
      bearing: -24,
      duration: 3800,
      curve: 1.3,
      essential: true,
    });
  }, [map, styleReady, config]);

  // Map centre feeds the "nearby" list when location isn't shared (only on real moves).
  useEffect(() => {
    if (!map) return;
    const update = () => {
      const c = map.getCenter();
      setMapCenter((prev) =>
        prev && distanceM(prev.lat, prev.lon, c.lat, c.lng) < 150 ? prev : { lat: c.lat, lon: c.lng },
      );
    };
    map.on("moveend", update);
    update();
    return () => {
      map.off("moveend", update);
    };
  }, [map]);

  // ---- live vehicle polling (pauses while the tab is hidden) ----
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ctrl: AbortController | null = null;
    let stopped = false;
    const pollMs = (config?.poll_seconds ?? 0) * 1000 || DEFAULT_POLL_MS;

    const poll = async () => {
      clearTimeout(timer);
      ctrl?.abort();
      ctrl = new AbortController();
      try {
        const data = await api.live(ctrl.signal);
        fleet.update(data.vehicles);
        controls.markDirty();
        setVehicles(data.vehicles);
        setUpdatedAt(Date.now());
        setLiveError(null);
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setLiveError((err as Error).message);
      }
      if (!stopped && !document.hidden) timer = setTimeout(poll, pollMs);
    };
    const onVisibility = () => {
      if (!document.hidden) poll();
      else clearTimeout(timer);
    };
    poll();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      clearTimeout(timer);
      ctrl?.abort();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [config, fleet, controls]);

  const liveIds = useMemo(() => new Set(vehicles.map((v) => v.id)), [vehicles]);
  const selected = useMemo(() => vehicles.find((v) => v.id === selectedId) ?? null, [vehicles, selectedId]);

  // ---- selection ----
  const stopFollowing = useCallback(() => {
    setFollowing(false);
    setChase(false);
    controls.setChase(false);
    controls.setSolo(null);
    controls.setFollow(false);
  }, [controls]);

  const backToNearby = useCallback(() => {
    stopFollowing();
    setSelectedId(null);
    setStopId(null);
    controls.setSelected(null);
  }, [controls, stopFollowing]);

  /** The next detail response for this id should frame the whole route. */
  const fitOnDetail = useRef<string | null>(null);

  const selectVehicle = useCallback(
    (id: string) => {
      if (id !== selectedId) stopFollowing();
      setStopId(null);
      setSelectedId(id);
      setDetail((d) => (d?.vehicle.id === id ? d : null));
      setDetailError(null);
      controls.setSelected(id);
      fitOnDetail.current = id;
    },
    [controls, selectedId, stopFollowing],
  );

  const selectStop = useCallback(
    (id: string) => {
      stopFollowing();
      setSelectedId(null);
      controls.setSelected(null);
      setStopId(id);
      setStopDetail((d) => (d?.stop.id === id ? d : null));
      setStopError(null);
    },
    [controls, stopFollowing],
  );

  const follow = useCallback(
    (on: boolean) => {
      if (!selectedId) return;
      if (!on) {
        stopFollowing();
        return;
      }
      setFollowing(true);
      controls.setSolo(selectedId);
      controls.flyToVehicle(selectedId); // camera locks on once it lands
      // Default to the camera sitting behind the bus and turning with it.
      setChase(true);
      controls.setChase(true);
    },
    [controls, selectedId, stopFollowing],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !(e.target instanceof HTMLInputElement)) backToNearby();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [backToNearby]);

  // Bus detail (upcoming stops + shape): on selection and after every live poll.
  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    const ctrl = new AbortController();
    api
      .vehicle(selectedId, ctrl.signal)
      .then((d) => {
        setDetail(d);
        setDetailError(null);
        // First response after selecting: show the whole route.
        if (fitOnDetail.current === selectedId) {
          fitOnDetail.current = null;
          if (d.shape?.length) controls.fitLines([d.shape]);
          else controls.flyTo(d.vehicle.lon, d.vehicle.lat, 16);
        }
      })
      .catch((err: Error) => {
        if (err.name !== "AbortError") setDetailError(err.message);
      });
    return () => ctrl.abort();
  }, [selectedId, updatedAt, controls]);

  // Stop arrivals, refreshed while the stop view is open.
  useEffect(() => {
    if (!stopId) {
      setStopDetail(null);
      return;
    }
    let ctrl = new AbortController();
    const load = () => {
      ctrl.abort();
      ctrl = new AbortController();
      api
        .stop(stopId, ctrl.signal)
        .then((d) => {
          setStopDetail(d);
          setStopError(null);
        })
        .catch((err: Error) => {
          if (err.name !== "AbortError") setStopError(err.message);
        });
    };
    load();
    const t = setInterval(load, STOP_POLL_MS);
    return () => {
      clearInterval(t);
      ctrl.abort();
    };
  }, [stopId]);

  // ---- route filter ----
  const applyFilter = useCallback(
    (route: RouteInfo | null) => {
      setFilterRoute(route);
      setFilterShapes([]);
      if (!route) return;
      api
        .route(route.id)
        .then((r) => {
          setFilterShapes(r.shapes);
          if (!selectedId) controls.fitLines(r.shapes);
        })
        .catch((err: Error) => setNotice(err.message));
    },
    [controls, selectedId],
  );

  // /map?route=110 (e.g. from the Siri shortcut): open filtered to that route.
  const routeParamDone = useRef(false);
  useEffect(() => {
    if (routeParamDone.current || !allRoutes.length) return;
    routeParamDone.current = true;
    const wanted = new URLSearchParams(window.location.search).get("route")?.match(/\d+|[A-Za-z]+/)?.[0];
    if (!wanted) return;
    const route = allRoutes.find((r) => r.short_name.toLowerCase() === wanted.toLowerCase());
    if (route) applyFilter(route);
    else setNotice(`Route ${wanted} isn't in the OC Transpo schedule.`);
  }, [allRoutes, applyFilter]);

  // ---- trip planning ----
  useEffect(() => {
    if (!trip) {
      setPlan(null);
      return;
    }
    let ctrl = new AbortController();
    const load = (first: boolean) => {
      ctrl.abort();
      ctrl = new AbortController();
      if (first) setPlanLoading(true);
      api
        .plan(trip.from, trip.to, ctrl.signal)
        .then((p) => {
          setPlan(p);
          setPlanError(null);
          if (first) setActiveOption(0);
        })
        .catch((err: Error) => {
          if (err.name !== "AbortError") setPlanError(err.message);
        })
        .finally(() => first && setPlanLoading(false));
    };
    load(true);
    const t = setInterval(() => load(false), PLAN_REFRESH_MS); // keep live departures fresh
    return () => {
      clearInterval(t);
      ctrl.abort();
    };
  }, [trip]);

  const option = plan?.options[activeOption] ?? null;

  // Draw the chosen option; frame it when it changes (not on every refresh).
  const framedKey = useRef("");
  useEffect(() => {
    if (!option) {
      controls.setPlan(EMPTY_FC, EMPTY_FC);
      return;
    }
    let cancelled = false;
    planFeatures(option, fleet.shapes).then(({ lines, points, bounds }) => {
      if (cancelled) return;
      controls.setPlan(lines, points);
      const key = `${activeOption}:${option.route_ids.join(">")}`;
      if (styleReady && framedKey.current !== key && !selectedId) {
        framedKey.current = key;
        controls.fitLines([bounds]);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [option, activeOption, controls, fleet, styleReady, selectedId]);

  // Which buses are drawn: a searched route, else the trip's routes, else everything.
  useEffect(() => {
    if (filterRoute) controls.setFilter((v) => v.route?.id === filterRoute.id);
    else if (option) {
      const ids = new Set(option.route_ids);
      controls.setFilter((v) => v.route != null && ids.has(v.route.id));
    } else controls.setFilter(null);
  }, [controls, filterRoute, option]);

  const clearTrip = useCallback(() => {
    setTrip(null);
    setPlan(null);
    setPlanError(null);
    framedKey.current = "";
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  // ---- route context on the map: selected bus wins, else the filtered route ----
  useEffect(() => {
    if (selected && detail && detail.vehicle.id === selected.id) {
      const color = selected.route?.color ?? "#8e8e93";
      controls.setRoute(detail.shape ? routeLines([detail.shape], color) : EMPTY_FC);
      controls.setRouteStops(upcomingStopFeatures(detail.upcoming, color));
    } else if (selectedId) {
      controls.setRouteStops(EMPTY_FC);
    } else if (filterRoute) {
      controls.setRoute(routeLines(filterShapes, filterRoute.color));
      controls.setRouteStops(EMPTY_FC);
    } else {
      controls.setRoute(EMPTY_FC);
      controls.setRouteStops(EMPTY_FC);
    }
  }, [controls, selected, selectedId, detail, filterRoute, filterShapes]);

  // Keep camera focus clear of the sidebar (left on desktop, bottom sheet on phones).
  useEffect(() => {
    if (!map) return;
    // bucket the sheet height so small layout jitter doesn't re-ease the camera
    const sheet = Math.round(sheetHeight / 24) * 24;
    controls.setPadding(
      mobile
        ? { top: 80, bottom: Math.min(sheet + 16, Math.round(window.innerHeight * 0.7)), left: 0, right: 0 }
        : { top: 40, bottom: 40, left: SIDEBAR_PX, right: 70 },
    );
  }, [map, controls, mobile, sheetHeight]);

  // Picking something opens the sheet again on phones.
  useEffect(() => {
    if (selectedId || stopId || trip) setSheetCollapsed(false);
  }, [selectedId, stopId, trip]);

  // The selected bus left the feed (end of trip, GPS dropout).
  useEffect(() => {
    if (selectedId && updatedAt && !selected && vehicles.length) {
      setNotice(`Bus ${selectedId} left the live feed.`);
      backToNearby();
    }
  }, [selected, selectedId, updatedAt, vehicles.length, backToNearby]);

  // ---- theme / terrain ----
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    writePref(THEME_KEY, theme);
    controls.setTheme(theme);
  }, [theme, controls]);

  useEffect(() => {
    writePref(TERRAIN_KEY, terrain ? "on" : "off");
    controls.setTerrain(terrain);
  }, [terrain, controls]);

  // ---- geolocation ----
  const watchId = useRef<number | null>(null);
  const flyOnFix = useRef(false);
  const startLocating = useCallback(
    (fly: boolean) => {
      if (!("geolocation" in navigator)) {
        setNotice("Location is not supported by this browser.");
        return;
      }
      if (watchId.current != null) {
        if (fly && user) controls.flyTo(user.lon, user.lat, 16);
        return;
      }
      flyOnFix.current = fly;
      setLocating(true);
      watchId.current = navigator.geolocation.watchPosition(
        (pos) => {
          const p = { lon: pos.coords.longitude, lat: pos.coords.latitude, accuracy: pos.coords.accuracy };
          setUser(p);
          setLocating(false);
          controls.setUser(p);
          if (flyOnFix.current) {
            flyOnFix.current = false;
            controls.flyTo(p.lon, p.lat, 16);
          }
        },
        (err) => {
          setLocating(false);
          if (watchId.current != null) navigator.geolocation.clearWatch(watchId.current);
          watchId.current = null;
          if (fly) setNotice(`Location unavailable: ${err.message}`);
        },
        { enableHighAccuracy: true, maximumAge: 10_000, timeout: 20_000 },
      );
    },
    [controls, user],
  );

  // If location permission was already granted, show the user without prompting.
  useEffect(() => {
    if (!map || !styleReady || !navigator.permissions) return;
    navigator.permissions
      .query({ name: "geolocation" })
      .then((p) => {
        if (p.state === "granted") startLocating(false);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, styleReady]);

  useEffect(
    () => () => {
      if (watchId.current != null) navigator.geolocation.clearWatch(watchId.current);
    },
    [],
  );

  const origin = user ?? mapCenter;
  const originLabel = user ? "near you" : "near map centre";

  return (
    <div className="fixed inset-0 font-sans text-zinc-900 antialiased dark:text-white">
      {/* MapLibre forces `position: relative` on its container, so size it from a positioned wrapper */}
      <div className="absolute inset-0">
        <div ref={containerRef} className="h-full w-full" />
      </div>

      <Sidebar
        vehicles={vehicles}
        allRoutes={allRoutes}
        updatedAt={updatedAt}
        now={now}
        error={liveError}
        filterRoute={filterRoute}
        onFilter={applyFilter}
        collapsed={sheetCollapsed}
        onCollapsedChange={setSheetCollapsed}
        onHeight={setSheetHeight}
        summary={
          selected ? (
            <div className="flex items-center gap-2.5 text-[14px] font-medium">
              <span
                className="inline-grid h-6 min-w-[32px] place-items-center rounded-md px-1.5 text-xs font-bold"
                style={{ background: selected.route?.color ?? "#8e8e93", color: selected.route?.text_color ?? "#fff" }}
              >
                {selected.route?.short_name ?? "—"}
              </span>
              <span className="truncate">{selected.headsign ?? "In service"}</span>
              {following && <span className="ml-auto flex-none text-xs text-emerald-500">Following</span>}
            </div>
          ) : trip && plan ? (
            <div className="truncate text-[14px] font-medium">
              {plan.from.name} → {plan.to.name}
            </div>
          ) : null
        }
      >
        {selected ? (
          <BusDetail
            vehicle={selected}
            detail={detail}
            detailError={detailError}
            user={user}
            now={now}
            following={following}
            cameraLocked={cameraLocked}
            chase={chase}
            onBack={backToNearby}
            backLabel={trip ? "Trip" : "Nearby"}
            onFollow={follow}
            onRecenter={() => selectedId && controls.flyToVehicle(selectedId)}
            onChase={(on) => {
              setChase(on);
              controls.setChase(on);
            }}
            onShowRoute={() => detail?.shape && controls.fitLines([detail.shape])}
            onStop={(s) => controls.flyTo(s.lon, s.lat, 17, 55)}
          />
        ) : stopId ? (
          <StopDetail
            stopId={stopId}
            detail={stopDetail}
            error={stopError}
            liveIds={liveIds}
            onBack={backToNearby}
            onVehicle={selectVehicle}
          />
        ) : trip ? (
          <TripView
            plan={plan}
            loading={planLoading}
            error={planError}
            active={activeOption}
            liveIds={liveIds}
            onActive={(i) => setActiveOption(i)}
            onTrack={selectVehicle}
            onClear={clearTrip}
          />
        ) : (
          <NearbyList
            vehicles={vehicles}
            origin={origin}
            originLabel={originLabel}
            filterRoute={filterRoute}
            loading={updatedAt == null}
            onSelect={selectVehicle}
          />
        )}
      </Sidebar>

      {/* Home: top-left on every screen size */}
      <a
        href="/"
        className={cx(
          glass,
          "absolute left-4 top-4 z-30 inline-flex h-11 items-center gap-1 rounded-full pl-2.5 pr-4 text-[14px] font-semibold text-zinc-900 transition active:scale-95 dark:text-white",
          "hover:bg-white/60 dark:hover:bg-[#2a2a2d]/60 max-md:left-2 max-md:top-[max(0.5rem,env(safe-area-inset-top))]",
        )}
        aria-label="Home"
      >
        <IconBack /> Home
      </a>

      <MapControls
        map={map}
        theme={theme}
        terrain={terrain}
        locating={locating}
        hasUser={Boolean(user)}
        hasHome={Boolean(config?.home)}
        hidden={false}
        onTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
        onTerrain={() => setTerrain((t) => !t)}
        onLocate={() => startLocating(true)}
        onHome={() => config?.home && controls.flyTo(config.home.lon, config.home.lat, 15.5)}
      />

      {(notice || (liveError && updatedAt == null)) && (
        <div
          role="status"
          style={mobile ? { bottom: sheetHeight + 20 } : undefined}
          className={cx(
            glass,
            "absolute bottom-6 left-1/2 z-30 max-w-[min(480px,calc(100vw-2rem))] -translate-x-1/2 rounded-full px-5 py-3 text-sm font-medium md:left-[calc(50%+190px)]",
            liveError && !notice && "text-red-500",
          )}
        >
          {notice ?? `Could not load live buses: ${liveError}`}
        </div>
      )}

      {!styleReady && (
        <div className="absolute inset-0 z-40 grid place-items-center bg-[#1c1c1e] text-sm text-white/50 [[data-theme=light]_&]:bg-[#f2f2f7] [[data-theme=light]_&]:text-black/50">
          Loading 3D map…
        </div>
      )}
    </div>
  );
}
