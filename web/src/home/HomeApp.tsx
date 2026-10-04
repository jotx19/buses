import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type MapConfig, type NearbyResponse, type PlanPlace, type RouteInfo } from "../api";
import { distanceLabel, minutesLabel } from "../format";
import { IconHome, IconLocate, IconMap, IconMoon, IconSpeak, IconSun, IconSwap } from "../components/Icons";
import { PlaceInput, resolvePlace } from "../components/PlaceInput";
import { IconButton, RouteBadge, cx, faint, glass, muted, selected } from "../components/ui";
import { TransitScene } from "./TransitScene";
import { Logo } from "../components/Logo";

const THEME_KEY = "oc-next-theme"; // shared with the map
const NEARBY_REFRESH_MS = 30_000;
type Theme = "dark" | "light";

function readTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function HomeApp() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [config, setConfig] = useState<MapConfig | null>(null);
  const [routes, setRoutes] = useState<Map<string, RouteInfo>>(new Map());
  const [liveCount, setLiveCount] = useState<number | null>(null);

  const [fromText, setFromText] = useState("");
  const [fromPlace, setFromPlace] = useState<PlanPlace | null>(null);
  const [toText, setToText] = useState("");
  const [toPlace, setToPlace] = useState<PlanPlace | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);

  const [here, setHere] = useState<{ lat: number; lon: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [nearby, setNearby] = useState<NearbyResponse | null>(null);
  const [nearbyError, setNearbyError] = useState<string | null>(null);

  // ---- theme ----
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* private mode */
    }
  }, [theme]);

  // ---- config, route colours, live count ----
  useEffect(() => {
    api.config().then(setConfig).catch(() => {});
    api
      .routes()
      .then((r) => setRoutes(new Map(r.routes.flatMap((x) => [[x.id, x], [x.short_name, x]] as [string, RouteInfo][]))))
      .catch(() => {});
    const loadCount = () =>
      api
        .live()
        .then((d) => setLiveCount(d.vehicles.filter((v) => v.in_service).length))
        .catch(() => {});
    loadCount();
    const t = setInterval(loadCount, 30_000);
    return () => clearInterval(t);
  }, []);

  // ---- location ----
  const useHere = useCallback((lat: number, lon: number) => {
    setHere({ lat, lon });
    setFromPlace({ name: "Current location", lat, lon });
    setFromText("Current location");
  }, []);

  const locate = useCallback(
    (quiet = false) => {
      if (!("geolocation" in navigator)) {
        if (!quiet) setMessage("Location isn't supported by this browser.");
        return;
      }
      setLocating(true);
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          setLocating(false);
          setMessage(null);
          useHere(pos.coords.latitude, pos.coords.longitude);
        },
        (err) => {
          setLocating(false);
          if (!quiet) setMessage(`Location unavailable: ${err.message}`);
        },
        { enableHighAccuracy: true, timeout: 12_000, maximumAge: 30_000 },
      );
    },
    [useHere],
  );

  // Already allowed? Detect silently on load.
  useEffect(() => {
    navigator.permissions
      ?.query({ name: "geolocation" })
      .then((p) => p.state === "granted" && locate(true))
      .catch(() => {});
  }, [locate]);

  // ---- nearby arrivals for the detected location ----
  useEffect(() => {
    if (!here) return;
    let ctrl = new AbortController();
    const load = () => {
      ctrl.abort();
      ctrl = new AbortController();
      api
        .nearby(here.lat, here.lon, ctrl.signal)
        .then((d) => {
          setNearby(d);
          setNearbyError(null);
        })
        .catch((err: Error) => err.name !== "AbortError" && setNearbyError(err.message));
    };
    load();
    const t = setInterval(load, NEARBY_REFRESH_MS);
    return () => {
      clearInterval(t);
      ctrl.abort();
    };
  }, [here]);

  // ---- plan ----
  const plan = async (e: React.FormEvent) => {
    e.preventDefault();
    setPlanning(true);
    setMessage(null);
    try {
      const [from, to] = await Promise.all([resolvePlace(fromText, fromPlace), resolvePlace(toText, toPlace)]);
      if (!from) return setMessage("Where are you starting from?");
      if (!to) return setMessage("Where do you want to go?");
      const q = new URLSearchParams({
        from: `${from.lat},${from.lon}`,
        from_name: from.name,
        to: `${to.lat},${to.lon}`,
        to_name: to.name,
      });
      window.location.href = `/map?${q}`;
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setPlanning(false);
    }
  };

  const swap = () => {
    setFromText(toText);
    setFromPlace(toPlace);
    setToText(fromText);
    setToPlace(fromPlace);
  };

  const speak = () => {
    if (!nearby?.spoken || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(nearby.spoken);
    u.rate = 1.02;
    window.speechSynthesis.speak(u);
  };

  const rows = useMemo(() => nearby?.buses ?? [], [nearby]);
  const usingHere = fromPlace?.name === "Current location";

  return (
    <div className="relative flex h-dvh flex-col overflow-hidden bg-[#f2f2f7] font-sans text-zinc-900 antialiased [--scene-bg:#f2f2f7] dark:bg-[#1c1c1e] dark:text-white dark:[--scene-bg:#1c1c1e]">
      <div className="fixed inset-0">
        <TransitScene />
      </div>

      {/* top bar */}
      <header className="relative z-20 mx-auto flex w-full max-w-5xl flex-none items-center justify-between px-4 pt-[max(1rem,env(safe-area-inset-top))] sm:px-6">
        <div className={cx(glass, "flex items-center gap-2.5 rounded-full py-1.5 pl-1.5 pr-4")}>
          <Logo size={36} className="drop-shadow-sm" />
          <span className="text-[15px] font-semibold tracking-tight">OC Next</span>
        </div>
        <div className={cx(glass, "flex items-center gap-1 rounded-full p-1")}>
          <IconButton label={theme === "dark" ? "Light mode" : "Dark mode"} onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}>
            {theme === "dark" ? <IconSun /> : <IconMoon />}
          </IconButton>
          <a
            href="/map"
            className="inline-flex h-10 items-center gap-1.5 rounded-full px-4 text-[13px] font-semibold transition hover:bg-black/[0.06] active:scale-95 dark:hover:bg-white/10"
          >
            <IconMap /> Live map
          </a>
        </div>
      </header>

      <main className="relative z-10 mx-auto flex min-h-0 w-full max-w-[460px] flex-1 flex-col px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[clamp(1rem,6vh,4.5rem)]">
        {/* hero */}
        <div className="mb-[clamp(0.75rem,3vh,1.5rem)] flex-none text-center">
          <div className={cx(glass, "mx-auto inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-[13px] tabular-nums")}>
            <span className="relative flex size-2">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
            </span>
            {liveCount != null ? (
              <span>
                <b className="font-semibold">{liveCount}</b> <span className={muted}>buses on the road now</span>
              </span>
            ) : (
              <span className={muted}>Connecting to OC Transpo…</span>
            )}
          </div>
          <h1 className="mt-[clamp(0.75rem,2.5vh,1.25rem)] text-[clamp(2.25rem,7vh,3.75rem)] font-bold leading-none tracking-[-0.035em]">Where to?</h1>
          <p className={cx("mt-3 text-[15px] [@media(max-height:640px)]:hidden", muted)}>Live OC Transpo buses, routes and arrivals in 3D.</p>
        </div>

        {/* plan card */}
        <form onSubmit={plan} className={cx(glass, "relative z-20 flex-none rounded-[30px] p-3")}>
          <div className="relative space-y-2">
            <PlaceInput
              label="From"
              dot="bg-emerald-500"
              placeholder="Current location or address"
              text={fromText}
              onText={setFromText}
              onPlace={setFromPlace}
              trailing={
                <span className="flex flex-none items-center gap-0.5">
                  {config?.home && (
                    <IconButton label="Start from home" onClick={() => useHere(config.home!.lat, config.home!.lon)}>
                      <IconHome />
                    </IconButton>
                  )}
                  <IconButton
                    label="Use my location"
                    active={usingHere}
                    onClick={() => locate(false)}
                    className={locating ? "[&_svg]:animate-spin" : undefined}
                  >
                    <IconLocate />
                  </IconButton>
                </span>
              }
            />
            <PlaceInput label="To" dot="bg-red-500" placeholder="Search a place or address" text={toText} onText={setToText} onPlace={setToPlace} />

            <button
              type="button"
              onClick={swap}
              aria-label="Swap from and to"
              title="Swap"
              className={cx(
                glass,
                "absolute right-16 top-1/2 z-10 grid size-9 -translate-y-1/2 place-items-center rounded-full text-zinc-700 transition hover:scale-105 active:scale-90 dark:text-white/80",
              )}
            >
              <IconSwap />
            </button>
          </div>

          <button
            type="submit"
            disabled={planning}
            className={cx(
              selected,
              "mt-3 flex h-14 w-full items-center justify-center gap-2 rounded-2xl text-[15px] font-semibold transition active:scale-[0.98] disabled:opacity-60",
            )}
          >
            {planning ? "Finding places…" : "Plan route"}
          </button>
          {message && <p className="px-2 pt-2.5 text-center text-[13px] text-red-500">{message}</p>}
        </form>

        {/* nearby arrivals */}
        <section className={cx(glass, "mt-4 flex min-h-[132px] flex-1 flex-col overflow-hidden rounded-[30px] p-2")} aria-live="polite">
          <div className="flex flex-none items-center justify-between px-3 pb-1 pt-2">
            <div>
              <h2 className="text-[15px] font-semibold tracking-tight">Nearby now</h2>
              <p className={cx("text-xs", muted)}>
                {nearby ? `${nearby.stop_count} stops within ${Math.round(nearby.radius_m)} m` : "Arrivals around you"}
              </p>
            </div>
            {nearby?.spoken && (
              <IconButton label="Read arrivals aloud" onClick={speak}>
                <IconSpeak />
              </IconButton>
            )}
          </div>

          {!here && (
            <button
              type="button"
              onClick={() => locate(false)}
              className="m-1 flex w-[calc(100%-0.5rem)] items-center justify-center gap-2 rounded-2xl bg-black/[0.05] py-3.5 text-[14px] font-medium transition hover:bg-black/[0.08] active:scale-[0.99] dark:bg-white/[0.07] dark:hover:bg-white/[0.11]"
            >
              <span className={locating ? "animate-spin" : undefined}>
                <IconLocate />
              </span>
              {locating ? "Detecting location…" : "Detect my location"}
            </button>
          )}
          {here && !nearby && !nearbyError && <p className={cx("px-3 py-4 text-center text-sm", muted)}>Loading arrivals…</p>}
          {nearbyError && <p className="px-3 py-4 text-center text-sm text-red-500">{nearbyError}</p>}
          {nearby && rows.length === 0 && <p className={cx("px-3 py-4 text-center text-sm", muted)}>No buses arriving nearby right now.</p>}

          {rows.length > 0 && (
            <ul className="mt-1 min-h-0 flex-1 space-y-0.5 overflow-y-auto overscroll-contain [scrollbar-width:thin]">
              {rows.map((b) => (
                <li key={`${b.route_id}-${b.stop_id}`}>
                  <a
                    href="/map"
                    className="flex items-center gap-3 rounded-2xl px-3 py-2.5 transition hover:bg-black/[0.05] dark:hover:bg-white/[0.07]"
                  >
                    <RouteBadge
                      route={
                        routes.get(b.route_id) ?? {
                          id: b.route_id,
                          short_name: b.route_id,
                          long_name: "",
                          color: "#5B6770",
                          text_color: "#FFFFFF",
                          route_type: 3,
                        }
                      }
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14.5px] font-medium">{b.stop_name}</span>
                      <span className={cx("block text-xs", faint)}>{distanceLabel(b.distance_m)} away</span>
                    </span>
                    <span className="flex-none text-right tabular-nums">
                      <span className={cx("block text-[16px] font-semibold", b.minutes <= 1 && "text-emerald-500 dark:text-emerald-400")}>
                        {minutesLabel(b.minutes)}
                      </span>
                      <span className={cx("block text-[11px]", muted)}>{b.time}</span>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
