// Procedural 3D trees. The vector tiles have no individual trees, so they are
// scattered from what the tiles do have: dense in woods, sparse in parks and
// lawns, and as street trees along residential / local roads. Placement uses a
// fixed world grid with hashed jitter, so trees stay put while panning, and any
// point that falls inside a building footprint is dropped.

import type { Map as MapLibreMap } from "maplibre-gl";

export const TREES_MIN_ZOOM = 15;
const MAX_TREES = 3500;
const M_PER_DEG = 111320;

type Ring = number[][];
type Poly = Ring[];

interface Area {
  spacing: number;
  keep: number;
}

const AREAS: Record<string, Area> = {
  wood: { spacing: 11, keep: 0.85 },
  forest: { spacing: 11, keep: 0.85 },
  park: { spacing: 20, keep: 0.4 },
  grass: { spacing: 24, keep: 0.25 },
  cemetery: { spacing: 22, keep: 0.35 },
};

// street trees: spacing along the road and offset from its centreline (metres)
const STREETS: Record<string, { spacing: number; offset: number; keep: number }> = {
  minor: { spacing: 13, offset: 8.5, keep: 0.6 },
  tertiary: { spacing: 15, offset: 11, keep: 0.5 },
  secondary: { spacing: 16, offset: 13, keep: 0.45 },
};

/** Deterministic hash of two ints → [0, 1). */
function hash(x: number, y: number, salt = 0) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(salt + 1, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function inRing(x: number, y: number, ring: Ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inPoly(x: number, y: number, poly: Poly) {
  if (!inRing(x, y, poly[0])) return false;
  for (let i = 1; i < poly.length; i++) if (inRing(x, y, poly[i])) return false;
  return true;
}

function polys(geom: GeoJSON.Geometry): Poly[] {
  if (geom.type === "Polygon") return [geom.coordinates];
  if (geom.type === "MultiPolygon") return geom.coordinates;
  return [];
}

function lines(geom: GeoJSON.Geometry): number[][][] {
  if (geom.type === "LineString") return [geom.coordinates];
  if (geom.type === "MultiLineString") return geom.coordinates;
  return [];
}

function bbox(ring: Ring) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of ring) {
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  }
  return { w, s, e, n };
}

/** Building footprints bucketed on a coarse grid for quick point-in-building tests. */
class BuildingIndex {
  private cells = new Map<string, { poly: Poly; b: ReturnType<typeof bbox> }[]>();
  constructor(private cell: number) {}
  private key(x: number, y: number) {
    return `${Math.floor(x / this.cell)}:${Math.floor(y / this.cell)}`;
  }
  add(poly: Poly) {
    const b = bbox(poly[0]);
    for (let x = Math.floor(b.w / this.cell); x <= Math.floor(b.e / this.cell); x++) {
      for (let y = Math.floor(b.s / this.cell); y <= Math.floor(b.n / this.cell); y++) {
        const k = `${x}:${y}`;
        let list = this.cells.get(k);
        if (!list) this.cells.set(k, (list = []));
        list.push({ poly, b });
      }
    }
  }
  /** true if (x, y) is inside or within `pad` degrees of a building */
  hits(x: number, y: number, pad: number) {
    const list = this.cells.get(this.key(x, y));
    if (!list) return false;
    for (const { poly, b } of list) {
      if (x < b.w - pad || x > b.e + pad || y < b.s - pad || y > b.n + pad) continue;
      if (inPoly(x, y, poly)) return true;
      // near the wall: test the 4 padded neighbours so canopies don't clip into houses
      if (inPoly(x + pad, y, poly) || inPoly(x - pad, y, poly) || inPoly(x, y + pad, poly) || inPoly(x, y - pad, poly)) {
        return true;
      }
    }
    return false;
  }
}

function octagon(lon: number, lat: number, rM: number, mLon: number): number[][] {
  const ring: number[][] = [];
  for (let i = 0; i <= 8; i++) {
    const a = (i % 8) * (Math.PI / 4) + Math.PI / 8;
    ring.push([lon + (Math.cos(a) * rM) / mLon, lat + (Math.sin(a) * rM) / M_PER_DEG]);
  }
  return ring;
}

