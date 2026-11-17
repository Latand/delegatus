import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentTranscriptCache, foldNativeBoundaries, nativeBoundaryEvent, readNativePromptAnchor } from "./transcript";
import { FIXTURE_NOW, FIXTURE_TURN, fixtureRecords, currentClaudeRecords, type FixtureEngine } from "./testFixture";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "central-native-")); roots.push(root); return path.join(root, "native.jsonl"); }
const encode = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join("\n") + "\n";
test.each([1, 40])("current Claude attachment ancestry closes after %i tool rounds, including append and restart", async rounds => {
  const file = fixture(), cache = new AgentTranscriptCache(), rows = currentClaudeRecords(rounds);
  const input = { engine: "claude" as const, path: file, revision: "current-shape", localRef: "local-ref", observedAt: FIXTURE_NOW };
  fs.writeFileSync(file, encode(rows.open));
  const before = await cache.acquire(input);
  expect(before.turn).toMatchObject({ determined: true, value: { state: "open" } });
  fs.appendFileSync(file, encode(rows.close));
  for (const reader of [cache, new AgentTranscriptCache()]) {
    expect((await reader.acquire(input)).turn).toMatchObject({ determined: true, value: { state: "closed", nativeId: "native-prompt-one" } });
    const bytes = reader.counters.payloadBytes;
    await reader.acquire(input);
    expect(reader.counters.payloadBytes).toBe(bytes);
  }
});

test("request bookkeeping does not change a Claude boundary; an unrelated attachment cannot close it", async () => {
  const rows = currentClaudeRecords(40);
  const fold = (records: Record<string, unknown>[]) => foldNativeBoundaries(records.map(row => nativeBoundaryEvent(row, "claude"))
    .filter((event): event is NonNullable<typeof event> => event !== null), "claude", "local-ref");
  // All five new bookkeeping types can be removed without changing ancestry.
  expect(fold([...rows.open, { ...rows.close.at(-1)!, parentUuid: "output-39" }])).toMatchObject({ state: "closed" });
  expect(fold([...rows.open, ...rows.close.slice(1, -1)])).toMatchObject({ state: "open" });
  expect(fold([...rows.open, { ...rows.close[0], parentUuid: "foreign-prompt" }, ...rows.close.slice(1)])).toMatchObject({ state: "open" });
});

test("current Claude ancestry recovers across request blobs larger than one acquisition", async () => {
  const file = fixture(), rows = currentClaudeRecords(40), cache = new AgentTranscriptCache();
  const padding = { type: "api-request-blob", padding: " ".repeat(2_600_000) };
  fs.writeFileSync(file, encode([...rows.open, ...rows.close.slice(0, 1), padding, padding, ...rows.close.slice(1)]));
  const input = { engine: "claude" as const, path: file, revision: "paged-current", localRef: "local-ref", observedAt: FIXTURE_NOW };
  expect((await cache.acquire(input)).turn.determined).toBe(false);
  expect((await cache.acquire(input)).turn).toMatchObject({ determined: true, value: { state: "closed" } });
  const bytes = cache.counters.payloadBytes;
  await cache.acquire(input);
  expect(cache.counters.payloadBytes).toBe(bytes);
});
test.each(["tool-use", "synthetic", "compaction", "background", "queued-prompt", "queued-notice"] as const)("current Claude attachment shape preserves open %s work", async kind => {
  const file = fixture(), rows = currentClaudeRecords();
  const terminal = rows.close.at(-1)!;
  const message = terminal.message as Record<string, unknown>;
  const close = kind === "queued-prompt" || kind === "queued-notice" ? [...rows.close, { type: "attachment", uuid: "queued-input", parentUuid: "terminal-frame",
    attachment: { type: "queued_command", commandMode: kind === "queued-prompt" ? "prompt" : "task-notification", prompt: "" } }]
    : kind === "background" ? [...rows.close, { type: "user", uuid: "background-prompt", parentUuid: "terminal-frame",
    isMeta: true, origin: "task", message: { role: "user", content: "<task-notification></task-notification>" } }]
    : [...rows.close.slice(0, -1), kind === "compaction" ? { ...terminal, isCompactSummary: true }
      : { ...terminal, message: kind === "synthetic" ? { ...message, model: "<synthetic>" }
        : { ...message, content: [{ type: "tool_use", id: "pending-call", name: "fixture", input: {} }] } }];
  fs.writeFileSync(file, encode([...rows.open, ...close]));
  expect((await new AgentTranscriptCache().acquire({ engine: "claude", path: file, revision: "adversarial-current",
    localRef: "local-ref", observedAt: FIXTURE_NOW })).turn).toMatchObject({ determined: true, value: { state: "open" } });
});

