import { expect, test } from "bun:test";

import type { PipelineStage } from "./types";
import { graphDigest, isStageDigest, stageDigest, stageDigestInput, stageDigests } from "./stageDigest";

/* The digests graph edits are guarded by (#1695 C7, graph slice 1). */

const stage = (over: Partial<PipelineStage> = {}): PipelineStage => ({
  id: "build", kind: "run", role: { roleId: "builder", params: { depth: 2, lens: "correctness" } }, prompt: "{{prev.output}}\n\nBuild it.", next: null, account: "account-a",
  effectiveRole: { roleId: "builder", engine: "codex", model: "gpt-5.6", effort: "high", access: "read-write", promptScaffold: null },
  ...over,
}) as PipelineStage;

test("the digest is a SHA-256 hex over the canonical stage configuration", () => {
  const digest = stageDigest(stage());
  expect(isStageDigest(digest)).toBe(true);
  expect(JSON.parse(stageDigestInput(stage()))).toEqual({
    v: 3,
    "prompt": "{{prev.output}}\n\nBuild it.",
    account: "account-a",
    role: { roleId: "builder", params: { depth: 2, lens: "correctness" } },
    runtime: { roleId: "builder", engine: "codex", model: "gpt-5.6", effort: "high", access: "read-write", promptScaffold: null },
    next: null,
    onFail: null,
  });
  expect(stageDigests([stage(), stage({ id: "review", prompt: "Review." })])).toEqual({ build: digest, review: stageDigest(stage({ prompt: "Review." })) });
});

test("values that mean the same stage digest the same", () => {
  const base = stageDigest(stage({ account: undefined, role: { roleId: "builder" } }));
  expect(stageDigest(stage({ account: null, role: { roleId: "builder", params: {} } }))).toBe(base);
  expect(stageDigest(stage({ account: "   ", role: { roleId: "builder" } }))).toBe(base);
  expect(stageDigest(stage({ role: { roleId: "builder", params: { lens: "correctness", depth: 2 } } }))).toBe(stageDigest(stage()));
  expect(stageDigest(stage({ account: " account-a " }))).toBe(stageDigest(stage()));
  expect(stageDigest(stage({ effectiveRole: { ...stage().effectiveRole, promptScaffold: undefined as never } }))).toBe(stageDigest(stage()));
  expect(stageDigest(stage({ onFail: undefined }))).toBe(stageDigest(stage({ onFail: null })));
  /* Fields no graph edit changes do not move it. */
  expect(stageDigest(stage({ id: "other", kind: "run" } as Partial<PipelineStage>))).toBe(stageDigest(stage()));
});

test("every change an override can make digests differently", () => {
  const base = stageDigest(stage());
  const changed = [
    stage({ prompt: "{{prev.output}}\n\nBuild it again." }),
    stage({ prompt: "{{task}}\n\nBuild it." }),
    stage({ account: "account-b" }),
    stage({ account: null }),
    stage({ role: { roleId: "architect", params: { depth: 2, lens: "correctness" } } as PipelineStage["role"] }),
    stage({ role: { roleId: "builder", params: { depth: 3, lens: "correctness" } } }),
    stage({ role: undefined }),
    stage({ effectiveRole: { ...stage().effectiveRole, engine: "claude" } }),
    stage({ effectiveRole: { ...stage().effectiveRole, model: null } }),
    stage({ effectiveRole: { ...stage().effectiveRole, effort: "xhigh" } }),
    stage({ effectiveRole: { ...stage().effectiveRole, access: "read-only" } }),
    /* The role registry changed and an override re-resolved the same role: only the stored scaffold moved. */
    stage({ effectiveRole: { ...stage().effectiveRole, promptScaffold: "Builder guidance, revised" } }),
    stage({ effectiveRole: { ...stage().effectiveRole, roleId: null } }),
    /* The stage's edges (graph slice 1). */
    stage({ next: "review" }),
    stage({ onFail: { to: "plan", maxRounds: 2 } }),
    stage({ onFail: { to: "plan", maxRounds: 3 } }),
  ].map(stageDigest);
  expect(changed).not.toContain(base);
  expect(new Set(changed).size).toBe(changed.length);
});

test("the graph digest moves with any stage's digest and with the array order", () => {
  const one = stage({ id: "one", next: "two" });
  const two = stage({ id: "two", next: null });
  const base = graphDigest([one, two]);
  expect(isStageDigest(base)).toBe(true);
  expect(graphDigest([structuredClone(one), structuredClone(two)])).toBe(base);
  expect(graphDigest([two, one])).not.toBe(base);
  expect(graphDigest([one, stage({ id: "two", next: null, prompt: "Changed." })])).not.toBe(base);
  expect(graphDigest([one, two, stage({ id: "three", next: null })])).not.toBe(base);
});

test("only a 64-character lowercase hex string is a digest", () => {
  expect(isStageDigest("a".repeat(64))).toBe(true);
  for (const value of ["A".repeat(64), "a".repeat(63), `${"a".repeat(63)}g`, null, undefined, 42, ""]) expect(isStageDigest(value)).toBe(false);
});
