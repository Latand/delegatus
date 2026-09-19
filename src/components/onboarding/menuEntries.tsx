"use client";

import { Compass, SlidersHorizontal } from "lucide-react";

import type { MobileMenuEntry } from "@/components/mobile/MobileMenuSheet";
import type { TFunction } from "@/lib/i18n";

import { openOnboarding } from "./useOnboarding";

/** The two re-entry rows (#1876, design §6) for the phone's board menus; the
    desktop rail menu renders the same two as its own rows. */
export function onboardingMobileMenuEntries(t: TFunction, closeSheet: () => void): MobileMenuEntry[] {
  return [
    { kind: "row", key: "setup-guide", icon: <Compass className="h-[18px] w-[18px]" aria-hidden />, label: t("onboarding.menu.guide"), testId: "menu-setup-guide", onSelect: () => { closeSheet(); openOnboarding("guide"); } },
    { kind: "row", key: "agent-mapping", icon: <SlidersHorizontal className="h-[18px] w-[18px]" aria-hidden />, label: t("onboarding.menu.mapping"), testId: "menu-agent-mapping", onSelect: () => { closeSheet(); openOnboarding("mapping"); } },
  ];
}
