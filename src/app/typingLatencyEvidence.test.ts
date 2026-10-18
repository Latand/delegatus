import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

/*
 * The run-level typing measurements the pull request cites are retained in
 * evidence/typing-latency/campaigns.json. These read the record itself: that it
 * names the revisions, the fixtures' fingerprints and the procedure, that base and
 * head alternate inside every repetition, that its summaries are the medians of its
 * own runs, and that the final head meets the limits on every scenario it measured.
 */
interface Run { seq: number; variant: "base" | "head"; scenario: string; fixture: string; rep: number; load1: number; chars: number; reported: number; p50: number; p90: number; max: number }
interface Summary { scenario: string; fixture: string; variant: string; runs: number; medianP50: number; medianP90: number; worstP90: number; runsWithinLimits: number }
interface Campaign { name: string; head: string; runs: Run[]; summary: Summary[] }

const dir = path.resolve(import.meta.dir, "../../evidence/typing-latency");
const record = JSON.parse(fs.readFileSync(path.join(dir, "campaigns.json"), "utf8")) as {
  schemaVersion: number;
  revisions: { base: { commit: string }; heads: { commit: string }[] };
  fixtures: Record<string, { sha256?: string; bytes?: number }>;
  limits: { p50Ms: number; p90Ms: number };
  campaigns: Campaign[];
  controls: { name: string; runs: unknown[] }[];
};

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
const groups = (runs: Run[]) => {
  const out = new Map<string, Run[]>();
  for (const run of runs) out.set(`${run.scenario}|${run.fixture}|${run.variant}`, [...(out.get(`${run.scenario}|${run.fixture}|${run.variant}`) ?? []), run]);
  return out;
};

test("the record names its revisions, fixture fingerprints and procedure", () => {
  expect(record.schemaVersion).toBe(2);
  for (const commit of [record.revisions.base.commit, ...record.revisions.heads.map((head) => head.commit)]) expect(commit).toMatch(/^[0-9a-f]{40}$/);
  for (const name of ["seat-current", "seat-long"]) {
    expect(record.fixtures[name]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(record.fixtures[name]!.bytes).toBeGreaterThan(1_000_000);
  }
  expect(record.fixtures["seat-over-board"]).toBeDefined();
  const procedure = fs.readFileSync(path.join(dir, "procedure.md"), "utf8");
  for (const heading of ["## Setup", "## Reading the numbers", "## measure.mjs", "## board-measure.ts", "## campaign.sh"]) expect(procedure).toContain(heading);
  expect(record.controls.length).toBeGreaterThan(0);
  for (const control of record.controls) expect(control.runs.length).toBeGreaterThan(0);
});

test("base and head alternate inside every repetition and every run carries its load", () => {
  for (const campaign of record.campaigns) {
    expect(record.revisions.heads.some((head) => head.commit.startsWith(campaign.head))).toBe(true);
    const reps = [...new Set(campaign.runs.map((run) => run.rep))].sort((a, b) => a - b);
    expect(reps).toEqual(reps.map((_, index) => index + 1));
    for (const rep of reps) {
      const inRep = campaign.runs.filter((run) => run.rep === rep).sort((a, b) => a.seq - b.seq);
      expect(inRep[0]!.variant).toBe(rep % 2 ? "base" : "head");
      for (const [key, runs] of groups(inRep)) expect({ key, count: runs.length }).toEqual({ key, count: 1 });
      expect(new Set(inRep.map((run) => run.variant))).toEqual(new Set(["base", "head"]));
    }
    for (const run of campaign.runs) {
      expect(Number.isFinite(run.load1)).toBe(true);
      expect(run.chars).toBeGreaterThan(50);
      expect(run.p90).toBeGreaterThanOrEqual(run.p50);
      expect(run.max).toBeGreaterThanOrEqual(run.p90);
    }
  }
});

test("each summary is the median of the runs it names", () => {
  for (const campaign of record.campaigns) {
    const byKey = groups(campaign.runs);
    expect(campaign.summary.length).toBe(byKey.size);
    for (const summary of campaign.summary) {
      const runs = byKey.get(`${summary.scenario}|${summary.fixture}|${summary.variant}`)!;
      expect(summary.runs).toBe(runs.length);
      expect(summary.medianP50).toBe(median(runs.map((run) => run.p50)));
      expect(summary.medianP90).toBe(median(runs.map((run) => run.p90)));
      expect(summary.worstP90).toBe(Math.max(...runs.map((run) => run.p90)));
      expect(summary.runsWithinLimits).toBe(runs.filter((run) => run.p50 <= record.limits.p50Ms && run.p90 <= record.limits.p90Ms).length);
    }
  }
});

test("the final head meets the limits on the seat conversation and on the seat over the board, in at least three repetitions", () => {
  const final = record.campaigns.find((campaign) => campaign.name === "final")!;
  expect(final.head).toBe(record.revisions.heads.at(-1)!.commit.slice(0, final.head.length));
  const heads = final.summary.filter((summary) => summary.variant === "head");
  expect(new Set(heads.map((summary) => summary.scenario))).toEqual(new Set(["ring", "reduced", "board-baseline", "board-ring", "board-breathe8"]));
  expect(new Set(heads.filter((summary) => summary.scenario === "ring").map((summary) => summary.fixture))).toEqual(new Set(["seat-current", "seat-long"]));
  for (const summary of heads) {
    expect(summary.runs).toBeGreaterThanOrEqual(3);
    expect({ scenario: summary.scenario, fixture: summary.fixture, p50: summary.medianP50 <= record.limits.p50Ms }).toEqual({ scenario: summary.scenario, fixture: summary.fixture, p50: true });
    expect({ scenario: summary.scenario, fixture: summary.fixture, p90: summary.medianP90 <= record.limits.p90Ms }).toEqual({ scenario: summary.scenario, fixture: summary.fixture, p90: true });
  }
});
