import { expect, test } from "bun:test";

import { refreshChatPullRequestStatus } from "./chatPullRequestStatus";
import { CHAT_PULL_REQUEST_REFRESH_MS, type ChatPullRequest } from "./chatPullRequests";

test("targeted status checks share cached observations and space distinct reads across panels", async () => {
  const item = (number: number): ChatPullRequest => ({
    repository: "sample/reports", number, url: `https://github.com/sample/reports/pull/${number}`, state: null,
  });
  const inputs = [{ ...item(1), state: "merged" as const }, item(2), item(3)];
  const reads: string[][] = [];
  let now = Date.now();
  const clock = { now: () => now, wait: async (ms: number) => { now += ms; } };
  const starts: number[] = [];
  let mergeable = "CONFLICTING";
  const run = async (args: string[]) => {
    reads.push(args);
    starts.push(now);
    return JSON.stringify({ data: {
      r0: { pullRequest: { state: "OPEN", isDraft: true, mergeable, title: "Update report", additions: 12, deletions: 2 } },
      r1: null,
    } });
  };
  const refresh = (items: ChatPullRequest[]) => refreshChatPullRequestStatus(items, undefined, run, clock);
  const calls = await Promise.all([
    refresh(inputs),
    refresh(inputs),
  ]);
  expect(reads).toHaveLength(1);
  expect(reads[0]!.join(" ")).toContain("pullRequest(number: 2)");
  expect(reads[0]!.join(" ")).not.toContain("pullRequest(number: 1)");
  expect(calls[0]).toEqual(calls[1]);
  expect(calls[0]).toMatchObject([{ state: "merged" }, { state: "draft", title: "Update report", conflict: true }, { state: null }]);

  // Reopening the same page, even from another window, reuses both observations.
  await refresh(inputs);
  expect(reads).toHaveLength(1);
  mergeable = "UNKNOWN";
  expect(await refresh([item(4)])).toMatchObject([{ conflict: null }]);
  expect(starts[1]! - starts[0]!).toBe(5_000);

  now += CHAT_PULL_REQUEST_REFRESH_MS;
  mergeable = "MERGEABLE";
  expect(await refresh([item(2)])).toMatchObject([{ state: "draft", conflict: false }]);
  expect(reads).toHaveLength(3);
});
