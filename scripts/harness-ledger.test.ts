import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Pipeline } from "@/lib/pipelines/types";

import {
  assertNotLiveState,
  bootstrapMean,
  bootstrapStratifiedEffect,
  buildReport,
  countFindings,
  decide,
  isoWeek,
  ledgerRows,
  mulberry32,
  noiseBand,
  outcomeObservations,
  pipelinePassed,
  PREREGISTERED_CHANGES,
  readPipelines,
  scaffoldHash,
  searchableChunk,
  stratifiedEffect,
  thisProjectMatcher,
  transcriptTokens,
  type ChangeResult,
  type Cluster,
  type LedgerRow,
  type Observation,
} from "./harness-ledger";

const REVIEWER_OLD = "You are a reviewer. Check the diff.";
const REVIEWER_NEW = "You are a reviewer. Check the diff. Search first.";

type AttemptSeed = { n: number; state: string; status?: "pass" | "fail" | "needs_decision"; findings?: string[]; startedAt: string; activatedBy?: { stageId: string; attempt: number; edge: "pass" | "fail" } | null; historical?: boolean; scaffold?: string; model?: string };

function attempt(seed: AttemptSeed, roleId: string) {
  return {
    n: seed.n,
    state: seed.state,
    historical: seed.historical,
    effectiveRole: { roleId, engine: "claude", model: seed.model ?? "opus", effort: "high", access: "read-write", promptScaffold: seed.scaffold ?? `role ${roleId}` },
    startedAt: seed.startedAt,
    completedAt: null,
    activatedBy: seed.activatedBy ?? null,
    verdict: seed.status ? { status: seed.status, findings: seed.findings ?? [] } : null,
    agentPath: null,
  };
}

/** A build → review loop: the review failed once, the fix ran again, the
    second review passed. One review attempt was cut and left no verdict. */
function fixturePipeline(id: string, overrides: Partial<{ project: string; repoDir: string; state: string; createdAt: string; reviewScaffold: string }> = {}): Pipeline {
  const createdAt = overrides.createdAt ?? "2026-09-02T10:00:00Z";
  const scaffold = overrides.reviewScaffold ?? REVIEWER_OLD;
  return {
    id,
    project: overrides.project ?? "repo-this",
    repoDir: overrides.repoDir ?? "/work/main",
    state: overrides.state ?? "completed",
    createdAt,
    stages: [
      { id: "build", kind: "run", prompt: "", next: "review", effectiveRole: {} },
      { id: "review", kind: "run", prompt: "", next: null, onFail: { to: "build", maxRounds: 3 }, effectiveRole: {} },
    ],
    runs: [
      {
        stageId: "build",
        attempts: [
          attempt({ n: 1, state: "passed", status: "pass", startedAt: createdAt }, "builder"),
          attempt({ n: 2, state: "passed", status: "pass", startedAt: createdAt, activatedBy: { stageId: "review", attempt: 1, edge: "fail" } }, "builder"),
          // A retry of the fix under the same activation spends no round.
          attempt({ n: 3, state: "passed", status: "pass", startedAt: createdAt, activatedBy: { stageId: "review", attempt: 1, edge: "fail" } }, "builder"),
          attempt({ n: 4, state: "failed", status: "fail", startedAt: createdAt, historical: true }, "builder"),
        ],
      },
      {
        stageId: "review",
        attempts: [
          attempt({ n: 1, state: "failed", status: "fail", findings: ["P1 — WRONG-PREMISE: this does not serve the requirement", "loose note"], startedAt: createdAt, scaffold }, "reviewer"),
          attempt({ n: 2, state: "needs_decision", startedAt: createdAt, scaffold }, "reviewer"),
          attempt({ n: 3, state: "passed", status: "pass", startedAt: createdAt, scaffold }, "reviewer"),
          attempt({ n: 4, state: "running", startedAt: createdAt, scaffold }, "reviewer"),
        ],
      },
    ],
  } as unknown as Pipeline;
}

