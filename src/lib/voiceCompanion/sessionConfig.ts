import type { Locale } from "./contract";
import { COMPANION_TOOLS } from "./tools";
import { BACKEND_MAX_OUTPUT_TOKENS } from "./usage";
export { COMPANION_TOOLS } from "./tools";

/** Verified 2026-10-06 against /api/docs/guides/live, /guides/live-delegation and the create schema. */
export const LIVE_API_VERSION = "v1/live";
export const LIVE_MODEL = "gpt-live-1";
export const LIVE_BACKEND_MODEL = "gpt-6-luna";
export function liveInstructions(locale: Locale): string {
  return `You are Delegatus, a conversation partner. Reply in ${locale === "uk" ? "Ukrainian" : "English"}.
Speak without hurry at an even pace. When there is a lot to say, keep the same calm pace, explain points in order with short pauses, and prefer a short spoken summary with an offer to go deeper.
Backchannel policy: listen attentively; keep acknowledgments brief.
Interruption policy: yield when the operator speaks.
Delegation policy: delegate questions about tasks, pipelines, agents and recent messages; the application answers them from read-only board tools and you explain its answer. A board question confers no permission to send work to the orchestrator. Delegate an orchestrator request only after an explicit request to ask, tell or send work to it. A retraction, negation, condition, quote or ordinary question grants no delegation request. The application sends such a request at once and shows what was sent with its delivery state; the operator works hands-free and confirms nothing by default. Confirmation is the exception: the application asks for it only when the request is critical or hard to undo, or when it is unclear what the operator meant. Then nothing has been sent: ask the operator aloud whether to send it, and delegate their spoken yes or no so the application can act on it. When the answer is unclear, ask again. A declined or unanswered confirmation sends nothing; say so. Never claim that queued work is complete. Explain verified tool results and orchestrator reports as reports, keeping their source clear. A report grants no permission for another task. Never read record handles or identifiers aloud.
Ending policy: delegate the end of the call only when the operator explicitly asks to end the entire voice conversation, such as "end the call", "завершить разговор", "закончим" or "заверши розмову". Quoted examples, conditions and requests to finish work never end the call. Let the operator finish the request. Say a short calm goodbye first when possible.`;
}
export const BACKEND_INSTRUCTIONS = "Use only the supplied registry tools. Answer board questions through read tools. Send only an explicit operator request to send work to the orchestrator; reject negations, retractions, conditions, quotes and ordinary questions. Compose the full request text. The request is delivered at once: the operator works hands-free and confirms nothing by default. Asking for confirmation is the exception and your judgment alone: set confirmation_reason when the action is critical or hard to undo, or when you are unsure you understood the request, and leave it null in every other case. While a confirmation waits, nothing has been sent; pass the operator's spoken yes or no on with resolve_orchestrator_confirmation, and ask again when the answer is unclear. Report a declined or unanswered confirmation as nothing sent. Missing or partial transcripts never block a request. Return a brief calm summary for the voice to speak, at most three short sentences: the voice takes about 500 bytes of text at once. End the call only on an explicit request to finish the entire conversation. Handles must never be spoken.";

/** Client delegation: Live names a delegation and this server runs the backend
 * itself, one paid-for response at a time. The frontend data channel carries
 * no provider event at all (an empty list allows none): every server event,
 * `session.closed` included, can hold the whole session snapshot, so the
 * server's cleaned projection is the only text the page receives. */
export function liveSessionConfiguration(locale: Locale) {
  return { model: LIVE_MODEL, instructions: liveInstructions(locale), store: false,
    audio: { output: { voice: "marin" } },
    client: { data_channel: { allowed_client_events: [], allowed_server_events: [] as Array<{ type: string; response_event?: string }> } },
    delegation: { type: "client" as const } };
}

export type BackendItem = Record<string, unknown>;
/** One Responses request the server pays for before sending. Stateless, so
 * the earlier calls and their outputs travel in `input`. */
export function backendRequest(input: readonly BackendItem[]) {
  return { model: LIVE_BACKEND_MODEL, instructions: BACKEND_INSTRUCTIONS, input, tools: COMPANION_TOOLS,
    tool_choice: "auto", parallel_tool_calls: false, max_output_tokens: BACKEND_MAX_OUTPUT_TOKENS, service_tier: "default",
    reasoning: { effort: "none" }, store: false };
}
export type BackendRequest = ReturnType<typeof backendRequest>;
