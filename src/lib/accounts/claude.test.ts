import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-claude-accounts-test-"));
const OLD_STATE = process.env.LLV_STATE_DIR;
const OLD_HOME = process.env.LLV_CLAUDE_HOME;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
process.env.LLV_CLAUDE_HOME = path.join(SANDBOX, "legacy-claude");

const mod = await import("./claude");
const { AccountArchiveUnavailableError, AccountRemovalBlockedError, retiredAccountArchive, setAccountRemovalCheckpointForTests } = await import("./removal");
const { agentRegistry } = await import("@/lib/agent/registry");
const { beginLegacySpawnFixture } = await import("@/lib/agent/registryTestFixtures");

beforeEach(() => {
  fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
  fs.rmSync(process.env.LLV_CLAUDE_HOME!, { recursive: true, force: true });
  fs.rmSync(path.join(SANDBOX, "accounts"), { recursive: true, force: true });
  fs.rmSync(path.join(SANDBOX, "shared"), { recursive: true, force: true });
});
afterAll(() => {
  if (OLD_STATE === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = OLD_STATE;
  if (OLD_HOME === undefined) delete process.env.LLV_CLAUDE_HOME; else process.env.LLV_CLAUDE_HOME = OLD_HOME;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

test("legacy Claude is Main and account creation never rewrites legacy credentials", () => {
  const credentials = path.join(process.env.LLV_CLAUDE_HOME!, ".credentials.json");
  fs.mkdirSync(path.dirname(credentials), { recursive: true, mode: 0o700 });
  fs.writeFileSync(credentials, "legacy-secret", { mode: 0o600 });
  const before = fs.readFileSync(credentials, "utf8");
  const account = mod.createManagedClaudeAccount("Work");
  expect(mod.listClaudeAccounts()[0]).toEqual(expect.objectContaining({ id: "default", label: "Main", kind: "legacy" }));
  expect(account.projectsDir).toBe(path.join(account.home, "projects"));
  expect(fs.readFileSync(credentials, "utf8")).toBe(before);
  expect(fs.statSync(account.home).mode & 0o777).toBe(0o700);
});

test("managed homes are distinct, snapshot-only, contained, and scrub inherited credentials", () => {
  const skills = path.join(process.env.LLV_CLAUDE_HOME!, "skills", "safe.md");
  fs.mkdirSync(path.dirname(skills), { recursive: true }); fs.writeFileSync(skills, "safe");
  const a = mod.createManagedClaudeAccount("A"); const b = mod.createManagedClaudeAccount("B");
  expect(a.home).not.toBe(b.home);
  expect(fs.lstatSync(path.join(a.home, "skills")).isSymbolicLink()).toBe(true);
  expect(fs.realpathSync(path.join(a.home, "skills"))).toContain(path.join("shared", "claude"));
  const env = mod.claudeManagedEnvironment(a.home, { NODE_ENV: "test", ANTHROPIC_API_KEY: "secret", CLAUDE_CODE_OAUTH_TOKEN: "secret", SAFE: "yes" });
  expect(env).toEqual(expect.objectContaining({ CLAUDE_CONFIG_DIR: a.home, SAFE: "yes" }));
  expect(env.ANTHROPIC_API_KEY).toBeUndefined(); expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  const transcript = path.join(a.projectsDir, "-repo", "12345678-1234-1234-1234-123456789abc.jsonl");
  fs.mkdirSync(path.dirname(transcript), { recursive: true }); fs.writeFileSync(transcript, "{}");
  expect(mod.claudeHomeOwningTranscript(transcript)).toBe(a.home);
});

test("unsafe modes and corrupt registries reject sensitive mutation while read mode stays Main", () => {
  const account = mod.createManagedClaudeAccount("Unsafe");
  fs.chmodSync(account.home, 0o755);
  expect(() => mod.claudeAccountForSpawn(account.id)).toThrow();
  fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
  const registry = mod.claudeRegistryPath(); fs.mkdirSync(path.dirname(registry), { recursive: true }); fs.writeFileSync(registry, "{ corrupt registry");
  expect(mod.listClaudeAccounts().map((item) => item.id)).toEqual(["default"]);
  expect(() => mod.createManagedClaudeAccount("Other")).toThrow(mod.CorruptClaudeAccountsError);
  expect(fs.readFileSync(registry, "utf8")).toBe("{ corrupt registry");
});

test("managed credentials reject symlinks and broad modes before an agent can spawn", () => {
  const account = mod.createManagedClaudeAccount("Credential safety");
  const credentials = path.join(account.home, ".credentials.json");
  fs.writeFileSync(credentials, "{}", { mode: 0o600 });
  expect(mod.managedClaudeCredentialIsSafe(account.home, true)).toBe(true);
  fs.chmodSync(credentials, 0o644);
  expect(mod.managedClaudeCredentialIsSafe(account.home, true)).toBe(false);
  expect(() => mod.claudeAccountForSpawn(account.id)).toThrow(mod.UnsafeClaudeHomeError);
  fs.rmSync(credentials); fs.symlinkSync(path.join(process.env.LLV_CLAUDE_HOME!, "missing"), credentials);
  expect(mod.managedClaudeCredentialIsSafe(account.home, true)).toBe(false);
});

test("managed account removal deletes its registry record and home, while orphan cleanup only removes safe managed children", () => {
  const account = mod.createManagedClaudeAccount("Delete me");
  const orphan = path.join(mod.claudeAccountsRoot(), "probe-login");
  fs.mkdirSync(orphan, { recursive: true, mode: 0o700 });

  mod.removeManagedClaudeAccount(account.id);
  const cleaned = mod.cleanupOrphanedClaudeHomes();

  expect(mod.listClaudeAccounts().map((item) => item.id)).not.toContain(account.id);
  expect(fs.existsSync(account.home)).toBe(false);
  expect(cleaned).toEqual({ removed: ["probe-login"], unresolved: [] });
  expect(fs.existsSync(orphan)).toBe(false);
});

test("durable account retirement rejects every later spawn admission", () => {
  const account = mod.createManagedClaudeAccount("Retired admission");
  mod.removeManagedClaudeAccount(account.id);

  expect(() => beginLegacySpawnFixture(agentRegistry(), {
    engine: "claude",
    cwd: "/repo",
    accountId: account.id,
  })).toThrow("claude account is retired");
});

test("sidecar cleanup does not follow a symlink outside the accounts root", () => {
  const account = mod.createManagedClaudeAccount("Linked sidecar");
  const sidecar = `${account.home}.lock`;
  const outside = path.join(SANDBOX, "outside-sidecar-target");
  const marker = path.join(outside, "keep.txt");
  fs.mkdirSync(sidecar, { mode: 0o700 });
  fs.mkdirSync(outside, { mode: 0o700 });
  fs.writeFileSync(marker, "keep", { mode: 0o600 });
  fs.symlinkSync(outside, path.join(sidecar, "external"));

  const removal = mod.removeManagedClaudeAccount(account.id);

  expect(removal).toMatchObject({ cleanupPending: true });
  expect(fs.readFileSync(marker, "utf8")).toBe("keep");
  expect(fs.lstatSync(path.join(sidecar, "external")).isSymbolicLink()).toBe(true);
});

test("a provider sidecar recreated during cleanup leaves cleanup pending", () => {
  const account = mod.createManagedClaudeAccount("Recreated sidecar");
  const sidecar = `${account.home}.lock`;
  fs.mkdirSync(sidecar, { mode: 0o700 });
  const originalRm = fs.rmSync;
  fs.rmSync = ((target: fs.PathLike, options?: fs.RmDirOptions) => {
    const result = originalRm(target, options);
    if (path.basename(String(target)) === path.basename(sidecar)) fs.mkdirSync(sidecar, { mode: 0o700 });
    return result;
  }) as typeof fs.rmSync;

  let removal: { cleanupPending: boolean } | undefined;
  try { removal = mod.removeManagedClaudeAccount(account.id); }
  finally { fs.rmSync = originalRm; }

  expect(removal).toMatchObject({ cleanupPending: true });
  expect(fs.existsSync(sidecar)).toBe(true);
});

test("a sidecar appearing after root enumeration is still cleaned", () => {
  const account = mod.createManagedClaudeAccount("Late sidecar");
  const sidecar = `${account.home}.lock`;
  const root = mod.claudeAccountsRoot();
  const originalRead = fs.readdirSync;
  let injected = false;
  fs.readdirSync = ((target: fs.PathLike, options?: unknown) => {
    const entries = originalRead(target, options as never);
    if (!injected && path.resolve(String(target)) === path.resolve(root)) {
      injected = true;
      fs.mkdirSync(sidecar, { mode: 0o700 });
    }
    return entries;
  }) as typeof fs.readdirSync;

  let removal: { cleanupPending: boolean } | undefined;
  try { removal = mod.removeManagedClaudeAccount(account.id); }
  finally { fs.readdirSync = originalRead; }

  expect(removal).toMatchObject({ cleanupPending: false });
  expect(fs.existsSync(sidecar)).toBe(false);
});

test("orphan cleanup reports unsafe Claude children for manual recovery", () => {
  const unsafe = path.join(mod.claudeAccountsRoot(), "unsafe-orphan");
  const link = path.join(mod.claudeAccountsRoot(), "linked-orphan");
  fs.mkdirSync(unsafe, { recursive: true, mode: 0o777 });
  fs.chmodSync(unsafe, 0o777);
  fs.symlinkSync(unsafe, link);

  const result = mod.cleanupOrphanedClaudeHomes();

  expect(result.unresolved).toEqual(expect.arrayContaining(["unsafe-orphan", "linked-orphan"]));
  expect(fs.existsSync(unsafe)).toBe(true);
  expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
});

test("orphan cleanup preserves a safe-looking home with unowned history", () => {
  const orphan = path.join(mod.claudeAccountsRoot(), "history-orphan");
  const transcript = path.join(orphan, "projects", "-repo", "unowned.jsonl");
  fs.mkdirSync(path.dirname(transcript), { recursive: true, mode: 0o700 });
  fs.chmodSync(orphan, 0o700);
  fs.writeFileSync(transcript, "{}\n", { mode: 0o600 });

  const result = mod.cleanupOrphanedClaudeHomes();

  expect(result).toMatchObject({
    removed: [],
    unresolved: ["history-orphan"],
    history: {
      "history-orphan": {
        home: orphan,
        artifacts: expect.arrayContaining([{
          path: path.relative(orphan, transcript),
          classification: "history",
          history: true,
        }]),
      },
    },
  });
  expect(fs.readFileSync(transcript, "utf8")).toBe("{}\n");
});

test("orphan cleanup preserves a home owned by an in-flight spawn", () => {
  const orphan = path.join(mod.claudeAccountsRoot(), "live-orphan");
  fs.mkdirSync(orphan, { recursive: true, mode: 0o700 });
  beginLegacySpawnFixture(agentRegistry(), { engine: "claude", cwd: "/repo", accountId: "live-orphan" });

  const result = mod.cleanupOrphanedClaudeHomes();

  expect(result.unresolved).toContain("live-orphan");
  expect(fs.existsSync(orphan)).toBe(true);
});

test("orphan cleanup removes exact stale sidecars and preserves registered account locks", () => {
  const registered = mod.createManagedClaudeAccount("Registered lock");
  const registeredSidecar = `${registered.home}.lock`;
  const staleSidecar = path.join(mod.claudeAccountsRoot(), "stale-account.lock");
  fs.mkdirSync(registeredSidecar, { mode: 0o700 });
  fs.mkdirSync(staleSidecar, { mode: 0o700 });

  const result = mod.cleanupOrphanedClaudeHomes();

  expect(result).toEqual({ removed: ["stale-account.lock"], unresolved: [] });
  expect(fs.existsSync(staleSidecar)).toBe(false);
  expect(fs.existsSync(registeredSidecar)).toBe(true);
});

test("orphan cleanup propagates a Claude accounts-root read failure", () => {
  const root = mod.claudeAccountsRoot();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const originalRead = fs.readdirSync;
  fs.readdirSync = ((target: fs.PathLike, options?: unknown) => {
    if (path.resolve(String(target)) === path.resolve(root)) throw Object.assign(new Error("unreadable"), { code: "EACCES" });
    return originalRead(target, options as never);
  }) as typeof fs.readdirSync;
  try {
    expect(() => mod.cleanupOrphanedClaudeHomes()).toThrow("unreadable");
  } finally {
    fs.readdirSync = originalRead;
  }
});

test("an interrupted registry replacement leaves the prior atomic registry readable", () => {
  const account = mod.createManagedClaudeAccount("Atomic");
  const registry = mod.claudeRegistryPath();
  fs.writeFileSync(`${registry}.${process.pid}.tmp`, "{ interrupted");
  expect(mod.listClaudeAccounts().map((item) => item.id)).toContain(account.id);
  mod.setActiveClaudeAccount(account.id);
  expect(mod.activeClaudeAccountId()).toBe(account.id);
});

test("concurrent child processes create and select accounts without losing registry updates", async () => {
  const modulePath = path.join(import.meta.dir, "claude.ts");
  const mutationPath = path.join(import.meta.dir, "accountMutation.ts");
  const run = (source: string) => Bun.spawn({
    cmd: [process.execPath, "-e", source],
    env: { ...process.env, LLV_STATE_DIR: process.env.LLV_STATE_DIR!, LLV_CLAUDE_HOME: process.env.LLV_CLAUDE_HOME! },
    stdout: "ignore",
    stderr: "pipe",
  });
  const create = (label: string) => run(`
    const m = await import(${JSON.stringify(modulePath)});
    const { withAccountMutationLockAsync } = await import(${JSON.stringify(mutationPath)});
    await withAccountMutationLockAsync(async () => m.createManagedClaudeAccount(${JSON.stringify(label)}));
  `);
  const [first, second] = [create("Child A"), create("Child B")];
  expect(await first.exited).toBe(0); expect(await second.exited).toBe(0);
  const ids = mod.listClaudeAccounts().map((item) => item.id);
  expect(ids).toEqual(expect.arrayContaining(["child-a", "child-b"]));
  const select = (id: string) => run(`
    const m = await import(${JSON.stringify(modulePath)});
    const { withAccountMutationLockAsync } = await import(${JSON.stringify(mutationPath)});
    await withAccountMutationLockAsync(async () => m.setActiveClaudeAccount(${JSON.stringify(id)}));
  `);
  const [left, right] = [select("child-a"), select("child-b")];
  expect(await left.exited).toBe(0); expect(await right.exited).toBe(0);
  expect(["child-a", "child-b"]).toContain(mod.activeClaudeAccountId());
});

test("a home whose projects symlinks into the shared store reports the canonical root", () => {
  const shared = mod.sharedClaudeProjectsRoot();
  fs.mkdirSync(shared, { recursive: true, mode: 0o700 });
  const home = process.env.LLV_CLAUDE_HOME!;
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.symlinkSync(shared, path.join(home, "projects"));
  try {
    const main = mod.listClaudeAccounts()[0]!;
    expect(main.projectsDir).toBe(shared);
    // Inside the shared store the path names no owner: ownership is the
    // registry's job (phase 0), so containment refuses to guess.
    const project = path.join(shared, "-repo");
    fs.mkdirSync(project, { recursive: true, mode: 0o700 });
    const transcript = path.join(project, "session.jsonl");
    fs.writeFileSync(transcript, "{}\n", { mode: 0o600 });
    expect(mod.claudeHomeOwningTranscript(transcript)).toBeNull();
  } finally {
    fs.rmSync(path.join(SANDBOX, "shared"), { recursive: true, force: true });
  }
});

test("a home with a real projects directory keeps its local root", () => {
  const home = process.env.LLV_CLAUDE_HOME!;
  const local = path.join(home, "projects");
  fs.mkdirSync(local, { recursive: true, mode: 0o700 });
  expect(mod.listClaudeAccounts()[0]!.projectsDir).toBe(local);
  const project = path.join(local, "-repo");
  fs.mkdirSync(project, { recursive: true, mode: 0o700 });
  const transcript = path.join(project, "session.jsonl");
  fs.writeFileSync(transcript, "{}\n", { mode: 0o600 });
  expect(mod.claudeHomeOwningTranscript(transcript)).toBe(home);
});

/* #1026 — a Claude-engine agent hands over the native `<home>/projects/...`
   path its own CLI writes, while every viewer record addresses the shared
   store. Translating is safe exactly when the mirrored file is really there. */
test("a native projects path maps to its shared-store mirror only when that file exists", () => {
  const shared = mod.sharedClaudeProjectsRoot();
  const home = process.env.LLV_CLAUDE_HOME!;
  const project = "-home-agent-repo";
  fs.mkdirSync(path.join(home, "projects", project), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(shared, project), { recursive: true, mode: 0o700 });
  const mirrored = path.join(shared, project, "session.jsonl");
  fs.writeFileSync(mirrored, "{}\n", { mode: 0o600 });

  expect(mod.mirroredClaudeTranscriptPath(path.join(home, "projects", project, "session.jsonl"))).toBe(mirrored);
  /* Nothing mirrored: a rejection the caller can act on beats a phantom path. */
  expect(mod.mirroredClaudeTranscriptPath(path.join(home, "projects", project, "stranger.jsonl"))).toBeNull();
  /* Already canonical, and paths outside every account's projects root. */
  expect(mod.mirroredClaudeTranscriptPath(mirrored)).toBeNull();
  expect(mod.mirroredClaudeTranscriptPath(path.join(home, "elsewhere", "session.jsonl"))).toBeNull();
  expect(mod.mirroredClaudeTranscriptPath("/codex/sessions/session.jsonl")).toBeNull();
});


test("new account creation refuses a pre-existing or unknown platform store", async () => {
  const store = await import("./claudeCredentials");
  const target = path.join(mod.claudeAccountsRoot(), "reused");
  const read = spyOn(store, "readClaudeCredentials");
  try {
    for (const state of ["present", "unknown"] as const) {
      read.mockImplementation((home) => home !== target ? { state: "absent" }
        : state === "present" ? { state, source: "keychain", document: {} } : { state });
      expect(() => mod.createManagedClaudeAccount("Reused")).toThrow(mod.UnsafeClaudeHomeError);
      expect(fs.existsSync(target)).toBe(false);
      expect(mod.listClaudeAccounts().some((account) => account.id === "reused")).toBe(false);
    }
  } finally { read.mockRestore(); }
});

/* ---- #1857: removal moves the leftovers into the shared archive ---- */

const SESSION_ID = ["12345678", "1234", "1234", "1234", "123456789abc"].join("-");
const LEFTOVERS: Record<string, string> = {
  "history.jsonl": "{\"display\":\"prompt history\"}\n",
  [path.join("shell-snapshots", "snapshot-zsh.sh")]: "export PATH=/usr/bin\n",
  [path.join("backups", ".claude.json.backup.1")]: "{\"projects\":{}}\n",
  [path.join("paste-cache", "pasted.txt")]: "pasted text\n",
  [path.join(".llv", "state.json")]: "{}\n",
  [path.join("statsig", "statsig.cached.json")]: "{}\n",
  [path.join("sessions", "4242.json")]: "{}\n",
  ".claude.json": "{\"numStartups\":3}\n",
};

function readRegistryJson(): { accounts: Array<{ id: string }>; retired: Array<{ id: string; archived?: boolean }>; removals?: unknown[] } {
  return JSON.parse(fs.readFileSync(mod.claudeRegistryPath(), "utf8"));
}

/** A home shaped like the operator's Claude B: `projects` links into the
    shared store and holds no transcript; everything else is CLI runtime state. */
function usedClaudeHome(label: string) {
  const account = mod.createManagedClaudeAccount(label);
  const shared = mod.sharedClaudeProjectsRoot();
  fs.mkdirSync(path.join(shared, "-repo"), { recursive: true, mode: 0o700 });
  fs.rmSync(path.join(account.home, "projects"), { recursive: true });
  fs.symlinkSync(shared, path.join(account.home, "projects"));
  const sharedTranscript = path.join(shared, "-repo", `${SESSION_ID}.jsonl`);
  fs.writeFileSync(sharedTranscript, "{\"cwd\":\"/repo\"}\n", { mode: 0o600 });
  const homeAddressed = path.join(account.home, "projects", "-repo", `${SESSION_ID}.jsonl`);
  for (const [relative, contents] of Object.entries(LEFTOVERS)) {
    fs.mkdirSync(path.dirname(path.join(account.home, relative)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(account.home, relative), contents, { mode: 0o600 });
  }
  fs.writeFileSync(path.join(account.home, ".credentials.json"), "{}", { mode: 0o600 });
  const conversation = agentRegistry().ensureConversation("claude", homeAddressed, account.id);
  return { account, shared, sharedTranscript, homeAddressed, conversation, archive: retiredAccountArchive("claude", account.id) };
}

function expectHomeUntouched(fixture: ReturnType<typeof usedClaudeHome>): void {
  for (const [relative, contents] of Object.entries(LEFTOVERS)) {
    expect(fs.readFileSync(path.join(fixture.account.home, relative), "utf8")).toBe(contents);
  }
  expect(fs.readFileSync(path.join(fixture.account.home, ".credentials.json"), "utf8")).toBe("{}");
  expect(fs.lstatSync(path.join(fixture.account.home, "projects")).isSymbolicLink()).toBe(true);
  expect(fs.existsSync(fixture.archive)).toBe(false);
  expect(mod.listClaudeAccounts().map((item) => item.id)).toContain(fixture.account.id);
  expect(readRegistryJson().removals ?? []).toEqual([]);
}

test("a used Claude home is removed and every leftover moves into the shared archive (#1857)", () => {
  const fixture = usedClaudeHome("Invented Bravo");
  agentRegistry().setConversationMigration(fixture.conversation.id, {
    intentId: "intent-parked",
    phase: "failed-recoverable",
    targetId: "default",
    revision: 1,
    error: "successor never verified",
    updatedAt: new Date().toISOString(),
  });
  const delivery = agentRegistry().holdDelivery(fixture.conversation.id, "owed for weeks");

  const removal = mod.removeManagedClaudeAccount(fixture.account.id);

  const leftoverBytes = Object.values(LEFTOVERS).reduce((sum, contents) => sum + Buffer.byteLength(contents), 0);
  expect(removal).toEqual({
    archive: fixture.archive,
    files: Object.keys(LEFTOVERS).length,
    bytes: leftoverBytes,
    conversationsRewritten: 1,
    pinsCleared: 0,
    deliveriesDropped: 1,
    migrationsSettled: 1,
    cleanupPending: false,
  });
  expect(fs.existsSync(fixture.account.home)).toBe(false);
  for (const [relative, contents] of Object.entries(LEFTOVERS)) {
    expect(fs.readFileSync(path.join(fixture.archive, relative), "utf8")).toBe(contents);
  }
  for (const name of [".credentials.json", "projects", "skills", "commands", "agents"]) {
    expect(() => fs.lstatSync(path.join(fixture.archive, name))).toThrow();
  }
  // The shared store is untouched and the conversation addresses it directly.
  expect(fs.readFileSync(fixture.sharedTranscript, "utf8")).toBe("{\"cwd\":\"/repo\"}\n");
  const conversation = agentRegistry().readOnlySnapshot().conversations[fixture.conversation.id]!;
  expect(conversation.generations.map((generation) => generation.path)).toEqual([fixture.sharedTranscript]);
  expect(conversation.migration).toBeNull();
  expect(agentRegistry().readOnlySnapshot().heldDeliveries[delivery.id]?.state).toBe("failed");
  expect(mod.claudeTranscriptOwnership(fixture.sharedTranscript, fixture.account.id)).toMatchObject({ kind: "owned", source: "shared-store" });
  // The account left the dialog; its id is retired and never reissued.
  expect(mod.listClaudeAccounts().map((item) => item.id)).not.toContain(fixture.account.id);
  expect(readRegistryJson().retired).toContainEqual(expect.objectContaining({ id: fixture.account.id, archived: true }));
  expect(readRegistryJson().removals ?? []).toEqual([]);
  expect(mod.createManagedClaudeAccount("Invented Bravo").id).not.toBe(fixture.account.id);
});

test("a Claude home with its own projects directory keeps its transcripts readable from the archive", () => {
  const account = mod.createManagedClaudeAccount("Invented Local");
  const transcript = path.join(account.projectsDir, "-repo", `${SESSION_ID}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true, mode: 0o700 });
  fs.writeFileSync(transcript, "{\"cwd\":\"/repo\"}\n", { mode: 0o600 });
  const conversation = agentRegistry().ensureConversation("claude", transcript, account.id);
  const archive = retiredAccountArchive("claude", account.id);

  mod.removeManagedClaudeAccount(account.id);

  const moved = path.join(archive, "projects", "-repo", `${SESSION_ID}.jsonl`);
  expect(fs.readFileSync(moved, "utf8")).toBe("{\"cwd\":\"/repo\"}\n");
  expect(mod.claudeProjectRoots()).toContain(path.join(archive, "projects"));
  expect(agentRegistry().readOnlySnapshot().conversations[conversation.id]!.generations[0]!.path).toBe(moved);
});

test("an existing archive destination refuses removal and leaves the home untouched", () => {
  const fixture = usedClaudeHome("Invented Taken");
  fs.mkdirSync(fixture.archive, { recursive: true, mode: 0o700 });

  expect(() => mod.removeManagedClaudeAccount(fixture.account.id)).toThrow(AccountArchiveUnavailableError);

  fs.rmdirSync(fixture.archive);
  expectHomeUntouched(fixture);
  expect(agentRegistry().readOnlySnapshot().conversations[fixture.conversation.id]!.generations[0]!.path).toBe(fixture.homeAddressed);
});

test("a home on another filesystem than the archive is refused before anything moves", () => {
  const fixture = usedClaudeHome("Invented Device");
  const originalLstat = fs.lstatSync;
  fs.lstatSync = ((target: fs.PathLike, options?: unknown) => {
    const stat = originalLstat(target, options as never) as fs.Stats;
    if (path.resolve(String(target)) !== path.resolve(fixture.account.home)) return stat;
    return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { dev: stat.dev + 1 });
  }) as typeof fs.lstatSync;
  try { expect(() => mod.removeManagedClaudeAccount(fixture.account.id)).toThrow(AccountArchiveUnavailableError); }
  finally { fs.lstatSync = originalLstat; }

  expectHomeUntouched(fixture);
});

for (const code of ["EACCES", "EXDEV"] as const) {
  test(`a failed home rename (${code}) changes nothing and clears the journal`, () => {
    const fixture = usedClaudeHome(`Invented Rename ${code}`);
    const originalRename = fs.renameSync;
    fs.renameSync = ((source: fs.PathLike, destination: fs.PathLike) => {
      if (path.resolve(String(source)) === path.resolve(fixture.account.home)) throw Object.assign(new Error("rename refused"), { code });
      return originalRename(source, destination);
    }) as typeof fs.renameSync;
    try {
      expect(() => mod.removeManagedClaudeAccount(fixture.account.id)).toThrow(code === "EXDEV" ? AccountArchiveUnavailableError : Error);
    } finally { fs.renameSync = originalRename; }

    expectHomeUntouched(fixture);
  });
}

test("a conversation that turns live inside the registry mutation puts the home back", () => {
  const fixture = usedClaudeHome("Invented Late");
  setAccountRemovalCheckpointForTests((reached) => {
    if (reached === "renamed") beginLegacySpawnFixture(agentRegistry(), { engine: "claude", cwd: "/repo", accountId: fixture.account.id });
  });
  try { expect(() => mod.removeManagedClaudeAccount(fixture.account.id)).toThrow(AccountRemovalBlockedError); }
  finally { setAccountRemovalCheckpointForTests(null); }

  expectHomeUntouched(fixture);
  expect(agentRegistry().readOnlySnapshot().conversations[fixture.conversation.id]!.generations[0]!.path).toBe(fixture.homeAddressed);
});

test("an accounts-registry write failure restores the agent registry and the home", () => {
  const fixture = usedClaudeHome("Invented Commit");
  const originalRename = fs.renameSync;
  let retired = false;
  setAccountRemovalCheckpointForTests((reached) => { if (reached === "registry-retired") retired = true; });
  fs.renameSync = ((source: fs.PathLike, destination: fs.PathLike) => {
    if (retired && path.resolve(String(destination)) === path.resolve(mod.claudeRegistryPath())) {
      retired = false;
      throw Object.assign(new Error("registry write denied"), { code: "EACCES" });
    }
    return originalRename(source, destination);
  }) as typeof fs.renameSync;
  try { expect(() => mod.removeManagedClaudeAccount(fixture.account.id)).toThrow("registry write denied"); }
  finally { fs.renameSync = originalRename; setAccountRemovalCheckpointForTests(null); }

  expectHomeUntouched(fixture);
  expect(agentRegistry().readOnlySnapshot().conversations[fixture.conversation.id]!.generations[0]!.path).toBe(fixture.homeAddressed);
});

test("a credential that cannot be unlinked leaves cleanup pending, and recovery finishes it", () => {
  const fixture = usedClaudeHome("Invented Credential");
  const originalUnlink = fs.unlinkSync;
  fs.unlinkSync = ((target: fs.PathLike) => {
    if (path.basename(String(target)) === ".credentials.json") throw Object.assign(new Error("denied"), { code: "EACCES" });
    return originalUnlink(target);
  }) as typeof fs.unlinkSync;
  let removal: ReturnType<typeof mod.removeManagedClaudeAccount>;
  try { removal = mod.removeManagedClaudeAccount(fixture.account.id); }
  finally { fs.unlinkSync = originalUnlink; }

  expect(removal.cleanupPending).toBe(true);
  expect(mod.listClaudeAccounts().map((item) => item.id)).not.toContain(fixture.account.id);
  expect(fs.existsSync(path.join(fixture.archive, ".credentials.json"))).toBe(true);
  expect(mod.recoverInterruptedClaudeAccountRemovals()).toEqual({ recovered: [fixture.account.id], unresolved: [] });
  expect(fs.existsSync(path.join(fixture.archive, ".credentials.json"))).toBe(false);
  expect(readRegistryJson().removals ?? []).toEqual([]);
});

test("creating an account keeps the shared transcript store and the removed-account archive (#1859)", () => {
  const fixture = usedClaudeHome("Invented Keeper");
  mod.removeManagedClaudeAccount(fixture.account.id);

  mod.createManagedClaudeAccount("Invented Newcomer");

  expect(fs.readFileSync(fixture.sharedTranscript, "utf8")).toBe("{\"cwd\":\"/repo\"}\n");
  expect(fs.readFileSync(path.join(fixture.archive, "history.jsonl"), "utf8")).toBe(LEFTOVERS["history.jsonl"]!);
});

async function crashRemovalAt(accountId: string, checkpoint: string): Promise<void> {
  const child = Bun.spawn({
    cmd: [process.execPath, path.join(import.meta.dir, "fixtures", "accountRemovalCrash.ts"), "claude", accountId, checkpoint],
    env: { ...process.env, LLV_STATE_DIR: process.env.LLV_STATE_DIR!, LLV_CLAUDE_HOME: process.env.LLV_CLAUDE_HOME! },
    stdout: "ignore",
    stderr: "pipe",
  });
  await child.exited;
  expect(child.signalCode).toBe("SIGKILL");
}

for (const checkpoint of ["journaled", "renamed", "registry-retired"] as const) {
  test(`a Viewer killed after the removal step "${checkpoint}" gets its home back on recovery`, async () => {
    const fixture = usedClaudeHome(`Invented Crash ${checkpoint}`);
    await crashRemovalAt(fixture.account.id, checkpoint);
    expect(readRegistryJson().removals).toHaveLength(1);

    expect(mod.recoverInterruptedClaudeAccountRemovals()).toEqual({ recovered: [fixture.account.id], unresolved: [] });

    expectHomeUntouched(fixture);
    // A retry after recovery completes the removal.
    expect(mod.removeManagedClaudeAccount(fixture.account.id).archive).toBe(fixture.archive);
    expect(fs.existsSync(fixture.account.home)).toBe(false);
  });
}

test("a Viewer killed after the accounts registry committed finishes the removal on recovery", async () => {
  const fixture = usedClaudeHome("Invented Crash committed");
  await crashRemovalAt(fixture.account.id, "accounts-committed");
  expect(mod.listClaudeAccounts().map((item) => item.id)).not.toContain(fixture.account.id);
  expect(fs.existsSync(path.join(fixture.archive, ".credentials.json"))).toBe(true);

  expect(mod.recoverInterruptedClaudeAccountRemovals()).toEqual({ recovered: [fixture.account.id], unresolved: [] });

  expect(fs.existsSync(path.join(fixture.archive, ".credentials.json"))).toBe(false);
  expect(() => fs.lstatSync(path.join(fixture.archive, "projects"))).toThrow();
  expect(fs.readFileSync(path.join(fixture.archive, "history.jsonl"), "utf8")).toBe(LEFTOVERS["history.jsonl"]!);
  expect(readRegistryJson().removals ?? []).toEqual([]);
});
