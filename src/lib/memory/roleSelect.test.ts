import { afterAll, beforeEach, expect, test, setSystemTime } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RoleMemoryRule } from "./roleTypes";
import { selectRoleMemory } from "./roleSelect";
import { renderLearnedRulesSelection } from "./roleRender";
import { ruleLine } from "./roleConsolidate";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "role-select-scoring-"));
const original = process.env.LLV_STATE_DIR;
let n = 0;
beforeEach(() => { process.env.LLV_STATE_DIR = path.join(root, `state-${++n}`); setSystemTime(new Date("2026-10-22T00:00:00.000Z")); });
afterAll(() => { setSystemTime(); if (original === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = original; fs.rmSync(root, { recursive: true, force: true }); });
const rule = (id: string, text: string): RoleMemoryRule => ({ kind: "rule", id, rule: text, scope: "machine", state: "active", hints: [], why: "The prior run omitted its ownership check.", source: { project: "selection-project", pipelineId: "selection-source", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: "selection-conversation" }, createdAt: "2026-10-22T00:00:00.000Z", changedAt: "2026-10-22T00:00:00.000Z" });
const rules = [rule("r_0000000000000001", "Check durable ownership before replaying receipts."), rule("r_0000000000000002", "Inspect translated labels in each language and theme.")];
const scopes = [{ scope: "machine", rules }];
const brief = "Durable receipts and ownership";
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function provider(answer: (body: { questions: Record<string, unknown>; state: unknown }) => Response = body => json({ answers: Object.fromEntries(Object.keys(body.questions).map((key, i) => [key, { noul: i ? 0.2 : 0.876543 }])), usage: { cost: 0.00001 } })) {
  const requests: { url: string; body: unknown }[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/key")) return json({ data: { limit: 10, limit_remaining: 1 } });
    const body = JSON.parse(String(init?.body)); requests.push({ url: String(url), body });
    return answer(body);
  }) as typeof fetch;
  return { requests, fetcher };
}

test("BM25 ranks matches and fills by curator order when terms do not match", async () => {
  const ranked = await selectRoleMemory(scopes, brief, { apiKey: null });
  expect(ranked).toMatchObject({ selector: "bm25", reason: "jev-no-key,bm25", shadowIds: rules.map(rule => rule.id) });
  expect(ranked.scores[0][1]).toBeGreaterThan(ranked.scores[1][1]);
  expect(await selectRoleMemory(scopes, "Unrelated astronomy", { apiKey: null })).toMatchObject({ selector: "bm25", reason: "jev-no-key,bm25-no-match", shadowIds: rules.map(rule => rule.id), scores: rules.map(rule => [rule.id, 0]) });
});

test("Jev stores only selected scores, rounded to three decimals", async () => {
  const { fetcher, requests } = provider();
  const result = await selectRoleMemory(scopes, brief, { apiKey: "fixture", fetch: fetcher });
  expect(result).toMatchObject({ selector: "jev", reason: "jev", shadowIds: [rules[0].id], scores: [[rules[0].id, 0.877]] });
  expect(requests).toHaveLength(1);
  expect(JSON.stringify(requests[0].body)).not.toContain(rules[0].id);
});

test.each(["missing", "malformed", "http", "network"])("a %s Jev answer falls back to the complete BM25 selection", async failure => {
  const { fetcher } = provider(() => {
    if (failure === "network") throw Error("fixture connection failure");
    return failure === "http" ? json({}, 403) : json({ answers: failure === "missing" ? {} : { bad: { noul: 2 } }, usage: { cost: 0 } });
  });
  const result = await selectRoleMemory(scopes, brief, { apiKey: "fixture", fetch: fetcher });
  expect(result.selector).toBe("bm25");
  expect(result.shadowIds).toEqual(rules.map(rule => rule.id));
  expect(result.reason).toContain("jev-");
});

test("the provider limit is checked before any rule text leaves", async () => {
  let decisions = 0;
  const fetcher = (async (url: string) => { if (url.endsWith("/key")) return json({ data: { limit: 3, limit_remaining: 0 } }); decisions++; return json({}); }) as typeof fetch;
  expect(await selectRoleMemory(scopes, brief, { apiKey: "fixture", fetch: fetcher })).toMatchObject({ selector: "bm25", reason: "jev-provider-limit,bm25" });
  expect(decisions).toBe(0);
});

test("an aborted deadline returns BM25 even when the provider ignores cancellation", async () => {
  const abort = new AbortController();
  let arrived!: () => void;
  const reached = new Promise<void>(resolve => { arrived = resolve; });
  const fetcher = (async () => { arrived(); return new Promise<Response>(() => {}); }) as unknown as typeof fetch;
  const pending = selectRoleMemory(scopes, brief, { apiKey: "fixture", fetch: fetcher, signal: abort.signal });
  await reached; abort.abort();
  expect(await pending).toMatchObject({ selector: "bm25", reason: "jev-timeout,bm25" });
});

test.each(["limit body", "decision body"])("the deadline covers a stalled %s", async stage => {
  const abort = new AbortController();
  let reached!: () => void;
  const arrived = new Promise<void>(resolve => { reached = resolve; });
  const stalled = () => { reached(); return new Promise<unknown>(() => {}); };
  const { fetcher } = provider();
  const request = (async (url: string | URL | Request, init?: RequestInit) => {
    if ((String(url).endsWith("/key")) === (stage === "limit body")) return { ok: true, json: stalled } as Response;
    return fetcher(url, init);
  }) as typeof fetch;
  const pending = selectRoleMemory(scopes, brief, { apiKey: "fixture", fetch: request, signal: abort.signal });
  await arrived; abort.abort();
  expect(await pending).toMatchObject({ selector: "bm25", reason: "jev-timeout,bm25" });
});

