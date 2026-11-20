import type { PullRequestState } from "./workLinks";

export const CHAT_PULL_REQUEST_BATCH = 8;

export interface ChatPullRequest {
  repository: string;
  number: number;
  url: string;
  title?: string;
  state: PullRequestState | null;
  checkedAt?: string;
  additions?: number;
  deletions?: number;
}

export interface ChatPullRequests {
  /** Most recently mentioned first; each PR appears at most once. */
  items: ChatPullRequest[];
  partial: boolean;
}
