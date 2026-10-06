import { afterAll, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import { beginCodexPromptDispatch, confirmCodexPromptDispatch, codexAutomaticPromptRows, recordCodexPromptDispatchTurn, restoreCodexPromptDispatch } from "./codexMessageProvenance";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-native-provenance-"));
afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));
const prompt = { type: "event_msg", timestamp: "2026-10-05T16:01:00Z", payload: { type: "user_message", message: "native delivered text" } };
const row = JSON.stringify(prompt) + "\n";

test.each(["", "x", "🌍"])("native provenance joins a truncated suffix through a multibyte leading record %s", async suffix => {
  const file = path.join(directory, "unicode-prefix.jsonl");
  fs.writeFileSync(file, JSON.stringify({ payload: { type: "tool_output", text: "ї".repeat(200_000) + suffix } }) + "\n");
  const dispatch = beginCodexPromptDispatch(file, prompt.payload.message, "unicode-send", { kind: "agent", role: "pipeline" });
  fs.appendFileSync(file, row);
  await confirmCodexPromptDispatch(dispatch, "unicode-turn");
  expect([...codexAutomaticPromptRows(file, [prompt])]).toEqual([0]);
});

test("a native transcript replacement cannot inherit an earlier delivery", async () => {
  const file = path.join(directory, "replaced.jsonl");
  fs.writeFileSync(file, "");
  const dispatch = beginCodexPromptDispatch(file, prompt.payload.message, "replaced-send", { kind: "agent", role: "pipeline" });
  fs.appendFileSync(file, row);
  await confirmCodexPromptDispatch(dispatch, "replaced-turn");
  expect([...codexAutomaticPromptRows(file, [prompt])]).toEqual([0]);
  fs.renameSync(file, path.join(directory, "previous.jsonl"));
  fs.writeFileSync(file, row);
  expect([...codexAutomaticPromptRows(file, [prompt])]).toEqual([]);
});

test("duplicate native families make the whole confirmation window ambiguous", async () => {
  const file = path.join(directory, "repeated.jsonl");
  fs.writeFileSync(file, "");
  const dispatch = beginCodexPromptDispatch(file, prompt.payload.message, "repeated-send", { kind: "agent", role: "pipeline" });
  fs.appendFileSync(file, row.repeat(2));
  await confirmCodexPromptDispatch(dispatch, "repeated-turn");
  expect([...codexAutomaticPromptRows(file, [prompt, prompt])]).toEqual([]);
  expect([...codexAutomaticPromptRows(file, [prompt])]).toEqual([]);
});

test("a different native turn or intervening human prompt closes the dispatch fence", async () => {
  for (const first of [
    { ...prompt, payload: { ...prompt.payload, turn_id: "other-turn" } },
    { ...prompt, payload: { ...prompt.payload, message: "Human intervened" } },
  ]) {
    const file = path.join(directory, `mismatch-${first.payload.message.length}.jsonl`);
    fs.writeFileSync(file, "");
    const dispatch = beginCodexPromptDispatch(file, prompt.payload.message, "mismatch-send", { kind: "agent", role: "pipeline" });
    fs.appendFileSync(file, JSON.stringify(first) + "\n" + row);
    await confirmCodexPromptDispatch(dispatch, "delivery-turn");
    expect([...codexAutomaticPromptRows(file, [first, prompt])]).toEqual([]);
  }
});

test("an operator admission never receives automatic authority from the same text", async () => {
  const file = path.join(directory, "operator.jsonl");
  fs.writeFileSync(file, "");
  const dispatch = beginCodexPromptDispatch(file, prompt.payload.message, "operator-send", { kind: "operator" });
  fs.appendFileSync(file, row);
  await confirmCodexPromptDispatch(dispatch, "operator-turn");
  expect([...codexAutomaticPromptRows(file, [prompt])]).toEqual([]);
});


test("a different native turn after an idless copy cannot lend it delivery authority", async () => {
  const file = path.join(directory, "copy-before-next-turn.jsonl");
  fs.writeFileSync(file, "");
  const dispatch = beginCodexPromptDispatch(file, prompt.payload.message, "concurrent-copy", { kind: "agent", role: "pipeline" });
  const copy = { type: "response_item", timestamp: prompt.timestamp,
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: prompt.payload.message }] } };
  const nextTurn = { payload: { type: "task_started", turn_id: "human-turn" } };
  fs.appendFileSync(file, row + JSON.stringify(copy) + "\n" + JSON.stringify(nextTurn) + "\n");
  await confirmCodexPromptDispatch(dispatch, "automatic-turn");
  expect(codexAutomaticPromptRows(file, [prompt, copy, nextTurn]).has(1)).toBe(false);
});

