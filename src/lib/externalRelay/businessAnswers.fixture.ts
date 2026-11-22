import { sampleRequest } from "./request.fixture";
import type { ExternalRelayAnswer, ExternalRelayRequest } from "./protocol";

export const businessFeature = "relay_business_answers";
export const isolatedRequesterFeature = "relay_isolated_requesters";
export const photoRef = `media_${"0".repeat(31)}1`;
export const answerText = "I can see the scene.";
const context = "requester_context";
const inbound = "relay_media_in";
const history = "relay_history_media";
const anchor = "message_anchor";
const photo = "message_history";
const contact = { key: "person_contact", name: "Contact", self: false };
const owner = { key: "person_owner", name: "Owner", self: false };

export const cases = [
  "business_contact", "business_owner", "guest_non_owner",
  "private_non_owner", "group_non_owner", "legacy_no_business",
] as const;

/** Partner basename map: answer_pair_business_contact.json, answer_pair_business_owner.json,
 * answer_pair_guest_non_owner.json, answer_pair_private_non_owner.json,
 * answer_pair_group_non_owner.json, answer_pair_legacy_no_business.json.
 * All wire data is synthetic; private includes the pinned contract's discriminator. */
export function answerPair(kind: typeof cases[number], imageBytes = 1, historyFeature = false) {
  const isBusiness = kind === "business_contact" || kind === "business_owner";
  const isGuest = kind === "guest_non_owner";
  const isPrivate = kind === "private_non_owner";
  const isolated = isBusiness || isGuest || isPrivate;
  const isLegacy = kind === "legacy_no_business";
  const isOwner = kind === "business_owner";
  const hasPhoto = kind === "business_contact" || isPrivate;
  const author = isOwner ? owner : contact;
  const advertised = isLegacy ? [] : [context,
    ...(isBusiness ? [businessFeature] : []),
    ...(hasPhoto ? [inbound] : []),
    ...(isGuest ? ["relay_guest_answers"] : []),
    ...(!isBusiness && (isGuest || isPrivate) ? [isolatedRequesterFeature] : [])];
  const earlier: ExternalRelayRequest["input"]["conversation"][number] = {
    id: photo, author: contact, sent_at: "2026-01-01T12:00:00Z", text: "A view from the garden.", reply_to: null,
    ...(hasPhoto ? { media: [{ ref: photoRef, kind: "photo", availability: "ready",
      mime_type: "image/png", byte_size: imageBytes, expires_at: "2099-01-01T00:00:00Z" }] } : {}),
  };
  const request: ExternalRelayRequest = {
    ...sampleRequest, request_id: `request_${kind}`, claimed_at: "2026-01-01T12:00:02Z",
    ...(isBusiness ? { delivery: "business" } : isGuest ? { delivery: "guest" } : isPrivate ? { delivery: "private" } : {}),
    ...(hasPhoto ? { features: [inbound, ...(isBusiness && historyFeature ? [history] : [])] } : {}),
    chat: { key: "chat_fixture_garden" },
    input: {
      instructions: "Answer about the garden.",
      owner_instructions: null,
      documents: [],
      conversation: [earlier, { id: anchor, author, sent_at: "2026-01-01T12:00:01Z", text: "What do you see?", reply_to: null }],
      respond_to: anchor,
      request_text: "What do you see?",
      ...(!isLegacy ? {
        requester: { key: author.key, is_owner: isOwner, is_admin: false, can_restrict_members: false,
          can_delete_messages: false, is_anonymous_admin: false },
        short_term_memory: null,
        tools: isolated ? [] : [{ name: "garden_guide", summary: "Find the garden guide.", mode: "handoff" }],
      } : {}),
    },
    answer: { max_chars: 240, progress: isolated ? "none" : "notes" },
  };
  return {
    request, advertised, isolated, hasPhoto, anchor, defaultAccepts: !isolated,
    modelReplyTo: isolated ? photo : anchor,
    expectedAnswer: { action: "reply", text: answerText, reply_to: isolated ? null : anchor } satisfies ExternalRelayAnswer,
  };
}
