import { expect, test } from "bun:test";
import { injectMemory } from "./injection";
const entry = { id: "m_fixture", title: "Widget", summary: "Widget sockets need bounded retries.", body: "Use three attempts.", engine: "claude", kind: "project_fact", scope: "project", writtenAt: "2026-10-01" };
const input = { prompt: "Fix widget sockets", origin: "operator", engine: "codex", project: "project-widget", conversation: "conversation-fixture", requestId: "turn-fixture", context: [] };
function ports() {
  const p = { enabled: () => true, ownsTraffic: () => true, candidates: () => [entry], reserve: () => true,
    decide: async () => ({ scores: { m_fixture: .8 }, cost: .001 }), settle: (_cost: number) => {}, record: (_entries: unknown) => {}, timeoutMs: 20 };
  return p;
}
test("injection records only selected entries; machine prompts and closed gates never call Jev", async () => {
  let calls = 0, offers = 0;
  const p = ports(); p.decide = async () => { calls++; return { scores: { m_fixture: .8 }, cost: .001 }; }; p.record = () => { offers++; };
  expect(await injectMemory({ ...input, origin: "agent" }, p)).toBe("");
  expect(await injectMemory(input, { ...p, enabled: () => false })).toBe("");
  expect(await injectMemory(input, { ...p, ownsTraffic: () => false })).toBe("");
  expect(calls).toBe(0);
  expect(await injectMemory(input, p)).toContain("m_fixture"); expect(offers).toBe(1);
});
test("cap, exceptions, hung Jev and switch closure fail open without an offer", async () => {
  const p = ports(); let records = 0; p.record = () => { records++; };
  expect(await injectMemory(input, { ...p, reserve: () => false })).toBe("");
  expect(await injectMemory(input, { ...p, decide: async () => { throw Error("offline"); } })).toBe("");
  expect(await injectMemory(input, { ...p, decide: () => new Promise(() => {}) })).toBe("");
  let enabled = true;
  expect(await injectMemory(input, { ...p, enabled: () => enabled, decide: async () => { enabled = false; return { scores: { m_fixture: .8 }, cost: .001 }; } })).toBe("");
  expect(records).toBe(0);
});
test("the deadline includes synchronous candidate work before Jev", async () => {
  let calls = 0;
  const p = ports();
  const result = await injectMemory(input, { ...p, candidates: () => {
    const until = performance.now() + 30;
    while (performance.now() < until) { /* model synchronous index work */ }
    return [entry];
  }, decide: async () => { calls++; return { scores: { m_fixture: .8 }, cost: .001 }; } });
  expect(result).toBe("");
  expect(calls).toBe(0);
});