for (const form of ["UserMessage", "userMessage"] as const) {
  test(`confirmed response preserves delayed identified ${form} across interleaved context and reload`, async () => {
    const file = path.join(directory, `delayed-${form}.jsonl`);
    const response = { type: "response_item", timestamp: prompt.timestamp,
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: prompt.payload.message }] } };
    const context = { type: "turn_context", payload: { turn_id: "delivery-turn", model: "fixture-model" } };
    const item = { type: "event_msg", timestamp: prompt.timestamp, payload: { type: "item_completed", turn_id: "delivery-turn",
      item: { type: form, id: "delivery-item", client_id: "admitted-client", content: [{ type: "text", text: prompt.payload.message }] } } };
    fs.writeFileSync(file, "");
    const dispatch = beginCodexPromptDispatch(file, prompt.payload.message, "admitted-client", { kind: "agent", role: "pipeline" });
    fs.appendFileSync(file, JSON.stringify(response) + "\n");
    await confirmCodexPromptDispatch(dispatch, "delivery-turn");
    expect([...codexAutomaticPromptRows(file, [response])]).toEqual([0]);
    fs.appendFileSync(file, [context, item].map(value => JSON.stringify(value) + "\n").join(""));
    expect([...codexAutomaticPromptRows(file, [response, context, item])]).toEqual([0, 2]);
    // Reading only a verified suffix still uses durable delivery evidence.
    expect([...codexAutomaticPromptRows(file, [item])]).toEqual([0]);
    const human = { ...item, payload: { ...item.payload, item: { ...item.payload.item, client_id: "human-client" } } };
    fs.appendFileSync(file, JSON.stringify(human) + "\n" + JSON.stringify(item) + "\n");
    expect([...codexAutomaticPromptRows(file, [response, context, item, human, item])]).toEqual([0, 2]);
  });
}

for (const changedAfterExtension of [false, true]) {
  test(`rewritten confirmation anchor cannot authorize delayed rows (${changedAfterExtension ? "after" : "before"} extension)`, async () => {
    const file = path.join(directory, `rewritten-anchor-${changedAfterExtension}.jsonl`);
    fs.writeFileSync(file, "");
    const dispatch = beginCodexPromptDispatch(file, prompt.payload.message, "anchor-client", { kind: "agent", role: "pipeline" });
    fs.appendFileSync(file, row);
    await confirmCodexPromptDispatch(dispatch, "anchor-turn");
    const item = { payload: { type: "item_completed", turn_id: "anchor-turn",
      item: { type: "UserMessage", client_id: "anchor-client", content: [{ type: "text", text: prompt.payload.message }] } } };
    fs.appendFileSync(file, JSON.stringify(item) + "\n");
    if (changedAfterExtension) expect([...codexAutomaticPromptRows(file, [prompt, item])]).toEqual([0, 1]);
    // Preserve inode, byte count and delayed row position while replacing the anchor.
    const changed = { ...prompt, payload: { ...prompt.payload, message: "human! delivered text" } };
    const changedRow = JSON.stringify(changed) + "\n";
    expect(Buffer.byteLength(changedRow)).toBe(Buffer.byteLength(row));
    const fd = fs.openSync(file, "r+");
    try { fs.writeSync(fd, changedRow, 0, "utf8"); } finally { fs.closeSync(fd); }
    expect([...codexAutomaticPromptRows(file, [changed, item])]).toEqual([]);
  });
}

for (const variant of ["idless", "client-only", "turn-only", "human-client", "other-turn", "other-text", "conflicting-client", "conflicting-turn"] as const) {
  test(`delayed ${variant} copy cannot inherit confirmed transport authority`, async () => {
    const file = path.join(directory, `negative-${variant}.jsonl`);
    fs.writeFileSync(file, "");
    const dispatch = beginCodexPromptDispatch(file, prompt.payload.message, "negative-client", { kind: "agent", role: "pipeline" });
    fs.appendFileSync(file, row);
    await confirmCodexPromptDispatch(dispatch, "negative-turn");
    const item = { payload: { type: "item_completed",
      ...(variant === "idless" || variant === "client-only" ? {} : { turnId: variant === "other-turn" || variant === "conflicting-turn" ? "human-turn" : "negative-turn" }),
      ...(variant === "conflicting-turn" ? { turn_id: "negative-turn" } : {}),
      item: { type: "userMessage", id: "native-item",
        ...(variant === "conflicting-client" ? { client_id: "human-client" } : {}),
        ...(variant === "idless" || variant === "turn-only" ? {} : { clientId: variant === "human-client" ? "human-client" : "negative-client" }),
        content: [{ type: "text", text: variant === "other-text" ? "human changed the text" : prompt.payload.message }] } } };
    const context = { type: "turn_context", payload: { turn_id: "negative-turn" } };
    fs.appendFileSync(file, [context, item].map(value => JSON.stringify(value) + "\n").join(""));
    expect([...codexAutomaticPromptRows(file, [prompt, context, item])]).toEqual([0]);
  });
}

