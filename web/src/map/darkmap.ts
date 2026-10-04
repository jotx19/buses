// Dark map look: recolours the OpenFreeMap Liberty basemap into neutral greys
// (Apple-Maps-at-night style) — charcoal ground, grey roads and buildings, subtle
// grey-green parks and deep blue-grey water. Applied after the style loads.

import type { Map as MapLibreMap } from "maplibre-gl";

type Paint = Record<string, string | number>;

const LABEL = { "text-color": "#a1a1a6", "text-halo-color": "rgba(10,10,12,0.9)", "text-halo-width": 1.3 };

// First matching rule wins. Ids come from the Liberty style.
const RULES: [RegExp, Paint][] = [
  [/^background$/, { "background-color": "#1c1c1e" }],
  [/^natural_earth$/, { "raster-opacity": 0.12, "raster-brightness-max": 0.3, "raster-saturation": -1 }],
  [/^park$/, { "fill-color": "#1f2622", "fill-outline-color": "#232b26", "fill-opacity": 0.95 }],
  [/^park_outline$/, { "line-color": "#262e29", "line-opacity": 0.5 }],
  [/^landuse_residential$/, { "fill-color": "#202022", "fill-opacity": 0.6 }],
  [/^landcover_wood$/, { "fill-color": "#1c241f", "fill-opacity": 0.95 }],
  [/^landcover_grass$/, { "fill-color": "#212923", "fill-opacity": 0.9 }],
  [/^landcover_(ice|sand)$/, { "fill-color": "#252527" }],
  [/^landcover_wetland$/, { "fill-opacity": 0.1 }],
  [/^landuse_(pitch|track)$/, { "fill-color": "#212923" }],
  [/^landuse_cemetery$/, { "fill-color": "#1f2621" }],
  [/^landuse_(hospital|school)$/, { "fill-color": "#222224" }],
  [/^water$/, { "fill-color": "#0f1820" }],
  [/^waterway/, { "line-color": "#121c26" }],
  [/^aeroway_fill$/, { "fill-color": "#222224" }],
  [/^aeroway_(runway|taxiway)$/, { "line-color": "#3a3a3c" }],
  [/^road_area_pattern$/, { "fill-opacity": 0.06 }],
  [/_casing$/, { "line-color": "#121214" }],
  [/(path_pedestrian)$/, { "line-color": "#2e2e30" }],
  [/(rail|rail_hatching)$/, { "line-color": "#363638" }],
  [/(motorway|trunk_primary|motorway_link)$/, { "line-color": "#545458" }],
  [/(secondary_tertiary|_link)$/, { "line-color": "#48484c" }],
  [/(minor|street|service_track)$/, { "line-color": "#3a3a3d" }],
  [/^building$/, { "fill-color": "#262628", "fill-outline-color": "#1e1e20" }],
  [/^boundary/, { "line-color": "#48484a" }],
];

export const DARK_SKY = {
  "sky-color": "#0b0b0d",
  "horizon-color": "#2a2a2e",
  "fog-color": "#18181a",
  "sky-horizon-blend": 0.5,
  "horizon-fog-blend": 0.6,
  "fog-ground-blend": 0.55,
  "atmosphere-blend": 0.7,
};

export function applyDarkPalette(map: MapLibreMap) {
  for (const layer of map.getStyle().layers) {
    if (layer.id.startsWith("oc-")) continue;
    let paint: Paint | undefined;
    if (layer.type === "symbol") paint = LABEL;
    else paint = RULES.find(([re]) => re.test(layer.id))?.[1];
    if (!paint) continue;
    for (const [prop, value] of Object.entries(paint)) {
      // Skip props that don't apply to this layer type (e.g. text on icon-only symbols).
      if (!prop.startsWith(layer.type === "fill-extrusion" ? "fill-extrusion" : layer.type) && layer.type !== "symbol") {
        continue;
      }
      try {
        map.setPaintProperty(layer.id, prop as Parameters<MapLibreMap["setPaintProperty"]>[1], value);
      } catch {
        /* property not valid for this layer */
      }
    }
  }
}
