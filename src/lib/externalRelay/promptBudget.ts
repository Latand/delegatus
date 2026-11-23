import { MAX_STRUCTURED_TEXT_BYTES, StructuredEnvelopeTooLargeError } from "@/lib/runtime/structuredContent";
import { visibleRelayTools, type ExternalRelayRequest } from "./protocol";

type Message = ExternalRelayRequest["input"]["conversation"][number];
type Rendered = { prompt: string };
const RECENT_HISTORY_ROWS = 10;
export type RelayPromptCuts = {
  older_message_texts_omitted?: number;
  documents_omitted?: number;
  tool_summaries_shortened?: number;
  tool_entries_omitted?: number;
};

export class RelayMandatoryPromptTooLargeError extends StructuredEnvelopeTooLargeError {
  constructor(public readonly mandatoryBytes: number) { super(); }
}

/** Cap tool summaries at Unicode boundaries before measuring the escaped prompt. */
function quotedRelayText(text: string, maxBytes: number): string {
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

export function requiredRelayMessageIds(conversation: readonly Message[], triggerId: string | null,
  recovered: readonly Message[], requiredIds: readonly string[] = []): Set<string> {
  const triggerIndex = conversation.findIndex(message => message.id === triggerId);
  const recent = triggerIndex < 0 ? [] : conversation.slice(Math.max(0, triggerIndex - RECENT_HISTORY_ROWS), triggerIndex + 1);
  const required = new Set([...requiredIds, ...recent.map(message => message.id)]);
  const messages = new Map([...conversation, ...recovered].map(message => [message.id, message]));
  const visited = new Set<string>();
  // An explicit reply and its ancestors can be outside the recent window.
  for (const start of [triggerId, ...requiredIds]) {
    for (let id = start; id && !visited.has(id); id = messages.get(id)?.reply_to ?? null) {
      visited.add(id);
      required.add(id);
    }
  }
  return required;
}

/** Preserve the trigger, recent window, explicit reply chains and memory.
 * Try smaller tool projections before trimming older rows. A refusal here
 * lets the owner runner deliver the full context through its run directory. */
export function boundedRelayPrompt<T extends Rendered>(request: ExternalRelayRequest,
  render: (request: ExternalRelayRequest, cuts: RelayPromptCuts) => T, requiredIds: ReadonlySet<string>, mayOmitToolTable: boolean,
): T {
  const input = request.input;
  const fits = (result: T) => Buffer.byteLength(result.prompt) <= MAX_STRUCTURED_TEXT_BYTES;
  const original = render(request, {});
  if (fits(original)) return original;

  const tools = visibleRelayTools(request);
  const compactCuts: RelayPromptCuts = {};
  let compactTools = input.tools;
  for (const cap of [256, 128, 64, 32, 0]) {
    const summaries = new Map(tools.map(tool => [tool.name, cap ? quotedRelayText(tool.summary, cap) : ""]));
    const shortened = tools.filter(tool => summaries.get(tool.name) !== tool.summary).length;
    if (!shortened) continue;
    compactCuts.tool_summaries_shortened = shortened;
    compactTools = input.tools?.map(tool => ({ ...tool, summary: summaries.get(tool.name) ?? tool.summary }));
    const result = render({ ...request, input: { ...input, tools: compactTools } }, compactCuts);
    if (fits(result)) return result;
  }

  const protectedRows = input.conversation.filter(message => requiredIds.has(message.id));
  const mediaRefs = new Set(protectedRows.flatMap(message => message.media?.map(media => media.ref) ?? []));
  const protectedDocuments = input.documents.filter(document =>
    document.message_id && requiredIds.has(document.message_id) || document.media_ref && mediaRefs.has(document.media_ref)
    || !document.message_id && !document.media_ref && protectedRows.some(message =>
      message.text.includes(`[Document attached; filename=${document.title};`)));

  if (mayOmitToolTable && tools.length) {
    // The tool table is discoverable through the relay service. Omit its
    // display projection before sacrificing any conversation history.
    const toolCuts = { tool_entries_omitted: tools.length };
    const withAllHistory = render(request, toolCuts);
    if (fits(withAllHistory)) return withAllHistory;
  }

  // Local recovery can append older rows. Select by timestamp, then retain
  // the order of the rows in the claim when rendering them.
  const optional = input.conversation.map((message, index) => ({ message, index }))
    .filter(({ message }) => !requiredIds.has(message.id))
    .sort((a, b) => Date.parse(a.message.sent_at) - Date.parse(b.message.sent_at) || a.index - b.index);
  let smallestBytes = Buffer.byteLength(original.prompt);
  const fitHistory = (candidate: ExternalRelayRequest["input"], cuts: RelayPromptCuts): { result: T; omitted: number } | null => {
    const withOldestRemoved = (count: number) => {
      if (!count) return render({ ...request, input: candidate }, cuts);
      const removed = new Set(optional.slice(0, count).map(({ message }) => message.id));
      return render({ ...request, input: { ...candidate, conversation: input.conversation.filter(message => !removed.has(message.id)) } },
        { ...cuts, older_message_texts_omitted: count });
    };
    let bestCount = optional.length;
    let best = withOldestRemoved(bestCount);
    smallestBytes = Math.min(smallestBytes, Buffer.byteLength(best.prompt));
    if (!fits(best)) return null;
    let low = 0, high = optional.length - 1;
    while (low <= high) {
      const count = Math.floor((low + high) / 2);
      const result = withOldestRemoved(count);
      if (fits(result)) { best = result; bestCount = count; high = count - 1; }
      else low = count + 1;
    }
    return { result: best, omitted: bestCount };
  };

  const compact = { ...input, tools: compactTools };
  // Compare the best fitting history under both projections. Removing the
  // discoverable table can retain more recent rows than compacting summaries.
  const candidates: Array<{ result: T; omitted: number }> = [];
  const compactResult = fitHistory(compact, compactCuts);
  if (compactResult) candidates.push(compactResult);
  if (compactTools !== input.tools) {
    const originalToolsResult = fitHistory(input, {});
    if (originalToolsResult) candidates.push(originalToolsResult);
  }
  if (mayOmitToolTable && tools.length) {
    const toolCuts = { tool_entries_omitted: tools.length };
    for (const toolInput of [compact, input]) {
      if (toolInput === input && compactTools === input.tools) continue;
      const omittedTableResult = fitHistory(toolInput, toolCuts);
      if (omittedTableResult) candidates.push(omittedTableResult);
    }
  }
  if (candidates.length) return candidates.reduce((best, candidate) => candidate.omitted < best.omitted ? candidate : best).result;
  let result: { result: T; omitted: number } | null;
  const documentsOmitted = input.documents.length - protectedDocuments.length;
  const documentCuts = documentsOmitted ? { documents_omitted: documentsOmitted } : {};
  if (documentsOmitted) {
    result = fitHistory({ ...compact, documents: protectedDocuments }, { ...compactCuts, ...documentCuts });
    if (result) return result.result;
  }
  if (mayOmitToolTable && tools.length) {
    const toolCuts = { tool_entries_omitted: tools.length };
    result = fitHistory({ ...compact, documents: protectedDocuments }, { ...compactCuts, ...documentCuts, ...toolCuts });
    if (!result) result = fitHistory({ ...input, documents: protectedDocuments }, { ...documentCuts, ...toolCuts });
    if (result) return result.result;
  }
  throw new RelayMandatoryPromptTooLargeError(smallestBytes);
}
