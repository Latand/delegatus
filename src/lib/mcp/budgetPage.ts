import { createHash, randomBytes } from "node:crypto";
import type { McpToolArgs, McpToolPayload } from "./server";

type Page = { rows: Record<string, unknown>[]; meta: McpToolPayload; upstream: string | null };
type Held = Page & { scope: string; expires: number; offset: number };
const caches = new WeakMap<object, Map<string, Held>>();

/** A bounded observed page survives byte-driven splitting. The upstream cursor
 * advances only after every row in that page has been delivered. Continuations
 * are immutable, replayable and bound to filters and projection options. */
export async function budgetPage(owner: object, tool: string, args: McpToolArgs, budget: number,
  load: (cursor: string | null) => Promise<Page>, full: boolean): Promise<McpToolPayload> {
  let cache = caches.get(owner);
  if (!cache) { cache = new Map(); caches.set(owner, cache); }
  const { cursor, clientRequestId: _key, ...filters } = args;
  const scope = createHash("sha256").update(JSON.stringify({ tool, filters: Object.fromEntries(Object.entries(filters).sort(([a], [b]) => a.localeCompare(b))) })).digest("hex");
  for (const [key, value] of cache) if (value.expires < Date.now()) cache.delete(key);
  let page: Page, offset = 0;
  if (typeof cursor === "string" && cursor.startsWith("mcp-page-")) {
    const held = cache.get(cursor);
    if (!held || held.scope !== scope) throw new Error("MCP page cursor expired or filters changed; restart without cursor");
    page = held; offset = held.offset;
  } else page = await load(typeof cursor === "string" ? cursor : null);
  const token = `mcp-page-${randomBytes(16).toString("hex")}`;
  const make = (rows: Record<string, unknown>[]) => {
    const remaining = page.rows.length - offset - rows.length;
    return { ...page.meta, conversations: rows, count: rows.length,
      omittedRecordCount: full ? 0 : rows.length,
      ...(typeof page.meta.total === "number" ? { omittedCount: Math.max(0, page.meta.total - rows.length) } : {}),
      budgetOmittedCount: remaining, nextCursor: remaining > 0 ? token : page.upstream,
      hasMore: remaining > 0 || Boolean(page.upstream),
      readMore: `${page.meta.readMore ?? ""} Pass nextCursor as cursor with the same filters and options; cursors expire after five minutes.` };
  };
  const rows: Record<string, unknown>[] = [];
  // Account for the real service envelope, including the caller-controlled key.
  const ceiling = budget - 256 - Buffer.byteLength(String(args.clientRequestId ?? ""));
  for (let i = offset; i < page.rows.length; i++) {
    const row = page.rows[i]!;
    if (!full && Buffer.byteLength(JSON.stringify(make([...rows, row]))) > ceiling) {
      if (rows.length) break;
      // Unusually large identities/paths must not prevent forward progress.
      rows.push({ conversationId: row.conversationId, truncated: true,
        omittedFieldCount: Object.keys(row).length - 1,
        readMore: "Read this conversation by conversationId, or restart with full:true." });
      break;
    }
    rows.push(row);
  }
  if (offset + rows.length < page.rows.length) {
    while (cache.size >= 128) cache.delete(cache.keys().next().value!);
    cache.set(token, { ...page, scope, offset: offset + rows.length, expires: Date.now() + 300_000 });
  }
  return make(rows);
}
