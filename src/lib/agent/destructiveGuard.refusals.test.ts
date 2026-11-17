// destructive-code: head-only; refusal writers and readers share fake state.
import { afterEach, expect, setSystemTime, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { journal } from "../../../bin/destructive-guard.mjs";
import { DestructiveRefusalIngester, destructiveRefusalPorts, guardRefusalsForState, type GuardIngestPorts } from "./destructiveGuard.refusals";
import { computeDestructivePolicy } from "./destructiveGuard";
import { guardFixture } from "./destructiveGuard.fixture";
import { attentionReason } from "@/components/attention";
import type { FileEntry } from "@/lib/types";
const fixtures: ReturnType<typeof guardFixture>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); });

test("installation and ingestion alarms round-trip through the real lifecycle writer and reader", async () => {
  const f = guardFixture(); fixtures.push(f);
  const previous = process.env.LLV_STATE_DIR;
  const { closeAgentRegistryForTests } = await import("./registry");
  const { readLifecycleJournal } = await import("@/lib/lifecycle/journal");
  closeAgentRegistryForTests(); process.env.LLV_STATE_DIR = f.state;
  const at = "2026-11-17T12:00:00.000Z"; setSystemTime(new Date(at));
  try {
    const ports = await destructiveRefusalPorts();
    ports.error("fixture ingestion unavailable");
    const file = f.state + "/destructive-guard-protected.json"; f.assertOwned(file); fs.writeFileSync(file, "invalid");
    computeDestructivePolicy(f.env, { home: f.home, accounts: [], projects: [] });
    for (let n = 0; n < 100 && readLifecycleJournal().events.length < 2; n++) await Bun.sleep(1);
    const events = readLifecycleJournal().events;
    expect(events).toHaveLength(2);
    expect(events.map(event => [event.type, event.at])).toEqual([["destructive_guard_off", at], ["destructive_guard_off", at]]);
  } finally {
    setSystemTime(); closeAgentRegistryForTests();
    if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
  }
});

test("real wrapper output reaches lifecycle, stage and board ports, then resumes without replay after restart", async () => {
  const f = guardFixture(); fixtures.push(f);
  expect(f.run("rm", ["-rf", f.state]).exitCode).toBe(1);
  const records: string[] = [], notices: string[] = [], errors: string[] = [];
  const ports: GuardIngestPorts = { resolve: () => ({ conversationId: "guard-conversation", project: "guard-project" }),
    record: async row => { records.push(row.id); }, notify: async (_id, _project, row) => { notices.push(row.id); }, error: message => errors.push(message) };
  await new DestructiveRefusalIngester(f.state, ports).ingest();
  expect(records).toHaveLength(1); expect(notices).toHaveLength(1); expect(errors).toEqual([]);
  const refusal = guardRefusalsForState(f.state)["guard-conversation"]!;
  const entry = { path: f.tmp + "/transcript.jsonl", mtime: Date.parse(refusal.at) / 1000, engine: "codex", guardRefusal: refusal } as FileEntry;
  expect(attentionReason(entry, Date.parse(refusal.at) / 1000 + 1)?.kind).toBe("refusal");
  await new DestructiveRefusalIngester(f.state, ports).ingest();
  expect(records).toHaveLength(1); expect(notices).toHaveLength(1);
  expect(f.run("rm", ["-rf", f.state]).exitCode).toBe(1);
  await new DestructiveRefusalIngester(f.state, ports).ingest();
  expect(records).toHaveLength(2); expect(notices).toHaveLength(1);
});

