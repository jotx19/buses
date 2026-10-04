// Smooth, on-road motion for live vehicles.
//
// Each GPS fix is projected onto the vehicle's route shape, giving a distance
// along the road. Between fixes the bus travels *along the shape* from where it
// is drawn to the new distance, at constant speed over roughly the time between
// fixes — so it follows curves and corners, and the next glide starts before the
// last one ends, keeping motion continuous. Heading comes from the road itself and
// is eased per frame, so turns sweep round instead of snapping.
//
// Vehicles without a usable shape (out of service, detours, GPS far from the
// route) fall back to a straight glide between fixes.

import type { Vehicle } from "../api";
import { ShapeCache, type RouteShape } from "./shapes";

const SNAP_TO_ROUTE_M = 60; // farther than this from the shape → off-route, glide freely
const MIN_GLIDE_MS = 2000;
const MAX_GLIDE_MS = 30000;
const DEFAULT_GAP_MS = 12000;
const JUMP_M = 1500; // bigger jumps teleport instead of racing across town
const HOLD_BACK_M = 80; // GPS slightly behind the drawn bus → hold rather than reverse
const TURN_TIME_S = 0.45; // heading easing time constant
const DROP_AFTER_MISSES = 2;

interface Pose {
  lon: number;
  lat: number;
  bearing: number;
}

interface Track {
  vehicle: Vehicle;
  misses: number;
  start: number;
  duration: number;
  /** route mode: distance along `shape` */
  shape: RouteShape | null;
  shapeId: string | null;
  sFrom: number;
  sTo: number;
  /** free mode */
  from: Pose;
  to: Pose;
  /** eased heading actually drawn */
  shownBearing: number;
  lastFrame: number;
  bearingKnown: boolean;
}

export interface Sample {
  vehicle: Vehicle;
  lon: number;
  lat: number;
  bearing: number;
  bearingKnown: boolean;
  onRoute: boolean;
}

export class Fleet {
  private tracks = new Map<string, Track>();
  readonly shapes = new ShapeCache();

  /** Feed a fresh /api/map/live snapshot. */
  update(vehicles: Vehicle[], now = performance.now()) {
    const seen = new Set<string>();
    for (const v of vehicles) {
      seen.add(v.id);
      const shape = v.shape_id ? this.shapes.get(v.shape_id) ?? null : null;
      if (v.shape_id && !shape) void this.shapes.load(v.shape_id); // ready by the next poll

      const track = this.tracks.get(v.id);
      if (!track) {
        this.tracks.set(v.id, this.create(v, shape, now));
        continue;
      }
      track.misses = 0;
      const prevTs = track.vehicle.timestamp;
      track.vehicle = v;
      if (prevTs != null && v.timestamp === prevTs) {
        // Same GPS fix as last poll. If its shape just finished loading and the bus is
        // parked (not mid-glide), put it on the road now rather than at the next fix.
        if (shape && track.shape !== shape && this.progress(track, now) >= 1) {
          const fix = shape.project(v.lon, v.lat);
          if (fix && fix.dist <= SNAP_TO_ROUTE_M) {
            Object.assign(track, { shape, shapeId: v.shape_id, sFrom: fix.s, sTo: fix.s, duration: 0, bearingKnown: true });
          }
        }
        continue;
      }

      const gap = prevTs != null && v.timestamp != null ? (v.timestamp - prevTs) * 1000 : DEFAULT_GAP_MS;
      const duration = clamp(gap, MIN_GLIDE_MS, MAX_GLIDE_MS);
      const cur = this.pose(track, now);

      // ---- on-route glide ----
      if (shape) {
        const sameShape = track.shape === shape;
        const curS = sameShape ? this.currentS(track, now) : shape.project(cur.lon, cur.lat)?.s;
        const fix = shape.project(v.lon, v.lat, curS);
        if (fix && fix.dist <= SNAP_TO_ROUTE_M && curS != null) {
          const curOnShape = sameShape || (shape.project(cur.lon, cur.lat)?.dist ?? Infinity) <= SNAP_TO_ROUTE_M;
          track.shape = shape;
          track.shapeId = v.shape_id;
          track.bearingKnown = true;
          track.start = now;
          if (!curOnShape || Math.abs(fix.s - curS) > JUMP_M) {
            track.sFrom = track.sTo = fix.s; // teleport (new trip, re-route, first fix on shape)
            track.duration = 0;
          } else if (fix.s < curS) {
            // Drawn bus is ahead of the GPS (it has been gliding on old info): hold position,
            // or ease back quickly if the gap is large.
            const back = curS - fix.s;
            track.sFrom = curS;
            track.sTo = back > HOLD_BACK_M ? fix.s : curS;
            track.duration = back > HOLD_BACK_M ? 1500 : 0;
          } else {
            track.sFrom = curS;
            track.sTo = fix.s;
            track.duration = duration;
          }
          continue;
        }
      }

      // ---- free glide (no shape / off-route) ----
      const target: Pose = { lon: v.lon, lat: v.lat, bearing: v.bearing ?? cur.bearing };
      const dist = distanceM(cur.lat, cur.lon, target.lat, target.lon);
      if (v.bearing == null && dist > 3) target.bearing = bearingDeg(cur.lat, cur.lon, target.lat, target.lon);
      track.bearingKnown ||= v.bearing != null || dist > 3;
      track.shape = null;
      track.shapeId = null;
      track.from = dist > JUMP_M ? target : cur;
      track.to = target;
      track.start = now;
      track.duration = dist > JUMP_M ? 0 : duration;
    }

    for (const [id, track] of this.tracks) {
      if (!seen.has(id) && ++track.misses > DROP_AFTER_MISSES) this.tracks.delete(id);
    }
  }

