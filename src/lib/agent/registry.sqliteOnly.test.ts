import { afterEach, expect, spyOn, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Database } from "bun:sqlite";

import { AgentRegistry, RegistryImportVerificationError } from "./registry";
import { publishRegistryBackendIdentity, registryBackendDescriptorPath } from "./registryBackendIdentity";

/* The registry lives in SQLite only (#1870, slice 2): a registry open never
   reads agent-registry.json once SQLite is initialised, the mirror is never
   rewritten, and an install still on JSON migrates once, verified, flipping its
   descriptor last. Every case runs in its own mkdtemp state directory. */

const CHILD = path.join(import.meta.dir, "registry.sqliteChild.ts");
const roots: string[] = [];

function stateRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-sqlite-only-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function withoutBackendEnv<T>(run: () => T): T {
  const previous = process.env.LLV_AGENT_REGISTRY_SQLITE;
  delete process.env.LLV_AGENT_REGISTRY_SQLITE;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.LLV_AGENT_REGISTRY_SQLITE;
    else process.env.LLV_AGENT_REGISTRY_SQLITE = previous;
  }
}

function managed(filename: string, storage: ConstructorParameters<typeof AgentRegistry>[3] = {}): AgentRegistry {
  return withoutBackendEnv(() => new AgentRegistry(filename, undefined, undefined, { ...storage, resolveBackendIdentity: true }));
}

function legacyRegistry(conversations: string[]): unknown {
  return {
    version: 2,
    entries: {},
    receipts: {},
    conversations: Object.fromEntries(conversations.map((label) => [`conversation_${label}`, {
      id: `conversation_${label}`,
      engine: "codex",
      generations: [{ id: `session-${label}`, path: `/sessions/${label}.jsonl`, accountId: "default" }],
    }])),
  };
}

function conversationIds(registry: AgentRegistry): string[] {
  return Object.keys(registry.readOnlySnapshot().conversations).sort();
}

function descriptorMode(filename: string): string | null {
  try {
    return (JSON.parse(fs.readFileSync(registryBackendDescriptorPath(filename), "utf8")) as { mode: string }).mode;
  } catch {
    return null;
  }
}

function siblings(filename: string, marker: string): string[] {
  const prefix = `${path.basename(filename)}${marker}`;
  return fs.readdirSync(path.dirname(filename)).filter((name) => name.startsWith(prefix)).sort();
}

function registryReads(filename: string): { count(): number; restore(): void } {
  const spy = spyOn(fs, "readFileSync");
  return {
    count: () => spy.mock.calls.filter(([target]) => typeof target === "string" && path.resolve(target) === filename).length,
    restore: () => spy.mockRestore(),
  };
}

/** A deployment already on SQLite: the store holds the registry, the writer
    published `sqlite`, and the 63 MB mirror still sits beside it. */
function seedSqliteDeployment(root: string): string {
  const filename = path.join(root, "agent-registry.json");
  fs.writeFileSync(filename, JSON.stringify(legacyRegistry(["alpha", "beta"])));
  new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
  publishRegistryBackendIdentity(filename, "sqlite", path.join(root, "agent-registry.sqlite"));
  /* What an older release left behind: a mirror that no longer matches. */
  fs.writeFileSync(filename, JSON.stringify(legacyRegistry(["stale-mirror"])));
  return filename;
}

test("a registry open never reads agent-registry.json once SQLite is initialised", () => {
  const filename = seedSqliteDeployment(stateRoot());

  const reads = registryReads(filename);
  let registry: AgentRegistry;
  try {
    registry = managed(filename);
    registry.storageDiagnostics();
  } finally {
    reads.restore();
  }

  expect(reads.count()).toBe(0);
  expect(conversationIds(registry)).toEqual(["conversation_alpha", "conversation_beta"]);
});