test("a fresh ingester process resumes its durable cursor without repeating records or notices", () => {
  const f = guardFixture(); fixtures.push(f);
  expect(f.run("rm", ["-rf", f.state]).exitCode).toBe(1);
  const script = f.tmp + "/ingest.ts", recorded = f.tmp + "/recorded.ndjson";
  fs.writeFileSync(recorded, "");
  fs.writeFileSync(script, `import fs from "node:fs";
import { DestructiveRefusalIngester } from ${JSON.stringify(path.join(import.meta.dir, "destructiveGuard.refusals.ts"))};
const record = (kind, id) => fs.appendFileSync(${JSON.stringify(recorded)}, JSON.stringify({ kind, id }) + "\\n");
await new DestructiveRefusalIngester(${JSON.stringify(f.state)}, {
  resolve: () => ({ conversationId: "guard-conversation", project: null }),
  record: async row => { record("record", row.id); },
  notify: async (_id, _project, row) => { record("notice", row.id); },
  error: reason => { throw Error(reason); },
}).ingest();`);
  f.assertOwned(script); f.assertOwned(recorded);
  for (let run = 0; run < 2; run++) {
    const result = Bun.spawnSync([process.execPath, script], { cwd: f.cwd, env: f.env });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const records = fs.readFileSync(recorded, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(records.map(row => row.kind)).toEqual(["record", "notice"]);
    expect(guardRefusalsForState(f.state)["guard-conversation"]?.id).toBe(records[0].id);
  }
});

test("partial lines wait, invalid lines raise an alarm, a failed record is retried without advancing the cursor", async () => {
  const f = guardFixture(); fixtures.push(f);
  f.run("rm", ["-rf", f.state]);
  const journal = f.env.LLV_DESTRUCTIVE_GUARD_JOURNAL!, line = fs.readFileSync(journal, "utf8");
  fs.writeFileSync(journal, line.slice(0, -1));
  let records = 0, fail = true; const errors: string[] = [];
  const ports: GuardIngestPorts = { resolve: () => ({ conversationId: null, project: null }), record: async () => { if (fail) throw Error("lease busy"); records++; }, notify: async () => {}, error: value => errors.push(value) };
  await new DestructiveRefusalIngester(f.state, ports).ingest(); expect(records).toBe(0);
  fs.appendFileSync(journal, "\n"); await new DestructiveRefusalIngester(f.state, ports).ingest();
  expect(errors).toContain("lease busy"); expect(fs.existsSync(f.state + "/destructive-guard/refusals.cursor.json")).toBeFalse();
  fail = false; await new DestructiveRefusalIngester(f.state, ports).ingest(); expect(records).toBe(1);
  fs.appendFileSync(journal, "invalid\n"); await new DestructiveRefusalIngester(f.state, ports).ingest();
  expect(errors).toContain("invalid destructive refusal journal line");
});

for (const boundary of ["record", "notify"] as const) test(`release ownership lost during ${boundary} leaves the cursor for a fresh owner`, async () => {
  const f = guardFixture(); fixtures.push(f); f.run("rm", ["-rf", f.state]);
  let current = true;
  const recorded: string[] = [], notices: string[] = [];
  const ports: GuardIngestPorts = {
    current: () => current, resolve: () => ({ conversationId: "guard-conversation", project: null }),
    record: async row => { recorded.push(row.id); if (boundary === "record") current = false; },
    notify: async (_id, _project, row) => { notices.push(row.id); if (boundary === "notify") current = false; }, error: () => {},
  };
  await new DestructiveRefusalIngester(f.state, ports).ingest();
  expect(fs.existsSync(f.state + "/destructive-guard/refusals.cursor.json")).toBeFalse();
  expect(notices).toHaveLength(boundary === "record" ? 0 : 1);
  await new DestructiveRefusalIngester(f.state, { ...ports, current: () => true }).ingest();
  expect(recorded).toHaveLength(2); expect(recorded[1]).toBe(recorded[0]);
  expect(guardRefusalsForState(f.state)["guard-conversation"]?.id).toBe(recorded[0]);
});

test("an oversized corrupt line is skipped across restart and the next writer output is consumed", async () => {
  const f = guardFixture(); fixtures.push(f); f.run("rm", ["-rf", f.state]);
  const file = f.env.LLV_DESTRUCTIVE_GUARD_JOURNAL!, line = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, "x".repeat(150000) + "\n" + line);
  const records: string[] = [], errors: string[] = [];
  const ports: GuardIngestPorts = { resolve: () => ({ conversationId: "guard-conversation", project: null }), record: async row => { records.push(row.id); }, notify: async () => {}, error: error => errors.push(error) };
  for (let n = 0; n < 4; n++) await new DestructiveRefusalIngester(f.state, ports).ingest();
  expect(records).toHaveLength(1); expect(errors).toContain("oversized guard journal line");
  expect(guardRefusalsForState(f.state)["guard-conversation"]?.id).toBe(records[0]);
});

