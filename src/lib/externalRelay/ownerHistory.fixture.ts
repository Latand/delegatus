import type http from "node:http";
import { startTestRelay } from "./testRelay";
import { destinationRelay } from "./ownerDestination.fixture";

export const syntheticGroups = [1, 2, 3].map(n => ({ chat_id: -100 - n, title: `Example group ${n}` }));
export const syntheticMessages = Array.from({ length: 12 }, (_, i) => ({
  message_id: i + 1, sent_at: `2026-10-${String(9 + Math.floor(i / 3)).padStart(2, "0")}T09:00:00Z`,
  author: { user_id: 10 + i, name: i === 0 ? null : "Member one", username: null },
  from_assistant: i === 1, thread_id: i === 2 ? 2 : null, reply_to_message_id: i === 2 ? 1 : null,
  text: i === 10 ? "Synthetic message ".repeat(400) : `Synthetic message ${i + 1}`,
  media: i === 11 ? { kind: "voice", description: "Synthetic voice description" } : null, truncated: false,
}));
export function localDate(now: number, tz: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  return ["year", "month", "day"].map(k => parts.find(p => p.type === k)!.value).join("-");
}
export const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
function midnight(date: string, tz: string) {
  const desired = Date.parse(`${date}T00:00:00Z`);
  let at = desired;
  for (let i = 0; i < 3; i++) {
    const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(at);
    const v = (key: string) => p.find(x => x.type === key)!.value;
    at += desired - Date.parse(`${v("year")}-${v("month")}-${v("day")}T${v("hour")}:${v("minute")}:${v("second")}Z`);
  }
  const offset = (desired - at) / 60000;
  return `${date}T00:00:00${offset < 0 ? "-" : "+"}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0")}:${String(Math.abs(offset) % 60).padStart(2, "0")}`;
}
export type HistoryExchange = { request: { method: string; path: string; query: string[][] }; response: { status: number; headers: Record<string,string>; body: unknown } };
export async function historyDouble() {
  const credential = "h".repeat(43);
  const state = { now: Date.parse("2026-10-12T09:00:00Z"), enabled: true, requests: 0, admissions: 0, minute: 0,
    forced: null as null | { status?: number; body?: unknown; headers?: Record<string,string>; drop?: boolean },
    afterHistoryResponse: null as (() => void) | null, exchanges: [] as HistoryExchange[] };
  function handle(req: http.IncomingMessage) {
    state.requests++;
    const url = new URL(req.url!, "http://double.example");
    const error = (status: number, code: string, retry?: number): { status: number; headers: Record<string, string>; body: unknown } => ({ status, headers: retry ? { "Retry-After": String(retry) } : {}, body: { error: { code, message: code.replaceAll("_", " "), ...(retry ? { retry_after_s: retry } : {}) } } });
    if (state.forced) return state.forced;
    if (!state.enabled) return error(404, "not_found");
    if (req.headers["delegatus-relay-version"] !== "1") return error(426, "unsupported_version");
    if (req.headers.authorization !== `Bearer ${credential}`) return error(401, "unauthorized");
    const admit = () => {
      const minute = Math.floor(state.now / 60000);
      if (minute !== state.minute) { state.minute = minute; state.admissions = 0; }
      return ++state.admissions > 60 ? error(429, "rate_limited", 60) : null;
    };
    const match = /^\/v1\/targets\/first\/owner\/groups(?:\/(-[0-9]+)\/messages)?$/.exec(url.pathname);
    if (!match) return error(404, "not_found");
    if (!match[1]) {
      if (url.search) return error(400, "malformed");
      const limited = admit(); if (limited) return limited;
      const response = { status: 200, body: { groups: syntheticGroups } };
      state.afterHistoryResponse?.(); return response;
    }
    const q = url.searchParams;
    const keys = [...q.keys()];
    if (keys.some(k => !["tz", "from", "to", "cursor", "limit"].includes(k)) || new Set(keys).size !== keys.length) return error(400, "malformed");
    const tz = q.get("tz") ?? "";
    if (!tz || tz.length > 64) return error(400, "malformed");
    for (const k of ["from", "to"]) {
      const d = q.get(k);
      if (d !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !Number.isFinite(Date.parse(`${d}T00:00:00Z`)) || new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) !== d)) return error(400, "malformed");
    }
    if (q.has("cursor") && !/^[1-9][0-9]{0,9}$/.test(q.get("cursor")!)) return error(400, "malformed");
    const limit = q.has("limit") ? Number(q.get("limit")) : 50;
    if (!/^[0-9]+$/.test(q.get("limit") ?? "50") || !Number.isInteger(limit) || limit < 1 || limit > 100) return error(400, "malformed");
    const limited = admit(); if (limited) return limited;
    try { new Intl.DateTimeFormat("en", { timeZone: tz }); } catch { return error(422, "malformed"); }
    const to = q.get("to") ?? localDate(state.now, tz), from = q.get("from") ?? to;
    const days = (Date.parse(to) - Date.parse(from)) / 86400000;
    if (days < 0 || days > 30 || to === "9999-12-31") return error(422, "malformed");
    if (!syntheticGroups.some(g => String(g.chat_id) === match[1])) return error(404, "not_found");
    const start = midnight(from, tz), end = midnight(addDays(to, 1), tz);
    const eligible = syntheticMessages.filter(m => Date.parse(m.sent_at) >= Date.parse(start) && Date.parse(m.sent_at) < Date.parse(end) && m.message_id > Number(q.get("cursor") ?? 0));
    const messages: typeof syntheticMessages = [];
    const page = { chat_id: Number(match[1]), title: syntheticGroups.find(g => String(g.chat_id) === match[1])!.title, timezone: tz,
      start, end, oldest_stored_at: syntheticMessages[0]!.sent_at, messages, next_cursor: null as string | null };
    for (const original of eligible.slice(0, limit)) {
      const m = structuredClone(original);
      if ([...m.text].length > 4096) { m.text = [...m.text].slice(0, 4095).join("") + "…"; m.truncated = true; }
      messages.push(m); page.next_cursor = String(m.message_id);
      if (Buffer.byteLength(JSON.stringify(page)) > 12000 && messages.length > 1) { messages.pop(); break; }
      while (Buffer.byteLength(JSON.stringify(page)) > 12000) { m.text = [...m.text].slice(0, -200).join("") + "…"; m.truncated = true; }
    }
    page.next_cursor = messages.length < eligible.length ? String(messages.at(-1)!.message_id) : null;
    const response = { status: 200, body: page };
    state.afterHistoryResponse?.(); return response;
  }
  const server = await startTestRelay(req => {
    const answer = handle(req);
    const url = new URL(req.url!, "http://double.example");
    state.exchanges.push({ request: { method: req.method!, path: url.pathname, query: [...url.searchParams] },
      response: { status: answer.status ?? 200, headers: answer.headers ?? {}, body: answer.body ?? null } });
    return answer;
  });
  const relay = { ...destinationRelay(), api_base: `${server.origin}/v1`, credential };
  return { ...server, relay, state, credential };
}