test("the leftover mirror is kept renamed and never rewritten on a restart", () => {
  const filename = seedSqliteDeployment(stateRoot());
  const before = siblings(filename, ".imported-");

  const first = managed(filename);
  first.ensureConversation("codex", "/sessions/gamma.jsonl", "gamma");
  expect(fs.existsSync(filename)).toBeFalse();
  const kept = siblings(filename, ".imported-");
  const added = kept.filter((name) => !before.includes(name));
  expect(added).toHaveLength(1);
  expect(JSON.parse(fs.readFileSync(path.join(path.dirname(filename), added[0]!), "utf8")).conversations)
    .toHaveProperty("conversation_stale-mirror");

  const restarted = managed(filename);
  restarted.ensureConversation("codex", "/sessions/delta.jsonl", "delta");
  expect(fs.existsSync(filename)).toBeFalse();
  expect(siblings(filename, ".imported-")).toEqual(kept);
  expect(restarted.storageDiagnostics()).toMatchObject({ backendMode: "sqlite", mirrorRevision: null, mirrorDirty: false });
  /* Explicit SQLite mode, the one tests and child processes use, writes no mirror either. */
  new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
  expect(fs.existsSync(filename)).toBeFalse();
});

test("sqlite mode creates no JSON write-lock around a mutation", () => {
  const filename = seedSqliteDeployment(stateRoot());
  const registry = managed(filename);
  registry.ensureConversation("codex", "/sessions/epsilon.jsonl", "epsilon");
  expect(siblings(filename, ".write-lock")).toEqual([]);
});

test("an off-mode install with the JSON migrates once, verified, and flips its descriptor last", () => {
  const root = stateRoot();
  const filename = path.join(root, "agent-registry.json");
  const legacy = JSON.stringify(legacyRegistry(["alpha", "beta", "gamma"]));
  fs.writeFileSync(filename, legacy);
  publishRegistryBackendIdentity(filename, "off", path.join(root, "agent-registry.sqlite"));

  /* A crash after the JSON is set aside but before the descriptor flips. */
  expect(() => managed(filename, {
    afterRegistryJsonRetired: () => {
      expect(descriptorMode(filename)).toBe("off");
      throw new Error("simulated crash before the descriptor flip");
    },
  })).toThrow("simulated crash before the descriptor flip");
  expect(descriptorMode(filename)).toBe("off");
  expect(fs.existsSync(filename)).toBeFalse();

  /* The next boot finishes the migration instead of starting empty. */
  const registry = managed(filename);
  expect(descriptorMode(filename)).toBe("sqlite");
  expect(conversationIds(registry)).toEqual(["conversation_alpha", "conversation_beta", "conversation_gamma"]);
  const kept = siblings(filename, ".imported-");
  expect(kept).toHaveLength(1);
  expect(fs.readFileSync(path.join(root, kept[0]!), "utf8")).toBe(legacy);
  expect(siblings(path.join(root, "agent-registry.sqlite"), ".stale-")).toEqual([]);

  /* Once migrated, a restart imports nothing and reads nothing. */
  const reads = registryReads(filename);
  try {
    expect(conversationIds(managed(filename))).toEqual(conversationIds(registry));
  } finally {
    reads.restore();
  }
  expect(reads.count()).toBe(0);
  expect(siblings(filename, ".imported-")).toEqual(kept);
  expect(siblings(filename, ".write-lock")).toEqual([]);
});

test("an install with no descriptor and a JSON registry migrates by default", () => {
  const root = stateRoot();
  const filename = path.join(root, "agent-registry.json");
  fs.writeFileSync(filename, JSON.stringify(legacyRegistry(["npm"])));

  const registry = managed(filename);

  expect(registry.storageDiagnostics().backendMode).toBe("sqlite");
  expect(descriptorMode(filename)).toBe("sqlite");
  expect(conversationIds(registry)).toEqual(["conversation_npm"]);
  expect(fs.existsSync(filename)).toBeFalse();
  expect(siblings(filename, ".imported-")).toHaveLength(1);
});

