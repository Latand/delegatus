import { createHash, randomBytes, randomUUID } from "node:crypto";
import { sessionIsLive } from "@/lib/team/sessions";
import { existingTeamStore } from "@/lib/team/store";
import { ExternalRelayError } from "./errors";
import { requesterTrigger, type ExternalRelayRequest } from "./protocol";
import { revokeOwnerRuns } from "./ownerRun";
import { selectOwnerDestination } from "./ownerDestination";
import { readRelayStore, withRelayStoreLock, type PairedRelay, type RelayStore } from "./store";
import { bindRequesterEntry, canonicalRelayProject, requesterEntries, type TrustedRequesterEntry } from "./trustedRequesters";
import { appendRequesterAudit, requesterHistory, requesterTarget, writeRequesterEntries, type EntryActor } from "./trustedRequesterStore";
import { redactRequesterCodeText, requesterCodeWord, type RequesterMcpInput, type RequesterOperation, type RequesterView } from "./requesterEnrolmentContract";

const VALID_MS = 10 * 60_000;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const received = "Code received. The owner will confirm.";
const refused = "This code was already used; ask the owner for a new one.";

type Location = { relay: string; target: string };
type Approval = { approvedBy: string; session: string; canStart: boolean };
type Authorize = (store: RelayStore) => Approval;
type Candidate = { key: string; name: string; chat: string; chatTitle: string | null; at: string; message: string };
type Pending = Location & {
  id: string; project: string; credential: string; revision: number; label: string;
  session: string; codeDigest: string; expires: number; actor: EntryActor;
  candidate?: Candidate; contested?: true; auditedExpiry?: true; timer?: ReturnType<typeof setTimeout>;
};
type Proposal = {
  operation: RequesterOperation; revision: number; project: string | null;
  credential: string; conversation: string; expires: number;
};
const globalState = globalThis as typeof globalThis & {
  __llvRequesterEnrolment?: { pending: Map<string, Pending>; proposals: Map<string, Proposal> };
};
const { pending, proposals } = globalState.__llvRequesterEnrolment ??= { pending: new Map(), proposals: new Map() };
const scopeKey = ({ relay, target }: Location) => JSON.stringify([relay, target]);
const current = (store: RelayStore, scope: Location) => requesterTarget(store, scope.relay, scope.target);
const problem = (code: string, status = 409) => new ExternalRelayError(code, status);

function pendingFor(scope: Location, relay: PairedRelay) {
  const key = scopeKey(scope);
  const item = pending.get(key);
  if (item && item.credential !== relay.credential) {
    clearTimeout(item.timer);
    pending.delete(key);
    return undefined;
  }
  return item;
}

function pendingStatus(item: Pending, now: number, project: string | null, revision: number): NonNullable<RequesterView["pending"]>["status"] {
  if (now >= item.expires) return "expired";
  if (item.project !== project || item.revision !== revision) return "stale";
  if (item.contested) return "contested";
  return item.candidate ? "candidate" : "waiting";
}

export async function trustedRequesterView(scope: Location, authorize: Authorize, { management = true, includeHistory = true } = {}): Promise<RequesterView> {
  const store = readRelayStore();
  authorize(store);
  const history = includeHistory ? await requesterHistory(scope.relay, scope.target) : [];
  const fresh = readRelayStore();
  const approval = authorize(fresh);
  const { relay, target, project, revision } = current(fresh, scope);
  const item = pendingFor(scope, relay);
  const now = Date.now();
  const visible = !!item && (!management || item.session === approval.session || now >= item.expires);
  return {
    relay: scope.relay, target: scope.target, targetName: target.name, project, revision, canStart: approval.canStart,
    entries: requesterEntries(relay, target).map(entry => {
      const binding = bindRequesterEntry(relay, entry, fresh.relays);
      return { ...binding, addedAt: entry.addedAt, active: canonicalRelayProject(entry.project) === project };
    }),
    pending: item && visible ? {
      id: item.id, label: item.label, expiresAt: new Date(item.expires).toISOString(),
      status: pendingStatus(item, now, project, revision),
      candidate: item.candidate ? { name: item.candidate.name, at: item.candidate.at, chatTitle: item.candidate.chatTitle } : null,
    } : null,
    // Another owner session holds the one enrolment for this target: say so
    // without its id, label or candidate, so the form is not offered.
    otherSession: item && !visible ? { expiresAt: new Date(item.expires).toISOString() } : null,
    history: history.map(({ time, action, label, approvedBy, surface }) => ({ time, action, label, approvedBy, surface })),
  };
}

