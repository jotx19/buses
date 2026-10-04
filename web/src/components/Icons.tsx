// Hugeicons (free stroke set), wrapped so every icon shares one size and weight.
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  Add01Icon,
  ArrowLeft01Icon,
  ArrowDataTransferVerticalIcon,
  ArrowDown01Icon,
  ArrowUp01Icon,
  VolumeHighIcon,
  ThreeDViewIcon,
  Flag02Icon,
  WalkingIcon,
  ArrowRight01Icon,
  Cancel01Icon,
  Compass01Icon,
  Home01Icon,
  Location01Icon,
  Location06Icon,
  Moon02Icon,
  MountainIcon,
  Navigation03Icon,
  Remove01Icon,
  Route01Icon,
  Search01Icon,
  Sun03Icon,
  Tick02Icon,
  Video01Icon,
} from "@hugeicons/core-free-icons";

function icon(svg: IconSvgElement, size = 19) {
  return function Icon() {
    return <HugeiconsIcon icon={svg} size={size} strokeWidth={1.6} aria-hidden="true" />;
  };
}

export const IconPlus = icon(Add01Icon);
export const IconMinus = icon(Remove01Icon);
export const IconClose = icon(Cancel01Icon, 17);
export const IconSearch = icon(Search01Icon, 17);
export const IconBack = icon(ArrowLeft01Icon);
export const IconLocate = icon(Location06Icon);
export const IconHome = icon(Home01Icon);
export const IconMountain = icon(MountainIcon);
export const IconSun = icon(Sun03Icon);
export const IconMoon = icon(Moon02Icon);
export const IconFollow = icon(Navigation03Icon, 16);
export const IconRoute = icon(Route01Icon, 16);
export const IconCamera = icon(Video01Icon, 16);
export const IconCompass = icon(Compass01Icon, 20);
export const IconStop = icon(Location01Icon, 20);
export const IconCheck = icon(Tick02Icon, 16);
export const IconWalk = icon(WalkingIcon, 16);
export const IconFlag = icon(Flag02Icon, 16);
export const IconChevron = icon(ArrowRight01Icon, 14);
export const IconCollapse = icon(ArrowDown01Icon, 18);
export const IconExpand = icon(ArrowUp01Icon, 18);
export const IconSwap = icon(ArrowDataTransferVerticalIcon, 18);
export const IconSpeak = icon(VolumeHighIcon, 18);
export const IconMap = icon(ThreeDViewIcon, 18);
