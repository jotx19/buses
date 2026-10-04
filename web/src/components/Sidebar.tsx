import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { RouteInfo, Vehicle } from "../api";
import { agoLabel, compareRoutes } from "../format";
import { IconClose, IconCollapse, IconExpand, IconSearch } from "./Icons";
import { Logo } from "./Logo";
import { RouteBadge, cx, fill, glass, muted, popover } from "./ui";

interface Props {
  vehicles: Vehicle[];
  allRoutes: RouteInfo[];
  updatedAt: number | null;
  now: number;
  error: string | null;
  filterRoute: RouteInfo | null;
  onFilter: (route: RouteInfo | null) => void;
  /** phones: sheet minimised to just its header */
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  /** reports the sheet's rendered height (used for map padding on phones) */
  onHeight?: (px: number) => void;
  /** one-line context shown under the header while minimised */
  summary?: ReactNode;
  children: ReactNode;
}

interface Option {
  route: RouteInfo;
  live: number;
}

/** Left glass sidebar (bottom sheet on phones): brand, live status, route search, content. */
export function Sidebar({
  vehicles,
  allRoutes,
  updatedAt,
  now,
  error,
  filterRoute,
  onFilter,
  collapsed,
  onCollapsedChange,
  onHeight,
  summary,
  children,
}: Props) {
  const asideRef = useRef<HTMLElement>(null);
  const swipeY = useRef<number | null>(null);

  // Phones: whenever the sheet's natural height changes (minimise, expand, new
  // content), glide from the old height to the new one. ResizeObserver runs after
  // layout but before paint, so the animation starts on the very frame of the change.
  useEffect(() => {
    const el = asideRef.current;
    if (!el) return;
    const phone = window.matchMedia("(max-width: 767px)");
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let last = 0;
    let anim: Animation | null = null;

    const settle = () => {
      const h = el.getBoundingClientRect().height;
      onHeight?.(Math.round(h));
      if (!last || !phone.matches || reduced.matches || Math.abs(h - last) < 2) {
        last = h;
        return;
      }
      const from = last;
      last = h;
      anim?.cancel();
      anim = el.animate([{ height: `${from}px` }, { height: `${h}px` }], {
        duration: 420,
        easing: "cubic-bezier(0.32, 0.72, 0, 1)", // iOS sheet curve
      });
      anim.onfinish = () => {
        anim = null;
        // content may have changed again mid-animation
        if (Math.abs(el.getBoundingClientRect().height - last) >= 2) settle();
      };
    };

    const ro = new ResizeObserver(() => {
      if (!anim) settle(); // ignore the intermediate sizes of our own animation
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      anim?.cancel();
    };
  }, [onHeight]);

  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const inService = vehicles.filter((v) => v.in_service).length;

  // Routes with buses on the road first, then the rest of the network.
  const options = useMemo<Option[]>(() => {
    const live = new Map<string, Option>();
    for (const v of vehicles) {
      if (!v.route) continue;
      const o = live.get(v.route.id) ?? { route: v.route, live: 0 };
      o.live++;
      live.set(v.route.id, o);
    }
    const rest = allRoutes.filter((r) => !live.has(r.id)).map((route) => ({ route, live: 0 }));
    const q = query.trim().toLowerCase();
    const match = (o: Option) =>
      !q || o.route.short_name.toLowerCase().startsWith(q) || o.route.long_name.toLowerCase().includes(q);
    const sort = (a: Option, b: Option) => compareRoutes(a.route.short_name, b.route.short_name);
    return [...[...live.values()].filter(match).sort(sort), ...rest.filter(match).sort(sort)].slice(0, 30);
  }, [vehicles, allRoutes, query]);

  const choose = (o: Option | undefined) => {
    if (!o) return;
    onFilter(o.route);
    setQuery("");
    setOpen(false);
    inputRef.current?.blur();
  };

  return (
    <aside
      ref={asideRef}
      className={cx(
        glass,
        "absolute z-20 flex flex-col overflow-hidden text-zinc-900 dark:text-white",
        "left-4 top-[4.25rem] bottom-4 w-[372px] rounded-[30px]",
        // phones: bottom sheet sized to its content, capped so the map stays visible
        "max-md:inset-x-2 max-md:top-auto max-md:bottom-[max(0.5rem,env(safe-area-inset-bottom))] max-md:max-h-[82dvh] max-md:w-auto max-md:rounded-[28px]",
        "max-md:transition-[max-height] max-md:duration-300",
        "animate-[panel-in_0.5s_cubic-bezier(0.32,0.72,0,1)]",
      )}
    >
      {/* grab handle (phones): tap or swipe to minimise / expand */}
      <button
        type="button"
        aria-label={collapsed ? "Expand panel" : "Minimise panel"}
        onClick={() => onCollapsedChange(!collapsed)}
        onPointerDown={(e) => (swipeY.current = e.clientY)}
        onPointerUp={(e) => {
          const start = swipeY.current;
          swipeY.current = null;
          if (start == null) return;
          const dy = e.clientY - start;
          if (dy > 30) onCollapsedChange(true);
          else if (dy < -30) onCollapsedChange(false);
        }}
        className="flex h-5 w-full flex-none touch-none items-end justify-center outline-none md:hidden"
      >
        <span className="h-[5px] w-9 rounded-full bg-black/20 transition-colors dark:bg-white/25" />
      </button>

      <header className={cx("flex flex-none items-center gap-3 px-4 pb-3 pt-4 max-md:pt-2.5", collapsed && !summary && "max-md:pb-4")}>
        <a
          href="/"
          title="Back to OC Next"
          className="flex-none rounded-full transition active:scale-95"
        >
          <Logo size={40} className="drop-shadow-sm" />
        </a>
        <div className="min-w-0 flex-1">
          <div className="text-[17px] font-semibold tracking-tight">OC Next</div>
          <div className={cx("flex items-center gap-1.5 text-[12.5px] tabular-nums", muted)}>
            <span className="relative flex size-[7px]">
              {!error && <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75" />}
              <span className={cx("relative inline-flex size-[7px] rounded-full", error ? "bg-red-500" : "bg-emerald-500")} />
            </span>
            {error ? (
              <span className="truncate text-red-500" title={error}>Feed unavailable</span>
            ) : updatedAt ? (
              <span className="truncate">
                <b className="font-semibold text-zinc-900 dark:text-white">{inService}</b> buses live · {agoLabel(updatedAt / 1000, now)}
              </span>
            ) : (
              <span>Connecting…</span>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={() => onCollapsedChange(!collapsed)}
          aria-label={collapsed ? "Expand panel" : "Minimise panel"}
          title={collapsed ? "Expand" : "Minimise"}
          className="grid size-10 flex-none place-items-center rounded-full bg-black/[0.05] text-zinc-600 outline-none transition active:scale-90 focus-visible:ring-2 focus-visible:ring-sky-500 md:hidden dark:bg-white/[0.08] dark:text-white/70"
        >
          {collapsed ? <IconExpand /> : <IconCollapse />}
        </button>
      </header>

      {collapsed && summary && (
        <div className="mx-4 mb-4 flex-none animate-[fade-up_0.35s_cubic-bezier(0.32,0.72,0,1)] rounded-2xl bg-black/[0.05] px-3 py-2.5 md:hidden dark:bg-white/[0.07]">
          {summary}
        </div>
      )}

      <div className={cx("relative flex-none px-4 pb-3", collapsed && "max-md:hidden")}>
        {filterRoute ? (
          <div className={cx("flex h-11 items-center gap-2.5 rounded-[14px] pl-2 pr-1.5", fill)}>
            <RouteBadge route={filterRoute} size="sm" />
            <span className="min-w-0 flex-1 truncate text-[14px] font-semibold">
              {filterRoute.long_name || `Route ${filterRoute.short_name}`}
            </span>
            <button
              type="button"
              onClick={() => onFilter(null)}
              aria-label="Clear route filter"
              className="grid size-8 place-items-center rounded-full text-zinc-500 transition hover:bg-black/[0.06] dark:text-white/60 dark:hover:bg-white/10"
            >
              <IconClose />
            </button>
          </div>
        ) : (
          <label
            className={cx(
              "flex h-11 items-center gap-2 rounded-[14px] px-3 transition focus-within:ring-[3px] focus-within:ring-sky-500/35",
              fill,
              muted,
            )}
          >
            <IconSearch />
            <input
              ref={inputRef}
              value={query}
              placeholder="Search routes"
              aria-label="Search routes"
              className="min-w-0 flex-1 bg-transparent text-base text-zinc-900 outline-none placeholder:text-zinc-500 dark:text-white dark:placeholder:text-white/45"
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
                setOpen(true);
              }}
              onFocus={() => setOpen(true)}
              onBlur={() => setTimeout(() => setOpen(false), 150)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") setActive((a) => Math.min(a + 1, options.length - 1));
                else if (e.key === "ArrowUp") setActive((a) => Math.max(a - 1, 0));
                else if (e.key === "Enter") choose(options[active]);
                else if (e.key === "Escape") inputRef.current?.blur();
                else return;
                e.preventDefault();
              }}
            />
          </label>
        )}

        {open && !filterRoute && options.length > 0 && (
          <ul
            role="listbox"
            className={cx(
              popover,
              "absolute inset-x-3 top-full z-30 mt-1 max-h-[min(380px,50vh)] overflow-y-auto rounded-[22px] p-1.5 [scrollbar-width:thin]",
            )}
          >
            {options.map((o, i) => (
              <li key={o.route.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(o)}
                  className={cx(
                    "flex w-full items-center gap-3 rounded-[14px] px-2.5 py-2 text-left",
                    i === active && "bg-black/[0.06] dark:bg-white/10",
                  )}
                >
                  <RouteBadge route={o.route} size="sm" />
                  <span className="min-w-0 flex-1 truncate text-[14px]">{o.route.long_name}</span>
                  <span className={cx("text-xs", o.live ? "font-semibold text-emerald-500" : muted)}>
                    {o.live ? `${o.live} live` : "not running"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className={cx("mx-4 h-px flex-none bg-black/[0.07] dark:bg-white/[0.07]", collapsed && "max-md:hidden")} />
      {/* phones: size by content (flex-basis auto) so the sheet grows with it and scrolls at the cap */}
      <div className={cx("flex min-h-0 flex-1 flex-col pt-3 max-md:basis-auto max-md:[&_*]:basis-auto", collapsed && "max-md:hidden")}>
        {children}
      </div>
    </aside>
  );
}