async function auditPending(item: Pending, action: "start_enrolment" | "decline" | "expired", actor: EntryActor, revision: number) {
  await appendRequesterAudit({
    time: new Date().toISOString(), action, relay: item.relay, target: item.target, project: item.project,
    entryId: item.id, label: item.label, ...actor, revisionBefore: revision, revisionAfter: revision,
  });
}

async function expire(item: Pending) {
  if (Date.now() < item.expires || item.auditedExpiry) return;
  await auditPending(item, "expired", item.actor, item.revision);
  item.auditedExpiry = true;
}

function scheduleExpiry(item: Pending, retry = 0) {
  const key = scopeKey(item);
  item.timer = setTimeout(() => {
    void withRelayStoreLock(async () => {
      if (pending.get(key) === item) await expire(item);
    }).catch(() => {
      if (pending.get(key) !== item) return;
      if (retry < 2) scheduleExpiry(item, retry + 1);
      else console.error("Relay requester enrolment expiry audit unavailable");
    });
  }, Math.max(1, item.expires - Date.now(), retry * 5000));
  item.timer.unref();
}

function checkedOperation(input: RequesterOperation, view: ReturnType<typeof current>, approval: Approval, now: number, proposal = false) {
  const item = pendingFor(input, view.relay);
  if (input.action === "start_enrolment") {
    if (!approval.canStart) throw problem("owner_required", 403);
    if (!view.project) throw problem("project_required", 400);
    if (item) throw problem("enrolment_pending");
    if (pending.size >= 256) throw problem("enrolment_limit");
    const entries = requesterEntries(view.relay, view.target);
    if (entries.length >= 50 || entries.some(entry => entry.label === input.label)) throw problem("invalid_requesters", 400);
    return;
  }
  if (input.action === "remove") {
    if (!requesterEntries(view.relay, view.target).some(entry => entry.id === input.entryId)) throw problem("not_found", 404);
    return;
  }
  if (!item || item.id !== input.entryId) throw problem("not_found", 404);
  if (!proposal && item.session !== approval.session && !(input.action === "decline" && now >= item.expires))
    throw problem("owner_session_required", 403);
  if (input.action === "confirm") {
    if (!approval.canStart) throw problem("owner_required", 403);
    if (pendingStatus(item, now, view.project, view.revision) !== "candidate") throw problem("candidate_unavailable");
  }
}

export function proposeRequesterOperation(input: RequesterMcpInput, conversation: string, authorize: Authorize) {
  if (input.action === "list") return trustedRequesterView(input, authorize, { management: false });
  const store = readRelayStore();
  const approval = authorize(store);
  const view = current(store, input);
  const now = Date.now();
  checkedOperation(input, view, approval, now, true);
  for (const [id, proposal] of proposals) if (proposal.expires <= now) proposals.delete(id);
  if (proposals.size >= 256) throw problem("proposal_limit");
  const id = randomBytes(24).toString("hex");
  proposals.set(id, { operation: input, revision: view.revision, project: view.project,
    credential: view.relay.credential, conversation, expires: now + VALID_MS });
  return { confirmationPath: `/#relay-requester=${id}`, expiresAt: new Date(now + VALID_MS).toISOString() };
}