test("hostile journal parents and caller values alarm without blocking the next valid record", async () => {
  const f = guardFixture(); fixtures.push(f); f.run("rm", ["-rf", f.state]);
  const file = f.env.LLV_DESTRUCTIVE_GUARD_JOURNAL!, line = fs.readFileSync(file, "utf8"), row = JSON.parse(line);
  fs.writeFileSync(file, JSON.stringify({ ...row, parents: [null] }) + "\n" + JSON.stringify({ ...row, caller: { capabilityDigest: {} } }) + "\n" + line);
  const errors: string[] = []; let count = 0;
  await new DestructiveRefusalIngester(f.state, { resolve: () => ({ conversationId: null, project: null }), record: async () => { count++; }, notify: async () => {}, error: error => errors.push(error) }).ingest();
  expect(count).toBe(1); expect(errors).toEqual(["invalid destructive refusal journal line", "invalid destructive refusal journal line"]);
});

test("rotation retains late appends and a corrupt cursor replays the archive before retirement", async () => {
  const f = guardFixture(); fixtures.push(f); f.run("rm", ["-rf", f.state]);
  const file = f.env.LLV_DESTRUCTIVE_GUARD_JOURNAL!, line = fs.readFileSync(file, "utf8"), archive = file + ".previous";
  fs.writeFileSync(file, "\n".repeat(5 * 1024 * 1024) + line);
  const records: string[] = [];
  const ports: GuardIngestPorts = { resolve: () => ({ conversationId: "guard-conversation", project: null }), record: async row => { records.push(row.id); }, notify: async () => {}, error: error => { throw Error(error); } };
  for (let n = 0; n < 82; n++) await new DestructiveRefusalIngester(f.state, ports).ingest();
  expect(fs.existsSync(archive)).toBeTrue(); expect(records).toHaveLength(1);
  const late = { ...JSON.parse(line), id: "late-refusal" }; fs.appendFileSync(archive, JSON.stringify(late) + "\n");
  await new DestructiveRefusalIngester(f.state, ports).ingest(); expect(records).toEqual([JSON.parse(line).id, late.id]);
  fs.writeFileSync(f.state + "/destructive-guard/refusals.cursor.json", "corrupt");
  fs.utimesSync(archive, new Date("2020-01-01"), new Date("2020-01-01"));
  await new DestructiveRefusalIngester(f.state, ports).ingest(); expect(fs.existsSync(archive)).toBeTrue();
  for (let n = 0; n < 83; n++) await new DestructiveRefusalIngester(f.state, ports).ingest();
  expect(records).toEqual([JSON.parse(line).id, late.id, JSON.parse(line).id, late.id]);
  expect(fs.existsSync(archive)).toBeFalse();
});

test("a long Unicode refusal remains one bounded writer record readable by the ingester", async () => {
  const f = guardFixture(); fixtures.push(f);
  const text = "界".repeat(5000);
  journal("wrapper", "rm", text, f.cwd + text, { given: text, resolved: text, rule: "sealed", entry: text, kind: text }, { session_id: text, transcript_path: text, tool_use_id: text }, f.env);
  const bytes = fs.readFileSync(f.env.LLV_DESTRUCTIVE_GUARD_JOURNAL!);
  expect(bytes.length).toBeLessThan(4096); expect(bytes.toString().split("\n")).toHaveLength(2);
  let count = 0;
  await new DestructiveRefusalIngester(f.state, { resolve: () => ({ conversationId: null, project: null }), record: async () => { count++; }, notify: async () => {}, error: error => { throw Error(error); } }).ingest();
  expect(count).toBe(1);
});
