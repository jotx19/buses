// Decorative animated city: curving streets with buses gliding along them and
// stops pulsing. Pure SVG (animateMotion) — no libraries, GPU-cheap. Respects
// "reduce motion" by showing a still frame.

import { useEffect, useState } from "react";

// Streets across a 1600×900 canvas (scaled to cover the viewport).
const STREETS = [
  "M -120 640 C 200 610, 300 430, 560 440 S 900 570, 1120 480 S 1450 260, 1720 290",
  "M -120 240 C 250 250, 380 150, 640 185 S 980 330, 1200 300 S 1500 420, 1720 380",
  "M 300 -60 C 320 200, 420 330, 470 520 S 520 820, 600 970",
  "M 1050 -60 C 1000 160, 1110 300, 1060 480 S 980 760, 1100 970",
  "M -120 830 C 300 790, 700 870, 1000 770 S 1400 650, 1720 710",
  "M 760 -60 C 740 120, 820 260, 800 420 S 760 700, 820 970",
];

// [street, route colour, seconds per trip, start offset 0..1, reverse]
const BUSES: [number, string, number, number, boolean][] = [
  [0, "#D30F1D", 34, 0.05, false],
  [0, "#0057B8", 40, 0.55, true],
  [1, "#508128", 38, 0.2, false],
  [1, "#0057B8", 44, 0.7, true],
  [2, "#5B6770", 26, 0.1, false],
  [2, "#0057B8", 30, 0.6, true],
  [3, "#D30F1D", 28, 0.35, true],
  [3, "#5B6770", 33, 0.85, false],
  [4, "#0057B8", 46, 0.4, false],
  [4, "#5B6770", 52, 0.9, true],
  [5, "#0980A5", 30, 0.15, false],
  [5, "#0057B8", 36, 0.65, true],
];

// Stops (approximate points on the streets)
const STOPS: [number, number][] = [
  [560, 440], [1120, 480], [640, 185], [1200, 300], [470, 520], [1060, 480], [1000, 770], [800, 420], [300, 250],
];

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduced(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}

export function TransitScene() {
  const reduced = useReducedMotion();
  return (
    <svg
      className="pointer-events-none absolute inset-0 h-full w-full"
      viewBox="0 0 1600 900"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      <defs>
        <pattern id="blocks" width="80" height="80" patternUnits="userSpaceOnUse" patternTransform="rotate(-8)">
          <path d="M 80 0 L 0 0 0 80" className="fill-none stroke-black/[0.05] dark:stroke-white/[0.035]" strokeWidth="2" />
        </pattern>
        <radialGradient id="vignette" cx="50%" cy="45%" r="70%">
          <stop offset="55%" stopColor="var(--scene-bg)" stopOpacity="0" />
          <stop offset="100%" stopColor="var(--scene-bg)" stopOpacity="0.95" />
        </radialGradient>
        <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="6" />
        </filter>
        {STREETS.map((d, i) => (
          <path key={i} id={`street-${i}`} d={d} />
        ))}
      </defs>

      <rect width="1600" height="900" fill="url(#blocks)" />

      {/* streets: wide road, then a faint centre line */}
      {STREETS.map((d, i) => (
        <g key={i}>
          <path d={d} className="fill-none stroke-black/[0.07] dark:stroke-white/[0.06]" strokeWidth="26" strokeLinecap="round" />
          <path d={d} className="fill-none stroke-black/[0.12] dark:stroke-white/[0.12]" strokeWidth="1.5" strokeDasharray="10 14" />
        </g>
      ))}

      {/* stops */}
      {STOPS.map(([x, y], i) => (
        <g key={i} transform={`translate(${x} ${y})`}>
          {!reduced && (
            <circle r="6" className="fill-sky-500/30">
              <animate attributeName="r" values="6;22" dur="2.6s" begin={`${i * 0.37}s`} repeatCount="indefinite" />
              <animate attributeName="opacity" values="0.7;0" dur="2.6s" begin={`${i * 0.37}s`} repeatCount="indefinite" />
            </circle>
          )}
          <circle r="5.5" className="fill-white stroke-zinc-900/70 dark:fill-[#e5e5ea] dark:stroke-black/60" strokeWidth="2" />
        </g>
      ))}

      {/* buses: body in route colour, window band, headlight glow; x-axis = direction of travel */}
      {BUSES.map(([street, color, dur, offset, reverse], i) => {
        const begin = `${-offset * dur}s`;
        return (
          <g key={i} opacity={reduced ? 0 : 1}>
            <g>
              <ellipse cx="0" cy="0" rx="30" ry="14" fill={color} opacity="0.35" filter="url(#glow)" />
              <rect x="-22" y="-9" width="44" height="18" rx="5" fill={color} />
              <rect x="-15" y="-5.5" width="27" height="11" rx="2.5" fill="#0b0b0d" opacity="0.55" />
              <rect x="14" y="-8" width="7" height="16" rx="3" fill="#ffffff" opacity="0.9" />
              <circle cx="23" cy="-5" r="2" fill="#fff6c8" />
              <circle cx="23" cy="5" r="2" fill="#fff6c8" />
              {!reduced && (
                <animateMotion
                  dur={`${dur}s`}
                  begin={begin}
                  repeatCount="indefinite"
                  rotate={reverse ? "auto-reverse" : "auto"}
                  keyPoints={reverse ? "1;0" : "0;1"}
                  keyTimes="0;1"
                  calcMode="linear"
                >
                  <mpath href={`#street-${street}`} />
                </animateMotion>
              )}
            </g>
          </g>
        );
      })}

      <rect width="1600" height="900" fill="url(#vignette)" />
    </svg>
  );
}
