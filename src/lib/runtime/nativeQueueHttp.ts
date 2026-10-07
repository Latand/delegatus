import { NextRequest, NextResponse } from "next/server";
import type { AttachmentDeliveryOutcome } from "@/lib/attachmentRetention";
import {
  admitInboxFilePayload, InboxFileConflictError, inboxFileBatchToken, inboxFilePaths, inboxFileText,
  settleInboxFiles, stageInboxFiles, withInboxBatch, type InboxFileUpload, type StagedInboxFiles,
} from "@/lib/inboxFiles";
import { operatorBrowserRequest } from "@/lib/agent/operatorAuthority";
import { agentRegistry, DeliveryReservationConflictError, type AgentRegistry, type DeliveryOperationOwner, type DirectAdmissionIdentity } from "@/lib/agent/registry";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { claimMessageAuthor, refuseAnonymous, settleMessageAuthor, teamActor } from "@/lib/team";
import type { TeamActor } from "@/lib/team/contract";
import { structuredDeliveryHostForConversation } from "./structuredDeliveryController";
import type { NativeQueueSnapshot } from "./nativeCodexQueue";
import { parseRuntimeCommand } from "./commands";
import type { RuntimeOperationResult } from "./contracts";
import { nativeQueueDeliveryKey } from "./deliveryDedup";
import { API_CLIENT_ORIGIN } from "./messageOrigin";
import { agentMessageOrigin } from "./agentMessageAuthor";
import { isRuntimeHostTransportFailure, RuntimeHostUnavailableError, runtimeHostClient, type RuntimeHostClient } from "./client";
import { ownedDeliveryProgressStore, type DeliveryProgressRecord } from "./deliveryProgress";
import { admissionRecordStanding, recordDirectWait, stillAtStep, stillOwnsRecord, type DeliveryProgressPort } from "./recordWait";
import { STRUCTURED_DELIVERY_TIMING } from "./structuredDeliveryQueue";
import { structuredHostsEnabled } from "./flags";
import { admitRuntimeImagePayload, type RuntimeImageAdmissionResult } from "./runtimeImageAdmission";
import { runtimeImageStore, type RuntimeImageUpload } from "./runtimeImageStore";
import type { StructuredImageRef } from "./structuredContent";
import { kickStructuredDeliveryQueue } from "./structuredDeliverySignal";

interface Dependencies {
  client(): RuntimeHostClient | null;
  enabled(): boolean;
  kick(): void;
  admitImages(images: unknown): RuntimeImageAdmissionResult;
  storeImages(uploads: readonly RuntimeImageUpload[]): StructuredImageRef[];
  nativeSnapshot?(conversationId: string): Promise<NativeQueueSnapshot | null>;
  /** Where a hand-off's owner row is written (A8); the Viewer's registry by default. */
  registry?(): AgentRegistry;
  /** Where a hand-off's waits are recorded; the Viewer's own store by default. */
  progress?: DeliveryProgressPort | null;
}

/** What the journal's request hash covers for a native add: the command
    without its operation id and authorship, in a stable order. */
function handOffRequestText(command: Record<string, unknown>): string {
  const sorted = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sorted);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== "operationId" && key !== "origin")
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sorted(item)]));
    }
    return value;
  };
  return JSON.stringify(sorted(command));
}
const defaults: Dependencies = {
  client: runtimeHostClient, enabled: structuredHostsEnabled, kick: kickStructuredDeliveryQueue,
  admitImages: (images) => admitRuntimeImagePayload({ images }),
  storeImages: (uploads) => runtimeImageStore().putMany(uploads),
  nativeSnapshot: async (id) => {
    const native = structuredDeliveryHostForConversation(id)?.nativeQueue;
    if (!native) return null;
    try { return await native.queue.refresh(); } catch { return native.queue.read(); }
  },
};