  private create(v: Vehicle, shape: RouteShape | null, now: number): Track {
    const fix = shape?.project(v.lon, v.lat);
    const onRoute = Boolean(fix && fix.dist <= SNAP_TO_ROUTE_M);
    const pose: Pose = { lon: v.lon, lat: v.lat, bearing: v.bearing ?? 0 };
    const bearing = onRoute ? shape!.heading(fix!.s) : pose.bearing;
    return {
      vehicle: v,
      misses: 0,
      start: now,
      duration: 0,
      shape: onRoute ? shape : null,
      shapeId: onRoute ? v.shape_id : null,
      sFrom: fix?.s ?? 0,
      sTo: fix?.s ?? 0,
      from: pose,
      to: pose,
      shownBearing: bearing,
      lastFrame: now,
      bearingKnown: onRoute || v.bearing != null,
    };
  }

  private progress(t: Track, now: number) {
    return t.duration > 0 ? clamp((now - t.start) / t.duration, 0, 1) : 1;
  }

  private currentS(t: Track, now: number) {
    return t.sFrom + (t.sTo - t.sFrom) * this.progress(t, now);
  }

  private pose(t: Track, now: number): Pose {
    if (t.shape) return t.shape.at(this.currentS(t, now));
    const k = this.progress(t, now);
    return {
      lon: t.from.lon + (t.to.lon - t.from.lon) * k,
      lat: t.from.lat + (t.to.lat - t.from.lat) * k,
      bearing: lerpAngle(t.from.bearing, t.to.bearing, Math.min(1, k * 3)),
    };
  }

  private toSample(t: Track, now: number, advance: boolean): Sample {
    const p = this.pose(t, now);
    if (advance) {
      // Ease the drawn heading toward the road heading (frame-rate independent).
      const dt = Math.max(0, (now - t.lastFrame) / 1000);
      t.lastFrame = now;
      t.shownBearing = lerpAngle(t.shownBearing, p.bearing, 1 - Math.exp(-dt / TURN_TIME_S));
    }
    return {
      vehicle: t.vehicle,
      lon: p.lon,
      lat: p.lat,
      bearing: t.shownBearing,
      bearingKnown: t.bearingKnown,
      onRoute: t.shape != null,
    };
  }

  /** One vehicle, without advancing heading easing (used by the camera). */
  sample(id: string, now = performance.now()): Sample | null {
    const t = this.tracks.get(id);
    return t ? this.toSample(t, now, false) : null;
  }

  /** Every vehicle for this frame (advances heading easing). */
  samples(now = performance.now()): Sample[] {
    const out: Sample[] = [];
    for (const t of this.tracks.values()) out.push(this.toSample(t, now, true));
    return out;
  }

  /** True while anything is still moving or turning. */
  isAnimating(now = performance.now()): boolean {
    for (const t of this.tracks.values()) {
      if (t.duration > 0 && now - t.start < t.duration) return true;
      if (Math.abs(angleDiff(t.shownBearing, this.pose(t, now).bearing)) > 0.5) return true;
    }
    return false;
  }
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

function angleDiff(a: number, b: number) {
  return ((((b - a) % 360) + 540) % 360) - 180;
}

function lerpAngle(a: number, b: number, k: number) {
  if (!Number.isFinite(a)) return b;
  if (!Number.isFinite(b)) return a;
  return (a + angleDiff(a, b) * k + 360) % 360;
}

const R = 6371000;
const RAD = Math.PI / 180;

export function distanceM(lat1: number, lon1: number, lat2: number, lon2: number) {
  const dLat = (lat2 - lat1) * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number) {
  const y = Math.sin((lon2 - lon1) * RAD) * Math.cos(lat2 * RAD);
  const x =
    Math.cos(lat1 * RAD) * Math.sin(lat2 * RAD) -
    Math.sin(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.cos((lon2 - lon1) * RAD);
  return ((Math.atan2(y, x) / RAD) + 360) % 360;
}

/**
 * Footprint of a vehicle as a closed lon/lat ring: a box with a tapered nose,
 * rotated to `bearing` (degrees clockwise from north) and centred on the vehicle.
 */
export function vehicleFootprint(
  lon: number,
  lat: number,
  bearing: number,
  lengthM: number,
  widthM: number,
): [number, number][] {
  const hl = lengthM / 2;
  const hw = widthM / 2;
  const nose = Math.min(widthM * 0.55, lengthM * 0.12);
  // local metres: x = right, y = forward
  const pts: [number, number][] = [
    [-hw, -hl],
    [hw, -hl],
    [hw, hl - nose],
    [hw * 0.55, hl],
    [-hw * 0.55, hl],
    [-hw, hl - nose],
    [-hw, -hl],
  ];
  const th = bearing * RAD;
  const cos = Math.cos(th);
  const sin = Math.sin(th);
  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.cos(lat * RAD);
  return pts.map(([x, y]) => {
    const east = x * cos + y * sin;
    const north = -x * sin + y * cos;
    return [lon + east / mPerDegLon, lat + north / mPerDegLat];
  });
}

/** Approximate circle polygon (for the location accuracy ring). */
export function circlePolygon(lon: number, lat: number, radiusM: number, steps = 48): [number, number][] {
  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.cos(lat * RAD);
  const ring: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    ring.push([lon + (Math.cos(a) * radiusM) / mPerDegLon, lat + (Math.sin(a) * radiusM) / mPerDegLat]);
  }
  return ring;
}
