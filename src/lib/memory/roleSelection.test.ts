import { afterAll, beforeEach, expect, test, setSystemTime, spyOn } from "bun:test";
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
const savedOpenAiKey = process.env.OPENAI_API_KEY;
const originalConfig = process.env.XDG_CONFIG_HOME;
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
beforeEach(() => { setSystemTime(new Date(NOW)); process.env.LLV_STATE_DIR = path.join(root, `state-${++n}`); process.env.XDG_CONFIG_HOME = path.join(root, `config-${n}`); delete process.env.OPENROUTER_API_KEY; delete process.env.OPENAI_API_KEY; seed(); });
afterAll(() => { setSystemTime(); if (originalState === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = originalState; if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = savedKey; if (savedOpenAiKey === undefined) delete process.env.OPENAI_API_KEY; else process.env["OPENAI_API_KEY"] = savedOpenAiKey; if (originalConfig === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = originalConfig; fs.rmSync(root, { recursive: true, force: true }); });

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
  expect(memoryDeliveries().map(row => row.delivery.reason).sort()).toEqual(["frozen", "jev-no-key,bm25-no-match"]);
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
    expect(memoryDeliveries().map(row => row.delivery.reason).sort()).toEqual(["frozen", "jev-no-key,bm25-no-match"]);
  } finally {
    clearTimeout(watchdog);
    for (const child of children) { if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; }
  }
});

test("the first start freezes the selected delivery and its ids", async () => {
  const { buildPipeline, savePipelines } = await import("@/lib/pipelines/store");
  savePipelines([buildPipeline({ id: input().attempt!.pipelineId, task: "Verify durable receipt ownership", project: profile.learnedRules.project, repoDir: root,
    stages: [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Check durable receipts before replaying them.", next: null, effectiveRole: { engine: "codex", model: "gpt-6.1-sol", effort: "high", roleId: "builder", access: "read-write", promptScaffold: "Build the task and verify its result." } }],
    srcPath: null, srcConversationId: null, now: NOW })]);
  const block = await learnedRulesForLaunchProfile(profile, input());
  const { memorySelection } = await import("./roleSelection");
  const row = memorySelection(input().attempt!)!;
  expect(row.shadow).toBe(false);
  expect(row.selector).toBe("bm25");
  expect(row.block).toBe(block!);
  expect(row.shadowIds).toEqual([id]);
  expect(memoryDeliveries()[0].delivery.shadowIds).toEqual(row.shadowIds);
  expect(Object.keys(row).filter(key => key !== "evidence").sort()).toEqual(["pipelineId", "stageId", "attempt", "createdAt", "release", "mode", "shadow", "selector", "selectorVersion", "reason", "scopes", "block", "entries", "scores", "shadowIds", "removed"].sort());
});


test.each(["openrouter", "openai"] as const)("a real %s launch persists rejected scores and costs across restart while delivering selected rules", async provider => {
  const { buildPipeline, savePipelines } = await import("@/lib/pipelines/store");
  savePipelines([buildPipeline({ id: input().attempt!.pipelineId, task: "Verify durable receipt ownership", project: profile.learnedRules.project, repoDir: root,
    stages: [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Check durable receipts before replaying them.", next: null, effectiveRole: { engine: "codex", model: "gpt-6.1-sol", effort: "high", roleId: "builder", access: "read-write", promptScaffold: "Build the task and verify its result." } }],
    srcPath: null, srcConversationId: null, now: NOW })]);
  process.env.OPENROUTER_API_KEY = "fixture";
  const { chooseService } = await import("@/lib/openaiServices/policy");
  if (provider === "openai") {
    const { writeKey } = await import("@/lib/keys/store");
    await writeKey("openai", ["sk", "proj", "r".repeat(48)].join("-"));
    await chooseService("rules", "openai");
  }
  let decisions = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname.endsWith("/key")) return Response.json({ data: { limit: 3, limit_remaining: 1 } });
    decisions++;
    const body = await request.json();
    if (provider === "openai") return Response.json({ answers: body.questions.map((row: { name: string }) => ({ type: "predicate", name: row.name, probability: 0.01 })), usage: { input_tokens: 100 } });
    return Response.json({ answers: Object.fromEntries(Object.keys(body.questions).map(key => [key, { noul: 0.01 }])), usage: { cost: 0.00001 } });
  } });
  const nativeFetch = globalThis.fetch;
  const stub = spyOn(globalThis, "fetch").mockImplementation(((url, init) => nativeFetch(new URL(new URL(String(url)).pathname, server.url), init)) as typeof fetch);
  try {
    const block = await learnedRulesForLaunchProfile(profile, input());
    expect(block).not.toContain(firstText);
    const { memorySelection } = await import("./roleSelection");
    const row = memorySelection(input().attempt!)!;
    expect(row).toMatchObject({ mode: "jev", shadow: false, selector: "jev", shadowIds: [], evidence: { provider, admission: { status: "admitted", limit: provider === "openai" ? null : 3, remaining: provider === "openai" ? null : 1 }, costUsd: 0.00001, billedUsd: 0.00001, allScores: [[id, 0.01]] } });
    const script = `import { memorySelection } from ${JSON.stringify(path.join(import.meta.dir, "roleSelection.ts"))};
const row = memorySelection(${JSON.stringify(input().attempt)});
if (JSON.stringify(row) !== ${JSON.stringify(JSON.stringify(row))}) throw Error('selection evidence changed on restart');`;
    await child(script);
    expect(await learnedRulesForLaunchProfile(profile, input())).toBe(block);
    expect(decisions).toBe(1);
  } finally {
    stub.mockRestore();
    await server.stop(true);
    await chooseService("rules", "openrouter");
    delete process.env.OPENROUTER_API_KEY;
  }
});