function readProposal(id: string) {
  const proposal = proposals.get(id);
  if (!proposal || Date.now() >= proposal.expires) {
    proposals.delete(id);
    throw problem("confirmation_expired", 410);
  }
  return proposal;
}

export function previewRequesterProposal(id: string, authorize: Authorize) {
  const store = readRelayStore();
  const approval = authorize(store);
  const proposal = readProposal(id);
  const view = current(store, proposal.operation);
  if (view.revision !== proposal.revision || view.project !== proposal.project || view.relay.credential !== proposal.credential)
    throw problem("stale_revision");
  checkedOperation(proposal.operation, view, approval, Date.now());
  const operation = proposal.operation;
  const entry = operation.action === "remove" ? requesterEntries(view.relay, view.target).find(entry => entry.id === operation.entryId) : null;
  const item = pendingFor(operation, view.relay);
  const label = operation.action === "start_enrolment" ? operation.label : entry?.label ?? item!.label;
  const subjectProject = entry ? entry.project : operation.action === "decline" && item ? item.project : view.project;
  return { operation, targetName: view.target.name, project: subjectProject, label };
}

type Command = { proposalId: string } | { operation: RequesterOperation; revision: number; project: string | null };
export async function applyRequesterOperation(command: Command, authorize: Authorize) {
  const result = await withRelayStoreLock(async (store, replace) => {
    const approval = authorize(store);
    const proposalId = "proposalId" in command ? command.proposalId : null;
    const proposal = "proposalId" in command ? readProposal(command.proposalId) : null;
    const { operation, revision, project } = "proposalId" in command ? proposal! : command;
    const view = current(store, operation);
    if (view.revision !== revision || view.project !== project || proposal && proposal.credential !== view.relay.credential)
      throw problem("stale_revision");
    const actor: EntryActor = { approvedBy: approval.approvedBy, surface: proposal ? "mcp" : "board",
      ...(proposal ? { proposingConversation: proposal.conversation } : {}) };
    const check = () => {
      const latest = authorize(store);
      if (latest.session !== approval.session || latest.approvedBy !== approval.approvedBy) throw problem("owner_session_required", 403);
      if (proposalId) readProposal(proposalId);
      if (canonicalRelayProject(view.target.project) !== view.project) throw problem("stale_revision");
      checkedOperation(operation, view, latest, Date.now());
    };
    check();
    const key = scopeKey(operation);
    const item = pendingFor(operation, view.relay);
    const entries = requesterEntries(view.relay, view.target);
    let issued: { code: string; expiresAt: string } | null = null;
    if (operation.action === "start_enrolment") {
      const code = `DLG-${randomBytes(6).toString("hex").toUpperCase()}`;
      const enrolment: Pending = { relay: operation.relay, target: operation.target, id: randomUUID(),
        project: view.project!, credential: view.relay.credential, revision, label: operation.label, session: approval.session,
        codeDigest: digest(code), expires: Date.now() + VALID_MS, actor };
      await auditPending(enrolment, "start_enrolment", actor, revision);
      check();
      pending.set(key, enrolment);
      scheduleExpiry(enrolment);
      issued = { code, expiresAt: new Date(enrolment.expires).toISOString() };
    } else if (operation.action === "decline") {
      await expire(item!);
      check();
      await auditPending(item!, "decline", actor, revision);
      check();
    } else {
      const candidate = item?.candidate;
      const entry: TrustedRequesterEntry = operation.action === "confirm"
        ? { id: item!.id, kind: "requester", key: candidate!.key, project: item!.project, label: item!.label,
          source: actor.surface, addedAt: new Date().toISOString() }
        : entries.find(entry => entry.id === operation.entryId)!;
      if (operation.action === "confirm" && entries.some(existing => existing.kind === "requester"
        && existing.key === candidate!.key && canonicalRelayProject(existing.project) === view.project))
        throw problem("requester_already_enrolled");
      const next = operation.action === "confirm" ? [...entries, entry] : entries.filter(existing => existing.id !== entry.id);
      await writeRequesterEntries(store, replace, view.relay, view.target, next, entry, operation.action, actor, check);
    }
    if (item && (operation.action === "confirm" || operation.action === "decline")) {
      clearTimeout(item.timer);
      pending.delete(key);
    }
    if (proposalId) proposals.delete(proposalId);
    return { issued, removedFrom: operation.action === "remove" ? operation.relay : null };
  });
  if (result.removedFrom) await revokeOwnerRuns(result.removedFrom);
  return { issued: result.issued };
}

