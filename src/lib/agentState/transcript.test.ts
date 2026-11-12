import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentTranscriptCache, foldNativeBoundaries, nativeBoundaryEvent, readNativePromptAnchor } from "./transcript";
import { FIXTURE_NOW, FIXTURE_TURN, fixtureRecords, type FixtureEngine } from "./testFixture";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "central-native-")); roots.push(root); return path.join(root, "native.jsonl"); }
const encode = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join("\n") + "\n";
for (const engine of ["codex", "claude", "copilot"] as FixtureEngine[]) {
  test(`${engine}: native completion wins, a later prompt reopens, and unchanged reads acquire no payload`, async () => {
    const file = fixture(), cache = new AgentTranscriptCache(2), rows = fixtureRecords(engine);
    const input = { engine, path: file, revision: "generation-one", localRef: engine === "codex" ? FIXTURE_TURN : "local-ref", observedAt: FIXTURE_NOW };
    fs.writeFileSync(file, encode(rows.open));
    expect((await cache.acquire(input)).turn).toMatchObject({ determined: true, value: { state: "open" } });
    fs.appendFileSync(file, encode(rows.close));
    expect((await cache.acquire(input)).turn).toMatchObject({ determined: true, value: { state: "closed", tools: 0 } });
    const bytes = cache.counters.payloadBytes;
    await Promise.all([cache.acquire(input), cache.acquire(input)]);
    expect(cache.counters.payloadBytes).toBe(bytes);
    expect(cache.counters.joined).toBeGreaterThan(0);
    fs.appendFileSync(file, encode(rows.open));
    expect((await cache.acquire(input)).turn).toMatchObject({ determined: true, value: { state: "open" } });
    for (let index = 0; index < 3; index++) await cache.acquire({ ...input, revision: `generation-${index}` });
    expect(cache.size).toBe(2);
    expect(cache.counters.evictions).toBeGreaterThan(0);
  });
}
test("matching Codex terminal settles historical calls while an old terminal cannot close a later native id", () => {
  const rows = fixtureRecords("codex");
  const events = [...rows.open, ...rows.close].map(record => nativeBoundaryEvent(record, "codex")!).filter(Boolean);
  expect(foldNativeBoundaries(events, "codex", FIXTURE_TURN)).toMatchObject({ state: "closed", tools: 0 });
  expect(foldNativeBoundaries([...events, { kind: "start", type: "task_started", id: "later-turn", at: 2000 },
    { kind: "terminal", type: "task_complete", id: FIXTURE_TURN, at: 3000 }], "codex", "later-turn")).toMatchObject({ state: "open", nativeId: "later-turn" });
});
test("torn JSON, UTF-8, truncation and same-size inode replacement cannot reuse a completed boundary", async () => {
  const file = fixture(), cache = new AgentTranscriptCache();
  const rows = fixtureRecords("codex");
  const input = { engine: "codex" as const, path: file, revision: "one", localRef: FIXTURE_TURN, observedAt: FIXTURE_NOW };
  fs.writeFileSync(file, encode([...rows.open, ...rows.close]));
  expect((await cache.acquire(input)).turn.determined).toBe(true);
  const length = fs.statSync(file).size;
  fs.writeFileSync(`${file}.new`, Buffer.alloc(length, 0xff));
  fs.renameSync(`${file}.new`, file);
  expect((await cache.acquire(input)).turn.determined).toBe(false);
  fs.writeFileSync(file, '{"payload":');
  expect((await cache.acquire(input)).turn.determined).toBe(false);
  fs.writeFileSync(file, encode(rows.open));
  expect((await cache.acquire(input)).turn).toMatchObject({ value: { state: "open" } });
});
test("Claude tool-use and synthetic assistants cannot supply a native terminal", () => {
  for (const message of [
    { model: "provider", stop_reason: "end_turn", content: [{ type: "tool_use", id: "call" }] },
    { model: "<synthetic>", stop_reason: "end_turn", content: [] },
  ]) expect(nativeBoundaryEvent({ type: "assistant", message }, "claude")?.kind).toBe("continue");
});


test("a boundary above four MiB resumes earlier pages once and then serves unchanged summaries without payload reads", async () => {
  const file = fixture(), cache = new AgentTranscriptCache();
  const rows = fixtureRecords("claude");
  fs.writeFileSync(file, encode(rows.open));
  const padding = JSON.stringify({ type: "metadata", padding: "x".repeat(1000) }) + "\n";
  fs.appendFileSync(file, padding.repeat(5200));
  fs.appendFileSync(file, encode(rows.close));
  const input = { engine: "claude" as const, path: file, revision: "large-generation", localRef: "local-ref", observedAt: FIXTURE_NOW };
  expect((await cache.acquire(input)).turn.determined).toBe(false);
  expect((await cache.acquire(input)).turn).toMatchObject({ determined: true, value: { state: "closed", nativeId: "native-prompt-one" } });
  expect(cache.counters.payloadBytes).toBeLessThan(fs.statSync(file).size + 64 * 1024);
  const bytes = cache.counters.payloadBytes;
  await cache.acquire(input);
  expect(cache.counters.payloadBytes).toBe(bytes);
});