test("an ambiguous idless dispatch cannot seed delayed identified authority", async () => {
  const file = path.join(directory, "ambiguous-anchor.jsonl");
  fs.writeFileSync(file, "");
  const dispatch = beginCodexPromptDispatch(file, prompt.payload.message, "ambiguous-client", { kind: "agent", role: "pipeline" });
  const next = { payload: { type: "task_started", turn_id: "human-turn" } };
  fs.appendFileSync(file, row + JSON.stringify(next) + "\n");
  await confirmCodexPromptDispatch(dispatch, "automatic-turn");
  const item = { payload: { type: "item_completed", turn_id: "automatic-turn",
    item: { type: "UserMessage", client_id: "ambiguous-client", content: [{ type: "text", text: prompt.payload.message }] } } };
  fs.appendFileSync(file, JSON.stringify(item) + "\n");
  expect([...codexAutomaticPromptRows(file, [prompt, next, item])]).toEqual([]);
});

test("identified interleaved items already flushed at confirmation join the same physical proof", async () => {
  const file = path.join(directory, "interleaved-flush.jsonl");
  fs.writeFileSync(file, "");
  const dispatch = beginCodexPromptDispatch(file, prompt.payload.message, "interleaved-client", { kind: "agent", role: "pipeline" });
  const context = { type: "turn_context", payload: { turn_id: "interleaved-turn", text: "ї🌍" } };
  const item = { payload: { type: "item_completed", turn_id: "interleaved-turn",
    item: { type: "UserMessage", client_id: "interleaved-client", content: [{ type: "text", text: prompt.payload.message }] } } };
  fs.appendFileSync(file, [prompt, context, item].map(value => JSON.stringify(value) + "\n").join(""));
  await confirmCodexPromptDispatch(dispatch, "interleaved-turn");
  expect([...codexAutomaticPromptRows(file, [prompt, context, item])]).toEqual([0, 2]);
});

test("a raced append cannot persist delayed authority against a stale scanner suffix", async () => {
  const file = path.join(directory, "raced-extension.jsonl");
  fs.writeFileSync(file, "");
  const dispatch = beginCodexPromptDispatch(file, prompt.payload.message, "race-client", { kind: "agent", role: "pipeline" });
  fs.appendFileSync(file, row);
  await confirmCodexPromptDispatch(dispatch, "race-turn");
  const item = { payload: { type: "item_completed", turn_id: "race-turn",
    item: { type: "UserMessage", client_id: "race-client", content: [{ type: "text", text: prompt.payload.message }] } } };
  fs.appendFileSync(file, JSON.stringify(item) + "\n");
  const originalRead = fs.readSync.bind(fs);
  let raced = false;
  const read = spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
    const result = originalRead(...args);
    if (!raced) { raced = true; fs.appendFileSync(file, row); }
    return result;
  }) as typeof fs.readSync);
  try { expect([...codexAutomaticPromptRows(file, [prompt, item])]).toEqual([]); }
  finally { read.mockRestore(); }
  expect([...codexAutomaticPromptRows(file, [prompt, item, prompt])]).toEqual([0, 1]);
});


test("an append during durable extension persistence refuses the stale scanner join", async () => {
  const file = path.join(directory, "raced-ledger-persistence.jsonl");
  fs.writeFileSync(file, "");
  const dispatch = beginCodexPromptDispatch(file, prompt.payload.message, "persist-client", { kind: "agent", role: "pipeline" });
  fs.appendFileSync(file, row);
  await confirmCodexPromptDispatch(dispatch, "persist-turn");
  const item = { payload: { type: "item_completed", turn_id: "persist-turn",
    item: { type: "UserMessage", client_id: "persist-client", content: [{ type: "text", text: prompt.payload.message }] } } };
  fs.appendFileSync(file, JSON.stringify(item) + "\n");
  const originalWrite = fs.writeSync.bind(fs);
  let raced = false;
  const write = spyOn(fs, "writeSync").mockImplementation(((...args: Parameters<typeof fs.writeSync>) => {
    const result = originalWrite(...args);
    if (!raced) { raced = true; fs.appendFileSync(file, row); }
    return result;
  }) as typeof fs.writeSync);
  try { expect([...codexAutomaticPromptRows(file, [prompt, item])]).toEqual([]); }
  finally { write.mockRestore(); }
  expect(raced).toBe(true);
  expect([...codexAutomaticPromptRows(file, [prompt, item, prompt])]).toEqual([0, 1]);
});


