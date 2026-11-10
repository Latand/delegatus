import { dispatchConversationMessage } from "@/lib/conversation/messageDispatch";
import { prepareMessageFiles } from "@/lib/longMessageFile";
import type { MessageTextAttachment } from "@/lib/messageTextAttachment";
/**
 * Resume or respawn a conversation's host, and deliver to it.
 *
 * Mounted twice: at `/api/conversation-host` and at the older `/api/tmux`
 * path that deployed clients still call. A send goes to
 * `deliverConversationMessage` / `enqueueStructuredMessage`, which resolve the
 * conversation's structured host; conversation actions and reconfigure go
 * through the structured control channel. No terminal multiplexer is involved.
 */
import { NextRequest, NextResponse } from "next/server";

import type { ConversationMessage, DeliveryOutcome } from "@/lib/delivery";
import { NO_STRUCTURED_HOST_CODE, NO_STRUCTURED_HOST_ERROR, type ConversationActionResult } from "@/lib/conversation/actions";
import type { StructuredMessageRequest } from "@/lib/runtime/structuredMessageDelivery";
import { structuredHostsEnabled } from "@/lib/runtime/flags";
import type { AccountChoiceActor } from "@/lib/accounts/accountOverrides";
import { callerConversationId, directOperatorActivityAuthority, operatorBrowserRequest } from "@/lib/agent/operatorAuthority";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { recordOperatorMessageAdmission } from "@/lib/suggestions/store";
import { API_CLIENT_ORIGIN, parseMessageOrigin } from "@/lib/runtime/messageOrigin";
import { claimMessageAuthor, recordConversationEvent, refuseAnonymous, settleMessageAuthor, teamActor, type MessageAuthorClaim } from "@/lib/team";
import { teamMode } from "@/lib/team/sessions";
import { existingTeamStore } from "@/lib/team/store";
import type { TeamActor } from "@/lib/team/contract";
import { agentMessageOrigin } from "@/lib/runtime/agentMessageAuthor";
import { agentRegistry } from "@/lib/agent/registry";
import { internalServiceClaim } from "@/lib/agent/callerClaims";
import { deputyDeliveryRefusal } from "@/lib/orchestrator/deputies";
import { admitOrchestratorRelay } from "@/lib/orchestrator/relay";
import { runtimeReceiptForSend } from "@/lib/runtime/sendSettlement";
import { attachmentsAreOrphaned, structuredAttachmentOutcome, type AttachmentDeliveryOutcome } from "@/lib/attachmentRetention";
import type { InboxFileAdmissionResult } from "@/lib/inboxFiles";
import type { NativeAnswerInput } from "@/lib/conversation/nativeAnswer";
import type { ApiError, FileEntry } from "@/lib/types";
import {
  conversationHostDependencies,
  type ConversationHostDependencies,
} from "./dependencies";
import { recordDeliveryIngress } from "@/lib/runtime/deliveryProgress";
import { admitConversationMember } from "@/lib/team/authorship";

interface SendResponse {
  ok: true;
  target: string | null;
  imagePaths?: string[];
  /** Inbox paths the general (non-image) attachments were written to (#1224):
      the same by-path handover images get, minus the base64-into-the-turn half. */
  filePaths?: string[];
  /** Set when the message booted a fresh agent host instead of reaching a live one. */
  spawned?: boolean;
  outcome?: "delivered-to-live" | "resumed" | "held" | "pending" | "reconfigured" | "queued" | "delivering" | "delivered" | "withdrawn";
  /** `withdrawn`: the account pick a reconfigure took back (#1846), or null when none was waiting. */
  withdrawn?: string | null;
  structured?: true;
  operationId?: string;
  receipt?: { operationId: string; status: string };
}

type ConversationHostPostBody = SendResponse | ApiError | ConversationActionResult["body"];

function respond(outcome: DeliveryOutcome): NextResponse<SendResponse | ApiError | { ok: false; outcome: "failed"; error: string }> {
  if (!outcome.ok) {
    const { status, ...body } = outcome;
    return NextResponse.json(body, { status });
  }
  return NextResponse.json(outcome);
}

