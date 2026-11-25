import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { statePath } from "@/lib/configDir";
import { authenticatedOwner, teamActor } from "@/lib/team/actor";
import { ExternalRelayError } from "./errors";
import { revokeOwnerRuns } from "./ownerRun";
import { withRelayStoreLock, type RelayStore, type PairedRelay, type RelayTargetSettings } from "./store";
import { canonicalRelayProject, earlierSwitchEntry, requesterEntries, requesterSettingsSchema, type TrustedRequesterEntry } from "./trustedRequesters";

export type EntryActor = { surface: "board" | "mcp"; approvedBy: string; proposingConversation?: string };
export type RequesterAuditRow = EntryActor & {
  time: string;
  action: "start_enrolment" | "confirm" | "decline" | "remove" | "expired" | "earlier-switch";
  relay: string;
  target: string;
  project: string | null;
  entryId: string;
  label: string;
  revisionBefore: number;
  revisionAfter: number;
};
export const trustedRequesterAuditFile = () => statePath("external-relay", "trusted-requesters-audit.jsonl");

async function auditContents(): Promise<Buffer> {
  try { return await fs.readFile(trustedRequesterAuditFile()); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return Buffer.alloc(0);
  }
}

const auditActions = new Set<string>(["start_enrolment", "confirm", "decline", "remove", "expired", "earlier-switch"]);

function auditRow(line: string): RequesterAuditRow | null {
  let row: unknown;
  try { row = JSON.parse(line); } catch { return null; }
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const saved = row as Record<string, unknown>;
  return typeof saved.time === "string" && typeof saved.action === "string" && auditActions.has(saved.action)
    && typeof saved.relay === "string" && typeof saved.target === "string" && typeof saved.label === "string"
    && (saved.surface === "board" || saved.surface === "mcp") ? row as RequesterAuditRow : null;
}

/** An unreadable line (hand edit, damage) never blocks a later write, above all a removal. */
function auditRows(contents: Buffer) {
  const lines = contents.subarray(0, contents.lastIndexOf(10) + 1).toString("utf8").split("\n").filter(Boolean);
  const rows = lines.flatMap(line => auditRow(line) ?? []);
  if (rows.length !== lines.length) console.warn("Relay requester audit: skipped unreadable rows", { count: lines.length - rows.length });
  return rows;
}

export async function requesterHistory(relay: string, target: string) {
  return auditRows(await auditContents()).filter(row => row.relay === relay && row.target === target).slice(-50).reverse();
}

/** Called under the relay-store lock. Retries reuse an audit row written before an interrupted replacement. */
export async function appendRequesterAudit(row: RequesterAuditRow) {
  const file = trustedRequesterAuditFile();
  const prior = await auditContents();
  const end = prior.lastIndexOf(10) + 1;
  const audited = auditRows(prior).some(saved => saved.action === row.action && saved.relay === row.relay
    && saved.target === row.target && saved.entryId === row.entryId && saved.project === row.project
    && saved.revisionBefore === row.revisionBefore && saved.revisionAfter === row.revisionAfter
    && (row.action === "earlier-switch" || saved.approvedBy === row.approvedBy && saved.surface === row.surface
      && saved.proposingConversation === row.proposingConversation));
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const handle = await fs.open(file, "a", 0o600);
  try {
    if (end !== prior.length) await handle.truncate(end);
    if (!audited) await handle.appendFile(JSON.stringify(row) + "\n");
    await handle.sync();
  } finally { await handle.close(); }
}

export async function materializeEarlierSwitch(relay: PairedRelay, target: RelayTargetSettings, actor: EntryActor): Promise<RelayTargetSettings> {
  const entry = earlierSwitchEntry(relay, target);
  if (!entry) return target;
  await appendRequesterAudit({
    time: new Date().toISOString(), action: "earlier-switch", relay: relay.id, target: target.id,
    project: entry.project, entryId: entry.id, label: entry.label, ...actor, revisionBefore: 0, revisionAfter: 1,
  });
  const { ownerTier: _ownerTier, ...settings } = target;
  return { ...settings, requesters: { revision: 1, entries: [entry] } };
}

