import { normalizeWorkLinkInput } from "@/lib/forge/workLinks";

/** A whole spoken PR reference; other queries retain literal text matching. */
export function pullRequestQuery(query: string): number | null {
  if (!/^(?:(?:pr|pull request)\s*#?\s*|#\s*)?\d+$/i.test(query.trim())) return null;
  const parsed = normalizeWorkLinkInput(query, { repository: "query/reference", kind: "pr" });
  return parsed.ok ? parsed.link.number : null;
}

export function normalizedBoardQuery(query: string): string {
  const number = pullRequestQuery(query);
  return number === null ? query.trim().toLowerCase() : `pr ${number}`;
}

/** Retained titles can name a PR even when its link evidence is unavailable. */
export function titleHasPullRequest(title: string, number: number): boolean {
  const references = /(?<![\p{L}\p{N}_])(?:(?:pr|pull request)\s*#?\s*|#\s*)(\d+)(?![\p{L}\p{N}_])/giu;
  for (const match of title.matchAll(references)) {
    if (Number(match[1]) === number && !/\bissue\s*$/i.test(title.slice(0, match.index))) return true;
  }
  return false;
}