describe("parsing", () => {
  test("ISO weeks follow the Thursday rule across a year boundary", () => {
    expect(isoWeek("2026-09-25T12:00:00Z")).toBe("2026-W39");
    expect(isoWeek("2027-01-01T00:00:00Z")).toBe("2026-W53");
    expect(isoWeek("2026-01-01T00:00:00Z")).toBe("2026-W01");
    expect(isoWeek("2024-12-30T00:00:00Z")).toBe("2025-W01");
  });

  test("findings count by severity from ranked records or the rendered prefix", () => {
    expect(countFindings({ status: "fail", findings: ["P1 — a", "P3 — b", "no rank"] }).counts).toEqual({ P0: 0, P1: 1, P2: 0, P3: 1, unranked: 1 });
    expect(countFindings({ status: "fail", findings: ["P0 — x"], rankedFindings: [{ severity: "P0", text: "x" }, { severity: null, text: "y" }] }).counts)
      .toEqual({ P0: 1, P1: 0, P2: 0, P3: 0, unranked: 1 });
    expect(countFindings(null).texts).toEqual([]);
  });

  test("one row per settled attempt; a missing verdict is none; rounds match the engine's count", () => {
    const rows = ledgerRows([fixturePipeline("p1", { state: "running" })], () => true, null);
    // 3 builder attempts (historical dropped) + 3 reviewer attempts (in flight in a live pipeline: dropped).
    expect(rows).toHaveLength(6);
    const review = rows.filter((row) => row.role === "reviewer");
    expect(review.map((row) => row.verdict)).toEqual(["fail", "none", "pass"]);
    expect(review[0].wrongPremise).toBe(1);
    expect(review[0].findings).toEqual({ P0: 0, P1: 1, P2: 0, P3: 0, unranked: 1 });
    expect(review[0].scaffoldHash).toBe(scaffoldHash(REVIEWER_OLD));
    expect(review[0].model).toBe("claude/opus");
    // Two fix attempts carry one activation: one round, as edgeRoundsUsed counts it.
    expect(rows.every((row) => row.pipelineFailEdgeRounds === 1 && row.pipelineHasFailEdge)).toBe(true);
    expect(rows[0].week).toBe("2026-W36");
  });

  test("an attempt cut when its pipeline finished reads as no verdict; a skipped one never ran", () => {
    for (const state of ["closed", "completed"]) {
      const pipeline = fixturePipeline(`cut-${state}`, { state });
      pipeline.runs[1].attempts.push(
        { ...pipeline.runs[1].attempts[3], n: 5, state: "reviewing", verdict: { status: "pass", findings: ["P1 — WRONG-PREMISE: never recorded"] } },
        { ...pipeline.runs[1].attempts[3], n: 6, state: "pending", startedAt: null },
        { ...pipeline.runs[1].attempts[3], n: 7, state: "skipped" },
      );
      const review = ledgerRows([pipeline], () => true, null).filter((row) => row.role === "reviewer");
      expect(review.map((row) => [row.attempt, row.verdict])).toEqual([[1, "fail"], [2, "none"], [3, "pass"], [4, "none"], [5, "none"], [6, "none"]]);
      // A verdict the cut attempt never settled is not read, nor are its findings.
      expect(review[4].wrongPremise).toBe(0);
      expect(review[4].findings).toEqual({ P0: 0, P1: 0, P2: 0, P3: 0, unranked: 0 });
      expect(review[5].week).toBe(isoWeek(pipeline.createdAt));
      expect(outcomeObservations(ledgerRows([pipeline], () => true, null), "reviewer").noVerdict.reduce((sum, entry) => sum + entry.sum, 0)).toBe(4);
    }
  });

  test("a lane closed after its final stage passed counts as passed; a cut final stage does not", () => {
    expect(pipelinePassed(fixturePipeline("done"))).toBe(true);
    // The fixture's review stage ends on a running attempt: not passed once closed.
    expect(pipelinePassed(fixturePipeline("cut", { state: "closed" }))).toBe(false);
    const merged = fixturePipeline("merged", { state: "closed" });
    merged.runs[1].attempts.pop();
    expect(pipelinePassed(merged)).toBe(true);
    const rows = ledgerRows([merged], () => true, null);
    expect(outcomeObservations(rows, "reviewer").roundsToPass.map((entry) => entry.pipelineId)).toEqual(["merged"]);
  });

  test("this repository is every key a pipeline under the main checkout carries, siblings included", () => {
    const pipelines = [
      fixturePipeline("a", { project: "repo-this", repoDir: "/work/main" }),
      fixturePipeline("b", { project: "dir-old-key", repoDir: "/work/main-pipeline-1234" }),
      fixturePipeline("c", { project: "repo-other", repoDir: "/work/elsewhere" }),
    ];
    const isThis = thisProjectMatcher(pipelines, "/work/main");
    expect(pipelines.map(isThis)).toEqual([true, true, false]);
  });

  test("tokens: Claude usage once per message id, Codex the last cumulative count, null when gone", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-ledger-tokens-"));
    try {
      const claude = path.join(dir, "claude.jsonl");
      const usage = { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 7 };
      fs.writeFileSync(claude, [
        JSON.stringify({ type: "assistant", message: { id: "m1", usage } }),
        JSON.stringify({ type: "assistant", message: { id: "m1", usage } }),
        JSON.stringify({ type: "assistant", message: { id: "m2", usage: { input_tokens: 1, output_tokens: 2 } } }),
        "{torn",
      ].join("\n"));
      expect(transcriptTokens(claude)).toEqual({ total: 125, output: 9 });
      const codex = path.join(dir, "codex.jsonl");
      const count = (total: number) => JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: total, output_tokens: 3, reasoning_output_tokens: 2 } } } });
      fs.writeFileSync(codex, [count(50), count(80)].join("\n"));
      // Reasoning is already inside output_tokens.
      expect(transcriptTokens(codex)).toEqual({ total: 80, output: 3 });
      expect(transcriptTokens(path.join(dir, "missing.jsonl"))).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reads a copy, prefers the live collection over the archive, refuses a live state path", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-ledger-db-"));
    try {
      const file = path.join(dir, "state.sqlite");
      const db = new Database(file);
      db.run("CREATE TABLE state_rows (collection TEXT, row_key TEXT, value_json TEXT)");
      const insert = db.prepare("INSERT INTO state_rows VALUES (?, ?, ?)");
      insert.run("pipelines_archive", "p1", JSON.stringify({ ...fixturePipeline("p1"), state: "closed" }));
      insert.run("pipelines", "p1", JSON.stringify(fixturePipeline("p1")));
      insert.run("tasks", "t1", "{}");
      db.close();
      const pipelines = readPipelines(file);
      expect(pipelines).toHaveLength(1);
      expect(pipelines[0].state).toBe("completed");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    expect(() => assertNotLiveState("/srv/someone/.config/agent-log-viewer/state/state.sqlite")).toThrow(/live state/);
    expect(() => assertNotLiveState("/var/tmp/scratch/state.sqlite")).not.toThrow();
  });

  test("the live-state guard refuses every app dir name and the staging sibling, with no marker files", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "harness-ledger-home-"));
    try {
      for (const [name, stateDir] of [["delegatus", "state"], ["delegatus", "state-staging"], ["agent-log-viewer", "state-staging"], ["live-log-viewer", "state"]]) {
        const directory = path.join(home, ".config", name, stateDir);
        fs.mkdirSync(directory, { recursive: true });
        const db = path.join(directory, "state.sqlite");
        fs.writeFileSync(db, "");
        expect(() => assertNotLiveState(db)).toThrow(/live state directory/);
      }
      const scratch = path.join(home, ".config", "delegatus", "state-copy");
      fs.mkdirSync(scratch, { recursive: true });
      fs.writeFileSync(path.join(scratch, "state.sqlite"), "");
      expect(() => assertNotLiveState(path.join(scratch, "state.sqlite"))).not.toThrow();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("the live-state guard follows symlinks and refuses a directory a live writer holds", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-ledger-guard-"));
    try {
      const liveDir = path.join(dir, "home", ".config", "agent-log-viewer", "state");
      fs.mkdirSync(liveDir, { recursive: true });
      fs.writeFileSync(path.join(liveDir, "state.sqlite"), "");
      const scratch = path.join(dir, "scratch");
      fs.mkdirSync(scratch);
      // A link to the live file, and a link to the live directory.
      fs.symlinkSync(path.join(liveDir, "state.sqlite"), path.join(scratch, "state.sqlite"));
      fs.symlinkSync(liveDir, path.join(scratch, "linked-state"));
      expect(() => assertNotLiveState(path.join(scratch, "state.sqlite"))).toThrow(/live state directory/);
      expect(() => readPipelines(path.join(scratch, "state.sqlite"))).toThrow(/live state directory/);
      expect(() => assertNotLiveState(path.join(scratch, "linked-state", "missing.sqlite"))).toThrow(/live state directory/);

      // A live directory under another name: the writer's own files give it away.
      const renamed = path.join(dir, "custom-state");
      fs.mkdirSync(renamed);
      fs.writeFileSync(path.join(renamed, "state.sqlite"), "");
      expect(() => assertNotLiveState(path.join(renamed, "state.sqlite"))).not.toThrow();
      fs.writeFileSync(path.join(renamed, "runtime-host.sock.lock"), "");
      expect(() => assertNotLiveState(path.join(renamed, "state.sqlite"))).toThrow(/runtime-host\.sock\.lock/);

      // A write-ahead log touched seconds ago: a writer holds the file.
      const copy = path.join(dir, "copy");
      fs.mkdirSync(copy);
      fs.writeFileSync(path.join(copy, "state.sqlite"), "");
      fs.writeFileSync(path.join(copy, "state.sqlite-wal"), "");
      const walTime = fs.statSync(path.join(copy, "state.sqlite-wal")).mtimeMs;
      expect(() => assertNotLiveState(path.join(copy, "state.sqlite"), walTime + 1_000)).toThrow(/write-ahead log/);
      expect(assertNotLiveState(path.join(copy, "state.sqlite"), walTime + 60_000)).toBe(fs.realpathSync(path.join(copy, "state.sqlite")));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a searchable chunk skips quotes, escapes and template syntax", () => {
    expect(searchableChunk('Say "yes" to {{lens}} and then keep reading the rest of this long sentence', 20)).toBe("d then keep reading ");
    expect(searchableChunk('"x" {{a}} "y" {{b}}', 8)).toBeNull();
    expect(searchableChunk("short", 40)).toBeNull();
    const chunk = searchableChunk('A "quoted" start, then a long plain run of words that source code carries', 24);
    expect(chunk).not.toBeNull();
    expect(chunk!).not.toMatch(/["{}$`\\]/);
  });
});

describe("bootstrap", () => {
  test("the PRNG is deterministic per seed", () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    const draws = Array.from({ length: 5 }, () => a());
    expect(Array.from({ length: 5 }, () => b())).toEqual(draws);
    expect(draws.every((value) => value >= 0 && value < 1)).toBe(true);
  });

  test("a rate's interval brackets the point and narrows as n grows", () => {
    const small: Cluster[] = Array.from({ length: 20 }, (_, index) => ({ sum: index % 4 === 0 ? 1 : 0, n: 1 }));
    const large: Cluster[] = Array.from({ length: 2000 }, (_, index) => ({ sum: index % 4 === 0 ? 1 : 0, n: 1 }));
    const a = bootstrapMean(small, 1000, mulberry32(1))!;
    const b = bootstrapMean(large, 1000, mulberry32(1))!;
    expect(a.value).toBeCloseTo(0.25, 10);
    expect(a.lo).toBeLessThanOrEqual(a.value);
    expect(a.hi).toBeGreaterThanOrEqual(a.value);
    expect(b.hi - b.lo).toBeLessThan((a.hi - a.lo) / 4);
    expect(bootstrapMean([], 10, mulberry32(1))).toBeNull();
    // Same seed, same interval.
    expect(bootstrapMean(small, 1000, mulberry32(1))).toEqual(a);
  });

  test("stratification removes a model-mix shift that a pooled difference reports", () => {
    // Model A fails 60 % in both arms, model B 20 % in both: no effect within
    // either model. The before arm is mostly A, the after arm mostly B, so the
    // pooled difference shows a large drop that is only the mix.
    const clusters = (n: number, failures: number): Cluster[] => Array.from({ length: n }, (_, index) => ({ sum: index < failures ? 1 : 0, n: 1 }));
    const arms = {
      before: new Map([["A", clusters(100, 60)], ["B", clusters(10, 2)]]),
      after: new Map([["A", clusters(10, 6)], ["B", clusters(100, 20)]]),
    };
    expect(stratifiedEffect(arms)).toBeCloseTo(0, 10);
    const pooledBefore = (60 + 2) / 110;
    const pooledAfter = (6 + 20) / 110;
    expect(pooledAfter - pooledBefore).toBeLessThan(-0.3);
    const estimate = bootstrapStratifiedEffect(arms, 500, mulberry32(3))!;
    expect(estimate.value).toBeCloseTo(0, 10);
    expect(estimate.lo).toBeLessThan(0);
    expect(estimate.hi).toBeGreaterThan(0);
    expect(estimate.strata).toEqual(["A", "B"]);
    expect(estimate.nBefore).toBe(110);
  });

  test("strata that ran in one arm only are dropped, and none shared gives null", () => {
    const one: Cluster[] = [{ sum: 1, n: 1 }];
    expect(stratifiedEffect({ before: new Map([["A", one]]), after: new Map([["B", one]]) })).toBeNull();
    expect(bootstrapStratifiedEffect({ before: new Map([["A", one]]), after: new Map([["B", one]]) }, 10, mulberry32(1))).toBeNull();
    const estimate = bootstrapStratifiedEffect({ before: new Map([["A", [{ sum: 0, n: 1 }]], ["C", one]]), after: new Map([["A", one]]) }, 10, mulberry32(1))!;
    expect(estimate.strata).toEqual(["A"]);
    expect(estimate.value).toBe(1);
  });
});

