import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterAll, expect, test } from "bun:test";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "startup-adoption-memory-"));
const previous = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  LLV_STATE_DIR: process.env.LLV_STATE_DIR, DELEGATUS_STATE_DIR: process.env.DELEGATUS_STATE_DIR };
process.env.HOME = directory;
process.env.XDG_CONFIG_HOME = path.join(directory, "config");
process.env.LLV_STATE_DIR = path.join(directory, "state");
process.env.DELEGATUS_STATE_DIR = process.env.LLV_STATE_DIR;
afterAll(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(directory, { recursive: true, force: true });
});

const { AgentRegistry } = await import("@/lib/agent/registry");
const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
const { structuredStartupAdoptionFilter } = await import(process.env.STARTUP_ADOPTION_MINIFIED_MODULE ?? "./startup") as typeof import("./startup");

test("completed adoption predicates release the preparation snapshot and retain pending-work decisions", async () => {
  const registry = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const artifactPath = path.join(directory, "memory-session.jsonl");
  fs.writeFileSync(artifactPath, "");
  const conversation = registry.ensureConversation("codex", artifactPath, null);
  const key = { engine: "codex" as const, sessionId: conversation.generations[0]!.id };
  registry.upsert({ key, artifactPath, cwd: directory, accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: directory }), status: "idle", host: null,
    structuredHost: { kind: "codex-app-server", endpoint: "fake:memory", process: null,
      eventCursor: 0, protocolVersion: "test", writerClaimEpoch: 0, activeTurnRef: null,
      pendingAttention: [], activeFlags: [] },
    claimEpoch: 0, claimOwner: null, pendingAction: null });
  const entry = registry.readOnlySnapshot().entries[`codex:${key.sessionId}`]!;
  const signals = { hostedRunningConversationIds: new Set<string>(),
    pendingOperationConversationIds: new Set([conversation.id]),
    pendingCodexContinuationConversationIds: new Set<string>(), admittedMessages: new Map() };
  const prepare = async () => {
    // A captured generation has its own lifetime, separate from the registry's
    // current cache. The returned predicates need only its selected facts.
    const snapshot = structuredClone(registry.readOnlySnapshot());
    const reference = new WeakRef(snapshot);
    const predicate = await structuredStartupAdoptionFilter(registry, signals, snapshot);
    return { reference, predicate };
  };
  try {
    const { reference, predicate } = await prepare();
    expect(predicate(entry)).toBe(true);
    expect(predicate.pendingWork(entry)).toBe(true);
    for (let i = 0; i < 8; i++) {
      await Bun.sleep(1);
      Bun.gc(true);
    }
    await Bun.sleep(1);
    expect(reference.deref() === undefined).toBe(true);
    expect(predicate(entry)).toBe(true);
    expect(predicate.pendingWork(entry)).toBe(true);
  } finally {
    registry.close();
  }
});

test.skipIf(Boolean(process.env.STARTUP_ADOPTION_MINIFIED_MODULE))(
  "production minification preserves the adoption snapshot lifetime boundary", async () => {
    const { loadBindings, transform, minify } = await import("next/dist/build/swc");
    await loadBindings();
    const sourceFile = path.join(import.meta.dir, "startup.ts");
    const transformed = await transform(fs.readFileSync(sourceFile, "utf8"), {
      filename: sourceFile,
      jsc: { parser: { syntax: "typescript" }, target: "es2022" },
      module: { type: "es6" },
    });
    // Keep this one transformed module separate while its imports use the real
    // source dependencies, as the ordinary lifetime fixture does.
    const code = transformed.code.replace(/(from\s*|import\s*\()(["'])((?:\.\.?\/|@\/)[^"']+)\2/g,
      (_match: string, prefix: string, _quote: string, specifier: string) =>
        `${prefix}${JSON.stringify(specifier.startsWith("@/")
          ? path.resolve(import.meta.dir, "../..", specifier.slice(2))
          : path.resolve(import.meta.dir, specifier))}`);
    const result = await minify(code, {
      compress: { inline: 2, global_defs: { "process.env.__NEXT_PRIVATE_MINIMIZE_MACRO_FALSE": false } },
      mangle: { reserved: ["AbortSignal"] },
      module: "unknown",
      output: { comments: false },
    });
    const compiled = path.join(directory, "startup.min.mjs");
    fs.writeFileSync(compiled, result.code);
    const child = spawn(process.execPath, ["test", import.meta.path, "--test-name-pattern", "completed adoption predicates"], {
      cwd: path.resolve(import.meta.dir, "../../.."),
      env: { ...process.env, STARTUP_ADOPTION_MINIFIED_MODULE: compiled },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (part: Buffer) => {
      output = (output + part.toString()).slice(-8_000);
    });
    const deadline = setTimeout(() => child.kill("SIGKILL"), 15_000);
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    }).finally(() => clearTimeout(deadline));
    if (exitCode !== 0) throw new Error(`Minified lifetime fixture exited ${exitCode}:\n${output}`);
    expect(exitCode).toBe(0);
  }, 30_000,
);
