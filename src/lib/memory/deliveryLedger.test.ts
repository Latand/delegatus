import { afterAll, beforeEach, expect, test, setSystemTime, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import crypto, { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stateLockWaitsInFlight } from "@/lib/state/lockWait";
import { learnedRulesForLaunchProfile } from "./roleLaunch";
import { DELIVERY_LEDGER_STARTS, engineMemoryVersion, memoryDeliveries, type MemoryEngineStart } from "./deliveryLedger";
import { learnedRulesSnapshot, leaveLessons, recordLessonRequest, roleMemoryCollection } from "./roleStore";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-delivery-test-"));
let draw = 0;
const random = spyOn(crypto, "randomBytes").mockImplementation(((size: number) => { const bytes = Buffer.alloc(size); bytes.writeBigUInt64BE(BigInt(++draw), size - 8); return bytes; }) as typeof crypto.randomBytes);
afterAll(() => { random.mockRestore(); setSystemTime(); fs.rmSync(root, { recursive: true, force: true }); });
let n = 0;
beforeEach(() => { setSystemTime(new Date("2026-10-16T00:00:00.000Z")); process.env.LLV_STATE_DIR = path.join(root, `state-${++n}`); });
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const profile = { learnedRules: { project: "ledger-project", roleId: "builder" } };
const start = (engine: "codex" | "claude" = "codex"): MemoryEngineStart => ({ engine, conversationId: "conversation_ledger", cwd: root, home: path.join(root, `home-${n}`), attempt: { pipelineId: "ledger-pipeline", stageId: "build", attempt: 2 } });
const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
async function runChild(script: string): Promise<void> {
  const child = Bun.spawn([process.execPath, "-e", script], { env: process.env, stdout: "pipe", stderr: "pipe" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { child.kill("SIGKILL"); void child.exited.then(() => reject(Error("memory-ledger child exceeded its deadline"))); }, 30_000); });
    const result = Promise.all([child.exited, new Response(child.stderr).text()]);
    const [code, stderr] = await Promise.race([result, timeout]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  } finally { if (timer) clearTimeout(timer); }
}
function lesson(rule: string, attempt = 1, rewrite?: string) {
  const source = { project: "ledger-project", pipelineId: "ledger-pipeline", stageId: "build", attempt, roleId: "builder", fixRound: false, conversationId: "conversation_ledger" };
  recordLessonRequest({ ...source, at: "2026-10-16T00:00:00.000Z" });
  return leaveLessons({ source, request: source, none: null, lessons: rewrite ? [] : [{ scope: "role", rule, why: "The prior delivery lost its recorded selection." }], ...(rewrite ? { rewrite: { id: rewrite, rule, why: "The prior wording omitted ownership checks." } } : {}), now: "2026-10-16T00:00:00.000Z" }).left[0]!;
}

test("each start records ordered ids, exact bytes and scope revisions without rule text", async () => {
  lesson("Verify durable acknowledgement ownership before replaying stored receipts.");
  lesson("Inspect both readers of a shared contract before changing its fields.", 2);
  const expected = learnedRulesSnapshot("ledger-project", "builder");
  const block = await learnedRulesForLaunchProfile(profile, start());
  const row = memoryDeliveries()[0]!.delivery;
  expect(block).toBe(expected.block);
  expect(row.rules).toEqual(expected.rules);
  expect(row.scopes).toEqual(expected.scopes);
  expect(row.bytes).toBe(Buffer.byteLength(block!));
  expect(row.at).toBe("2026-10-16T00:00:00.000Z");
  expect(row.attempt).toEqual(start().attempt);
  expect(row.conversationId).toBe(start().conversationId);
  expect(JSON.stringify(row)).not.toContain("Verify durable");
  await learnedRulesForLaunchProfile(profile, start());
  expect(memoryDeliveries()).toHaveLength(2);
  expect(fs.statSync(path.join(process.env.LLV_STATE_DIR!, "role-memory", "delivery.sqlite")).mode & 0o777).toBe(0o600);
  expect(() => memoryDeliveries(0, 101)).toThrow("page");
});

