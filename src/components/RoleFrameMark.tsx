"use client";

import { BadgeCheck, Bot, Brush, DraftingCompass, Hammer, Radar, Rocket, ScanEye, Waypoints, type LucideIcon } from "lucide-react";

import { useLocale } from "@/lib/i18n";
import type { FrameRole } from "@/lib/roleFrames";

import { roleNameById } from "./builderCopy";

const EMBLEM: Record<FrameRole, LucideIcon> = {
  orchestrator: Waypoints,
  architect: DraftingCompass,
  builder: Hammer,
  reviewer: ScanEye,
  verifier: BadgeCheck,
  cleaner: Brush,
  "prod-auditor": Radar,
  deployer: Rocket,
  neutral: Bot,
};

/** The role's name as the role registry's copy has it; `neutral` reads «Agent». */
export function useFrameRoleName(role: FrameRole): string {
  const { t } = useLocale();
  return role === "neutral" ? t("roleFrame.neutral") : roleNameById(t, role);
}

/**
 * The role mark a framed conversation carries in its header: an emblem and the
 * role's name. The markup is the same under every variant;
 * `src/styles/roleFrames.css` draws it as the rail's emblem tile, the ribbon's
 * label, the halo's chip or the bracket's dog-ear — and hides it when no
 * variant is chosen, so today's header is unchanged.
 */
export function RoleFrameMark({ role }: { role: FrameRole }) {
  const { t } = useLocale();
  const name = useFrameRoleName(role);
  const Emblem = EMBLEM[role];
  return (
    <span className="role-mark" data-role-mark={role} title={t("roleFrame.markTitle", { role: name })}>
      <span className="role-mark-emblem" aria-hidden>
        <Emblem strokeWidth={2.25} />
      </span>
      <span className="role-mark-word">{name}</span>
    </span>
  );
}
