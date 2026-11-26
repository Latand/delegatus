import { pageReader, pageReadFailure, type PageReader } from "./pageReader";
import { PageReadError } from "./pageUrlPolicy";
import type { ToolProjection } from "./toolLoop";
export type ProviderOpen = { urls: string[]; id?: string; pending?: true; search?: true };
/** Unknown actions fail closed. Both CLI and app-server use action/results. */
export function providerOpen(item: Record<string, unknown>, phase: "start" | "done" = "done"): ProviderOpen | null {
  const action = item.action && typeof item.action === "object" ? item.action as Record<string, unknown> : {};
  const id = typeof item.id === "string" ? item.id : undefined;
  if (action.type === "search") return phase === "done" && id ? { urls: [], id, search: true } : null;
  const urls = new Set<string>();
  if (typeof action.url === "string") urls.add(action.url);
  for (const source of [action.results, item.results]) if (Array.isArray(source))
    for (const row of source) if (row && typeof row.url === "string") urls.add(row.url);
  return { urls: [...urls], ...(id ? { id } : {}), ...(phase === "start" && !urls.size ? { pending: true as const } : {}) };
}
/** Keep bounded evidence. Overflow is represented as an unverifiable open. */
export function collectProviderOpen(opens: ProviderOpen[], open: ProviderOpen) {
  if (open.id && !open.pending) {
    for (let index = opens.length - 1; index >= 0; index--) if (opens[index]?.id === open.id && opens[index]?.pending) opens.splice(index, 1);
  }
  if (open.search) return;
  if (opens.length >= 128) { opens[127] = { urls: [] }; return; }
  opens.push(open.urls.length > 256 || open.urls.some(url => url.length > 2048) ? { urls: [] } : open);
}
export async function checkProviderOpens(opens: readonly ProviderOpen[], round: number, options: {
  reader?: PageReader; signal: AbortSignal;
}): Promise<ToolProjection | null> {
  if (!opens.length) return null;
  const reader = options.reader ?? pageReader;
  const hosts = new Set<string>(), checked = new Set<string>();
  try {
    for (const open of opens) {
      if (!open.urls.length) throw new PageReadError("url_refused", { class: "unverifiable_open", host: "", hop: 0, provider: true });
      for (const url of open.urls) {
        if (checked.has(url)) continue;
        let host = "";
        try { host = new URL(url).hostname; } catch { /* Policy returns invalid_url. */ }
        hosts.add(host);
        if (hosts.size > 16) throw new PageReadError("url_refused", { class: "unverifiable_open", host: "", hop: 0, provider: true });
        await reader.checkPageUrl(url, { signal: options.signal });
        checked.add(url);
      }
    }
    return null;
  } catch (error) {
    const failure = pageReadFailure(error);
    return { round, tool: "web_search", ...failure,
      ...(failure.refusal ? { refusal: { ...failure.refusal, provider: true } } : {}) };
  }
}
