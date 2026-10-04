// Everything layered on top of the OpenFreeMap basemap: terrain, hillshade, sky,
// 3D buildings, and the transit layers. Re-run after every style change because
// MapLibre drops custom sources/layers when the style is swapped.

import type { ExpressionSpecification, Map as MapLibreMap } from "maplibre-gl";
import { DARK_SKY, applyDarkPalette } from "./darkmap";
import { TREES_MIN_ZOOM } from "./trees";

/** "dark" is the neutral grey night map (dark glass UI); "light" is full daylight. */
export type Theme = "dark" | "light";

// Both looks start from Liberty (it has parks, woods and land use); dark is a recolour.
export const BASEMAP: Record<Theme, string> = {
  dark: "https://tiles.openfreemap.org/styles/liberty",
  light: "https://tiles.openfreemap.org/styles/liberty",
};

const TERRAIN_TILES = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
const TERRAIN_ATTRIBUTION =
  '<a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank">Terrain: Mapzen / AWS</a>';
export const TRANSIT_ATTRIBUTION =
  '<a href="https://www.octranspo.com/en/plan-your-trip/travel-tools/developers" target="_blank">Live data: OC Transpo</a>';

export const TERRAIN_EXAGGERATION = 1.4;

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

export const SOURCES = {
  route: "oc-route",
  routeStops: "oc-route-stops",
  stops: "oc-stops",
  user: "oc-user",
  busShapes: "oc-bus-shapes",
  busPoints: "oc-bus-points",
  trees: "oc-trees",
  plan: "oc-plan",
  planPoints: "oc-plan-points",
} as const;

export const CLICKABLE_BUS_LAYERS = ["oc-bus-body", "oc-bus-glass", "oc-bus-roof", "oc-bus-arrow", "oc-bus-label"];
export const CLICKABLE_STOP_LAYERS = ["oc-stops-dot", "oc-route-stops-dot"];

const PALETTE = {
  dark: {
    building: ["#2c2c2e", "#353538", "#404044"],
    buildingOpacity: 1,
    sky: DARK_SKY,
    light: { color: "#ffffff", intensity: 0.3, position: [1.4, 210, 40] as [number, number, number] },
    hillshade: { shadow: "#000000", highlight: "#2e2e31", accent: "#0e0e10", exaggeration: 0.35 },
    trunk: "#2a2522",
    leaves: ["#1f2d22", "#243326", "#28382a", "#1c281f"],
    casing: "#0a0a0c",
    stop: "#f2f2f7",
    stopStroke: "#1c1c1e",
    text: "#ebebf0",
    halo: "#1c1c1e",
    glass: "#1a1d22",
    user: "#0a84ff",
  },
  light: {
    building: ["#e3ddd3", "#d6cfc4", "#c5bdb1"],
    buildingOpacity: 0.95,
    sky: {
      "sky-color": "#7fb8f0",
      "horizon-color": "#e6f0fa",
      "fog-color": "#f2efe9",
      "sky-horizon-blend": 0.5,
      "horizon-fog-blend": 0.6,
      "fog-ground-blend": 0.85,
      "atmosphere-blend": 0.5,
    },
    light: { color: "#ffffff", intensity: 0.42, position: [1.4, 200, 35] as [number, number, number] },
    hillshade: { shadow: "#5e5446", highlight: "#ffffff", accent: "#8a7f70", exaggeration: 0.3 },
    trunk: "#7a5a43",
    leaves: ["#6f9a55", "#7caa5c", "#89b464", "#658f4d"],
    casing: "#ffffff",
    stop: "#ffffff",
    stopStroke: "#2c333c",
    text: "#1b2027",
    halo: "#ffffff",
    glass: "#25303d",
    user: "#0a6cff",
  },
} as const;

function firstSymbolLayer(map: MapLibreMap): string | undefined {
  return map.getStyle().layers.find((l) => l.type === "symbol")?.id;
}

function addGeoJSON(map: MapLibreMap, id: string, attribution?: string) {
  if (!map.getSource(id)) map.addSource(id, { type: "geojson", data: EMPTY, attribution });
}

