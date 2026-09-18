import { expect, test } from "bun:test";

import type { Pipeline, PipelineEdgeActivation, PipelineStage } from "@/lib/pipelines/types";

import { edgeCount, returnsInto, stageIdentity } from "./stageIdentity";

/*
 * The data model behind graph slice 5 (#1743): what a stage says it runs on,
 * and how often an edge fired. Nothing here touches copy or the DOM.
 *
 * The pipeline under test is the shape the operator watches: `build` passes to
 * `review`, and `review`'s fail edge returns the work to `build` with a budget
 * of two.
 */

const role = (over: Record<string, unknown> = {}) =>
  ({ roleId: "builder", engine: "claude", model: "opus", effort: "high", access: "read-write", promptScaffold: null, ...over }) as never;

const BUILD: PipelineStage = {
  id: "build", kind: "run", prompt: "Build.", next: "review", onFail: null, role: { roleId: "builder" }, effectiveRole: role(),
} as unknown as PipelineStage;
const REVIEW: PipelineStage = {
  id: "review", kind: "run", prompt: "Review.", next: null, onFail: { to: "build", maxRounds: 2 },
  role: { roleId: "reviewer" }, effectiveRole: role({ roleId: "reviewer", model: "opus", effort: "medium" }),
} as unknown as PipelineStage;

const sentBack = (attempt: number): PipelineEdgeActivation => ({ stageId: "review", attempt, edge: "fail" });
const passedOn = (attempt: number): PipelineEdgeActivation => ({ stageId: "build", attempt, edge: "pass" });

function attempt(n: number, over: Record<string, unknown> = {}) {
  return { n, state: "passed", activatedBy: null, historical: false, effectiveRole: role(), ...over } as never;
}

function pipeline(stages: PipelineStage[], runs: Array<{ stageId: string; attempts: unknown[] }>): Pipeline {
  return { id: "p", stages, runs, cursor: null, state: "running" } as unknown as Pipeline;
}

const FAIL_EDGE = { from: "review", to: "build", kind: "fail" as const, maxRounds: 2 };
const PASS_EDGE = { from: "build", to: "review", kind: "pass" as const };

/* ── Edge counts ──────────────────────────────────────────────────────────── */

test("one return reads a travelled fail edge that fired once, with budget left", () => {
  const record = pipeline([BUILD, REVIEW], [
    { stageId: "build", attempts: [attempt(1), attempt(2, { state: "running", activatedBy: sentBack(1) })] },
    { stageId: "review", attempts: [attempt(1, { state: "failed", activatedBy: passedOn(1) })] },
  ]);
  expect(edgeCount(record, FAIL_EDGE)).toEqual({ fired: 1, max: 2, travelled: true, exhausted: false });
});

test("several returns read as several, each from its own source attempt", () => {
  const record = pipeline([BUILD, REVIEW], [
    { stageId: "build", attempts: [
      attempt(1),
      attempt(2, { activatedBy: sentBack(1) }),
      attempt(3, { state: "running", activatedBy: sentBack(2) }),
    ] },
    { stageId: "review", attempts: [
      attempt(1, { state: "failed", activatedBy: passedOn(1) }),
      attempt(2, { state: "failed", activatedBy: passedOn(2) }),
    ] },
  ]);
  expect(edgeCount(record, FAIL_EDGE).fired).toBe(2);
});

test("a manual retry of the target is not a return: the arrow still reads one", () => {
  /* The first `build` respawn died, and the operator retried the stage twice.
     All three attempts carry the SAME activation, so one round was spent. */
  const record = pipeline([BUILD, REVIEW], [
    { stageId: "build", attempts: [
      attempt(1),
      attempt(2, { state: "failed", activatedBy: sentBack(1) }),
      attempt(3, { state: "failed", activatedBy: sentBack(1) }),
      attempt(4, { state: "running", activatedBy: sentBack(1) }),
    ] },
    { stageId: "review", attempts: [attempt(1, { state: "failed", activatedBy: passedOn(1) })] },
  ]);
  expect(edgeCount(record, FAIL_EDGE).fired).toBe(1);
});

