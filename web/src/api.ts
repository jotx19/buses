// Types and fetchers for the Rust server's /api/map/* endpoints.

export type LngLat = [number, number];

export interface RouteInfo {
  id: string;
  short_name: string;
  long_name: string;
  color: string;
  text_color: string;
  /** GTFS route_type: 0 = O-Train (light rail), 3 = bus */
  route_type: number;
}

export interface NextStop {
  id: string;
  name: string;
  minutes: number;
  time: string;
}

export interface Vehicle {
  id: string;
  in_service: boolean;
  route: RouteInfo | null;
  trip_id: string | null;
  shape_id: string | null;
  headsign: string | null;
  direction_id: number | null;
  lat: number;
  lon: number;
  bearing: number | null;
  speed_kmh: number | null;
  timestamp: number | null;
  next_stop: NextStop | null;
}

export interface LiveResponse {
  server_time: number;
  feed_time: number | null;
  static_ready: boolean;
  count: number;
  vehicles: Vehicle[];
}

export interface UpcomingStop {
  id: string;
  code: string;
  name: string;
  lat: number;
  lon: number;
  minutes: number;
  time: string;
}

export interface VehicleDetail {
  vehicle: Vehicle;
  upcoming: UpcomingStop[];
  shape: LngLat[] | null;
  server_time: number;
}

export interface Stop {
  id: string;
  code: string;
  name: string;
  lat: number;
  lon: number;
}

export interface StopArrival {
  route: RouteInfo;
  headsign: string | null;
  vehicle_id: string | null;
  minutes: number;
  time: string;
}

export interface StopDetail {
  stop: Stop;
  arrivals: StopArrival[];
}

export interface MapConfig {
  home: { lat: number; lon: number } | null;
  center: { lat: number; lon: number };
  poll_seconds: number;
}

export interface PlanPlace {
  name: string;
  lat: number;
  lon: number;
}

export interface PlanStop extends PlanPlace {
  id: string;
  code: string;
}

export interface Departure {
  minutes: number;
  time: string;
  vehicle_id: string | null;
}

export type PlanLeg =
  | { type: "walk"; from: PlanPlace; to: PlanPlace; meters: number; minutes: number }
  | {
      type: "bus";
      route: RouteInfo;
      headsign: string;
      shape_id: string;
      board: PlanStop;
      alight: PlanStop;
      stops: number;
      ride_minutes: number;
      departures: Departure[];
    };

export interface TripOption {
  total_minutes: number;
  leaves_in: number | null;
  transfers: number;
  walk_meters: number;
  route_ids: string[];
  legs: PlanLeg[];
}

export interface PlanResponse {
  from: PlanPlace;
  to: PlanPlace;
  walk_only_minutes: number;
  options: TripOption[];
}

export interface PlaceResult {
  name: string;
  label: string;
  lat: number;
  lon: number;
}

export interface NearbyBus {
  route_id: string;
  stop_id: string;
  stop_name: string;
  stop_code?: string;
  distance_m: number;
  minutes: number;
  time: string;
}

export interface NearbyResponse {
  lat: number;
  lon: number;
  radius_m: number;
  stop_count: number;
  buses: NearbyBus[];
  spoken: string;
}

async function getJSON<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal, cache: "no-store" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `Request failed (${res.status})`);
  return data as T;
}

export const api = {
  config: () => getJSON<MapConfig>("/api/map/config"),
  live: (signal?: AbortSignal) => getJSON<LiveResponse>("/api/map/live", signal),
  vehicle: (id: string, signal?: AbortSignal) =>
    getJSON<VehicleDetail>(`/api/map/vehicle/${encodeURIComponent(id)}`, signal),
  shape: (id: string) => getJSON<{ id: string; points: LngLat[] }>(`/api/map/shape/${encodeURIComponent(id)}`),
  routes: () => getJSON<{ routes: RouteInfo[] }>("/api/map/routes"),
  route: (id: string) =>
    getJSON<{ route: RouteInfo; shapes: LngLat[][] }>(`/api/map/route/${encodeURIComponent(id)}`),
  stops: (bbox: [number, number, number, number], signal?: AbortSignal) =>
    getJSON<{ stops: Stop[] }>(`/api/map/stops?bbox=${bbox.map((n) => n.toFixed(5)).join(",")}`, signal),
  plan: (from: PlanPlace, to: PlanPlace, signal?: AbortSignal) =>
    getJSON<PlanResponse>(
      `/api/plan?${new URLSearchParams({
        from: `${from.lat},${from.lon}`,
        to: `${to.lat},${to.lon}`,
        from_name: from.name,
        to_name: to.name,
      })}`,
      signal,
    ),
  nearby: (lat: number, lon: number, signal?: AbortSignal) =>
    getJSON<NearbyResponse>(`/api/nearby?lat=${lat}&lon=${lon}`, signal),
  geocode: (q: string, signal?: AbortSignal) =>
    getJSON<{ results: PlaceResult[] }>(`/api/geocode?q=${encodeURIComponent(q)}`, signal),
  stop: (id: string, signal?: AbortSignal) =>
    getJSON<StopDetail>(`/api/map/stop/${encodeURIComponent(id)}`, signal),
};