/** Admissions return as soon as the journal commits; no native RPC on this hop. */
export async function handleNativeQueue(request: NextRequest, dependencies: Dependencies = defaults): Promise<NextResponse> {
  const rejected = rejectCrossOrigin(request);
  if (rejected) return rejected;
  if (!dependencies.enabled()) return NextResponse.json({ error: "structured hosts are disabled" }, { status: 503 });
  const client = dependencies.client();
  if (!client?.nativeQueueRead) return NextResponse.json({ error: "native queue journal is unavailable" }, { status: 503 });
  if (request.method === "GET") {
    const conversationId = request.nextUrl.searchParams.get("conversationId");
    if (!conversationId || !/^conversation_[a-zA-Z0-9_-]+$/.test(conversationId)) return NextResponse.json({ error: "conversationId is invalid" }, { status: 400 });
    try {
      const [entries, native] = await Promise.all([
        client.nativeQueueRead(conversationId), dependencies.nativeSnapshot?.(conversationId) ?? null,
      ]);
      return NextResponse.json({ entries, native });
    } catch {
      return NextResponse.json({ error: "native queue history is unavailable" }, { status: 503 });
    }
  }
  /* Who is acting (sign-in-and-team §7.1): a queued message is a message, so
     in team mode a person needs a member session here exactly as on a send. */
  const person = teamActor(request);
  const anonymous = refuseAnonymous(person);
  if (anonymous) return anonymous as NextResponse;
  let command: ReturnType<typeof parseRuntimeCommand>;
  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  let files: InboxFileUpload[] = [];
  let batch = "";
  /* #1629: the composer stages attachments as bytes, exactly as it does for an
     ordinary send, so a queued message must be able to carry them. The bytes are
     admitted and content-addressed HERE and the command carries refs — the same
     road `/api/runtime/send` takes, and the reason the command's own 256 KiB
     ceiling bounds the command rather than the attachment. */
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const payload = body as Record<string, unknown>;
    /* #1117: this route is the operator's own composer surface, exactly as
       `/api/runtime/send` is, so authorship is stamped HERE and never read off
       the body — a queued message keeps the same provenance a sent one has,
       the operator's only from a Viewer page. */
    let agentOrigin = API_CLIENT_ORIGIN;
    if (person.kind === "agent") {
      try { agentOrigin = agentMessageOrigin(agentRegistry().readOnlySnapshot(), person.conversationId); }
      catch { agentOrigin = { kind: "agent", role: "agent", conversationId: person.conversationId }; }
    }
    body = { ...payload, origin: operatorBrowserRequest(request) ? { kind: "operator" } : agentOrigin };
    if (Array.isArray(payload.images) && payload.images.some((image) => image && typeof image === "object" && "base64" in image)) {
      const admitted = dependencies.admitImages(payload.images);
      if (admitted.error) return NextResponse.json({ error: admitted.error.error }, { status: admitted.error.status });
      body = { ...(body as Record<string, unknown>), images: dependencies.storeImages(admitted.images) };
    }
    /* #1652: a general attachment takes the road it takes on an ordinary send.
       The same admission refuses a bad file with its reason, the bytes land in
       the viewer inbox under a batch derived from the ORIGINAL key, and their
       paths are folded into the words before the command is parsed. The
       queued version's text then names the files, so its digest covers them,
       an edit carrying that text keeps them, and a replay of the key rebuilds
       the identical command. Only a message or its edit carries content; a
       control that names files is refused rather than having them dropped. */
    if (payload.files !== undefined && payload.files !== null) {
      if (payload.action !== "add" && payload.action !== "update") {
        return NextResponse.json({ error: "files can only be queued with a message or an edit of one" }, { status: 400 });
      }
      const admitted = admitInboxFilePayload({ files: payload.files });
      if (admitted.error) return NextResponse.json({ error: admitted.error.error }, { status: admitted.error.status });
      const rest: Record<string, unknown> = { ...(body as Record<string, unknown>) };
      delete rest.files;
      body = rest;
      if (admitted.files.length) {
        files = admitted.files;
        const key = payload.idempotencyKey ?? payload.operationId;
        batch = inboxFileBatchToken(typeof key === "string" ? key : null);
        body = { ...rest, text: inboxFileText(typeof rest.text === "string" ? rest.text : "", inboxFilePaths(files, batch)) };
      }
    }
  }
  try { command = parseRuntimeCommand("native-queue", body); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "invalid native queue command" }, { status: 400 }); }
  /* A8: the composer's Queue-for-Codex hand-off is an accepted message the
     moment the journal commits it. Its owner row and record exist before the
     command leaves this process, under an operation id the row mints and every
     replay of the key reuses, so a lost reply leaves an owned, bounded,
     explained entry. Panel controls on an existing entry are unchanged. */
  const handOff = command.kind === "native-queue" && command.action === "add";
  const registry = handOff ? (dependencies.registry ?? agentRegistry)() : null;
  const progress = dependencies.progress === undefined ? ownedDeliveryProgressStore() : dependencies.progress;
  const identity: DirectAdmissionIdentity | null = handOff && command.kind === "native-queue" ? {
    conversationId: command.conversationId as ViewerConversationId,
    clientMessageId: command.idempotencyKey,
    command: { operationId: command.operationId ?? "", kind: "send", policy: "queue", ...(command.origin ? { origin: command.origin } : {}) },
    text: handOffRequestText(command as unknown as Record<string, unknown>),
    contentDigest: null,
    evidenceText: typeof command.text === "string" ? command.text : null,
    evidenceImageCount: Array.isArray(command.images) ? command.images.length : 0,
  } : null;
  const writeRow = async (adoptOperationId?: string): Promise<DeliveryOperationOwner | NextResponse> => {
    try {
      const row = await registry!.deliveryWrite({ label: "delivery.direct-admission", operationId: adoptOperationId ?? command.operationId ?? null },
        () => registry!.recordDirectAdmission({ handOff: identity!, ...(adoptOperationId ? { adoptOperationId } : {}) }));
      if (!row.acquired || !row.value) {
        return NextResponse.json({ error: "the delivery record's write lock is busy; nothing was sent", retryable: true }, { status: 503 });
      }
      return row.value;
    } catch (error) {
      if (error instanceof DeliveryReservationConflictError) {
        return NextResponse.json({ error: error.message, recovery: "query or replay the original Viewer idempotency key" }, { status: 409 });
      }
      throw error;
    }
  };
  const endRow = async (operationId: string, reason: string) => {
    await registry!.deliveryWrite({ label: "delivery.direct-admission", operationId },
      () => registry!.settleDirectAdmission(operationId, "failed", reason, "lost"));
    try { progress?.settle?.(operationId, "failed", reason); } catch { /* never fails the answer */ }
  };
  const admit = async (staged: StagedInboxFiles | null): Promise<NextResponse> => {
    /* The same rule as an ordinary send (#1224): bytes go on a TERMINAL refusal
       and on nothing else. A 409 is the journal refusing this request; a thrown
       transport leaves the operation's fate unknown, and a receipt of any other
       status names an operation whose message holds these paths. */
    let outcome: AttachmentDeliveryOutcome = "uncertain";
    let owner: DeliveryOperationOwner | null = null;
    let written: ReturnType<typeof recordDirectWait> = null;
    try {
      if (handOff) {
        const row = await writeRow();
        if (row instanceof NextResponse) {
          outcome = row.status === 409 ? "refused" : "uncertain";
          return row;
        }
        owner = row;
        if (owner.terminalState !== null) {
          /* A row the settlement already ended sends nothing again: the answer
             is what the journal holds under its operation, if anything. */
          let current;
          try { current = await client.operationStatus(owner.command.operationId); }
          catch { return NextResponse.json({ error: "native queue admission status is unavailable", retryable: true }, { status: 503 }); }
          if (!current) {
            outcome = "refused";
            return NextResponse.json({ error: "this message never reached Codex's queue; queue it again with a new message" }, { status: 409 });
          }
          outcome = current.receipt.status === "rejected" ? "refused" : "accepted";
          return NextResponse.json({ ...current, replayed: true }, { status: current.receipt.status === "rejected" ? 409 : 202 });
        }
        command = { ...command, operationId: owner.command.operationId };
        /* A replay of the key finds the record its first request started. One
           that request wrote is carried on as it stands; one the queue or the
           native executor moved is theirs, and the replay's command answers
           without touching its phase, clocks or stall. */
        const standing = admissionRecordStanding(progress, owner.command.operationId, handOffWrote);
        written = standing.standing === "fresh"
          ? recordDirectWait(progress, registry!, owner, { reason: "checking", detail: HANDING_OFF, nextWakeMs: null })
          : standing.standing === "continue" ? standing.record : null;
      }
      const result = await client.command(command);
      outcome = result.receipt.status === "rejected" ? "refused" : "accepted";
      if (owner && result.operationId !== owner.command.operationId) {
        /* A key first admitted before this build: the journal answered the
           operation it already holds. That operation gets the row, the record
           and the deadline from this answer on. */
        const adopted = await writeRow(result.operationId);
        if (!(adopted instanceof NextResponse)) {
          owner = adopted;
          /* The journal's operation may already be listed and led. */
          written = admissionRecordStanding(progress, owner.command.operationId, handOffWrote).standing === "leave"
            ? null
            : recordDirectWait(progress, registry!, owner, { reason: "queued", nextWakeMs: STRUCTURED_DELIVERY_TIMING.retryMs });
        }
      } else if (owner && result.receipt.status === "rejected") {
        await endRow(owner.command.operationId, result.receipt.reason || "native queue admission was refused");
      } else if (owner && written && (result.receipt.status === "queued" || result.receipt.status === "pending")
        && progress && stillAtStep(progress.get(owner.command.operationId), written)) {
        recordDirectWait(progress, registry!, owner, { reason: "queued", nextWakeMs: STRUCTURED_DELIVERY_TIMING.retryMs });
      }
      stampQueuedAuthor(person, command, result);
      if (result.receipt.status === "queued" || result.receipt.status === "pending") dependencies.kick();
      return NextResponse.json(result, { status: result.receipt.status === "rejected" ? 409 : 202 });
    } catch (error) {
      const message = error instanceof Error ? error.message : "native queue admission is unavailable";
      const conflict = /idempotency|revision changed|frozen or unresolved|ownership changed/.test(message);
      if (conflict) outcome = "refused";
      if (owner) {
        const answered = error instanceof RuntimeHostUnavailableError && !isRuntimeHostTransportFailure(error)
          && message !== "runtime host request cancelled";
        if (conflict || answered) {
          await endRow(owner.command.operationId, message);
        } else {
          /* It may have reached the journal: the record says why it waits,
             the attempt is counted and the queue is woken to list it. Written
             only over the record this request wrote: once the queue or the
             native executor moved it, they own it. */
          if (stillOwnsRecord(progress, owner.command.operationId, written)) recordDirectWait(progress, registry!, owner, {
            reason: "evidence-unreadable",
            detail: `${HAND_OFF_UNACKNOWLEDGED}: ${message}`,
            attempted: true,
            nextWakeMs: STRUCTURED_DELIVERY_TIMING.retryMs,
          });
          dependencies.kick();
        }
      }
      return NextResponse.json({ error: message, recovery: "query or replay the original Viewer idempotency key" }, { status: conflict ? 409 : 503 });
    } finally {
      if (staged) settleInboxFiles(staged, outcome);
    }
  };
  if (!files.length) return admit(null);
  /* Written only once the command is valid, and never over a file already
     there: a replay reuses the bytes its first attempt left, and only the
     files this request created are its to release. Staging, admission and
     that release take one turn per batch, so no other request under the key
     can reuse a file while this one may still delete it. */
  return withInboxBatch(batch, async () => {
    let staged: StagedInboxFiles;
    try { staged = stageInboxFiles(files, batch); }
    catch (error) {
      if (error instanceof InboxFileConflictError) {
        return NextResponse.json({ error: error.message, recovery: "query or replay the original Viewer idempotency key" }, { status: 409 });
      }
      return NextResponse.json({ error: "the attachments could not be saved to the inbox", retryable: true }, { status: 503 });
    }
    return admit(staged);
  });
}