export function installScene(map: MapLibreMap, theme: Theme, terrain: boolean) {
  const p = PALETTE[theme];
  // Drop the basemap's own extrusions so ours (theme-coloured) are the only ones.
  for (const l of map.getStyle().layers) {
    if (l.type === "fill-extrusion" && !l.id.startsWith("oc-")) map.removeLayer(l.id);
  }
  if (theme === "dark") applyDarkPalette(map);
  const beforeLabels = firstSymbolLayer(map);

  // Terrain + hillshade use separate DEM sources (recommended by MapLibre for quality).
  if (!map.getSource("oc-dem")) {
    map.addSource("oc-dem", {
      type: "raster-dem",
      tiles: [TERRAIN_TILES],
      tileSize: 256,
      maxzoom: 15,
      encoding: "terrarium",
      attribution: TERRAIN_ATTRIBUTION,
    });
    map.addSource("oc-dem-shade", {
      type: "raster-dem",
      tiles: [TERRAIN_TILES],
      tileSize: 256,
      maxzoom: 15,
      encoding: "terrarium",
    });
  }
  if (!map.getLayer("oc-hillshade")) {
    map.addLayer(
      {
        id: "oc-hillshade",
        type: "hillshade",
        source: "oc-dem-shade",
        paint: {
          "hillshade-shadow-color": p.hillshade.shadow,
          "hillshade-highlight-color": p.hillshade.highlight,
          "hillshade-accent-color": p.hillshade.accent,
          "hillshade-exaggeration": p.hillshade.exaggeration,
        },
      },
      beforeLabels,
    );
  }
  setTerrainEnabled(map, terrain);
  map.setSky(p.sky);
  // Directional light gives buildings and trees lit / shaded sides.
  map.setLight({ anchor: "map", ...p.light });

  // 3D buildings from the OpenMapTiles `building` layer.
  if (!map.getLayer("oc-buildings")) {
    map.addLayer(
      {
        id: "oc-buildings",
        type: "fill-extrusion",
        source: "openmaptiles",
        "source-layer": "building",
        minzoom: 13.5,
        filter: ["!=", ["get", "hide_3d"], true],
        paint: {
          "fill-extrusion-color": [
            "interpolate", ["linear"], ["coalesce", ["get", "render_height"], 0],
            0, p.building[0], 40, p.building[1], 140, p.building[2],
          ],
          "fill-extrusion-height": [
            "interpolate", ["linear"], ["zoom"],
            13.5, 0, 14.5, ["coalesce", ["get", "render_height"], 6],
          ],
          "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
          "fill-extrusion-opacity": p.buildingOpacity,
          "fill-extrusion-vertical-gradient": true,
        },
      },
      beforeLabels,
    );
  }

  for (const id of Object.values(SOURCES)) {
    addGeoJSON(map, id, id === SOURCES.busPoints ? TRANSIT_ATTRIBUTION : undefined);
  }

  // Procedural trees (see trees.ts): trunk, lower canopy, crown
  map.addLayer(
    {
      id: "oc-trees",
      type: "fill-extrusion",
      source: SOURCES.trees,
      minzoom: TREES_MIN_ZOOM,
      paint: {
        "fill-extrusion-color": [
          "case",
          ["==", ["get", "part"], 0],
          p.trunk,
          ["match", ["get", "shade"], 0, p.leaves[0], 1, p.leaves[1], 2, p.leaves[2], p.leaves[3]],
        ],
        "fill-extrusion-base": ["get", "base"],
        "fill-extrusion-height": ["get", "height"],
        "fill-extrusion-opacity": 1,
        "fill-extrusion-vertical-gradient": true,
      },
    },
    beforeLabels,
  );

  // Location accuracy ring
  map.addLayer({
    id: "oc-user-accuracy",
    type: "fill",
    source: SOURCES.user,
    paint: { "fill-color": p.user, "fill-opacity": 0.12, "fill-outline-color": p.user },
  }, beforeLabels);

  // Route context (selected bus / filtered route)
  map.addLayer({
    id: "oc-route-casing",
    type: "line",
    source: SOURCES.route,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": p.casing,
      "line-opacity": 0.75,
      "line-width": ["interpolate", ["exponential", 1.5], ["zoom"], 10, 5, 14, 9, 18, 22],
      "line-blur": 1.5,
    },
  }, beforeLabels);
  map.addLayer({
    id: "oc-route-line",
    type: "line",
    source: SOURCES.route,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": ["get", "color"],
      "line-width": ["interpolate", ["exponential", 1.5], ["zoom"], 10, 2.5, 14, 5, 18, 13],
      "line-opacity": 0.95,
    },
  }, beforeLabels);

  // Planned trip: dashed walking, solid route-coloured bus legs
  map.addLayer({
    id: "oc-plan-walk",
    type: "line",
    source: SOURCES.plan,
    filter: ["==", ["get", "kind"], "walk"],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": p.text,
      "line-width": ["interpolate", ["linear"], ["zoom"], 11, 2, 17, 4.5],
      "line-dasharray": [0.1, 2],
      "line-opacity": 0.9,
    },
  }, beforeLabels);
  map.addLayer({
    id: "oc-plan-bus-casing",
    type: "line",
    source: SOURCES.plan,
    filter: ["==", ["get", "kind"], "bus"],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": p.casing,
      "line-width": ["interpolate", ["exponential", 1.5], ["zoom"], 10, 7, 14, 12, 18, 26],
      "line-opacity": 0.8,
    },
  }, beforeLabels);
  map.addLayer({
    id: "oc-plan-bus",
    type: "line",
    source: SOURCES.plan,
    filter: ["==", ["get", "kind"], "bus"],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": ["get", "color"],
      "line-width": ["interpolate", ["exponential", 1.5], ["zoom"], 10, 4, 14, 7, 18, 16],
    },
  }, beforeLabels);

  // All stops in view (only when zoomed in)
  map.addLayer({
    id: "oc-stops-dot",
    type: "circle",
    source: SOURCES.stops,
    minzoom: 15,
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 15, 3, 18, 6],
      "circle-color": p.stop,
      "circle-stroke-color": p.stopStroke,
      "circle-stroke-width": 1.5,
      "circle-opacity": ["interpolate", ["linear"], ["zoom"], 15, 0, 15.4, 1],
      "circle-stroke-opacity": ["interpolate", ["linear"], ["zoom"], 15, 0, 15.4, 1],
      "circle-pitch-alignment": "map",
    },
  });
  map.addLayer({
    id: "oc-stops-label",
    type: "symbol",
    source: SOURCES.stops,
    minzoom: 17,
    layout: {
      "text-field": ["get", "name"],
      "text-font": ["Noto Sans Regular"],
      "text-size": 11,
      "text-offset": [0, 1.1],
      "text-anchor": "top",
      "text-optional": true,
    },
    paint: { "text-color": p.text, "text-halo-color": p.halo, "text-halo-width": 1.4 },
  });

  // Upcoming stops of the selected bus
  map.addLayer({
    id: "oc-route-stops-dot",
    type: "circle",
    source: SOURCES.routeStops,
    paint: {
      "circle-radius": [
        "interpolate", ["linear"], ["zoom"],
        11, ["case", ["get", "next"], 6, 3],
        16, ["case", ["get", "next"], 8, 5.5],
      ],
      "circle-color": "#ffffff",
      "circle-stroke-color": ["get", "color"],
      "circle-stroke-width": ["case", ["get", "next"], 4, 2.5],
      "circle-pitch-alignment": "map",
    },
  });
  map.addLayer({
    id: "oc-route-stops-label",
    type: "symbol",
    source: SOURCES.routeStops,
    minzoom: 13,
    layout: {
      "text-field": ["concat", ["get", "name"], "  ·  ", ["get", "eta"]],
      "text-font": ["Noto Sans Bold"],
      "text-size": ["case", ["get", "next"], 13, 11],
      "text-offset": [0.9, 0],
      "text-anchor": "left",
      "text-optional": true,
      "symbol-sort-key": ["get", "order"],
    },
    paint: { "text-color": p.text, "text-halo-color": p.halo, "text-halo-width": 1.6 },
  });

  // Trip endpoints and boarding / alighting stops
  map.addLayer({
    id: "oc-plan-points",
    type: "circle",
    source: SOURCES.planPoints,
    paint: {
      "circle-radius": ["match", ["get", "role"], "start", 8, "end", 9, 6],
      "circle-color": ["match", ["get", "role"], "start", "#30d158", "end", "#ff453a", "#ffffff"],
      "circle-stroke-color": ["match", ["get", "role"], "start", "#ffffff", "end", "#ffffff", ["get", "color"]],
      "circle-stroke-width": ["match", ["get", "role"], "start", 3, "end", 3, 3.5],
      "circle-pitch-alignment": "map",
    },
  });
  map.addLayer({
    id: "oc-plan-labels",
    type: "symbol",
    source: SOURCES.planPoints,
    layout: {
      "text-field": ["get", "name"],
      "text-font": ["Noto Sans Bold"],
      "text-size": 12,
      "text-offset": [0, 1.3],
      "text-anchor": "top",
      "text-optional": true,
      "symbol-sort-key": ["match", ["get", "role"], "start", 0, "end", 0, 1],
    },
    paint: { "text-color": p.text, "text-halo-color": p.halo, "text-halo-width": 1.6 },
  });

  // Selection halo under the selected bus
  map.addLayer({
    id: "oc-bus-halo",
    type: "circle",
    source: SOURCES.busPoints,
    filter: ["==", ["get", "selected"], true],
    paint: {
      "circle-radius": ["interpolate", ["exponential", 2], ["zoom"], 10, 14, 15, 26, 18, 60],
      "circle-color": ["get", "color"],
      "circle-opacity": 0.22,
      "circle-blur": 0.6,
      "circle-stroke-color": ["get", "color"],
      "circle-stroke-width": 2,
      "circle-stroke-opacity": 0.8,
      "circle-pitch-alignment": "map",
    },
  });

  // 3D vehicles: body, window band and roof stacked as three extrusions
  const scaled = (m: number): ExpressionSpecification => ["*", ["get", "scale"], m];
  const fadeIn: ExpressionSpecification = ["interpolate", ["linear"], ["zoom"], 14.2, 0, 14.9, 1];
  map.addLayer({
    id: "oc-bus-body",
    type: "fill-extrusion",
    source: SOURCES.busShapes,
    minzoom: 14.2,
    paint: {
      "fill-extrusion-color": ["get", "color"],
      "fill-extrusion-base": scaled(0.35),
      "fill-extrusion-height": scaled(1.75),
      "fill-extrusion-opacity": fadeIn as unknown as number,
    },
  });
  map.addLayer({
    id: "oc-bus-glass",
    type: "fill-extrusion",
    source: SOURCES.busShapes,
    minzoom: 14.2,
    paint: {
      "fill-extrusion-color": p.glass,
      "fill-extrusion-base": scaled(1.75),
      "fill-extrusion-height": scaled(2.75),
      "fill-extrusion-opacity": fadeIn as unknown as number,
    },
  });
  map.addLayer({
    id: "oc-bus-roof",
    type: "fill-extrusion",
    source: SOURCES.busShapes,
    minzoom: 14.2,
    paint: {
      "fill-extrusion-color": ["get", "roof"],
      "fill-extrusion-base": scaled(2.75),
      "fill-extrusion-height": scaled(3.15),
      "fill-extrusion-opacity": fadeIn as unknown as number,
    },
  });

  // Zoomed-out heading arrows (fade out as the 3D bodies fade in)
  map.addLayer({
    id: "oc-bus-arrow",
    type: "symbol",
    source: SOURCES.busPoints,
    maxzoom: 15.2,
    layout: {
      "icon-image": ["concat", ["case", ["get", "hasBearing"], "arrow-", "dot-"], ["get", "colorKey"]],
      "icon-rotate": ["get", "bearing"],
      "icon-rotation-alignment": "map",
      "icon-pitch-alignment": "map",
      "icon-size": ["interpolate", ["linear"], ["zoom"], 9, 0.55, 12, 0.8, 15, 1],
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
      "symbol-sort-key": ["get", "sort"],
    },
    paint: {
      "icon-opacity": ["interpolate", ["linear"], ["zoom"], 14.4, 1, 15.1, 0],
    },
  });

  // Route number badges, billboarded above each vehicle
  map.addLayer({
    id: "oc-bus-label",
    type: "symbol",
    source: SOURCES.busPoints,
    minzoom: 10.5,
    layout: {
      "text-field": ["step", ["zoom"], ["get", "label"], 15.5, ["get", "labelLong"]],
      "text-font": ["Noto Sans Bold"],
      "text-size": ["interpolate", ["linear"], ["zoom"], 11, 11, 16, 13],
      "text-anchor": "bottom",
      "text-offset": ["interpolate", ["linear"], ["zoom"], 11, ["literal", [0, -1.1]], 15, ["literal", [0, -1.6]], 17, ["literal", [0, -2.6]]],
      "text-pitch-alignment": "viewport",
      "text-rotation-alignment": "viewport",
      "text-allow-overlap": ["step", ["zoom"], false, 14, true],
      "icon-image": ["concat", "badge-", ["get", "colorKey"]],
      "icon-text-fit": "both",
      "icon-text-fit-padding": [2, 5, 2, 5],
      "icon-anchor": "bottom",
      "icon-offset": [0, 0],
      "icon-allow-overlap": ["step", ["zoom"], false, 14, true],
      "symbol-sort-key": ["get", "sort"],
      "symbol-z-order": "source",
    },
    paint: {
      "text-color": ["get", "textColor"],
    },
  });
}

export function setTerrainEnabled(map: MapLibreMap, on: boolean) {
  map.setTerrain(on ? { source: "oc-dem", exaggeration: TERRAIN_EXAGGERATION } : null);
}

export function setSourceData(map: MapLibreMap, id: string, data: GeoJSON.FeatureCollection) {
  const src = map.getSource(id) as { setData?: (d: GeoJSON.FeatureCollection) => void } | undefined;
  src?.setData?.(data);
}

export const EMPTY_FC = EMPTY;