test("interleaved context cannot hide a conflicting native start in the confirmation window", async () => {
  const file = path.join(directory, "interleaved-conflict.jsonl");
  fs.writeFileSync(file, "");
  const dispatch = beginCodexPromptDispatch(file, prompt.payload.message, "context-client", { kind: "agent", role: "pipeline" });
  const context = { type: "turn_context", payload: { model: "fixture" } };
  const foreign = { type: "event_msg", payload: { type: "task_started", turn_id: "human-turn" } };
  fs.appendFileSync(file, [prompt, context, foreign].map(value => JSON.stringify(value) + "\n").join(""));
  await confirmCodexPromptDispatch(dispatch, "automatic-turn");
  expect([...codexAutomaticPromptRows(file, [prompt, context, foreign])]).toEqual([]);
});


test("confirmation persists pending transport before a writer delayed over one second and cold reopen", async () => {
  const file = path.join(directory, "pending-cold-reopen.jsonl");
  fs.writeFileSync(file, "");
  const dispatch = beginCodexPromptDispatch(file, prompt.payload.message, "pending-client", { kind: "agent", role: "pipeline" });
  const start = performance.now();
  const confirmation = confirmCodexPromptDispatch(dispatch, "pending-turn");
  const ledgerDirectory = path.join(process.env.LLV_STATE_DIR!, "codex-prompt-deliveries");
  // Persistence precedes the first asynchronous wait for the native writer.
  const bindings = fs.existsSync(ledgerDirectory) ? fs.readdirSync(ledgerDirectory)
    .flatMap(name => fs.readFileSync(path.join(ledgerDirectory, name), "utf8").trim().split("\n").map(line => JSON.parse(line))) : [];
  const persistedBeforeWait = bindings.some(binding => binding.clientId === "pending-client" && binding.turnId === "pending-turn");
  await confirmation;
  expect(performance.now() - start).toBeGreaterThanOrEqual(1_000);
  expect(persistedBeforeWait).toBe(true);
  const item = { payload: { type: "item_completed", turn_id: "pending-turn",
    item: { type: "userMessage", clientId: "pending-client", content: [{ type: "text", text: prompt.payload.message }] } } };
  fs.appendFileSync(file, JSON.stringify(item) + "\n");
  const reopened = spawnSync(process.execPath, ["-e", `
    import fs from "node:fs";
    import { codexAutomaticPromptRows } from ${JSON.stringify(path.resolve("src/lib/runtime/codexMessageProvenance.ts"))};
    const records = fs.readFileSync(process.argv[1], "utf8").trim().split("\\n").map(JSON.parse);
    console.log(JSON.stringify([...codexAutomaticPromptRows(process.argv[1], records)]));
  `, file], { env: process.env, encoding: "utf8" });
  expect(reopened.status).toBe(0);
  expect(JSON.parse(reopened.stdout)).toEqual([0]);
  expect([...codexAutomaticPromptRows(file, [item])]).toEqual([0]);
});


for (const conflict of ["duplicate-family", "client-alias", "turn-alias", "item-turn", "start-turn-alias"] as const) {
  test(`interleaved ${conflict} cannot authenticate an earlier prompt or a later copy`, async () => {
    const file = path.join(directory, `full-window-${conflict}.jsonl`);
    fs.writeFileSync(file, "");
    const dispatch = beginCodexPromptDispatch(file, prompt.payload.message, "window-client", { kind: "agent", role: "pipeline" });
    const context = { type: "turn_context", payload: { model: "fixture" } };
    const item = { payload: { type: "item_completed", turn_id: "window-turn", item: {
      type: "UserMessage", client_id: "window-client", content: [{ type: "text", text: prompt.payload.message }],
      ...(conflict === "item-turn" ? { turnId: "human-turn" } : {}),
      ...(conflict === "client-alias" ? { clientId: "human-client" } : {}),
    }, ...(conflict === "turn-alias" ? { turnId: "human-turn" } : {}) } };
    const contradictory = conflict === "duplicate-family" ? prompt : conflict === "start-turn-alias"
      ? { payload: { type: "task_started", turn_id: "window-turn", turnId: "human-turn" } } : item;
    const records = [prompt, context, contradictory];
    fs.appendFileSync(file, records.map(value => JSON.stringify(value) + "\n").join(""));
    await confirmCodexPromptDispatch(dispatch, "window-turn");
    const later = { payload: { type: "item_completed", turn_id: "window-turn", item: {
      type: "UserMessage", client_id: "window-client", content: [{ type: "text", text: prompt.payload.message }],
    } } };
    records.push(later);
    fs.appendFileSync(file, JSON.stringify(later) + "\n");
    expect([...codexAutomaticPromptRows(file, records)]).toEqual([]);
  });
}

