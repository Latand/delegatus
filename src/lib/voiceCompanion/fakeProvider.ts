import type { LiveCommand, LiveConnection, LiveProvider } from "./provider";
import type { Locale } from "./contract";
import type { BackendRequest } from "./sessionConfig";

type Item = Record<string, unknown>;
const APPENDS = new Set(["session.commentary.append", "session.thinking.append", "session.instructions.append"]);
const APPEND_LIMIT_BYTES = 500;
/** A Responses result in the documented shape: output items and usage. */
export function backendResponse(id: string, output: Item[], usage: Item = { input_tokens: 100, input_tokens_details: { cached_tokens: 50 }, output_tokens: 20 }) {
  return { id, object: "response", status: "completed", output, usage };
}
export const functionCall = (callId: string, name: string, args: Item = {}): Item =>
  ({ type: "function_call", id: `fc_${callId}`, call_id: callId, name, arguments: JSON.stringify(args), status: "completed" });
export const message = (text: string): Item =>
  ({ type: "message", id: `msg_${text.length}`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });
/** Documented `session.delegation.created` for client delegation: metadata only, no task text. */
export const delegationCreated = (id: string, offsetMs: number) =>
  ({ type: "session.delegation.created", event_id: `event-${id}`, offset_ms: offsetMs, delegation: { id, type: "delegation", target: "client" } });

/** Local documented-event provider; owns no network or credential reader.
 * Events use the official Live schemas and Responses results linked in the
 * research note. A test decides their ordering, including transport loss. */
export class FakeLiveProvider implements LiveProvider {
  readonly commands: LiveCommand[] = [];
  readonly sessions: Array<{ id: string; locale: Locale; sdp: string }> = [];
  private readonly receivers = new Map<string, { event(value: unknown): void; lost(): void }>();
  private readonly disconnected = new Set<string>();
  autoClose = true;
  /** Every hangup asked, including the ones that failed. */
  readonly hangups: string[] = [];
  /** Hangups that answer with a provider failure before one succeeds. */
  hangupFailures = 0;
  /** How the next mints fail, oldest first: "lost" creates the session and loses
   * the answer (a timeout after the provider accepted the request); "refused" is
   * the provider's own answer that nothing was created; "hang" never answers. */
  createFailures: Array<"lost" | "refused" | "hang"> = [];
  /** The answer a mint returns; a test may make it echo something. */
  answer: (fallbackId: string) => { id?: string; sdp: string } = () => ({ sdp: "v=0\r\ns=fake-answer\r\n" });
  /** Every backend request this server paid for and sent, in order. */
  readonly requests: BackendRequest[] = [];
  /** How a backend request is answered. Defaults to one spoken sentence. */
  responder: (request: BackendRequest, index: number) => unknown | Promise<unknown> = (_request, index) => backendResponse(`resp_fake_${index + 1}`, [message("Done.")]);
  async hangup(id: string) {
    this.hangups.push(id);
    if (this.hangupFailures > 0) { this.hangupFailures -= 1; throw new Error("PROVIDER_ERROR"); }
  }
  async create(_key: string, locale: Locale, sdp: string) {
    const failure = this.createFailures.shift();
    if (failure === "refused") throw new Error("PROVIDER_REFUSED");
    const fallback = `live_fake_${this.sessions.length + 1}`;
    const answer = this.answer(fallback);
    const id = answer.id ?? fallback;
    this.sessions.push({ id, locale, sdp });
    if (failure === "lost") throw new Error("PROVIDER_ERROR");
    if (failure === "hang") return new Promise<never>(() => undefined);
    return { id, sdp: answer.sdp };
  }
  async respond(_key: string, request: BackendRequest, signal: AbortSignal): Promise<unknown> {
    const index = this.requests.push(JSON.parse(JSON.stringify(request)) as BackendRequest) - 1;
    const result = await Promise.race([this.responder(request, index),
      new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("PROVIDER_ERROR")), { once: true }))]);
    return result;
  }
  async attach(id: string, _key: string, event: (value: unknown) => void, lost: () => void): Promise<LiveConnection> {
    this.receivers.set(id, { event, lost });
    return { send: command => {
      if (this.disconnected.has(id)) throw new Error("PROVIDER_ERROR");
      // Commentary, thinking and instructions take at most 500 tokens. A token
      // holds at least one byte, so text past 500 UTF-8 bytes may be over the
      // limit, and the fake answers it with the documented error event.
      if (APPENDS.has(command.type) && (typeof command.content !== "string" || Buffer.byteLength(command.content) > APPEND_LIMIT_BYTES)) {
        this.refused.push(command);
        queueMicrotask(() => this.replay(id, { type: "error", event_id: `${id}-refused-${this.refused.length}`,
          error: { type: "invalid_request_error", code: "string_above_max_length", param: "content", message: "Content is limited to 500 tokens." } }));
        return;
      }
      this.commands.push(command);
      if (command.type === "session.close" && this.autoClose)
        queueMicrotask(() => this.replay(id, { type: "session.closed", event_id: `${id}-closed`, reason: "close_requested", session: { id }, usage: { seconds: 18 } }));
    }, dispose: () => { this.receivers.delete(id); } };
  }
  /** Appended text the provider would refuse: over its documented 500 tokens. */
  readonly refused: LiveCommand[] = [];
  replay(id: string, ...events: unknown[]): void { for (const event of events) this.receivers.get(id)?.event(event); }
  disconnect(id: string): void { this.disconnected.add(id); this.receivers.get(id)?.lost(); }
  get attached() { return this.receivers.size; }
}
