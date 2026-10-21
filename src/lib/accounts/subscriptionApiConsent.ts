import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { statePath } from "@/lib/configDir";
import { writeJsonDurably } from "@/lib/state/durableJson";

type Consent = { version: 1; enabled: boolean; source: "default" | "migration" | "operator" };
const consentFile = () => statePath("subscription-api-consent.json");
const disabled: Consent = { version: 1, enabled: false, source: "default" };

/** Only the old Claude parser's successful usage readings prove prior direct
 * use. A new CLI reading can never opt an installation into direct calls. */
function previouslyUsedDirectUsage(): boolean {
  try {
    const file = statePath("limits-cache.json");
    if (fs.statSync(file).size > 2 * 1024 * 1024) return false;
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    const windowPresent = (value: unknown): boolean => Boolean(value && typeof value === "object" && "usedPercent" in value && typeof value.usedPercent === "number" && Number.isFinite(value.usedPercent) && value.usedPercent >= 0);
    if (saved.version === 2) return Object.values(saved.engines?.claude ?? {}).some(value => {
      const entry = value as { parser?: number; data?: { session?: unknown; weekly?: unknown }; provenance?: { source?: string } };
      return (entry.parser === undefined || entry.parser <= 2) && (windowPresent(entry.data?.session) || windowPresent(entry.data?.weekly))
        && ["live", "cache"].includes(entry.provenance?.source ?? "");
    });
    return windowPresent(saved.data?.claude?.session) || windowPresent(saved.data?.claude?.weekly);
  } catch { return false; }
}

/** No process cache: revocation in another Viewer generation takes effect at
 * the next dispatch. A malformed or unreadable consent always fails closed. */
export function subscriptionApiConsent(): Consent {
  const file = consentFile();
  try {
    if (fs.statSync(file).size > 1024) return { ...disabled };
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value?.version === 1 && typeof value.enabled === "boolean" && ["default", "migration", "operator"].includes(value.source)
      ? { version: 1, enabled: value.enabled, source: value.source } : { ...disabled };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { ...disabled };
  }
  const initial: Consent = { version: 1, enabled: previouslyUsedDirectUsage(), source: "default" };
  if (initial.enabled) initial.source = "migration";
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeJsonDurably(temporary, initial);
    try { fs.linkSync(temporary, file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } finally { fs.rmSync(temporary, { force: true }); }
  // An explicit choice that won the exclusive creation must be respected.
  return subscriptionApiConsent();
}

export function setSubscriptionApiConsent(enabled: boolean): Consent {
  const next: Consent = { version: 1, enabled, source: "operator" };
  writeJsonDurably(consentFile(), next);
  return next;
}
