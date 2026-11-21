import fs from "node:fs";
import { z } from "zod";
import { canonicalProject } from "@/lib/projects/aliases";
import { existingTeamStore, teamStoreFile } from "@/lib/team/store";
import type { PairedRelay, RelayTargetSettings } from "./store";

const entryId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const entryProject = z.string().min(1).max(256);
const requesterKeySchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const requesterLabelSchema = z.string().trim().min(1).max(128).regex(/^[^\x00-\x1f\x7f]*$/);
const shared = {
  id: entryId,
  label: requesterLabelSchema,
  addedAt: z.iso.datetime({ offset: true }),
};
const pairedEntry = z.strictObject({ ...shared, kind: z.literal("paired-owner"),
  project: entryProject.nullable(), source: z.enum(["board", "mcp", "earlier-switch"]) })
  .refine(entry => entry.project !== null || entry.source === "earlier-switch");
const requesterEntry = z.strictObject({ ...shared, kind: z.literal("requester"), key: requesterKeySchema,
  project: entryProject, source: z.enum(["board", "mcp"]) });
const entries = z.discriminatedUnion("kind", [pairedEntry, requesterEntry]);
export const requesterSettingsSchema = z.strictObject({ revision: z.number().int().min(1),
  entries: z.array(entries).max(50) }).refine(({ entries }) =>
  new Set(entries.map(entry => entry.id)).size === entries.length
  && new Set(entries.map(entry => entry.label)).size === entries.length);
export type TrustedRequesterEntry = z.infer<typeof entries>;
export type TrustedRequesterSettings = z.infer<typeof requesterSettingsSchema>;
export type RelayRunEntry = Pick<TrustedRequesterEntry, "id" | "kind" | "project" | "label"> & { tier: "owner" | "requester" };

export const canonicalRelayProject = (project: string | null) => project ? canonicalProject(project) : null;

type RelayOwner = Pick<PairedRelay, "owner">;
function telegramOwner(relay: RelayOwner): string | null {
  const { id, namespace } = relay.owner;
  return namespace === "telegram" && /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id)) ? id : null;
}

/** Open only an existing team store. Requery its owner even with a cached handle. */
export function machineTelegramOwner(relays: readonly RelayOwner[]): string | null {
  try {
    const store = existingTeamStore();
    if (store) {
      const owner = store.owner();
      if (!owner || owner.status !== "active") return null;
      if (owner.telegram) return owner.telegram.userId;
    } else if (fs.statSync(teamStoreFile(), { throwIfNoEntry: false })) {
      return null;
    }
    const first = relays[0] ? telegramOwner(relays[0]) : null;
    return first && relays.every(relay => telegramOwner(relay) === first) ? first : null;
  } catch { return null; }
}

export function legacyRequesterId(targetId: string): string {
  return `earlier-switch-${targetId}`;
}

export function earlierSwitchEntry(relay: Pick<PairedRelay, "pairedAt">, target: RelayTargetSettings): TrustedRequesterEntry | null {
  if (target.ownerTier !== true || target.requesters !== undefined) return null;
  return { id: legacyRequesterId(target.id), kind: "paired-owner", project: canonicalRelayProject(target.project),
    label: "Paired owner", addedAt: relay.pairedAt, source: "earlier-switch" };
}

export function requesterEntries(relay: Pick<PairedRelay, "pairedAt">, target: RelayTargetSettings): readonly TrustedRequesterEntry[] {
  if (target.requesters !== undefined) {
    const checked = requesterSettingsSchema.safeParse(target.requesters);
    return checked.success ? checked.data.entries : [];
  }
  const legacy = earlierSwitchEntry(relay, target);
  return legacy ? [legacy] : [];
}

export function bindRequesterEntry(relay: Pick<PairedRelay, "owner" | "name">, entry: TrustedRequesterEntry, relays: readonly RelayOwner[]): RelayRunEntry {
  const paired = entry.kind === "paired-owner";
  const tier = paired ? pairedOwnerTier(relay, relays) : "requester";
  return { id: entry.id, kind: entry.kind, tier, project: entry.project,
    label: paired && tier === "requester" && entry.source === "earlier-switch" ? `Owner of pairing ${relay.name}` : entry.label };
}

export function pairedOwnerTier(relay: RelayOwner, relays: readonly RelayOwner[]): RelayRunEntry["tier"] {
  const id = telegramOwner(relay);
  return id !== null && id === machineTelegramOwner(relays) ? "owner" : "requester";
}