class OperatorActivityTargetConflictError extends Error {}

function operatorFallbackEntry(
  files: FileEntry[],
  target: { pid: number; hasPid: boolean; filePath: string; conversationId: string },
): FileEntry | undefined {
  const byPath = target.filePath ? files.find((entry) => entry.path === target.filePath) : undefined;
  const byConversation = target.conversationId
    ? files.find((entry) => entry.conversationId === target.conversationId)
    : undefined;
  if ((byPath && byConversation && byPath.path !== byConversation.path)
    || (byPath?.conversationId && target.conversationId && byPath.conversationId !== target.conversationId)
    || (byConversation && target.filePath && byConversation.path !== target.filePath)) {
    throw new OperatorActivityTargetConflictError("operator activity target evidence conflicts");
  }
  if (byPath) return byPath;
  if (byConversation) return byConversation;
  if (target.filePath || target.conversationId || !target.hasPid) return undefined;
  return files.find((entry) => entry.pid === target.pid);
}

/** Whether this request is the operator acting directly, and the conversation
    the target resolved to — the same resolution the activity record already
    performs, returned so a caller does not scan for it a second time. */
interface AuthorizedOperatorAction {
  byOperator: boolean;
  conversationId: string;
}

async function recordAuthorizedOperatorActivity(
  dependencies: ConversationHostDependencies,
  req: NextRequest,
  target: { pid: number; hasPid: boolean; filePath: string; conversationId: string },
  identity: { idempotencyKey?: string },
  kind: "message" | "dialog",
  inProcessPerson = false,
): Promise<AuthorizedOperatorAction> {
  if (!inProcessPerson && !directOperatorActivityAuthority(req).ok) return { byOperator: false, conversationId: target.conversationId };
  // Ordinary attribution can use the completed inventory. A cached conflict
  // needs fresh membership: a launch may have adopted a canonical owner since
  // that inventory was captured.
  let fallbackEntry: FileEntry | undefined;
  try {
    fallbackEntry = operatorFallbackEntry((await dependencies.completedFileScan({ revalidate: false })).snapshot.files, target);
  } catch (error) {
    if (!(error instanceof OperatorActivityTargetConflictError)) throw error;
    fallbackEntry = operatorFallbackEntry((await dependencies.completedFileScan()).snapshot.files, target);
  }
  dependencies.recordOperatorRequest(req, {
    kind,
    idempotencyKey: identity.idempotencyKey ?? null,
    conversationId: target.conversationId || null,
    path: target.filePath || null,
    fallbackEntry: fallbackEntry ?? null,
  });
  return { byOperator: true, conversationId: target.conversationId || fallbackEntry?.conversationId || "" };
}

