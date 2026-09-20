import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/* #1870 slice 7, driven only through the account store APIs that predate the
   move, so every case fails on behaviour at the merge base rather than on a
   new export. One mkdtemp state directory, never the live one; every account
   name is invented. */

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-accounts-legacy-"));
const OLD_STATE = process.env.LLV_STATE_DIR;
const OLD_CLAUDE_HOME = process.env.LLV_CLAUDE_HOME;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
process.env.LLV_CLAUDE_HOME = path.join(SANDBOX, "legacy-claude");

const claude = await import("./claude");
const bindings = await import("./projectBindings");
const overrides = await import("./accountOverrides");
const admission = await import("@/lib/agent/spawnAdmission");
const { accountMutationRevisionForTests, withAccountMutationLock } = await import("./accountMutation");
const { setAccountRemovalCheckpointForTests } = await import("./removal");
const { accountsCollectionRevision, accountsDatabasePath, resetAccountCollectionsForTests } = await import("./accountsStore");
const { readStateCollectionRows } = await import("@/lib/state/sqliteStateStore");
const { agentRegistry } = await import("@/lib/agent/registry");
const { beginLegacySpawnFixture } = await import("@/lib/agent/registryTestFixtures");

function stateDirectory(): string {
  return process.env.LLV_STATE_DIR!;
}

function statePath(name: string): string {
  return path.join(stateDirectory(), name);
}

