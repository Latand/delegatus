/* What a launch refused for a pending update is told (#2515). Resolves state
   only when a caller reads it (#1905), and imports no liveness code, so the
   admission paths that refuse can load it without the readings behind it. */
import { operatorLocale } from "@/lib/operator/settings";
import { translate, type Locale, type MessageKey } from "@/lib/i18n/core";
import { statePath } from "@/lib/configDir";

import { readAuto } from "./auto";
import type { DrainLease } from "./drain";
import type { BusyReason, QuietBlockers } from "./quiet";

const BUSY_WORDS: Record<BusyReason, MessageKey> = {
  "update": "selfUpdate.launchHold.busy.update",
  "web": "selfUpdate.launchHold.busy.web",
  "runtime-host": "selfUpdate.launchHold.busy.runtime-host",
  "pipeline-controller": "selfUpdate.launchHold.busy.pipeline-controller",
  "seat-tick": "selfUpdate.launchHold.busy.seat-tick",
};

/**
 * What a pending update is waiting for, in plain words. A refused launch used
 * to say only that work was draining, which reads the same whether two turns
 * are running or ninety rows of dead hosts are being counted.
 */
export function describeUpdateWait(blockers: QuietBlockers | null | undefined, locale: Locale = "en"): string {
  const t = (key: MessageKey, params?: Record<string, string | number>) => translate(locale, key, params);
  if (!blockers) return t("selfUpdate.launchHold.firstRead");
  const work = [
    ...(blockers.turns ? [t("selfUpdate.launchHold.turns", { count: blockers.turns })] : []),
    ...(blockers.stages ? [t("selfUpdate.launchHold.stages", { count: blockers.stages })] : []),
  ];
  const held = blockers.unresolvedBlocking ?? 0;
  const unresolved = held ? t("selfUpdate.launchHold.unresolved", { count: held, minutes: Math.round((blockers.unresolvedGraceMs ?? 0) / 60_000) }) : "";
  if (work.length) return t("selfUpdate.launchHold.work", { work: work.join(t("selfUpdate.launchHold.join")), unresolved });
  const other = [
    ...(blockers.busyReason ? [t(BUSY_WORDS[blockers.busyReason])] : blockers.busy ? [t("selfUpdate.launchHold.busyOther")] : []),
    ...(blockers.operatorActiveAt ? [t("selfUpdate.launchHold.operator", { minutes: Math.round((blockers.operatorWindowMs ?? 0) / 60_000) })] : []),
    ...(blockers.memoryMb !== null ? [t("selfUpdate.launchHold.memory", { available: blockers.memoryMb })] : []),
    ...(blockers.unreadable ? [t("selfUpdate.launchHold.unreadable", { reason: blockers.unreadable })] : []),
  ];
  return other.length ? t("selfUpdate.launchHold.noLiveWork", { wait: other.join(t("selfUpdate.launchHold.join")) }) : t("selfUpdate.launchHold.quietMinute");
}

/** The blockers the pending update last recorded, and the wait they name. */
export function updateHoldWait(
  blockers: QuietBlockers | null = readAuto(statePath("self-update", "auto.json")).lastBlockers,
): { error: string; waitingFor: string; blockers: QuietBlockers | null } {
  const locale = operatorLocale() ?? "en";
  const waitingFor = describeUpdateWait(blockers, locale);
  return { error: translate(locale, "selfUpdate.launchHold.error", { waitingFor }), waitingFor, blockers };
}

export interface LaunchHoldRefusal {
  error: string;
  code: "launch_held_for_update";
  target: string;
  since: string;
  /** The same wait as `error`, without the sentence around it. */
  waitingFor: string;
  blockers: QuietBlockers | null;
}

/** The refusal an autonomous launch gets while an update holds admission. */
export function launchHoldRefusal(hold: Pick<DrainLease, "target" | "since">, blockers?: QuietBlockers | null): LaunchHoldRefusal {
  const wait = blockers === undefined ? updateHoldWait() : updateHoldWait(blockers);
  return {
    code: "launch_held_for_update", target: hold.target, since: hold.since, ...wait,
  };
}