test("same-instant rewrites remain reconstructable from permanent rule versions", async () => {
  const first = "Verify durable acknowledgement ownership before replaying stored receipts.";
  const id = lesson(first).id;
  await learnedRulesForLaunchProfile(profile, start());
  lesson("Check current ownership before replaying any persisted acknowledgement.", 2, id);
  await learnedRulesForLaunchProfile(profile, start());
  const current = roleMemoryCollection()!.get(`r:${id}`);
  if (current?.kind !== "rule") throw Error("missing rule");
  const versions = [current, ...current.versions!.map(version => roleMemoryCollection()!.get(`r:${version}`))];
  const rows = memoryDeliveries();
  expect(rows[0]!.delivery.rules[0]!.hash).toBe(digest(first));
  for (const { delivery } of rows) for (const item of delivery.rules) expect(versions.some(version => version?.kind === "rule" && digest(version.rule) === item.hash)).toBe(true);
});

test.each(["codex", "claude"] as const)("%s stores distinct native index versions privately and deduplicates unchanged copies", async engine => {
  const input = start(engine);
  const file = engine === "codex" ? path.join(input.home!, "memories", "memory_summary.md") : path.join(input.home!, "projects", root.replace(/[^a-zA-Z0-9]/g, "-"), "memory", "MEMORY.md");
  const original = "Private engine memory version one.\n";
  write(file, original);
  await learnedRulesForLaunchProfile(profile, input);
  await learnedRulesForLaunchProfile(profile, input);
  write(file, "Private engine memory version two.\n");
  await learnedRulesForLaunchProfile(profile, input);
  const entries = memoryDeliveries().map(row => row.delivery.engineMemory[0]!);
  expect(entries.map(entry => entry.hash)).toEqual([digest(original), digest(original), digest("Private engine memory version two.\n")]);
  fs.unlinkSync(file);
  expect(engineMemoryVersion(entries[0]!.hash)!.toString()).toBe(original);
  const db = new Database(path.join(process.env.LLV_STATE_DIR!, "role-memory", "delivery.sqlite"), { readonly: true });
  try { expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM versions").get()!.n).toBe(2); } finally { db.close(); }
});

test("clean, disabled and role-free starts record empty rule delivery and respect native memory switches", async () => {
  const input = start();
  write(path.join(input.home!, "memories", "memory_summary.md"), "Engine summary fixture.");
  expect(await learnedRulesForLaunchProfile({ ...profile, cleanMemory: true }, input)).toBeUndefined();
  write(path.join(input.home!, "config.toml"), "[features]\nmemories = false\n");
  expect(await learnedRulesForLaunchProfile(undefined, input)).toBeUndefined();
  process.env.LLV_ROLE_MEMORY = "off";
  try { expect(await learnedRulesForLaunchProfile(profile, input)).toBeUndefined(); } finally { delete process.env.LLV_ROLE_MEMORY; }
  for (const row of memoryDeliveries()) { expect(row.delivery.rules).toEqual([]); expect(row.delivery.engineMemory).toEqual([]); }
});

test("unreadable native memory and ledger failures refuse the start without claiming delivery", async () => {
  const input = start();
  const file = path.join(input.home!, "memories", "memory_summary.md");
  write(file, "x".repeat(1024 * 1024 + 1));
  await expect(learnedRulesForLaunchProfile(profile, input)).rejects.toThrow("snapshot limit");
  expect(memoryDeliveries()).toEqual([]);
  fs.unlinkSync(file);
  write(path.join(process.env.LLV_STATE_DIR!, "role-memory", "delivery.sqlite"), "damaged database fixture");
  await expect(learnedRulesForLaunchProfile(profile, input)).rejects.toThrow();
});

test("retention survives a real process restart and removes only unreferenced file copies", async () => {
  const input = start();
  write(path.join(input.home!, "memories", "memory_summary.md"), "Retired engine version.");
  await learnedRulesForLaunchProfile(profile, input);
  const oldHash = memoryDeliveries()[0]!.delivery.engineMemory[0]!.hash;
  const db = new Database(path.join(process.env.LLV_STATE_DIR!, "role-memory", "delivery.sqlite"));
  try { db.query("INSERT INTO deliveries(sequence,body) VALUES (?,?)").run(DELIVERY_LEDGER_STARTS, JSON.stringify(memoryDeliveries()[0]!.delivery)); } finally { db.close(); }
  write(path.join(input.home!, "memories", "memory_summary.md"), "Current engine version.");
  const script = `import { stateLockWaitsInFlight } from "@/lib/state/lockWait";
import { learnedRulesForLaunchProfile } from ${JSON.stringify(path.join(import.meta.dir, "roleLaunch.ts"))}; await learnedRulesForLaunchProfile(${JSON.stringify(profile)}, ${JSON.stringify(input)});`;
  const child = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, HOME: input.home, XDG_CONFIG_HOME: path.join(input.home!, "config") }, stdout: "pipe", stderr: "pipe" });
  const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(error).toBe(""); expect(code).toBe(0);
  expect(memoryDeliveries()[0]!.sequence).toBe(DELIVERY_LEDGER_STARTS);
  expect(memoryDeliveries()[1]!.delivery.engineMemory[0]!.hash).toBe(digest("Current engine version."));
  expect(engineMemoryVersion(oldHash)).toBeNull();
});