test("over-cap candidate pools skip Jev and a shadow switch runs no selector", async () => {
  let calls = 0;
  const request = (async () => { calls++; throw Error("unexpected provider call"); }) as unknown as typeof fetch;
  const pool = [{ scope: "machine", rules: Array.from({ length: 500 }, (_, i) => rule(`r_${i.toString(16).padStart(16, "0")}`, "Ownership ".repeat(30))) }];
  const result = await selectRoleMemory(pool, brief, { apiKey: "fixture", fetch: request });
  expect(result.reason).toBe("jev-pool,bm25");
  expect(result.scores.map(([id]) => id)).toEqual(result.shadowIds);
  expect(result.shadowIds.length).toBeLessThan(pool[0].rules.length);
  expect(calls).toBe(0);
  process.env.LLV_ROLE_MEMORY_SHADOW = "off";
  try { expect(await selectRoleMemory(scopes, brief, { apiKey: "fixture", fetch: request })).toEqual({ selector: "whole", selectorVersion: "1", reason: "whole", scores: [], shadowIds: [] }); }
  finally { delete process.env.LLV_ROLE_MEMORY_SHADOW; }
});

test("briefs and rule text pass credential redaction before the provider", async () => {
  const { fetcher, requests } = provider();
  await selectRoleMemory([{ scope: "machine", rules: [rule(rules[0].id, "Contact sample@example.invalid before checking /home/user/config.\npassword=sample")] }], "sample@example.invalid\napi_key=sample", { apiKey: "fixture", fetch: fetcher });
  expect(requests).toHaveLength(1);
  const wire = JSON.stringify(requests[0].body);
  for (const forbidden of ["sample@example.invalid", "/home/user", "sample"]) expect(wire).not.toContain(forbidden);
});

test("the selection cap persists across a fresh process and stays independent of asks", async () => {
  const { reserveSelectionSpend } = await import("./roleSelectionSpend");
  expect(await reserveSelectionSpend(4.999999, new AbortController().signal)).not.toBeNull();
  const script = `import { selectRoleMemory } from ${JSON.stringify(path.join(import.meta.dir, "roleSelect.ts"))};
let decisions = 0;
const request = async url => { if (String(url).endsWith('/key')) return new Response(JSON.stringify({ data: { limit: 10, limit_remaining: 10 } })); decisions++; throw Error('unexpected decision'); };
const selected = await selectRoleMemory(${JSON.stringify(scopes)}, ${JSON.stringify(brief)}, { apiKey: 'fixture', fetch: request, now: () => new Date('2026-10-22T00:00:00.000Z') });
if (selected.reason !== 'jev-cap,bm25' || decisions) throw Error(JSON.stringify(selected));`;
  const child = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 20_000);
  try { const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]); expect({ exit, stderr }).toEqual({ exit: 0, stderr: expect.any(String) }); }
  finally { clearTimeout(watchdog); if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; } }
  const { writeAsksYouSettings } = await import("@/lib/asks/settings");
  writeAsksYouSettings({ capUsd: 50 });
  const { fetcher, requests } = provider();
  expect(await selectRoleMemory(scopes, brief, { apiKey: "fixture", fetch: fetcher })).toMatchObject({ reason: "jev-cap,bm25" });
  expect(requests).toHaveLength(0);
});

test.each(["a", "ж", "界", "😀"])("shadow packing reserves kept rules and respects both budgets in %s text", async character => {
  const pool = Array.from({ length: 80 }, (_, i) => ({ ...rule(`r_${i.toString(16).padStart(16, "0")}`, character.repeat(240) + String(i)), ...(i < 10 ? { keptByOperatorAt: "2026-10-22T00:00:00.000Z" } : {}) }));
  const result = await selectRoleMemory([{ scope: "machine", rules: pool }], brief, { apiKey: null });
  for (const kept of pool.slice(0, 10)) expect(result.shadowIds).toContain(kept.id);
  const chosen = pool.filter(rule => result.shadowIds.includes(rule.id));
  const selectedLines = chosen.filter(rule => !rule.keptByOperatorAt).map(ruleLine).join("\n");
  expect([...selectedLines].length).toBeLessThanOrEqual(9_000);
  expect(Buffer.byteLength(renderLearnedRulesSelection([{ scope: "machine", rules: chosen }]).block)).toBeLessThanOrEqual(24_000);
  expect(result.scores.map(([id]) => id)).toEqual(chosen.filter(rule => !rule.keptByOperatorAt).map(rule => rule.id));
});

test("a missing brief shadows whole-scope delivery without a scoring budget", async () => {
  const pool = Array.from({ length: 60 }, (_, i) => rule(`r_${i.toString(16).padStart(16, "0")}`, "a".repeat(240)));
  const result = await selectRoleMemory([{ scope: "machine", rules: pool }], "", { apiKey: null });
  expect(result).toMatchObject({ selector: "whole", reason: "no-brief", scores: [], shadowIds: pool.map(rule => rule.id) });
});

test("a changed key after provider admission sends no rules", async () => {
  const savedKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "first";
  let decisions = 0;
  const request = (async (url: string) => {
    if (url.endsWith("/key")) { process.env.OPENROUTER_API_KEY = "next"; return json({ data: { limit: 10, limit_remaining: 10 } }); }
    decisions++; return json({});
  }) as typeof fetch;
  try { expect(await selectRoleMemory(scopes, brief, { fetch: request })).toMatchObject({ selector: "bm25", reason: "jev-authority-changed,bm25" }); expect(decisions).toBe(0); }
  finally { if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = savedKey; }
});