test("an exhausted budget is marked exhausted once the returns reach the maximum", () => {
  const record = pipeline([BUILD, REVIEW], [
    { stageId: "build", attempts: [
      attempt(1),
      attempt(2, { activatedBy: sentBack(1) }),
      attempt(3, { activatedBy: sentBack(2) }),
    ] },
    { stageId: "review", attempts: [
      attempt(1, { state: "failed", activatedBy: passedOn(1) }),
      attempt(2, { state: "failed", activatedBy: passedOn(2) }),
      attempt(3, { state: "failed", activatedBy: passedOn(3) }),
    ] },
  ]);
  expect(edgeCount(record, FAIL_EDGE)).toEqual({ fired: 2, max: 2, travelled: true, exhausted: true });
});

test("a pass edge is counted the same way and carries no budget", () => {
  const record = pipeline([BUILD, REVIEW], [
    { stageId: "build", attempts: [attempt(1), attempt(2, { activatedBy: sentBack(1) })] },
    { stageId: "review", attempts: [
      attempt(1, { state: "failed", activatedBy: passedOn(1) }),
      attempt(2, { state: "running", activatedBy: passedOn(2) }),
    ] },
  ]);
  expect(edgeCount(record, PASS_EDGE)).toEqual({ fired: 2, max: null, travelled: true, exhausted: false });
});

test("an untravelled edge fired zero times and is not exhausted", () => {
  const record = pipeline([BUILD, REVIEW], [
    { stageId: "build", attempts: [attempt(1, { state: "running" })] },
    { stageId: "review", attempts: [] },
  ]);
  expect(edgeCount(record, FAIL_EDGE)).toEqual({ fired: 0, max: 2, travelled: false, exhausted: false });
  expect(edgeCount(record, PASS_EDGE).travelled).toBe(false);
});

test("lineage-adopted evidence never marks an edge travelled", () => {
  const record = pipeline([BUILD, REVIEW], [
    { stageId: "build", attempts: [attempt(1), attempt(2, { historical: true, activatedBy: sentBack(1) })] },
    { stageId: "review", attempts: [attempt(1, { state: "failed", activatedBy: passedOn(1) })] },
  ]);
  expect(edgeCount(record, FAIL_EDGE).fired).toBe(0);
});

test("a stage row says how often work came back to it, from the same edge rule", () => {
  const record = pipeline([BUILD, REVIEW], [
    { stageId: "build", attempts: [
      attempt(1),
      attempt(2, { activatedBy: sentBack(1) }),
      attempt(3, { state: "running", activatedBy: sentBack(2) }),
    ] },
    { stageId: "review", attempts: [
      attempt(1, { state: "failed", activatedBy: passedOn(1) }),
      attempt(2, { state: "failed", activatedBy: passedOn(2) }),
    ] },
  ]);
  /* Two of two used: the row that work returned to carries the count, and the
     stage that sent it back carries none. */
  expect(returnsInto(record, "build")).toEqual([{ fired: 2, max: 2, travelled: true, exhausted: true }]);
  expect(returnsInto(record, "review")).toEqual([]);
});

/* ── Launched values versus configured values ─────────────────────────────── */

test("a stage that has not launched shows its configuration, marked as configuration", () => {
  const record = pipeline([BUILD, REVIEW], [{ stageId: "build", attempts: [] }, { stageId: "review", attempts: [] }]);
  expect(stageIdentity(record, BUILD)).toEqual({
    engine: "claude", model: "opus", modelLabel: "Opus 5", effort: "high",
    source: "configured", modelIsDefault: true, next: null,
  });
});

