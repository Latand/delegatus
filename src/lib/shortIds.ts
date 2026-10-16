/** Shared display and comparison rules. Persist full identities; abbreviate only at boundaries. */
export const SHORT_ID_CHARS = 8;
export const MIN_SHORT_ID_CHARS = 7;

function parts(value: string): { tag: string; hash: string } | null {
  for (const pattern of [/^(evt_|rpt_)([a-f0-9]{24})$/i, /^(repo-|dir-|pr_)([a-f0-9]{32})$/i, /^(roles-\d+-)([a-f0-9]{20})$/i, /^(task-legacy:)([a-f0-9]{64})$/i]) {
    const match = pattern.exec(value);
    if (match) return { tag: match[1]!, hash: match[2]! };
  }
  if (/^[a-f0-9]{40}$|^[a-f0-9]{64}$/i.test(value)) return { tag: "", hash: value };
  const task = /^(task-v1:)([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.exec(value);
  return task ? { tag: task[1]!, hash: task[2]! } : null;
}

export function shortId(value: string): string {
  const parsed = parts(value);
  return parsed ? parsed.tag + parsed.hash.slice(0, SHORT_ID_CHARS) : value;
}

export function matchesShortId(full: string, given: string): boolean {
  const parsed = parts(full);
  if (!parsed) return full === given;
  const prefix = given.slice(parsed.tag.length);
  return given.slice(0, parsed.tag.length).toLowerCase() === parsed.tag.toLowerCase()
    && /^[a-f0-9]{7}/i.test(prefix) && full.toLowerCase().startsWith(given.toLowerCase());
}

export type ShortIdResolution = { kind: "match"; value: string } | { kind: "none" } | { kind: "ambiguous"; candidates: string[] };
export function resolveShortId(candidates: Iterable<string>, given: string): ShortIdResolution {
  const matches = [...new Set(candidates)].filter(value => matchesShortId(value, given)).sort();
  if (!matches.length) return { kind: "none" };
  if (matches.length === 1) return { kind: "match", value: matches[0]! };
  return { kind: "ambiguous", candidates: matches.slice(0, 8).map(value => uniqueShortId(value, matches)) };
}

export function shortenHashesInText(text: string): string {
  return text.replace(/(?<![\w/])(?:(?:repo-|dir-|pr_|evt_|rpt_|task-legacy:|roles-\d+-)[a-f0-9]{20,64}|[a-f0-9]{64}|[a-f0-9]{40})(?![\w/])/gi, shortId);
}

const authored = new Set(["text", "details", "body", "prompt", "spec", "summary", "findings", "snippet", "content", "comment", "answer", "title", "task", "clientRequestId", "idempotencyKey"]);
const status = new Set(["stateDetail", "error", "detail"]);
export function shortIdsInAnswer<T>(payload: T): T {
  const seen = new WeakMap<object, unknown>();
  const visit = (value: unknown, key = ""): unknown => {
    if (typeof value === "string" && key === "label" && /^(Yes, publish report |Так, публікуй звіт )/.test(value)) return shortenHashesInText(value);
    if (typeof value === "string") return authored.has(key) ? value : status.has(key) ? shortenHashesInText(value) : shortId(value);
    if (!value || typeof value !== "object") return value;
    if (seen.has(value)) return seen.get(value);
    if (Array.isArray(value)) {
      const copy: unknown[] = []; seen.set(value, copy);
      for (const child of value) copy.push(visit(child, key));
      return copy;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return value;
    const copy: Record<string, unknown> = {}; seen.set(value, copy);
    for (const [name, child] of Object.entries(value)) Object.defineProperty(copy, name, { value: visit(child, name), enumerable: true, writable: true, configurable: true });
    return copy;
  };
  return visit(payload) as T;
}

/** A displayed collision can ask for more characters without revealing a full hash. */
export function uniqueShortId(value: string, candidates: readonly string[]): string {
  let length = (parts(value)?.tag.length ?? 0) + SHORT_ID_CHARS;
  while (length < value.length && candidates.some(other => other !== value && other.slice(0, length).toLowerCase() === value.slice(0, length).toLowerCase())) length++;
  return value.slice(0, length);
}
