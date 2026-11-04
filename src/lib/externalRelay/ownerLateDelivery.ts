import { ownerTurnDiagnostic } from "./diagnostic";
import { cloneClientKey, sendAsClone, type CloneSendInput } from "./cloneSend";
import { ownerDeliverySchema, requestSchema, type ExternalRelayCompletion } from "./protocol";
import { changeRunAsync, ownerRelayStoreDeadline, ownerStopPending, type PairedRelay, type RunRecord } from "./store";
import type { StagedAttachment } from "./attachments";
import type { RelayAnswerDelivery } from "./answers";
import { relayRequestInFlight } from "./activity";
import { readAnswerRecord } from "./answers";
import { ownerTierFor } from "./profile";
import { ownerFailureAnswer } from "./ownerRun";
import { isDeepStrictEqual } from "node:util";
import { answerCapabilities } from "./answerV2";
import { isOwnerRequestTimeoutReply } from "./requestTimeout";

/** Older custody rows retained the input in the answer record. Reconstruct only
 * from that record and the already verified owner request, never from chat text. */
export function ownerRecoveryRequest(run: RunRecord, relay: PairedRelay): unknown | null {
  if (run.ownerTurn?.rawRequest) return run.ownerTurn.rawRequest;
  const record = readAnswerRecord(run.relayId, run.targetId, run.requestId);
  if (!record?.profile?.owner || !run.ownerTurn?.request) return null;
  const parsed = requestSchema.safeParse({ request_id: run.requestId, lease_id: run.leaseId,
    kind: "answer", target_id: run.targetId, claimed_at: record.claimedAt ?? run.startedAt,
    features: record.features, ...(record.chatKey ? { chat: { key: record.chatKey } } : {}),
    input: record.input, answer: { max_chars: relay.limits.max_answer_chars, progress: "none" },
    liveness: { poll_freshness_s: 60, claim_window_s: 5, ack_window_s: 10, heartbeat_interval_s: 10, stall_window_s: 45 } });
  if (!parsed.success) return null;
  const owner = ownerTierFor({ ownerTier: true }, parsed.data);
  return owner && owner.text === run.ownerTurn.request.text && owner.requestText === run.ownerTurn.request.requestText
    ? parsed.data : null;
}

type LateAnswer = NonNullable<NonNullable<RunRecord["ownerTurn"]>["lateAnswer"]>;
const RETRY_MS = 30_000;
const KEY_LIFETIME_MS = 24 * 60 * 60 * 1000;
const FILE_NOTE = "[Files were produced; late delivery supports text only, so files are omitted.]";
// Telegram measures parsed text in UTF-16 units. Plain text avoids expansion
// and preserves literal markup; a code point is never cut between surrogates.
function payloadsFor(pending: LateAnswer, relayId: string, requestId: string,
  delivery: NonNullable<RunRecord["ownerTurn"]>["delivery"]): CloneSendInput[] | undefined {
  const context = ownerDeliverySchema.safeParse(delivery);
  if (!context.success || pending.body.outcome !== "answered") return;
  const answer = pending.body.answer;
  const texts: string[] = [];
  let part = "";
  for (const point of answer.text) {
    if (part.length + point.length > 4096) {
      if (part.trim()) texts.push(part);
      part = "";
    }
    part += point;
  }
  if (part.trim()) texts.push(part);
  if (pending.files.length || answer.attachments?.length) {
    const last = texts.length - 1;
    if (last >= 0 && texts[last]!.length + 2 + FILE_NOTE.length <= 4096) texts[last] += `\n\n${FILE_NOTE}`;
    else texts.push(FILE_NOTE);
  }
  if (!texts.length) return;
  return texts.map((text, index) => ({
    client_key: cloneClientKey(relayId, "owner-late-answer", requestId, index), chat_id: context.data.chat_id,
    text, parse_mode: null, reply_to_message_id: context.data.reply_to_message_id,
    ...(context.data.message_thread_id === null ? {} : { message_thread_id: context.data.message_thread_id }), silent: false,
  }));
}

/** All paths (runner, startup and diagnosed-stop recovery) use the same durable
 * payload and key. No discovery, opaque reply reference or owner id fills gaps. */
