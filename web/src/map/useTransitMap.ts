// Owns the MapLibre instance: scene setup, the per-frame bus renderer, camera
// moves (fly / follow / chase), clicks, stops-in-view and the user marker.
// React state lives in App; this hook keeps its own mutable state in a ref so
// the 30 fps render loop never re-renders React.

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import * as maplibregl from "maplibre-gl";
import type { Map as MapLibreMap, PaddingOptions } from "maplibre-gl";
import { api, type Vehicle } from "../api";
import { Fleet, circlePolygon, distanceM } from "./fleet";
import { buildBusFeatures } from "./features";
import { installIconResolver } from "./icons";
import { TREES_MIN_ZOOM, buildTrees } from "./trees";
import {
  BASEMAP,
  CLICKABLE_BUS_LAYERS,
  CLICKABLE_STOP_LAYERS,
  EMPTY_FC,
  SOURCES,
  installScene,
  setSourceData,
  setTerrainEnabled,
  type Theme,
} from "./scene";

const FRAME_MS = 33; // ~30 fps is plenty for buses and keeps setData cheap
const STOPS_MIN_ZOOM = 14.8;
const FOLLOW_ZOOM = 17;
const FOLLOW_PITCH = 66;
/** Chase cam: how quickly the map swings round behind the bus on turns (seconds). */
const CHASE_TURN_S = 0.8;
/** Chase cam: aim this far ahead of the bus (metres at zoom 17) so it sits low with road ahead. */
const CHASE_LOOK_AHEAD_M = 22;

/**
 * Debounce that still fires at least every `maxWait` ms under a constant stream
 * of calls (follow mode moves the camera every frame).
 */
function debounce(fn: () => void, wait: number, maxWait: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let first = 0;
  const run = () => {
    timer = undefined;
    first = 0;
    fn();
  };
  const call = () => {
    const now = Date.now();
    if (!first) first = now;
    clearTimeout(timer);
    timer = setTimeout(run, now - first >= maxWait ? 0 : wait);
  };
  call.cancel = () => clearTimeout(timer);
  return call;
}

export interface TransitMapHandlers {
  onVehicleClick: (id: string) => void;
  onStopClick: (id: string) => void;
  onEmptyClick: () => void;
  onFollowChange: (following: boolean) => void;
}

export interface UserPosition {
  lon: number;
  lat: number;
  accuracy: number;
}

interface MutableState {
  styleReady: boolean;
  dirty: boolean;
  lastFrame: number;
  theme: Theme;
  terrain: boolean;
  selectedId: string | null;
  filter: ((v: Vehicle) => boolean) | null;
  /** follow mode: draw only this vehicle */
  solo: string | null;
  follow: boolean;
  chase: boolean;
  /** last chase-cam frame time, for frame-rate independent easing */
  lastCam: number;
  /** vehicle we are flying to; follow starts when the flight lands on it */
  pendingFollow: string | null;
  data: Record<string, GeoJSON.FeatureCollection>;
}