test("a pending empty binding leaves exact human and idless copies external", async () => {
  const file = path.join(directory, "pending-human.jsonl");
  fs.writeFileSync(file, "");
  const dispatch = beginCodexPromptDispatch(file, prompt.payload.message, "pending-human-auto", { kind: "agent", role: "pipeline" });
  await confirmCodexPromptDispatch(dispatch, "pending-human-turn");
  const item = (clientId: string) => ({ payload: { type: "item_completed", turn_id: "pending-human-turn",
    item: { type: "UserMessage", clientId, content: [{ type: "text", text: prompt.payload.message }] } } });
  const human = item("actual-human-client");
  fs.appendFileSync(file, [prompt, human].map(value => JSON.stringify(value) + "\n").join(""));
  expect([...codexAutomaticPromptRows(file, [prompt, human])]).toEqual([]);
  const delivered = item("pending-human-auto");
  fs.appendFileSync(file, JSON.stringify(delivered) + "\n");
  expect([...codexAutomaticPromptRows(file, [prompt, human, delivered])]).toEqual([2]);
  fs.appendFileSync(file, JSON.stringify(delivered) + "\n");
  expect([...codexAutomaticPromptRows(file, [prompt, human, delivered, delivered])]).toEqual([2]);
});

test("duplicate delayed families cannot pick a first copy or seed a later copy", async () => {
  const file = path.join(directory, "duplicate-delayed.jsonl");
  fs.writeFileSync(file, "");
  const dispatch = beginCodexPromptDispatch(file, prompt.payload.message, "duplicate-client", { kind: "agent", role: "pipeline" });
  fs.appendFileSync(file, row);
  await confirmCodexPromptDispatch(dispatch, "duplicate-turn");
  const item = { payload: { type: "item_completed", turn_id: "duplicate-turn",
    item: { type: "UserMessage", clientId: "duplicate-client", content: [{ type: "text", text: prompt.payload.message }] } } };
  const response = { payload: { type: "message", role: "user", turn_id: "duplicate-turn", client_id: "duplicate-client", content: prompt.payload.message } };
  fs.appendFileSync(file, [item, item, response].map(value => JSON.stringify(value) + "\n").join(""));
  expect([...codexAutomaticPromptRows(file, [prompt, item, item, response])]).toEqual([0, 3]);
  fs.appendFileSync(file, JSON.stringify(item) + "\n");
  expect([...codexAutomaticPromptRows(file, [item])]).toEqual([]);
});


for (const pending of [false, true]) {
  test(`wrong admitted content cannot seed a later native copy (${pending ? "pending" : "anchored"})`, async () => {
    const file = path.join(directory, `wrong-content-${pending}.jsonl`);
    fs.writeFileSync(file, "");
    const dispatch = beginCodexPromptDispatch(file, prompt.payload.message, "content-client", { kind: "agent", role: "pipeline" });
    if (!pending) fs.appendFileSync(file, row);
    await confirmCodexPromptDispatch(dispatch, "content-turn");
    const item = (text: string) => ({ payload: { type: "item_completed", turn_id: "content-turn",
      item: { type: "UserMessage", clientId: "content-client", content: [{ type: "text", text }] } } });
    const wrong = item("unadmitted content");
    const copy = item(prompt.payload.message);
    fs.appendFileSync(file, [wrong, copy].map(value => JSON.stringify(value) + "\n").join(""));
    expect([...codexAutomaticPromptRows(file, [wrong, copy])]).toEqual([]);
  });
}


