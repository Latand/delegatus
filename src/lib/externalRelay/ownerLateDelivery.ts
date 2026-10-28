import { ownerTurnDiagnostic } from "./diagnostic";
import { cloneClientKey, sendAsClone, type CloneSendInput } from "./cloneSend";
import { ownerDeliverySchema, type ExternalRelayCompletion } from "./protocol";
import { changeRunAsync, ownerStopPending, type PairedRelay, type RunRecord } from "./store";
import type { StagedAttachment } from "./attachments";
import type { RelayAnswerDelivery } from "./answers";
import { relayRequestInFlight } from "./activity";

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
      const pending: LateAnswer = { ...row.ownerTurn.lateAnswer, body: row.ownerTurn.lateAnswer?.body ?? body,
        files: row.ownerTurn.lateAnswer?.files ?? files };
      pending.clientKey ??= cloneClientKey(relay.id, "owner-late-answer", requestId, 0);
      if (row.ownerTurn.completionAttempt) return row;
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
      prepared.pending = pending;
      return { ...row, ...(!ownerStopPending(row) && !relayRequestInFlight(requestId) ? { capacityReleased: true as const } : {}),
        ownerTurn: { ...row.ownerTurn, lateAnswer: pending } };
    }, Date.now() + 5000);
    let pending = prepared.pending;
    if (!pending || !authorize()) return { body, delivery: "refused" };
    if (!pending.parts) {
      if (missingContextAlarm) console.error("ALARM: Owner relay late delivery pending-delivery-context; answer retained without execution reservation", JSON.stringify({ requestId }));
      return { body, delivery: "unconfirmed" };
    }
    if (pending.parts.every(part => part.receipt)) return { body, delivery: "accepted" };
    if (["uncertain", "retry-expired", "refused"].includes(pending.status ?? "") || (pending.nextAttemptAt ?? 0) > Date.now())
      return { body, delivery: "unconfirmed" };
    for (let index = 0; index < pending.parts.length; index++) {
      const part = pending.parts[index]!;
      if (part.receipt) continue;
      // Celestia forgets keys after 24h. Each unresolved part keeps its fence.
      if (part.firstAttemptAt !== undefined && Date.now() - part.firstAttemptAt >= KEY_LIFETIME_MS - 60_000) {
        await changeRunAsync(requestId, row => ({ ...row, ownerTurn: { ...row.ownerTurn!,
          lateAnswer: { ...row.ownerTurn!.lateAnswer!, status: "retry-expired" } } }), Date.now() + 5000);
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
      }, Date.now() + 5000);
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
      }, Date.now() + 5000);
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
