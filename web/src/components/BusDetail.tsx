import type { UpcomingStop, Vehicle, VehicleDetail } from "../api";
import { distanceM } from "../map/fleet";
import type { UserPosition } from "../map/useTransitMap";
import { agoLabel, compass, distanceLabel, minutesLabel } from "../format";
import { IconBack, IconCamera, IconCheck, IconFollow, IconLocate, IconRoute } from "./Icons";
import { Pill, RouteBadge, cx, faint, fill, muted } from "./ui";

interface Props {
  vehicle: Vehicle;
  detail: VehicleDetail | null;
  detailError: string | null;
  user: UserPosition | null;
  now: number;
  following: boolean;
  cameraLocked: boolean;
  chase: boolean;
  onBack: () => void;
  backLabel?: string;
  onFollow: (on: boolean) => void;
  onRecenter: () => void;
  onChase: (on: boolean) => void;
  onShowRoute: () => void;
  onStop: (stop: UpcomingStop) => void;
}

export function BusDetail({
  vehicle: v,
  detail,
  detailError,
  user,
  now,
  following,
  cameraLocked,
  chase,
  onBack,
  backLabel = "Nearby",
  onFollow,
  onRecenter,
  onChase,
  onShowRoute,
  onStop,
}: Props) {
  const color = v.route?.color ?? "#8e8e93";
  const upcoming = detail?.vehicle.id === v.id ? detail.upcoming : [];
  const kind = v.route?.route_type === 0 ? "Train" : "Bus";

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label={`${kind} ${v.id}`}>
      <div className="px-3">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex h-8 items-center gap-0.5 rounded-full pl-1 pr-3 text-[13px] font-medium text-sky-600 transition hover:bg-black/[0.05] dark:text-sky-400 dark:hover:bg-white/[0.07]"
        >
          <IconBack /> {backLabel}
        </button>
      </div>

      <header className="flex items-center gap-3.5 px-5 pb-3 pt-2">
        <RouteBadge route={v.route} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xl font-bold leading-tight tracking-tight">
            {v.in_service ? v.headsign ?? "Destination unknown" : "Not in service"}
          </div>
          <div className={cx("mt-0.5 truncate text-[13px]", muted)}>
            {v.in_service ? v.route?.long_name || `Route ${v.route?.short_name}` : `${kind} not on a trip`}
          </div>
        </div>
      </header>

      <div className={cx("mx-4 grid grid-cols-4 divide-x divide-black/10 rounded-2xl py-2.5 text-center dark:divide-white/10", fill)}>
        <Stat label={kind} value={`#${v.id}`} />
        <Stat label="Speed" value={v.speed_kmh != null ? `${Math.round(v.speed_kmh)} km/h` : "—"} />
        <Stat label="Heading" value={v.bearing != null ? compass(v.bearing) : "—"} />
        <Stat
          label={user ? "From you" : "GPS"}
          value={user ? distanceLabel(distanceM(user.lat, user.lon, v.lat, v.lon)) : v.timestamp ? agoLabel(v.timestamp, now) : "—"}
        />
      </div>

      <div className="flex gap-2 px-4 pb-3 pt-3">
        <Pill active={following} onClick={() => onFollow(!following)} title={following ? "Stop following" : "Follow this bus"}>
          {following ? <IconCheck /> : <IconFollow />} {following ? "Following" : "Follow"}
        </Pill>
        {following ? (
          <>
            <Pill active={chase} onClick={() => onChase(!chase)} title="Camera behind the bus, turning with it">
              <IconCamera /> Behind bus
            </Pill>
            {!cameraLocked && (
              <Pill onClick={onRecenter}>
                <IconLocate /> Recentre
              </Pill>
            )}
          </>
        ) : (
          <Pill onClick={onShowRoute} disabled={!detail?.shape}>
            <IconRoute /> Whole route
          </Pill>
        )}
      </div>

      {v.in_service && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-baseline justify-between px-5 pb-1.5">
            <span className={cx("text-[13px] font-semibold", muted)}>Upcoming stops</span>
            {v.timestamp && <span className={cx("text-xs", faint)}>GPS {agoLabel(v.timestamp, now)}</span>}
          </div>
          {detailError && <p className={cx("px-5 py-2 text-sm", muted)}>{detailError}</p>}
          {!detail && !detailError && <p className={cx("px-5 py-2 text-sm", muted)}>Loading trip…</p>}
          {detail && upcoming.length === 0 && <p className={cx("px-5 py-2 text-sm", muted)}>No live stop predictions.</p>}
          {upcoming.length > 0 && (
            <ol className={cx("mx-3 mb-3 min-h-0 flex-1 overflow-y-auto rounded-2xl py-1 [scrollbar-width:thin]", fill)}>
              {upcoming.map((s, i) => (
                <li key={`${s.id}-${i}`}>
                  <button
                    type="button"
                    onClick={() => onStop(s)}
                    className="relative flex min-h-[50px] w-full items-center gap-3 px-3.5 py-2 text-left transition hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
                  >
                    {/* route-coloured line joining the stops */}
                    <span
                      className={cx("absolute left-[21px] w-0.5 opacity-40", i === 0 ? "top-1/2" : "top-0", i === upcoming.length - 1 ? "bottom-1/2" : "bottom-0")}
                      style={{ background: color }}
                    />
                    <span
                      className="relative z-10 size-3.5 flex-none rounded-full border-[2.5px] bg-white dark:bg-[#1c1c1e]"
                      style={i === 0 ? { borderColor: color, background: color, boxShadow: `0 0 0 5px ${color}40` } : { borderColor: color }}
                    />
                    <span className={cx("min-w-0 flex-1 text-[14px] leading-snug", i === 0 ? "font-semibold" : "font-medium")}>
                      {s.name}
                      {s.code && <span className={cx("ml-1.5 text-xs font-normal", faint)}>#{s.code}</span>}
                    </span>
                    <span className="flex flex-none flex-col items-end tabular-nums">
                      <strong className={cx("text-[15px] font-semibold", i === 0 && "text-emerald-500 dark:text-emerald-400")}>
                        {minutesLabel(s.minutes)}
                      </strong>
                      <span className={cx("text-[11px]", muted)}>{s.time}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-1.5">
      <div className={cx("text-[11px] font-medium", muted)}>{label}</div>
      <div className="mt-0.5 truncate text-[14px] font-semibold tabular-nums">{value}</div>
    </div>
  );
}