const HANDING_OFF = "handing the message to Codex's queue";
const HAND_OFF_UNACKNOWLEDGED = "the runtime journal did not acknowledge the hand-off";

/** A record the hand-off route itself wrote, before the queue listed the entry. */
function handOffWrote(record: DeliveryProgressRecord): boolean {
  return (record.waitReason === "checking" && record.detail === HANDING_OFF)
    || (record.waitReason === "evidence-unreadable" && Boolean(record.detail?.startsWith(HAND_OFF_UNACKNOWLEDGED)));
}

/**
 * A member's queued words are stamped with the member (sign-in-and-team §7.1).
 *
 * The record Codex writes when the entry is finally sent names the version it
 * carried — `dedup=sha256(<entry>-v<revision>)` — so the author is recorded
 * under that version's key, and the provenance route turns the key back into
 * the token the feed reads. The key exists only once the host has admitted
 * the add or edit (the host mints the entry id), so the claim is taken here,
 * after admission: a fresh admission names an id nothing else can hold, and a
 * replay or a refusal claims nothing.
 */
function stampQueuedAuthor(person: TeamActor, command: ReturnType<typeof parseRuntimeCommand>, result: RuntimeOperationResult): void {
  if (command.kind !== "native-queue" || (command.action !== "add" && command.action !== "update")) return;
  if (result.receipt.status === "rejected") return;
  const entry = result.receipt.nativeQueue;
  if (!entry || typeof command.text !== "string") return;
  settleMessageAuthor(claimMessageAuthor({
    actor: person,
    clientMessageId: nativeQueueDeliveryKey(entry.entryId, entry.revision),
    conversationId: command.conversationId,
    text: command.text,
    priorSubmission: () => (result.replayed ? "admitted" : "not-executed"),
  }));
}
