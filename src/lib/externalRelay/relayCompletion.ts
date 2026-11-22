import type { RelayHttpRefusal } from "./httpDiagnostics";
import { answerTooLongNotice, recordCompletionRefusal, type CompletionRefusal } from "./completionRefusal";
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
  onRefusal?: (refusal: CompletionRefusal) => void,
  onHttpRefusal?: (record: RelayHttpRefusal) => void,
): Promise<{ body: ExternalRelayCompletion; delivery: RelayAnswerDelivery; refusalCode?: string; tooLong?: true }> {
  let wait = 1000;
  let attempted = false;
  let downgraded = false;
  let attachmentRemoved = false;
  let attachmentFallbackUsed = false;
  let unresolved = false;
  let tooLong = false;
  const result = (delivery: RelayAnswerDelivery) => ({ body, delivery, ...(tooLong ? { tooLong: true as const } : {}) });
  const lengthNotice = () => {
    if (body.outcome !== "answered" || tooLong) return false;
    const text = answerTooLongNotice(plainMax);
    if (!text) return false;
    body = { ...body, answer: { action: "reply", text, reply_to: body.answer.reply_to } };
    tooLong = true;
    return true;
  };
  let refusalCode: string | undefined;
  const refused = () => ({ ...result(unresolved ? "unconfirmed" : "refused"),
    ...(refusalCode ? { refusalCode } : {}) });
  const authorizedBody = () => {
    if ((body.outcome === "answered" || body.outcome === "declined" && body.reason === "handoff")
      && allowOwnerReply && !allowOwnerReply()) body = { lease_id: body.lease_id, outcome: "failed", reason: "cancelled", detail: null };
    return body;
  };
  while (true) {
    if (attempted && Date.now() >= until()) return result("unconfirmed");
    attempted = true;
    authorizedBody();
    let responseStatus = 0;
    try {
      await relayCall(relay.api_base, `/requests/${encodeURIComponent(requestId)}/complete`, "POST", body, relay.credential,
        { timeoutMs: 5000, onResponseStatus: status => { responseStatus = status; }, maxBytes: relay.limits.max_response_bytes, onHttpRefusal,
          ...(allowOwnerReply ? { prepareBody: authorizedBody } : {}) });
      return result("accepted");
    } catch (error) {
      if (responseStatus >= 300) {
        recordCompletionRefusal(error instanceof ExternalRelayError ? error : new ExternalRelayError("unreachable"), responseStatus, requestId, onRefusal);
      }
      if (isUnknownFeatureRefusal(error)) await onUnknownFeature?.();
      if (error instanceof ExternalRelayError) {
        if (error.status === 409 && error.code === "lease_lost") refusalCode = error.code;
        if (allowOwnerReply && error.status === 409 && error.code === "already_completed") return result("unconfirmed");
        if (unresolved && error.status >= 400 && error.status < 500) return refused();
        if (tooLong && error.status >= 400 && error.status < 500 && error.status !== 429) return refused();
        const v2 = body.outcome === "answered" && body.answer.format !== undefined;
        if (v2 && body.outcome === "answered" && (error.status === 400 && error.code === "malformed" && body.answer.mentions?.length
          || error.status === 422 && (body.answer.attachments?.some(file => file.kind === "photo") || hasActiveMediaReference(body.answer.text)))) return refused();
        if (v2 && attachmentRemoved && !attachmentFallbackUsed && body.outcome === "answered" && body.answer.text.trim()
          && (error.status === 415 || error.status === 400 && error.code === "malformed" || error.status === 422 && error.code === "invalid_format")) {
          attachmentFallbackUsed = true;
          if ([...body.answer.text].length <= plainMax) {
            const { action, text, reply_to } = body.answer;
            body = { ...body, answer: { action, text, reply_to, format: "plain", buttons: [] } };
          } else if (!lengthNotice()) return refused();
          continue;
        }
        if (v2 && error.status === 409 && error.code === "already_completed") return unresolved ? refused() : { body: { lease_id: body.lease_id, outcome: "failed", reason: "invalid_answer", detail: null }, delivery: "refused" };
        if (v2 && !downgraded && (error.status === 422 && ["invalid_format", "attachment_not_ready"].includes(error.code) || error.status === 415 || error.status === 400 && error.code === "malformed")) {
          downgraded = true;
          if (body.outcome === "answered" && body.answer.text.trim() && error.status === 422 && error.code === "attachment_not_ready" && body.answer.attachments?.length) {
            const answer = { ...body.answer }; delete answer.attachments;
            if (hasActiveMediaReference(answer.text)) { body = { lease_id: body.lease_id, outcome: "failed", reason: "invalid_answer", detail: null }; continue; }
            attachmentRemoved = true;
            body = { ...body, answer };
          } else if (body.outcome === "answered" && body.answer.text.trim() && [...body.answer.text].length <= plainMax) {
            const { action, text, reply_to } = body.answer;
            body = { ...body, answer: { action, text, reply_to, format: "plain", buttons: [] } };
          } else if (body.outcome === "answered" && body.answer.text.trim()) {
            if (!lengthNotice()) return refused();
          } else body = { lease_id: body.lease_id, outcome: "failed", reason: "invalid_answer", detail: null };
          continue;
        }
        if (v2 && [415, 422].includes(error.status)) return refused();
        if (error.status === 413 && body.outcome === "answered") {
          const answer = body.answer;
          if ([...answer.text].length <= plainMax && (answer.format !== "plain"
            || answer.buttons?.length || answer.mentions?.length || answer.attachments?.length)) {
            const { action, text, reply_to } = answer;
            body = { ...body, answer: { action, text, reply_to, format: "plain", buttons: [] } };
            continue;
          }
          if ([...answer.text].length > plainMax && lengthNotice()) continue;
          return refused();
        }
        if (error.status === 409 && error.code === "handoff_after_action" && body.outcome === "declined" && body.reason === "handoff") {
          body = { lease_id: body.lease_id, outcome: "failed", reason: "invalid_answer", detail: null }; continue;
        }
        if ([400, 401, 404, 409, 413, 426].includes(error.status)) return refused();
      }
      unresolved = !!allowOwnerReply;
      if (Date.now() >= until()) return result("unconfirmed");
      if (body.outcome === "answered" && (body.answer.format !== undefined || tooLong) && error instanceof ExternalRelayError && error.status === 429 && error.retryAfterSeconds !== null) wait = Math.max(1, error.retryAfterSeconds * 1000);
      await new Promise(resolve => setTimeout(resolve, Math.min(wait, Math.max(0, until() - Date.now()))));
      wait = Math.min(wait * 2, 5000);
    }
  }
}

function hasActiveMediaReference(text: string): boolean {
  const visible: string[] = [];
  let fence: { marker: string; length: number } | null = null;
  for (const line of text.split("\n")) {
    const marker = /^(?: {0,3}>[\t ]?)*(?:[\t ]*(?:[-+*]|\d+[.)])[\t ]+)?[\t ]*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker?.[0] === fence.marker && marker.length >= fence.length) fence = null;
      continue;
    }
    if (marker) { fence = { marker: marker[0]!, length: marker.length }; continue; }
    visible.push(line);
  }
  const source = visible.join("\n").replace(/(`+)([\s\S]*?)\1/g, "");
  return /(?<!\\)!\[[^\]]*\]\(attachment:[A-Za-z0-9_-]{1,64}\)/.test(source);
}
