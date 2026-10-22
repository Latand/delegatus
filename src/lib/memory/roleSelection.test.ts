import { afterAll, beforeEach, expect, test, setSystemTime } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { learnedRulesForLaunchProfile } from "./roleLaunch";
import { memoryDeliveries, type MemoryEngineStart } from "./deliveryLedger";
import { deleteRule, roleMemoryCollection } from "./roleStore";
import type { RoleMemoryRule } from "./roleTypes";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "role-selection-"));
const originalState = process.env.LLV_STATE_DIR;
const savedKey = process.env.OPENROUTER_API_KEY;
let n = 0;
const NOW = "2026-10-22T00:00:00.000Z";
const profile = { learnedRules: { project: "selection-project", roleId: "builder" } };
const scope = "role:selection-project:builder";
const firstText = "Verify durable ownership before replaying persisted operation receipts.";
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const id = "r_0000000000000001";
const input = (): MemoryEngineStart => ({ engine: "codex", conversationId: "selection-conversation", cwd: root, home: path.join(root, "native-home"), nativeMemoryEnabled: false, attempt: { pipelineId: "selection-pipeline", stageId: "build", attempt: 1 } });
function seed(text = firstText) {
  const rule: RoleMemoryRule = { kind: "rule", id, scope, rule: text, why: "An earlier replay accepted an obsolete acknowledgement.", state: "active", hints: [], source: { project: "selection-project", pipelineId: "source-pipeline", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: "source-conversation" }, createdAt: NOW, changedAt: NOW };
  roleMemoryCollection(true)!.boundedPatch(4, tx => { tx.put(rule); tx.put({ kind: "scope", scope, revision: 1, active: [id], history: [] }); });
}
function rewrite() {
  roleMemoryCollection()!.boundedPatch(4, tx => {
    const current = tx.get(`r:${id}`) as RoleMemoryRule;
    const version = "r_0000000000000099";
    tx.put({ ...current, id: version, versionOf: id, state: "archived", reason: "rewritten" });
    tx.put({ ...current, rule: "Check the current owner and operation before replaying any persisted receipt.", versions: [version] });
  });
}
beforeEach(() => { setSystemTime(new Date(NOW)); process.env.LLV_STATE_DIR = path.join(root, `state-${++n}`); delete process.env.OPENROUTER_API_KEY; seed(); });
afterAll(() => { setSystemTime(); if (originalState === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = originalState; if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = savedKey; fs.rmSync(root, { recursive: true, force: true }); });

test("a resumed attempt receives its first block after a rewrite", async () => {
  const first = await learnedRulesForLaunchProfile(profile, input());
  rewrite();
  const resumed = await learnedRulesForLaunchProfile(profile, input());
  expect(resumed).toBe(first);
  expect(memoryDeliveries()[1].delivery.rules).toEqual([{ id, hash: digest(firstText) }]);
});

test.each(["curator move", "budget archive", "curator merge"])("a %s leaves the frozen block intact on adoption or migration", async change => {
  const first = await learnedRulesForLaunchProfile(profile, input());
  rewrite();
  roleMemoryCollection()!.boundedPatch(4, tx => {
    const rule = tx.get(`r:${id}`) as RoleMemoryRule;
    tx.put({ ...rule, scope: change === "curator move" ? "machine" : scope, state: change === "curator move" ? "active" : change === "curator merge" ? "merged" : "archived", reason: change === "budget archive" ? "budget" : "duplicate" });
    tx.put({ kind: "scope", scope, active: [], revision: 2, history: [] });
  });
  expect(await learnedRulesForLaunchProfile(profile, { ...input(), engine: "claude", home: path.join(root, "migrated-home") })).toBe(first);
  expect(memoryDeliveries()[1].delivery.reason).toBe("frozen");
});

test("an operator deletion removes its line and records the withdrawal once", async () => {
  const first = await learnedRulesForLaunchProfile(profile, input());
  deleteRule(id, NOW);
  const next = await learnedRulesForLaunchProfile(profile, input());
  expect(first).toContain(firstText);
  expect(next).not.toContain(firstText);
  const { memorySelection } = await import("./roleSelection");
  const selection = memorySelection(input().attempt!)!;
  expect(selection.entries).toEqual([]);
  expect(selection.removed).toEqual([{ id, reason: "deleted", at: NOW }]);
  expect(memoryDeliveries()[1].delivery.removed).toEqual(selection.removed);
  expect(await learnedRulesForLaunchProfile(profile, input())).toBe(next);
  expect(memorySelection(input().attempt!)!.removed).toHaveLength(1);
});

test("two concurrent first starts keep a single selection", async () => {
  const [a, b] = await Promise.all([learnedRulesForLaunchProfile(profile, input()), learnedRulesForLaunchProfile(profile, { ...input(), engine: "claude" })]);
  expect(a).toBe(b);
  const { roleSelectionCollection } = await import("./roleSelection");
  const store = roleSelectionCollection()!;
  try { expect(store.keyPage("", 10)).toHaveLength(1); } finally { store.close(); }
  expect(memoryDeliveries().map(row => row.delivery.reason).sort()).toEqual(["frozen", "no-brief"]);
});

test("an unresolved frozen version is withdrawn without substituting its current text", async () => {
  await learnedRulesForLaunchProfile(profile, input());
  seed("A replacement with no retained version cannot prove its earlier text.");
  const next = await learnedRulesForLaunchProfile(profile, input());
  expect(next).not.toContain(firstText);
  expect(next).not.toContain("A replacement");
  expect(memoryDeliveries()[1].delivery.removed).toEqual([{ id, reason: "unresolved", at: NOW }]);
});

test("a fresh process replays the frozen block after a rewrite and account change", async () => {
  const first = await learnedRulesForLaunchProfile(profile, input());
  rewrite();
  const script = `import { learnedRulesForLaunchProfile } from ${JSON.stringify(path.join(import.meta.dir, "roleLaunch.ts"))};
import { createHash } from 'node:crypto';
const block = await learnedRulesForLaunchProfile(${JSON.stringify(profile)}, ${JSON.stringify({ ...input(), engine: "claude", home: path.join(root, "successor-home") })});
if (createHash('sha256').update(block).digest('hex') !== ${JSON.stringify(digest(first!))}) throw Error('frozen block changed');`;
  await child(script);
  expect(memoryDeliveries()[1].delivery.reason).toBe("frozen");
});

async function child(script: string): Promise<void> {
  const owned = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => owned.kill("SIGKILL"), 20_000);
  try {
    const [exit, stderr] = await Promise.all([owned.exited, new Response(owned.stderr).text()]);
    expect({ exit, stderr }).toMatchObject({ exit: 0 });
  } finally { clearTimeout(timer); if (owned.exitCode === null) { owned.kill("SIGKILL"); await owned.exited; } }
}