test("a vanished opened transcript cannot become an unbound dispatch", () => {
  const file = path.join(directory, "vanished-boundary.jsonl");
  fs.writeFileSync(file, row);
  const originalStat = fs.statSync.bind(fs);
  const stat = spyOn(fs, "statSync").mockImplementation(((filename: fs.PathLike, ...args: unknown[]) => {
    if (filename === file) throw Object.assign(new Error("fixture disappeared"), { code: "ENOENT" });
    return Reflect.apply(originalStat, fs, [filename, ...args]);
  }) as typeof fs.statSync);
  try { expect(beginCodexPromptDispatch(file, prompt.payload.message, "vanished-client", { kind: "agent", role: "pipeline" })).toBeNull(); }
  finally { stat.mockRestore(); }
});

test("a missing dispatch file becomes bound when context appears during the confirmation wait", async () => {
  const file = path.join(directory, "created-then-replaced.jsonl");
  const dispatch = beginCodexPromptDispatch(file, prompt.payload.message, "created-client", { kind: "agent", role: "pipeline" });
  const context = { type: "turn_context", payload: { model: "fixture" } };
  const confirmation = confirmCodexPromptDispatch(dispatch, "created-turn");
  fs.writeFileSync(file, JSON.stringify(context) + "\n");
  await confirmation;
  fs.renameSync(file, file + ".previous");
  const item = { payload: { type: "item_completed", turn_id: "created-turn",
    item: { type: "UserMessage", clientId: "created-client", content: [{ type: "text", text: prompt.payload.message }] } } };
  fs.writeFileSync(file, JSON.stringify(item) + "\n");
  expect([...codexAutomaticPromptRows(file, [item])]).toEqual([]);
});


for (const alteration of ["replacement", "prefix-rewrite"] as const) {
  test(`pending transport cannot cross a ${alteration} of its dispatch file`, async () => {
    const file = path.join(directory, `pending-file-${alteration}.jsonl`);
    const before = { payload: { type: "tool_output", text: "existing boundary" } };
    const beforeRow = JSON.stringify(before) + "\n";
    fs.writeFileSync(file, beforeRow);
    const dispatch = beginCodexPromptDispatch(file, prompt.payload.message, "fenced-client", { kind: "agent", role: "pipeline" });
    await confirmCodexPromptDispatch(dispatch, "fenced-turn");
    const item = { payload: { type: "item_completed", turn_id: "fenced-turn",
      item: { type: "UserMessage", client_id: "fenced-client", content: [{ type: "text", text: prompt.payload.message }] } } };
    const changed = alteration === "replacement" ? before : { payload: { ...before.payload, text: "rewritten prefix!" } };
    expect(Buffer.byteLength(JSON.stringify(changed) + "\n")).toBe(Buffer.byteLength(beforeRow));
    if (alteration === "replacement") fs.renameSync(file, file + ".previous");
    fs.writeFileSync(file, [changed, item].map(value => JSON.stringify(value) + "\n").join(""));
    expect([...codexAutomaticPromptRows(file, [changed, item])]).toEqual([]);
  });
}

for (const version of [1, 2] as const) {
  test(`legacy version ${version} keeps exact anchors and its safe delayed-join behavior`, async () => {
    const file = path.join(directory, `legacy-${version}.jsonl`);
    fs.writeFileSync(file, "");
    const dispatch = beginCodexPromptDispatch(file, prompt.payload.message, "legacy-client", { kind: "agent", role: "pipeline" });
    fs.appendFileSync(file, row);
    await confirmCodexPromptDispatch(dispatch, "legacy-turn");
    const ledger = path.join(process.env.LLV_STATE_DIR!, "codex-prompt-deliveries",
      createHash("sha256").update(path.resolve(file)).digest("hex") + ".jsonl");
    const proof = JSON.parse(fs.readFileSync(ledger, "utf8").trim().split("\n").at(-1)!);
    const legacy = { version, fileIdentity: proof.fileIdentity, turnId: proof.turnId, rows: proof.rows,
      ...(version === 2 ? { clientId: proof.clientId, scanOffset: proof.scanOffset } : {}) };
    fs.writeFileSync(ledger, JSON.stringify(legacy) + "\n");
    expect([...codexAutomaticPromptRows(file, [prompt])]).toEqual([0]);
    const item = { payload: { type: "item_completed", turn_id: "legacy-turn",
      item: { type: "userMessage", clientId: "legacy-client", content: [{ type: "text", text: prompt.payload.message }] } } };
    fs.appendFileSync(file, JSON.stringify(item) + "\n");
    expect([...codexAutomaticPromptRows(file, [prompt, item])]).toEqual(version === 2 ? [0, 1] : [0]);
    fs.appendFileSync(file, JSON.stringify(item) + "\n");
    expect([...codexAutomaticPromptRows(file, [item])]).toEqual([]);
  });
}


