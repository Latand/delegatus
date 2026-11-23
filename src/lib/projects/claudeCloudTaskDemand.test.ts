import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AccountContext } from "@/lib/accounts/contracts";
import { queueClaudeCloudTasks, settleClaudeCloudTaskDemands } from "./claudeCloudTaskDemand";

const prior = process.env.LLV_STATE_DIR;
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-task-demand-"));
  process.env.LLV_STATE_DIR = root;
});
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
    remote: () => null,
    resolve: (_project, id) => ({ kind: "available", account: contexts.get(id)! }),
    prepare: async input => { prepared.push(input.account.accountId); return { state: "unavailable", reason: "fixture readiness" }; },
  }, "sample/project");
  await settleClaudeCloudTaskDemands();
  expect(queued.queued).toEqual(["account-a", "account-b"]);
  expect(prepared).toEqual(["account-a", "account-b"]);
});


test.each(["queued", "provider await"])("explicit preparation rechecks revoked authority after %s", async revokedAt => {
  let authorized = true, effects = 0;
  const account = { id: "account-a", label: "Fixture", home: root, projectsDir: root, kind: "managed" as const, authPresent: true, createdAt: 0 };
  queueClaudeCloudTasks("repo-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "account-a", () => {
    if (!authorized) throw new Error("Preparation authority withdrawn");
  }, {
    accounts: () => [account], allowed: () => true, remote: () => "https://github.com/sample/project",
    resolve: () => ({ kind: "available", account: { engine: "claude", accountId: account.id, kind: "managed", home: root, transcriptRoot: root, env: { NODE_ENV: "test" } } }),
    prepare: async input => {
      await Promise.resolve();
      if (revokedAt === "provider await") authorized = false;
      input.assertCurrent(); effects++;
      return { state: "unavailable", reason: "fixture readiness" };
    },
  }, undefined, { force: true });
  if (revokedAt === "queued") authorized = false;
  await settleClaudeCloudTaskDemands();
  expect(effects).toBe(0);
});
