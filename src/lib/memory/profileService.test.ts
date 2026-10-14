import { describe, expect, test } from "bun:test";
import { createProfileService } from "./profileService";
import { sampleAnswer, sampleMemory } from "./profile.fixture";
import { MemoryProfileError } from "./profile";
import type { ProfileRow } from "./profileTypes";
import { MEMORY_PROFILE_MODEL, MEMORY_PROFILE_FALLBACK_MODEL, prepareProfileCaller, type ProfileCaller, type ProfileResult } from "./profileModel";

function harness(call: ProfileCaller = async (_, locale) => ({ answer: sampleAnswer(locale === "uk"), model: "haiku" })) {
  const rules = sampleMemory(); const rows = new Map<string, ProfileRow>();
  let preparations = 0;
  const ports = { rules: () => structuredClone(rules), read: (_: string, locale: string) => structuredClone(rows.get(locale) ?? null), write: (row: ProfileRow) => { rows.set(row.locale, structuredClone(row)); }, prepare: async () => { preparations++; return call; }, model: "haiku" };
  return { rules, rows, ports, service: createProfileService(ports), preparations: () => preparations };
}
describe("explicit parallel profile generation", () => {
  test("parallel requests persist their producing models, including an overall fallback", async () => {
    const requests: string[] = [];
    const caller = await prepareProfileCaller("garden", {
      model: MEMORY_PROFILE_MODEL,
      manager: { resolveHeadlessSpawn: () => ({ kind: "available", account: { engine: "claude", accountId: "sample", kind: "managed", home: "sample", transcriptRoot: "sample", env: { NODE_ENV: "test" } } }) },
      credentials: () => ({ state: "present", source: "file", document: { claudeAiOauth: { accessToken: "sample", expiresAt: Date.now() + 60_000 } } }),
      request: async (_, init) => {
        const body = JSON.parse(init.body as string); requests.push(body.model);
        if (body.model === MEMORY_PROFILE_MODEL && body.messages[0].content.includes("Memory level: all memory")) return new Response(null, { status: 403 });
        return Response.json({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(sampleAnswer()) }] });
      },
    });
    const h = harness(caller); h.ports.model = MEMORY_PROFILE_MODEL;
    await h.service.start("garden", "en").done;
    expect(h.service.read("garden", "en").run!.state).toBe("done");
    expect(h.rows.get("en")!.parts.find(part => part.scope === "overall")!.model).toBe(MEMORY_PROFILE_FALLBACK_MODEL);
    expect(h.service.read("garden", "en").overall!.model).toBe(MEMORY_PROFILE_FALLBACK_MODEL);
    expect(h.service.read("garden", "en").slices.filter(slice => slice.summary).every(slice => slice.summary!.model === MEMORY_PROFILE_MODEL)).toBe(true);
    expect(requests.filter(model => model === MEMORY_PROFILE_FALLBACK_MODEL)).toHaveLength(1);
    // A later explicit refresh can upgrade the fallback; completed Opus slices stay cached.
    requests.length = 0;
    await h.service.start("garden", "en").done;
    expect(requests).toEqual([MEMORY_PROFILE_MODEL, MEMORY_PROFILE_FALLBACK_MODEL]);
  });
  test("reads never generate; all calls start together; duplicate presses join", async () => {
    const releases = new Map<string, (answer: ProfileResult) => void>();
    const h = harness(input => new Promise(resolve => releases.set(input.scope, resolve)));
    h.service.read("garden", "en"); expect(h.preparations()).toBe(0);
    const run = h.service.start("garden", "en");
    expect(h.service.start("garden", "en")).toBe(run);
    await Promise.resolve(); expect(releases.size).toBe(5);
    releases.get("machine")!({ answer: sampleAnswer(), model: "haiku" }); await Promise.resolve(); await Promise.resolve();
    expect(run.latest.slices.find(slice => slice.scope === "machine")!.summary).not.toBeNull();
    expect(run.latest.overall).toBeNull(); expect(run.latest.run!.state).toBe("running");
    expect(run.latest.stale).toBe(false);
    for (const [scope, release] of releases) if (scope !== "machine") release({ answer: sampleAnswer(), model: "haiku" });
    await run.done; expect(run.latest.run!.state).toBe("done");
  });
  test("unchanged refresh is instant and only changed slices regenerate", async () => {
    const scopes: string[] = [];
    const h = harness(async input => { scopes.push(input.scope); return { answer: sampleAnswer(), model: "haiku" }; });
    await h.service.start("garden", "en").done; expect(scopes).toHaveLength(5);
    scopes.length = 0; await h.service.start("garden", "en").done;
    expect(scopes).toHaveLength(0); expect(h.preparations()).toBe(1);
    h.rules.scopes[0]!.active[0]!.rule = "Check the new sample shape before saving.";
    h.rules.scopes[0]!.active[0]!.changedAt = "2026-01-02";
    expect(h.service.read("garden", "en").stale).toBe(true);
    expect(h.service.read("garden", "en").changes).toEqual({ added: 0, rewritten: 1, removed: 0 });
    await h.service.start("garden", "en").done;
    expect(scopes).toEqual(["overall", "role:garden:builder"]);
    expect(h.service.read("garden", "en").stale).toBe(false);
  });
  test("one locale retry, separate locale caches, no malformed-answer retry", async () => {
    let calls = 0;
    const h = harness(async (_, locale) => { calls++; return { answer: sampleAnswer(calls > 5 && locale === "uk"), model: "haiku" }; });
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
    h.ports.prepare = async () => async () => ({ answer: sampleAnswer(), model: h.ports.model });
    await h.service.start("garden", "en").done;
    expect(h.service.read("garden", "en").stale).toBe(false);
  });
  test("a fresh overall retains changed-rule counts for a failed slice", async () => {
    const h = harness(); await h.service.start("garden", "en").done;
    const scope = h.rules.scopes[0]!;
    scope.active[0]!.rule = "Check the new sample shape before saving.";
    scope.active[0]!.changedAt = "2026-01-02";
    scope.active.pop();
    scope.active.push({ ...scope.active[0]!, id: "six", rule: "Keep preview labels readable." });
    h.ports.prepare = async () => async input => {
      if (input.scope === scope.scope) throw new MemoryProfileError("invalid");
      return { answer: sampleAnswer(), model: "haiku" };
    };
    await h.service.start("garden", "en").done;
    const view = h.service.read("garden", "en");
    expect(view.overall!.stale).toBe(false);
    expect(view.stale).toBe(true);
    expect(view.changes).toEqual({ added: 1, rewritten: 1, removed: 1 });
    h.ports.prepare = async () => async () => ({ answer: sampleAnswer(), model: h.ports.model });
    await h.service.start("garden", "en").done;
    const refreshed = h.service.read("garden", "en");
    expect(refreshed.stale).toBe(false);
    expect(refreshed.changes).toEqual({ added: 0, rewritten: 0, removed: 0 });
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