test("a non-pipeline role launch selects rules and records the same delivery through a real endpoint", async () => {
  process.env.OPENAI_API_KEY = "fixture";
  let calls = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    calls++;
    const body = await request.json();
    deleteRule(id, NOW);
    return Response.json({ answers: body.questions.map((q: { name: string }) => ({ type: "predicate", name: q.name, probability: .9 })), usage: { input_tokens: 100 } });
  } });
  const nativeFetch = globalThis.fetch;
  const stub = spyOn(globalThis, "fetch").mockImplementation(((url, init) => nativeFetch(new URL(new URL(String(url)).pathname, server.url), init)) as typeof fetch);
  try {
    const start = { ...input(), attempt: undefined };
    const block = await learnedRulesForLaunchProfile({ ...profile, title: "Repair receipt recovery" }, start);
    expect(block).not.toContain(firstText);
    expect(calls).toBe(1);
    expect(memoryDeliveries()[0].delivery).toMatchObject({ reason: "jev", rules: [], evidence: { provider: "openai" } });
  } finally { stub.mockRestore(); await server.stop(true); }
});

test("an existing shadow row converts to its stored selection without another provider call", async () => {
  const { prepareRoleSelection, selectionCandidate, roleSelectionCollection, memorySelection } = await import("./roleSelection");
  const { learnedRulesSnapshot } = await import("./roleStore");
  await prepareRoleSelection();
  const candidate = { ...selectionCandidate(input().attempt!, learnedRulesSnapshot(profile.learnedRules.project, "builder")), shadow: true, selector: "jev" as const, shadowIds: [], reason: "jev" };
  const store = roleSelectionCollection()!;
  try { store.boundedPatch(2, tx => tx.put(candidate)); } finally { store.close(); }
  const block = await learnedRulesForLaunchProfile(profile, input());
  expect(block).not.toContain(firstText);
  expect(memorySelection(input().attempt!)!).toMatchObject({ shadow: false, mode: "jev", entries: [], block });
  expect(await learnedRulesForLaunchProfile(profile, input())).toBe(block);
});

test("a persisted legacy switch bypass cannot retain whole delivery", async () => {
  const { prepareRoleSelection, selectionCandidate, roleSelectionCollection, memorySelection } = await import("./roleSelection");
  const { learnedRulesSnapshot } = await import("./roleStore");
  await prepareRoleSelection();
  const store = roleSelectionCollection()!;
  try { store.boundedPatch(2, tx => tx.put(selectionCandidate(input().attempt!, learnedRulesSnapshot(profile.learnedRules.project, "builder")))); }
  finally { store.close(); }
  await learnedRulesForLaunchProfile(profile, input());
  expect(memorySelection(input().attempt!)!).toMatchObject({ mode: "bm25", shadow: false, reason: "jev-no-key,bm25-no-match" });
});