test("contended delivery yields to the loop and captures rules and native input after admission retry", async () => {
  const input = start();
  const file = path.join(input.home!, "memories", "memory_summary.md");
  write(file, "Before admission.");
  const id = lesson("Verify ownership before replaying any persisted acknowledgement.").id;
  await learnedRulesForLaunchProfile(profile, input);
  const db = new Database(path.join(process.env.LLV_STATE_DIR!, "role-memory", "delivery.sqlite"));
  db.exec("BEGIN IMMEDIATE");
  const waitForAttempt = async (attempts: number) => {
    const deadline = performance.now() + 3000;
    while (!stateLockWaitsInFlight().some(wait => wait.callSite === "memory.delivery" && wait.attempts >= attempts)) {
      if (performance.now() > deadline) throw Error("delivery admission did not retry");
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  };
  let progressed = false;
  const pending = learnedRulesForLaunchProfile(profile, input);
  try {
    await new Promise<void>(resolve => setImmediate(() => { progressed = true; resolve(); }));
    await waitForAttempt(2);
    write(file, "After admission.");
    lesson("Check current ownership before replaying stored operation acknowledgements.", 2, id);
    await waitForAttempt(3);
  } finally { db.exec("ROLLBACK"); db.close(); }
  const block = await pending;
  expect(progressed).toBe(true);
  const row = memoryDeliveries()[1]!.delivery;
  expect(row.engineMemory[0]!.hash).toBe(digest("After admission."));
  expect(row.rules[0]!.hash).toBe(digest("Check current ownership before replaying stored operation acknowledgements."));
  expect(row.bytes).toBe(Buffer.byteLength(block!));
});

test("a byte-limit eviction keeps newer starts and drops their predecessor copies atomically", async () => {
  const input = start();
  await learnedRulesForLaunchProfile(profile, input);
  const db = new Database(path.join(process.env.LLV_STATE_DIR!, "role-memory", "delivery.sqlite"));
  const old = "a".repeat(64);
  try {
    db.query("INSERT INTO versions(hash,content) VALUES (?,zeroblob(?))").run(old, 64 * 1024 * 1024);
    db.query("INSERT INTO files(sequence,hash) VALUES (1,?)").run(old);
  } finally { db.close(); }
  write(path.join(input.home!, "memories", "memory_summary.md"), "A newer captured version.");
  await learnedRulesForLaunchProfile(profile, input);
  const rows = memoryDeliveries();
  expect(rows).toHaveLength(1); expect(rows[0].sequence).toBe(2);
  expect(engineMemoryVersion(old)).toBeNull();
  expect(engineMemoryVersion(rows[0].delivery.engineMemory[0].hash)!.toString()).toBe("A newer captured version.");
});

test("the 64 MiB archive bound survives a seed, fresh writer and fresh reader", async () => {
  const state = process.env.LLV_STATE_DIR!;
  const archive = path.join(state, "role-memory", "delivery.sqlite");
  const seedScript = `import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
const filename = ${JSON.stringify(archive)};
fs.mkdirSync(path.dirname(filename), { recursive: true });
const db = new Database(filename);
db.exec("CREATE TABLE deliveries (sequence INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL); CREATE TABLE versions (hash TEXT PRIMARY KEY, content BLOB NOT NULL); CREATE TABLE files (sequence INTEGER REFERENCES deliveries(sequence) ON DELETE CASCADE, hash TEXT REFERENCES versions(hash), PRIMARY KEY(sequence, hash)); CREATE INDEX files_hash ON files(hash); BEGIN IMMEDIATE");
for (let i = 0; i < 64; i++) { const content = Buffer.alloc(1024 * 1024, i); const hash = createHash("sha256").update(content).digest("hex"); const row = { schemaVersion: 1, conversationId: "seed-" + i, engine: "codex", at: "2026-10-16T00:00:00.000Z", scopes: [], rules: [], bytes: 0, engineMemory: [{ kind: "codex-summary", hash, bytes: content.length, loadedBytes: content.length }] }; db.query("INSERT INTO deliveries(sequence,body) VALUES (?,?)").run(i + 1, JSON.stringify(row)); db.query("INSERT INTO versions(hash,content) VALUES (?,?)").run(hash, content); db.query("INSERT INTO files(sequence,hash) VALUES (?,?)").run(i + 1, hash); }
db.exec("COMMIT"); db.close();`;
  await runChild(seedScript);

  const summaryFile = path.join(root, `home-${n}`, "memories", "memory_summary.md");
  write(summaryFile, "z".repeat(1024 * 1024));
  const input: MemoryEngineStart = { engine: "codex", conversationId: "fresh-writer", cwd: root, home: path.dirname(path.dirname(summaryFile)), nativeMemoryEnabled: true };
  const writerScript = `import { learnedRulesForLaunchProfile } from ${JSON.stringify(path.join(import.meta.dir, "roleLaunch.ts"))};
await learnedRulesForLaunchProfile(undefined, ${JSON.stringify(input)});`;
  await runChild(writerScript);

  const readerScript = `import assert from "node:assert/strict";
import { DELIVERY_LEDGER_FILE_BYTES, engineMemoryVersion, memoryDeliveries } from ${JSON.stringify(path.join(import.meta.dir, "deliveryLedger.ts"))};
import { Database } from "bun:sqlite";
const rows = memoryDeliveries(); assert.equal(rows.length, 64);
assert.deepEqual(rows.map(row => row.sequence), Array.from({ length: 64 }, (_, i) => i + 2));
const db = new Database(${JSON.stringify(archive)}, { readonly: true });
const bytes = db.query("SELECT COALESCE(SUM(length(content)),0) AS bytes FROM versions").get().bytes;
assert.ok(bytes <= DELIVERY_LEDGER_FILE_BYTES); db.close();
for (const row of rows) for (const file of row.delivery.engineMemory) { const content = engineMemoryVersion(file.hash); assert.ok(content, "retained delivery must have its content copy"); assert.equal(content.length, file.bytes); }`;
  await runChild(readerScript);
});

test("Claude custom directories, disabled settings and linked checkout defaults resolve to the captured index", async () => {
  const input = start("claude");
  const repository = path.join(root, `repository-${n}`), checkout = path.join(root, `checkout-${n}`);
  const metadata = path.join(repository, ".git", "worktrees", "fixture");
  write(path.join(checkout, ".git"), `gitdir: ${metadata}\n`);
  write(path.join(metadata, "commondir"), "../..\n");
  input.cwd = checkout;
  const index = path.join(input.home!, "projects", repository.replace(/[^a-zA-Z0-9]/g, "-"), "memory", "MEMORY.md");
  write(index, "Repository index.");
  await learnedRulesForLaunchProfile(profile, input);
  expect(memoryDeliveries()[0].delivery.engineMemory[0].hash).toBe(digest("Repository index."));
  const custom = path.join(root, `custom-${n}`);
  write(path.join(input.home!, "settings.json"), JSON.stringify({ autoMemoryDirectory: custom }));
  write(path.join(custom, "MEMORY.md"), "Custom index.");
  await learnedRulesForLaunchProfile(profile, input);
  expect(memoryDeliveries()[1].delivery.engineMemory[0].hash).toBe(digest("Custom index."));
  write(path.join(repository, ".claude", "settings.local.json"), JSON.stringify({ autoMemoryEnabled: false }));
  await learnedRulesForLaunchProfile(profile, input);
  expect(memoryDeliveries()[2].delivery.engineMemory).toEqual([]);
});


test("an ownerless start captures the native default home from the engine environment", async () => {
  const input = { ...start(), home: undefined, env: { NODE_ENV: "test" as const, HOME: path.join(root, `default-home-${n}`) } };
  const file = path.join(input.env.HOME, ".codex", "memories", "memory_summary.md");
  write(file, "Default home engine summary.");
  await learnedRulesForLaunchProfile(profile, input);
  expect(memoryDeliveries()[0].delivery.engineMemory[0].hash).toBe(digest("Default home engine summary."));
});

test("Claude fallback spawn settings and settings environment switches match native input selection", async () => {
  const input = { ...start("claude"), claudeSettingsPath: path.join(root, `base-settings-${n}.json`) };
  const custom = path.join(root, `base-memory-${n}`);
  write(path.join(custom, "MEMORY.md"), "Fallback settings engine index.");
  write(input.claudeSettingsPath, JSON.stringify({ autoMemoryDirectory: custom }));
  await learnedRulesForLaunchProfile(profile, input);
  expect(memoryDeliveries()[0].delivery.engineMemory[0].hash).toBe(digest("Fallback settings engine index."));
  write(path.join(input.home!, "settings.json"), JSON.stringify({ env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" } }));
  await learnedRulesForLaunchProfile(profile, input);
  expect(memoryDeliveries()[1].delivery.engineMemory).toEqual([]);
});

test("Claude tilde memory paths expand against engine HOME and provider launches use provider sources", async () => {
  const input = start("claude");
  const engineHome = path.join(root, `engine-home-${n}`);
  input.home = engineHome;
  const tildeRoot = path.join(engineHome, "custom-memory");
  write(path.join(engineHome, "settings.json"), JSON.stringify({ autoMemoryDirectory: "~/custom-memory" }));
  write(path.join(tildeRoot, "MEMORY.md"), "Provider native memory copy.");
  await learnedRulesForLaunchProfile(profile, input);
  expect(memoryDeliveries()[0]!.delivery.engineMemory).toEqual([{ kind: "claude-index", hash: digest("Provider native memory copy."), bytes: 28, loadedBytes: 28 }]);

  // Provider launches pass --setting-sources "". The account and project files
  // are therefore absent from Claude's effective settings and cannot suppress
  // the generated policy's native memory default or redirect its index.
  input.providerAccount = true;
  write(path.join(engineHome, "settings.json"), JSON.stringify({ autoMemoryEnabled: false, autoMemoryDirectory: path.join(root, "excluded") }));
  const project = path.join(input.cwd, ".claude");
  write(path.join(project, "settings.local.json"), JSON.stringify({ autoMemoryEnabled: false }));
  const defaultIndex = path.join(engineHome, "projects", input.cwd.replace(/[^a-zA-Z0-9]/g, "-"), "memory", "MEMORY.md");
  write(defaultIndex, "Provider default memory index.");
  await learnedRulesForLaunchProfile(profile, input);
  const providerExpected = { kind: "claude-index" as const, hash: digest("Provider default memory index."), bytes: 30, loadedBytes: 30 };
  expect(memoryDeliveries()[1]!.delivery.engineMemory).toEqual([providerExpected]);
});


test.each([false, true])("private copies refuse a state path inside a checkout, including a symlink: %s", async linked => {
  const checkout = path.join(root, `archive-checkout-${n}`);
  write(path.join(checkout, ".git", "HEAD"), "ref: refs/heads/main\n");
  if (linked) {
    const target = path.join(checkout, "private-archive");
    fs.mkdirSync(target, { recursive: true });
    fs.mkdirSync(process.env.LLV_STATE_DIR!, { recursive: true });
    fs.symlinkSync(target, path.join(process.env.LLV_STATE_DIR!, "role-memory"), "dir");
  } else process.env.LLV_STATE_DIR = path.join(checkout, "state");
  await expect(learnedRulesForLaunchProfile({ cleanMemory: true }, start())).rejects.toThrow("outside a checkout");
  expect(fs.existsSync(path.join(process.env.LLV_STATE_DIR!, "role-memory", "delivery.sqlite"))).toBe(false);
});


test.each(["symlink", "hardlink"] as const)("an existing %s cannot redirect private database writes into a checkout", async kind => {
  const checkout = path.join(root, `linked-archive-checkout-${n}`);
  write(path.join(checkout, ".git", "HEAD"), "ref: refs/heads/main\n");
  const target = path.join(checkout, "archive.sqlite");
  const db = new Database(target, { create: true }); db.exec("CREATE TABLE sentinel (value INTEGER)"); db.close();
  const before = fs.readFileSync(target);
  const directory = path.join(process.env.LLV_STATE_DIR!, "role-memory");
  fs.mkdirSync(directory, { recursive: true });
  if (kind === "symlink") fs.symlinkSync(target, path.join(directory, "delivery.sqlite"));
  else fs.linkSync(target, path.join(directory, "delivery.sqlite"));
  await expect(learnedRulesForLaunchProfile({ cleanMemory: true }, start())).rejects.toThrow("unlinked regular file");
  expect(fs.readFileSync(target)).toEqual(before);
});
