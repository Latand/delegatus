import type { GateRefusal } from "./gate";
export type DelegationCode = GateRefusal | "invalid_instruction" | "already_requested" | "not_admitted" | "session_closed"
  | "duplicate_proposal" | "proposal_unavailable" | "proposal_changed" | "operator_cancelled" | "confirmation_expired"
  | "not_requested" | "operator_refused" | "request_not_waiting" | "request_other_project";
export const DELEGATION_REASONS: Record<DelegationCode, string> = {
  no_orchestrator: "This project has no designated orchestrator, so nothing was sent.",
  invalid_instruction: "The request text is empty or too long.", empty_instruction: "The request text is empty or too long.",
  already_requested: "That request was already raised. Nothing new was sent.",
  not_admitted: "The request could not be admitted.", session_closed: "The voice session has ended.",
  duplicate_proposal: "A request from this turn is already waiting.", proposal_unavailable: "That request is no longer available.",
  proposal_changed: "The request expired, changed, or its orchestrator changed before confirmation.",
  operator_cancelled: "The operator declined the request.", confirmation_expired: "The confirmation was not answered in time.",
  source_changed: "The operator took the request back.", retracted: "The operator took the request back.",
  no_input: "No operator utterance is available.", not_final: "The operator's utterance is still arriving.",
  stale_input: "The request refers to an earlier utterance.", negated: "The operator asked for nothing to be sent.",
  conditional: "The request is conditional.", question: "The utterance is a question about sending.", quoted: "The send request is quoted.",
  not_imperative: "The utterance does not ask to send.", not_addressed: "The request is not addressed to the orchestrator.",
  not_confirmed: "The confirmation must come in a later operator turn.", not_requested: "The operator did not request a send.",
  operator_refused: "The operator asked for nothing to be sent.",
  request_not_waiting: "That earlier request is not waiting for a report: it was never sent or its delivery failed. Nothing was sent.",
  request_other_project: "That waiting request went to another project's orchestrator, so this ask is not a repeat of it. Nothing was sent.",
};
/** Delivery-failure codes the owner reads as a sentence. Any other code is not shown: the generic sentence stands. */
const DELIVERY_FAILURES: Record<string, { en: string; uk: string }> = {
  conversation_busy: { en: "the orchestrator's conversation was busy", uk: "розмова оркестратора була зайнята" },
  conversation_closed: { en: "the orchestrator's conversation is closed", uk: "розмову оркестратора закрито" },
  member_required: { en: "the call's starter is no longer a team member", uk: "той, хто розпочав розмову, більше не учасник команди" },
  voice_seat_changed: { en: "the orchestrator changed before delivery", uk: "оркестратор змінився до доставки" },
};
/** The route answers its codes in capitals (`CONVERSATION_CLOSED`); the table is keyed in lower case. */
const knownFailure = (code?: string | null) => { const key = code?.toLowerCase(); return key && Object.hasOwn(DELIVERY_FAILURES, key) ? DELIVERY_FAILURES[key] : null; };
export function deliveryFailureReason(code?: string): string {
  const known = knownFailure(code);
  return known ? `The message was not delivered: ${known.en}, so nothing was sent.` : "The delivery failed. Nothing reached the orchestrator.";
}
/** The same reasons as the owner reads them in Ukrainian. The model and the record keep the English ones. */
const DELEGATION_REASONS_UK: Record<DelegationCode, string> = {
  no_orchestrator: "У цього проєкту немає призначеного оркестратора, тож нічого не надіслано.",
  invalid_instruction: "Текст запиту порожній або задовгий.", empty_instruction: "Текст запиту порожній або задовгий.",
  already_requested: "Цей запит уже надсилали. Нічого нового не надіслано.",
  not_admitted: "Запит не вдалося прийняти.", session_closed: "Голосову розмову завершено.",
  duplicate_proposal: "Запит із цієї репліки вже чекає.", proposal_unavailable: "Цей запит більше недоступний.",
  proposal_changed: "Запит застарів, змінився або змінився його оркестратор до підтвердження.",
  operator_cancelled: "Ви відхилили запит.", confirmation_expired: "На підтвердження не відповіли вчасно.",
  source_changed: "Ви забрали запит назад.", retracted: "Ви забрали запит назад.",
  no_input: "Немає вашої репліки.", not_final: "Ваша репліка ще надходить.",
  stale_input: "Запит стосується давнішої репліки.", negated: "Ви просили нічого не надсилати.",
  conditional: "Запит був умовним.", question: "Репліка була питанням про надсилання.", quoted: "Прохання надіслати було цитатою.",
  not_imperative: "Репліка не просить нічого надіслати.", not_addressed: "Запит не адресовано оркестратору.",
  not_confirmed: "Підтвердження має прийти в наступній вашій репліці.", not_requested: "Ви не просили нічого надсилати.",
  operator_refused: "Ви просили нічого не надсилати.",
  request_not_waiting: "Той давніший запит не чекає звіту: його не надіслали або доставка не вдалася. Нічого не надіслано.",
  request_other_project: "Той запит, що чекає, пішов оркестратору іншого проєкту, тож це прохання не є його повтором. Нічого не надіслано.",
};
/** Why a request ended as it did, in the owner's language, from the code its record keeps; null when its stage
 * needs no reason or the code is not one of these, and the recorded reason then stands as it is. */