test("legacy physical proof cannot override contradictory native identity aliases", () => {
  const file = path.join(directory, "legacy-conflicting-identity.jsonl");
  const contradictory = { payload: { type: "user_message", clientId: "legacy-client", client_id: "human-client", message: prompt.payload.message } };
  const line = JSON.stringify(contradictory);
  fs.writeFileSync(file, line + "\n");
  const stat = fs.statSync(file);
  const ledger = path.join(process.env.LLV_STATE_DIR!, "codex-prompt-deliveries",
    createHash("sha256").update(path.resolve(file)).digest("hex") + ".jsonl");
  fs.mkdirSync(path.dirname(ledger), { recursive: true });
  fs.writeFileSync(ledger, JSON.stringify({ version: 1, fileIdentity: `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`,
    turnId: "legacy-turn", rows: [{ offset: 0, length: Buffer.byteLength(line),
      digest: createHash("sha256").update(line).digest("hex") }] }) + "\n");
  expect([...codexAutomaticPromptRows(file, [contradictory])]).toEqual([]);
});


test("admitted dispatch intent survives a process reopen and remains unconfirmed until recovery", async () => {
  const file = path.join(directory, "cold-dispatch-intent.jsonl");
  fs.writeFileSync(file, "");
  const origin = { kind: "agent" as const, role: "startup-recovery" };
  const dispatch = beginCodexPromptDispatch(file, prompt.payload.message, "cold-intent-client", origin);
  recordCodexPromptDispatchTurn(dispatch, "cold-intent-turn");
  fs.appendFileSync(file, row);
  expect([...codexAutomaticPromptRows(file, [prompt])]).toEqual([]);
  expect(restoreCodexPromptDispatch(file, prompt.payload.message, "cold-intent-client", { kind: "operator" })).toBeNull();
  expect(restoreCodexPromptDispatch(file, prompt.payload.message, "cold-intent-client", { ...origin, role: "pipeline" })).toBeNull();
  expect(restoreCodexPromptDispatch(file, "another payload", "cold-intent-client", origin)).toBeNull();
  const reopened = spawnSync(process.execPath, ["-e", `
    import fs from "node:fs";
    import { restoreCodexPromptDispatch, confirmCodexPromptDispatch, codexAutomaticPromptRows }
      from ${JSON.stringify(path.resolve("src/lib/runtime/codexMessageProvenance.ts"))};
    const file = process.argv[1];
    const records = fs.readFileSync(file, "utf8").trim().split("\\n").map(JSON.parse);
    const dispatch = restoreCodexPromptDispatch(file, records[0].payload.message, "cold-intent-client", { kind: "agent", role: "startup-recovery" });
    if (!dispatch || dispatch.nativeTurnId !== "cold-intent-turn") process.exit(2);
    await confirmCodexPromptDispatch(dispatch, dispatch.nativeTurnId);
    console.log(JSON.stringify([...codexAutomaticPromptRows(file, records)]));
  `, file], { env: process.env, encoding: "utf8" });
  expect(reopened.status).toBe(0);
  expect(JSON.parse(reopened.stdout)).toEqual([0]);
  // A receipt retry after a human copy must keep the original frozen positions.
  fs.appendFileSync(file, row);
  await confirmCodexPromptDispatch(restoreCodexPromptDispatch(file, prompt.payload.message, "cold-intent-client", origin), "cold-intent-turn");
  expect([...codexAutomaticPromptRows(file, [prompt, prompt])]).toEqual([0]);
});

test("dispatch intent persistence failure stops admission before the RPC boundary", () => {
  const file = path.join(directory, "failed-intent-persistence.jsonl");
  fs.writeFileSync(file, "");
  const sync = spyOn(fs, "fsyncSync").mockImplementation(() => { throw new Error("intent durability unavailable"); });
  try {
    expect(() => beginCodexPromptDispatch(file, prompt.payload.message, "failed-intent-client", { kind: "agent", role: "pipeline" }))
      .toThrow("intent durability unavailable");
  } finally { sync.mockRestore(); }
  expect([...codexAutomaticPromptRows(file, [prompt])]).toEqual([]);
});

