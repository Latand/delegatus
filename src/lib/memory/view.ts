import { openRouterKeySource, readAsksYouSettings } from "@/lib/asks/settings";
import { currentSpend, loadOperatorAsks } from "@/lib/asks/store";
import { viewerReleaseOwnsTraffic } from "@/lib/viewerInstrumentation";
import { isStagingMode } from "@/lib/staging";
import { sharedMemoryEnabled } from "./settings";
import { memoryIndex } from "./service";
import type { MemorySettingView } from "./viewTypes";

export function memorySettingView(project: string, now = new Date()): MemorySettingView {
  const enabled = sharedMemoryEnabled(project);
  const keySource = openRouterKeySource();
  const capUsd = readAsksYouSettings().capUsd;
  const spend = currentSpend(loadOperatorAsks(undefined, now), now);
  const ownsTraffic = viewerReleaseOwnsTraffic();
  // A decision reserves at least one cent before making a provider call.
  const reasons: MemorySettingView["reasons"] = [];
  if (!enabled) reasons.push("projectOff");
  if (!keySource) reasons.push("noKey");
  if (spend.usd + .01 > capUsd) reasons.push("capped");
  if (!ownsTraffic) reasons.push("notOwner");
  return { enabled, reasons, keySource, ...(isStagingMode() ? { staging: true } : {}), capUsd, spentUsd: spend.usd, month: spend.month,
    counts: memoryIndex().injectionActivity(now) };
}
