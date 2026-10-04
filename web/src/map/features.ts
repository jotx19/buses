// Turns fleet samples into the GeoJSON drawn by the bus layers in scene.ts.

import type { LngLatBounds } from "maplibre-gl";
import type { UpcomingStop, Vehicle } from "../api";
import type { Sample } from "./fleet";
import { vehicleFootprint } from "./fleet";
import { colorKey } from "./icons";

export const OUT_OF_SERVICE_COLOR = "#6B7480";

const BUS_LENGTH_M = 12.5;
const TRAIN_LENGTH_M = 48;
const WIDTH_M = 2.6;

/**
 * True-to-scale vehicles vanish below ~zoom 16, so they are exaggerated when
 * zoomed out and shrink to real size up close.
 */
export function vehicleScale(zoom: number) {
  if (zoom >= 17.5) return 1;
  return 1 + (17.5 - zoom) * 0.7;
}

export function vehicleColor(v: Vehicle) {
  return v.route?.color ?? OUT_OF_SERVICE_COLOR;
}

const roofCache = new Map<string, string>();
/** A lighter tint of the route colour for the roof. */
function roofColor(hex: string) {
  let c = roofCache.get(hex);
  if (!c) {
    const n = parseInt(hex.slice(1), 16);
    const mix = (v: number) => Math.round(v + (255 - v) * 0.35);
    c = `rgb(${mix((n >> 16) & 255)},${mix((n >> 8) & 255)},${mix(n & 255)})`;
    roofCache.set(hex, c);
  }
  return c;
}

export function headsignLabel(v: Vehicle) {
  const short = v.route?.short_name ?? "";
  return v.headsign ? `${short}  ${v.headsign}` : short;
}

export function buildBusFeatures(
  samples: Sample[],
  opts: { zoom: number; selectedId: string | null; bounds: LngLatBounds | null },
): { shapes: GeoJSON.FeatureCollection; points: GeoJSON.FeatureCollection } {
  const scale = vehicleScale(opts.zoom);
  const withBodies = opts.zoom >= 14;
  const shapes: GeoJSON.Feature[] = [];
  const points: GeoJSON.Feature[] = [];

  for (const s of samples) {
    const v = s.vehicle;
    const color = vehicleColor(v);
    const selected = v.id === opts.selectedId;
    const isTrain = v.route?.route_type === 0;
    const props = {
      id: v.id,
      color,
      colorKey: colorKey(color),
      textColor: v.route?.text_color ?? "#FFFFFF",
      label: v.route?.short_name ?? "",
      labelLong: headsignLabel(v),
      bearing: s.bearing,
      hasBearing: s.bearingKnown,
      selected,
      // higher draws on top: selected > in service > out of service
      sort: selected ? 3 : v.in_service ? 2 : 1,
      roof: roofColor(color),
      scale,
    };
    points.push({ type: "Feature", properties: props, geometry: { type: "Point", coordinates: [s.lon, s.lat] } });

    if (withBodies && (!opts.bounds || opts.bounds.contains([s.lon, s.lat]))) {
      const ring = vehicleFootprint(
        s.lon,
        s.lat,
        s.bearing,
        (isTrain ? TRAIN_LENGTH_M : BUS_LENGTH_M) * scale,
        WIDTH_M * scale,
      );
      shapes.push({ type: "Feature", properties: props, geometry: { type: "Polygon", coordinates: [ring] } });
    }
  }
  return {
    shapes: { type: "FeatureCollection", features: shapes },
    points: { type: "FeatureCollection", features: points },
  };
}

export function routeLines(lines: [number, number][][], color: string): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: lines
      .filter((l) => l.length > 1)
      .map((coordinates) => ({
        type: "Feature",
        properties: { color },
        geometry: { type: "LineString", coordinates },
      })),
  };
}

export function upcomingStopFeatures(stops: UpcomingStop[], color: string): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: stops.map((s, i) => ({
      type: "Feature",
      properties: {
        id: s.id,
        name: s.name,
        eta: s.minutes <= 0 ? "now" : `${s.minutes} min`,
        next: i === 0,
        order: i,
        color,
      },
      geometry: { type: "Point", coordinates: [s.lon, s.lat] },
    })),
  };
}
