import { afterEach, beforeEach, expect, test, setSystemTime, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classify, classifyWithDecisions, askDecisionsCeilingUsd, decideWithOpenAi, askDecisionsRequest, decisionsRequest, decisionsCostCeilingUsd } from "./decisions";
import { chooseService, resolveService } from "./policy";
import { writeKey, removeOpenAiKey } from "@/lib/keys/store";
import { classifierText, jevFailureCostUsd } from "@/lib/asks/jev";
import { runAskSweep, type AskCandidate } from "@/lib/asks/sweep";
import { loadOperatorAsks, mutateOperatorAsks } from "@/lib/asks/store";
import { groundedRequest } from "@/lib/memory/selection";
import { decideMemories, injectMemory } from "@/lib/memory/injection";
import { selectRoleMemory } from "@/lib/memory/roleSelect";
import type { RoleMemoryRule } from "@/lib/memory/roleTypes";
import { openAiRoleSelectionProvider, isSelectionEvidence } from "@/lib/memory/roleSelectionProvider";
import { reserveSelectionSpend } from "@/lib/memory/roleSelectionSpend";

const envNames = ["XDG_CONFIG_HOME", "LLV_STATE_DIR", "OPENAI_API_KEY", "OPENROUTER_API_KEY"];
let root: string, saved: Record<string, string | undefined>;
const credential = ["sk", "proj", "r".repeat(48)].join("-");
beforeEach(() => {
  setSystemTime(new Date("2026-10-30T00:00:00Z"));
  saved = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  for (const name of envNames) delete process.env[name];
  root = fs.mkdtempSync(path.join(os.tmpdir(), "decisions-contract-"));
  process.env.XDG_CONFIG_HOME = path.join(root, "config"); process.env.LLV_STATE_DIR = path.join(root, "state");
});
afterEach(() => {
  setSystemTime();
  for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  fs.rmSync(root, { recursive: true, force: true });
});
const usage = { input_tokens: 1000, input_tokens_details: { cached_tokens: 200, cache_write_tokens: 300 } };
const reply = (names: string[]) => ({ answers: names.map(name => ({ type: "predicate", name, probability: .9 })), usage });
const mockVendor = (handler: (body: ReturnType<typeof askDecisionsRequest>, init: RequestInit) => unknown) => (async (_url: string | URL | Request, init?: RequestInit) => Response.json(handler(JSON.parse(String(init!.body)), init!))) as unknown as typeof fetch;

