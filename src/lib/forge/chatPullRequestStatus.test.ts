import { expect, test } from "bun:test";

import { refreshChatPullRequestStatus } from "./chatPullRequestStatus";
import type { ChatPullRequest } from "./chatPullRequests";

test("targeted status checks reuse merged, fresh and failed results across panels", async () => {
  const item = (number: number): ChatPullRequest => ({
    repository: "sample/reports", number, url: `https://github.com/sample/reports/pull/${number}`, state: null,
  });
  const inputs = [{ ...item(1), state: "merged" as const }, item(2), item(3)];
  const reads: string[][] = [];
  const run = async (args: string[]) => {
    reads.push(args);
    return JSON.stringify({ data: {
      r0: { pullRequest: { state: "OPEN", isDraft: true, title: "Update report", additions: 12, deletions: 2 } },
      r1: null,
    } });
  };
  const calls = await Promise.all([
    refreshChatPullRequestStatus(inputs, undefined, run),
    refreshChatPullRequestStatus(inputs, undefined, run),
  ]);
  expect(reads).toHaveLength(1);
  expect(reads[0]!.join(" ")).toContain("pullRequest(number: 2)");
  expect(reads[0]!.join(" ")).not.toContain("pullRequest(number: 1)");
  expect(calls[0]).toEqual(calls[1]);
  expect(calls[0]).toMatchObject([{ state: "merged" }, { state: "draft", title: "Update report" }, { state: null }]);
});
