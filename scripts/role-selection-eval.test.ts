import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EvalBudget, evaluate, type EvalCase } from "./role-selection-eval";
import { openAiRoleSelectionProvider, openRouterRoleSelectionProvider } from "../src/lib/memory/roleSelectionProvider";
import type { SelectionPromptVersion } from "../src/lib/memory/roleSelectionPrompt";
import type { RoleMemoryRule } from "../src/lib/memory/roleTypes";

test("the committed privacy-safe bundle replays every recorded cell without dispatch", async () => {
  const directory = path.join(import.meta.dir, "..", "evals", "role-selection");
  const cases = JSON.parse(fs.readFileSync(path.join(directory, "corpus.json"), "utf8")) as EvalCase[];
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "inputs.json"), "utf8"));
  const expected = JSON.parse(fs.readFileSync(path.join(directory, "results.json"), "utf8"));
  const providers = [openAiRoleSelectionProvider, openRouterRoleSelectionProvider].map(make => ({
    id: make().id, key: "offline", make: (promptVersion: SelectionPromptVersion) => make({ promptVersion }),
  }));
  expect(manifest.digest).toBe((await import("./role-selection-eval")).digest(cases));
  const actual = await evaluate(cases, new EvalBudget(path.join(directory, "spend.json")), providers, true);
  expect(actual).toEqual(expected.results);
  const receipts = new EvalBudget(path.join(directory, "spend.json")).read();
  expect(receipts).toHaveLength(192);
  expect({
    usageConfirmedUsd: receipts.reduce((sum, row) => sum + (row.cost ?? (row.usageVersion === 2 ? row.observedUsd ?? 0 : 0)), 0),
    retainedUsd: receipts.reduce((sum, row) => sum + (row.cost ?? row.ceiling), 0),
    unpricedCells: receipts.filter(row => row.cost === null).length,
  }).toEqual(expected.spend);
});

test("the eval cap retains unknown dispatches and observed bills across real process restarts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "selection-eval-"));
  const file = path.join(root, "budget.json");
  try {
    const budget = new EvalBudget(file);
    expect(budget.reserve("first", 4)).toBe(true);
    budget.observe("first", .01);
    const script = `import { EvalBudget } from ${JSON.stringify(path.join(import.meta.dir, "role-selection-eval.ts"))};
const budget = new EvalBudget(${JSON.stringify(file)});
if (budget.read()[0].observedUsd !== .01) throw Error('observed usage was lost');
if (budget.reserve('second', 0.01)) throw Error('unknown dispatch admitted');
budget.finish({ key:'first',ceiling:4,cost:3.99,complete:true });
if (!budget.reserve('second',1)) throw Error('remaining credit refused');
budget.finish({ key:'second',ceiling:1,cost:1,complete:true });
if (budget.reserve('third',0.02)) throw Error('cap exceeded');
if (!budget.reserve('last',0.005)) throw Error('within cap refused');`;
    const child = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
    try {
      const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    } finally { if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; } }
    expect(budget.reserve("duplicate", .001)).toBe(false);
    expect(budget.reserve("first", .001)).toBe(false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("both prompts and providers replay captured decisions without dispatch or another charge", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "selection-eval-replay-"));
  const input: EvalCase = { id: "case-a", cohort: "replay", role: "builder", brief: "Repair receipt recovery", applied: ["r_a"], misled: ["r_b"], scopes: [{ scope: "machine", rules: ["Check receipt ownership before replaying.", "Measure browser colors in both themes."].map((rule, i): RoleMemoryRule => ({
    kind: "rule", id: i ? "r_b" : "r_a", rule, why: "Earlier checks missed a boundary.", scope: "machine", state: "active", hints: [],
    source: { origin: "conversation", project: "fixture", roleId: "builder", fixRound: false, conversationId: "fixture-conversation" }, createdAt: "2026-10-01T00:00:00Z", changedAt: "2026-10-01T00:00:00Z",
  })) }] };
  let calls = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    calls++;
    const body = await request.json();
    return Array.isArray(body.questions)
      ? Response.json({ answers: body.questions.map((q: { name: string }, i: number) => ({ type: "predicate", name: q.name, probability: i ? .01 : .9 })), usage: { input_tokens: 100 } })
      : Response.json({ answers: Object.fromEntries(Object.keys(body.questions).map((id, i) => [id, { noul: i ? .01 : .9 }])), usage: { cost: .00001 } });
  } });
  const nativeFetch = globalThis.fetch;
  const request = ((url, init) => nativeFetch(new URL(new URL(String(url)).pathname, server.url), init)) as typeof fetch;
  const providers = [openAiRoleSelectionProvider, openRouterRoleSelectionProvider].map(make => ({ id: make().id, key: "fixture", make: (promptVersion: SelectionPromptVersion) => make({ promptVersion, fetch: request }) }));
  try {
    const budget = new EvalBudget(path.join(root, "spend.json"));
    const first = await evaluate([input], budget, providers);
    expect(calls).toBe(4);
    for (const result of first.filter(result => result.arm.includes("-v"))) expect(result).toMatchObject({ recalled: 1, misledDelivered: 0, delivered: 1 });
    const receipt = fs.readFileSync(budget.file, "utf8");
    const replay = await evaluate([input], budget, providers, true);
    expect(replay.filter(result => result.arm.includes("-v"))).toEqual(first.filter(result => result.arm.includes("-v")));
    expect(calls).toBe(4);
    expect(fs.readFileSync(budget.file, "utf8")).toBe(receipt);
    await expect(evaluate([{ ...input, brief: "A changed task" }], budget, providers, true)).rejects.toThrow("missing frozen response");
    expect(calls).toBe(4);
  } finally { await server.stop(true); fs.rmSync(root, { recursive: true, force: true }); }
});