test("legacy persisted Claude summaries are reparsed once after a boundary reader upgrade", async () => {
  const file = fixture(), rows = currentClaudeRecords(), cache = new AgentTranscriptCache();
  const input = { engine: "claude" as const, path: file, revision: "legacy-summary", localRef: "local-ref", observedAt: FIXTURE_NOW };
  fs.writeFileSync(file, encode([...rows.open, ...rows.close]));
  const acquisition = await cache.acquire(input);
  if (!acquisition.turn.determined || !acquisition.transcript.determined) throw new Error("fixture boundary unavailable");
  // The old reader persisted this open summary for the very same file version.
  const legacy = JSON.parse(JSON.stringify(acquisition));
  delete legacy.transcript.value.boundaryVersion;
  legacy.turn.value = { ...legacy.turn.value, state: "open", closing: null };
  const restarted = new AgentTranscriptCache();
  restarted.seed(input, legacy);
  expect((await restarted.acquire(input)).turn).toMatchObject({ determined: true, value: { state: "closed" } });
  expect(restarted.counters.payloadBytes).toBeGreaterThan(0);
  const current = await restarted.acquire(input), next = new AgentTranscriptCache();
  next.seed(input, current);
  expect((await next.acquire(input)).turn).toMatchObject({ determined: true, value: { state: "closed" } });
  expect(next.counters.payloadBytes).toBe(0);
});

test.each([
  { message: { role: "user", content: [{ type: "tool_result", content: "done" }] } },
  { isCompactSummary: true, message: { role: "user", content: "summary" } },
  { isMeta: true, message: { role: "user", content: "metadata" } },
  { promptSource: "system", message: { role: "user", content: "notification" } },
  { interruptedByShutdown: true, message: { role: "user", content: "interrupted" } },
  { message: { role: "tool", content: "output" } },
])("Claude native and ledger readers exclude non-prompt user frames: %#", frame => {
  const user = { type: "user", uuid: "non-prompt", ...frame };
  expect(nativeBoundaryEvent(user, "claude")?.kind).not.toBe("start");
  expect(nativeBoundaryEvent({ kind: "item", turnId: "local-ref", item: user }, "claude-ledger", "local-ref")).toBeNull();
  const events = [
    { type: "user", uuid: "opening", message: { role: "user", content: "start" } },
    { type: "assistant", uuid: "terminal", parentUuid: "opening", message: { role: "assistant", model: "fixture", stop_reason: "end_turn", content: [] } },
    user,
  ].map(row => nativeBoundaryEvent(row, "claude")).filter((event): event is NonNullable<typeof event> => event !== null);
  expect(foldNativeBoundaries(events, "claude", "local-ref")).toMatchObject({ state: "closed", nativeId: "opening" });
});

