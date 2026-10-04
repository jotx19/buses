import type { PlanLeg, PlanResponse, TripOption } from "../api";
import { distanceLabel, minutesLabel } from "../format";
import { IconChevron, IconClose, IconFlag, IconWalk } from "./Icons";
import { RouteBadge, cx, faint, fill, muted, selected as selectedStyle } from "./ui";

interface Props {
  plan: PlanResponse | null;
  loading: boolean;
  error: string | null;
  active: number;
  liveIds: Set<string>;
  onActive: (i: number) => void;
  onTrack: (vehicleId: string) => void;
  onClear: () => void;
}

type BusLeg = Extract<PlanLeg, { type: "bus" }>;

/** Trip planner results: from → to, ranked options, and step-by-step directions. */
export function TripView({ plan, loading, error, active, liveIds, onActive, onTrack, onClear }: Props) {
  const option = plan?.options[active];
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Trip plan">
      <div className="flex items-start gap-3 px-5 pb-3">
        <div className="relative min-w-0 flex-1 space-y-2 pl-5">
          <span className="absolute left-[5px] top-[9px] bottom-[9px] w-px border-l border-dashed border-zinc-400 dark:border-white/30" />
          <Endpoint color="bg-emerald-500" label="From" name={plan?.from.name ?? "…"} />
          <Endpoint color="bg-red-500" label="To" name={plan?.to.name ?? "…"} />
        </div>
        <button
          type="button"
          onClick={onClear}
          aria-label="Clear trip"
          title="Clear trip"
          className="grid size-8 flex-none place-items-center rounded-full bg-black/[0.05] text-zinc-500 transition hover:bg-black/[0.09] dark:bg-white/[0.07] dark:text-white/60 dark:hover:bg-white/[0.12]"
        >
          <IconClose />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 [scrollbar-width:thin]">
        {loading && <p className={cx("px-2 py-6 text-center text-sm", muted)}>Finding routes…</p>}
        {error && <p className="px-2 py-6 text-center text-sm text-red-500">{error}</p>}
        {plan && !loading && plan.options.length === 0 && (
          <p className={cx("px-2 py-6 text-center text-sm", muted)}>
            No bus connection found. Walking takes about {Math.round(plan.walk_only_minutes)} min.
          </p>
        )}

        {plan && plan.options.length > 0 && (
          <ul className="space-y-1.5">
            {plan.options.map((o, i) => (
              <li key={i}>
                <OptionCard option={o} active={i === active} onClick={() => onActive(i)} />
              </li>
            ))}
          </ul>
        )}

        {option && (
          <ol className={cx("mt-3 rounded-2xl py-1", fill)}>
            {option.legs.map((leg, i) =>
              leg.type === "walk" ? (
                leg.meters >= 5 && (
                  <Step key={i} icon={<IconWalk />}>
                    <div className="text-[14px] font-medium">
                      Walk {distanceLabel(leg.meters)} to {i === option.legs.length - 1 ? plan!.to.name : leg.to.name}
                    </div>
                    <div className={cx("text-xs", muted)}>about {minutesLabel(Math.round(leg.minutes))}</div>
                  </Step>
                )
              ) : (
                <BusStep key={i} leg={leg} liveIds={liveIds} onTrack={onTrack} />
              ),
            )}
            <Step icon={<IconFlag />}>
              <div className="text-[14px] font-medium">Arrive at {plan!.to.name}</div>
            </Step>
          </ol>
        )}
      </div>
    </section>
  );
}

function Endpoint({ color, label, name }: { color: string; label: string; name: string }) {
  return (
    <div className="relative">
      <span className={cx("absolute -left-5 top-[5px] size-[11px] rounded-full ring-2 ring-white dark:ring-[#1c1c1e]", color)} />
      <div className={cx("text-[11px] font-medium", faint)}>{label}</div>
      <div className="truncate text-[15px] font-semibold leading-tight">{name}</div>
    </div>
  );
}

function OptionCard({ option: o, active, onClick }: { option: TripOption; active: boolean; onClick: () => void }) {
  const buses = o.legs.filter((l): l is BusLeg => l.type === "bus");
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cx(
        "w-full rounded-2xl px-3.5 py-3 text-left transition active:scale-[0.99]",
        active ? selectedStyle : "bg-black/[0.04] hover:bg-black/[0.07] dark:bg-white/[0.05] dark:hover:bg-white/[0.09]",
      )}
    >
      <div className="flex items-center gap-1.5">
        {o.legs.map((l, i) => (
          <span key={i} className="flex items-center gap-1.5">
            {i > 0 && <span className="opacity-40"><IconChevron /></span>}
            {l.type === "walk" ? (
              <span className="flex items-center opacity-70"><IconWalk /></span>
            ) : (
              <RouteBadge route={l.route} size="sm" />
            )}
          </span>
        ))}
        <span className="ml-auto pl-2 text-[17px] font-bold tabular-nums">{Math.round(o.total_minutes)} min</span>
      </div>
      <div className={cx("mt-1.5 flex justify-between text-xs", active ? "opacity-70" : muted)}>
        <span>
          {o.leaves_in != null ? `Leaves in ${minutesLabel(o.leaves_in)}` : "No live departure yet"} · {buses[0]?.board.name}
        </span>
        <span className="tabular-nums">{distanceLabel(o.walk_meters)} walk</span>
      </div>
    </button>
  );
}

function Step({ icon, children, color }: { icon: React.ReactNode; children: React.ReactNode; color?: string }) {
  return (
    <li className="flex gap-3 px-3.5 py-2.5">
      <span
        className={cx("mt-0.5 grid size-7 flex-none place-items-center rounded-full", !color && "bg-black/[0.06] dark:bg-white/10")}
        style={color ? { background: color, color: "#fff" } : undefined}
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </li>
  );
}

function BusStep({ leg, liveIds, onTrack }: { leg: BusLeg; liveIds: Set<string>; onTrack: (id: string) => void }) {
  return (
    <li className="flex gap-3 px-3.5 py-2.5">
      <RouteBadge route={leg.route} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-semibold leading-snug">
          Board at {leg.board.name}
          {leg.board.code && <span className={cx("ml-1.5 text-xs font-normal", faint)}>#{leg.board.code}</span>}
        </div>
        <div className={cx("text-xs", muted)}>
          towards {leg.headsign || leg.route.long_name} · {leg.stops} stops · {minutesLabel(Math.round(leg.ride_minutes))}
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {leg.departures.length === 0 && <span className={cx("text-xs", faint)}>No live departures right now</span>}
          {leg.departures.map((d, i) => {
            const live = d.vehicle_id != null && liveIds.has(d.vehicle_id);
            return (
              <button
                key={i}
                type="button"
                disabled={!live}
                onClick={() => d.vehicle_id && onTrack(d.vehicle_id)}
                title={live ? "Track this bus" : "Bus position not available yet"}
                className={cx(
                  "inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-xs font-semibold tabular-nums transition",
                  live
                    ? "bg-emerald-500/15 text-emerald-600 hover:bg-emerald-500/25 active:scale-95 dark:text-emerald-400"
                    : "bg-black/[0.05] text-zinc-500 dark:bg-white/[0.07] dark:text-white/50",
                )}
              >
                {live && <span className="size-1.5 rounded-full bg-current" />}
                {minutesLabel(d.minutes)}
              </button>
            );
          })}
        </div>
        <div className="mt-2 text-[14px] font-medium leading-snug">Get off at {leg.alight.name}</div>
      </div>
    </li>
  );
}