/** Reserved code tokens are removed even in later chat history and after restart. */
export function redactRequesterCodes<T>(value: T): T {
  if (typeof value === "string") return redactRequesterCodeText(value) as T;
  if (Array.isArray(value)) {
    const redacted = value.map(redactRequesterCodes);
    return redacted.some((item, index) => item !== value[index]) ? redacted as T : value;
  }
  if (value && typeof value === "object") {
    const original = value as Record<string, unknown>;
    let redacted: Record<string, unknown> | undefined;
    for (const key of Object.keys(original)) {
      const item = redactRequesterCodes(original[key]);
      if (item !== original[key]) (redacted ??= { ...original })[key] = item;
    }
    if (redacted) return redacted as T;
  }
  return value;
}

function enrolmentOwnerStillLive(item: Pending, store: RelayStore, now: number) {
  const team = existingTeamStore();
  const session = team?.session(item.session);
  if (!session || session.method !== "telegram" || session.memberId !== item.actor.approvedBy || !sessionIsLive(session, now))
    return false;
  const owner = team?.member(session.memberId);
  const destination = selectOwnerDestination(store.relays);
  return owner?.status === "active" && owner.role === "owner" && destination.installationOwner
    && owner.telegram?.userId === destination.chatId;
}

/** Only the verified trigger can bind, and only to this pairing and target. */
export function requesterCodeMatch(relay: PairedRelay, request: ExternalRelayRequest, deadline: number) {
  const scope = { relay: relay.id, target: request.target_id };
  const key = scopeKey(scope);
  const item = pending.get(key);
  if (!item || item.credential !== relay.credential || relay.paused || request.delivery === "guest"
    || request.input.requester?.is_anonymous_admin || !request.chat) return;
  const trigger = requesterTrigger(request.input);
  if (!trigger) return;
  const token = trigger.text.trim().split(/\s+/).filter(word => !/^@[A-Za-z0-9_]+$/.test(word));
  if (token.length !== 1 || !requesterCodeWord.test(token[0]!) || digest(token[0]!) !== item.codeDigest) return;
  const chat = request.chat;
  return (leaseHeld: () => boolean) => withRelayStoreLock(store => {
    const now = Date.now();
    if (pending.get(key) !== item || now >= deadline || !leaseHeld()) return { message: trigger.id, text: refused };
    const saved = store.relays.find(paired => paired.id === relay.id && paired.credential === item.credential);
    const target = saved?.targets.find(target => target.id === scope.target);
    if (now >= item.expires || !saved || saved.paused || !target?.enabled || target.answered_by !== "install"
      || canonicalRelayProject(target.project) !== item.project || (target.requesters?.revision ?? 0) !== item.revision
      || !enrolmentOwnerStillLive(item, store, now))
      return { message: trigger.id, text: refused };
    const first = item.candidate;
    if (!first) {
      item.candidate = { key: trigger.author.key, name: redactRequesterCodes(trigger.author.name), chat: chat.key,
        chatTitle: redactRequesterCodes(chat.title ?? null), at: new Date(now).toISOString(), message: trigger.id };
    } else if (first.key !== trigger.author.key || first.message !== trigger.id || first.chat !== chat.key) {
      item.contested = true;
    }
    return { message: trigger.id, text: item.contested ? refused : received };
  }, Math.min(deadline, Date.now() + 5000));
}