for (const alteration of ["replacement", "prefix-rewrite"] as const) {
  test(`recovered dispatch intent cannot cross a ${alteration}`, async () => {
    const file = path.join(directory, `recovered-boundary-${alteration}.jsonl`);
    const prefix = { payload: { type: "tool_output", text: "old boundary" } };
    fs.writeFileSync(file, JSON.stringify(prefix) + "\n");
    const origin = { kind: "agent" as const, role: "pipeline" };
    const dispatch = beginCodexPromptDispatch(file, prompt.payload.message, "recovered-boundary-client", origin);
    recordCodexPromptDispatchTurn(dispatch, "recovered-boundary-turn");
    if (alteration === "replacement") fs.renameSync(file, file + ".previous");
    const changed = alteration === "replacement" ? prefix : { payload: { ...prefix.payload, text: "new boundary" } };
    fs.writeFileSync(file, JSON.stringify(changed) + "\n" + row);
    await confirmCodexPromptDispatch(restoreCodexPromptDispatch(file, prompt.payload.message, "recovered-boundary-client", origin), "recovered-boundary-turn");
    expect([...codexAutomaticPromptRows(file, [changed, prompt])]).toEqual([]);
  });
}

for (const variant of ["native-client", "idless", "human-client", "client-conflict", "turn-conflict", "changed-text", "foreign-start", "duplicate-family"] as const) {
  test(`split legacy native ${variant} joins only original delivery identity`, async () => {
    const file = path.join(directory, `legacy-split-${variant}.jsonl`);
    const response = { type: "response_item", timestamp: prompt.timestamp,
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: prompt.payload.message }] } };
    fs.writeFileSync(file, "");
    const dispatch = beginCodexPromptDispatch(file, prompt.payload.message, "legacy-split-client", { kind: "agent", role: "pipeline" });
    fs.appendFileSync(file, JSON.stringify(response) + "\n");
    await confirmCodexPromptDispatch(dispatch, "legacy-split-turn");
    // record_user_prompt_and_emit_turn_item assigns the admitted client ID;
    // as_legacy_user_message_event preserves it. Paginated policy omits this
    // event entirely. A delayed idless event cannot represent this send.
    const event = { ...prompt, payload: { ...prompt.payload,
      ...(variant === "idless" ? {} : { client_id: variant === "human-client" ? "other-client" : "legacy-split-client" }),
      ...(variant === "client-conflict" ? { clientId: "other-client" } : {}),
      ...(variant === "turn-conflict" ? { turn_id: "other-turn" } : {}),
      ...(variant === "changed-text" ? { message: "human content" } : {}),
    } };
    const records: Array<Record<string, unknown>> = [response];
    if (variant === "foreign-start") records.push({ payload: { type: "task_started", turn_id: "other-turn" } });
    records.push(event);
    if (variant === "duplicate-family") records.push(event);
    fs.appendFileSync(file, records.slice(1).map(value => JSON.stringify(value) + "\n").join(""));
    expect([...codexAutomaticPromptRows(file, records)]).toEqual(variant === "native-client" ? [0, 1] : [0]);
    const canonicalCopy = { ...prompt, payload: { ...prompt.payload, client_id: "legacy-split-client" } };
    fs.appendFileSync(file, JSON.stringify(canonicalCopy) + "\n");
    expect([...codexAutomaticPromptRows(file, [canonicalCopy])]).toEqual([]);
  });
}


test("confirmed pending legacy client identity survives the bounded wait and a process reopen", async () => {
  const file = path.join(directory, "pending-legacy-process.jsonl");
  fs.writeFileSync(file, "");
  const dispatch = beginCodexPromptDispatch(file, prompt.payload.message, "pending-legacy-client", { kind: "agent", role: "pipeline" });
  // Await the real bounded capture operation; no artificial flush timer.
  await confirmCodexPromptDispatch(dispatch, "pending-legacy-turn");
  const event = { ...prompt, payload: { ...prompt.payload, client_id: "pending-legacy-client" } };
  fs.appendFileSync(file, JSON.stringify(event) + "\n");
  const reopened = spawnSync(process.execPath, ["-e", `
    import fs from "node:fs";
    import { codexAutomaticPromptRows } from ${JSON.stringify(path.resolve("src/lib/runtime/codexMessageProvenance.ts"))};
    const file = process.argv[1];
    const records = fs.readFileSync(file, "utf8").trim().split("\\n").map(JSON.parse);
    console.log(JSON.stringify([...codexAutomaticPromptRows(file, records)]));
  `, file], { env: process.env, encoding: "utf8" });
  expect(reopened.status).toBe(0);
  expect(JSON.parse(reopened.stdout)).toEqual([0]);
  expect([...codexAutomaticPromptRows(file, [event])]).toEqual([0]);
});
