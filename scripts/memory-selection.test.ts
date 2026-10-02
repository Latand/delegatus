import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { CAP_USD, charged, collect, metrics, paidReplay, parseAnswer, queryFor, requestBody,
  confidenceIntervals, sampleOperatorPrompts, machineMessage, nativeMatch, budgetSelect, entryText, offerRows, offerIntervals, contextView, replayText, summarizeVariants, REQUEST_VARIANTS, graphScores, cleanEnvelope, reservation, retrieve, samplePrompts, select, validateLabels, type Case, type Labels, type Message, type Sample } from "./memory-selection";

const roots: string[] = [];
const priorKey = process.env.OPENROUTER_API_KEY;
afterEach(() => {
  if (priorKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = priorKey;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function root() { const p = fs.mkdtempSync(path.join(os.tmpdir(), "memory-replay-test-")); roots.push(p); return p; }
const candidate = (id: string) => ({ id, title: "Socket lifecycle", summary: "Attach an error handler before writing.", body: "Private body must stay local", engine: "claude", kind: "failure", scope: "project", writtenAt: "2026-01-01" });
const c: Case = { id: "p01", prompt: "Investigate failures while writing to a closed socket.", engine: "codex", candidates: [candidate("c1"), candidate("c2"), candidate("c3"), candidate("c4")], retrievalMs: 2, strictCount: 0 };
const sample: Sample = { version: 1, seed: "test", collectedAt: "2026-01-01", counts: {}, cases: [c] };
const labels: Labels = { rule: "A fact changes the next action.", cases: [{ id: "p01", prompt: c.prompt, candidates: c.candidates.map(m => ({ id: m.id, helpful: m.id === "c4", summary: m.summary, reason: "Fixture relevance" })) }] };
const message = (body: string, index = 0, transcript = "one"): Message => ({ body, message_index: index, transcript_path: transcript, engine: "codex", project: "project-a", timestamp: 1 });

test("sampling skips launch metadata, never promotes a later turn and folds copies", () => {
  const result = samplePrompts([
    message("# AGENTS.md instructions", 0), message(c.prompt, 1), message("Later content", 2),
    message("You are a Builder. Implement a long machine generated assignment.", 0, "two"), message(c.prompt, 1, "two"),
    message("<!-- llv:structured-user -->\n" + c.prompt, 0, "copy"),
    message("Short", 0, "short"), message(c.prompt, 1, "short"),
    message("<recommended_plugins>runtime metadata", 0, "three"), message(c.prompt + " Again.", 1, "three"),
  ], 32);
  expect(result.rows.map(r => r.body).sort()).toEqual([c.prompt, c.prompt + " Again."].sort());
  expect(result.counts).toMatchObject({ machine: 1, duplicate: 1, short: 1 });
  expect(samplePrompts([...result.rows].reverse(), 1).rows).toEqual(samplePrompts(result.rows, 1).rows);
});

test("literal FTS syntax is bounded; recall policy is distinct", () => {
  expect(queryFor('socket OR "closed"', "strict")).toBe('"socket" AND "OR" AND "closed"');
  expect(queryFor("please investigate closed socket socket", "recall")).toBe('"investigate" OR "closed" OR "socket"');
  expect(queryFor("!!!", "strict")).toBeNull();
  expect(queryFor(Array(30).fill("word").join(" "), "strict")!.split(" AND ")).toHaveLength(16);
});

test("100-request sampling balances engines then projects and reallocates exhausted strata", () => {
  const messages = Array.from({ length: 150 }, (_, i) => ({
    ...message(`${c.prompt} Unique request ${i}.`, 0, `transcript-${i}`),
    engine: i < 120 ? "codex" : "claude", project: i % 2 ? "project-a" : "project-b",
  }));
  const result = samplePrompts(messages, 100);
  expect(result.rows).toHaveLength(100);
  expect(result.rows.filter(r => r.engine === "claude")).toHaveLength(30);
  expect(result.rows.filter(r => r.engine === "codex" && r.project === "project-a")).toHaveLength(35);
  expect(new Set(result.rows.map(r => r.body)).size).toBe(100);
  expect(samplePrompts([...messages].reverse(), 100)).toEqual(result);
  const limited = samplePrompts(messages, 20);
  for (const engine of ["claude", "codex"]) for (const project of ["project-a", "project-b"])
    expect(limited.rows.filter(r => r.engine === engine && r.project === project)).toHaveLength(5);
  expect(samplePrompts(messages.slice(0, 7), 100).counts).toMatchObject({ requested: 100, sampled: 7 });
  expect(() => samplePrompts(messages, 101)).toThrow();
  const many = Array.from({ length: 100 }, (_, i) => ({ ...c, id: `p${i + 1}` }));
  expect(() => validateLabels({ ...sample, cases: many }, { ...labels,
    cases: many.map(row => ({ ...labels.cases[0], id: row.id })) })).not.toThrow();
});

test("confidence intervals resample prompts together and preserve paired equality", () => {
  const cases = [c, { ...c, id: "p02" }];
  const pairedLabels = { ...labels, cases: [labels.cases[0], { ...labels.cases[0], id: "p02" }] };
  const selection = [["c4"], []];
  const result = confidenceIntervals(cases, pairedLabels, selection, selection);
  expect(result.fts).toEqual([0, 1 / 3]);
  expect(result.jev).toEqual(result.fts);
  expect(result.none).toEqual([0, 0]);
  expect(result.pairedJevMinusFts).toEqual({ estimate: 0, interval: [0, 0] });
  const loss = confidenceIntervals(cases, pairedLabels, [["c4"], ["c4"]], [[], []]);
  expect(loss.pairedJevMinusFts.estimate).toBe(-1 / 3);
  expect(loss.pairedJevMinusFts.interval).toEqual([-1 / 3, -1 / 3]);
  expect(confidenceIntervals(cases, pairedLabels, selection, selection)).toEqual(result);
});

function memoryDb(filename: string) {
  const db = new Database(filename);
  db.exec(`CREATE TABLE memory_entries (id TEXT, title TEXT, summary TEXT, body TEXT, engine TEXT, kind TEXT, scope TEXT, writtenAt TEXT, project TEXT, sourcePath TEXT, sourceKind TEXT);
    CREATE VIRTUAL TABLE memory_fts USING fts5(id UNINDEXED, title, summary, body);`);
  const add = (id: string, engine: string, project: string, kind: string, scope: string, sourceKind: string, sourcePath: string, body: string) => {
    db.query("INSERT INTO memory_entries VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(id, "socket " + id, "socket", body, engine, kind, scope, "2026-01-01", project, sourcePath, sourceKind);
    db.query("INSERT INTO memory_fts VALUES (?,?,?,?)").run(id, "socket " + id, "socket", body);
  };
  add("own", "codex", "project-a", "failure", "project", "codex_memory", "own.md", "socket");
  add("other", "claude", "project-b", "failure", "project", "claude_memory", "other.md", "socket");
  add("instructions", "shared", "", "instruction", "global", "instruction", "AGENTS.md", "socket");
  add("topic", "claude", "project-a", "failure", "project", "claude_memory", "socket.md", "socket");
  add("pointer", "claude", "project-a", "reference", "project", "claude_index", "MEMORY.md", "[socket](socket.md)");
  add("global", "shared", "", "skill", "global", "skill", "SKILL.md", "socket");
  return db;
}

test("FTS scopes, cross-engine exclusion and topic dedup run on the real SQLite schema", () => {
  const db = memoryDb(":memory:");
  try {
    const hits = retrieve(db, message("socket"), "strict");
    expect(hits).toHaveLength(2);
    expect(hits.some(h => h.id === "global")).toBeTrue();
    expect(hits.filter(h => h.id === "topic" || h.id === "pointer")).toHaveLength(1);
  } finally { db.close(); }
});

test("collect opens indexes read-only and leaves bytes unchanged", () => {
  const dir = root(), mp = path.join(dir, "memories.sqlite"), tp = path.join(dir, "transcripts.sqlite");
  memoryDb(mp).close();
  const db = new Database(tp);
  db.exec("CREATE TABLE transcript_files(path TEXT,engine TEXT,project TEXT); CREATE TABLE transcript_messages(transcript_path TEXT,message_index INTEGER,body TEXT,timestamp INTEGER,speaker TEXT,byte_offset INTEGER)");
  db.query("INSERT INTO transcript_files VALUES (?,?,?)").run("one", "codex", "project-a");
  db.query("INSERT INTO transcript_messages(transcript_path,message_index,body,timestamp,speaker) VALUES (?,?,?,?,?)").run("one", 0, c.prompt, 1, "user"); db.close();
  const before = [fs.readFileSync(mp), fs.readFileSync(tp)];
  const collected = collect(tp, mp);
  expect(collected.cases).toHaveLength(1);
  expect(collected.counts.memoryEntries).toBe(6);
  expect(fs.readFileSync(mp)).toEqual(before[0]); expect(fs.readFileSync(tp)).toEqual(before[1]);
});

test("complete labels required; P@3 penalizes empty slots and never invents no-injection precision", () => {
  validateLabels(sample, labels);
  expect(() => validateLabels(sample, { ...labels, cases: [] })).toThrow();
  const m = metrics([c], labels, [["c4"]], [2]);
  expect(m.precisionAt3).toBe(1 / 3); expect(m.precisionWhenOffered).toBe(1); expect(m.recall).toBe(1);
  const none = metrics([c], labels, [[]], [0]);
  expect(none.precisionAt3).toBe(0); expect(none.precisionWhenOffered).toBeNull();
  expect(select({ c1: 0.7, c2: 0.9, c3: 0.9, c4: 0.95 }, c.candidates)).toEqual(["c4", "c2", "c3"]);
});

test("Jev gets bounded redacted summaries, no bodies; malformed usage never means free", () => {
  const email = ["person", "example.invalid"].join("@");
  const body = requestBody({ ...c, prompt: email + " " + "x".repeat(5000) });
  expect(JSON.stringify(body)).not.toContain(email);
  expect(JSON.stringify(body)).not.toContain("Private body");
  expect(("prompt" in body.state ? body.state.prompt : "").length).toBeLessThanOrEqual(4003);
  expect(reservation(body)).toBeGreaterThanOrEqual(0.01);
  expect(() => parseAnswer({ answers: { c1: { noul: 0.9 } }, usage: { input_tokens: 1 } }, ["c1"])).toThrow();
  expect(() => parseAnswer({ answers: { c1: { noul: 2 } }, usage: { input_tokens: 1, cost: 0 } }, ["c1"])).toThrow();
});

function setup(cost = 0.00001) {
  const dir = root(), ledger = path.join(dir, "ledger.json"), probe = path.join(dir, "probe.json");
  fs.writeFileSync(probe, JSON.stringify({ status: "complete", costUsd: cost, inputTokens: 10, latencyMs: 1 }));
  process.env.OPENROUTER_API_KEY = "test-only";
  return { ledger, probe };
}
const response = () => Response.json({ answers: Object.fromEntries(c.candidates.map(m => [m.id, { noul: 0.9 }])), usage: { cost: 0.0001, input_tokens: 100 } });

test("USD cap refuses before fetch, including the probe cost", async () => {
  const { ledger, probe } = setup(CAP_USD + 0.005);
  let calls = 0;
  await expect(paidReplay(sample, labels, ledger, probe, async () => { calls++; return response(); })).rejects.toThrow("Budget");
  expect(calls).toBe(0);
});

test("probe overrun below the total cap refuses before fetch", async () => {
  const { ledger, probe } = setup(CAP_USD - 0.005);
  let calls = 0;
  await expect(paidReplay(sample, labels, ledger, probe, async () => { calls++; return response(); })).rejects.toThrow("stop and reconcile");
  expect(calls).toBe(0);
});

test("reservation is durable before fetch; completed replay spends nothing twice", async () => {
  const { ledger, probe } = setup(); let calls = 0;
  const fake = (async () => {
    calls++;
    expect(JSON.parse(fs.readFileSync(ledger, "utf8")).receipts[1].status).toBe("reserved");
    return response();
  });
  const result = await paidReplay(sample, labels, ledger, probe, fake);
  expect(charged(result.receipts)).toBeCloseTo(0.00011, 9);
  await paidReplay(sample, labels, ledger, probe, fake);
  expect(calls).toBe(1);
  await expect(paidReplay({ ...sample, seed: "changed" }, labels, ledger, probe, fake)).rejects.toThrow("Frozen");
});

test("provider overrun remains blocked when the ledger is reopened", async () => {
  const { ledger, probe } = setup(0);
  const cases = ["p01", "p02"].map(id => ({ ...c, id, candidates: [candidate("c1")] }));
  const replaySample = { ...sample, cases };
  const replayLabels = { ...labels, cases: cases.map(row => ({ ...labels.cases[0], id: row.id,
    candidates: labels.cases[0].candidates.slice(0, 1) })) };
  let calls = 0;
  const fake = async () => {
    calls++;
    return Response.json({ answers: { c1: { noul: 0.9 } }, usage: { cost: 1.1, input_tokens: 100 } });
  };
  await expect(paidReplay(replaySample, replayLabels, ledger, probe, fake)).rejects.toThrow("stop and reconcile");
  expect(calls).toBe(1);
  const persisted = fs.readFileSync(ledger, "utf8");
  expect(charged(JSON.parse(persisted).receipts)).toBe(1.1);
  await expect(paidReplay(replaySample, replayLabels, ledger, probe, fake)).rejects.toThrow("stop and reconcile");
  expect(calls).toBe(1);
  expect(fs.readFileSync(ledger, "utf8")).toBe(persisted);
});

test.each(["network", "http", "shape"])("%s failure burns reservation and blocks a retry", async kind => {
  const { ledger, probe } = setup(); let calls = 0;
  const fake = (async () => {
    calls++;
    if (kind === "network") throw new Error("lost reply");
    if (kind === "http") return new Response("private error", { status: 503 });
    return Response.json({});
  });
  await expect(paidReplay(sample, labels, ledger, probe, fake)).rejects.toThrow();
  expect(charged(JSON.parse(fs.readFileSync(ledger, "utf8")).receipts)).toBeCloseTo(0.01001, 9);
  await expect(paidReplay(sample, labels, ledger, probe, fake)).rejects.toThrow("Unsettled");
  expect(calls).toBe(1);
});

test("concurrent run is refused; absent environment key never falls back to a file", async () => {
  const { ledger, probe } = setup(); fs.mkdirSync(ledger + ".lock");
  await expect(paidReplay(sample, labels, ledger, probe)).rejects.toThrow();
  fs.rmdirSync(ledger + ".lock"); delete process.env.OPENROUTER_API_KEY;
  await expect(paidReplay(sample, labels, ledger, probe)).rejects.toThrow("OPENROUTER_API_KEY");
  expect(fs.existsSync(ledger)).toBeFalse();
});

test.each(["", ".pilot"])("public %s label/receipt artifacts reproduce every selection, metric and cost", suffix => {
  const publishedLabels = JSON.parse(fs.readFileSync(new URL(`../docs/research/memory-selection${suffix}.labels.json`, import.meta.url), "utf8")) as Labels;
  const results = JSON.parse(fs.readFileSync(new URL(`../docs/research/memory-selection${suffix}.results.json`, import.meta.url), "utf8"));
  const cases = results.cases.map((row: { id: string; engine: string; retrievalMs: number; strictCount: number }) => ({
    ...row, prompt: publishedLabels.cases.find(l => l.id === row.id)!.prompt,
    candidates: publishedLabels.cases.find(l => l.id === row.id)!.candidates.map(l => candidate(l.id)),
  })) as Case[];
  validateLabels({ ...sample, cases }, publishedLabels);
  for (const row of results.cases) {
    const current = cases.find(c => c.id === row.id)!;
    expect(row.fts).toEqual(current.candidates.slice(0, 3).map(c => c.id));
    expect(row.jev).toEqual(select(results.calls.find((r: { id: string }) => r.id === row.id).scores, current.candidates));
  }
  for (const arm of ["fts", "jev", "none"] as const) {
    const selected = results.cases.map((row: Record<string, string[]>) => arm === "none" ? [] : row[arm]);
    const computed = metrics(cases, publishedLabels, selected, []);
    for (const key of ["offered", "helpful", "available", "precisionAt3", "precisionWhenOffered", "recall", "promptCoverage"] as const) expect(computed[key]).toBe(results[arm][key]);
  }
  expect(charged(results.calls)).toBe(results.spendUsd);
  expect(results.spendUsd).toBeLessThan(CAP_USD);
  if (!suffix) expect(results.confidenceIntervals).toEqual(confidenceIntervals(cases, publishedLabels,
    results.cases.map((row: { fts: string[] }) => row.fts), results.cases.map((row: { jev: string[] }) => row.jev)));
});


test("all-turn population preserves short replies and excludes only known machine origins", () => {
  const rows = [message("# AGENTS.md instructions"), message("Так", 1), message("yes", 2),
    message("Seat tick: do scheduled work", 3), message("Agent finished: job", 4),
    { ...message("ordinary looking relay", 5), machineOrigin: true },
    { ...message("yes", 6), eventId: "event-a" }, { ...message("yes", 6, "copy"), eventId: "event-a" }];
  const result = sampleOperatorPrompts(rows);
  expect(result.counts).toMatchObject({ eligible: 3, machine: 4, copies: 1, sampled: 3 });
  expect(result.rows.map(r => r.message_index).sort()).toEqual([1, 2, 6]);
  expect(machineMessage("You are the board Maintainer for one project")).toBeTrue();
  expect(machineMessage("Operator, 30.09, verbatim: task")).toBeTrue();
  expect(machineMessage("Раунд фіксів 3 по PR: fix the findings")).toBeTrue();
  expect(machineMessage("Use the screenshot to fix this")).toBeFalse();
});

test("native near-duplicates are rejected without rejecting tiny shared words", () => {
  const original = { ...candidate("a"), title: "Attach socket handlers", summary: "before first writing bytes to a network connection", body: "one two three four five six seven eight nine ten" };
  expect(nativeMatch(original, { ...original, id: "b", body: original.body + " extra" })).toBeTrue();
  expect(nativeMatch(candidate("a"), { ...candidate("b"), title: "unrelated", summary: "no overlap", body: "private" })).toBeFalse();
});

test("confidence selection stops at 15 entries and 10000 characters including separators", () => {
  const candidates = Array.from({ length: 30 }, (_, i) => ({ ...candidate(`c${i + 1}`), summary: "x".repeat(700) }));
  const scores = Object.fromEntries(candidates.map((c, i) => [c.id, 1 - i / 100]));
  const selected = budgetSelect(candidates, scores, 0.8);
  expect(selected.length).toBeLessThanOrEqual(15);
  expect(candidates.filter(c => selected.includes(c.id)).reduce((s, c) => s + entryText(c).length, 0)).toBeLessThanOrEqual(10000);
  expect(selected).not.toContain("c22");
  expect(budgetSelect(candidates, scores, 1.1)).toEqual([]);
  const small = candidates.map(c => ({ ...c, summary: "short" }));
  expect(budgetSelect(small, scores, 0)).toHaveLength(15);
});

test("offer precision, recall and size intervals preserve paired identity and Unicode byte cost", () => {
  const expanded = { ...sample, cases: [{ ...c, candidates: [{ ...candidate("c4"), summary: "ї".repeat(6000) }] }] };
  const rows = offerRows(expanded, labels, [["c4"]]);
  expect(rows[0].approximateTokens).toBeGreaterThan(2500);
  expect(rows[0].characters).toBeLessThan(10000);
  const same = offerIntervals(rows, ["conversation-a"], rows);
  expect(same.precision.interval).toEqual([0, 0]);
  expect(same.meanCharacters.interval).toEqual([0, 0]);
  const empty = offerIntervals(offerRows(expanded, labels, [[]]), ["a"]);
  expect(empty.precision.interval).toEqual([null, null]);
  expect(empty.recall.interval).toEqual([0, 0]);
});

test("context view preserves role order and explicitly marks truncation; credentials are withheld", () => {
  const contextual = { ...c, context: [{ role: "user", text: "earlier work ".repeat(1700) }, { role: "assistant", text: "Latest decision" }] };
  expect(contextView(contextual)).toStartWith("[earlier context omitted]");
  expect(contextView(contextual)).toEndWith("assistant: Latest decision");
  const value = ["Fixture", "Only", "12345"].join("");
  expect(replayText("password: " + value)).not.toContain(value);
  expect(replayText(value)).not.toContain(value);
  const state = requestBody(contextual).state;
  expect("context" in state ? state.context : null).toBe(contextView(contextual));
});


test("expanded collection keeps the prefix before later operator turns and never looks ahead", () => {
  const dir = root(), mp = path.join(dir, "memories.sqlite"), tp = path.join(dir, "transcripts.sqlite");
  memoryDb(mp).close();
  const db = new Database(tp);
  db.exec("CREATE TABLE transcript_files(path TEXT,engine TEXT,project TEXT); CREATE TABLE transcript_messages(transcript_path TEXT,message_index INTEGER,body TEXT,timestamp INTEGER,speaker TEXT,byte_offset INTEGER)");
  db.query("INSERT INTO transcript_files VALUES (?,?,?)").run("one", "codex", "project-a");
  const add = db.query("INSERT INTO transcript_messages VALUES (?,?,?,?,?,NULL)");
  add.run("one", 0, "Pinned task: a generated pipeline assignment", 1, "user");
  add.run("one", 1, "The socket problem remains", 2, "assistant");
  add.run("one", 2, "Continue", 3, "user");
  add.run("one", 3, "Future answer must not affect labels", 4, "assistant");
  db.close();
  const result = collect(tp, mp);
  expect(result.cases).toHaveLength(1);
  expect(result.cases[0].prompt).toBe("Continue");
  expect(result.cases[0].context!.map(t => t.text)).toEqual(["Pinned task: a generated pipeline assignment", "The socket problem remains"]);
  expect(result.cases[0].candidates.length).toBeGreaterThan(0);
});

test("expanded FTS returns top thirty after native duplicate filtering", () => {
  const db = memoryDb(":memory:");
  try {
    for (let i = 0; i < 40; i++) {
      const id = `extra-${i}`, body = `socket connection error handler lifecycle rule number ${i}`;
      db.query("INSERT INTO memory_entries VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(id, id, body, body, "claude", "failure", "global", "2026-01-01", "", `${id}.md`, "claude_memory");
      db.query("INSERT INTO memory_fts VALUES (?,?,?,?)").run(id, id, body, body);
    }
    const first = retrieve(db, message("socket"), "recall", true);
    expect(first).toHaveLength(30);
    expect(first.every(m => Number.isFinite(m.score))).toBeTrue();
    expect(first.map(m => m.score)).toEqual(first.map(m => m.score).sort((a, b) => b! - a!));
  } finally { db.close(); }
});


test("all-turn public evidence independently reproduces every confidence arm and interval", () => {
  const results = JSON.parse(fs.readFileSync(new URL("../docs/research/memory-selection.all-turns.results.json", import.meta.url), "utf8")) as ReturnType<typeof summarizeVariants>;
  const publishedLabels = JSON.parse(fs.readFileSync(new URL("../docs/research/memory-selection.all-turns.labels.json", import.meta.url), "utf8")) as Labels;
  expect(results.counts.sampled).toBe(100);
  expect(results.population!.reduce((n, p) => n + p.operator, 0)).toBe(results.counts.eligible);
  expect(results.counts.messages).toBe(results.counts.machine + results.counts.copies + results.counts.eligible);
  for (const arm of results.arms) {
    const rows = results.cases.map((c, i) => {
      const graph = results.graph.cases.find(g => g.id === c.id)!.scores;
      const probabilities = results.calls.find(r => r.id === `${arm.arm === "graph-grounded" ? "grounded" : arm.arm}:${c.id}`)?.scores ?? {};
      const scores: Record<string, number> = arm.arm === "fts" ? Object.fromEntries(c.candidates.map(m => [m.id, m.score!])) :
        arm.arm === "graph" ? graph : arm.arm === "graph-grounded" ? Object.fromEntries(Object.entries(probabilities).filter(([id]) => graph[id] >= 0.5)) : probabilities;
      const ranked = c.candidates.filter(m => scores[m.id] >= arm.threshold).sort((a, b) => scores[b.id] - scores[a.id]);
      const selected: string[] = []; let characters = 0, bytes = 0;
      for (const m of ranked) if (selected.length < 15 && characters + m.characters <= 10000) {
        selected.push(m.id); characters += m.characters; bytes += m.bytes;
      }
      expect(arm.selected[i]).toEqual(selected);
      const good = publishedLabels.cases.find(l => l.id === c.id)!.candidates.filter(l => l.helpful).map(l => l.id);
      return { caseId: c.id, offered: selected.length, helpful: selected.filter(id => good.includes(id)).length,
        available: good.length, characters, approximateTokens: Math.ceil(bytes / 4) };
    });
    expect(arm.rows).toEqual(rows);
    expect(arm.intervals).toEqual(offerIntervals(rows, results.cases.map(c => c.conversation)));
    const total = (key: "offered" | "helpful" | "available" | "characters") => rows.reduce((n, r) => n + r[key], 0);
    expect(arm.precision).toBe(total("offered") ? total("helpful") / total("offered") : null);
    expect(arm.recall).toBe(total("helpful") / total("available"));
    expect(arm.meanEntries).toBe(total("offered") / 100);
    expect(arm.meanCharacters).toBe(total("characters") / 100);
    expect(arm.tokenOverflow).toBe(rows.filter(r => r.approximateTokens > 2500).length);
  }
  expect(results.spendUsd).toBe(charged(results.calls));
  expect(results.spendUsd).toBeLessThan(2);
  expect(results.calls.every(r => r.status === "complete")).toBeTrue();
  for (const { arm, threshold } of results.operating) {
    const qualifying = results.arms.filter(a => a.arm === arm && (a.precision ?? 0) >= 0.9 &&
      (a.intervals.precision.interval[0] ?? 0) >= 0.8 && a.rows.reduce((n, r) => n + r.offered, 0) >= 20)
      .sort((a, b) => (b.recall ?? 0) - (a.recall ?? 0) || a.threshold - b.threshold)[0];
    expect(threshold).toBe(qualifying?.threshold ?? null);
  }
  for (const { variant, comparison, exploratory } of results.paired) for (const pair of [comparison, exploratory]) {
    if (!pair) continue;
    const fts = results.arms.find(a => a.arm === "fts" && a.threshold === pair.ftsThreshold)!;
    const jev = results.arms.find(a => a.arm === variant && a.threshold === pair.jevThreshold)!;
    expect(pair.intervals).toEqual(offerIntervals(jev.rows, results.cases.map(c => c.conversation), fts.rows));
  }
});


test("positive operator provenance outranks tool-name and urgency heuristics through collect", () => {
  const dir = root(), mp = path.join(dir, "memories.sqlite"), tp = path.join(dir, "transcripts.sqlite"), transcript = path.join(dir, "native.jsonl");
  memoryDb(mp).close();
  const body = "<!-- llv:structured-user origin=operator -->\nPlease fix send_message_to_orchestrator so failed sends stay visible.";
  fs.writeFileSync(transcript, JSON.stringify({ type: "response_item", timestamp: "2026-01-01T00:00:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: body }] } }) + "\n");
  const db = new Database(tp);
  db.exec("CREATE TABLE transcript_files(path TEXT,engine TEXT,project TEXT); CREATE TABLE transcript_messages(transcript_path TEXT,message_index INTEGER,body TEXT,timestamp INTEGER,speaker TEXT,byte_offset INTEGER)");
  db.query("INSERT INTO transcript_files VALUES (?,?,?)").run(transcript, "codex", "project-a");
  db.query("INSERT INTO transcript_messages VALUES (?,?,?,?,?,?)").run(transcript, 0, body, 1, "user", 0); db.close();
  const result = collect(tp, mp);
  expect(result.counts.eligible).toBe(1);
  expect(result.cases[0].prompt).toBe("Please fix send_message_to_orchestrator so failed sends stay visible.");
  expect(machineMessage("ТЕРМІНОВО: check the result", true)).toBeFalse();
  expect(machineMessage("Your turn ended and the pipeline controller could not read a verdict", true)).toBeTrue();
  expect(sampleOperatorPrompts([{ ...message("Review this now"), operatorOrigin: true, machineOrigin: true }]).counts.eligible).toBe(0);
});


test("voice digest is stripped while the operator suffix survives", () => {
  const text = "While you were away the manager reported:\n- [info] Finished a task.\n\nMention what matters in your own words. Do not read this list aloud.\n\nPlease check the result.";
  expect(cleanEnvelope(text)).toBe("Please check the result.");
  expect(machineMessage(text, true)).toBeFalse();
  expect(machineMessage("Від локального оркестратора: relay", true)).toBeTrue();
});

test("improved questions carry their own memory, context and literal criteria", () => {
  const contextual = { ...c, project: "project-a", context: [{ role: "user", text: "Fix the socket handler" }, { role: "assistant", text: "I will inspect cleanup" }] };
  const original = requestBody(contextual, "original");
  expect(JSON.stringify(original)).not.toContain("I will inspect cleanup");
  for (const variant of ["framed", "grounded"] as const) {
    const request = requestBody(contextual, variant);
    expect(JSON.stringify(request.state)).toContain("project-a");
    expect(JSON.stringify(request.state)).toContain("codex");
    expect(JSON.stringify(request.state)).toContain("I will inspect cleanup");
    const question = JSON.stringify(request.questions.c1);
    expect(question).toContain(candidate("c1").summary);
    expect(question).toContain("criteria");
    expect(question.includes("supportingBodyExcerpt")).toBe(variant === "grounded");
  }
});

test("all variants share one durable cap and replay without further charges", async () => {
  const { ledger, probe } = setup(); let calls = 0;
  const fake = async () => { calls++; return response(); };
  const result = await paidReplay(sample, labels, ledger, probe, fake, [...REQUEST_VARIANTS]);
  expect(calls).toBe(4);
  expect(charged(result.receipts)).toBeCloseTo(0.00041, 9);
  await paidReplay(sample, labels, ledger, probe, fake, [...REQUEST_VARIANTS]);
  expect(calls).toBe(4);
  expect(summarizeVariants(sample, labels, result).variantUsage).toHaveLength(4);
  const next = setup();
  fs.writeFileSync(next.probe, JSON.stringify({ kind: "prior-experiments", status: "complete", costUsd: 1.995 }));
  await expect(paidReplay(sample, labels, next.ledger, next.probe, fake, [...REQUEST_VARIANTS])).rejects.toThrow("Budget refuses");
  expect(calls).toBe(4);
});

test("graph reranks linked neighbours and Codex keywords within the eligible pool", () => {
  const pool = [
    { ...candidate("c1"), title: "Seed", body: "See [[Target]]", score: 10 },
    { ...candidate("c2"), title: "Target", body: "Details", score: 1 },
    { ...candidate("c3"), title: "Unrelated", body: "Other", score: 4, kind: "other" },
  ];
  const graph = graphScores(pool);
  expect(graph.edges.link).toBe(1);
  expect(graph.scores.c2).toBeGreaterThan(graph.scores.c3);
  expect(Object.keys(graph.scores)).toEqual(["c1", "c2", "c3"]);
  const keywords = pool.slice(0, 2).map(c => ({ ...c, sourceKind: "codex_memory", body: c.summary + "\n- socket, lifecycle" }));
  expect(graphScores(keywords).edges.keywords).toBe(1);
});


test("native Claude queued human provenance outranks the generic meta flag", () => {
  const dir = root(), mp = path.join(dir, "memories.sqlite"), tp = path.join(dir, "transcripts.sqlite"), transcript = path.join(dir, "native.jsonl");
  memoryDb(mp).close();
  const origins = [{ origin: { kind: "human" } }, { origin: "human" }, { promptSource: "typed" }, { turnOrigin: "human" }, {}];
  const records = origins.map((origin, i) => ({ ...origin, uuid: `event-${i}`, isMeta: true,
    message: { role: "user", content: `Please inspect parser case ${i}.` } }));
  const lines = records.map(r => JSON.stringify(r) + "\n");
  fs.writeFileSync(transcript, lines.join(""));
  const db = new Database(tp);
  db.exec("CREATE TABLE transcript_files(path TEXT,engine TEXT,project TEXT); CREATE TABLE transcript_messages(transcript_path TEXT,message_index INTEGER,body TEXT,timestamp INTEGER,speaker TEXT,byte_offset INTEGER)");
  db.query("INSERT INTO transcript_files VALUES (?,?,?)").run(transcript, "claude", "project-a");
  let offset = 0;
  records.forEach((r, i) => { db.query("INSERT INTO transcript_messages VALUES (?,?,?,?,?,?)").run(transcript, i, r.message.content, i, "user", offset); offset += Buffer.byteLength(lines[i]); });
  db.close();
  const result = collect(tp, mp);
  expect(result.counts).toMatchObject({ messages: 5, machine: 1, eligible: 4, sampled: 4 });
  expect(result.cases.map(c => c.prompt).sort()).toEqual(records.slice(0, 4).map(r => r.message.content));
});
