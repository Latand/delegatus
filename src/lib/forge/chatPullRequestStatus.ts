import os from "node:os";

import { isForgeAppRepository } from "@/lib/git/agentForgeCredentials";
import { githubRunner, type GithubRunner } from "@/lib/monitor/githubEvidence";
import { recordValue } from "@/lib/scanner/json";

import { forgeAppWriter } from "./appWrite";
import { CHAT_PULL_REQUEST_REFRESH_MS, type ChatPullRequest } from "./chatPullRequests";

const RETRY_TTL = 60_000;
const CACHE_LIMIT = 1024;
const QUEUE_LIMIT = 4;
const GITHUB_MIN_INTERVAL = 5_000;
const GITHUB_TIMEOUT = 8_000;

type Observation = { at: number; row?: ChatPullRequest };
type Clock = { now: () => number; wait: (ms: number) => Promise<unknown> };
const systemClock: Clock = { now: Date.now, wait: ms => new Promise(resolve => setTimeout(resolve, ms)) };
const observations = new Map<string, Observation>();
let lane = Promise.resolve();
let queued = 0;
let nextReadAt = 0;

function isActive(item: ChatPullRequest): boolean {
  return item.state === "open" || item.state === "draft";
}

/** Prefer a recent targeted observation, or a newer durable forge sweep. */
export function withChatPullRequestStatus(item: ChatPullRequest): ChatPullRequest {
  if (item.state === "merged") return item;
  const observed = observations.get(item.url)?.row;
  if (!observed?.checkedAt) return item;
  if (observed.state === "merged" || !item.checkedAt || observed.checkedAt >= item.checkedAt) return observed;
  return isActive(item) && isActive(observed) && observed.conflict != null
    ? { ...item, conflict: observed.conflict }
    : item;
}

function due(item: ChatPullRequest, now: number): boolean {
  const observation = observations.get(item.url);
  const current = withChatPullRequestStatus(item);
  if (current.state === "merged") return false;
  if (observation && now - observation.at < RETRY_TTL) return false;
  const checked = isActive(current)
    ? observation?.row?.conflict == null ? undefined : observation.row.checkedAt
    : current.checkedAt;
  return !(now - Date.parse(checked ?? "") < CHAT_PULL_REQUEST_REFRESH_MS);
}

/** The query contains only validated repository names and numbers already
 * resolved from the authorized transcript. Never send transcript text. */
async function readBatch(items: ChatPullRequest[], run: GithubRunner): Promise<unknown> {
  const query = items.map(({ repository, number }, index) => {
    const [owner, name] = repository.split("/");
    return `r${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { pullRequest(number: ${number}) { state isDraft mergeable title additions deletions } }`;
  }).join(" ");
  try {
    return JSON.parse(await run(["api", "graphql", "-f", `query=query { ${query} }`]));
  } catch (error) {
    // gh may exit nonzero on a partial GraphQL response. Preserve its usable rows.
    const stdout = (error as { stdout?: unknown } | null)?.stdout;
    if (typeof stdout === "string") {
      try { return JSON.parse(stdout); } catch { /* no usable response */ }
    }
    return null;
  }
}

function readRow(item: ChatPullRequest, value: unknown, at: number): ChatPullRequest | undefined {
  const row = recordValue(recordValue(value)?.pullRequest);
  if (!row || (row.state !== "OPEN" && row.state !== "MERGED" && row.state !== "CLOSED")) return;
  return {
    ...item,
    state: row.state === "OPEN" ? (row.isDraft === true ? "draft" : "open") : row.state === "MERGED" ? "merged" : "closed",
    conflict: row.state !== "OPEN" ? null : row.mergeable === "CONFLICTING" ? true : row.mergeable === "MERGEABLE" ? false : null,
    checkedAt: new Date(at).toISOString(),
    ...(typeof row.title === "string" ? { title: row.title.slice(0, 240) } : {}),
    ...(typeof row.additions === "number" && Number.isSafeInteger(row.additions) ? { additions: row.additions } : {}),
    ...(typeof row.deletions === "number" && Number.isSafeInteger(row.deletions) ? { deletions: row.deletions } : {}),
  };
}

/** A single bounded lane across panels. Recheck cached observations after
 * waiting so overlapping requests use the first result. */
export async function refreshChatPullRequestStatus(
  items: readonly ChatPullRequest[],
  signal?: AbortSignal,
  run?: GithubRunner,
  clock: Clock = systemClock,
): Promise<ChatPullRequest[]> {
  if (!signal?.aborted && queued < QUEUE_LIMIT && items.some(item => due(item, clock.now()))) {
    queued += 1;
    lane = lane.then(async () => {
      const pending = [...new Map(items.filter(item => due(item, clock.now())).map(item => [item.url, item])).values()];
      if (signal?.aborted || !pending.length) return;
      const cwd = os.tmpdir();
      const batches = new Map<string, ChatPullRequest[]>();
      for (const item of pending) {
        const key = !run && isForgeAppRepository(item.repository) ? item.repository : "";
        const batch = batches.get(key) ?? [];
        batch.push(item);
        batches.set(key, batch);
      }
      for (const [repository, batch] of batches) {
        if (signal?.aborted) break;
        const delay = nextReadAt - clock.now();
        if (delay > 0) await clock.wait(delay);
        if (signal?.aborted) break;
        nextReadAt = clock.now() + GITHUB_MIN_INTERVAL;
        const reader = run ?? (repository
          ? (args => forgeAppWriter(cwd, GITHUB_TIMEOUT)(args, repository))
          : githubRunner(cwd, GITHUB_TIMEOUT));
        const answer = recordValue(recordValue(await readBatch(batch, reader))?.data);
        const at = clock.now();
        for (const [index, item] of batch.entries()) {
          const previous = observations.get(item.url);
          observations.delete(item.url);
          const row = readRow(item, answer?.[`r${index}`], at) ?? previous?.row;
          observations.set(item.url, { at, row });
        }
        while (observations.size > CACHE_LIMIT) observations.delete(observations.keys().next().value!);
      }
    }).catch(() => { /* the cached history remains usable */ }).finally(() => { queued -= 1; });
    await lane;
  }
  return items.map(withChatPullRequestStatus);
}
