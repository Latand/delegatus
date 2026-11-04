import { MAX_STRUCTURED_TEXT_BYTES, StructuredEnvelopeTooLargeError } from "@/lib/runtime/structuredContent";
import type { ExternalRelayRequest } from "./protocol";

type Message = ExternalRelayRequest["input"]["conversation"][number];
const QUOTED_TEXT_BYTES = 4096;

/** Clip optional quotations at Unicode boundaries; measure the final escaped
 * prompt separately, because JSON can expand even short source strings. */
export function quotedRelayText(text: string, maxBytes = QUOTED_TEXT_BYTES): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const suffix = "\n[Earlier text omitted]";
  let result = "", bytes = Buffer.byteLength(suffix);
  for (const point of text) {
    const size = Buffer.byteLength(point);
    if (bytes + size > maxBytes) break;
    result += point; bytes += size;
  }
  return result + suffix;
}

/** Rebuild complete sections under the receiver's actual UTF-8 bound. Keep
 * current input and its immediate parent whole, including recovered parents.
 * Refuse before dispatch when mandatory content alone cannot fit. */
export function boundedRelayPrompt<T extends string | { prompt: string }>(request: ExternalRelayRequest,
  render: (request: ExternalRelayRequest) => T, extraMessages: readonly Message[] = [], maxBytes = MAX_STRUCTURED_TEXT_BYTES,
): { request: ExternalRelayRequest; result: T } {
  let current = request;
  let result = render(current);
  const fits = () => Buffer.byteLength(typeof result === "string" ? result : result.prompt) <= maxBytes;
  if (fits()) return { request: current, result };
  const messages = new Map(request.input.conversation.map(message => [message.id, message]));
  for (const message of extraMessages) messages.set(message.id, message);
  const trigger = messages.get(request.input.respond_to ?? "");
  const protectedIds = new Set([request.input.respond_to, trigger?.reply_to]);
  current = { ...request, input: { ...request.input, conversation: [...messages.values()].map(message =>
    message.author.self && !protectedIds.has(message.id) ? { ...message, text: quotedRelayText(message.text) } : message) } };
  const refresh = () => { result = render(current); return fits(); };
  if (refresh()) return { request: current, result };
  // Local recovery can add older rows after the service window. Remove the
  // oldest timestamps first, keeping source order for ties. A binary search
  // bounds rebuilds even with the protocol's maximum history and escaping.
  const history = current.input.conversation;
  const optional = history.map((message, index) => ({ message, index }))
    .filter(({ message }) => !protectedIds.has(message.id))
    .sort((a, b) => Date.parse(a.message.sent_at) - Date.parse(b.message.sent_at) || a.index - b.index);
  const removeOldest = (count: number) => {
    const removed = new Set(optional.slice(0, count).map(({ message }) => message.id));
    current.input.conversation = history.filter(message => !removed.has(message.id));
  };
  let low = 1, high = optional.length, fitting: number | null = null;
  while (low <= high) {
    const count = Math.floor((low + high) / 2);
    removeOldest(count);
    if (refresh()) { fitting = count; high = count - 1; }
    else low = count + 1;
  }
  if (fitting !== null) { removeOldest(fitting); refresh(); return { request: current, result }; }
  removeOldest(optional.length);
  current.input.short_term_memory = null;
  if (refresh()) return { request: current, result };
  for (const document of current.input.documents.slice()) {
    if (document.message_id && protectedIds.has(document.message_id)) continue;
    current.input.documents = current.input.documents.filter(row => row !== document);
    if (refresh()) return { request: current, result };
  }
  // Optional service context follows history in the trimming order. Tool
  // identities and safety fields remain available for describe/call; only
  // their display summaries are shortened here.
  current.input.tool_guidance = undefined;
  if (refresh()) return { request: current, result };
  current.input.tools = current.input.tools?.map(tool => ({ ...tool, summary: quotedRelayText(tool.summary, 256) }));
  if (refresh()) return { request: current, result };
  if (current.input.owner_instructions) current.input.owner_instructions = quotedRelayText(current.input.owner_instructions);
  if (refresh()) return { request: current, result };
  current.input.instructions = quotedRelayText(current.input.instructions);
  if (refresh()) return { request: current, result };
  throw new StructuredEnvelopeTooLargeError();
}