test("a fresh install with nothing on disk opens SQLite and publishes it", () => {
  const root = stateRoot();
  const filename = path.join(root, "agent-registry.json");

  const registry = managed(filename);
  registry.ensureConversation("codex", "/sessions/fresh.jsonl", "fresh");

  expect(registry.storageDiagnostics().backendMode).toBe("sqlite");
  expect(descriptorMode(filename)).toBe("sqlite");
  expect(fs.existsSync(filename)).toBeFalse();
  expect(fs.existsSync(path.join(root, "agent-registry.sqlite"))).toBeTrue();
});

test("a stale SQLite trio from an earlier experiment is set aside before the JSON imports", () => {
  const root = stateRoot();
  const filename = path.join(root, "agent-registry.json");
  const store = path.join(root, "agent-registry.sqlite");
  fs.writeFileSync(filename, JSON.stringify(legacyRegistry(["experiment"])));
  new AgentRegistry(filename, undefined, undefined, { sqliteMode: "dual-write" }).ensureConversation("codex", "/sessions/x.jsonl", "x");
  /* Back to JSON; the off-mode writer keeps changing the file afterwards. */
  fs.writeFileSync(filename, JSON.stringify(legacyRegistry(["authoritative"])));
  publishRegistryBackendIdentity(filename, "off", store);

  const registry = managed(filename);

  expect(conversationIds(registry)).toEqual(["conversation_authoritative"]);
  const stale = siblings(filename.replace(/\.json$/, ".sqlite"), ".stale-");
  expect(stale.length).toBeGreaterThanOrEqual(1);
  const aside = new Database(path.join(root, stale.find((name) => !/-(wal|shm)$/.test(name))!), { readonly: true });
  try {
    const rows = aside.query<{ row_key: string }, []>("SELECT row_key FROM registry_rows WHERE collection = 'conversations'").all();
    expect(rows.map((row) => row.row_key)).toContain("conversation_experiment");
  } finally {
    aside.close();
  }
  expect(descriptorMode(filename)).toBe("sqlite");
});

test("an import that fails verification leaves the database unmarked and the JSON untouched", () => {
  const root = stateRoot();
  const filename = path.join(root, "agent-registry.json");
  const legacy = JSON.stringify(legacyRegistry(["alpha", "beta"]));
  fs.writeFileSync(filename, legacy);

  expect(() => managed(filename, {
    onRegistryImportVerify: (imported) => { delete imported.conversations.conversation_beta; },
  })).toThrow(RegistryImportVerificationError);

  expect(fs.readFileSync(filename, "utf8")).toBe(legacy);
  expect(descriptorMode(filename)).toBeNull();
  expect(siblings(filename, ".imported-")).toEqual([]);
  const db = new Database(path.join(root, "agent-registry.sqlite"), { readonly: true });
  try {
    const marker = db.query<{ value: string }, []>("SELECT value FROM registry_meta WHERE key = 'migration_complete'").get();
    const rows = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM registry_rows").get();
    expect(marker).toBeNull();
    expect(rows?.count).toBe(0);
  } finally {
    db.close();
  }

  /* Nothing was lost: the next boot imports the untouched file. */
  expect(conversationIds(managed(filename))).toEqual(["conversation_alpha", "conversation_beta"]);
});

