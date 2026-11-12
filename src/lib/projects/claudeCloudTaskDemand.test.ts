import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AccountContext } from "@/lib/accounts/contracts";
import { queueClaudeCloudTasks, settleClaudeCloudTaskDemands } from "./claudeCloudTaskDemand";

const prior = process.env.LLV_STATE_DIR;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-task-demand-"));
process.env.LLV_STATE_DIR = root;
afterEach(async () => {
  await settleClaudeCloudTaskDemands();
  fs.rmSync(root, { recursive: true, force: true });
  process.env.LLV_STATE_DIR = prior;
});

test("a Claude Cloud admission queues every allowed project account without execution-capacity filtering", async () => {
  const project = "repo-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const accounts = ["account-a", "account-b", "account-denied"].map(id => ({
    id, label: id, home: path.join(root, id), projectsDir: root, kind: "managed" as const, authPresent: true, createdAt: 0,
  }));
  const contexts = new Map(accounts.map(value => [value.id, {
    engine: "claude" as const, accountId: value.id, kind: "managed" as const, home: value.home, transcriptRoot: value.home, env: { NODE_ENV: "test" as const },
  } satisfies AccountContext]));
  const prepared: string[] = [];
  const queued = queueClaudeCloudTasks(project, undefined, () => {}, {
    accounts: () => accounts,
    allowed: (_project, _engine, id) => id !== "account-denied",
    remote: () => "https://github.com/sample/project.git",
    resolve: (_project, id) => ({ kind: "available", account: contexts.get(id)! }),
    prepare: async input => { prepared.push(input.account.accountId); return { state: "unavailable", reason: "fixture readiness" }; },
  });
  await settleClaudeCloudTaskDemands();
  expect(queued.queued).toEqual(["account-a", "account-b"]);
  expect(prepared).toEqual(["account-a", "account-b"]);
});
