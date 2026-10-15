import { createHash } from "node:crypto";
import { readSync } from "node:fs";
import { readMessagesPage, type ConversationMessage, type MessagesPage, type MessagesPageCursor, type MessagesPageSource } from "@/lib/session/messagesPage";
import { normalizeSessionLine, type SessionToolCall } from "@/lib/session/reader";
import { isViewerMcpServer } from "@/lib/mcp/presentation";
import { splitRelayMessageText } from "@/lib/orchestrator/relayText";
import { byteShort } from "./prototypeRead";
import { cleanStrings } from "./redaction";

export const SEAT_SCAN_BYTES = 2 * 1024 * 1024;
const TEXT_BYTES = 12000;
const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const time = (value: string | null) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const fingerprint = (filename: string) => createHash("sha256").update(filename).digest("hex").slice(0, 6);
const handle = (filename: string, row: ConversationMessage) => `m${row.seq.toString(36)}.${row.part ?? 0}.${fingerprint(filename)}`;
function position(filename: string, value: unknown): { seq: number; part: number } | "stale_handle" | null {
  if (typeof value !== "string") return null;
  const match = /^m([0-9a-z]+)\.(\d+)\.([0-9a-f]{6})$/u.exec(value);
  if (!match) return null;
  if (match[3] !== fingerprint(filename)) return "stale_handle";
  const seq = parseInt(match[1], 36), part = Number(match[2]);
  return Number.isSafeInteger(seq) && Number.isSafeInteger(part) ? { seq, part } : null;
}
/** A client handle must name an exact record, including on an older-page request. */
function anchor(source: MessagesPageSource, pos: { seq: number; part: number }, kind: "message" | "tool_call", redactText: (text: string) => string) {
  let bytes = 0;
  if (pos.seq > 0) {
    const boundary = Buffer.alloc(1);
    bytes = readSync(source.descriptor, boundary, 0, 1, pos.seq - 1);
    if (bytes !== 1 || boundary[0] !== 0x0a) return { row: null, bytes };
  }
  const page = readMessagesPage(source, { kinds: new Set([kind]), roles: new Set(["assistant"]), limit: 1, maxChars: 16000,
    cursor: { o: pos.seq, p: pos.part + 1, r: [] }, maxScanBytes: SEAT_SCAN_BYTES - bytes, redactText });
  const row = page.records[0];
  return { row: row?.seq === pos.seq && row.part === pos.part ? row : null, bytes: bytes + page.scanned.bytes };
}
export function turnAfter(text: string): string {
  if (text.startsWith("Seat tick — ")) return "wake";
  if (/\[Voice Delegatus (?:wrote this request|reply:)/u.test(text)) return "voice";
  if (/^(?:Prototype review decision|Operator decision|Seat decision)/u.test(text)) return "form";
  if (splitRelayMessageText(text)) return "relay";
  if (text.startsWith("Agent finished: ")) return "agent";
  return "other";
}
/** Offsets address the cleaned UTF-8 copy. Clip only after complete-record redaction. */
function chunk(text: string, offset = 0, room = TEXT_BYTES) {
  const bytes = Buffer.from(text);
  let start = Math.min(offset, bytes.length);
  while (start > 0 && start < bytes.length && (bytes[start] & 0xc0) === 0x80) start--;
  let end = Math.min(bytes.length, start + Math.max(0, room));
  while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  if (end < bytes.length) {
    const newline = bytes.lastIndexOf(0x0a, end - 1);
    // An early line break must not turn a two-chunk message into three calls.
    if (newline >= start && (bytes.length - start > 2 * TEXT_BYTES || bytes.length - newline - 1 <= TEXT_BYTES)) end = newline + 1;
  }
  return { offset: start, text: bytes.subarray(start, end).toString("utf8"), next: end < bytes.length ? end : null, bytes: bytes.length };
}
export interface SeatMessage { handle: string; time: string | null; after: string; bytes: number; text: string; rest?: { message: string; offset: number } }
export interface SeatMessages {
  speech: string; shown: number; more: boolean; before: string | null; truncated: boolean; rows?: SeatMessage[];
  item?: Omit<SeatMessage, "rest"> & { offset: number; next: number | null };
  status?: "stale_handle" | "not_found";
  scanned?: { bytes: number; capped: boolean };
}
const missing = (status: "stale_handle" | "not_found"): SeatMessages => ({ status, speech: status === "stale_handle"
  ? "The orchestrator changed. Read its latest messages for fresh handles."
  : "No such message within the bounded voice read. Older history may be outside this read.", shown: 0, more: false, before: null, truncated: false });

/** Incoming pages do not answer a reply read. All pages share one byte allowance. */
function replyPage(source: MessagesPageSource, cursor: MessagesPageCursor | null, allowance: number,
  redactText: (text: string) => string, at: number | null = null, wholeTurn = false) {
  const records: ConversationMessage[] = [];
  let spent = 0, more = false, capped = false;
  do {
    const page = readMessagesPage(source, { kinds: new Set(["message"]), roles: new Set(["assistant", "user"]),
      limit: 24, maxChars: 16000, cursor, maxScanBytes: allowance - spent, redactText });
    spent += page.scanned.bytes; capped ||= page.scanned.capped;
    records.push(...page.records); more = page.hasMore; cursor = page.cursor;
    const newest = records.findIndex(row => row.role === "assistant" && (at === null || row.ts && Date.parse(row.ts) <= at));
    if (newest >= 0 && (!wholeTurn || records.some((row, index) => index > newest && row.role === "user"))) break;
  } while (cursor && spent < allowance && !capped);
  return { records, cursor, spent, more, capped: capped || more && spent >= allowance };
}
const messageCursor = (filename: string, cursor: MessagesPageCursor) => `s${cursor.o.toString(36)}.${cursor.p}.${fingerprint(filename)}`;

/** One descriptor, no author join, no registry snapshot, and one total scan allowance. */
export function seatMessages(source: MessagesPageSource, filename: string, args: Record<string, unknown>, redactText: (text: string) => string): SeatMessages {
  if ((args.message && (args.before || args.at)) || (args.before && args.at) || (args.offset != null && !args.message)) throw new Error("INVALID_TOOL_ARGUMENTS");
  const token = args.message ?? args.before;
  const scanCursor = typeof args.before === "string" && args.before.startsWith("s");
  const pos = token ? position(filename, scanCursor ? `m${String(token).slice(1)}` : token) : null;
  if (pos === "stale_handle") return missing(pos);
  if (token && (!pos || pos.seq >= source.size)) return missing("not_found");
  const at = typeof args.at === "string" ? Date.parse(args.at) : null;
  if (at !== null && !Number.isFinite(at)) throw new Error("INVALID_TOOL_ARGUMENTS");
  const start: MessagesPageCursor | null = pos ? { o: pos.seq, p: pos.part + (args.message ? 1 : 0), r: [] } : null;
  let anchorBytes = 0;
  if (pos && !scanCursor) {
    const checked = anchor(source, pos, "message", redactText);
    if (!checked.row || checked.bytes >= SEAT_SCAN_BYTES) return missing("not_found");
    anchorBytes = checked.bytes;
  }
  const scan = replyPage(source, start, SEAT_SCAN_BYTES - anchorBytes, redactText, at);
  const { records, cursor, capped } = scan;
  const spent = anchorBytes + scan.spent;
  let more = scan.more;
  const labels = new Map<ConversationMessage, string>();
  let after = "other";
  for (const row of [...records].reverse()) { if (row.role === "user") after = turnAfter(row.sourceText ?? row.text); else labels.set(row, after); }
  const assistants = records.filter(row => row.role === "assistant");
  const target = args.message ? assistants.find(row => row.seq === pos!.seq && row.part === pos!.part)
    : at !== null ? assistants.find(row => row.ts && Date.parse(row.ts) <= at) : null;
  if (args.message || at !== null) {
    if (!target) return missing("not_found");
    let piece = chunk(target.text, Number(args.offset ?? 0));
    const base = { handle: handle(filename, target), time: time(target.ts), after: labels.get(target) ?? "other" };
    const result: SeatMessages = { speech: "One orchestrator message. Continue with message and next as offset when next is present.",
      shown: 1, more: false, before: base.handle, truncated: !!target.truncated, item: { ...base, ...piece } };
    // JSON escaping has a separate wire budget from the decoded text budget.
    while (jsonBytes(result) > 16000 && piece.text) { piece = chunk(target.text, piece.offset, Math.max(1, Buffer.byteLength(piece.text) - 512)); result.item = { ...base, ...piece }; }
    return result;
  }
  const rows: SeatMessage[] = [];
  let room = TEXT_BYTES;
  const limit = Number(args.limit ?? 6);
  // Reserve a first chunk for older replies before newer ones spend the page.
  // Each supported reply (up to two text allowances) then has at most one
  // allowance left for its own continuation, even when it is second on the page.
  const candidates: Array<{ row: ConversationMessage; minimum: number }> = [];
  let reserved = 0;
  for (const row of assistants.slice(0, limit)) {
    const firstCharacterBytes = Buffer.byteLength(String.fromCodePoint(row.text.codePointAt(0) ?? 0));
    const minimum = Math.min(TEXT_BYTES, Math.max(firstCharacterBytes, Buffer.byteLength(row.text) - TEXT_BYTES));
    if (reserved + minimum > TEXT_BYTES) break;
    candidates.push({ row, minimum }); reserved += minimum;
  }
  if (candidates.length < assistants.length) more = true;
  for (const { row, minimum } of candidates) {
    reserved -= minimum;
    if (rows.length >= limit || room <= 0) { more = true; break; }
    const id = handle(filename, row);
    let piece = chunk(row.text, 0, room - reserved);
    const base = { handle: id, time: time(row.ts), after: labels.get(row) ?? "other", bytes: piece.bytes };
    const projected = (): SeatMessage => ({ ...base, text: piece.text, ...(piece.next !== null ? { rest: { message: id, offset: piece.next } } : {}) });
    let rowRoom = room - reserved;
    while (jsonBytes([...rows, projected()]) > 14000 && rowRoom > 0) {
      rowRoom = Math.max(0, Math.min(rowRoom, Buffer.byteLength(piece.text)) - 512);
      piece = chunk(row.text, 0, rowRoom);
    }
    if (!piece.text || jsonBytes([...rows, projected()]) > 14000) { more = true; break; }
    rows.push(projected()); room -= Buffer.byteLength(piece.text);
    if (piece.next !== null) more = true;
  }
  const newest = rows[0];
  return { rows, shown: rows.length, more, before: rows.at(-1)?.handle ?? (cursor ? messageCursor(filename, cursor) : null),
    truncated: capped || assistants.some(row => row.truncated) || rows.some(row => row.rest),
    speech: byteShort(`${rows.length} orchestrator messages.${newest ? ` Newest at ${newest.time}, after ${newest.after}: ${byteShort(newest.text, 200)}` : ""} before reads OLDER messages.`, 600),
    scanned: { bytes: spent, capped } };
}

export function newestSeatReply(source: MessagesPageSource, filename: string, message: unknown, redactText: (text: string) => string) {
  if (message) {
    const pos = position(filename, message);
    if (pos === "stale_handle") return { status: pos };
    if (!pos || typeof pos === "string") return { status: "not_found" };
    if (pos.seq >= source.size) return { status: "not_found" };
    const row = anchor(source, pos, "message", redactText).row;
    return row?.seq === pos.seq && row.part === pos.part ? { handle: String(message), time: time(row.ts), text: row.text } : { status: "not_found" };
  }
  const page = replyPage(source, null, SEAT_SCAN_BYTES, redactText, null, true);
  const newest = page.records.findIndex(row => row.role === "assistant");
  const end = page.records.findIndex((row, index) => index > newest && row.role === "user");
  const turn = page.records.slice(newest < 0 ? 0 : newest, end < 0 ? undefined : end).filter(row => row.role === "assistant");
  if (!turn.length) return { status: "not_found" };
  return { handle: handle(filename, turn[0]), time: time(turn[0].ts), text: turn.reverse().map(row => row.text).join("\n\n").slice(0, 16000) };
}

type ActionLine = (input: Record<string, unknown>, title: (kind: "task" | "pipeline", id: unknown) => string) => string | null;
const text = (value: unknown) => typeof value === "string" ? value : "";
const quoted = (value: unknown) => text(value) ? ` «${byteShort(text(value).split("\n")[0], 80)}»` : "";
const writeFields = (input: Record<string, unknown>, fields: string[]) => fields.some(key => Object.hasOwn(input, key) && input[key] !== undefined);
export const ACTION_LINES: Record<string, ActionLine> = {
  create_pipeline: input => `Started lane${quoted(input.task ?? input.title)}`,
  pipeline_action: (input, title) => {
    const lane = title("pipeline", input.pipelineId);
    const stage = quoted(input.stageId);
    const actions: Record<string, string> = {
      "retry-merge": `Put lane${lane} back in the merge queue`, "retry-stage": `Retried stage${stage} in lane${lane}`,
      "resolve-decision": `Answered lane${lane}'s decision`, "add-stage": `Added a stage to lane${lane}`,
      "override-stage": `Changed stage${stage}'s settings in lane${lane}`, "remove-stage": `Removed stage${stage} from lane${lane}`,
      "reorder-stage": `Reordered the stages of lane${lane}`, "set-edge": `Changed the next stage in lane${lane}`,
      "publish": `Published lane${lane}`, "start": `Started lane${lane}`, "takeover": `Took over lane${lane}`,
      "set-delivery-remote": `Set lane${lane}'s delivery remote`, "update-draft": `Updated draft lane${lane}`,
      "set-position": `Moved lane${lane} on the board`, "continue-review": `Continued lane${lane}'s review`,
      "accept-head": `Accepted lane${lane}'s current changes`, "convert-legacy-review": `Converted lane${lane}'s review stages`,
      "revert-legacy-review": `Restored lane${lane}'s earlier review stages`, "skip-stage": `Skipped stage${stage} in lane${lane}`,
      "link-task": `Linked a task to lane${lane}`, "unlink-task": `Unlinked a task from lane${lane}`,
      "set-src": `Changed lane${lane}'s source conversation`, "delete": `Deleted lane${lane}`,
      "dismiss": `Hid lane${lane}`, "undismiss": `Restored lane${lane} on the board`,
      "attach-link": `Attached a work link to lane${lane}`, "detach-link": `Removed a work link from lane${lane}`,
      "close": `Closed lane${lane}`, "pause": `Paused lane${lane}`, "resume": `Resumed lane${lane}`,
    };
    return input.action === "preview-legacy-review" ? null : actions[text(input.action)] ?? `Changed lane${lane}`;
  },
  create_task: input => `Created task${quoted(input.text)}`,
  update_task: (input, title) => `Updated task${title("task", input.taskId ?? input.id)}${input.status ? `: ${text(input.status)}` : ""}`,
  link_task_to_pipeline: (input, title) => `Linked task${title("task", input.taskId)} to lane${title("pipeline", input.pipelineId)}`,
  deploy_exact_sha: input => `Deployed release ${text(input.sha ?? input.commit).slice(0, 8)}`,
  bridge_report: input => `Reported:${quoted(input.summary ?? input.body)}`,
  bridge_directive: () => "Sent a directive to the orchestrator",
  publish_prototype_review: input => `Asked the operator in a form:${quoted(input.title)}`,
  resend_prototype_review_telegram: () => "Sent a decision form to Telegram again",
  send_message: input => `Messaged an agent:${quoted(input.text ?? input.message)}`,
  send_message_to_orchestrator: () => "Messaged another project's orchestrator",
  spawn_agent: input => `Started an agent${input.role ? ` (${text(input.role)})` : ""}:${quoted(input.prompt)}`,
  request_attention: input => `Asked to show the operator a ${text(input.kind) || "notice"}`,
  dismiss_attention: input => input.target ? "Cleared a needs-you flag" : null,
  suggest_replies: () => "Offered reply drafts",
  seat_tick_settings: input => writeFields(input, ["enabled", "wakeIntervalMinutes", "untilMinutes", "reason", "monitorPrompt", "replaceLine", "removeLine", "appendLine", "autonomy", "autonomyDecision", "release", "autoRotate"]) ? "Changed wake settings" : null,
  account_project_binding: input => ["add", "remove"].includes(text(input.action)) ? "Changed account binding" : null,
  auto_updates: input => writeFields(input, ["enabled"]) ? "Changed update settings" : null,
  role_presets: input => writeFields(input, ["overrides", "workerLimit"]) ? "Changed role settings" : null,
  curate_rules: input => input.action === "apply" ? "Curated learned rules" : null,
  flow_action: () => "Changed a review flow", conversation_action: () => "Changed an agent conversation",
  conversation_migration: () => "Migrated an agent conversation", rotate_orchestrator: () => "Rotated the orchestrator",
  create_orchestrator: () => "Designated an orchestrator", leave_lesson: () => "Recorded lessons",
  issue_report: input => input.action === "publish" ? "Filed an issue report" : input.action === "preview" ? "Prepared an issue report" : null,
  telegram_bot_send: () => "Sent a Telegram message",
  telegram_bot_send_media: () => "Sent Telegram media", telegram_bot_send_document: () => "Sent a Telegram document",
  ask_orchestrator_in_parallel: () => "Asked a parallel orchestrator",
};
export const NOT_SEAT_ACTIONS = new Set(["lifecycle_events", "agent_activity", "stage_report", "backfill_worktree_projects"]);
export interface SeatActionRead {
  page?: MessagesPage; titles?: Map<string, string>; anchorBytes?: number;
  overlap?: { results: Map<string, SessionToolCall>; bytes: number };
}

// Scan positions advance past pages containing only results or read-only calls,
// including a scan exhausted inside a line.
const actionCursor = (filename: string, cursor: MessagesPageCursor) => `a${cursor.o.toString(36)}.${cursor.p}.${fingerprint(filename)}`;

function failed(value: unknown): boolean {
  if (typeof value === "string") { try { return failed(JSON.parse(value)); } catch { return false; } }
  const row = object(value);
  return row.ok === false || row.isError === true || row.is_error === true || (!!row.code && row.ok !== true) || row.status === "refused" || row.status === "failed"
    || (Array.isArray(row.content) && row.content.some(part => failed(object(part).text))) || (!!row.structuredContent && failed(row.structuredContent));
}
/** Re-read a bounded newer neighborhood of a continuation. Results there can
 * belong to calls on the older page; only the older page may emit actions. */
function actionResultOverlap(source: MessagesPageSource, offset: number, allowance: number) {
  const results = new Map<string, SessionToolCall>();
  const buffer = Buffer.allocUnsafe(Math.min(512 * 1024, allowance, source.size - offset));
  const bytes = readSync(source.descriptor, buffer, 0, buffer.length, offset);
  const lines = buffer.subarray(0, bytes).toString("utf8").split("\n");
  if (offset + bytes < source.size) lines.pop(); // Never normalize a clipped result.
  for (const line of lines) {
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    for (const row of normalizeSessionLine(source.engine, object(value))) {
      if (row.record.kind === "tool_result" && row.call?.id) results.set(row.call.id, row.call);
    }
  }
  return { results, bytes };
}
export function seatActions(source: MessagesPageSource, filename: string, args: Record<string, unknown>, redactText: (text: string) => string,
  lookup: (kind: "task" | "pipeline", id: string) => string | undefined, retained: SeatActionRead = {}) {
  const scanCursor = typeof args.before === "string" && args.before.startsWith("a");
  const pos = args.before ? position(filename, scanCursor ? `m${String(args.before).slice(1)}` : args.before) : null;
  if (pos === "stale_handle") return missing(pos);
  if (args.before && (!pos || pos.seq >= source.size)) return missing("not_found");
  if (args.since && !Number.isFinite(Date.parse(String(args.since)))) throw new Error("INVALID_TOOL_ARGUMENTS");
  if (pos && !scanCursor && !retained.page) {
    const checked = anchor(source, pos, "tool_call", redactText);
    if (!checked.row || checked.bytes >= SEAT_SCAN_BYTES) return missing("not_found");
    retained.anchorBytes = checked.bytes;
  }
  const overlap = retained.overlap ??= pos ? actionResultOverlap(source, pos.seq, SEAT_SCAN_BYTES - (retained.anchorBytes ?? 0) - 1)
    : { results: new Map<string, SessionToolCall>(), bytes: 0 };
  const page = retained.page ??= readMessagesPage(source, { kinds: new Set(["tool_call", "tool_result"]), roles: new Set(["assistant", "tool"]), limit: 120,
    maxChars: 16000, since: typeof args.since === "string" ? args.since : undefined,
    cursor: pos ? { o: pos.seq, p: pos.part, r: [] } : null, maxScanBytes: SEAT_SCAN_BYTES - (retained.anchorBytes ?? 0) - overlap.bytes, redactText });
  const results = new Map(overlap.results);
  for (const row of page.records) if (row.kind === "tool_result" && row.call?.id) results.set(row.call.id, row.call);
  const titles = retained.titles ??= new Map<string, string>();
  const title = (kind: "task" | "pipeline", id: unknown) => {
    if (!id || typeof id !== "string") return "";
    const key = `${kind}:${id}`;
    if (!titles.has(key)) titles.set(key, titles.size < 30 ? redactText(lookup(kind, id) ?? "") : "");
    return quoted(titles.get(key));
  };
  const rows: Array<{ time: string | null; action: string; outcome: "done" | "failed" | "running" }> = [];
  const seen = new Set<string>(); let before: string | null = null, more = page.hasMore, stopped = false;
  for (const row of page.records) {
    const call = row.call;
    if (row.kind !== "tool_call" || !call?.server || !isViewerMcpServer(call.server) || !call.tool || !Object.hasOwn(ACTION_LINES, call.tool) || seen.has(call.id)) continue;
    seen.add(call.id);
    const input = cleanStrings(call.input ?? {}, redactText);
    // Identity fields select keyed records; only the resulting title is data
    // for the voice. Redacting an id first would turn it into an unresolvable reference.
    for (const key of ["pipelineId", "taskId", "id"]) if (Object.hasOwn(call.input ?? {}, key)) input[key] = call.input![key];
    const line = ACTION_LINES[call.tool](input, title);
    if (!line) continue;
    const result = results.get(call.id);
    const outcome = call.status === "failed" || call.error || failed(call.result) || result?.error || failed(result?.result) ? "failed"
      : call.status === "completed" || result ? "done" : "running";
    const item = { time: time(row.ts), action: byteShort(redactText(line).replace(/[\u0000-\u001f\u007f]/gu, " "), 160), outcome } as const;
    if (rows.length >= Number(args.limit ?? 15) || jsonBytes([...rows, item]) > 4800) { more = true; stopped = true; break; }
    rows.push(item); before = handle(filename, row);
  }
  if (!stopped && page.cursor) before = actionCursor(filename, page.cursor);
  return { rows, shown: rows.length, more, before, truncated: page.scanned.capped,
    speech: byteShort(`${rows.length} orchestrator actions: ${rows.filter(row => row.outcome === "done").length} done, ${rows.filter(row => row.outcome === "failed").length} failed, ${rows.filter(row => row.outcome === "running").length} running. ${rows.slice(0, 2).map(row => row.action).join(". ")}`, 600),
    scanned: { bytes: page.scanned.bytes + (retained.anchorBytes ?? 0) + overlap.bytes, capped: page.scanned.capped } };
}
