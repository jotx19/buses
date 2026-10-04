import type { StopDetail as StopData } from "../api";
import { minutesLabel } from "../format";
import { IconBack, IconStop } from "./Icons";
import { RouteBadge, cx, fill, muted } from "./ui";

interface Props {
  stopId: string;
  detail: StopData | null;
  error: string | null;
  liveIds: Set<string>;
  onBack: () => void;
  onVehicle: (id: string) => void;
}

export function StopDetail({ stopId, detail, error, liveIds, onBack, onVehicle }: Props) {
  const stop = detail?.stop.id === stopId ? detail.stop : null;
  const arrivals = stop ? detail!.arrivals : [];
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Stop arrivals">
      <div className="px-3">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex h-8 items-center gap-0.5 rounded-full pl-1 pr-3 text-[13px] font-medium text-sky-600 transition hover:bg-black/[0.05] dark:text-sky-400 dark:hover:bg-white/[0.07]"
        >
          <IconBack /> Nearby
        </button>
      </div>

      <header className="flex items-center gap-3.5 px-5 pb-3 pt-2">
        <span className="grid size-12 flex-none place-items-center rounded-[14px] bg-sky-500 text-white">
          <IconStop />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xl font-bold leading-tight tracking-tight">{stop?.name ?? "Loading stop…"}</div>
          <div className={cx("mt-0.5 text-[13px]", muted)}>{stop?.code ? `Stop #${stop.code}` : "Bus stop"}</div>
        </div>
      </header>

      <div className={cx("px-5 pb-1.5 text-[13px] font-semibold", muted)}>Next arrivals</div>
      {error && <p className={cx("px-5 py-2 text-sm", muted)}>{error}</p>}
      {stop && arrivals.length === 0 && <p className={cx("px-5 py-2 text-sm", muted)}>No live predictions right now.</p>}
      {arrivals.length > 0 && (
        <ol className={cx("mx-3 mb-3 min-h-0 flex-1 divide-y divide-black/[0.06] overflow-y-auto rounded-2xl dark:divide-white/[0.06]", fill)}>
          {arrivals.map((a, i) => {
            const tracked = a.vehicle_id != null && liveIds.has(a.vehicle_id);
            return (
              <li key={i}>
                <button
                  type="button"
                  disabled={!tracked}
                  onClick={() => a.vehicle_id && onVehicle(a.vehicle_id)}
                  title={tracked ? "Show this bus" : "Bus position not available"}
                  className="flex min-h-[52px] w-full items-center gap-3 px-3.5 py-2 text-left transition enabled:hover:bg-black/[0.04] dark:enabled:hover:bg-white/[0.05]"
                >
                  <RouteBadge route={a.route} />
                  <span className="min-w-0 flex-1 text-[14px] font-medium leading-snug">
                    {a.headsign ?? a.route.long_name}
                    {tracked && <span className="block text-xs font-medium text-emerald-500 dark:text-emerald-400">● Live on map</span>}
                  </span>
                  <span className="flex flex-none flex-col items-end tabular-nums">
                    <strong className="text-[15px] font-semibold">{minutesLabel(a.minutes)}</strong>
                    <span className={cx("text-[11px]", muted)}>{a.time}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
