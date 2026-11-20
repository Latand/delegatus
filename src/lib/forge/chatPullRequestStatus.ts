import os from "node:os";

import { isForgeAppRepository } from "@/lib/git/agentForgeCredentials";
import { githubRunner, type GithubRunner } from "@/lib/monitor/githubEvidence";
import { recordValue } from "@/lib/scanner/json";

import { forgeAppWriter } from "./appWrite";
import type { ChatPullRequest } from "./chatPullRequests";

const STATUS_TTL = 3 * 60_000;
const RETRY_TTL = 60_000;
const CACHE_LIMIT = 1024;
const QUEUE_LIMIT = 4;
const GITHUB_TIMEOUT = 8_000;

type Observation = { at: number; row?: ChatPullRequest };
const observations = new Map<string, Observation>();
let lane = Promise.resolve();
let queued = 0;

/** Prefer a recent targeted observation, or a newer durable forge sweep. */
export function withChatPullRequestStatus(item: ChatPullRequest): ChatPullRequest {
  const observed = observations.get(item.url)?.row;
  return observed && item.state !== "merged" && (!item.checkedAt || observed.checkedAt! >= item.checkedAt) ? observed : item;
}

function due(item: ChatPullRequest, now: number): boolean {
  const current = withChatPullRequestStatus(item);
  if (current.state === "merged") return false;
  const checked = Date.parse(current.checkedAt ?? "");
  if (now - checked < STATUS_TTL) return false;
  const observation = observations.get(item.url);
  return !observation || now - observation.at >= RETRY_TTL;
}

/** The query contains only validated repository names and numbers already
 * resolved from the authorized transcript. Never send transcript text. */
async function readBatch(items: ChatPullRequest[], run: GithubRunner): Promise<unknown> {
  const query = items.map(({ repository, number }, index) => {
    const [owner, name] = repository.split("/");
    return `r${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { pullRequest(number: ${number}) { state isDraft title additions deletions } }`;
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
): Promise<ChatPullRequest[]> {
  if (queued < QUEUE_LIMIT && items.some(item => due(item, Date.now()))) {
    queued += 1;
    lane = lane.then(async () => {
      const at = Date.now();
      const pending = [...new Map(items.filter(item => due(item, at)).map(item => [item.url, item])).values()];
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
        const reader = run ?? (repository
          ? (args => forgeAppWriter(cwd, GITHUB_TIMEOUT)(args, repository))
          : githubRunner(cwd, GITHUB_TIMEOUT));
        const answer = recordValue(recordValue(await readBatch(batch, reader))?.data);
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
