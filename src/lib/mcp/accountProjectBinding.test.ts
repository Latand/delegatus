import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeEach, expect, test } from "bun:test";

/* A throwaway state directory: the binding record this suite writes lives
   inside the sandbox, never in the operator's runtime state. */
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-account-binding-"));
const originalStateDir = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
fs.mkdirSync(process.env.LLV_STATE_DIR, { recursive: true });

afterAll(() => {
  if (originalStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = originalStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const { viewerMcpBindings } = await import("./bindings");
const { accountProjectBindings } = await import("@/lib/accounts/projectBindings");

const ATLAS = "project-atlas";
const BEACON = "project-beacon";
const RESERVED = "acct-reserved";
const SPARE = "acct-spare";

function bindingsFor(callerProject = ATLAS) {
  return viewerMcpBindings(undefined, undefined, {
    callerProject: () => callerProject,
    listBindableAccounts: (engine: "claude" | "codex") => engine === "claude"
      ? [{ accountId: RESERVED, label: "Reserved" }, { accountId: SPARE, label: "Spare" }]
      : [],
  } as never);
}

beforeEach(() => {
  fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
  fs.mkdirSync(process.env.LLV_STATE_DIR!, { recursive: true });
});

test("a list of an unconfigured project reports every account allowed, and no bindings", async () => {
  const read = await bindingsFor().account_project_binding({ clientRequestId: "binding-list" });
  expect(read).toMatchObject({
    action: "list",
    changed: false,
    project: ATLAS,
    bindings: [],
    allowedFor: { claude: { restricted: false, allowed: [{ accountId: RESERVED, label: "Reserved" }, { accountId: SPARE, label: "Spare" }] } },
  });
});

test("add and remove are confirmed by the record read back, and an independent read agrees", async () => {
  const tool = bindingsFor();
  /* Other rows in the table, which a write's answer no longer repeats (#1845). */
  await tool.account_project_binding({ clientRequestId: "binding-other", action: "add", engine: "claude", accountId: SPARE, project: BEACON });
  const added = await tool.account_project_binding({
    clientRequestId: "binding-add",
    action: "add",
    engine: "claude",
    accountId: RESERVED,
    project: ATLAS,
  });
  /* #1845: the write answers the row it changed, with `bound` re-read from
     the store, and that project's pool for that engine — never the table. */
  expect(added).toEqual({
    action: "add",
    changed: true,
    project: ATLAS,
    engine: "claude",
    accountId: RESERVED,
    bound: true,
    allowed: expect.objectContaining({ restricted: true, allowed: [{ accountId: RESERVED, label: "Reserved" }] }),
  });
  expect(Buffer.byteLength(JSON.stringify(added))).toBeLessThan(400);
  /* The answer is a read of the store, so a reader that never saw the call has
     to find the same row — this is the check an echo could not pass. */
  expect(accountProjectBindings()).toContainEqual(expect.objectContaining({ engine: "claude", accountId: RESERVED, project: ATLAS }));
  /* The whole table stays one list away. */
  const table = await tool.account_project_binding({ clientRequestId: "binding-table" }) as { bindings: unknown[] };
  expect(table.bindings).toHaveLength(2);

  const again = await tool.account_project_binding({
    clientRequestId: "binding-add-again",
    action: "add",
    engine: "claude",
    accountId: RESERVED,
    project: ATLAS,
  });
  expect(again).toMatchObject({ changed: false, bound: true, accountId: RESERVED });

  const removed = await tool.account_project_binding({
    clientRequestId: "binding-remove",
    action: "remove",
    engine: "claude",
    accountId: RESERVED,
    project: ATLAS,
  });
  expect(removed).toMatchObject({ action: "remove", changed: true, bound: false, allowed: { restricted: false } });
  expect(removed).not.toHaveProperty("bindings");
  expect(accountProjectBindings()).toEqual([expect.objectContaining({ accountId: SPARE, project: BEACON })]);
});

test("both directions of the relation come back from one read", async () => {
  const tool = bindingsFor();
  for (const [accountId, project] of [[RESERVED, ATLAS], [SPARE, ATLAS], [SPARE, BEACON]] as const) {
    await tool.account_project_binding({
      clientRequestId: `binding-${accountId}-${project}`,
      action: "add",
      engine: "claude",
      accountId,
      project,
    });
  }
  const read = await tool.account_project_binding({ clientRequestId: "binding-both-directions", project: ATLAS });
  expect(read).toMatchObject({
    allowedFor: { claude: { restricted: true, allowed: [{ accountId: RESERVED }, { accountId: SPARE }] } },
    accounts: {
      claude: [
        { accountId: RESERVED, projects: [ATLAS] },
        { accountId: SPARE, projects: [ATLAS, BEACON] },
      ],
    },
  });
});

test("a mutation missing its engine, account or project is refused with nothing written", async () => {
  const tool = bindingsFor();
  await expect(tool.account_project_binding({ clientRequestId: "binding-no-engine", action: "add", accountId: RESERVED, project: ATLAS }))
    .rejects.toThrow("engine must be claude or codex");
  await expect(tool.account_project_binding({ clientRequestId: "binding-no-account", action: "add", engine: "claude", project: ATLAS }))
    .rejects.toThrow("accountId is required");
  await expect(tool.account_project_binding({ clientRequestId: "binding-bad-action", action: "toggle", engine: "claude", accountId: RESERVED, project: ATLAS }))
    .rejects.toThrow("action must be list, add or remove");
  expect(accountProjectBindings()).toEqual([]);
});
