import net from "node:net";
import { checkedAnswer, checkedRound, type ExternalRelayRequest, type ExternalRelayDecision, type RelayUrlButton, type RelayMediaKind } from "./protocol";

export type AnswerDrop = { part: string; index?: number; reason: string };
export type LocalAttachment = { path: string; kind: RelayMediaKind; caption?: string; filename?: string };
const localFiles = new WeakMap<object, LocalAttachment[]>();
export const answerFiles = (answer: object) => localFiles.get(answer) ?? [];
export function answerCapabilities(request: ExternalRelayRequest, engine: string) {
  const offered = request.features?.includes("relay_rich_messages") === true;
  const guide = request.input.format;
  const rich = offered && !!guide;
  const media = rich && request.features?.includes("relay_media_out") === true && !!request.answer.attachments;
  return { rich, media, generate: media && engine === "codex",
    plainMax: offered ? Math.min(4000, guide?.formats.plain ?? 4000) : request.answer.max_chars,
    richMax: Math.min(32000, guide?.formats.rich_markdown ?? 32000, request.answer.max_chars),
    blocks: Math.min(500, guide?.max_blocks ?? 500), depth: Math.min(16, guide?.max_depth ?? 16), columns: Math.min(20, guide?.max_table_columns ?? 20),
    rows: rich && guide?.buttons.allowed ? Math.min(2, guide.buttons.max_rows) : 0,
    perRow: Math.min(3, guide?.buttons.max_per_row ?? 0), totalButtons: Math.min(6, guide?.buttons.max_total ?? 0),
    maxItems: media ? Math.min(4, request.answer.attachments!.max_items) : 0,
    maxBytes: Math.min(67108864, request.answer.attachments?.max_total_bytes ?? 0),
    kinds: media ? request.answer.attachments!.kinds : [],
  };
}
export type AnswerCapabilities = ReturnType<typeof answerCapabilities>;
export function withAnswerParts<T extends { required: readonly string[]; properties: object }>(schema: T, caps: AnswerCapabilities) {
  if (!caps.rich) return schema;
  const parts = { format: { type: "string", enum: ["plain", "rich_markdown"] },
    buttons: { type: "array", items: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["text", "url"], properties: { text: { type: "string" }, url: { type: "string" } } } } },
    ...(caps.generate ? { attachments: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["path", "kind", "caption"], properties: { path: { type: "string" }, kind: { type: "string", enum: ["photo", "document"] }, caption: { type: "string" } } } } } : {}) };
  return { ...schema, required: [...schema.required, ...Object.keys(parts)], properties: { ...schema.properties, ...parts } };
}
/** Navigation targets are parsed without ever resolving or fetching them. */
export function safeRelayUrl(value: unknown): value is string {
  if (typeof value !== "string" || [...value].length > 2048 || !value.startsWith("https://") || /[\x00-\x20\x7f\\]/.test(value)) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password || host === "localhost" || host.endsWith(".localhost")) return false;
    if (net.isIP(host) === 4) {
      const [a, b, c] = host.split(".").map(Number);
      if (a === 0 || a === 10 || a === 127 || a! >= 224 || a === 169 && b === 254 || a === 172 && b! >= 16 && b! <= 31 || a === 192 && (b === 168 || b === 0 && [0,2].includes(c!)) || a === 198 && ([18,19].includes(b!) || b === 51 && c === 100) || a === 203 && b === 0 && c === 113 || a === 100 && b! >= 64 && b! <= 127) return false;
    }
    if (net.isIP(host) === 6) {
      // Refuse mapped/compatible addresses too: an IPv4 private address may
      // be written in hexadecimal, which a string prefix check would miss.
      const first = Number.parseInt(host.split(":")[0]!, 16);
      if (!(first >= 0x2000 && first < 0x4000) || host.startsWith("2001:db8:")) return false;
    }
    return true;
  } catch { return false; }
}
export function checkedButtons(value: unknown, caps: AnswerCapabilities, drops: AnswerDrop[] = []): RelayUrlButton[][] {
  if (!Array.isArray(value)) return [];
  const rows: RelayUrlButton[][] = [];
  let count = 0;
  value.forEach((row, ri) => {
    if (!Array.isArray(row)) { drops.push({ part: "button", index: ri, reason: "shape" }); return; }
    const accepted: RelayUrlButton[] = [];
    row.forEach((button, bi) => {
      if (ri >= caps.rows || bi >= caps.perRow || count >= caps.totalButtons || !button || typeof button.text !== "string" || !button.text.trim() || [...button.text].length > 64 || /[\x00-\x1f\x7f]/.test(button.text) || !safeRelayUrl(button.url)) {
        drops.push({ part: "button", index: ri * 3 + bi, reason: "button_invalid" }); return;
      }
      accepted.push({ text: button.text, url: button.url }); count++;
    });
    if (accepted.length) rows.push(accepted);
  });
  return rows;
}
export function checkedCaption(value: string): string {
  let result = "";
  for (const point of value) { if (result.length + point.length > 1024) break; result += point; }
  return result;
}
/** Mask paired backtick runs in linear work, preserving literal unmatched runs. */
function withoutInlineCode(line: string) {
  const runs: { start:number; end:number; length:number }[]=[];
  const next=new Map<number,number>();
  for (let i=0;i<line.length;) {
    if (line[i]==="\\") { i+=2; continue; }
    if (line[i]!=="`") { i++; continue; }
    const start=i; while(line[i]==="`")i++;
    runs.push({start,end:i,length:i-start});
  }
  const matches=new Map<number,number>();
  for(let i=runs.length-1;i>=0;i--) {
    const run=runs[i]!; const after=next.get(run.length);
    if(after!==undefined)matches.set(i,after);
    next.set(run.length,i);
  }
  const chunks:string[]=[];let offset=0;
  for(let i=0;i<runs.length;i++) {
    const end=matches.get(i);if(end===undefined)continue;
    chunks.push(line.slice(offset,runs[i]!.start),"_");offset=runs[end]!.end;i=end;
  }
  chunks.push(line.slice(offset));return chunks.join("");
}
function invalidLinks(text:string) {
  const labels:number[]=[];
  for(let index=0;index<text.length;index++) {
    if(text[index]==="\\") { index++;continue; }
    if(text[index]==="[") { labels.push(index);continue; }
    if(text[index]!=="]"||!labels.length)continue;
    labels.pop();
    if(text[index+1]!=="(")continue;
    const targetStart=index+2;let cursor=targetStart,depth=1;
    while(cursor<text.length&&depth) {
      if(text[cursor]==="\\") { cursor+=2;continue; }
      if(text[cursor]==="(")depth++;
      else if(text[cursor]===")")depth--;
      if(depth)cursor++;
    }
    if(depth)return true;
    if(!safeRelayUrl(text.slice(targetStart,cursor).split(/\s/)[0]))return true;
    index=cursor;
  }
  return false;
}
/** Bounded by the source cap before scanning; code is excluded from syntax
 * checks. Every list item counts, including nested items and quoted blocks. */