export function conversationHostPOST(req: NextRequest, options?: { actor: TeamActor }): Promise<NextResponse<ConversationHostPostBody>>;
// HTTP mounts expose the one-argument signature; their framework context is
// never an actor option. The explicit overload is for trusted in-process sends.
export function conversationHostPOST(req: NextRequest): Promise<NextResponse<ConversationHostPostBody>>;
export async function conversationHostPOST(req: NextRequest, options?: { actor: TeamActor }): Promise<NextResponse<ConversationHostPostBody>> {
  const ingressAt = new Date().toISOString();
  const dependencies = conversationHostDependencies();
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  // Only an in-process caller can supply an actor. Next's route context and
  // JSON/header claims carry no actor authority. Recheck before dispatch too.
  const trustedActor = options?.actor;
  const actorRejection = () => {
    if (!trustedActor) return null;
    try {
      if (trustedActor.kind === "member" && existingTeamStore()?.member(trustedActor.memberId)?.status === "active") return null;
      if (trustedActor.kind === "operator" && teamMode() === "solo") return null;
    } catch { /* Unreadable membership cannot authorize a send. */ }
    return NextResponse.json({ code: "member_required", error: "The person who started this call is no longer a member, so nothing was sent." }, { status: 401 });
  };
  const deniedActor = actorRejection();
  if (deniedActor) return deniedActor;
  // A rechecked in-process operator or member is the person's own authority;
  // the synthetic request it built carries no session cookie.
  const inProcessPerson = trustedActor?.kind === "operator" || trustedActor?.kind === "member";

  let body: { orchestratorRelayProject?: unknown; pid?: unknown; path?: unknown; conversationId?: unknown; clientMessageId?: unknown; operationId?: unknown; text?: unknown; policy?: unknown; image?: unknown; images?: unknown; files?: unknown; action?: unknown; key?: unknown; label?: unknown; question?: unknown; decision?: unknown; requestId?: unknown; answer?: unknown; target?: unknown; model?: unknown; effort?: unknown; fast?: unknown; serviceTier?: unknown; accountId?: unknown };
  try {
    body = (await req.json()) as {
      pid?: unknown;
      path?: unknown;
      conversationId?: unknown;
      clientMessageId?: unknown;
      operationId?: unknown;
      text?: unknown;
      image?: unknown;
      images?: unknown;
      action?: unknown;
      key?: unknown;
      label?: unknown;
      question?: unknown;
      decision?: unknown;
      requestId?: unknown;
      answer?: unknown;
      target?: unknown;
      model?: unknown;
      effort?: unknown;
      fast?: unknown;
      serviceTier?: unknown;
      accountId?: unknown;
    };
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const voiceBinding = (body as { voiceDelegatus?: { sessionId?: unknown; proposalId?: unknown } }).voiceDelegatus;
  if (voiceBinding !== undefined && (body.orchestratorRelayProject === undefined || !voiceBinding
    || typeof voiceBinding.sessionId !== "string" || typeof voiceBinding.proposalId !== "string")) {
    return NextResponse.json({ error: "voice delegation requires a confirmed orchestrator proposal", code: "voice_admission_refused" }, { status: 400 });
  }
  let relay: Extract<ReturnType<typeof admitOrchestratorRelay>, { ok: true }> | null = null;
  if (body.orchestratorRelayProject !== undefined) {
    if (typeof body.orchestratorRelayProject !== "string" || !body.orchestratorRelayProject.trim() || body.action !== undefined) {
      return NextResponse.json({ error: "an orchestrator relay requires a project and is a message only" }, { status: 400 });
    }
    // Relay recovery binds the words and authenticated author. Keep every
    // mount on the same text-only contract before materializing attachments.
    if (body.image != null
      || (body.images != null && (!Array.isArray(body.images) || body.images.length > 0))
      || (body.files != null && (!Array.isArray(body.files) || body.files.length > 0))) {
      return NextResponse.json({ error: "orchestrator relays accept text only; attachments are not supported" }, { status: 400 });
    }
    // A team install answers a person without a live member session with the
    // sign-in refusal its identity gate gives, before relay admission.
    const anonymousRelay = refuseAnonymous(trustedActor ?? teamActor(req));
    if (anonymousRelay) return anonymousRelay;
    const admitted = admitOrchestratorRelay(req, body.orchestratorRelayProject,
      typeof body.conversationId === "string" ? body.conversationId : "",
      typeof body.text === "string" ? body.text : "",
      typeof body.clientMessageId === "string" ? body.clientMessageId : undefined,
      voiceBinding ? { sessionId: voiceBinding.sessionId as string, proposalId: voiceBinding.proposalId as string } : undefined,
      inProcessPerson);
    if (!admitted.ok) {
      return NextResponse.json({ error: admitted.error, code: admitted.code, admission: "refused" }, { status: admitted.status });
    }
    relay = admitted;
    if (body.conversationId !== admitted.recipient) {
      body.conversationId = admitted.recipient;
      delete body.path;
    }
    // Terminal evidence answers before either transport can recover a host or
    // reserve again, including the adopted legacy recipient's fallback path.
    if (relay.terminalReceipt || relay.voiceRecoveryReceipt) {
      const receipt = (relay.terminalReceipt ?? relay.voiceRecoveryReceipt)!;
      const response = {
        target: relay.recipient,
        operationId: receipt.operationId, receipt: runtimeReceiptForSend(receipt),
      };
      if (receipt.state === "in-flight") return NextResponse.json({ ...response, ok: true as const, outcome: "queued" as const });
      return receipt.state === "delivered"
        ? NextResponse.json({ ...response, ok: true as const, outcome: "delivered" as const })
        : NextResponse.json({ ...response, ok: false, outcome: receipt.state, error: receipt.reason ?? "delivery failed", resend: receipt.resend }, { status: 409 });
    }
  }

  const pid = Number(body.pid);
  const hasPid = Number.isInteger(pid) && pid > 0;
  const filePath = typeof body.path === "string" ? body.path : "";
  const conversationId = typeof body.conversationId === "string" ? body.conversationId : "";
  if (!hasPid && !filePath && !conversationId.startsWith("conversation_")) {
    return NextResponse.json({ error: "pid, path, or conversationId is required" }, { status: 400 });
  }

  const explicitAction = typeof body.action === "string" ? body.action : "";
  if (dependencies.conversationActions.includes(explicitAction)) {
    /* Answering an agent's question is a person acting: in team mode it
       needs a member, and the audit names them (sign-in-and-team §7.1). */
    const answering = explicitAction === "permission" || explicitAction === "answer";
    const person = answering ? trustedActor ?? teamActor(req) : null;
    if (person) {
      const anonymous = refuseAnonymous(person);
      if (anonymous) return anonymous;
    }
    if (answering) {
      const clientMessageId = typeof body.clientMessageId === "string" ? body.clientMessageId.trim().slice(0, 128) : "";
      const target = { pid, hasPid, filePath, conversationId };
      try {
        const activity = await recordAuthorizedOperatorActivity(
          dependencies,
          req,
          target,
          clientMessageId ? { idempotencyKey: clientMessageId } : {},
          "dialog",
          inProcessPerson,
        );
        admitConversationMember(person!, activity.conversationId || conversationId, filePath);
      } catch (error) {
        if (error instanceof OperatorActivityTargetConflictError) {
          return NextResponse.json({ error: error.message }, { status: 409 });
        }
        return NextResponse.json({ error: "direct operator activity could not be recorded" }, { status: 503 });
      }
    }
    const controlCaller = callerConversationId(req);
    const result = await dependencies.applyConversationAction({
      actor: controlCaller ? { kind: "agent", conversationId: controlCaller } : { kind: "operator" },
      ...(["interrupt", "kill"].includes(explicitAction) ? { controlOrigin: controlCaller
        ? { kind: "agent" as const, conversationId: controlCaller }
        : inProcessPerson || operatorBrowserRequest(req) ? { kind: "operator" as const } : API_CLIENT_ORIGIN } : {}),
      conversationId,
      transcriptPath: filePath,
      action: explicitAction,
      /* #862: the caller owns operation identity for durable controls. Without
         it every HTTP retry of one user gesture would mint a fresh operation —
         and a second compaction — instead of replaying the first receipt. */
      ...(typeof body.operationId === "string" && body.operationId.trim()
        ? { operationId: body.operationId.trim() }
        : {}),
      ...(explicitAction === "speed" ? { serviceTier: body.serviceTier } : {}),
      ...(typeof body.decision === "string" ? { decision: body.decision } : {}),
      ...(typeof body.requestId === "string" && body.requestId.trim() ? { requestId: body.requestId.trim() } : {}),
      ...(explicitAction === "answer" && body.answer && typeof body.answer === "object" && !Array.isArray(body.answer)
        ? { answer: body.answer as NativeAnswerInput } : {}),
    });
    if (person && result.status < 400) recordConversationEvent({ actor: person, action: "question.answered", conversationId, path: filePath });
    return NextResponse.json(result.body, { status: result.status });
  }

  /* Who is asking, for attributing an account choice outside a project's pool.
     An agent names itself by presenting its conversation capability; anything
     else is the operator, which is the same reading every operator-only gate in
     this codebase uses. */
  const caller = callerConversationId(req);
  const actor: AccountChoiceActor = caller ? { kind: "agent", conversationId: caller } : { kind: "operator" };
  const structuredControl = explicitAction === "reconfigure" && structuredHostsEnabled()
    ? await dependencies.dispatchStructuredControl({
        path: filePath,
        conversationId,
        action: explicitAction,
        actor,
        ...(explicitAction === "reconfigure" ? {
          reconfiguration: {
            model: typeof body.model === "string" ? body.model : undefined,
            effort: typeof body.effort === "string" ? body.effort : undefined,
            fast: typeof body.fast === "boolean" || body.fast === null ? body.fast : undefined,
            accountId: typeof body.accountId === "string" ? body.accountId : undefined,
          },
        } : {}),
      })
    : null;
  if (structuredControl) return NextResponse.json(structuredControl.body, { status: structuredControl.status });
  if (body.action === "reconfigure") {
    return NextResponse.json({ ok: false, outcome: "failed", code: NO_STRUCTURED_HOST_CODE, error: NO_STRUCTURED_HOST_ERROR }, { status: 409 });
  }

  /* A seat's deputy takes no message after its one ask (docs/design/ghost-seat.md
     §4). The structured path refuses it too; this answers before any
     attachment is written. */
  const deputyRefusal = deputyDeliveryRefusal({
    conversationId,
    path: filePath,
    clientMessageId: typeof body.clientMessageId === "string" ? body.clientMessageId.slice(0, 128) : null,
  });
  if (deputyRefusal) {
    const { status, ...refusal } = deputyRefusal;
    return NextResponse.json({ ok: false, outcome: "failed", ...refusal }, { status });
  }

  const policy = body.policy;
  if (policy !== undefined && policy !== "steer-or-queue") {
    return NextResponse.json({ error: "policy is invalid" }, { status: 400 });
  }
  const text = relay?.text ?? (typeof body.text === "string" ? body.text : "");
  const { images, error: imageError } = dependencies.collectImagePayloads(body);
  if (imageError) {
    return NextResponse.json({ error: imageError.error }, { status: imageError.status });
  }
  /* #1224: a general attachment is admitted against the same shared policy the
     composer refuses against, so an over-budget file is answered with the reason
     rather than dropped from the batch on its way through. Validation finishes
     before the message's inbox batch is planned or written. */
  const rawFiles = (body as { files?: unknown }).files;
  const fileAdmission: InboxFileAdmissionResult = rawFiles === undefined || rawFiles === null
    ? { files: [], error: null }
    : await (await import("@/lib/inboxFiles")).admitInboxFilePayloadAsync({ files: rawFiles }, trustedActor ?? teamActor(req));
  if (fileAdmission.error) {
    return NextResponse.json({ error: fileAdmission.error.error }, { status: fileAdmission.error.status });
  }
  if (!text.trim() && !images.length && !fileAdmission.files.length) {
    return NextResponse.json({ error: "empty message" }, { status: 400 });
  }

  /* #1117: message authorship declared by the caller — the in-process MCP
     bindings stamp their sends `agent` with the server-attributed sender role.
     Validated, never defaulted: a send without it stays unattributed. */
  const requestedOrigin = parseMessageOrigin((body as { origin?: unknown }).origin);

  const clientMessageId = typeof body.clientMessageId === "string" ? body.clientMessageId.trim().slice(0, 128) : "";
  /* Who is sending (sign-in-and-team §7.1). In team mode a person's message
     needs a member session; the refusal comes before anything is recorded or
     delivered. The member is stamped against the client message id the feed
     already joins every delivered record to, and only once the delivery
     below admitted this submission (`claimMessageAuthor`). */
  const sender = trustedActor ?? teamActor(req);
  const anonymousSend = refuseAnonymous(sender);
  if (anonymousSend) return anonymousSend;
  const service = internalServiceClaim(req);
  /* Only the server's caller capability can name an agent. An ordinary client
     cannot turn its own message into another seat's by supplying `origin`. */
  const origin = relay?.origin ?? (sender.kind === "agent"
    ? (() => {
      try { return agentMessageOrigin(agentRegistry().readOnlySnapshot(), sender.conversationId,
        service.claim === "valid" && service.service === "mcp" ? requestedOrigin?.role : null); }
      catch { return { kind: "agent" as const, role: "agent", conversationId: sender.conversationId }; }
    })()
    : sender.kind === "service" ? service.claim === "valid"
      ? requestedOrigin ?? { kind: "agent" as const, role: service.service }
      : API_CLIENT_ORIGIN
    : { kind: "operator" as const });
  const operatorTarget = { pid, hasPid, filePath, conversationId };
  /* Stamped before the message is accepted, so the compare-and-clear below
     retires the set that was standing when the operator pressed send and
     leaves a fresher one — offered while this request was in flight — alone. */
  const acceptedAt = new Date();
  let operatorAction: AuthorizedOperatorAction;
  try {
    operatorAction = await recordAuthorizedOperatorActivity(
      dependencies,
      req,
      operatorTarget,
      clientMessageId ? { idempotencyKey: clientMessageId } : {},
      "message",
      inProcessPerson,
    );
  } catch (error) {
    if (error instanceof OperatorActivityTargetConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json({ error: "direct operator activity could not be recorded" }, { status: 503 });
  }
  /* The operator's message is remembered at the moment this path accepted it,
     whether or not a pane is mounted to notice. An agent's send through this
     same route is not the operator's. The client's own message id rides
     along: a delivery retried under the key it already used keeps its first
     admission. */
  if (operatorAction.byOperator) {
    recordOperatorMessageAdmission(operatorAction.conversationId, acceptedAt, clientMessageId);
  }
  const authoredConversation = operatorAction.conversationId || conversationId || null;
  const revokedActor = actorRejection();
  if (revokedActor) return revokedActor;
  const authorClaim: MessageAuthorClaim | null = operatorAction.byOperator
    ? claimMessageAuthor({
      actor: sender,
      clientMessageId,
      conversationId: authoredConversation,
      text,
      path: filePath,
      priorSubmission: () => dependencies.priorSubmission(authoredConversation ?? "", clientMessageId),
    })
    : null;

  /* The attachments hit disk HERE, after every early refusal above — a rejected
     request never orphans bytes — and the paths ride the delivered text the way
     `buildImagePayload` folds image paths in. The batch is keyed by the client's
     own message id, so a retried delivery rewrites the same paths instead of
     leaving a second copy behind. */
  let payloadText = text;
  let filePaths: string[] = [];
  let textAttachment: MessageTextAttachment | undefined;
  {
    const { stageInboxFilesAsync, inboxFileBatchToken, withInboxBatch } = await import("@/lib/inboxFiles");
    try {
      const batch = inboxFileBatchToken(clientMessageId);
      const prepared = prepareMessageFiles(text, fileAdmission.files, batch);
      textAttachment = prepared.textAttachment;
      payloadText = prepared.payload;
      filePaths = (await withInboxBatch(batch, () => stageInboxFilesAsync(prepared.files, batch))).filePaths;
    } catch (error) {
      return NextResponse.json({
        error: error instanceof Error ? error.message : "attachments could not be saved",
      }, { status: 500 });
    }
  }
  /* A TERMINALLY refused delivery leaves no bytes behind (#1224). A delivery
     that was accepted — including one held for a switch — keeps them, because
     the agent still has to open the path it was handed, and so does one whose
     fate could not be established: see `attachmentRetention.ts` for why "not
     ok" is the wrong key to hang a deletion on. */
  const releaseAttachments = async (outcome: AttachmentDeliveryOutcome): Promise<void> => {
    if (!filePaths.length || !attachmentsAreOrphaned(outcome)) return;
    (await import("@/lib/inboxFiles")).deleteInboxFiles(filePaths);
    filePaths = [];
  };
  const attachmentField = () => (filePaths.length ? { filePaths, ...(textAttachment ? { textAttachment } : {}) } : {});

  const structuredEnabled = structuredHostsEnabled();
  if (structuredEnabled) {
    const revoked = actorRejection(); if (revoked) return revoked;
  }
  try { admitConversationMember(sender, authoredConversation, filePath); }
  catch {
    await releaseAttachments("refused");
    return NextResponse.json({ error: "conversation authority could not be recorded" }, { status: 503 });
  }
  try { relay?.admissionGuard?.(); }
  catch {
    await releaseAttachments("refused");
    return NextResponse.json({ error: "relay authority changed before delivery", code: "orchestrator_relay_refused", admission: "refused" }, { status: 403 });
  }
  const selected = await dispatchConversationMessage({
    ...(relay?.admissionGuard ? { admissionGuard: relay.admissionGuard, recoveryAuthorityGuard: relay.admissionGuard } : {}),
    path: filePath,
    ...(conversationId ? { conversationId } : {}),
    ...(typeof body.clientMessageId === "string" ? { clientMessageId: body.clientMessageId.slice(0, 128) } : {}),
    // Only admission's authenticated durable send can choose a relay replay
    // operation; caller-supplied operation IDs grant no such authority.
    ...(relay?.operationId ? { operationId: relay.operationId } : {}),
    text: payloadText.trim(),
    ...(policy ? { policy } : {}),
    images,
    ...(origin ? { origin } : {}),
  } satisfies StructuredMessageRequest, {
    ...(relay?.admissionGuard ? { admissionGuard: relay.admissionGuard, recoveryAuthorityGuard: relay.admissionGuard } : {}),
    pid: hasPid ? pid : null,
    path: filePath,
    ...(conversationId ? { conversationId } : {}),
    ...(typeof body.clientMessageId === "string" ? { clientMessageId: body.clientMessageId.slice(0, 128) } : {}),
    text: payloadText,
    ...(policy ? { policy } : {}),
    images,
    ...(origin ? { origin } : {}),
    // The "on resume" profile (issue #241 §4): honored only when this send
    // reopens a finished conversation; a live pane ignores it.
  } satisfies ConversationMessage, {
    structured: request => structuredEnabled ? dependencies.enqueueStructuredMessage(request) : Promise.resolve(null),
    legacy: async (request): Promise<DeliveryOutcome | NextResponse<ApiError>> => {
      const revoked = actorRejection();
      try { relay?.admissionGuard?.(); }
      catch { return NextResponse.json({ error: "relay authority changed before delivery", code: "orchestrator_relay_refused", admission: "refused" }, { status: 403 }); }
      return revoked ?? dependencies.deliverConversationMessage(request);
    },
  });
  if (selected.transport === "structured") {
    const structured = selected.result;
    recordDeliveryIngress(structured.operationId, ingressAt);
    await releaseAttachments(structuredAttachmentOutcome(structured));
    if (structured.ok) settleMessageAuthor(authorClaim);
    const { status, ...response } = structured.ok ? { ...structured, status: 200 } : structured;
    return NextResponse.json({ ...response, ...attachmentField() }, { status });
  }
  const outcome = selected.result;
  if (outcome instanceof NextResponse) return outcome;
  recordDeliveryIngress(outcome.operationId, ingressAt);
  /* `started` actuation is the uncertain case the image path also keeps: the
     agent may already hold the message, so its attachments stay readable. */
  await releaseAttachments(outcome.ok
    ? "accepted"
    : outcome.actuation === "started" ? "uncertain" : "refused");
  if (!outcome.ok) return respond(outcome);
  settleMessageAuthor(authorClaim);
  return NextResponse.json({ ...outcome, ...attachmentField() });
}