function seed(name: string, body: unknown): void {
  fs.mkdirSync(stateDirectory(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(statePath(name), `${JSON.stringify(body, null, 2)}\n`);
}

/** Every persisted account row, exactly as stored, read back through one
    snapshot connection: the successor of comparing the bytes of a JSON file. */
function persistedRows(): { k: string; v: unknown }[] {
  return (readStateCollectionRows(accountsDatabasePath(stateDirectory()), "accounts") ?? []) as { k: string; v: unknown }[];
}

function rowValue(key: string): Record<string, unknown> | undefined {
  return persistedRows().find((row) => row.k === key)?.v as Record<string, unknown> | undefined;
}

beforeEach(() => {
  fs.rmSync(stateDirectory(), { recursive: true, force: true });
  fs.rmSync(process.env.LLV_CLAUDE_HOME!, { recursive: true, force: true });
  fs.rmSync(path.join(SANDBOX, "accounts"), { recursive: true, force: true });
  fs.rmSync(path.join(SANDBOX, "shared"), { recursive: true, force: true });
  resetAccountCollectionsForTests();
});

afterEach(() => setAccountRemovalCheckpointForTests(null));

afterAll(() => {
  if (OLD_STATE === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = OLD_STATE;
  if (OLD_CLAUDE_HOME === undefined) delete process.env.LLV_CLAUDE_HOME; else process.env.LLV_CLAUDE_HOME = OLD_CLAUDE_HOME;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

test("a legacy claude-accounts.json is imported on the first listing, and the file is retired behind a tombstone", () => {
  seed("claude-accounts.json", {
    version: 1,
    active: "default",
    accounts: [{ id: "lane-one", label: "Lane One", kind: "managed", createdAt: 1 }],
    retired: [],
    removals: [],
  });
  fs.mkdirSync(path.join(claude.claudeAccountsRoot(), "lane-one"), { recursive: true, mode: 0o700 });

  expect(claude.listClaudeAccounts().map((account) => account.id)).toEqual(["default", "lane-one"]);

  expect(fs.lstatSync(claude.claudeRegistryPath()).isDirectory()).toBe(true);
  expect(() => fs.readFileSync(claude.claudeRegistryPath(), "utf8")).toThrow(/EISDIR/);
  expect(rowValue("claude:lane-one")).toEqual({ id: "lane-one", label: "Lane One", kind: "managed", createdAt: 1 });
});

test("a legacy binding record is imported and a later binding writes one row, not the whole record", () => {
  seed("account-project-bindings.json", {
    schemaVersion: 1,
    bindings: [{ engine: "claude", accountId: "lane-one", project: "repo-alpha", createdAt: "2026-01-01T00:00:00.000Z" }],
  });

  expect(bindings.accountProjectBindings().map((binding) => binding.project)).toEqual(["repo-alpha"]);

  const added = bindings.bindAccountToProject("codex", "lane-two", "repo-beta");
  expect(added.ok).toBe(true);
  expect(bindings.accountProjectBindings().map((binding) => `${binding.engine}:${binding.project}`).sort())
    .toEqual(["claude:repo-alpha", "codex:repo-beta"]);
  expect(persistedRows().map((row) => row.k)).toEqual(expect.arrayContaining([
    "binding:claude:lane-one:repo-alpha",
    "binding:codex:lane-two:repo-beta",
  ]));
  expect(fs.lstatSync(statePath("account-project-bindings.json")).isDirectory()).toBe(true);
});

test("a legacy spawn admission fence is imported and still fences its own attempt", () => {
  seed("spawn-admission-fences.json", {
    version: 1,
    fences: {
      "attempt-from-before": {
        version: 1,
        clientAttemptId: "attempt-from-before",
        requestDigest: "a".repeat(64),
        status: 422,
        error: "the launch was refused before the move",
        rejectedAt: "2026-01-01T00:00:00.000Z",
      },
    },
  });

  expect(admission.readSpawnAdmissionFence("attempt-from-before")).toMatchObject({ status: 422 });

  const replay = admission.recordSpawnAdmissionRejection({
    clientAttemptId: "attempt-from-before",
    requestDigest: "a".repeat(64),
    status: 422,
    error: "the launch was refused before the move",
  }, () => null);
  expect(replay.kind).toBe("fenced");
  const conflict = admission.recordSpawnAdmissionRejection({
    clientAttemptId: "attempt-from-before",
    requestDigest: "b".repeat(64),
    status: 422,
    error: "a different request under the same key",
  }, () => null);
  expect(conflict.kind).toBe("conflict");
});

test("the out-of-pool journal keeps its legacy records and appends without rewriting them", () => {
  seed("account-project-overrides.json", {
    schemaVersion: 1,
    overrides: [{
      at: "2026-01-01T00:00:00.000Z",
      engine: "claude",
      project: "repo-alpha",
      accountId: "lane-one",
      allowedAccountIds: ["lane-two"],
      reason: "outside-pool",
      actor: "operator",
      actorConversationId: null,
      conversationId: null,
      via: "structured-reconfigure",
    }],
  });
  const bound = bindings.bindAccountToProject("claude", "lane-two", "repo-gamma");
  expect(bound.ok).toBe(true);
  const before = persistedRows().filter((row) => row.k.startsWith("override:")).map((row) => row.k);

  overrides.attributeNamedAccountChoice({
    engine: "claude",
    project: "repo-gamma",
    accountId: "lane-three",
    conversationId: null,
    actor: { kind: "operator" },
    via: "launch",
    now: () => "2026-02-02T00:00:00.000Z",
  });

  const after = persistedRows().filter((row) => row.k.startsWith("override:")).map((row) => row.k);
  expect(after.slice(0, before.length)).toEqual(before);
  expect(after).toHaveLength(before.length + 1);
  expect(overrides.accountProjectOverrides().map((override) => override.at))
    .toEqual(["2026-02-02T00:00:00.000Z", "2026-01-01T00:00:00.000Z"]);
});

test("the account mutation revision IS the accounts collection revision, and an empty transaction advances neither", () => {
  const account = claude.createManagedClaudeAccount("Revision");
  expect(accountMutationRevisionForTests()).toBe(accountsCollectionRevision(stateDirectory()));

  const before = accountMutationRevisionForTests();
  withAccountMutationLock(() => undefined);
  expect(accountMutationRevisionForTests()).toBe(before);

  claude.setActiveClaudeAccount(account.id);

  expect(accountMutationRevisionForTests()).toBe(before + 1);
  expect(accountsCollectionRevision(stateDirectory())).toBe(before + 1);
  expect(rowValue("active:claude")).toMatchObject({ active: account.id });
  // `account-mutation-revision.json` is gone: the revision has no file of its own.
  expect(fs.existsSync(statePath("account-mutation-revision.json"))
    && !fs.lstatSync(statePath("account-mutation-revision.json")).isDirectory()).toBe(false);
});

test("a #1857 removal commits the account row and its journal step in one transaction", () => {
  const account = claude.createManagedClaudeAccount("Removed");
  const observed: { checkpoint: string; revision: number; listed: boolean; retired: boolean; phase: unknown }[] = [];
  setAccountRemovalCheckpointForTests((checkpoint) => {
    const rows = persistedRows();
    const journal = rows.find((row) => row.k === `removal:claude:${account.id}`)?.v as { phase?: unknown } | undefined;
    observed.push({
      checkpoint,
      revision: accountsCollectionRevision(stateDirectory()),
      listed: rows.some((row) => row.k === `claude:${account.id}`),
      retired: rows.some((row) => row.k === `retired:claude:${account.id}`),
      phase: journal?.phase ?? null,
    });
  });

  claude.removeManagedClaudeAccount(account.id);

  const journaled = observed.find((step) => step.checkpoint === "journaled")!;
  const retiring = observed.find((step) => step.checkpoint === "registry-retired")!;
  const committed = observed.find((step) => step.checkpoint === "accounts-committed")!;
  /* The account row, its retired record and its journal step come out of one
     snapshot apiece: never an account removed with no journal step, nor a
     journal step ahead of the registry write it describes. */
  expect({ listed: journaled.listed, retired: journaled.retired, phase: journaled.phase })
    .toEqual({ listed: true, retired: false, phase: "archiving" });
  expect({ listed: retiring.listed, retired: retiring.retired, phase: retiring.phase })
    .toEqual({ listed: true, retired: false, phase: "retiring" });
  expect({ listed: committed.listed, retired: committed.retired, phase: committed.phase })
    .toEqual({ listed: false, retired: true, phase: "scrubbing" });
  /* The commit that removes the account, records its retirement and moves its
     journal to `scrubbing` is ONE transaction, and the account mutation
     revision advances with it rather than in a file of its own. */
  expect(committed.revision).toBe(retiring.revision + 1);
  expect(accountMutationRevisionForTests()).toBe(accountsCollectionRevision(stateDirectory()));

  expect(claude.listClaudeAccounts().map((row) => row.id)).not.toContain(account.id);
  expect(persistedRows().some((row) => row.k === `removal:claude:${account.id}`)).toBe(false);
});

/* A registry the store could not recover is a gap row, and a gap is never
   "nothing is retired": the spawn path refuses the launch on it, the way the
   direct file read refused by rethrowing anything that was not ENOENT. */
test("a registry recorded as a gap refuses a launch that names an account", () => {
  fs.mkdirSync(stateDirectory(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(statePath("claude-accounts.json"), Buffer.alloc(4096, 0));

  // The import records the gap and keeps the bytes aside.
  claude.listClaudeAccounts();

  expect(() => beginLegacySpawnFixture(agentRegistry(), {
    engine: "claude",
    cwd: "/repo",
    accountId: "lane-one",
  })).toThrow(/claude account registry could not be read/);
});

/* The fence store's own gap: the refusal was always right, but reading the
   path instead opened the tombstone and answered EISDIR, which named nothing.
   The recorded reason and the kept file name the cause. */
test("a fence store recorded as a gap names its reason instead of answering EISDIR", () => {
  fs.mkdirSync(stateDirectory(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(statePath("spawn-admission-fences.json"), Buffer.alloc(2048, 0));
  seed("claude-accounts.json", { version: 1, active: "default", accounts: [], retired: [], removals: [] });

  claude.listClaudeAccounts();

  let thrown: Error | null = null;
  try { admission.readSpawnAdmissionFence("attempt-after-the-gap"); }
  catch (error) { thrown = error as Error; }
  expect(thrown?.message).toContain("spawn admission fence store could not be read");
  expect(thrown?.message).toContain("spawn-admission-fences.json.unreadable-");
  expect(thrown?.message).not.toContain("EISDIR");
});
