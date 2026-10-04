// Icons drawn on a canvas on demand, one per route colour:
//   badge-RRGGBB  stretchable rounded label behind the route number
//   arrow-RRGGBB  heading arrow used when zoomed out
//   dot-RRGGBB    same, for vehicles that have not reported a heading yet

import type { Map as MapLibreMap } from "maplibre-gl";

const PR = 2; // draw at 2x for crisp icons on retina screens

function canvas(size: number) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  return c.getContext("2d")!;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function badge(color: string) {
  const s = 48;
  const ctx = canvas(s);
  ctx.shadowColor = "rgba(0,0,0,0.45)";
  ctx.shadowBlur = 6;
  ctx.shadowOffsetY = 2;
  roundRect(ctx, 5, 4, s - 10, s - 12, 11);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = "rgba(255,255,255,0.92)";
  ctx.stroke();
  return {
    data: ctx.getImageData(0, 0, s, s),
    options: {
      pixelRatio: PR,
      stretchX: [[17, 31]] as [number, number][],
      stretchY: [[16, 26]] as [number, number][],
      content: [13, 10, 35, 34] as [number, number, number, number],
    },
  };
}

function marker(color: string, withArrow: boolean) {
  const s = 64;
  const c = s / 2;
  const ctx = canvas(s);
  ctx.shadowColor = "rgba(0,0,0,0.5)";
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 2;
  ctx.beginPath();
  ctx.arc(c, c, 17, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.lineWidth = 4;
  ctx.strokeStyle = "#ffffff";
  ctx.stroke();
  if (withArrow) {
    // heading wedge beyond the circle + chevron inside (points north; MapLibre rotates it)
    ctx.beginPath();
    ctx.moveTo(c, 2);
    ctx.lineTo(c + 9, 14);
    ctx.lineTo(c - 9, 14);
    ctx.closePath();
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(c - 7, c + 5);
    ctx.lineTo(c, c - 6);
    ctx.lineTo(c + 7, c + 5);
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.arc(c, c, 5, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
  }
  return { data: ctx.getImageData(0, 0, s, s), options: { pixelRatio: PR } };
}

/** `#D30F1D` → `D30F1D`, the suffix used in icon ids. */
export function colorKey(hex: string) {
  return hex.replace("#", "").toUpperCase();
}

export function installIconResolver(map: MapLibreMap) {
  map.setMissingStyleImageResolver((id) => {
    const m = /^(badge|arrow|dot)-([0-9A-F]{6})$/.exec(id);
    if (!m || map.hasImage(id)) return;
    const color = `#${m[2]}`;
    const img = m[1] === "badge" ? badge(color) : marker(color, m[1] === "arrow");
    map.addImage(id, img.data, img.options);
  });
}
