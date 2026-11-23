import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { statePath } from "@/lib/configDir";
import { authenticatedOwner, teamActor } from "@/lib/team/actor";
import { ExternalRelayError } from "./errors";
import { revokeOwnerRuns } from "./ownerRun";
import { updateRelayStoreAsync, type PairedRelay, type RelayTargetSettings } from "./store";
import { canonicalRelayProject, earlierSwitchEntry, requesterSettingsSchema, type TrustedRequesterEntry } from "./trustedRequesters";

type EntryActor = { surface: "board" | "mcp"; approvedBy: string };
export const trustedRequesterAuditFile = () => statePath("external-relay", "trusted-requesters-audit.jsonl");

/** Called under the relay-store write lock, before its atomic replacement. */
export async function materializeEarlierSwitch(relay: PairedRelay, target: RelayTargetSettings, actor: EntryActor): Promise<RelayTargetSettings> {
  const entry = earlierSwitchEntry(relay, target);
  if (!entry) return target;
  const file = trustedRequesterAuditFile();
  const row = {
    time: new Date().toISOString(), action: "earlier-switch", relay: relay.id, target: target.id,
    project: entry.project, entryId: entry.id, label: entry.label, ...actor, revisionBefore: 0, revisionAfter: 1,
  };
  // An interrupted store replacement may leave the audit row ahead of the
  // grant. Retrying the same materialisation reuses the durable row.
  let audited = false;
  let partialTail: number | null = null;
  try {
    const prior = await fs.readFile(file);
    const end = prior.lastIndexOf(10) + 1;
    if (end !== prior.length) partialTail = end;
    audited = prior.subarray(0, end).toString("utf8").trim().split("\n").some(line => {
      if (!line) return false;
      const saved = JSON.parse(line) as Partial<typeof row>;
      return saved.action === row.action && saved.relay === row.relay && saved.target === row.target
        && saved.entryId === row.entryId && saved.project === row.project;
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const handle = await fs.open(file, "a", 0o600);
  try {
    if (partialTail !== null) await handle.truncate(partialTail);
    if (!audited) await handle.appendFile(JSON.stringify(row) + "\n");
    await handle.sync();
  } finally { await handle.close(); }
  const { ownerTier: _ownerTier, ...settings } = target;
  return { ...settings, requesters: { revision: 1, entries: [entry] } };
}

async function writeEntries(relayId: string, targetId: string, expectedRevision: number,
  change: (relay: PairedRelay, target: RelayTargetSettings, entries: readonly TrustedRequesterEntry[]) => {
    entries: TrustedRequesterEntry[]; actor: EntryActor;
  },
): Promise<void> {
  await updateRelayStoreAsync(async store => {
    const relay = store.relays.find(item => item.id === relayId);
    const target = relay?.targets.find(item => item.id === targetId);
    if (!relay || !target) throw new ExternalRelayError("not_found", 404);
    const previous = target.requesters;
    if ((previous?.revision ?? 0) !== expectedRevision) throw new ExternalRelayError("stale_revision", 409);
    const legacy = earlierSwitchEntry(relay, target);
    const { entries, actor } = change(relay, target, previous?.entries ?? (legacy ? [legacy] : []));
    const requesters = requesterSettingsSchema.safeParse({ revision: expectedRevision + 1, entries });
    if (!requesters.success) throw new ExternalRelayError("invalid_requesters", 400);
    const materialized = await materializeEarlierSwitch(relay, target, actor);
    const updated = { ...materialized, requesters: requesters.data };
    return { ...store, relays: store.relays.map(item => item === relay
      ? { ...relay, targets: relay.targets.map(item => item === target ? updated : item) } : item) };
  });
  await revokeOwnerRuns(relayId);
}

/** The management surface provides confirmed, owner-authorized input. */
export function addTrustedRequester(relayId: string, targetId: string, revision: number,
  input: { key: string; label: string }, actor: EntryActor): Promise<void> {
  return writeEntries(relayId, targetId, revision, (_relay, target, entries) => {
    const project = canonicalRelayProject(target.project);
    if (!project) throw new ExternalRelayError("project_required", 400);
    return { actor, entries: [...entries, { id: randomUUID(), kind: "requester", key: input.key, project,
      label: input.label, addedAt: new Date().toISOString(), source: actor.surface }] };
  });
}

export function addPairedOwnerRequester(req: NextRequest, relayId: string, targetId: string, revision: number): Promise<void> {
  return writeEntries(relayId, targetId, revision, (relay, target, entries) => {
    const actor = teamActor(req);
    if (actor.kind !== "member" || relay.owner.namespace !== "telegram" || !authenticatedOwner(req, relay.owner.id))
      throw new ExternalRelayError("owner_required", 403);
    const project = canonicalRelayProject(target.project);
    if (!project) throw new ExternalRelayError("project_required", 400);
    return { actor: { surface: "board", approvedBy: actor.memberId }, entries: [...entries, {
      id: randomUUID(), kind: "paired-owner", project, label: "Paired owner", addedAt: new Date().toISOString(), source: "board",
    }] };
  });
}

/** A confirmed removal invalidates the old id before stopping its runs. */
export function removeTrustedRequester(relayId: string, targetId: string, revision: number, entryId: string, actor: EntryActor): Promise<void> {
  return writeEntries(relayId, targetId, revision, (_relay, _target, entries) => {
    if (!entries.some(entry => entry.id === entryId)) throw new ExternalRelayError("not_found", 404);
    return { actor, entries: entries.filter(entry => entry.id !== entryId) };
  });
}
