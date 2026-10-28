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
const { createMcpToolService, MemoryMcpReceiptStore } = await import("./server");
const { accountProjectBindings } = await import("@/lib/accounts/projectBindings");
const { persistProjectAliases } = await import("@/lib/projects/aliases");

const ATLAS = "project-atlas";
const BEACON = "project-beacon";
const RESERVED = "acct-reserved";
const SPARE = "acct-spare";

function bindingsFor(callerProject: string | null = ATLAS, projects = [
  { project: ATLAS, displayName: "Atlas" },
  { project: BEACON, displayName: "Beacon" },
]) {
  return viewerMcpBindings(undefined, undefined, {
    callerProject: () => callerProject,
    registrySnapshot: () => ({ conversations: {} }),
    lastCompletedCatalog: () => ({ files: [], projectCatalog: projects }),
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

test("a list by display name returns the canonical project's stored restriction", async () => {
  const tool = bindingsFor();
  await tool.account_project_binding({ action: "add", engine: "claude", accountId: RESERVED, project: ATLAS });
  const read = await tool.account_project_binding({ action: "list", project: "Atlas" });
  expect(read).toMatchObject({
    project: ATLAS,
    allowedFor: { claude: { restricted: true, allowed: [{ accountId: RESERVED, label: "Reserved" }] } },
  });
});

test("an unknown project list refuses instead of reporting an unrestricted policy", async () => {
  const tool = bindingsFor();
  await tool.account_project_binding({ action: "add", engine: "claude", accountId: RESERVED, project: ATLAS });
  const service = createMcpToolService(tool, new MemoryMcpReceiptStore());
  const read = await service.callTool("account_project_binding", { clientRequestId: "binding-unknown", action: "list", project: "Missing project" });
  expect(read).toMatchObject({ ok: false, details: { code: "unknown_project", outcome: "not-executed" } });
  expect(read.error).toContain('no such project "Missing project"');
  expect(read).not.toHaveProperty("allowedFor");
  expect(accountProjectBindings()).toEqual([expect.objectContaining({ project: ATLAS, accountId: RESERVED })]);
});

test("an ambiguous display name list refuses and names the candidate project keys", async () => {
  const tool = bindingsFor(ATLAS, [
    { project: ATLAS, displayName: "Atlas" },
    { project: BEACON, displayName: "Atlas" },
  ]);
  await tool.account_project_binding({ action: "add", engine: "claude", accountId: RESERVED, project: ATLAS });
  const service = createMcpToolService(tool, new MemoryMcpReceiptStore());
  const read = await service.callTool("account_project_binding", { clientRequestId: "binding-ambiguous", action: "list", project: "Atlas" });
  expect(read).toMatchObject({
    ok: false,
    details: { code: "ambiguous_project", outcome: "not-executed", candidates: [ATLAS, BEACON] },
  });
  expect(read.error).toContain('ambiguous project "Atlas"');
  expect(read).not.toHaveProperty("allowedFor");
});

test("a canonical alias retains the restriction and a known unconfigured project allows every account", async () => {
  persistProjectAliases([{ source: "older-atlas", target: ATLAS, displayName: "Atlas" }]);
  const tool = bindingsFor();
  await tool.account_project_binding({ action: "add", engine: "claude", accountId: RESERVED, project: ATLAS });
  expect(await tool.account_project_binding({ action: "list", project: "older-atlas" })).toMatchObject({
    project: ATLAS,
    allowedFor: { claude: { restricted: true, allowed: [{ accountId: RESERVED, label: "Reserved" }] } },
  });
  expect(await tool.account_project_binding({ action: "list", project: "Beacon" })).toMatchObject({
    project: BEACON,
    allowedFor: { claude: { restricted: false, allowed: [{ accountId: RESERVED }, { accountId: SPARE }] } },
  });
});

test("a list without a project or caller returns the whole table without an effective policy", async () => {
  const tool = bindingsFor(null, []);
  await tool.account_project_binding({ action: "add", engine: "claude", accountId: RESERVED, project: ATLAS });
  await tool.account_project_binding({ action: "add", engine: "claude", accountId: SPARE, project: BEACON });
  const read = await tool.account_project_binding({ action: "list" });
  expect(read).toMatchObject({
    project: null,
    callerProject: null,
    bindings: [expect.objectContaining({ project: ATLAS }), expect.objectContaining({ project: BEACON })],
  });
  expect(read).not.toHaveProperty("allowedFor");
});

test("a binding refusal behind a foreign holder carries the safe public account-store message", async () => {
  const { foreignAccountHolder } = await import("@/lib/accounts/accountMutation.fixture");
  const { ACCOUNT_STORE_BUSY_MESSAGE } = await import("@/lib/accounts/accountMutation");
  const tool = bindingsFor();
  const holder = await foreignAccountHolder();
  try {
    holder.releaseAfter(120);
    const error = await tool.account_project_binding({
      clientRequestId: "binding-held-public-message", action: "add", engine: "claude", accountId: RESERVED, project: ATLAS,
    }).then(() => null, (caught: unknown) => caught);
    expect(error).toMatchObject({ message: `BUSY: ${ACCOUNT_STORE_BUSY_MESSAGE}` });
    expect((error as Error).message).not.toMatch(/pid|claude|codex|held by|account mutation/i);
    expect(accountProjectBindings()).toEqual([]);
  } finally { await holder.close(); }
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
    fallback: false,
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
    .rejects.toThrow("action must be list, add, remove or set-fallback");
  expect(accountProjectBindings()).toEqual([]);
});

test("binding tool adds, lists and clears the fallback flag", async () => {
  const tool = bindingsFor();
  const target = { engine: "claude", accountId: RESERVED, project: ATLAS };
  expect(await tool.account_project_binding({ ...target, action: "add", fallback: true })).toMatchObject({ bound: true, fallback: true });
  expect(await tool.account_project_binding({ action: "list", project: ATLAS })).toMatchObject({ bindings: [expect.objectContaining({ fallback: true })] });
  expect(await tool.account_project_binding({ ...target, action: "set-fallback", fallback: false })).toMatchObject({ changed: true, fallback: false });
  expect(accountProjectBindings()[0].fallback).toBe(false);
  await expect(tool.account_project_binding({ ...target, action: "set-fallback" })).rejects.toThrow("fallback is required");
  await expect(tool.account_project_binding({ ...target, accountId: SPARE, action: "set-fallback", fallback: true })).rejects.toThrow("NOT_BOUND");
});