test.each(["opening", "unrelated", undefined])("image-caption metadata preserves only owned ancestry across cache restart: %j", async parentUuid => {
  const file = fixture(), cache = new AgentTranscriptCache();
  const rows = [
    { type: "user", uuid: "opening", message: { role: "user", content: "fixture image instruction" } },
    { type: "user", uuid: "image-context", parentUuid, isMeta: true, entrypoint: "sdk-cli", userType: "external",
      message: { role: "user", content: [{ type: "text", text: "[Image: source: fixture.png]" }] } },
  ];
  const input = { engine: "claude" as const, path: file, revision: "fixture", localRef: "local-ref", observedAt: FIXTURE_NOW };
  fs.writeFileSync(file, encode(rows));
  expect((await cache.acquire(input)).turn).toMatchObject({ determined: true, value: { state: "open", nativeId: "opening" } });
  fs.appendFileSync(file, encode([{ type: "assistant", uuid: "terminal", parentUuid: "image-context",
    message: { role: "assistant", model: "fixture", stop_reason: "end_turn", content: [] } }]));
  const expected = { determined: true, value: { state: parentUuid === "opening" ? "closed" : "open", nativeId: "opening" } } as const;
  expect((await cache.acquire(input)).turn).toMatchObject(expected);
  expect((await new AgentTranscriptCache().acquire(input)).turn).toMatchObject(expected);
});

test("ledger fallback recovers the opening before a large tool result and joined prompt", async () => {
  const file = fixture(), cache = new AgentTranscriptCache();
  fs.writeFileSync(file, encode([
    { kind: "turn-started", turnId: "local-ref" },
    { kind: "item", turnId: "local-ref", item: { type: "user", uuid: "opening", message: { role: "user", content: "start" } } },
    { kind: "item", turnId: "local-ref", item: { type: "user", uuid: "tool-result", message: { role: "user", content: [{ type: "tool_result", content: "x".repeat(200000) }] } } },
    { kind: "item", turnId: "local-ref", item: { type: "user", uuid: "steering", message: { role: "user", content: "joined prompt" } } },
  ]));
  const input = { engine: "claude-ledger" as const, path: file, localRef: "local-ref", revision: "fixture", observedAt: FIXTURE_NOW };
  expect((await cache.acquire(input)).turn).toMatchObject({ determined: true, value: { nativeId: "opening" } });
  const bytes = cache.counters.payloadBytes;
  await cache.acquire(input);
  expect(cache.counters.payloadBytes).toBe(bytes);
});

test("a delivered background notification retains its own opening across tool output", () => {
  const records = [
    { type: "user", uuid: "foreground", message: { role: "user", content: "start" } },
    { type: "assistant", message: { role: "assistant", model: "fixture", stop_reason: "end_turn", content: [] } },
    { type: "user", uuid: "background-notice", isMeta: true, origin: "task", message: { role: "user", content: "<task-notification><task-id>fixture-job</task-id><status>completed</status></task-notification>" } },
    { type: "user", uuid: "background-output", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "follow-up", content: "done" }] } },
    { type: "assistant", message: { role: "assistant", model: "fixture", stop_reason: "end_turn", content: [] } },
  ];
  const events = records.map(row => nativeBoundaryEvent(row, "claude")).filter((event): event is NonNullable<typeof event> => event !== null);
  expect(foldNativeBoundaries(events, "claude", "background-local-ref")).toMatchObject({ state: "closed", nativeId: "background-notice" });
});
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

test.each([null, FIXTURE_TURN])("a Codex boundary above four MiB uses a bounded tail (localRef %j)", async localRef => {
  const file = fixture(), cache = new AgentTranscriptCache();
  const rows = fixtureRecords("codex");
  fs.writeFileSync(file, encode(rows.open));
  const padding = JSON.stringify({ type: "metadata", padding: "x".repeat(1000) }) + "\n";
  fs.appendFileSync(file, padding.repeat(5200));
  fs.appendFileSync(file, encode(rows.close));
  const input = { engine: "codex" as const, path: file, revision: "large-generation", localRef, observedAt: FIXTURE_NOW };
  expect((await cache.acquire(input)).turn).toMatchObject({ determined: false, why: "native record exceeds acquisition budget" });
  expect(cache.counters.payloadBytes).toBeLessThanOrEqual(4 * 1024 * 1024 + 64);
  const bytes = cache.counters.payloadBytes;
  await cache.acquire(input);
  expect(cache.counters.payloadBytes).toBe(bytes);
});

