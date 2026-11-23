import { beforeEach, afterEach, test, expect, setSystemTime, spyOn } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { selectRoleMemory } from "./roleSelect";
import { configuredRoleSelectionProvider } from "./roleSelectionProvider";
import { chooseService, resolveService } from "@/lib/openaiServices/policy";
import type { RoleMemoryRule } from "./roleTypes";

const names = ["LLV_STATE_DIR", "XDG_CONFIG_HOME", "OPENAI_API_KEY", "OPENROUTER_API_KEY"];
let root: string, saved: Record<string, string | undefined>;
beforeEach(() => {
  setSystemTime(new Date("2026-11-03T00:00:00Z"));
  saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  root = fs.mkdtempSync(path.join(os.tmpdir(), "selection-provider-"));
  process.env.LLV_STATE_DIR = path.join(root, "state");
  process.env.XDG_CONFIG_HOME = path.join(root, "config");
});
afterEach(() => {
  setSystemTime();
  for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  fs.rmSync(root, { recursive: true, force: true });
});
const scopes = [{ scope: "role:fixture:builder", rules: ["Check the receipt owner before replay.", "Measure phone gestures in the browser.", "Preserve the task's safety boundaries."].map((rule, i): RoleMemoryRule => ({
  kind: "rule", id: `r_${String(i).padStart(16, "0")}`, scope: "role:fixture:builder", rule, why: "Earlier verification was incomplete.", state: "active", hints: [],
  source: { origin: "conversation", project: "fixture", roleId: "builder", fixRound: false, conversationId: "fixture-conversation" },
  createdAt: "2026-10-01T00:00:00Z", changedAt: "2026-10-01T00:00:00Z", ...(i === 2 ? { keptByOperatorAt: "2026-10-01T00:00:00Z" } : {}),
})) }];

test.each(["openai", "openrouter", "both", "neither"])("unsaved %s keys route real decisions and preserve protected rules", async keys => {
  if (keys === "openai" || keys === "both") process.env.OPENAI_API_KEY = "fixture-a";
  if (keys === "openrouter" || keys === "both") process.env.OPENROUTER_API_KEY = "fixture-b";
  const expected = keys === "openai" || keys === "both" ? "openai" : "openrouter";
  const paths: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const route = new URL(request.url).pathname; paths.push(route);
    expect(request.headers.get("authorization")).toBe(`Bearer fixture-${expected === "openai" ? "a" : "b"}`);
    if (route.endsWith("/key")) return Response.json({ data: { limit: null, limit_remaining: null } });
    const body = await request.json();
    if (expected === "openai") return Response.json({ usage: { input_tokens: 100 }, answers: body.questions.map((q: { name: string }, i: number) => ({ type: "predicate", name: q.name, probability: i ? .01 : .9 })) });
    return Response.json({ usage: { cost: .00001 }, answers: Object.fromEntries(Object.keys(body.questions).map((id, i) => [id, { noul: i ? .01 : .9 }])) });
  } });
  const nativeFetch = globalThis.fetch;
  const request = ((url, init) => nativeFetch(new URL(new URL(String(url)).pathname, server.url), init)) as typeof fetch;
  try {
    const result = await selectRoleMemory(scopes, "Repair persisted receipt recovery", { fetch: request });
    expect(result.evidence?.provider).toBe(expected);
    expect(result.selector).toBe(keys === "neither" ? "bm25" : "jev");
    expect(result.shadowIds).toContain(scopes[0].rules[2].id);
    if (keys !== "neither") expect(result.shadowIds).toEqual([scopes[0].rules[0].id, scopes[0].rules[2].id]);
    expect(paths).toEqual(keys === "neither" ? [] : expected === "openai" ? ["/v1/decisions"] : ["/api/v1/key", "/api/alpha/decisions"]);
  } finally { await server.stop(true); }
});

