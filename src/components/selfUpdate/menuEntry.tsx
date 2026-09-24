"use client";

import { CircleArrowUp } from "lucide-react";

import type { MobileMenuEntry } from "@/components/mobile/MobileMenuSheet";
import type { TFunction } from "@/lib/i18n";

import { openSelfUpdate } from "./openSelfUpdate";

/** The phone's "Update" row (#2007), beside the setup guide's rows in the
    board menus; the desktop rail menu renders the same row itself. */
export function selfUpdateMobileMenuEntry(t: TFunction, closeSheet: () => void): MobileMenuEntry {
  return { kind: "row", key: "self-update", icon: <CircleArrowUp className="h-[18px] w-[18px]" aria-hidden />, label: t("selfUpdate.menu"), testId: "menu-self-update", onSelect: () => { closeSheet(); openSelfUpdate(); } };
}