export function richTextRefusal(text: string, caps: AnswerCapabilities): string | null {
  if ([...text].length > caps.richMax || Buffer.byteLength(text) > 128000) return "length";
  let blocks = 0, paragraph = false, table = false, fence: string | null = null, previousQuoteDepth=0;
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const tableHeader = (line: string, next: string | undefined) => !!next
    && line.includes("|") && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(next);
  for (let index=0;index<lines.length;index++) {
    const line=lines[index]!;
    const quotes = (/^\s{0,3}(?:>\s*)+/.exec(line)?.[0].match(/>/g) ?? []).length;
    if (quotes > caps.depth) return "depth";
    const content = line.replace(/^\s{0,3}(?:>\s*)+/, "");
    if(quotes!==previousQuoteDepth)paragraph=table=false;
    if(quotes>previousQuoteDepth)blocks+=quotes-previousQuoteDepth;
    previousQuoteDepth=quotes;
    if(blocks>caps.blocks)return "blocks";
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(content)?.[1];
    if (fence) { if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null; continue; }
    if (marker) { fence = marker; blocks++; paragraph = table = false; continue; }
    // Matched backtick runs delimit inline code. Unclosed runs remain literal.
    const visible = withoutInlineCode(content).replace(/\\[\\`*{}[\]()#+.!<>|~-]/g, "_");
    if (/<[a-z/!?]/i.test(visible)) return "raw_html";
    if (/!\[/.test(visible)) return "inline_media";
    if (/^\s{0,3}\[[^\]]+\]:|\[\^[^\]]+\]/.test(visible)) return "reference";
    if (invalidLinks(visible)) return "link";
    const indent = /^\s*/.exec(content)![0].replace(/\t/g, "    ").length;
    const list = /^\s*(?:[-+*]|\d+[.)])\s/.test(content);
    if (quotes + (list ? Math.floor(indent / 2) + 1 : 0) > caps.depth) return "depth";
    const pipes = visible.split("|");
    const isTable = visible.includes("|") && (table || tableHeader(content, lines[index+1])
      || index>0 && tableHeader(lines[index-1]!,content));
    const separator=isTable&&index>0&&tableHeader(lines[index-1]!,content);
    if (isTable) {
      const columns = pipes.length - (visible.trimStart().startsWith("|") ? 1 : 0) - (visible.trimEnd().endsWith("|") ? 1 : 0);
      if (columns > caps.columns) return "table_columns";
      if (!separator) blocks++;
      table = true; paragraph = false;
    } else if (!content.trim()) { paragraph = table = false; }
    else if (/^\s*#{1,6}\s/.test(content) || list) { blocks++; paragraph = table = false; }
    else { if (!paragraph) blocks++; paragraph = true; table = false; }
    if (blocks > caps.blocks) return "blocks";
  }
  return blocks > caps.blocks ? "blocks" : null;
}
export type AnswerCheckOptions = { handoff: boolean; ignore: boolean; stagedAttachments?: number };
export function checkedAnswerV2(value: unknown, request: ExternalRelayRequest, caps: AnswerCapabilities,
  options: AnswerCheckOptions = { handoff: true, ignore: true }, drops: AnswerDrop[] = []): ExternalRelayDecision | null {
  if (!caps.rich) return checkedAnswer(value, { ...request, answer: { ...request.answer, max_chars: caps.plainMax } }, options);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.action === "handoff") return checkedAnswer(value, request, options);
  if (raw.action === "ignore") return options.ignore ? { action: "ignore", text: "", reply_to: null, format: "plain", buttons: [] } : null;
  if (raw.action !== "reply" || typeof raw.text !== "string" || raw.reply_to !== null && typeof raw.reply_to !== "string") return null;
  let format: "plain" | "rich_markdown" = raw.format === "rich_markdown" ? "rich_markdown" : "plain";
  if (format === "rich_markdown") {
    const reason = richTextRefusal(raw.text, caps);
    if (reason) { drops.push({ part: "text", reason }); if ([...raw.text].length > caps.plainMax) return null; format = "plain"; }
  } else if ([...raw.text].length > caps.plainMax) { drops.push({part:"text",reason:"plain_length"}); return null; }
  const files: LocalAttachment[] = [];
  if (caps.generate && Array.isArray(raw.attachments)) raw.attachments.forEach((file, index) => {
    if (index >= caps.maxItems || !file || typeof file.path !== "string" || !["photo", "document"].includes(file.kind) || !caps.kinds.includes(file.kind) || file.caption !== undefined && typeof file.caption !== "string") {
      drops.push({ part: "attachment", index, reason: "attachment_invalid" }); return;
    }
    const caption = checkedCaption(file.caption ?? "");
    if (caption !== (file.caption ?? "")) drops.push({ part: "caption", index, reason: "caption_too_long" });
    files.push({ path: file.path, kind: file.kind, caption });
  });
  if (!raw.text.trim() && !files.length && !(caps.media && (options.stagedAttachments ?? 0) > 0)) return null;
  const answer: ExternalRelayDecision = { action: "reply", text: raw.text, reply_to: request.input.conversation.some(m => m.id === raw.reply_to) ? raw.reply_to as string : null,
    format, buttons: checkedButtons(raw.buttons, caps, drops) };
  localFiles.set(answer, files);
  return answer;
}
export function checkedRoundV2(value: unknown, request: ExternalRelayRequest, caps: AnswerCapabilities, options: AnswerCheckOptions, drops: AnswerDrop[]) {
  if (value && typeof value === "object" && (value as Record<string, unknown>).action === "call") return checkedRound(value, request, options);
  return checkedAnswerV2(value, request, caps, options, drops);
}
export function formatSection(request: ExternalRelayRequest): string {
  return answerCapabilities(request, "").rich ? `<format>\n${JSON.stringify(request.input.format).replace(/</g, "\\u003c")}\n</format>\n` : "";
}
export function richAnswerInstructions(caps: AnswerCapabilities, owner = false): string {
  return `format plain sends text literally, at most ${caps.plainMax} characters. Use ${owner ? "relay_answer with format rich_markdown before your last message" : 'format "rich_markdown"'} for tables, lists, headings, code or a reply longer than ${caps.plainMax} characters, following <format>, at most ${caps.richMax} characters. ${owner ? "relay_answer sets" : "buttons holds"} up to ${caps.rows} rows of ${caps.perRow} https links {"text", "url"}; use [] for none.${caps.generate && !owner ? ` You may create a requested picture with your native image tool. attachments lists up to ${caps.maxItems} images you created in this turn, using the path your image tool reported, kind photo (or document for the original) and a plain caption of at most 1024 characters; use [] for none.` : ""}${owner && caps.media ? ` relay_answer also attaches up to ${caps.maxItems} files under your document roots by absolute path, kind photo, document, audio or video. Never write a local path in the posted message.` : ""}`;
}