test("explicit choices override connected keys and survive a fresh process", async () => {
  process.env.OPENAI_API_KEY = "fixture-a"; process.env.OPENROUTER_API_KEY = "fixture-b";
  await chooseService("rules", "openrouter");
  expect(configuredRoleSelectionProvider().id).toBe("openrouter");
  const script = `import {resolveService} from ${JSON.stringify(path.resolve("src/lib/openaiServices/policy.ts"))};
if(resolveService('rules').effective!=='openrouter') throw Error('explicit provider lost');`;
  const child = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  try {
    const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  } finally { if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; } }
  await chooseService("rules", "openai");
  delete process.env.OPENAI_API_KEY;
  expect(resolveService("rules")).toMatchObject({ requested: "openai", effective: "openai", available: false, held: true });
  expect(await selectRoleMemory(scopes, "receipt recovery")).toMatchObject({ selector: "bm25", reason: "jev-no-key,bm25" });
});

for (const provider of ["openai", "openrouter"] as const) test.each(["http", "shape", "timeout", "revoked"])(`${provider} %s falls back through its real endpoint`, async kind => {
  process.env[provider === "openai" ? "OPENAI_API_KEY" : "OPENROUTER_API_KEY"] = "fixture";
  const abort = new AbortController();
  let arrived!: () => void;
  const reached = new Promise<void>(resolve => { arrived = resolve; });
  let release = () => {};
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname.endsWith("/key")) return Response.json({ data: { limit: null, limit_remaining: null } });
    const body = await request.json();
    arrived();
    if (kind === "timeout") return new Promise<Response>(resolve => { release = () => resolve(Response.json({})); });
    if (kind === "http") return Response.json({}, { status: 429 });
    if (kind === "revoked") {
      delete process.env[provider === "openai" ? "OPENAI_API_KEY" : "OPENROUTER_API_KEY"];
      return provider === "openai" ? Response.json({ answers: body.questions.map((q: { name: string }) => ({ type: "predicate", name: q.name, probability: .9 })), usage: { input_tokens: 100 } })
        : Response.json({ answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { noul: .9 }])), usage: { cost: .00001 } });
    }
    return Response.json({ answers: [], usage: { input_tokens: 100, cost: .00001 } });
  } });
  const nativeFetch = globalThis.fetch;
  const request = ((url, init) => nativeFetch(new URL(new URL(String(url)).pathname, server.url), init)) as typeof fetch;
  try {
    const pending = selectRoleMemory(scopes, "receipt recovery", { fetch: request, signal: abort.signal });
    await reached;
    if (kind === "timeout") abort.abort();
    expect(await pending).toMatchObject({ selector: "bm25", reason: `jev-${kind === "revoked" ? "authority-changed" : kind},bm25` });
    expect((await selectRoleMemory(scopes, "receipt recovery", { apiKey: null })).shadowIds).toEqual(scopes[0].rules.map(rule => rule.id));
  } finally { abort.abort(); release(); await server.stop(true); }
});

test.each([true, false])("a BM25 fault uses Decisions when available (%s), and whole only after both fail", async available => {
  process.env.OPENAI_API_KEY = "fixture";
  let calls = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    calls++;
    if (!available) return Response.json({}, { status: 429 });
    const body = await request.json();
    return Response.json({ answers: body.questions.map((q: { name: string }) => ({ type: "predicate", name: q.name, probability: .9 })), usage: { input_tokens: 100 } });
  } });
  const nativeFetch = globalThis.fetch;
  const broken = spyOn(Math, "log").mockImplementation(() => { throw Error("fixture scoring failure"); });
  try {
    const result = await selectRoleMemory(scopes, "receipt recovery", { fetch: ((url, init) => nativeFetch(new URL(new URL(String(url)).pathname, server.url), init)) as typeof fetch });
    expect(calls).toBe(1);
    expect(result.selector).toBe(available ? "jev" : "whole");
    if (!available) expect(result.reason).toBe("jev-http,bm25-error");
  } finally { broken.mockRestore(); await server.stop(true); }
});
