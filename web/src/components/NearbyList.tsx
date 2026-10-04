import { useMemo } from "react";
import type { RouteInfo, Vehicle } from "../api";
import { distanceM } from "../map/fleet";
import { distanceLabel, minutesLabel } from "../format";
import { RouteBadge, cx, faint, muted } from "./ui";

const NEARBY_RADIUS_M = 2500;
const MAX_ROWS = 40;

interface Props {
  vehicles: Vehicle[];
  origin: { lat: number; lon: number } | null;
  originLabel: string;
  filterRoute: RouteInfo | null;
  loading: boolean;
  onSelect: (id: string) => void;
}

/** Active buses closest to the user (or the map centre), nearest first. */
export function NearbyList({ vehicles, origin, originLabel, filterRoute, loading, onSelect }: Props) {
  const rows = useMemo(() => {
    if (!origin) return [];
    return vehicles
      .filter((v) => v.in_service && (!filterRoute || v.route?.id === filterRoute.id))
      .map((v) => ({ v, d: distanceM(origin.lat, origin.lon, v.lat, v.lon) }))
      .filter((r) => filterRoute || r.d <= NEARBY_RADIUS_M)
      .sort((a, b) => a.d - b.d)
      .slice(0, MAX_ROWS);
  }, [vehicles, origin, filterRoute]);

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-baseline justify-between px-5 pb-2 pt-1">
        <h2 className="text-[15px] font-semibold tracking-tight">
          {filterRoute ? `Route ${filterRoute.short_name}` : "Nearby buses"}
        </h2>
        <span className={cx("text-xs", muted)}>{filterRoute ? `${rows.length} live` : originLabel}</span>
      </div>

      <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-3 [scrollbar-width:thin]">
        {loading && !rows.length && <li className={cx("px-3 py-6 text-center text-sm", muted)}>Loading live buses…</li>}
        {!loading && !rows.length && (
          <li className={cx("px-3 py-6 text-center text-sm", muted)}>
            {filterRoute ? "No buses on this route right now." : "No active buses within 2.5 km."}
          </li>
        )}
        {rows.map(({ v, d }) => (
          <li key={v.id}>
            <button
              type="button"
              onClick={() => onSelect(v.id)}
              className="group flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition hover:bg-black/[0.05] active:scale-[0.99] dark:hover:bg-white/[0.07]"
            >
              <RouteBadge route={v.route} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14.5px] font-medium">{v.headsign ?? v.route?.long_name ?? "In service"}</span>
                <span className={cx("block truncate text-xs", muted)}>
                  {v.next_stop ? `${v.next_stop.name} · ${minutesLabel(v.next_stop.minutes)}` : "No stop prediction"}
                </span>
              </span>
              <span className="flex-none text-right tabular-nums">
                <span className="block text-[14px] font-semibold">{distanceLabel(d)}</span>
                <span className={cx("block text-[11px]", faint)}>
                  {v.speed_kmh != null && v.speed_kmh > 1 ? `${Math.round(v.speed_kmh)} km/h` : "stopped"}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
