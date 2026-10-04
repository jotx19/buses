// Map features for a planned trip: bus legs follow the real road (sliced from the
// route shape between boarding and alighting stops), walking legs are dashed.

import type { PlanLeg, TripOption } from "../api";
import type { ShapeCache } from "./shapes";

export async function planFeatures(option: TripOption, shapes: ShapeCache) {
  const lines: GeoJSON.Feature[] = [];
  const points: GeoJSON.Feature[] = [];
  const all: [number, number][] = [];

  for (const leg of option.legs) {
    if (leg.type === "walk") {
      if (leg.meters < 5) continue;
      const coords: [number, number][] = [
        [leg.from.lon, leg.from.lat],
        [leg.to.lon, leg.to.lat],
      ];
      all.push(...coords);
      lines.push({ type: "Feature", properties: { kind: "walk" }, geometry: { type: "LineString", coordinates: coords } });
      continue;
    }
    lines.push({
      type: "Feature",
      properties: { kind: "bus", color: leg.route.color },
      geometry: { type: "LineString", coordinates: await busPath(leg, shapes) },
    });
    all.push([leg.board.lon, leg.board.lat], [leg.alight.lon, leg.alight.lat]);
    for (const [stop, role] of [
      [leg.board, "board"],
      [leg.alight, "alight"],
    ] as const) {
      points.push({
        type: "Feature",
        properties: { role, name: stop.name, color: leg.route.color },
        geometry: { type: "Point", coordinates: [stop.lon, stop.lat] },
      });
    }
  }

  const first = option.legs[0];
  const last = option.legs[option.legs.length - 1];
  if (first?.type === "walk") {
    points.push({ type: "Feature", properties: { role: "start", name: first.from.name }, geometry: { type: "Point", coordinates: [first.from.lon, first.from.lat] } });
    all.push([first.from.lon, first.from.lat]);
  }
  if (last?.type === "walk") {
    points.push({ type: "Feature", properties: { role: "end", name: last.to.name }, geometry: { type: "Point", coordinates: [last.to.lon, last.to.lat] } });
    all.push([last.to.lon, last.to.lat]);
  }

  return {
    lines: { type: "FeatureCollection", features: lines } as GeoJSON.FeatureCollection,
    points: { type: "FeatureCollection", features: points } as GeoJSON.FeatureCollection,
    bounds: all,
  };
}

async function busPath(leg: Extract<PlanLeg, { type: "bus" }>, shapes: ShapeCache): Promise<[number, number][]> {
  const straight: [number, number][] = [
    [leg.board.lon, leg.board.lat],
    [leg.alight.lon, leg.alight.lat],
  ];
  const shape = leg.shape_id ? await shapes.load(leg.shape_id) : null;
  if (!shape) return straight;
  const a = shape.project(leg.board.lon, leg.board.lat);
  const b = a && shape.project(leg.alight.lon, leg.alight.lat, a.s);
  if (!a || !b || a.dist > 120 || b.dist > 120 || b.s <= a.s) return straight;
  return shape.slice(a.s, b.s);
}