describe("noise band", () => {
  const observation = (version: string, week: string, sum: number, n: number): Observation => ({ pipelineId: `${version}-${week}`, version, model: "m", split: "this", week, sum, n });

  test("pools the weekly spread inside unchanged cells and ignores thin weeks and single-week cells", () => {
    const band = noiseBand([
      observation("v1", "2026-W30", 2, 10), // 20 %
      observation("v1", "2026-W31", 4, 10), // 40 %
      observation("v1", "2026-W32", 9, 4), // under the weekly minimum
      observation("v2", "2026-W30", 5, 10), // 50 %
      observation("v2", "2026-W31", 7, 10), // 70 %
      observation("v3", "2026-W30", 1, 10), // one week only
    ], 100);
    // Each cell deviates ±10 points around its mean: Σ squares 400 over 2 degrees of freedom.
    expect(band.delta).toBeCloseTo(Math.sqrt(200), 10);
    expect(band.cells).toBe(2);
    expect(band.weeks).toBe(4);
    expect(band.units).toBe(40);
    expect(noiseBand([observation("v1", "2026-W30", 1, 10)], 100).delta).toBeNull();
  });

  test("outcomes attribute a pipeline to the role's version and never read the reviewer's verdict", () => {
    const rows = ledgerRows([fixturePipeline("p1"), fixturePipeline("p2", { state: "closed" })], () => true, null);
    const observations = outcomeObservations(rows, "reviewer");
    // Rounds-to-pass: passed pipelines only; p2 closed with its review cut.
    expect(observations.roundsToPass.map((entry) => [entry.pipelineId, entry.sum])).toEqual([["p1", 1]]);
    // WRONG-PREMISE: every finished pipeline.
    expect(observations.wrongPremise.map((entry) => entry.sum)).toEqual([1, 1]);
    // No verdict: the needs_decision attempt with none, and the attempt cut when the pipeline finished.
    expect(observations.noVerdict.map((entry) => [entry.sum, entry.n])).toEqual([[2, 4], [2, 4]]);
    expect(observations.noVerdict[0].version).toBe(scaffoldHash(REVIEWER_OLD));
  });
});