test("an attempt recorded without the values it ran on falls back to the configuration, as configuration", () => {
  const record = pipeline([BUILD, REVIEW], [
    { stageId: "build", attempts: [attempt(1, { state: "passed", effectiveRole: undefined })] },
    { stageId: "review", attempts: [] },
  ]);
  const identity = stageIdentity(record, BUILD);
  expect(identity.source).toBe("configured");
  expect(identity.next).toBeNull();
  expect(identity.engine).toBe("claude");
});

test("a bound attempt that never left the queue is not a launch", () => {
  const record = pipeline([BUILD, REVIEW], [
    { stageId: "build", attempts: [attempt(1, { state: "pending", effectiveRole: role({ model: "haiku" }) })] },
  ]);
  const identity = stageIdentity(record, BUILD);
  expect(identity.source).toBe("configured");
  expect(identity.model).toBe("opus");
});

test("a stage that has run shows the values it was actually launched on, not the stage configuration", () => {
  /* The account fell back to Sonnet at launch; the stage still says Opus. */
  const record = pipeline([BUILD, REVIEW], [
    { stageId: "build", attempts: [attempt(1, { state: "running", effectiveRole: role({ model: "sonnet", effort: "medium" }) })] },
  ]);
  expect(stageIdentity(record, BUILD)).toEqual({
    engine: "claude", model: "sonnet", modelLabel: "Sonnet", effort: "medium",
    source: "launched", modelIsDefault: false, next: { engine: "claude", model: "opus", modelLabel: "Opus 5", effort: "high" },
  });
});

test("an edit made after the launch leaves the launched values on the node and names the next attempt", () => {
  const edited = { ...BUILD, effectiveRole: role({ engine: "codex", model: "gpt-5.6-terra", effort: "xhigh" }) } as PipelineStage;
  const record = pipeline([edited, REVIEW], [
    { stageId: "build", attempts: [attempt(1, { state: "passed" })] },
  ]);
  const identity = stageIdentity(record, edited);
  expect(identity.source).toBe("launched");
  expect(identity.engine).toBe("claude");
  expect(identity.next).toEqual({ engine: "codex", model: "gpt-5.6-terra", modelLabel: "5.6-Terra", effort: "xhigh" });
});

test("a launch that matches the configuration marks no next attempt", () => {
  const record = pipeline([BUILD, REVIEW], [
    { stageId: "build", attempts: [attempt(1, { state: "passed", effectiveRole: role() })] },
  ]);
  expect(stageIdentity(record, BUILD).next).toBeNull();
});

test("the latest own attempt wins, and lineage-adopted evidence is never it", () => {
  const record = pipeline([BUILD, REVIEW], [
    { stageId: "build", attempts: [
      attempt(1, { state: "passed", effectiveRole: role({ model: "haiku" }) }),
      attempt(2, { state: "running", effectiveRole: role({ model: "sonnet" }) }),
      attempt(3, { historical: true, effectiveRole: role({ model: "fable" }) }),
    ] },
  ]);
  expect(stageIdentity(record, BUILD).modelLabel).toBe("Sonnet");
});

test("a blank model resolves to the engine default, and an uncatalogued id keeps its own text", () => {
  const blank = { ...BUILD, effectiveRole: role({ engine: "codex", model: "", effort: "low" }) } as PipelineStage;
  const record = pipeline([blank, REVIEW], [{ stageId: "build", attempts: [] }]);
  const identity = stageIdentity(record, blank);
  expect(identity.modelIsDefault).toBe(true);
  expect(identity.modelLabel.length).toBeGreaterThan(0);

  const odd = { ...BUILD, effectiveRole: role({ engine: "claude", model: "opus-next-9", effort: "max" }) } as PipelineStage;
  const other = pipeline([odd, REVIEW], [{ stageId: "build", attempts: [] }]);
  expect(stageIdentity(other, odd).modelLabel).toBe("opus-next-9");
  expect(stageIdentity(other, odd).modelIsDefault).toBe(false);
});