test("whole fallback after both selectors fail still enforces the byte ceiling and retains protected rules", async () => {
  const { learnedRulesSnapshot } = await import("./roleStore");
  const { selectedSnapshot } = await import("./roleSelection");
  const { selectRoleMemory } = await import("./roleSelect");
  const store = roleMemoryCollection()!;
  try {
    const original = store.get(`r:${id}`) as RoleMemoryRule;
    const pool = Array.from({ length: 110 }, (_, i) => ({ ...original, id: `r_${(i + 2).toString(16).padStart(16, "0")}`, rule: `Receipt ${i} ${"界".repeat(270)}`, ...(i === 109 ? { keptByOperatorAt: NOW } : {}) }));
    store.boundedPatch(pool.length + 1, tx => { for (const rule of pool) tx.put(rule); tx.put({ kind: "scope", scope, active: pool.map(rule => rule.id), history: [], revision: 2 }); });
    const snapshot = learnedRulesSnapshot(profile.learnedRules.project, "builder");
    const failed = await selectRoleMemory(snapshot.candidates, "receipt recovery", { apiKey: null, timeoutMs: 0 });
    expect(failed).toMatchObject({ selector: "whole", reason: "selector-timeout" });
    const projected = selectedSnapshot(snapshot, failed);
    expect(Buffer.byteLength(projected.block)).toBeLessThanOrEqual(24_000);
    expect(projected.rules.map(rule => rule.id)).toContain(pool[109].id);
    expect(projected.rules.length).toBeLessThan(pool.length);
    for (const rule of projected.rules) expect(projected.block).toContain(`[${rule.id}]`);
    const { prepareRoleSelection, selectionCandidate, roleSelectionCollection } = await import("./roleSelection");
    await prepareRoleSelection();
    const selectionStore = roleSelectionCollection()!;
    try { selectionStore.boundedPatch(2, tx => tx.put({ ...selectionCandidate(input().attempt!, snapshot), reason: "selector-timeout" })); }
    finally { selectionStore.close(); }
    const resumed = await learnedRulesForLaunchProfile(profile, input());
    expect(Buffer.byteLength(resumed!)).toBeLessThanOrEqual(24_000);
    expect(resumed).toContain(pool[109].id);
  } finally { store.close(); }
});

test("whole fallback drops optional rules across scopes before a larger protected-only scope", async () => {
  const { learnedRulesSnapshot } = await import("./roleStore");
  const { selectedSnapshot } = await import("./roleSelection");
  const store = roleMemoryCollection()!;
  try {
    const original = store.get(`r:${id}`) as RoleMemoryRule;
    let number = 2;
    const scopeKeys = [scope, "role:*:builder", "project:selection-project", "machine"];
    const groups = scopeKeys.map((scope, index) => ({ scope, rules: Array.from({ length: index === 3 ? 9 : 20 }, () => ({
      ...original, scope, id: `r_${(number++).toString(16).padStart(16, "0")}`, rule: (index === 3 ? "😀" : "a").repeat(270), ...(index === 3 ? { keptByOperatorAt: NOW } : {}),
    })) }));
    store.boundedPatch(80, tx => {
      for (const group of groups) {
        for (const rule of group.rules) tx.put(rule);
        tx.put({ kind: "scope", scope: group.scope, active: group.rules.map(rule => rule.id), history: [], revision: 2 });
      }
    });
    const snapshot = learnedRulesSnapshot(profile.learnedRules.project, "builder");
    const projected = selectedSnapshot(snapshot, { selector: "whole", reason: "jev-http,bm25-error", selectorVersion: "1", scores: [], shadowIds: [] });
    expect(Buffer.byteLength(projected.block)).toBeLessThanOrEqual(24_000);
    for (const rule of groups[3].rules) expect(projected.rules.map(row => row.id)).toContain(rule.id);
    expect(projected.rules.length).toBeLessThan(69);
  } finally { store.close(); }
});