test("a Copilot resume anchor counts only this process's prompts and refuses rotation or changed anchor bytes", async () => {
  const file = fixture(), cache = new AgentTranscriptCache();
  const rows = fixtureRecords("copilot");
  fs.writeFileSync(file, encode([...rows.open, ...rows.close]));
  const anchor = await readNativePromptAnchor(file);
  expect(anchor).not.toBeNull();
  fs.appendFileSync(file, encode([...rows.open, ...rows.close]));
  const input = { engine: "copilot" as const, path: file, revision: "resumed-generation", localRef: "local-ref", observedAt: FIXTURE_NOW, anchor };
  expect((await cache.acquire(input)).turn).toMatchObject({ determined: true, value: { state: "closed", promptOrdinal: 1 } });
  fs.appendFileSync(file, encode([rows.open[0]!, rows.close.at(-1)!]));
  expect((await cache.acquire(input)).turn).toMatchObject({ value: { state: "open", promptOrdinal: 2 } });
  fs.renameSync(file, `${file}.old`);
  fs.copyFileSync(`${file}.old`, file);
  expect((await cache.acquire(input)).turn.determined).toBe(false);
});

test("large Codex tool histories reduce to bounded summaries without losing the terminal or rereading completed payload", async () => {
  const file = fixture(), cache = new AgentTranscriptCache();
  const rows = fixtureRecords("codex");
  const call = JSON.stringify(rows.open[1]) + "\n";
  fs.writeFileSync(file, encode([rows.open[0]]) + call.repeat(25000) + encode(rows.close));
  const input = { engine: "codex" as const, path: file, revision: "many-tools", localRef: FIXTURE_TURN, observedAt: FIXTURE_NOW };
  let result = await cache.acquire(input);
  for (let pass = 0; pass < 4 && !result.turn.determined; pass++) result = await cache.acquire(input);
  expect(result.turn).toMatchObject({ determined: true, value: { state: "closed", tools: 0 } });
  const bytes = cache.counters.payloadBytes;
  await cache.acquire(input);
  expect(cache.counters.payloadBytes).toBe(bytes);
});

test("an unnamed Codex user echo preserves the latest native start against an older terminal", () => {
  const records = [
    { type: "event_msg", payload: { type: "task_started", turn_id: "new-native-turn" } },
    { type: "event_msg", payload: { type: "user_message", message: "fixture request" } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: FIXTURE_TURN } },
  ];
  const events = records.map(record => nativeBoundaryEvent(record, "codex")!);
  expect(foldNativeBoundaries(events, "codex", FIXTURE_TURN)).toMatchObject({ state: "open", nativeId: "new-native-turn" });
});

test("an unnamed prompt after a closed Codex turn cannot reuse the old cached reference as its native identity", () => {
  const records = [...fixtureRecords("codex").open, ...fixtureRecords("codex").close,
    { type: "event_msg", payload: { type: "user_message", message: "new fixture request" } },
    ...fixtureRecords("codex").close];
  const events = records.map(record => nativeBoundaryEvent(record, "codex")!).filter(Boolean);
  expect(foldNativeBoundaries(events, "codex", FIXTURE_TURN)).toMatchObject({ state: "open", nativeId: null });
});

for (const engine of ["codex", "claude", "copilot"] as FixtureEngine[]) test(`${engine}: a native record larger than one page cannot strand earlier boundary recovery`, async () => {
  const file = fixture(), cache = new AgentTranscriptCache(), rows = fixtureRecords(engine);
  fs.writeFileSync(file, encode(rows.open) + encode([{ type: "metadata", padding: "x".repeat(700_000) }]) + encode(rows.close));
  const input = { engine, path: file, revision: "large-record", localRef: engine === "codex" ? FIXTURE_TURN : "local-ref", observedAt: FIXTURE_NOW };
  expect((await cache.acquire(input)).turn).toMatchObject({ determined: true, value: { state: "closed" } });
  const bytes = cache.counters.payloadBytes;
  await cache.acquire(input);
  expect(cache.counters.payloadBytes).toBe(bytes);
});

test("a record beyond the acquisition budget stays explicitly unknown and unchanged retries acquire no payload", async () => {
  const file = fixture(), cache = new AgentTranscriptCache(), rows = fixtureRecords("codex");
  fs.writeFileSync(file, encode(rows.open) + encode([{ type: "metadata", padding: "x".repeat(5 * 1024 * 1024) }]) + encode(rows.close));
  const input = { engine: "codex" as const, path: file, revision: "oversize-record", localRef: FIXTURE_TURN, observedAt: FIXTURE_NOW };
  expect((await cache.acquire(input)).turn.determined).toBe(false);
  expect((await cache.acquire(input)).turn).toMatchObject({ determined: false, why: "native record exceeds acquisition budget" });
  const bytes = cache.counters.payloadBytes;
  expect((await cache.acquire(input)).turn.determined).toBe(false);
  expect(cache.counters.payloadBytes).toBe(bytes);
});
