"use client";

import { Compass, Mic, Route, SlidersHorizontal } from "lucide-react";

import type { MobileMenuEntry } from "@/components/mobile/MobileMenuSheet";
import type { TFunction } from "@/lib/i18n";

import { openOnboarding } from "./useOnboarding";
import { startInterfaceWalk } from "./walkStop";

/** The re-entry rows (#1876, design §6; the interface walk, #2166 §3.9) for
    the phone's board menus; the desktop rail menu renders the same rows. */
export function onboardingMobileMenuEntries(t: TFunction, closeSheet: () => void): MobileMenuEntry[] {
  return [
    { kind: "row", key: "setup-guide", icon: <Compass className="h-[18px] w-[18px]" aria-hidden />, label: t("onboarding.menu.guide"), testId: "menu-setup-guide", onSelect: () => { closeSheet(); openOnboarding("guide"); } },
    { kind: "row", key: "interface-walk", icon: <Route className="h-[18px] w-[18px]" aria-hidden />, label: t("onboarding.menu.walk"), testId: "menu-interface-walk", onSelect: () => { closeSheet(); startInterfaceWalk(); } },
    { kind: "row", key: "agent-mapping", icon: <SlidersHorizontal className="h-[18px] w-[18px]" aria-hidden />, label: t("onboarding.menu.mapping"), testId: "menu-agent-mapping", onSelect: () => { closeSheet(); openOnboarding("mapping"); } },
    { kind: "row", key: "dictation", icon: <Mic className="h-[18px] w-[18px]" aria-hidden />, label: t("onboarding.menu.voice"), testId: "menu-dictation", onSelect: () => { closeSheet(); openOnboarding("voice"); } },
  ];
}
