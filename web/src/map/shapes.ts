// Route geometry for on-road animation: projects GPS fixes onto a route shape
// (distance along it) and samples position + heading at any distance.

import { api, type LngLat } from "../api";

const M_PER_DEG = 111320;

export class RouteShape {
  readonly points: LngLat[];
  /** cumulative metres at each vertex */
  private cum: Float64Array;
  private x: Float64Array;
  private y: Float64Array;
  private kx: number;
  readonly length: number;

  constructor(points: LngLat[]) {
    this.points = points;
    const lat0 = points.reduce((a, p) => a + p[1], 0) / Math.max(points.length, 1);
    this.kx = M_PER_DEG * Math.cos((lat0 * Math.PI) / 180);
    const n = points.length;
    this.x = new Float64Array(n);
    this.y = new Float64Array(n);
    this.cum = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      this.x[i] = points[i][0] * this.kx;
      this.y[i] = points[i][1] * M_PER_DEG;
      if (i > 0) this.cum[i] = this.cum[i - 1] + Math.hypot(this.x[i] - this.x[i - 1], this.y[i] - this.y[i - 1]);
    }
    this.length = n ? this.cum[n - 1] : 0;
  }

  /**
   * Closest point on the shape to (lon, lat). With `near`, the search prefers the
   * stretch around that distance so loops / out-and-back routes don't jump sides.
   */
  project(lon: number, lat: number, near?: number): { s: number; dist: number } | null {
    const n = this.points.length;
    if (n < 2) return null;
    const px = lon * this.kx;
    const py = lat * M_PER_DEG;
    let best = { s: 0, dist: Infinity };
    let bestNear = { s: 0, dist: Infinity };
    for (let i = 1; i < n; i++) {
      const ax = this.x[i - 1], ay = this.y[i - 1];
      const dx = this.x[i] - ax, dy = this.y[i] - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
      const d = Math.hypot(ax + dx * t - px, ay + dy * t - py);
      const s = this.cum[i - 1] + t * Math.sqrt(len2);
      if (d < best.dist) best = { s, dist: d };
      // within 1.5 km ahead / 300 m behind the previous position
      if (near != null && s > near - 300 && s < near + 1500 && d < bestNear.dist) bestNear = { s, dist: d };
    }
    return bestNear.dist < best.dist + 25 ? bestNear : best;
  }

  /** The road geometry between two distances along the shape. */
  slice(s0: number, s1: number): LngLat[] {
    if (s1 < s0) [s0, s1] = [s1, s0];
    const out: LngLat[] = [];
    const a = this.at(s0);
    out.push([a.lon, a.lat]);
    for (let i = 0; i < this.points.length; i++) {
      if (this.cum[i] > s0 && this.cum[i] < s1) out.push(this.points[i]);
    }
    const b = this.at(s1);
    out.push([b.lon, b.lat]);
    return out;
  }

  /** Position and heading (degrees, clockwise from north) at distance `s`. */
  at(s: number): { lon: number; lat: number; bearing: number } {
    const n = this.points.length;
    s = Math.max(0, Math.min(this.length, s));
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] <= s) lo = mid;
      else hi = mid;
    }
    const seg = this.cum[hi] - this.cum[lo] || 1;
    const t = (s - this.cum[lo]) / seg;
    const x = this.x[lo] + (this.x[hi] - this.x[lo]) * t;
    const y = this.y[lo] + (this.y[hi] - this.y[lo]) * t;
    return { lon: x / this.kx, lat: y / M_PER_DEG, bearing: this.heading(s) };
  }

  /** Heading from a short chord around `s`, so corners turn smoothly instead of snapping. */
  heading(s: number, span = 9): number {
    const a = this.xy(Math.max(0, s - span));
    const b = this.xy(Math.min(this.length, s + span));
    const dx = b[0] - a[0], dy = b[1] - a[1];
    if (dx === 0 && dy === 0) return 0;
    return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
  }

  private xy(s: number): [number, number] {
    const n = this.points.length;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] <= s) lo = mid;
      else hi = mid;
    }
    const seg = this.cum[hi] - this.cum[lo] || 1;
    const t = (s - this.cum[lo]) / seg;
    return [this.x[lo] + (this.x[hi] - this.x[lo]) * t, this.y[lo] + (this.y[hi] - this.y[lo]) * t];
  }
}

/** Fetches each shape once and keeps it for the session. */
export class ShapeCache {
  private shapes = new Map<string, RouteShape>();
  private pending = new Map<string, Promise<RouteShape | null>>();

  get(id: string): RouteShape | undefined {
    return this.shapes.get(id);
  }

  load(id: string): Promise<RouteShape | null> {
    const have = this.shapes.get(id);
    if (have) return Promise.resolve(have);
    let p = this.pending.get(id);
    if (!p) {
      p = api
        .shape(id)
        .then((r) => {
          const shape = new RouteShape(r.points);
          this.shapes.set(id, shape);
          return shape;
        })
        .catch(() => null)
        .finally(() => this.pending.delete(id));
      this.pending.set(id, p);
    }
    return p;
  }
}