test("two processes migrating at once import exactly once", async () => {
  const root = stateRoot();
  const filename = path.join(root, "agent-registry.json");
  fs.writeFileSync(filename, JSON.stringify(legacyRegistry(["alpha", "beta"])));
  publishRegistryBackendIdentity(filename, "off", path.join(root, "agent-registry.sqlite"));
  const start = path.join(root, "start");
  const env = { ...process.env };
  delete env.LLV_AGENT_REGISTRY_SQLITE;
  const children = ["one", "two"].map((label) => {
    const ready = path.join(root, `${label}.ready`);
    const result = path.join(root, `${label}.result`);
    const child = Bun.spawn([process.execPath, CHILD, "managed-open", filename, ready, start, label, "0", result], {
      cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe",
    });
    return { child, ready, result };
  });
  for (const { ready } of children) while (!fs.existsSync(ready)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
  fs.writeFileSync(start, "start");
  const exits = await Promise.all(children.map(({ child }) => child.exited));
  const errors = await Promise.all(children.map(({ child }) => new Response(child.stderr).text()));
  expect(errors.map((text) => text.split("\n").filter((line) => line && !line.includes("deprecated")).join("\n"))).toEqual(["", ""]);
  expect(exits).toEqual([0, 0]);

  const seen = children.map(({ result }) => fs.readFileSync(result, "utf8"));
  expect(seen[0]).toBe(seen[1]);
  expect(JSON.parse(seen[0]!)).toEqual(["conversation_alpha", "conversation_beta"]);
  expect(siblings(filename, ".imported-")).toHaveLength(1);
  expect(siblings(filename.replace(/\.json$/, ".sqlite"), ".stale-")).toEqual([]);
  expect(descriptorMode(filename)).toBe("sqlite");
});

test("dead JSON write-lock residue is removed and a live owner's claim is kept", () => {
  const root = stateRoot();
  const filename = seedSqliteDeployment(root);
  const lock = `${filename}.write-lock`;
  const residue = (label: string, pid: number) => {
    const token = crypto.randomUUID();
    const pending = `${lock}.owner.pending-${token}`;
    fs.mkdirSync(pending);
    fs.writeFileSync(path.join(pending, "owner.json"), JSON.stringify({ pid, startIdentity: `${pid}:${label}`, token }));
    const retired = `${lock}.retired-${token}`;
    fs.symlinkSync(path.basename(pending), retired, "dir");
    return { pending, retired };
  };
  const dead = residue("dead", 2_147_483_600);
  const live = residue("live", process.pid);
  const dangling = `${lock}.retired-${crypto.randomUUID()}`;
  fs.symlinkSync(`${path.basename(lock)}.owner.pending-${crypto.randomUUID()}`, dangling, "dir");

  withoutBackendEnv(() => new AgentRegistry(
    filename,
    (owner) => owner.pid === process.pid,
    undefined,
    { resolveBackendIdentity: true },
  ));

  expect(fs.existsSync(dead.pending)).toBeFalse();
  expect(() => fs.lstatSync(dead.retired)).toThrow();
  expect(() => fs.lstatSync(dangling)).toThrow();
  expect(fs.existsSync(live.pending)).toBeTrue();
  expect(fs.lstatSync(live.retired).isSymbolicLink()).toBeTrue();
});

test("an explicitly configured JSON mode still runs, with a deprecation warning", () => {
  const root = stateRoot();
  const filename = path.join(root, "agent-registry.json");
  fs.writeFileSync(filename, JSON.stringify(legacyRegistry(["kept"])));
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const previous = process.env.LLV_AGENT_REGISTRY_SQLITE;
  process.env.LLV_AGENT_REGISTRY_SQLITE = "off";
  try {
    const registry = new AgentRegistry(filename, undefined, undefined, { resolveBackendIdentity: true });
    expect(registry.storageDiagnostics().backendMode).toBe("off");
    expect(conversationIds(registry)).toEqual(["conversation_kept"]);
    expect(warn.mock.calls.some((call) => String(call[0]).includes("deprecated"))).toBeTrue();
  } finally {
    warn.mockRestore();
    if (previous === undefined) delete process.env.LLV_AGENT_REGISTRY_SQLITE;
    else process.env.LLV_AGENT_REGISTRY_SQLITE = previous;
  }
  expect(fs.existsSync(filename)).toBeTrue();
  expect(fs.existsSync(path.join(root, "agent-registry.sqlite"))).toBeFalse();
});
