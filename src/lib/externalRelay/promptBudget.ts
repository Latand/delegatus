import { MAX_STRUCTURED_TEXT_BYTES, StructuredEnvelopeTooLargeError } from "@/lib/runtime/structuredContent";
import type { ExternalRelayRequest } from "./protocol";

type Message = ExternalRelayRequest["input"]["conversation"][number];
const QUOTED_TEXT_BYTES = 4096;
const QUOTED_TEXT_MARKER = "\n[Quoted text shortened; beginning and end kept]\n";

/** Clip optional quotations at Unicode boundaries; measure the final escaped
 * prompt separately, because JSON can expand even short source strings. */
export function quotedRelayText(text: string, maxBytes = QUOTED_TEXT_BYTES): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const marker = QUOTED_TEXT_MARKER;
  if (maxBytes < Buffer.byteLength(marker)) return marker.slice(0, maxBytes);
  const bytes = Buffer.from(text);
  const available = Math.max(0, maxBytes - Buffer.byteLength(marker));
  let head = Math.floor(available / 2), tail = bytes.length - (available - head);
  while (head > 0 && (bytes[head]! & 0xc0) === 0x80) head--;
  while (tail < bytes.length && (bytes[tail]! & 0xc0) === 0x80) tail++;
  return bytes.subarray(0, head).toString("utf8") + marker + bytes.subarray(tail).toString("utf8");
}

/** Rebuild complete sections under the receiver's actual UTF-8 bound. Keep
 * current input whole and its immediate parent present, including recovered parents.
 * Refuse before dispatch when mandatory content alone cannot fit. */
export function boundedRelayPrompt<T extends string | { prompt: string }>(request: ExternalRelayRequest,
  render: (request: ExternalRelayRequest, quotationBytes: number) => T, extraMessages: readonly Message[] = [], maxBytes = MAX_STRUCTURED_TEXT_BYTES,
): { request: ExternalRelayRequest; result: T } {
  let current = request;
  let quotationBytes = Infinity;
  let result = render(current, quotationBytes);
  const fits = () => Buffer.byteLength(typeof result === "string" ? result : result.prompt) <= maxBytes;
  if (fits()) return { request: current, result };
  const messages = new Map(request.input.conversation.map(message => [message.id, message]));
  for (const message of extraMessages) messages.set(message.id, message);
  const trigger = messages.get(request.input.respond_to ?? "");
  const protectedIds = new Set([request.input.respond_to, trigger?.reply_to]);
  current = { ...request, input: { ...request.input, conversation: [...messages.values()].map(message =>
    message.author.self && !protectedIds.has(message.id) ? { ...message, text: quotedRelayText(message.text) } : message) } };
  const refresh = () => { result = render(current, quotationBytes); return fits(); };
  if (refresh()) return { request: current, result };
  // Once unprotected rows have had the ordinary excerpt cap, remove the
  // oldest rows before applying smaller excerpts to the explicit reply.
  const initialHistory = current.input.conversation;
  const initialOptional = initialHistory.map((message, index) => ({ message, index }))
    .filter(({ message }) => !protectedIds.has(message.id))
    .sort((a, b) => Date.parse(a.message.sent_at) - Date.parse(b.message.sent_at) || a.index - b.index);
  const removeInitialOldest = (count: number) => {
    const removed = new Set(initialOptional.slice(0, count).map(({ message }) => message.id));
    current.input.conversation = initialHistory.filter(message => !removed.has(message.id));
  };
  let initialLow = 1, initialHigh = initialOptional.length, initialFitting: number | null = null;
  while (initialLow <= initialHigh) {
    const count = Math.floor((initialLow + initialHigh) / 2);
    removeInitialOldest(count);
    if (refresh()) { initialFitting = count; initialHigh = count - 1; }
    else initialLow = count + 1;
  }
  if (initialFitting !== null) { removeInitialOldest(initialFitting); refresh(); return { request: current, result }; }
  removeInitialOldest(initialOptional.length);
  refresh();
  // The reply target is data too. Previously its protected identity also
  // protected its entire text, bypassing the quotation cap in the renderer.
  // Measure the complete escaped render after each cut, including local
  // metadata and report context supplied by the owner renderer.
  const replyTargetId = trigger?.reply_to;
  for (const budget of [4096, 2048, 1024, 512]) {
    quotationBytes = budget;
    current.input.conversation = current.input.conversation.map(message => message.id === request.input.respond_to || message.id === replyTargetId
      ? message : { ...message, text: quotedRelayText(message.text, budget) });
    if (refresh()) return { request: current, result };
  }
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
  const trimServiceText = (field: "owner_instructions" | "instructions") => {
    const original = current.input[field];
    if (!original) return false;
    const minimum = Buffer.byteLength(QUOTED_TEXT_MARKER);
    let low = minimum, high = Math.min(QUOTED_TEXT_BYTES, Buffer.byteLength(original));
    const apply = (budget: number) => { current.input[field] = quotedRelayText(original, budget); };
    apply(high);
    if (refresh()) return true;
    apply(low);
    if (!refresh()) return false;
    let best = low;
    while (low <= high) {
      const budget = Math.floor((low + high) / 2);
      apply(budget);
      if (refresh()) { best = budget; low = budget + 1; }
      else high = budget - 1;
    }
    apply(best);
    return refresh();
  };
  if (trimServiceText("owner_instructions")) return { request: current, result };
  if (trimServiceText("instructions")) return { request: current, result };
  // The explicit reply is protected while history, memory, documents, tools,
  // and optional service text are reduced. Only excerpt it as a last resort.
  if (replyTargetId) {
    for (const budget of [4096, 2048, 1024, 512, 256]) {
      quotationBytes = budget;
      current.input.conversation = current.input.conversation.map(message => message.id === replyTargetId
        ? { ...message, text: quotedRelayText(message.text, budget) } : message);
      if (refresh()) return { request: current, result };
    }
  }
  throw new StructuredEnvelopeTooLargeError();
}