describe("the pre-registered rule", () => {
  const change = PREREGISTERED_CHANGES[0];
  const effect = (value: number, lo: number, hi: number) => ({ value, lo, hi, nBefore: 50, nAfter: 50, strata: ["m"] });
  const result = (outcome: ChangeResult["outcome"], delta: number | null, here: ReturnType<typeof effect> | null, there: ReturnType<typeof effect> | null): ChangeResult => {
    const usable = delta !== null && (outcome === "roundsToPass" || delta <= 10);
    return {
      change,
      outcome,
      delta,
      usable,
      bySplit: { this: here, other: there },
      exceedsDeltaBothSplits: usable && !!here && !!there && Math.abs(here.value) > delta! && Math.abs(there.value) > delta! && Math.sign(here.value) === Math.sign(there.value),
    };
  };

  test("disproved when every interval includes zero", () => {
    expect(decide([result("noVerdict", 3, effect(-5, -9, 1), effect(-6, -12, 2))]).verdict).toBe("value disproved");
  });

  test("disproved when δ exceeds 10 points on every rate outcome, even with a large effect", () => {
    expect(decide([
      result("noVerdict", 14, effect(-20, -30, -10), effect(-20, -35, -5)),
      result("wrongPremise", null, null, null),
    ]).verdict).toBe("value disproved");
  });

  test("proven when an effect beats δ in both splits, same sign", () => {
    const decision = decide([
      result("noVerdict", 4, effect(-8, -12, -4), effect(-6, -11, -1)),
      result("wrongPremise", 3, effect(1, -2, 4), effect(0, -3, 3)),
    ]);
    expect(decision.verdict).toBe("value proven");
  });

  test("not proven when the effects disagree in sign or one split is under δ", () => {
    expect(decide([
      result("noVerdict", 4, effect(-8, -12, -4), effect(6, 1, 11)),
      result("wrongPremise", 3, effect(-5, -8, -2), effect(-2, -6, 2)),
    ]).verdict).toBe("value not proven (neither condition holds)");
  });
});

