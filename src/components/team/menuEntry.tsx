"use client";

import { Users } from "lucide-react";

import type { MobileMenuEntry } from "@/components/mobile/MobileMenuSheet";
import type { MobileNav } from "@/components/mobile/mobileNav";
import type { TFunction } from "@/lib/i18n";

/** «Team» in the phone's board menus, beside «Activity» (sign-in-and-team
    §6.9): members, who did what and sessions, or on a solo install the card
    that sets up a team. The desktop rail menu links the same page. */
export function teamMobileMenuEntry(t: TFunction, nav: MobileNav): MobileMenuEntry {
  return { kind: "row", key: "team", icon: <Users className="h-[18px] w-[18px]" aria-hidden />, label: t("team.menu"), testId: "menu-team", onSelect: () => nav.leave("/team") };
}
