"use client";

import { Activity } from "lucide-react";

import type { MobileMenuEntry } from "@/components/mobile/MobileMenuSheet";
import type { MobileNav } from "@/components/mobile/mobileNav";
import type { TFunction } from "@/lib/i18n";

/** «Activity» in the phone's board menus, the Overview's and a project's:
    your time and your agents' time, per day and per project. The desktop
    rail links the same page. */
export function activityMobileMenuEntry(t: TFunction, nav: MobileNav): MobileMenuEntry {
  return { kind: "row", key: "activity", icon: <Activity className="h-[18px] w-[18px]" aria-hidden />, label: t("activity.menu"), testId: "menu-activity", onSelect: () => nav.leave("/activity") };
}
