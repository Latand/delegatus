import { configFilePath } from "@/lib/configDir";
import { readKey } from "@/lib/keys/store";
import { resolveService } from "@/lib/openaiServices/policy";
import { readAsksYouSettings } from "./settings";
import { currentSpend, readOperatorAsks } from "./store";
import type { AsksYouSettingView } from "./types";

/** What the setting row draws. Never the key. */
export function asksYouSettingView(now = new Date()): AsksYouSettingView {
  const settings = readAsksYouSettings();
  const spend = currentSpend(readOperatorAsks(undefined, now), now);
  const resolution = resolveService("asks");
  const key = readKey(resolution.effective);
  return {
    enabled: settings.enabled,
    provider: resolution.effective,
    keySource: key.value ? (key.source === "env" ? "env" : "file") : null,
    keyPath: configFilePath(resolution.effective + "-api-key"),
    month: spend.month,
    spentUsd: spend.usd,
    capUsd: settings.capUsd,
    calls: spend.calls,
    capped: spend.capped,
  };
}
