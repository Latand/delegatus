import { ExternalRelayError, isUnknownFeatureRefusal, relayCall } from "./client";
import type { PairedRelay } from "./store";
import type { RelayAnswerDelivery } from "./answers";
import type { ExternalRelayCompletion } from "./protocol";

export async function completeRelayRequest(
  relay: PairedRelay,
  requestId: string,
  body: ExternalRelayCompletion,
  until: () => number,
  allowOwnerReply?: () => boolean,
  onUnknownFeature?: () => Promise<unknown>,
  plainMax = 4000,
): Promise<{ body: ExternalRelayCompletion; delivery: RelayAnswerDelivery }> {
  let wait = 1000;
  let attempted = false;
  let downgraded = false;
  let unresolved = false;
  const refused = () => ({ body, delivery: unresolved ? "unconfirmed" as const : "refused" as const });
  while (true) {
    if (attempted && Date.now() >= until()) return { body, delivery: "unconfirmed" };
    attempted = true;
    if (body.outcome === "answered" && allowOwnerReply && !allowOwnerReply()) body = { lease_id: body.lease_id, outcome: "failed", reason: "cancelled", detail: null };
    try {
      await relayCall(relay.api_base, `/requests/${encodeURIComponent(requestId)}/complete`, "POST", body, relay.credential,
        { timeoutMs: 5000, maxBytes: relay.limits.max_response_bytes,
          ...(allowOwnerReply ? { prepareBody: () => {
            if (body.outcome === "answered" && !allowOwnerReply()) body = { lease_id: body.lease_id, outcome: "failed", reason: "cancelled", detail: null };
            return body;
          } } : {}) });
      return { body, delivery: "accepted" };
    } catch (error) {
      if (isUnknownFeatureRefusal(error)) await onUnknownFeature?.();
      if (error instanceof ExternalRelayError) {
        if (allowOwnerReply && error.status === 409 && error.code === "already_completed") return { body, delivery: "unconfirmed" };
        if (unresolved && error.status >= 400 && error.status < 500) return refused();
        const v2 = body.outcome === "answered" && body.answer.format !== undefined;
        if (v2 && body.outcome === "answered" && (error.status === 400 && error.code === "malformed" && body.answer.mentions?.length
          || error.status === 422 && (body.answer.attachments?.some(file => file.kind === "photo") || /!\[/.test(body.answer.text)))) return refused();
        if (v2 && error.status === 409 && error.code === "already_completed") return unresolved ? refused() : { body: { lease_id: body.lease_id, outcome: "failed", reason: "invalid_answer", detail: null }, delivery: "refused" };
        if (v2 && !downgraded && (error.status === 422 && ["invalid_format", "attachment_not_ready"].includes(error.code) || error.status === 415 || error.status === 400 && error.code === "malformed")) {
          downgraded = true;
          if (body.outcome === "answered" && body.answer.text.trim() && error.status === 422 && error.code === "attachment_not_ready") {
            const answer = { ...body.answer }; delete answer.attachments;
            if (/!\[/.test(answer.text)) { body = { lease_id: body.lease_id, outcome: "failed", reason: "invalid_answer", detail: null }; continue; }
            body = { ...body, answer };
          } else if (body.outcome === "answered" && body.answer.text.trim() && [...body.answer.text].length <= plainMax) {
            const { action, text, reply_to } = body.answer;
            body = { ...body, answer: { action, text, reply_to, format: "plain", buttons: [] } };
          } else body = { lease_id: body.lease_id, outcome: "failed", reason: "invalid_answer", detail: null };
          continue;
        }
        if (v2 && [415, 422].includes(error.status)) return refused();
        if (error.status === 413 && body.outcome === "answered") { body = { lease_id: body.lease_id, outcome: "failed", reason: "invalid_answer", detail: null }; continue; }
        if (error.status === 409 && error.code === "handoff_after_action" && body.outcome === "declined" && body.reason === "handoff") {
          body = { lease_id: body.lease_id, outcome: "failed", reason: "invalid_answer", detail: null }; continue;
        }
        if ([400, 401, 404, 409, 413, 426].includes(error.status)) return refused();
      }
      unresolved = !!allowOwnerReply;
      if (Date.now() >= until()) return { body, delivery: "unconfirmed" };
      if (body.outcome === "answered" && body.answer.format !== undefined && error instanceof ExternalRelayError && error.status === 429 && error.retryAfterSeconds !== null) wait = Math.max(1, error.retryAfterSeconds * 1000);
      await new Promise(resolve => setTimeout(resolve, Math.min(wait, Math.max(0, until() - Date.now()))));
      wait = Math.min(wait * 2, 5000);
    }
  }
}