test("asks sends redacted bounded input, parses names, and accounts for cached tokens once", async () => {
  const input = "x".repeat(1200) + "\n" + "z".repeat(3500);
  const result = await classifyWithDecisions(input, { apiKey: credential, fetch: mockVendor((body, init) => {
    expect(body.model).toBe("gpt-6-luna"); expect(body.input).toBe(classifierText(input));
    expect(body.questions.map(row => [row.type, row.name])).toEqual([["predicate", "asks"], ["predicate", "waiting"], ["predicate", "decision"]]);
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${credential}` });
    const result = reply(["decision", "waiting", "asks"]); result.answers[0].probability = .2;
    return result;
  }) });
  expect(result).toMatchObject({ score: .9, answers: { asks: .9, waiting: .9, decision: .2 }, inputTokens: 1000 });
  expect(result.costUsd).toBeCloseTo((500 * .1 + 200 * .01 + 300 * .125) / 1e6, 12);
  expect(askDecisionsCeilingUsd(input)).toBeGreaterThan(result.costUsd);
});

test.each(["refusal", "missing", "duplicate", "extra", "range", "usage", "type"])("%s is a typed shape failure carrying observed spend", async kind => {
  const request = askDecisionsRequest("A question?");
  const result = reply(request.questions.map(row => row.name));
  if (kind === "refusal") result.answers[0].type = "refusal";
  if (kind === "missing") result.answers.pop();
  if (kind === "duplicate") result.answers[1].name = result.answers[0].name;
  if (kind === "extra") result.answers.push({ type: "predicate", name: "extra", probability: .1 });
  if (kind === "range") result.answers[0].probability = 2;
  if (kind === "type") (result.answers[0] as unknown as { probability: string }).probability = "0.9";
  if (kind === "usage") result.usage = { ...usage, input_tokens: 1 };
  await expect(decideWithOpenAi(request, { apiKey: credential, signal: AbortSignal.timeout(1000), fetch: (async () => Response.json(result)) as unknown as typeof fetch })).rejects.toMatchObject({ code: "shape" });
});

test.each([401, 429, 500])("HTTP %i bills zero without exposing provider errors", async status => {
  try { await classifyWithDecisions("Question?", { apiKey: credential, fetch: (async () => new Response(credential, { status })) as unknown as typeof fetch }); throw Error("expected refusal"); }
  catch (error) { expect(error).toMatchObject({ code: "http", status }); expect(jevFailureCostUsd(error, 1)).toBe(0); expect(String(error)).not.toContain(credential); }
});

test("network, invalid JSON and an expired body preserve typed failures", async () => {
  await expect(classifyWithDecisions("Question?", { apiKey: credential, fetch: (async () => { throw Error(credential); }) as unknown as typeof fetch })).rejects.toMatchObject({ code: "network" });
  await expect(classifyWithDecisions("Question?", { apiKey: credential, fetch: (async () => new Response("bad")) as unknown as typeof fetch })).rejects.toMatchObject({ code: "shape" });
  const abort = new AbortController();
  await expect(decideWithOpenAi(askDecisionsRequest("Question?"), { apiKey: credential, signal: abort.signal,
    fetch: (async () => ({ ok: true, status: 200, json: () => { abort.abort(); throw Error("expired"); } })) as unknown as typeof fetch })).rejects.toMatchObject({ code: "timeout" });
});

test("memory uses its real evidence builder and preserves fields through the OpenAI translation", async () => {
  const candidate = { id: "memory-a", title: "Parser", summary: "Escaping rule", body: "A concrete parser constraint.", engine: "codex", kind: "note", scope: "project", writtenAt: "2026-10-30T00:00:00Z" };
  const input = { prompt: "Update the parser", engine: "codex", project: "repo-fixture", candidates: [candidate] };
  const body = groundedRequest(input);
  const translated = decisionsRequest(body);
  expect(translated.input[0].content.find(part => part.type === "input_json")).toEqual({ type: "input_json", data: body.state });
  expect(JSON.parse(translated.questions[0].instructions)).toEqual({ instructions: body.questions[candidate.id].instructions, criteria: body.questions[candidate.id].criteria });
  let reserve = 0, settled = 0;
  const block = await injectMemory({ ...input, origin: "operator", conversation: "conversation-a", requestId: "turn-a" }, {
    provider: "openai", enabled: () => true, ownsTraffic: () => true, candidates: () => [candidate],
    reserve: ceiling => { reserve = ceiling; return true; }, settle: cost => { settled = cost; }, record: () => {},
    decide: (request, signal) => decideMemories(request, credential, signal, "openai", mockVendor(body => reply(body.questions.map(row => row.name)))),
  });
  expect(block).toContain(candidate.summary); expect(reserve).toBeGreaterThanOrEqual(decisionsCostCeilingUsd(translated)); expect(settled).toBeGreaterThan(0);
});

test("an OpenAI refusal fails the optional memory offer and settles only observed usage", async () => {
  const candidate = { id: "memory-refused", title: "Parser", summary: "Escaping rule", body: "A concrete constraint.", engine: "codex", kind: "note", scope: "project", writtenAt: "2026-10-30T00:00:00Z" };
  let failed = false, recorded = false, settled = 0;
  const block = await injectMemory({ prompt: "Update the parser", engine: "codex", project: "repo-fixture", origin: "operator", conversation: "conversation-a", requestId: "turn-refused" }, {
    provider: "openai", enabled: () => true, ownsTraffic: () => true, candidates: () => [candidate], reserve: () => true,
    settle: cost => { settled = cost; }, record: () => { recorded = true; }, activity: event => { failed ||= event === "failed"; },
    decide: (body, signal) => decideMemories(body, credential, signal, "openai", (async () => Response.json({ answers: [{ type: "refusal", name: candidate.id }], usage })) as unknown as typeof fetch),
  });
  expect(block).toBe(""); expect(failed).toBe(true); expect(recorded).toBe(false); expect(settled).toBeGreaterThan(0); expect(settled).toBeLessThan(.01);
});

test("the sweep resolves between messages and separates provider score caches", async () => {
  await writeKey("openai", credential); await chooseService("asks", "openai");
  process.env["OPENROUTER_API_KEY"] = "baseline-fixture";
  const now = new Date("2026-10-30T00:00:00Z"), text = "The parser changes are complete and the targeted checks pass. Should I merge the branch now, or wait for another review?";
  const candidates: AskCandidate[] = ["one", "two"].map(subject => ({ subject, conversationId: subject, path: `${subject}.jsonl`, project: "repo-fixture", role: null, title: null, working: false, structuredAsk: false, lastTurnStartedAt: null }));
  const dispatched: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init!.body));
    dispatched.push(String(url) + ":" + new Headers(init?.headers).get("authorization"));
    if (String(url).includes("api.openai.com")) { await removeOpenAiKey(); return Response.json(reply(body.questions.map((row: {name: string}) => row.name))); }
    return Response.json({ answers: { asks: { noul: .9 }, waiting: { noul: .1 }, decision: { noul: .2 } }, usage: { cost: 0 } });
  }) as unknown as typeof fetch;
  try {
  await runAskSweep({ now: () => now, settings: () => ({ enabled: true, capUsd: 1 }), enabledSince: null, candidates,
    finalMessage: candidate => ({ id: candidate.subject, text, ts: now.getTime(), engineError: false }),
    resolve: () => { const r = resolveService("asks"); return r.apiKey ? { provider: r.effective, apiKey: r.apiKey } : null; },
    classify: (text, key, provider = "openrouter") => classify(text, { apiKey: key, provider }),
    read: () => loadOperatorAsks(undefined, now), write: mutation => { mutateOperatorAsks(mutation, now); },
  });
  } finally { globalThis.fetch = original; }
  expect(dispatched).toEqual([`https://api.openai.com/v1/decisions:Bearer ${credential}`, "https://openrouter.ai/api/alpha/decisions:Bearer baseline-fixture"]);
  expect(Object.keys(loadOperatorAsks(undefined, now).scores).map(key => key.startsWith("openai:")).sort()).toEqual([false, true]);
});

function rule(index: number): RoleMemoryRule {
  return { kind: "rule", id: `r_${index.toString(16).padStart(16, "0")}`, rule: "Check receipt ownership before replay.", scope: "machine", state: "active", hints: [], why: "Earlier replay lacked proof.",
    source: { project: "repo-fixture", pipelineId: "pipeline-fixture", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: "conversation-a" }, createdAt: "2026-10-30T00:00:00Z", changedAt: "2026-10-30T00:00:00Z" };
}
test("actual rule selector skips OpenRouter balance, keeps its wire label, and handles HTTP 429", async () => {
  await writeKey("openai", credential); await chooseService("rules", "openai");
  const scopes = [{ scope: "machine", rules: [rule(1), rule(2)] }]; let calls = 0;
  const fetcher = mockVendor(body => { calls++; expect(body.model).toBe("gpt-6-luna"); expect(Array.isArray(body.input)).toBe(true); return reply(body.questions.map(row => row.name)); });
  const selected = await selectRoleMemory(scopes, "Receipt ownership", { fetch: fetcher });
  expect(selected).toMatchObject({ selector: "jev", selectorVersion: "openai/gpt-6-luna-v2", shadowIds: scopes[0].rules.map(row => row.id) }); expect(calls).toBe(1);
  const refused = await selectRoleMemory(scopes, "Receipt ownership", { fetch: (async () => new Response("credit_balance_exhausted", { status: 429 })) as unknown as typeof fetch });
  expect(refused).toMatchObject({ selector: "bm25", reason: "jev-http,bm25" });
});
test("key loss between actual rule batches stops dispatch with authority reason", async () => {
  await writeKey("openai", credential); await chooseService("rules", "openai"); let calls = 0;
  const scopes = [{ scope: "machine", rules: Array.from({ length: 33 }, (_, index) => rule(index + 1)) }];
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => { calls++; const body = JSON.parse(String(init!.body)); await removeOpenAiKey(); return Response.json(reply(body.questions.map((row: { name: string }) => row.name))); }) as unknown as typeof fetch;
  expect(await selectRoleMemory(scopes, "Receipt ownership", { fetch: fetcher })).toMatchObject({ selector: "bm25", reason: "jev-authority-changed,bm25" }); expect(calls).toBe(1);
});

test("an unsaved rule provider follows the OpenAI key when both keys exist", async () => {
  await writeKey("openai", credential);
  process.env["OPENROUTER_API_KEY"] = "baseline-fixture";
  const urls: string[] = [];
  const selected = await selectRoleMemory([{ scope: "machine", rules: [rule(1)] }], "Receipt ownership", { fetch: (async (url, init) => {
    urls.push(String(url));
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${credential}`);
    const body = JSON.parse(String(init?.body));
    return Response.json(reply(body.questions.map((row: { name: string }) => row.name)));
  }) as typeof fetch });
  expect(selected).toMatchObject({ selector: "jev", evidence: { provider: "openai" } });
  expect(urls).toEqual(["https://api.openai.com/v1/decisions"]);
});

test("OpenAI's real adapter preserves batch order, redaction, total cost and durable evidence", async () => {
  await writeKey("openai", credential); await chooseService("rules", "openai");
  const pool = Array.from({ length: 65 }, (_, index) => rule(index + 1));
  pool[0].rule += "\ncredential: sample";
  const plan = openAiRoleSelectionProvider().prepare({ role: "agent", brief: "Receipt ownership", rules: pool });
  let batches = 0;
  const expected: [string, number][] = [];
  const selected = await selectRoleMemory([{ scope: "machine", rules: pool }], "Receipt ownership", { fetch: mockVendor((body, init) => {
    expect(init.redirect).toBe("error");
    expect(JSON.stringify(body)).not.toContain("sample");
    const start = batches++ * 32;
    const answer = reply(body.questions.map(row => row.name));
    answer.answers.forEach((row, index) => {
      row.probability = (start + index + 1) / 100;
      expected.push([pool[start + index].id, row.probability]);
    });
    answer.answers.reverse();
    return answer;
  }) });
  const billed = ((500 * .1 + 200 * .01 + 300 * .125) / 1e6) * 3;
  expect(batches).toBe(3);
  expect(selected).toMatchObject({ selector: "jev", evidence: { provider: "openai", scoreSource: "jev", allScores: expected, ceilingUsd: plan.ceilingUsd, reservedUsd: plan.ceilingUsd } });
  expect(selected.evidence!.costUsd).toBeCloseTo(billed, 12);
  expect(selected.evidence!.billedUsd).toBeCloseTo(billed, 12);
  expect(isSelectionEvidence(JSON.parse(JSON.stringify(selected.evidence)))).toBe(true);
});

test.each(["http", "shape", "unpriced", "network"])("OpenAI rule %s failures retain main's observed or conservative charge", async kind => {
  await writeKey("openai", credential); await chooseService("rules", "openai");
  const selected = await selectRoleMemory([{ scope: "machine", rules: [rule(1)] }], "Receipt ownership", { fetch: Object.assign(async () => {
    if (kind === "network") throw Error("fixture network failure");
    return kind === "http" ? new Response("refused", { status: 429 }) : Response.json({ answers: [], usage: kind === "shape" ? usage : {} });
  }, { preconnect: fetch.preconnect }) });
  expect(selected).toMatchObject({ selector: "bm25", shadowIds: [rule(1).id] });
  const cost = kind === "http" ? 0 : kind === "shape" ? (500 * .1 + 200 * .01 + 300 * .125) / 1e6 : selected.evidence!.reservedUsd;
  expect(selected.evidence!.costUsd).toBeCloseTo(cost, 12);
  expect(selected.evidence!.billedUsd).toBe(kind === "unpriced" || kind === "network" ? null : cost);
  expect(selected.evidence!.reservedUsd).toBeGreaterThan(0);
});

test.each(["key", "provider"])("a changed %s between OpenAI rule batches stops dispatch even with a funded fallback", async change => {
  await writeKey("openai", credential); await chooseService("rules", "openai");
  // Equal credentials make the provider check independent of the key check.
  process.env.OPENROUTER_API_KEY = credential;
  let calls = 0;
  const selected = await selectRoleMemory([{ scope: "machine", rules: Array.from({ length: 33 }, (_, index) => rule(index + 1)) }], "Receipt ownership", { fetch: (async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    if (change === "key") await writeKey("openai", ["sk", "proj", "s".repeat(48)].join("-"));
    else await chooseService("rules", "openrouter");
    return Response.json(reply(body.questions.map((row: { name: string }) => row.name)));
  }) as typeof fetch });
  expect(calls).toBe(1);
  expect(selected).toMatchObject({ selector: "bm25", reason: "jev-authority-changed,bm25", evidence: { provider: "openai", billedUsd: null } });
  expect(selected.evidence!.costUsd).toBeGreaterThan((500 * .1 + 200 * .01 + 300 * .125) / 1e6);
});

test("initial service resolution belongs to the selector's monotonic deadline", async () => {
  await writeKey("openai", credential); await chooseService("rules", "openai");
  let clock = 0, reads = 0, calls = 0;
  const now = spyOn(performance, "now").mockImplementation(() => clock);
  const statSync = fs.statSync;
  const stat = spyOn(fs, "statSync").mockImplementation(((...args: Parameters<typeof fs.statSync>) => {
    const result = statSync(...args);
    if (String(args[0]).endsWith("openai-services.json")) { reads++; clock = 10_000; }
    return result;
  }) as typeof fs.statSync);
  try {
    const selected = await selectRoleMemory([{ scope: "machine", rules: [rule(1)] }], "Receipt ownership", { fetch: mockVendor(body => { calls++; return reply(body.questions.map(row => row.name)); }) });
    expect(reads).toBe(1); expect(calls).toBe(0);
    expect(selected).toMatchObject({ selector: "whole", reason: "selector-timeout", evidence: { phase: "bm25", costUsd: 0 } });
  } finally { stat.mockRestore(); now.mockRestore(); }
});

test.each([1, 2])("OpenAI cannot dispatch when synchronous authority read %i crosses the monotonic deadline", async crossingRead => {
  await writeKey("openai", credential); await chooseService("rules", "openai");
  fs.mkdirSync(process.env.LLV_STATE_DIR!, { recursive: true });
  fs.writeFileSync(path.join(process.env.LLV_STATE_DIR!, "memory-source.json"), JSON.stringify({ schemaVersion: 1, source: "delegatus", phase: "active", changedAt: "2026-10-30T00:00:00Z" }));
  let clock = 0, reads = 0, calls = 0;
  const now = spyOn(performance, "now").mockImplementation(() => clock);
  const statSync = fs.statSync;
  const stat = spyOn(fs, "statSync").mockImplementation(((...args: Parameters<typeof fs.statSync>) => {
    const result = statSync(...args);
    if (String(args[0]).endsWith("memory-source.json") && ++reads === crossingRead) clock = 10_000;
    return result;
  }) as typeof fs.statSync);
  try {
    const selected = await selectRoleMemory([{ scope: "machine", rules: [rule(1)] }], "Receipt ownership", { fetch: mockVendor(body => { calls++; return reply(body.questions.map(row => row.name)); }) });
    expect(reads).toBe(crossingRead); expect(calls).toBe(0);
    expect(selected).toMatchObject({ selector: "bm25", reason: "jev-timeout,bm25" });
    expect(selected.evidence!.costUsd).toBe(selected.evidence!.reservedUsd);
    expect(selected.evidence!.costUsd).toBeGreaterThan(0);
  } finally { stat.mockRestore(); now.mockRestore(); }
});

test("OpenAI checks the same deadline between rule batches", async () => {
  await writeKey("openai", credential); await chooseService("rules", "openai");
  let clock = 0, calls = 0;
  const now = spyOn(performance, "now").mockImplementation(() => clock);
  try {
    const selected = await selectRoleMemory([{ scope: "machine", rules: Array.from({ length: 33 }, (_, index) => rule(index + 1)) }], "Receipt ownership", { fetch: mockVendor(body => {
      calls++; clock = 10_000;
      return reply(body.questions.map(row => row.name));
    }) });
    expect(calls).toBe(1);
    expect(selected).toMatchObject({ selector: "bm25", reason: "jev-timeout,bm25", evidence: { billedUsd: null } });
    expect(selected.evidence!.costUsd).toBe(selected.evidence!.reservedUsd);
  } finally { now.mockRestore(); }
});

test("a cancelled OpenAI rule body retains its ceiling through a late reply and process restart", async () => {
  await writeKey("openai", credential); await chooseService("rules", "openai");
  const abort = new AbortController();
  let ready!: () => void, release!: (value: unknown) => void, finished!: () => void;
  const reached = new Promise<void>(resolve => { ready = resolve; });
  const bodyFinished = new Promise<void>(resolve => { finished = resolve; });
  let responseBody: ReturnType<typeof reply>;
  const pending = selectRoleMemory([{ scope: "machine", rules: [rule(1)] }], "Receipt ownership", { signal: abort.signal, fetch: (async (_url, init) => {
    const body = JSON.parse(String(init?.body)); responseBody = reply(body.questions.map((row: { name: string }) => row.name));
    return { ok: true, status: 200, json: async () => {
      ready();
      const value = await new Promise(resolve => { release = resolve; });
      finished(); return value;
    } } as Response;
  }) as typeof fetch });
  await reached; abort.abort();
  const selected = await pending, retained = structuredClone(selected.evidence!);
  expect(selected).toMatchObject({ selector: "bm25", reason: "jev-timeout,bm25" });
  expect(retained.costUsd).toBe(retained.reservedUsd); expect(retained.costUsd).toBeGreaterThan(0);
  release(responseBody!); await bodyFinished;
  await reserveSelectionSpend(0, new AbortController().signal);
  expect(selected.evidence).toEqual(retained);
  const script = `import { reserveSelectionSpend } from ${JSON.stringify(path.resolve(import.meta.dir, "../memory/roleSelectionSpend.ts"))};
if (await reserveSelectionSpend(${5 - retained.reservedUsd / 2}, new AbortController().signal, new Date('2026-10-30T00:00:00Z')) !== null) throw Error('cancelled reservation was refunded');`;
  const child = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 20_000);
  try {
    const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: expect.any(String) });
  } finally { clearTimeout(watchdog); if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; } }
});
