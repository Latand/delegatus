import { MAX_STRUCTURED_TEXT_BYTES, StructuredEnvelopeTooLargeError } from "@/lib/runtime/structuredContent";
import type { ExternalRelayRequest } from "./protocol";

type Message = ExternalRelayRequest["input"]["conversation"][number];
const QUOTED_TEXT_BYTES = 4096;

export class RelayMandatoryPromptTooLargeError extends StructuredEnvelopeTooLargeError {
  constructor(public readonly mandatoryBytes: number) { super(); }
}

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
  requiredIds: readonly string[] = [],
): { request: ExternalRelayRequest; result: T } {
  let current = request;
  let result = render(current);
  const fits = () => Buffer.byteLength(typeof result === "string" ? result : result.prompt) <= maxBytes;
  if (fits()) return { request: current, result };
  const messages = new Map(request.input.conversation.map(message => [message.id, message]));
  for (const message of extraMessages) messages.set(message.id, message);
  const trigger = messages.get(request.input.respond_to ?? "");
  const protectedIds = new Set([request.input.respond_to, ...requiredIds]);
  // Follow explicit links, including recovered parents and earlier requests.
  // Selection cannot remove a row that explains the requested subject.
  const visited = new Set<string>();
  for (const id of [trigger?.id, ...requiredIds]) {
    for (let message: Message | undefined = id ? messages.get(id) : undefined;
      message?.reply_to && !visited.has(message.reply_to);) {
      visited.add(message.reply_to);
      protectedIds.add(message.reply_to);
      message = messages.get(message.reply_to);
    }
  }
  current = { ...request, input: { ...request.input, conversation: [...messages.values()] } };
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
  const protectedRows = [...messages.values()].filter(message => protectedIds.has(message.id));
  const mediaRefs = new Set(protectedRows.flatMap(message => message.media?.map(media => media.ref) ?? []));
  for (const document of current.input.documents.slice()) {
    if (document.message_id && protectedIds.has(document.message_id) || document.media_ref && mediaRefs.has(document.media_ref)
      || !document.message_id && !document.media_ref && protectedRows.some(message =>
        message.text.includes(`[Document attached; filename=${document.title};`))) continue;
    current.input.documents = current.input.documents.filter(row => row !== document);
    if (refresh()) return { request: current, result };
  }
  // Optional service context follows history in the trimming order. Tool
  // identities and safety fields remain available for describe/call; only
  // their display summaries are shortened here.
  current.input.tool_guidance = undefined;
  if (refresh()) return { request: current, result };
  const tools = current.input.tools;
  for (const cap of [256, 128, 64, 32, 0]) {
    current.input.tools = tools?.map(tool => ({ ...tool, summary: cap ? quotedRelayText(tool.summary, cap) : "" }));
    if (refresh()) return { request: current, result };
  }
  // Instructions, requested quotations, documents and tool identities are
  // mandatory. Never silently shorten them to obtain a successful launch.
  throw new RelayMandatoryPromptTooLargeError(Buffer.byteLength(typeof result === "string" ? result : result.prompt));
}
