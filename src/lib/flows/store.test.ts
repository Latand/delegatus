import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CODEX_GPT61_SOL_MODEL, CODEX_TERRA_MODEL } from "@/lib/agent/models";
import { projectKeyIndexSnapshot } from "@/lib/projects/projectKeyIndex";

import { configuredReviewerFallback, loadPresets, savePresets, loadFlows, mergeSeededPresets, patchFlowRows, saveFlows, seededPresetsFromRoles, withFlowSnapshot, withFlowMutation } from "./store";
import type { Flow, FlowPreset } from "./types";

const LEGACY_DEFAULT: FlowPreset = {
  name: "Codex high → Fable",
  implementer: { engine: "codex", model: null, effort: "high" },
  reviewer: { engine: "claude", model: "fable", effort: null },
};

test("fresh seeds use Sol and preserve a saved legacy preset", () => {
  const presets = mergeSeededPresets([LEGACY_DEFAULT]);
  expect(presets.some((preset) => preset.name === LEGACY_DEFAULT.name)).toBe(true);
  expect(presets[0]).toMatchObject({
    name: "Builder → Reviewer",
    implementer: { engine: "codex", model: CODEX_GPT61_SOL_MODEL, effort: "high" },
    reviewer: { engine: "codex", model: CODEX_GPT61_SOL_MODEL, effort: "xhigh" },
  });
});

test("seed migration preserves a customized preset", () => {
  const custom = { ...LEGACY_DEFAULT, reviewer: { engine: "claude" as const, model: "fable", effort: "max" } };
  expect(mergeSeededPresets([custom])).toContainEqual(custom);
});

test("flow preset seeds derive their canonical roles from the role registry", () => {
  const presets = seededPresetsFromRoles();
  expect(presets.find((preset) => preset.name === "Builder → Reviewer")).toMatchObject({
    name: "Builder → Reviewer",
    implementer: { engine: "codex", model: CODEX_GPT61_SOL_MODEL, effort: "high" },
    reviewer: { engine: "codex", model: CODEX_GPT61_SOL_MODEL, effort: "xhigh" },
  });
});

test("saved flow seeds and unmarked same-name edits retain their selections", () => {
  const first = seededPresetsFromRoles();
  const refreshed = structuredClone(first);
  refreshed[0]!.implementer.effort = "medium";
  expect(mergeSeededPresets(first, refreshed)[0]!.implementer.effort).toBe("high");

  const custom = { ...structuredClone(first[0]!), managed: undefined, implementer: { ...first[0]!.implementer, effort: "low" } };
  expect(mergeSeededPresets([custom], refreshed)).toContainEqual(custom);
});