test("the report renders every section from a synthetic ledger", () => {
  const pipelines = [
    fixturePipeline("p1", { createdAt: "2026-08-24T10:00:00Z" }),
    fixturePipeline("p2", { createdAt: "2026-09-10T10:00:00Z", reviewScaffold: REVIEWER_NEW }),
    fixturePipeline("p3", { createdAt: "2026-09-10T10:00:00Z", project: "repo-other", repoDir: "/work/elsewhere" }),
    fixturePipeline("p4", { createdAt: "2026-09-10T10:00:00Z", project: "repo-other", repoDir: "/work/elsewhere", state: "running" }),
  ];
  const rows: LedgerRow[] = ledgerRows(pipelines, thisProjectMatcher(pipelines, "/work/main"), null);
  const report = buildReport(rows, null, { iterations: 50, seed: 1, minVersionN: 1 });
  // The split and marker counts the prose cites come from the generated section.
  expect(report.markdown).toContain("Pipelines: this repository 2 pipelines, 2 finished, 2 with a fail edge, 2 of those passed; other repositories 2 pipelines, 1 finished, 2 with a fail edge, 1 of those passed. 3 of 3 finished pipelines (100.0 %) carry a WRONG-PREMISE finding.");
  expect(report.markdown).toContain("## Noise band");
  expect(report.markdown).toContain("## The pre-registered replay");
  expect(report.markdown).toContain("## Harness versions");
  expect(report.markdown).toContain(`### reviewer \`${scaffoldHash(REVIEWER_NEW)}\``);
  expect(report.verdict).toBe("value disproved");
});