export async function deliverOwnerLateAnswer(relay: PairedRelay, requestId: string,
  body: ExternalRelayCompletion, files: StagedAttachment[], authorize: () => boolean,
): Promise<{ body: ExternalRelayCompletion; delivery: RelayAnswerDelivery }> {
  const prepared = { pending: undefined as LateAnswer | undefined };
  let targetId = "";
  let missingContextAlarm = false;
  try {
    await changeRunAsync(requestId, row => {
      if (!row.ownerTurn || row.relayId !== relay.id || !authorize()) return row;
      targetId = row.targetId;
      let pending: LateAnswer = { ...row.ownerTurn.lateAnswer, body: row.ownerTurn.lateAnswer?.body ?? body,
        files: row.ownerTurn.lateAnswer?.files ?? files };
      if (row.ownerTurn.completionAttempt) return row;
      if (row.ownerTurn.failureReply) {
        const request = requestSchema.safeParse(ownerRecoveryRequest(row, relay));
        const owner = request.success && (row.ownerTurn.context ?? ownerTierFor({ ownerTier: true }, request.data));
        if (!request.success || !owner || pending.body.outcome !== "answered") return row;
        const answer = isOwnerRequestTimeoutReply(pending.body, answerCapabilities(request.data, "").plainMax)
          ? pending.body.answer : ownerFailureAnswer(request.data, owner,
            row.ownerTurn.diagnostic ?? ownerTurnDiagnostic("exception", "Owner request could not be completed"), [relay.credential]);
        if (!answer) return row;
        const clean: LateAnswer = { body: { ...pending.body, answer }, files: [] };
        const payloads = payloadsFor(clean, relay.id, requestId, row.ownerTurn.delivery);
        const changed = !isDeepStrictEqual(pending.body, clean.body) || pending.files.length > 0
          || pending.payload !== undefined && !isDeepStrictEqual(pending.payload, payloads?.[0])
          || pending.parts !== undefined && !isDeepStrictEqual(pending.parts.map(part => part.payload), payloads);
        if (changed) {
          // An old payload may already be visible. Never resend its internal
          // text or substitute a new payload under its uncertain key.
          const attempted = pending.firstAttemptAt !== undefined || pending.parts?.some(part => part.firstAttemptAt !== undefined || part.receipt)
            || ["uncertain", "retry-expired"].includes(pending.status ?? "");
          pending = attempted ? { ...pending, status: "uncertain" } : clean;
        }
      }
      if (pending.status !== "uncertain") {
        pending.clientKey ??= cloneClientKey(relay.id, "owner-late-answer", requestId, 0);
        if (!pending.parts) {
          // Retain the exact payload of an older possibly delivered attempt. A
          // definite unused-key refusal (no firstAttemptAt) can be recomposed.
          const payloads = pending.payload && pending.firstAttemptAt !== undefined ? [pending.payload]
            : payloadsFor(pending, relay.id, requestId, row.ownerTurn.delivery);
          pending.parts = payloads?.map((payload, index) => ({ payload,
            ...(index === 0 && pending.firstAttemptAt !== undefined ? { firstAttemptAt: pending.firstAttemptAt } : {}) }));
        }
        pending.payload = pending.parts?.[0]?.payload ?? pending.payload;
        if (!pending.parts) {
          missingContextAlarm = pending.status !== "pending-delivery-context";
          pending.status = "pending-delivery-context";
        }
      }
      prepared.pending = pending;
      return { ...row, ...(!ownerStopPending(row) && !relayRequestInFlight(requestId) ? { capacityReleased: true as const } : {}),
        ownerTurn: { ...row.ownerTurn, lateAnswer: pending } };
    }, ownerRelayStoreDeadline());
    let pending = prepared.pending;
    if (!pending || !authorize()) return { body, delivery: "refused" };
    body = pending.body;
    if (pending.status === "uncertain") return { body, delivery: "unconfirmed" };
    if (!pending.parts) {
      if (missingContextAlarm) console.error("ALARM: Owner relay late delivery pending-delivery-context; answer retained without execution reservation", JSON.stringify({ requestId }));
      return { body, delivery: "unconfirmed" };
    }
    if (pending.parts.every(part => part.receipt)) return { body, delivery: "accepted" };
    if (["retry-expired", "refused"].includes(pending.status ?? "") || (pending.nextAttemptAt ?? 0) > Date.now())
      return { body, delivery: "unconfirmed" };
    for (let index = 0; index < pending.parts.length; index++) {
      const part = pending.parts[index]!;
      if (part.receipt) continue;
      // Celestia forgets keys after 24h. Each unresolved part keeps its fence.
      if (part.firstAttemptAt !== undefined && Date.now() - part.firstAttemptAt >= KEY_LIFETIME_MS - 60_000) {
        await changeRunAsync(requestId, row => ({ ...row, ownerTurn: { ...row.ownerTurn!,
          lateAnswer: { ...row.ownerTurn!.lateAnswer!, status: "retry-expired" } } }), ownerRelayStoreDeadline());
        return { body, delivery: "unconfirmed" };
      }
      const hadUnresolvedAttempt = part.firstAttemptAt !== undefined;
      await changeRunAsync(requestId, row => {
        const saved = row.ownerTurn!.lateAnswer!;
        const parts = saved.parts!.map((item, i) => i === index ? { ...item,
          firstAttemptAt: item.firstAttemptAt ?? Date.now() } : item);
        pending = { ...saved, parts, firstAttemptAt: parts[0]!.firstAttemptAt,
          nextAttemptAt: Date.now() + RETRY_MS, status: "retry" };
        return { ...row, ownerTurn: { ...row.ownerTurn!, lateAnswer: pending } };
      }, ownerRelayStoreDeadline());
      const sent = await sendAsClone(relay, targetId, part.payload, { partIndex: index, beforeSend: () => {
        if (!authorize()) throw new Error("owner relay revoked");
      } });
      await changeRunAsync(requestId, row => {
        const saved = row.ownerTurn!.lateAnswer!;
        const parts = saved.parts!.map((item, i) => {
          if (i !== index) return item;
          if (sent.kind === "sent") return { ...item, receipt: sent };
          if (!hadUnresolvedAttempt && sent.kind === "refused" && (sent.fallback || sent.code === "rate_limited"))
            return { ...item, firstAttemptAt: undefined };
          return item;
        });
        pending = { ...saved, parts, firstAttemptAt: parts[0]!.firstAttemptAt,
          ...(sent.kind === "uncertain" && sent.cause ? { status: "uncertain" as const } : {}),
          ...(sent.kind === "refused" && ["text_too_long", "format_invalid", "bad_request"].includes(sent.code)
            ? { status: "refused" as const } : {}) };
        return { ...row, ownerTurn: { ...row.ownerTurn!, lateAnswer: pending } };
      }, ownerRelayStoreDeadline());
      if (sent.kind !== "sent") {
        console.error("Owner relay late delivery pending", JSON.stringify({ requestId, outcome: sent.kind }));
        return { body, delivery: "unconfirmed" };
      }
    }
    return { body, delivery: "accepted" };
  } catch (error) {
    console.error("Owner relay late delivery pending", JSON.stringify({ requestId,
      diagnostic: ownerTurnDiagnostic("exception", error, [relay.credential]) }));
    return { body, delivery: "unconfirmed" };
  }
}
