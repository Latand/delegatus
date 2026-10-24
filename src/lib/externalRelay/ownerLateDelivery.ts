import { ownerTurnDiagnostic } from "./diagnostic";
import { cloneClientKey, sendAsClone, type CloneSendInput } from "./cloneSend";
import { ownerDeliverySchema, type ExternalRelayCompletion } from "./protocol";
import { changeRunAsync, type PairedRelay, type RunRecord } from "./store";
import type { StagedAttachment } from "./attachments";
import type { RelayAnswerDelivery } from "./answers";

type LateAnswer = NonNullable<NonNullable<RunRecord["ownerTurn"]>["lateAnswer"]>;
const RETRY_MS = 30_000;
const KEY_LIFETIME_MS = 24 * 60 * 60 * 1000;
const FILE_NOTE = "[Files were produced; late delivery supports text only, so files are omitted.]";
const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function payloadFor(pending: LateAnswer, delivery: NonNullable<RunRecord["ownerTurn"]>["delivery"]): CloneSendInput | undefined {
  const context = ownerDeliverySchema.safeParse(delivery);
  if (!context.success || pending.body.outcome !== "answered") return;
  const answer = pending.body.answer;
  const note = pending.files.length || answer.attachments?.length ? `\n\n${FILE_NOTE}` : "";
  // HTML carries escaped plain text beyond Telegram's 4096-unit plain limit.
  // Keep the complete answer durable if it exceeds this one-message contract.
  const text = `${answer.text}${note}`;
  return { client_key: pending.clientKey!, chat_id: context.data.chat_id,
    text: text.length <= 4096 ? text : escapeHtml(text), parse_mode: text.length <= 4096 ? null : "HTML", reply_to_message_id: context.data.reply_to_message_id,
    ...(context.data.message_thread_id === null ? {} : { message_thread_id: context.data.message_thread_id }), silent: false };
}

/** All paths (runner, startup and diagnosed-stop recovery) use the same durable
 * payload and key. No discovery, opaque reply reference or owner id fills gaps. */
export async function deliverOwnerLateAnswer(relay: PairedRelay, requestId: string,
  body: ExternalRelayCompletion, files: StagedAttachment[], authorize: () => boolean,
): Promise<{ body: ExternalRelayCompletion; delivery: RelayAnswerDelivery }> {
  const prepared = { pending: undefined as LateAnswer | undefined };
  let targetId = "";
  try {
    await changeRunAsync(requestId, row => {
      if (!row.ownerTurn || row.relayId !== relay.id || !authorize()) return row;
      targetId = row.targetId;
      const pending: LateAnswer = { ...row.ownerTurn.lateAnswer, body: row.ownerTurn.lateAnswer?.body ?? body,
        files: row.ownerTurn.lateAnswer?.files ?? files };
      pending.clientKey ??= cloneClientKey(relay.id, "owner-late-answer", requestId, 0);
      pending.payload ??= payloadFor(pending, row.ownerTurn.delivery);
      if (!pending.payload) pending.status = "pending-delivery-context";
      prepared.pending = pending;
      return { ...row, ownerTurn: { ...row.ownerTurn, lateAnswer: pending } };
    }, Date.now() + 5000);
    let pending = prepared.pending;
    if (!pending || !authorize()) return { body, delivery: "refused" };
    if (!pending.payload) {
      console.error("Owner relay late delivery pending-delivery-context", JSON.stringify({ requestId }));
      return { body, delivery: "unconfirmed" };
    }
    if (pending.status === "uncertain" || pending.status === "retry-expired" || (pending.nextAttemptAt ?? 0) > Date.now())
      return { body, delivery: "unconfirmed" };
    // Celestia forgets keys after 24h. Never redispatch an unresolved send after
    // that fence expires; definite unused-key refusals may still be retried.
    if (pending.firstAttemptAt !== undefined && Date.now() - pending.firstAttemptAt >= KEY_LIFETIME_MS - 60_000) {
      await changeRunAsync(requestId, row => ({ ...row, ownerTurn: { ...row.ownerTurn!,
        lateAnswer: { ...row.ownerTurn!.lateAnswer!, status: "retry-expired" } } }), Date.now() + 5000);
      console.error("Owner relay late delivery retry-expired", JSON.stringify({ requestId }));
      return { body, delivery: "unconfirmed" };
    }
    const hadUnresolvedAttempt = pending.firstAttemptAt !== undefined;
    await changeRunAsync(requestId, row => {
      pending = { ...row.ownerTurn!.lateAnswer!, firstAttemptAt: pending!.firstAttemptAt ?? Date.now(),
        nextAttemptAt: Date.now() + RETRY_MS, status: "retry" };
      return { ...row, ownerTurn: { ...row.ownerTurn!, lateAnswer: pending } };
    }, Date.now() + 5000);
    const sent = await sendAsClone(relay, targetId, pending.payload!, { beforeSend: () => {
      if (!authorize()) throw new Error("owner relay revoked");
    } });
    if (sent.kind === "sent") return { body, delivery: "accepted" };
    await changeRunAsync(requestId, row => {
      const lateAnswer = row.ownerTurn?.lateAnswer;
      if (!lateAnswer) return row;
      return { ...row, ownerTurn: { ...row.ownerTurn!, lateAnswer: { ...lateAnswer,
        // The client classifies only documented unused-key refusals as fallback.
        ...(!hadUnresolvedAttempt && sent.kind === "refused" && (sent.fallback || sent.code === "rate_limited") ? { firstAttemptAt: undefined } : {}),
        ...(sent.kind === "uncertain" && sent.cause ? { status: "uncertain" as const } : {}) } } };
    }, Date.now() + 5000);
    console.error("Owner relay late delivery pending", JSON.stringify({ requestId, outcome: sent.kind }));
    return { body, delivery: "unconfirmed" };
  } catch (error) {
    console.error("Owner relay late delivery pending", JSON.stringify({ requestId,
      diagnostic: ownerTurnDiagnostic("exception", error, [relay.credential]) }));
    return { body, delivery: "unconfirmed" };
  }
}