test("concurrent first starts in separate processes keep one block", async () => {
  const markers = [path.join(root, `ready-${n}-a`), path.join(root, `ready-${n}-b`)];
  const children = markers.map(marker => Bun.spawn([process.execPath, "-e", `
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { learnedRulesForLaunchProfile } from ${JSON.stringify(path.join(import.meta.dir, "roleLaunch.ts"))};
fs.writeFileSync(${JSON.stringify(marker)}, 'ready');
await Bun.stdin.text();
const block = await learnedRulesForLaunchProfile(${JSON.stringify(profile)}, ${JSON.stringify(input())});
console.log(createHash('sha256').update(block).digest('hex'));
`], { env: { ...process.env }, stdin: "pipe", stdout: "pipe", stderr: "pipe" }));
  const watchdog = setTimeout(() => children.forEach(child => child.kill("SIGKILL")), 20_000);
  try {
    const deadline = performance.now() + 15_000;
    while (!markers.every(marker => fs.existsSync(marker))) {
      if (performance.now() > deadline || children.some(child => child.exitCode !== null)) throw Error("first-start children did not become ready");
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    children.forEach(child => child.stdin.end());
    const outcomes = await Promise.all(children.map(async child => ({ exit: await child.exited, hash: await new Response(child.stdout).text(), error: await new Response(child.stderr).text() })));
    for (const outcome of outcomes) if (outcome.exit !== 0) throw Error(outcome.error);
    expect(outcomes.map(result => result.exit)).toEqual([0, 0]);
    expect(outcomes[0].hash).toBe(outcomes[1].hash);
    const { roleSelectionCollection } = await import("./roleSelection");
    const store = roleSelectionCollection()!;
    try { expect(store.keyPage("", 10)).toHaveLength(1); } finally { store.close(); }
    expect(memoryDeliveries().map(row => row.delivery.reason).sort()).toEqual(["frozen", "no-brief"]);
  } finally {
    clearTimeout(watchdog);
    for (const child of children) { if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; }
  }
});

test("the first start records shadow ids without changing the delivered block", async () => {
  const { buildPipeline, savePipelines } = await import("@/lib/pipelines/store");
  savePipelines([buildPipeline({ id: input().attempt!.pipelineId, task: "Verify durable receipt ownership", project: profile.learnedRules.project, repoDir: root,
    stages: [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Check durable receipts before replaying them.", next: null, effectiveRole: { engine: "codex", model: "gpt-6.1-sol", effort: "high", roleId: "builder", access: "read-write", promptScaffold: null } }],
    srcPath: null, srcConversationId: null, now: NOW })]);
  const block = await learnedRulesForLaunchProfile(profile, input());
  const { memorySelection } = await import("./roleSelection");
  const row = memorySelection(input().attempt!)!;
  expect(row.shadow).toBe(true);
  expect(row.selector).toBe("bm25");
  expect(row.block).toBe(block!);
  expect(row.shadowIds).toEqual([id]);
  expect(memoryDeliveries()[0].delivery.shadowIds).toEqual(row.shadowIds);
  expect(Object.keys(row).sort()).toEqual(["pipelineId", "stageId", "attempt", "createdAt", "release", "mode", "shadow", "selector", "selectorVersion", "reason", "scopes", "block", "entries", "scores", "shadowIds", "removed"].sort());
});
