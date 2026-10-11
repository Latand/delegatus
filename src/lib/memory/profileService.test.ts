import { describe, expect, test } from "bun:test";
import { createProfileService } from "./profileService";
import { sampleAnswer, sampleMemory } from "./profile.fixture";
import { MemoryProfileError } from "./profile";
import type { ProfileRow } from "./profileTypes";
import type { ProfileCaller } from "./profileModel";

function harness(call: ProfileCaller = async (_, locale) => sampleAnswer(locale === "uk")) {
  const rules = sampleMemory(); const rows = new Map<string, ProfileRow>();
  let preparations = 0;
  const ports = { rules: () => structuredClone(rules), read: (_: string, locale: string) => structuredClone(rows.get(locale) ?? null), write: (row: ProfileRow) => { rows.set(row.locale, structuredClone(row)); }, prepare: async () => { preparations++; return call; }, model: "haiku" };
  return { rules, rows, ports, service: createProfileService(ports), preparations: () => preparations };
}
describe("explicit parallel profile generation", () => {
  test("reads never generate; all calls start together; duplicate presses join", async () => {
    const releases = new Map<string, (answer: unknown) => void>();
    const h = harness(input => new Promise(resolve => releases.set(input.scope, resolve)));
    h.service.read("garden", "en"); expect(h.preparations()).toBe(0);
    const run = h.service.start("garden", "en");
    expect(h.service.start("garden", "en")).toBe(run);
    await Promise.resolve(); expect(releases.size).toBe(5);
    releases.get("machine")!(sampleAnswer()); await Promise.resolve(); await Promise.resolve();
    expect(run.latest.slices.find(slice => slice.scope === "machine")!.summary).not.toBeNull();
    expect(run.latest.overall).toBeNull(); expect(run.latest.run!.state).toBe("running");
    expect(run.latest.stale).toBe(false);
    for (const [scope, release] of releases) if (scope !== "machine") release(sampleAnswer());
    await run.done; expect(run.latest.run!.state).toBe("done");
  });
  test("unchanged refresh is instant and only changed slices regenerate", async () => {
    const scopes: string[] = [];
    const h = harness(async input => { scopes.push(input.scope); return sampleAnswer(); });
    await h.service.start("garden", "en").done; expect(scopes).toHaveLength(5);
    scopes.length = 0; await h.service.start("garden", "en").done;
    expect(scopes).toHaveLength(0); expect(h.preparations()).toBe(1);
    h.rules.scopes[0]!.active[0]!.rule = "Check the new sample shape before saving.";
    h.rules.scopes[0]!.active[0]!.changedAt = "2026-01-02";
    expect(h.service.read("garden", "en").stale).toBe(true);
    await h.service.start("garden", "en").done;
    expect(scopes).toEqual(["overall", "role:garden:builder"]);
    expect(h.service.read("garden", "en").stale).toBe(false);
  });
  test("one locale retry, separate locale caches, no malformed-answer retry", async () => {
    let calls = 0;
    const h = harness(async (_, locale) => { calls++; return sampleAnswer(calls > 5 && locale === "uk"); });
    await h.service.start("garden", "uk").done; expect(calls).toBe(10);
    expect(h.service.read("garden", "uk").overall).not.toBeNull();
    expect(h.service.read("garden", "en").overall).toBeNull();
    const invalid = harness(async () => { throw new MemoryProfileError("invalid"); });
    await invalid.service.start("garden", "en").done;
    expect(invalid.service.read("garden", "en").run!.errors).toHaveLength(5);
  });
  test("removed bindings disappear and old prose remains stale on failure", async () => {
    const h = harness(); await h.service.start("garden", "en").done;
    h.rules.scopes[0]!.active.shift();
    const view = h.service.read("garden", "en");
    expect(view.stale).toBe(true); expect(view.changes.removed).toBe(1);
    expect(view.overall!.answer.topics[0]!.ruleIds).toEqual([]);
    h.ports.prepare = async () => { throw new MemoryProfileError("account"); };
    await h.service.start("garden", "en").done;
    expect(h.service.read("garden", "en").overall!.answer.text).toBe(sampleAnswer().text);
    expect(h.service.read("garden", "en").stale).toBe(true);
  });
  test("a failed model upgrade never admits old cached parts on the next press", async () => {
    const h = harness(); await h.service.start("garden", "en").done;
    h.ports.model = "new-model";
    h.ports.prepare = async () => { throw new MemoryProfileError("account"); };
    await h.service.start("garden", "en").done;
    expect(h.service.read("garden", "en").stale).toBe(true);
    h.ports.prepare = async () => async () => sampleAnswer();
    await h.service.start("garden", "en").done;
    expect(h.service.read("garden", "en").stale).toBe(false);
  });
  test("empty and disabled memory make no model calls; restart reports interruption", async () => {
    const h = harness(); h.rules.enabled = false;
    await h.service.start("garden", "en").done; expect(h.preparations()).toBe(0);
    h.rules.enabled = true; h.rules.scopes.forEach(scope => { scope.active = []; });
    await h.service.start("garden", "en").done; expect(h.preparations()).toBe(0);
    h.rows.get("en")!.run!.state = "running";
    expect(h.service.read("garden", "en").run!.errors[0]!.code).toBe("interrupted");
  });
  test("storage refusal emits a terminal failure before settling the stream", async () => {
    const h = harness(); let writes = 0;
    h.ports.write = row => { if (++writes > 1) throw Error("unavailable"); h.rows.set(row.locale, structuredClone(row)); };
    const run = h.service.start("garden", "en"); await run.done;
    expect(run.latest.run!.state).toBe("failed");
  });
});
