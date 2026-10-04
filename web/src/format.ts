export function minutesLabel(m: number) {
  if (m <= 0) return "now";
  if (m === 1) return "1 min";
  return `${m} min`;
}

export function distanceLabel(m: number) {
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
export function compass(bearing: number) {
  return COMPASS[Math.round((((bearing % 360) + 360) % 360) / 45) % 8];
}

export function agoLabel(unixSeconds: number, nowMs = Date.now()) {
  const s = Math.max(0, Math.round(nowMs / 1000 - unixSeconds));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.floor(m / 60)} h ago`;
}

/** Numeric-aware route sort: 1, 2, 6, 10, 75, 98, 111, 299 … */
export function compareRoutes(a: string, b: string) {
  return a.localeCompare(b, undefined, { numeric: true });
}