test("a persisted unanchored tail stays uncertain on an appended terminal after restart", async () => {
  const file = fixture(), cache = new AgentTranscriptCache();
  oversizedTranscript(file, "codex", [{ type: "response_item", payload: { type: "function_call", call_id: "fixture-call" } }]);
  const input = { engine: "codex" as const, path: file, revision: "persisted-tail", localRef: null, observedAt: FIXTURE_NOW };
  const first = await cache.acquire(input);
  expect(first.turn).toMatchObject({ determined: true, value: { state: "open", nativeId: null } });
  const restarted = new AgentTranscriptCache();
  restarted.seed(input, JSON.parse(JSON.stringify(first)));
  expect((await restarted.acquire(input)).turn).toMatchObject({ determined: true, value: { state: "open" } });
  expect(restarted.counters.payloadBytes).toBe(0);
  fs.appendFileSync(file, encode(fixtureRecords("codex").close));
  expect((await restarted.acquire(input)).turn).toMatchObject({ determined: false, why: "native record exceeds acquisition budget" });
});

test.each(["codex"] as const)("%s: cached tail cannot close a different local turn", async engine => {
  const file = fixture(), cache = new AgentTranscriptCache();
  oversizedTranscript(file, engine, fixtureRecords(engine).close);
  const input = { engine, path: file, revision: "changed-local-reference", localRef: null, observedAt: FIXTURE_NOW };
  expect((await cache.acquire(input)).turn).toMatchObject({ determined: false, why: "native record exceeds acquisition budget" });
  expect((await cache.acquire({ ...input, localRef: "later-local-turn" })).turn).toMatchObject({ determined: false });
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
  const result = await cache.acquire(input);
  expect(result.turn).toMatchObject({ determined: true, value: { state: "closed", tools: 0 } });
  expect(cache.counters.payloadBytes).toBeLessThanOrEqual(4 * 1024 * 1024 + 64);
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

// The acquisition budget is 4 MiB. Each transcript below holds a record larger
// than that between its opening and its newest records, and history before the
// opening, so the opening can only be reached by reading most of the file.
const OVERSIZED = 5 * 1024 * 1024;
const BUDGET = 4 * 1024 * 1024;
function oversizedTranscript(file: string, engine: "codex" | "claude", tail: unknown[], options: { history?: number } = {}) {
  const rows = fixtureRecords(engine);
  const history = encode([{ type: "metadata", padding: "h".repeat(64 * 1024) }]).repeat(options.history ?? 160);
  fs.writeFileSync(file, history + encode(rows.open) + encode([{ type: "metadata", padding: "x".repeat(OVERSIZED) }]) + (tail.length ? encode(tail) : ""));
  return fs.statSync(file).size;
}


for (const [engine, localRef] of [["codex", null], ["codex", FIXTURE_TURN]] as const) {
  test(`${engine}: a terminal beyond the acquisition budget needs its opening (localRef ${localRef ? "set" : "null"})`, async () => {
    const file = fixture(), cache = new AgentTranscriptCache();
    const size = oversizedTranscript(file, engine, fixtureRecords(engine).close);
    expect(size).toBeGreaterThan(3 * BUDGET);
    const input = { engine, path: file, revision: "oversize-closed", localRef, observedAt: FIXTURE_NOW };
    const result = await cache.acquire(input);
    expect(result.turn).toMatchObject({ determined: false, why: "native record exceeds acquisition budget" });
    // One bounded tail pass: no more than one acquisition budget plus the
    // 64-byte overlap edge, whatever the file's size.
    expect(cache.counters.payloadBytes).toBeLessThanOrEqual(BUDGET + 64);
    expect(result.transcript).toMatchObject({ determined: true, value: { size } });
    const bytes = cache.counters.payloadBytes;
    expect((await cache.acquire(input)).turn).toMatchObject({ determined: false, why: "native record exceeds acquisition budget" });
    expect(cache.counters.payloadBytes).toBe(bytes);
  }, 20_000);
}

test("codex: the tail cost stays one budget as the history before the opening grows", async () => {
  const costs: number[] = [];
  for (const history of [16, 480]) {
    const file = fixture(), cache = new AgentTranscriptCache();
    oversizedTranscript(file, "codex", fixtureRecords("codex").close, { history });
    const result = await cache.acquire({ engine: "codex", path: file, revision: `history-${history}`, localRef: null, observedAt: FIXTURE_NOW });
    expect(result.turn).toMatchObject({ determined: false, why: "native record exceeds acquisition budget" });
    costs.push(cache.counters.payloadBytes);
  }
  expect(costs[1]).toBe(costs[0]!);
}, 30_000);

test("codex: work after a record beyond the budget with no terminal reads as an open turn of unknown native id", async () => {
  const file = fixture(), cache = new AgentTranscriptCache();
  oversizedTranscript(file, "codex", [{ type: "response_item", timestamp: "2026-10-10T12:00:00.500Z", payload: { type: "custom_tool_call", call_id: "fixture-call" } }]);
  const result = await cache.acquire({ engine: "codex", path: file, revision: "oversize-open", localRef: null, observedAt: FIXTURE_NOW });
  expect(result.turn).toMatchObject({ determined: true, value: { state: "open", nativeId: null, opening: null, closing: null, tools: 1 } });
}, 20_000);



const ambiguousTails: [string, "codex" | "claude", unknown[], string | null][] = [
  ["codex terminal for a turn other than the local reference", "codex",
    [{ type: "event_msg", timestamp: "2026-10-10T12:00:01.000Z", payload: { type: "task_complete", turn_id: "older-native-turn" } }], FIXTURE_TURN],
  ["codex terminal without a native id", "codex", [{ type: "event_msg", timestamp: "2026-10-10T12:00:01.000Z", payload: { type: "task_complete" } }], null],
  ["codex tool call after the terminal", "codex", [...fixtureRecords("codex").close,
    { type: "response_item", timestamp: "2026-10-10T12:00:02.000Z", payload: { type: "function_call", call_id: "late-call" } }], null],
  ["codex unnamed user echo before the terminal", "codex", [{ type: "event_msg", payload: { type: "user_message", message: "fixture" } },
    ...fixtureRecords("codex").close], null],
  ["the oversized record is the newest record", "codex", [], null],
];
for (const [name, engine, tail, localRef] of ambiguousTails) test(`a tail that cannot settle the turn stays explicitly unknown: ${name}`, async () => {
  const file = fixture(), cache = new AgentTranscriptCache();
  oversizedTranscript(file, engine, tail);
  const input = { engine, path: file, revision: "oversize-ambiguous", localRef, observedAt: FIXTURE_NOW };
  const result = await cache.acquire(input);
  expect(result.turn).toMatchObject({ determined: false, why: "native record exceeds acquisition budget" });
  expect(cache.counters.payloadBytes).toBeLessThanOrEqual(BUDGET + 64);
  const bytes = cache.counters.payloadBytes;
  expect((await cache.acquire(input)).turn.determined).toBe(false);
  expect(cache.counters.payloadBytes).toBe(bytes);
}, 20_000);

test.each(["codex", "claude"] as const)("%s: corrupt oversized tails retain an invalid-evidence refusal", async engine => {
  const file = fixture();
  oversizedTranscript(file, engine, fixtureRecords(engine).close);
  const size = fs.statSync(file).size;
  const input = { engine, path: file, revision: "invalid-tail", localRef: null, observedAt: FIXTURE_NOW };
  for (const suffix of [Buffer.from('{"type":\n'), Buffer.from([0xff, 10])]) {
    fs.truncateSync(file, size);
    fs.appendFileSync(file, suffix);
    expect((await new AgentTranscriptCache().acquire(input)).turn).toMatchObject({ determined: false, why: "native transcript unreadable or invalid" });
  }
});

test("an append after a tail-read turn rereads the tail instead of folding onto it", async () => {
  const file = fixture(), cache = new AgentTranscriptCache();
  oversizedTranscript(file, "codex", [{ type: "response_item", payload: { type: "custom_tool_call", call_id: "fixture-call" } }]);
  const first = await cache.acquire({ engine: "codex", path: file, revision: "append-1", localRef: null, observedAt: FIXTURE_NOW });
  expect(first.turn).toMatchObject({ determined: true, value: { state: "open", nativeId: null } });
  fs.appendFileSync(file, encode([{ type: "response_item", payload: { type: "custom_tool_call_output", call_id: "fixture-call" } },
    { type: "event_msg", timestamp: "2026-10-10T12:00:02.000Z", payload: { type: "task_complete", turn_id: FIXTURE_TURN } }]));
  const second = await cache.acquire({ engine: "codex", path: file, revision: "append-1", localRef: null, observedAt: FIXTURE_NOW });
  expect(second.turn).toMatchObject({ determined: false, why: "native record exceeds acquisition budget" });
}, 20_000);

// A local reference can still name A while the latest native opening is B.
for (const [engine, localRef] of [["codex", null], ["codex", "old-turn"]] as const) {
  test(`${engine}: a stale terminal cannot close an unseen newer opening (localRef ${localRef})`, async () => {
    const file = fixture();
    const opening = (id: string) => ({ type: "event_msg", payload: { type: "task_started", turn_id: id } });
    const terminal = { type: "event_msg", payload: { type: "task_complete", turn_id: "old-turn" } };
    for (const padding of [100, OVERSIZED]) {
      fs.writeFileSync(file, encode([opening("old-turn"), opening("new-turn"), { type: "metadata", padding: "x".repeat(padding) }, terminal]));
      const input = { engine, path: file, revision: "hidden-opening", localRef, observedAt: FIXTURE_NOW };
      const cache = new AgentTranscriptCache();
      const result = await cache.acquire(input);
      expect(result.turn).toMatchObject(padding === 100
        ? { determined: true, value: { state: "open", nativeId: "new-turn" } }
        : { determined: false, why: "native record exceeds acquisition budget" });
      expect(cache.counters.payloadBytes).toBeLessThanOrEqual(BUDGET + 64);
      // Native recovery after a fresh process cannot reuse the stale terminal.
      expect((await new AgentTranscriptCache().acquire(input)).turn).toEqual(result.turn);
    }
  });
}

test.each(["codex", "claude"] as const)("%s: a latest opening in the bounded tail permits closure of an oversized transcript", async engine => {
  const file = fixture(), cache = new AgentTranscriptCache(), rows = fixtureRecords(engine);
  oversizedTranscript(file, engine, [...rows.open, ...rows.close]);
  const input = { engine, path: file, revision: "anchored-tail", localRef: null, observedAt: FIXTURE_NOW };
  expect((await cache.acquire(input)).turn).toMatchObject({ determined: true, value: { state: "closed", nativeId: engine === "codex" ? FIXTURE_TURN : "native-prompt-one" } });
  expect(cache.counters.payloadBytes).toBeLessThanOrEqual(BUDGET + 64);
});

test.each(["codex", "claude"] as const)("%s: a legacy persisted closure without an opening is reacquired", async engine => {
  const file = fixture(), rows = fixtureRecords(engine);
  fs.writeFileSync(file, encode([...rows.open, ...rows.close]));
  const input = { engine, path: file, revision: "legacy-tail", localRef: null, observedAt: FIXTURE_NOW };
  const first = await new AgentTranscriptCache().acquire(input);
  if (!first.turn.determined) throw new Error("fixture must close");
  const legacy = JSON.parse(JSON.stringify(first));
  legacy.turn.value.opening = null;
  legacy.turn.value.nativeId = engine === "codex" ? FIXTURE_TURN : null;
  const restarted = new AgentTranscriptCache();
  restarted.seed(input, legacy);
  const result = await restarted.acquire(input);
  expect(result.turn).toMatchObject({ determined: true, value: { state: "closed", opening: engine === "codex" ? "task_started" : "user" } });
  expect(restarted.counters.payloadBytes).toBeGreaterThan(0);
});