export function delegationReason(code: string | null | undefined, stage: string, locale: "en" | "uk"): string | null {
  if (stage === "failed") {
    if (locale === "en") return deliveryFailureReason(code ?? undefined);
    const known = knownFailure(code);
    return known ? `Повідомлення не доставлено: ${known.uk}, тож нічого не надіслано.` : "Доставка не вдалася. До оркестратора нічого не дійшло.";
  }
  if (!code || !Object.hasOwn(DELEGATION_REASONS, code)) return null;
  return (locale === "uk" ? DELEGATION_REASONS_UK : DELEGATION_REASONS)[code as DelegationCode];
}

const SPOKEN_CUT = " The rest of the answer was left out.";
/** Text Live can take in one append. A longer one keeps its whole sentences
 * that fit, or else its clauses or words, and says that the rest was left out. */
export function speakable(text: string, limit = 500): string {
  if (limit <= 0) return "";
  if (Buffer.byteLength(text) <= limit) return text;
  if (limit < Buffer.byteLength(`…${SPOKEN_CUT}`)) {
    let head = "";
    for (const char of text) { if (Buffer.byteLength(head + char) > limit) break; head += char; }
    return head.trimEnd();
  }
  let room = limit - Buffer.byteLength(`…${SPOKEN_CUT}`);
  let head = "";
  for (const char of text) {
    room -= Buffer.byteLength(char);
    if (room < 0) break;
    head += char;
  }
  const end = (pattern: RegExp) => { let last = -1; for (const match of head.matchAll(pattern)) last = match.index + match[0].length; return last; };
  const at = [/[.!?…](?=\s|$)/gu, /[,;:—](?=\s|$)/gu, /\S(?=\s)/gu].map(end).find(index => index >= head.length / 3) ?? head.length;
  const kept = head.slice(0, at).trimEnd().replace(/[,;:—]$/u, ".");
  return `${/[.!?…]$/u.test(kept) ? kept : `${kept}…`}${SPOKEN_CUT}`;
}

/** Every unsuccessful send gives both backends an explicit delivery fact. */
export function nothingSent<T extends { status?: unknown; speech?: unknown }>(result: T): T | (T & { sent: false; speech: string }) {
  if (result.status === "sent") return result;
  const speech = typeof result.speech === "string" ? result.speech : "";
  return { ...result, sent: false, speech: /^Nothing (?:was|has been|new was) sent\b/iu.test(speech) ? speech : `Nothing was sent. ${speech}`.trim() };
}

export interface DeliveryFact { kind: "sent" | "nothing" | "awaiting"; speech: string }
const DELIVERY_SPEECH: Record<string, string> = {
  delivered: "The orchestrator received the request.", queued: "The request is queued for the orchestrator.",
  unknown: "The request's delivery is not confirmed yet.",
};
export function deliveryFact(result: Record<string, unknown>): DeliveryFact | null {
  if (result.status === "sent" && typeof result.delivery === "string" && DELIVERY_SPEECH[result.delivery])
    return { kind: "sent", speech: DELIVERY_SPEECH[result.delivery] };
  if (result.status === "awaiting_report")
    return { kind: "awaiting", speech: "The request is already queued; its report is pending." };
  if (result.status === "answered")
    return { kind: "sent", speech: "The orchestrator already received this request." };
  if (result.status === "awaiting_confirmation") {
    const instruction = typeof result.instruction === "string" ? result.instruction : "";
    const reason = typeof result.confirmationReason === "string" ? result.confirmationReason
      : typeof result.reason === "string" ? result.reason : "";
    const sentence = (text: string) => `${text.trim().replace(/[.!?…]+$/u, "")}.`;
    const request = instruction ? ` I would send: ${sentence(speakable(instruction, 180))}` : "";
    const confirmation = reason ? ` Confirmation reason: ${sentence(speakable(reason, 100))}` : "";
    return { kind: "awaiting", speech: `Nothing has been sent.${request}${confirmation} Ask the operator whether to send it; their spoken yes or no or the card's buttons will confirm.` };
  }
  const fixed: Record<string, string> = {
    too_long: "Nothing was sent: the task was too long. Ask the operator to say it more briefly.",
    check_waiting: "Nothing was sent yet: a similar request already waits for the orchestrator's answer. Ask the operator whether this repeats it.",
    nothing_waiting: "No confirmation is waiting, so nothing was sent.",
  };
  const speech = fixed[String(result.status)] ?? (result.code === "private_history_boundary" ? String(result.speech)
    : typeof result.reason === "string" && result.reason ? result.reason : "The request could not be sent.");
  return { kind: "nothing", speech: fixed[String(result.status)] ?? String(nothingSent({ speech }).speech) };
}

/** Delivery facts reserve their bytes before the model's answer is shortened. */
export function delegationSpeech(answer: string, facts: readonly DeliveryFact[]): string {
  if (!facts.length) return speakable(answer);
  const sent = facts.filter(fact => fact.kind === "sent");
  const ordered = [...sent, ...facts.filter(fact => fact.kind !== "sent")];
  let speech = [...new Set(ordered.map(fact => fact.speech))].join(" ");
  if (Buffer.byteLength(speech) > 500) {
    // Many failures can exhaust an append. Keep all successful delivery states
    // and the latest refusal within the byte bound.
    const successes = [...new Set(sent.map(fact => fact.speech))].join(" ");
    const last = facts.findLast(fact => fact.kind !== "sent");
    speech = [successes, last ? speakable(last.speech, 500 - Buffer.byteLength(successes) - (successes ? 1 : 0)) : ""].filter(Boolean).join(" ");
  }
  if (!sent.length) return speech;
  const head = speakable(answer, 500 - Buffer.byteLength(speech) - 1);
  return [head, speech].filter(Boolean).join(" ");
}
