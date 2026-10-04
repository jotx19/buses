// Shared Tailwind building blocks: the frosted-glass material, route badges, buttons.
import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { RouteInfo } from "../api";

/** Selected / on state: solid, inverted (white on dark, black on light) — no glow. */
export const selected = "bg-zinc-900 text-white dark:bg-white dark:text-zinc-900";

/** Frosted glass: heavy blur + saturation, translucent fill, hairline border. */
export const glass =
  "border border-white/60 bg-white/40 shadow-[0_24px_60px_-16px_rgba(0,0,0,0.3)] backdrop-blur-3xl backdrop-saturate-200 " +
  "dark:border-white/[0.09] dark:bg-[#1c1c1e]/45 dark:shadow-[0_24px_60px_-12px_rgba(0,0,0,0.7)]";

export const muted = "text-zinc-500 dark:text-white/50";
export const faint = "text-zinc-400 dark:text-white/30";
export const fill = "bg-black/[0.05] dark:bg-white/[0.07]";
export const fillHover = "hover:bg-black/[0.08] dark:hover:bg-white/[0.11]";

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

export function RouteBadge({ route, size = "md" }: { route: RouteInfo | null; size?: "sm" | "md" | "lg" }) {
  const sizes = {
    sm: "h-[22px] min-w-[30px] rounded-md px-1.5 text-xs",
    md: "h-7 min-w-[38px] rounded-lg px-2 text-[13px]",
    lg: "h-12 min-w-[48px] rounded-[14px] px-2.5 text-xl",
  };
  return (
    <span
      className={cx(
        "inline-grid flex-none place-items-center font-bold tabular-nums tracking-tight shadow-[inset_0_0_0_1px_rgba(255,255,255,0.15)]",
        sizes[size],
      )}
      style={route ? { background: route.color, color: route.text_color } : { background: "#8e8e93", color: "#fff" }}
    >
      {route?.short_name ?? "—"}
    </span>
  );
}

export function IconButton({
  label,
  active,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cx(
        "grid size-10 place-items-center rounded-full transition duration-200 ease-out active:scale-90",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500",
        active ? selected : "text-zinc-800 hover:bg-black/[0.06] dark:text-white/90 dark:hover:bg-white/10",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Pill({
  active,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={cx(
        "inline-flex h-10 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-3.5 text-[13px] font-semibold",
        "transition duration-200 ease-out active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500",
        active ? selected : cx(fill, fillHover, "text-zinc-900 dark:text-white"),
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