test("flow preset seeds fall back to the role default when a saved builder override is semantically invalid", () => {
  const previousState = process.env.LLV_STATE_DIR;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-flow-bad-override-"));
  process.env.LLV_STATE_DIR = sandbox;
  try {
    /* saveRoleOverrides refuses this override on this branch, so the bytes
       land via a hand-edit; the fail-closed loader rejects the file and
       seeding degrades to the built-in defaults either way. */
    fs.writeFileSync(
      path.join(sandbox, "role-presets.json"),
      JSON.stringify({ schemaVersion: 1, overrides: { builder: { config: { model: "not-a-gpt-model" } } } }),
      "utf8",
    );
    expect(() => seededPresetsFromRoles()).not.toThrow();
    expect(seededPresetsFromRoles().find((preset) => preset.name === "Builder → Reviewer")?.implementer).toEqual({
      engine: "codex",
      model: CODEX_GPT61_SOL_MODEL,
      effort: "high",
    });
  } finally {
    if (previousState === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousState;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("new role seeds coexist with a saved pre-registry flow preset", () => {
  const previous = {
    name: "Terra high → Fable",
    implementer: { engine: "codex" as const, model: CODEX_TERRA_MODEL, effort: "high" },
    reviewer: { engine: "claude" as const, model: "fable", effort: null },
  };
  expect(mergeSeededPresets([previous])).toContainEqual(previous);
  expect(mergeSeededPresets([previous]).find((preset) => preset.name === "Builder → Architect")?.reviewer).toEqual({
    engine: "claude",
    model: "opus",
    effort: "xhigh",
  });
});

test("flow specs persist in SQLite and legacy flow entries import on first boot", () => {
  const previousState = process.env.LLV_STATE_DIR;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-flow-spec-"));
  process.env.LLV_STATE_DIR = sandbox;
  const flow = {
    id: "spec-flow",
    template: "implement-review-loop",
    project: "repo",
    cwd: "/repo",
    implementerPath: "/implementer.jsonl",
    roles: { implementer: { engine: "codex" as const, model: null, effort: "high" }, reviewer: { engine: "codex" as const, model: null, effort: "xhigh" } },
    baseRef: "base",
    baseMode: "head" as const,
    mode: "auto" as const,
    reviewerMode: "headless" as const,
    roundLimit: 5,
    state: "waiting_ready" as const,
    stateDetail: null,
    rounds: [],
    createdAt: "now",
    closedAt: null,
  } satisfies Flow;
  let legacySandbox: string | null = null;
  try {
    saveFlows([{ ...flow, spec: "Ship the feature\nAC1: Reviewer receives this context" }]);
    expect(loadFlows()).toMatchObject([{ spec: "Ship the feature\nAC1: Reviewer receives this context" }]);
    expect(fs.existsSync(path.join(sandbox, "state.sqlite"))).toBe(true);
    /* A read or steady-state write does not churn the rollback mirror. */
    expect(fs.existsSync(path.join(sandbox, "flows.json"))).toBe(false);

    legacySandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-flow-legacy-import-"));
    process.env.LLV_STATE_DIR = legacySandbox;
    fs.writeFileSync(path.join(legacySandbox, "flows.json"), JSON.stringify({ flows: [flow] }));
    expect(loadFlows()).toEqual([{
      ...flow,
      revision: 0,
      targetSha: null,
      implementerConversationId: null,
      reviewerFallback: configuredReviewerFallback(),
      pausedState: null,
      kickoffDelivery: null,
      hostClaim: null,
    }]);
  } finally {
    if (previousState === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousState;
    fs.rmSync(sandbox, { recursive: true, force: true });
    if (legacySandbox) fs.rmSync(legacySandbox, { recursive: true, force: true });
  }
});

test("warm flow reads reuse cached project membership", () => {
  const previousState = process.env.LLV_STATE_DIR;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-flow-project-membership-"));
  process.env.LLV_STATE_DIR = sandbox;
  const flow = {
    id: "membership-flow", template: "implement-review-loop", project: "repo", cwd: "/repo",
    implementerPath: "/implementer.jsonl",
    roles: { implementer: { engine: "codex" as const, model: null, effort: "high" }, reviewer: { engine: "codex" as const, model: null, effort: "xhigh" } },
    baseRef: "base", baseMode: "head" as const, mode: "auto" as const, reviewerMode: "headless" as const,
    roundLimit: 5, state: "waiting_ready" as const, stateDetail: null, rounds: [], createdAt: "now", closedAt: null,
  } satisfies Flow;
  try {
    saveFlows([flow]);
    const expected = loadFlows();
    const stat = spyOn(fs, "statSync");
    try {
      for (let pass = 0; pass < 3; pass++) expect(loadFlows()).toEqual(expected);
      expect(stat.mock.calls.filter(([filename]) => String(filename).endsWith("project-aliases.json")).length).toBeLessThanOrEqual(3);
    } finally { stat.mockRestore(); }
    fs.writeFileSync(path.join(sandbox, "project-aliases.json"), JSON.stringify({ schemaVersion: 1, aliases: { repo: "renamed-project" }, displayNames: {} }));
    loadFlows();
    expect(projectKeyIndexSnapshot().has("renamed-project")).toBe(true);
  } finally {
    if (previousState === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousState;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("flow row patches hold the latest-row merge and commit under one process-shared lease", async () => {
  const previousState = process.env.LLV_STATE_DIR;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-flow-atomic-patch-"));
  process.env.LLV_STATE_DIR = sandbox;
  const flow = {
    id: "atomic-patch-flow",
    template: "implement-review-loop",
    project: "repo",
    cwd: "/repo",
    implementerPath: "/implementer.jsonl",
    roles: { implementer: { engine: "codex" as const, model: null, effort: "high" }, reviewer: { engine: "codex" as const, model: null, effort: "xhigh" } },
    baseRef: "base",
    baseMode: "head" as const,
    mode: "auto" as const,
    reviewerMode: "headless" as const,
    roundLimit: 5,
    state: "waiting_ready" as const,
    stateDetail: null,
    rounds: [],
    createdAt: "now",
    closedAt: null,
  } satisfies Flow;
  const resultFile = path.join(sandbox, "writer-result.json");
  const readyFile = path.join(sandbox, "writer-ready");
  const releaseFile = path.join(sandbox, "writer-release");
  let child: ReturnType<typeof Bun.spawn> | null = null;
  try {
    saveFlows([flow]);
    child = Bun.spawn({
      cmd: [process.execPath, path.join(import.meta.dir, "../state/hotStateAuthority.sqliteChild.ts"), resultFile, "write", readyFile, releaseFile],
      cwd: process.cwd(), env: { ...process.env, LLV_STATE_DIR: sandbox }, stdout: "pipe", stderr: "pipe",
    });
    const deadline = performance.now() + 4_000;
    while (!fs.existsSync(readyFile)) {
      if (child.exitCode !== null || performance.now() >= deadline) throw new Error("cross-process writer did not finish its read");
      await Bun.sleep(5);
    }
    patchFlowRows([flow.id], current => {
      // The peer holds the previous committed generation and can only save
      // after this collection lease is released.
      fs.writeFileSync(releaseFile, "write");
      expect(fs.existsSync(resultFile)).toBe(false);
      current[0]!.stateDetail = "atomic-patch";
      return current;
    });
    expect(await child.exited).toBe(0);
    expect(JSON.parse(fs.readFileSync(resultFile, "utf8"))).toMatchObject({ ok: true });
    expect(loadFlows()[0]!.stateDetail).toBe("atomic-patch");
  } finally {
    if (child?.exitCode === null) child.kill();
    if (child) await child.exited;
    if (previousState === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousState;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("legacy flow rounds import with current relay retry defaults", () => {
  const previousState = process.env.LLV_STATE_DIR;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-flow-relay-defaults-"));
  process.env.LLV_STATE_DIR = sandbox;
  try {
    const legacy = {
      id: "legacy-relay-defaults",
      template: "implement-review-loop",
      project: "repo",
      cwd: "/repo",
      implementerPath: "/implementer.jsonl",
      roles: {
        implementer: { engine: "codex", model: null, effort: "high" },
        reviewer: { engine: "codex", model: null, effort: "xhigh" },
      },
      baseRef: "base",
      baseMode: "head",
      mode: "auto",
      reviewerMode: "headless",
      roundLimit: 5,
      state: "relay_pending",
      stateDetail: null,
      rounds: [{
        n: 1,
        reviewerPath: "/reviewer.jsonl",
        findingsPath: "/findings.md",
        triggeredBy: "marker",
        readyNote: null,
        verdict: "REQUEST_CHANGES",
        findingsCount: 1,
        startedAt: "2026-08-05T00:00:00.000Z",
        reviewedAt: "2026-08-05T00:01:00.000Z",
        relayedAt: null,
        error: null,
      }],
      createdAt: "2026-08-05T00:00:00.000Z",
      closedAt: null,
    };
    fs.writeFileSync(path.join(sandbox, "flows.json"), JSON.stringify({ flows: [legacy] }));
    expect(loadFlows()[0]!.rounds[0]).toMatchObject({
      relayRetryCount: 0,
      relayDeliveryAttempt: 0,
      relayDeliveryTransport: null,
      relayRetryAt: null,
      relayRetryRequiresIdempotency: false,
    });
  } finally {
    if (previousState === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousState;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("flow persistence assigns a monotonic revision to binding-only generations", () => {
  const previousState = process.env.LLV_STATE_DIR;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-flow-revision-"));
  process.env.LLV_STATE_DIR = sandbox;
  const flow = {
    id: "revision-flow",
    template: "implement-review-loop",
    project: "repo",
    cwd: "/repo",
    implementerPath: "/implementer.jsonl",
    roles: { implementer: { engine: "codex" as const, model: null, effort: "high" }, reviewer: { engine: "codex" as const, model: null, effort: "xhigh" } },
    baseRef: "base",
    baseMode: "head" as const,
    mode: "auto" as const,
    reviewerMode: "headless" as const,
    roundLimit: 5,
    state: "reviewing" as const,
    stateDetail: null,
    rounds: [{
      n: 1,
      reviewerPath: "/reviewer-new.jsonl",
      findingsPath: null,
      triggeredBy: "marker" as const,
      readyNote: null,
      verdict: null,
      findingsCount: null,
      startedAt: "2026-07-22T10:00:00.000Z",
      reviewedAt: null,
      relayedAt: null,
      error: null,
      providerLimitWait: { resetsAt: null, startedAt: "2026-07-22T10:00:00.000Z", capacityProbes: 1 },
    }],
    createdAt: "2026-07-22T10:00:00.000Z",
    closedAt: null,
  } satisfies Flow;
  try {
    saveFlows([flow]);
    loadFlows(); // Prime the persisted snapshot cache.
    const first = loadFlows()[0]!;
    expect(first.revision).toBe(1);
    first.rounds[0]!.providerLimitWait!.capacityProbes = 2;
    expect(loadFlows()[0]!.rounds[0]!.providerLimitWait!.capacityProbes).toBe(1);

    first.rounds[0]!.reviewerPath = "/reviewer-next.jsonl";
    saveFlows([first]);
    expect(loadFlows()[0]).toMatchObject({
      revision: 2,
      rounds: [{ reviewerPath: "/reviewer-next.jsonl" }],
    });
    expect(loadFlows()[0]!.rounds[0]!.providerLimitWait!.capacityProbes).toBe(2);
  } finally {
    if (previousState === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousState;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("a delayed stale flow writer cannot replace a newer lifecycle generation", () => {
  const previousState = process.env.LLV_STATE_DIR;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-flow-stale-writer-"));
  process.env.LLV_STATE_DIR = sandbox;
  try {
    const flow = {
      id: "stale-writer-flow",
      template: "implement-review-loop",
      project: "repo",
      cwd: "/repo",
      implementerPath: "/implementer.jsonl",
      roles: { implementer: { engine: "codex" as const, model: null, effort: "high" }, reviewer: { engine: "codex" as const, model: null, effort: "xhigh" } },
      baseRef: "base",
      baseMode: "head" as const,
      mode: "auto" as const,
      reviewerMode: "headless" as const,
      roundLimit: 5,
      state: "reviewing" as const,
      stateDetail: null,
      rounds: [],
      createdAt: "2026-07-22T10:00:00.000Z",
      closedAt: null,
    } satisfies Flow;
    saveFlows([flow]);
    const stale = structuredClone(loadFlows()[0]!);
    const current = loadFlows()[0]!;
    current.state = "needs_decision";
    current.stateDetail = "review host was lost";
    saveFlows([current]);
    expect(loadFlows()[0]!.revision).toBe(2);

    stale.state = "reviewing";
    stale.stateDetail = null;
    saveFlows([stale]);

    expect(loadFlows()[0]).toMatchObject({
      revision: 2,
      state: "needs_decision",
      stateDetail: "review host was lost",
    });
    expect(stale).toMatchObject({
      revision: 2,
      state: "needs_decision",
      stateDetail: "review host was lost",
    });
  } finally {
    if (previousState === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousState;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("seed presets survive an unreadable role overrides file", () => {
  const previous = process.env.LLV_STATE_DIR;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-flow-seed-corrupt-"));
  process.env.LLV_STATE_DIR = sandbox;
  try {
    fs.writeFileSync(path.join(sandbox, "role-presets.json"), "{", "utf8");
    expect(seededPresetsFromRoles().find((preset) => preset.name === "Builder → Reviewer")).toMatchObject({
      implementer: { engine: "codex", model: CODEX_GPT61_SOL_MODEL, effort: "high" },
    });
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

for (const managed of [undefined, "role-registry"] as const) {
  test(`saved Sol presets survive repeated loads (managed=${managed})`, () => {
    const previous = process.env.LLV_STATE_DIR;
    const state = fs.mkdtempSync(path.join(os.tmpdir(), "llv-saved-sol-"));
    process.env.LLV_STATE_DIR = state;
    try {
      const saved = structuredClone(seededPresetsFromRoles()[0]!);
      saved.managed = managed;
      saved.implementer.model = "gpt-5.6-sol";
      savePresets([saved]);
      expect(loadPresets()).toContainEqual(saved);
      expect(loadPresets()).toContainEqual(saved);
    } finally {
      if (previous === undefined) delete process.env.LLV_STATE_DIR;
      else process.env.LLV_STATE_DIR = previous;
      fs.rmSync(state, { recursive: true, force: true });
    }
  });
}


test("a flow snapshot retains its lease until an asynchronous cross-store checkpoint settles", async () => {
  const previous = process.env.LLV_STATE_DIR;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "flow-snapshot-wait-"));
  process.env.LLV_STATE_DIR = sandbox;
  let release!: () => void, admitted!: () => void;
  const ready = new Promise<void>(resolve => { admitted = resolve; });
  let snapshot: Promise<unknown> | undefined, writer: Promise<unknown> | undefined;
  try {
    snapshot = withFlowSnapshot(async () => { admitted(); await new Promise<void>(resolve => { release = resolve; }); });
    await ready;
    let entered = false;
    writer = withFlowMutation(() => { entered = true; });
    await Bun.sleep(80);
    expect(entered).toBe(false);
    release(); await snapshot; await writer;
    expect(entered).toBe(true);
  } finally {
    release?.(); await snapshot?.catch(() => {}); await writer?.catch(() => {});
    if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
