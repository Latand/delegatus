import type { ForgeCacheFile, StoredPullRequest } from "./cache";
import { isMergeBatchHead, parseMergeBatchTitle } from "./mergeBatchTitle";

const ms = (iso: string) => Date.parse(iso);

export interface LandedPullRequest {
  repository: string;
  number: number;
  pr: StoredPullRequest;
  at: string;
  batch?: number;
}

/**
 * Every PR that reached its base branch (§2.1): merged on its own, or closed
 * by a merge batch whose merged PR names it in its title, at the batch's
 * merge. The batch's own PR is never one.
 */
export function landedPullRequests(forge: ForgeCacheFile): LandedPullRequest[] {
  const landed = new Map<string, LandedPullRequest>();
  for (const [name, entry] of Object.entries(forge.repositories)) {
    /* A renamed repository can sit under both names; one key per PR. */
    const repository = (entry.canonical ?? name).toLowerCase();
    const viaBatch = new Map<number, { at: string; number: number }>();
    for (const [batch, pr] of Object.entries(entry.prs)) {
      if (pr.state !== "merged" || !isMergeBatchHead(pr.headRefName) || !pr.mergedAt) continue;
      for (const number of parseMergeBatchTitle(pr.title)) {
        const held = viaBatch.get(number);
        if (!held || ms(pr.mergedAt) < ms(held.at)) viaBatch.set(number, { at: pr.mergedAt, number: Number(batch) });
      }
    }
    for (const [key, pr] of Object.entries(entry.prs)) {
      const number = Number(key);
      if (!Number.isSafeInteger(number) || isMergeBatchHead(pr.headRefName)) continue;
      const batch = pr.state === "closed" ? viaBatch.get(number) : undefined;
      const at = pr.state === "merged" && pr.mergedAt ? pr.mergedAt : pr.state === "closed" ? batch?.at : undefined;
      if (!at) continue;
      landed.set(`${repository}#${number}`, { repository, number, pr, at, ...(batch ? { batch: batch.number } : {}) });
    }
  }
  return [...landed.values()];
}