export function useTransitMap(
  container: RefObject<HTMLDivElement | null>,
  init: { theme: Theme; terrain: boolean },
  handlers: TransitMapHandlers,
) {
  const mapRef = useRef<MapLibreMap | null>(null);
  const userMarker = useRef<maplibregl.Marker | null>(null);
  const fleet = useMemo(() => new Fleet(), []);
  const [map, setMap] = useState<MapLibreMap | null>(null);
  const [styleReady, setStyleReady] = useState(false);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const st = useRef<MutableState>({
    styleReady: false,
    dirty: true,
    lastFrame: 0,
    theme: init.theme,
    terrain: init.terrain,
    selectedId: null,
    filter: null,
    solo: null,
    lastCam: 0,
    follow: false,
    chase: false,
    pendingFollow: null,
    data: {
      [SOURCES.route]: EMPTY_FC,
      [SOURCES.routeStops]: EMPTY_FC,
      [SOURCES.stops]: EMPTY_FC,
      [SOURCES.user]: EMPTY_FC,
    },
  });

  // ---- create the map once ----
  useEffect(() => {
    if (!container.current) return;
    const s = st.current;
    const m = new maplibregl.Map({
      container: container.current,
      style: BASEMAP[s.theme],
      center: [-75.6972, 45.4215],
      zoom: 10.5,
      pitch: 0,
      maxPitch: 78,
      attributionControl: { compact: true },
      canvasContextAttributes: { antialias: true },
      fadeDuration: 200,
    });
    mapRef.current = m;
    installIconResolver(m);

    // Trees are rebuilt after the camera stops or new basemap tiles arrive (debounced).
    // ("idle" never fires here because the bus animation keeps the map rendering.)
    let treesShown = false;
    const scheduleTrees = debounce(() => {
      if (!s.styleReady) return;
      if (m.getZoom() < TREES_MIN_ZOOM) {
        if (treesShown) setSourceData(m, SOURCES.trees, EMPTY_FC);
        treesShown = false;
        return;
      }
      setSourceData(m, SOURCES.trees, buildTrees(m));
      treesShown = true;
    }, 350, 1500);
    m.on("moveend", scheduleTrees);
    m.on("sourcedata", (e) => {
      if (e.sourceId === "openmaptiles" && e.tile && !m.isMoving()) scheduleTrees();
    });

    m.on("style.load", () => {
      installScene(m, s.theme, s.terrain);
      for (const [id, fc] of Object.entries(s.data)) setSourceData(m, id, fc);
      s.styleReady = true;
      s.dirty = true;
      setStyleReady(true);
    });

    const markDirty = () => (s.dirty = true);
    m.on("zoom", markDirty);
    m.on("moveend", markDirty);

    // Manual drag breaks follow mode (zoom / rotate / pitch while following are fine).
    m.on("dragstart", () => {
      s.pendingFollow = null;
      if (s.follow) {
        s.follow = false;
        handlersRef.current.onFollowChange(false);
      }
    });

    // Arrival of a fly-to: start following if we actually landed on the bus.
    m.on("moveend", () => {
      const id = s.pendingFollow;
      if (!id) return;
      s.pendingFollow = null;
      const smp = fleet.sample(id);
      if (!smp || id !== s.selectedId) return;
      const c = m.getCenter();
      if (distanceM(c.lat, c.lng, smp.lat, smp.lon) < 150) {
        s.lastCam = performance.now();
        s.follow = true;
        handlersRef.current.onFollowChange(true);
      }
    });

    // Clicks: buses first, then stops, else clear the selection.
    m.on("click", (e) => {
      const box: [maplibregl.PointLike, maplibregl.PointLike] = [
        [e.point.x - 10, e.point.y - 10],
        [e.point.x + 10, e.point.y + 10],
      ];
      const existing = (ids: string[]) => ids.filter((id) => m.getLayer(id));
      const buses = m.queryRenderedFeatures(box, { layers: existing(CLICKABLE_BUS_LAYERS) });
      if (buses.length) {
        const top = buses.find((f) => f.properties?.selected !== true) ?? buses[0];
        handlersRef.current.onVehicleClick(String(top.properties!.id));
        return;
      }
      const stops = m.queryRenderedFeatures(box, { layers: existing(CLICKABLE_STOP_LAYERS) });
      if (stops.length) {
        handlersRef.current.onStopClick(String(stops[0].properties!.id));
        return;
      }
      handlersRef.current.onEmptyClick();
    });

    let hoverPending = false;
    m.on("mousemove", (e) => {
      if (hoverPending) return;
      hoverPending = true;
      requestAnimationFrame(() => {
        hoverPending = false;
        const layers = [...CLICKABLE_BUS_LAYERS, ...CLICKABLE_STOP_LAYERS].filter((id) => m.getLayer(id));
        const hit = m.queryRenderedFeatures(
          [
            [e.point.x - 6, e.point.y - 6],
            [e.point.x + 6, e.point.y + 6],
          ],
          { layers },
        ).length;
        m.getCanvas().style.cursor = hit ? "pointer" : "";
      });
    });

    // Stops in view when zoomed in.
    let stopsCtrl: AbortController | null = null;
    const loadStops = debounce(() => {
      stopsCtrl?.abort();
      if (m.getZoom() < STOPS_MIN_ZOOM) {
        s.data[SOURCES.stops] = EMPTY_FC;
        setSourceData(m, SOURCES.stops, EMPTY_FC);
        return;
      }
      const b = m.getBounds();
      stopsCtrl = new AbortController();
      api
        .stops([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()], stopsCtrl.signal)
        .then(({ stops }) => {
          const fc: GeoJSON.FeatureCollection = {
            type: "FeatureCollection",
            features: stops.map((st) => ({
              type: "Feature",
              properties: { id: st.id, name: st.name, code: st.code },
              geometry: { type: "Point", coordinates: [st.lon, st.lat] },
            })),
          };
          s.data[SOURCES.stops] = fc;
          setSourceData(m, SOURCES.stops, fc);
        })
        .catch(() => {});
    }, 250, 2000);
    m.on("moveend", loadStops);

    // ---- render loop ----
    let raf = 0;
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      if (!s.styleReady) return;
      const animating = fleet.isAnimating(t);
      if (!animating && !s.dirty && !s.follow) return;
      if (t - s.lastFrame < FRAME_MS) return;
      s.lastFrame = t;
      s.dirty = false;

      const samples = fleet
        .samples(t)
        .filter((x) =>
          s.solo ? x.vehicle.id === s.solo : x.vehicle.id === s.selectedId || !s.filter || s.filter(x.vehicle),
        );
      const { shapes, points } = buildBusFeatures(samples, {
        zoom: m.getZoom(),
        selectedId: s.selectedId,
        bounds: m.getPitch() < 50 ? m.getBounds() : null,
      });
      setSourceData(m, SOURCES.busShapes, shapes);
      setSourceData(m, SOURCES.busPoints, points);

      if (s.follow && s.selectedId && !m.isMoving()) {
        const smp = fleet.sample(s.selectedId, t);
        if (smp) {
          const dt = Math.min(0.1, Math.max(0, (t - s.lastCam) / 1000));
          s.lastCam = t;
          let center: [number, number] = [smp.lon, smp.lat];
          const opts: maplibregl.JumpToOptions = {};
          if (s.chase) {
            // Swing the map round so we look along the bus's heading (eased on turns)...
            const cur = m.getBearing();
            const d = ((((smp.bearing - cur) % 360) + 540) % 360) - 180;
            const bearing = cur + d * (1 - Math.exp(-dt / CHASE_TURN_S));
            opts.bearing = bearing;
            // ...and aim a little ahead so the bus sits in the lower part of the view.
            const ahead = CHASE_LOOK_AHEAD_M * 2 ** (17 - m.getZoom());
            const rad = (bearing * Math.PI) / 180;
            center = [
              smp.lon + (Math.sin(rad) * ahead) / (111320 * Math.cos((smp.lat * Math.PI) / 180)),
              smp.lat + (Math.cos(rad) * ahead) / 111320,
            ];
          }
          opts.center = center;
          m.jumpTo(opts);
        }
      }
    };
    raf = requestAnimationFrame(tick);

    setMap(m);
    return () => {
      cancelAnimationFrame(raf);
      scheduleTrees.cancel();
      loadStops.cancel();
      stopsCtrl?.abort();
      m.remove();
      mapRef.current = null;
    };
  }, [container, fleet]);

  const controls = useMemo(() => {
    const s = st.current;
    const m = () => mapRef.current;
    const setData = (id: string, fc: GeoJSON.FeatureCollection) => {
      s.data[id] = fc;
      const map = m();
      if (map && s.styleReady) setSourceData(map, id, fc);
    };

    return {
      markDirty() {
        s.dirty = true;
      },
      setTheme(theme: Theme) {
        const map = m();
        if (!map || theme === s.theme) return;
        s.theme = theme;
        s.styleReady = false;
        map.setStyle(BASEMAP[theme], { diff: false });
      },
      setTerrain(on: boolean) {
        s.terrain = on;
        const map = m();
        if (map && s.styleReady) setTerrainEnabled(map, on);
      },
      setSelected(id: string | null) {
        s.selectedId = id;
        s.dirty = true;
        if (!id) {
          s.solo = null;
          s.pendingFollow = null;
          if (s.follow) {
            s.follow = false;
            handlersRef.current.onFollowChange(false);
          }
        }
      },
      /** Draw only this vehicle (follow mode), or everything again with `null`. */
      setSolo(id: string | null) {
        s.solo = id;
        s.dirty = true;
      },
      setFilter(filter: ((v: Vehicle) => boolean) | null) {
        s.filter = filter;
        s.dirty = true;
      },
      setRoute(fc: GeoJSON.FeatureCollection) {
        setData(SOURCES.route, fc);
      },
      setRouteStops(fc: GeoJSON.FeatureCollection) {
        setData(SOURCES.routeStops, fc);
      },
      setPlan(lines: GeoJSON.FeatureCollection, points: GeoJSON.FeatureCollection) {
        setData(SOURCES.plan, lines);
        setData(SOURCES.planPoints, points);
      },
      setFollow(on: boolean) {
        s.follow = on;
        s.pendingFollow = null;
        handlersRef.current.onFollowChange(on);
        const map = m();
        const smp = s.selectedId ? fleet.sample(s.selectedId) : null;
        if (on && map && smp) {
          map.easeTo({ center: [smp.lon, smp.lat], zoom: Math.max(map.getZoom(), 15.5), duration: 900 });
        }
      },
      setChase(on: boolean) {
        s.chase = on;
        const map = m();
        // Tilt down behind the bus, unless a fly-to (which sets pitch itself) is under way.
        if (on && map && !s.pendingFollow && map.getPitch() < 45) map.easeTo({ pitch: FOLLOW_PITCH, duration: 900 });
      },
      setPadding(padding: PaddingOptions) {
        m()?.easeTo({ padding, duration: 450 });
      },
      flyToVehicle(id: string) {
        const map = m();
        const smp = fleet.sample(id);
        if (!map || !smp) return;
        s.follow = false;
        s.pendingFollow = id;
        map.flyTo({
          center: [smp.lon, smp.lat],
          zoom: Math.max(map.getZoom(), FOLLOW_ZOOM),
          pitch: FOLLOW_PITCH,
          bearing: smp.bearing,
          curve: 1.42,
          speed: 1.1,
          maxDuration: 3200,
          essential: true,
        });
      },
      flyTo(lon: number, lat: number, zoom?: number, pitch = 58) {
        const map = m();
        if (!map) return;
        s.pendingFollow = null;
        if (s.follow) {
          s.follow = false;
          handlersRef.current.onFollowChange(false);
        }
        map.flyTo({ center: [lon, lat], zoom: zoom ?? Math.max(map.getZoom(), 15.5), pitch, curve: 1.4, essential: true });
      },
      fitLines(lines: [number, number][][]) {
        const map = m();
        const pts = lines.flat();
        if (!map || !pts.length) return;
        const b = new maplibregl.LngLatBounds(pts[0], pts[0]);
        for (const p of pts) b.extend(p);
        map.fitBounds(b, { padding: 70, pitch: 45, duration: 1600, maxZoom: 15.5 });
      },
      setUser(pos: UserPosition | null) {
        const map = m();
        if (!pos) {
          userMarker.current?.remove();
          userMarker.current = null;
          setData(SOURCES.user, EMPTY_FC);
          return;
        }
        if (map && !userMarker.current) {
          const el = document.createElement("div");
          el.className = "user-dot";
          el.innerHTML = '<span class="user-dot__pulse"></span><span class="user-dot__core"></span>';
          userMarker.current = new maplibregl.Marker({ element: el, pitchAlignment: "map" })
            .setLngLat([pos.lon, pos.lat])
            .addTo(map);
        }
        userMarker.current?.setLngLat([pos.lon, pos.lat]);
        setData(SOURCES.user, {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              properties: {},
              geometry: { type: "Polygon", coordinates: [circlePolygon(pos.lon, pos.lat, Math.min(pos.accuracy, 500))] },
            },
          ],
        });
      },
    };
  }, [fleet]);

  return { map, styleReady, fleet, controls };
}

export type TransitMapControls = ReturnType<typeof useTransitMap>["controls"];
