"use client";

import { BadgeCheck, Bot, Brush, DraftingCompass, Hammer, Radar, Rocket, ScanEye, Waypoints, type LucideIcon } from "lucide-react";

import { useLocale, type TFunction } from "@/lib/i18n";
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
export function frameRoleName(t: TFunction, role: FrameRole): string {
  return role === "neutral" ? t("roleFrame.neutral") : roleNameById(t, role);
}

export function useFrameRoleName(role: FrameRole): string {
  const { t } = useLocale();
  return frameRoleName(t, role);
}

/** The role's emblem alone, for a surface that names the role elsewhere. */
export function RoleEmblem({ role, strokeWidth = 2.25 }: { role: FrameRole; strokeWidth?: number }) {
  const Emblem = EMBLEM[role];
  return <Emblem strokeWidth={strokeWidth} aria-hidden />;
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
  return (
    <span className="role-mark" data-role-mark={role} title={t("roleFrame.markTitle", { role: name })}>
      <span className="role-mark-emblem" aria-hidden>
        <RoleEmblem role={role} />
      </span>
      <span className="role-mark-word">{name}</span>
    </span>
  );
}

/**
 * The role on a list row (the needs-you panel, the phone's Needs-you sheet):
 * the emblem tile the open-agents rail draws and the role's name in the role's
 * ink, from the one palette `src/styles/roleFrames.css` keeps. On a row the
 * role is content, so it is drawn under every frame variant and with none.
 */
export function RoleTag({ role, compact = false }: { role: FrameRole; compact?: boolean }) {
  const name = useFrameRoleName(role);
  return (
    <span className="role-tag" data-role={role} data-role-tag={role} title={name}>
      <span className="role-tag-emblem" aria-hidden>
        <RoleEmblem role={role} />
      </span>
      {compact ? null : <span className="role-tag-word">{name}</span>}
    </span>
  );
}
