import { boundedRepository, normalizeWorkLinkInput, workLinkUrl, type ForgeCacheView, type PullRequestState } from "./workLinks";

export const CHAT_PULL_REQUEST_BATCH = 8;
export const CHAT_PULL_REQUEST_PAGE_SIZE = 12;
export const CHAT_PULL_REQUEST_REFRESH_MS = 3 * 60_000;
export const MAX_CHAT_PULL_REQUESTS = 128;

export interface ChatPullRequest {
  repository: string;
  number: number;
  url: string;
  title?: string;
  state: PullRequestState | null;
  conflict?: boolean | null;
  checkedAt?: string;
  additions?: number;
  deletions?: number;
}

export interface ChatPullRequests {
  /** Most recently mentioned first; each PR appears at most once. */
  items: ChatPullRequest[];
  partial: boolean;
  /** Shared readers can see cached states without initiating GitHub reads. */
  refresh?: boolean;
}


export function chatPullRequestForUrl(value: string, forge: ForgeCacheView): ChatPullRequest | null {
  const parsed = normalizeWorkLinkInput(value, { repository: null });
  if (!parsed.ok || parsed.link.kind !== "pr") return null;
  const { repository, number } = parsed.link;
  const cached = forge.repository(repository);
  const canonical = boundedRepository(cached?.canonical) ? cached.canonical : repository;
  const pr = cached?.pr(number);
  return {
    repository: canonical, number, url: workLinkUrl(canonical, number, "pr"),
    state: pr?.state ?? null,
    ...(pr?.title ? { title: pr.title.slice(0, 240) } : {}),
    ...(pr?.checkedAt ? { checkedAt: pr.checkedAt } : {}),
    ...(pr?.additions !== undefined ? { additions: pr.additions } : {}),
    ...(pr?.deletions !== undefined ? { deletions: pr.deletions } : {}),
  };
}
