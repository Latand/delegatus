import { openRouterKeyPath, openRouterKeySource, readAsksYouSettings } from "./settings";
import { currentSpend, readOperatorAsks } from "./store";
import type { AsksYouSettingView } from "./types";

/** What the setting row draws. Never the key. */
export function asksYouSettingView(now = new Date()): AsksYouSettingView {
  const settings = readAsksYouSettings();
  const spend = currentSpend(readOperatorAsks(undefined, now), now);
  return {
    enabled: settings.enabled,
    keySource: openRouterKeySource(),
    keyPath: openRouterKeyPath(),
    month: spend.month,
    spentUsd: spend.usd,
    capUsd: settings.capUsd,
    calls: spend.calls,
    capped: spend.capped,
  };
}