export function requesterTarget(store: RelayStore, relayId: string, targetId: string) {
  const relay = store.relays.find(item => item.id === relayId);
  const target = relay?.targets.find(item => item.id === targetId);
  if (!relay || !target) throw new ExternalRelayError("not_found", 404);
  return { relay, target, project: canonicalRelayProject(target.project), revision: target.requesters?.revision ?? 0 };
}

/** The caller holds the store lock and revalidates its authority immediately before replacement. */
export async function writeRequesterEntries(store: RelayStore, replace: (next: RelayStore) => void,
  relay: PairedRelay, target: RelayTargetSettings, entries: readonly TrustedRequesterEntry[],
  entry: TrustedRequesterEntry, action: "confirm" | "remove", actor: EntryActor, authorize: () => void,
) {
  const revision = target.requesters?.revision ?? 0;
  const requesters = requesterSettingsSchema.safeParse({ revision: revision + 1, entries });
  if (!requesters.success) throw new ExternalRelayError("invalid_requesters", 400);
  const materialized = await materializeEarlierSwitch(relay, target, actor);
  authorize();
  await appendRequesterAudit({
    time: new Date().toISOString(), action, relay: relay.id, target: target.id, project: entry.project,
    entryId: entry.id, label: entry.label, ...actor, revisionBefore: revision, revisionAfter: revision + 1,
  });
  authorize();
  replace({ ...store, relays: store.relays.map(item => item === relay
    ? { ...relay, targets: relay.targets.map(item => item === target ? { ...materialized, requesters: requesters.data } : item) } : item) });
}

async function writeEntries(relayId: string, targetId: string, revision: number, action: "confirm" | "remove",
  change: (relay: PairedRelay, target: RelayTargetSettings, entries: readonly TrustedRequesterEntry[]) => {
    entries: TrustedRequesterEntry[]; entry: TrustedRequesterEntry; actor: EntryActor;
  },
  authorize = () => {},
): Promise<void> {
  await withRelayStoreLock(async (store, replace) => {
    const { relay, target, revision: currentRevision } = requesterTarget(store, relayId, targetId);
    if (currentRevision !== revision) throw new ExternalRelayError("stale_revision", 409);
    const next = change(relay, target, requesterEntries(relay, target));
    await writeRequesterEntries(store, replace, relay, target, next.entries, next.entry, action, next.actor, authorize);
  });
  await revokeOwnerRuns(relayId);
}

/** The management surface provides confirmed, owner-authorized input. */
export function addTrustedRequester(relayId: string, targetId: string, revision: number,
  input: { key: string; label: string }, actor: EntryActor): Promise<void> {
  return writeEntries(relayId, targetId, revision, "confirm", (_relay, target, entries) => {
    const project = canonicalRelayProject(target.project);
    if (!project) throw new ExternalRelayError("project_required", 400);
    const entry = { id: randomUUID(), kind: "requester" as const, key: input.key, project,
      label: input.label, addedAt: new Date().toISOString(), source: actor.surface };
    return { actor, entry, entries: [...entries, entry] };
  });
}

export function addPairedOwnerRequester(req: NextRequest, relayId: string, targetId: string, revision: number): Promise<void> {
  return writeEntries(relayId, targetId, revision, "confirm", (relay, target, entries) => {
    const actor = teamActor(req);
    if (actor.kind !== "member" || relay.owner.namespace !== "telegram" || !authenticatedOwner(req, relay.owner.id))
      throw new ExternalRelayError("owner_required", 403);
    const project = canonicalRelayProject(target.project);
    if (!project) throw new ExternalRelayError("project_required", 400);
    const entry = { id: randomUUID(), kind: "paired-owner" as const, project, label: "Paired owner",
      addedAt: new Date().toISOString(), source: "board" as const };
    return { actor: { surface: "board", approvedBy: actor.memberId }, entry, entries: [...entries, entry] };
  });
}

/** A confirmed removal invalidates the old id before stopping its runs. */
export function removeTrustedRequester(relayId: string, targetId: string, revision: number, entryId: string, actor: EntryActor): Promise<void> {
  return writeEntries(relayId, targetId, revision, "remove", (_relay, _target, entries) => {
    const entry = entries.find(entry => entry.id === entryId);
    if (!entry) throw new ExternalRelayError("not_found", 404);
    return { actor, entry, entries: entries.filter(entry => entry.id !== entryId) };
  });
}
