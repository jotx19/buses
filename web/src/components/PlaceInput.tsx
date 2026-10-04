import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, type PlaceResult, type PlanPlace } from "../api";
import { cx, fill, muted, popover } from "./ui";

interface Props {
  label: string;
  dot: string;
  placeholder: string;
  text: string;
  onText: (text: string) => void;
  onPlace: (place: PlanPlace | null) => void;
  trailing?: ReactNode;
}

/** Address / place search with live suggestions (server-side Photon geocoder). */
export function PlaceInput({ label, dot, placeholder, text, onText, onPlace, trailing }: Props) {
  const [results, setResults] = useState<PlaceResult[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const typed = useRef(false);

  useEffect(() => {
    if (!typed.current) return;
    const q = text.trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      api
        .geocode(q, ctrl.signal)
        .then((r) => {
          setResults(r.results);
          setActive(0);
          setOpen(true);
        })
        .catch(() => {});
    }, 220);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [text]);

  const choose = (r: PlaceResult | undefined) => {
    if (!r) return;
    typed.current = false;
    onText(r.name);
    onPlace({ name: r.name, lat: r.lat, lon: r.lon });
    setOpen(false);
  };

  return (
    <div className="relative">
      <label className={cx("flex h-14 items-center gap-3 rounded-2xl pl-4 pr-1.5 transition focus-within:ring-[3px] focus-within:ring-sky-500/35", fill)}>
        <span className={cx("size-2.5 flex-none rounded-full", dot)} />
        <span className="min-w-0 flex-1">
          <span className={cx("block text-[11px] font-medium", muted)}>{label}</span>
          <input
            value={text}
            placeholder={placeholder}
            aria-label={label}
            className="block w-full bg-transparent text-base font-medium text-zinc-900 outline-none placeholder:font-normal placeholder:text-zinc-400 dark:text-white dark:placeholder:text-white/35"
            onChange={(e) => {
              typed.current = true;
              onText(e.target.value);
              onPlace(null);
            }}
            onFocus={() => results.length && setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            onKeyDown={(e) => {
              if (!open) return;
              if (e.key === "ArrowDown") setActive((a) => Math.min(a + 1, results.length - 1));
              else if (e.key === "ArrowUp") setActive((a) => Math.max(a - 1, 0));
              else if (e.key === "Enter") choose(results[active]);
              else if (e.key === "Escape") setOpen(false);
              else return;
              e.preventDefault();
            }}
          />
        </span>
        {trailing}
      </label>

      {open && results.length > 0 && (
        <ul
          role="listbox"
          className={cx(popover, "absolute inset-x-0 top-full z-30 mt-2 max-h-72 overflow-y-auto rounded-[20px] p-1.5")}
        >
          {results.map((r, i) => (
            <li key={`${r.lat},${r.lon},${i}`}>
              <button
                type="button"
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(r)}
                className={cx("block w-full rounded-[14px] px-3 py-2 text-left", i === active && "bg-black/[0.06] dark:bg-white/10")}
              >
                <span className="block truncate text-[14px] font-medium">{r.name}</span>
                {r.label && <span className={cx("block truncate text-xs", muted)}>{r.label}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Resolve free text to a place (top geocoder match) when nothing was picked. */
export async function resolvePlace(text: string, place: PlanPlace | null): Promise<PlanPlace | null> {
  if (place) return place;
  const q = text.trim();
  if (!q) return null;
  const { results } = await api.geocode(q);
  const r = results[0];
  return r ? { name: r.name, lat: r.lat, lon: r.lon } : null;
}
