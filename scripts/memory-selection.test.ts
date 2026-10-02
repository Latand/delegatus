import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { CAP_USD, charged, collect, metrics, paidReplay, parseAnswer, queryFor, requestBody,
  confidenceIntervals, reservation, retrieve, samplePrompts, select, validateLabels, type Case, type Labels, type Message, type Sample } from "./memory-selection";

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
    message("<!-- llv:structured-user -->" + c.prompt, 0, "copy"),
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
  db.exec("CREATE TABLE transcript_files(path TEXT,engine TEXT,project TEXT); CREATE TABLE transcript_messages(transcript_path TEXT,message_index INTEGER,body TEXT,timestamp INTEGER,speaker TEXT)");
  db.query("INSERT INTO transcript_files VALUES (?,?,?)").run("one", "codex", "project-a");
  db.query("INSERT INTO transcript_messages VALUES (?,?,?,?,?)").run("one", 0, c.prompt, 1, "user"); db.close();
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
  expect(body.state.prompt.length).toBeLessThanOrEqual(4003);
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