export function buildTrees(map: MapLibreMap): GeoJSON.FeatureCollection {
  const empty: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
  if (map.getZoom() < TREES_MIN_ZOOM || !map.getSource("openmaptiles")) return empty;

  const view = map.getBounds();
  const lat0 = view.getCenter().lat;
  const mLon = M_PER_DEG * Math.cos((lat0 * Math.PI) / 180);
  const padLon = (view.getEast() - view.getWest()) * 0.15;
  const padLat = (view.getNorth() - view.getSouth()) * 0.15;
  // Pitched views can reach the horizon; trees beyond ~1 km are specks anyway.
  const c = view.getCenter();
  const reach = 1000;
  const vw = Math.max(view.getWest() - padLon, c.lng - reach / mLon);
  const ve = Math.min(view.getEast() + padLon, c.lng + reach / mLon);
  const vs = Math.max(view.getSouth() - padLat, c.lat - reach / M_PER_DEG);
  const vn = Math.min(view.getNorth() + padLat, c.lat + reach / M_PER_DEG);

  const buildings = new BuildingIndex(0.0008);
  for (const f of map.querySourceFeatures("openmaptiles", { sourceLayer: "building" })) {
    for (const p of polys(f.geometry)) {
      const [x, y] = p[0][0];
      if (x > vw - 0.002 && x < ve + 0.002 && y > vs - 0.002 && y < vn + 0.002) buildings.add(p);
    }
  }
  const wallPad = 2.5 / M_PER_DEG;

  const seen = new Set<string>();
  const points: { lon: number; lat: number; seed: number }[] = [];
  const place = (lon: number, lat: number) => {
    if (lon < vw || lon > ve || lat < vs || lat > vn) return;
    const key = `${Math.round(lon * 1e5)}:${Math.round(lat * 1e5)}`; // ~1 m dedupe across tile edges
    if (seen.has(key) || buildings.hits(lon, lat, wallPad)) return;
    seen.add(key);
    points.push({ lon, lat, seed: hash(Math.round(lon * 1e5), Math.round(lat * 1e5), 7) });
  };

  // Areas: world-aligned grid + jitter inside each polygon
  const areaFeatures = [
    ...map.querySourceFeatures("openmaptiles", { sourceLayer: "landcover" }),
    ...map.querySourceFeatures("openmaptiles", { sourceLayer: "park" }).map((f) => {
      f.properties = { ...f.properties, class: "park" };
      return f;
    }),
    ...map.querySourceFeatures("openmaptiles", { sourceLayer: "landuse" }).filter((f) => f.properties?.class === "cemetery"),
  ];
  for (const f of areaFeatures) {
    const area = AREAS[String(f.properties?.class)];
    if (!area) continue;
    const stepLat = area.spacing / M_PER_DEG;
    const stepLon = area.spacing / mLon;
    for (const poly of polys(f.geometry)) {
      const b = bbox(poly[0]);
      const w = Math.max(b.w, vw), e = Math.min(b.e, ve), s = Math.max(b.s, vs), n = Math.min(b.n, vn);
      if (w > e || s > n) continue;
      for (let gx = Math.floor(w / stepLon); gx <= Math.ceil(e / stepLon); gx++) {
        for (let gy = Math.floor(s / stepLat); gy <= Math.ceil(n / stepLat); gy++) {
          if (hash(gx, gy, area.spacing) > area.keep) continue;
          const lon = (gx + hash(gx, gy, 1)) * stepLon;
          const lat = (gy + hash(gx, gy, 2)) * stepLat;
          if (inPoly(lon, lat, poly)) place(lon, lat);
        }
        if (points.length > MAX_TREES) break;
      }
    }
  }

  // Street trees along both sides of local roads
  for (const f of map.querySourceFeatures("openmaptiles", { sourceLayer: "transportation" })) {
    const st = STREETS[String(f.properties?.class)];
    if (!st || f.properties?.brunnel === "tunnel" || f.properties?.brunnel === "bridge") continue;
    for (const line of lines(f.geometry)) {
      for (let i = 1; i < line.length; i++) {
        const [x1, y1] = line[i - 1];
        const [x2, y2] = line[i];
        const dx = (x2 - x1) * mLon;
        const dy = (y2 - y1) * M_PER_DEG;
        const len = Math.hypot(dx, dy);
        if (len < 4) continue;
        const nx = -dy / len, ny = dx / len; // unit normal in metres
        // anchor positions to a global along-road lattice via the segment start hash
        const start = hash(Math.round(x1 * 1e5), Math.round(y1 * 1e5), 3) * st.spacing;
        for (let d = start; d < len; d += st.spacing) {
          const t = d / len;
          const bx = x1 + (x2 - x1) * t;
          const by = y1 + (y2 - y1) * t;
          for (const side of [1, -1]) {
            const hx = Math.round(bx * 1e5) * side, hy = Math.round(by * 1e5);
            if (hash(hx, hy, 11) > st.keep) continue;
            const off = st.offset + (hash(hx, hy, 12) - 0.5) * 2;
            place(bx + (nx * off * side) / mLon, by + (ny * off * side) / M_PER_DEG);
          }
        }
      }
      if (points.length > MAX_TREES) break;
    }
  }

  // Nearest the camera first if we have to cap
  if (points.length > MAX_TREES) {
    points.sort((a, b) => Math.hypot(a.lon - c.lng, a.lat - c.lat) - Math.hypot(b.lon - c.lng, b.lat - c.lat));
    points.length = MAX_TREES;
  }

  // Each tree: trunk + wide lower canopy + narrower crown
  const features: GeoJSON.Feature[] = [];
  for (const p of points) {
    const size = 0.75 + p.seed * 0.6; // 0.75–1.35
    const shade = Math.floor(hash(p.seed * 1e6, 5) * 4);
    const trunkTop = 2.2 * size;
    const r1 = 2.6 * size, r2 = 1.7 * size;
    const mid = trunkTop + 3.4 * size;
    const top = mid + 2.2 * size;
    features.push(
      {
        type: "Feature",
        properties: { part: 0, shade, base: 0, height: trunkTop + 0.4 },
        geometry: { type: "Polygon", coordinates: [octagon(p.lon, p.lat, 0.35 * size, mLon)] },
      },
      {
        type: "Feature",
        properties: { part: 1, shade, base: trunkTop, height: mid },
        geometry: { type: "Polygon", coordinates: [octagon(p.lon, p.lat, r1, mLon)] },
      },
      {
        type: "Feature",
        properties: { part: 2, shade, base: mid, height: top },
        geometry: { type: "Polygon", coordinates: [octagon(p.lon, p.lat, r2, mLon)] },
      },
    );
  }
  return { type: "FeatureCollection", features };
}
