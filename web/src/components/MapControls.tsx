import { useEffect, useState } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import type { Theme } from "../map/scene";
import { IconCompass, IconHome, IconLocate, IconMinus, IconMoon, IconMountain, IconPlus, IconSun } from "./Icons";
import { IconButton, cx, glass } from "./ui";

interface Props {
  map: MapLibreMap | null;
  theme: Theme;
  terrain: boolean;
  locating: boolean;
  hasUser: boolean;
  hasHome: boolean;
  hidden: boolean;
  onTheme: () => void;
  onTerrain: () => void;
  onLocate: () => void;
  onHome: () => void;
}

const group = cx(glass, "flex flex-col rounded-full p-1");

export function MapControls({ map, theme, terrain, locating, hasUser, hasHome, hidden, onTheme, onTerrain, onLocate, onHome }: Props) {
  const [view, setView] = useState({ bearing: 0, pitch: 0 });

  // Subscribe here (not in App) so camera motion only re-renders this component.
  useEffect(() => {
    if (!map) return;
    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setView({ bearing: map.getBearing(), pitch: map.getPitch() }));
    };
    map.on("rotate", update);
    map.on("pitch", update);
    update();
    return () => {
      cancelAnimationFrame(raf);
      map.off("rotate", update);
      map.off("pitch", update);
    };
  }, [map]);

  const is3D = view.pitch > 8;

  return (
    <div
      className={cx(
        "absolute right-4 top-4 z-10 flex flex-col gap-2.5 transition-opacity max-md:right-2 max-md:top-[max(0.5rem,env(safe-area-inset-top))]",
        hidden && "max-md:pointer-events-none max-md:opacity-0",
      )}
    >
      <div className={group}>
        <IconButton label="Zoom in" onClick={() => map?.zoomIn()}>
          <IconPlus />
        </IconButton>
        <IconButton label="Zoom out" onClick={() => map?.zoomOut()}>
          <IconMinus />
        </IconButton>
      </div>

      <div className={group}>
        <IconButton label="Reset to north" onClick={() => map?.easeTo({ bearing: 0, duration: 700 })}>
          <span className="grid place-items-center transition-transform duration-100" style={{ transform: `rotate(${-view.bearing}deg)` }}>
            <IconCompass />
          </span>
        </IconButton>
        <IconButton
          label={is3D ? "Switch to 2D" : "Switch to 3D"}
          onClick={() => map?.easeTo({ pitch: is3D ? 0 : 60, duration: 900 })}
          className="text-[13px] font-semibold"
        >
          {is3D ? "2D" : "3D"}
        </IconButton>
        <IconButton label="Terrain" active={terrain} aria-pressed={terrain} onClick={onTerrain}>
          <IconMountain />
        </IconButton>
        <IconButton label={theme === "dark" ? "Daylight map" : "Night map"} onClick={onTheme}>
          {theme === "dark" ? <IconSun /> : <IconMoon />}
        </IconButton>
      </div>

      <div className={group}>
        {hasHome && (
          <IconButton label="Home location" onClick={onHome}>
            <IconHome />
          </IconButton>
        )}
        <IconButton label="My location" active={hasUser} onClick={onLocate} className={locating ? "[&_svg]:animate-spin" : undefined}>
          <IconLocate />
        </IconButton>
      </div>
    </div>
  );
}
