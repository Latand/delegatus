import { expect, test } from "bun:test";
import { selectCloudCheckConfig, type CloudCheckConfigSources } from "./cloud-check-config";
import type { Pipeline } from "../src/lib/pipelines/types";

const account = { engine: "codex" as const, accountId: "fixture", kind: "managed" as const,
  home: "/fixture/account", transcriptRoot: "/fixture/transcripts", env: { NODE_ENV: "test" as const } };
const stage = { id: "build", account: "chosen", effectiveRole: { engine: "codex" } };
const lane = { project: "repo-fixture", worktreeDir: "/fixture/checkout", stages: [stage] } as Pipeline;
function sources(overrides: Partial<CloudCheckConfigSources> = {}): CloudCheckConfigSources {
  return { lane: () => lane, project: () => "repo-fixture", environment: () => "asenvcfg_fixture",
    account: () => ({ kind: "available", account }), ...overrides };
}

test("unconfigured projects use the selected account's prepared binding and frozen task receipts survive later edits", () => {
  const selected = sources({ environment: () => "", preparedEnvironment: (_project, accountId) => `asenvcfg_${accountId}` });
  expect(selectCloudCheckConfig(lane.worktreeDir, "lane", "build", selected)).toMatchObject({ environmentId: "asenvcfg_fixture" });
  const withReceipt = { ...lane, runs: [{ stageId: "build", attempts: [{ accountId: "fixture", cloud: { taskId: "task-fixture", accountId: "fixture", environmentId: "asenvcfg_frozen" } }] }] } as Pipeline;
  const frozen = sources({ lane: () => withReceipt, environment: () => "asenvcfg_changed", preparedEnvironment: () => "asenvcfg_changed" });
  expect(selectCloudCheckConfig(lane.worktreeDir, "lane", "build", frozen)).toMatchObject({ environmentId: "asenvcfg_frozen" });
});

test("local projects and missing prepared bindings choose local checks without requiring a Codex account", () => {
  let accounts = 0;
  const selected = sources({ environment: () => "", preparedEnvironment: () => "", hasPreparedEnvironment: () => false,
    account: () => { accounts++; return { kind: "unavailable", allowedAccountIds: [] }; } });
  expect(selectCloudCheckConfig(lane.worktreeDir, "lane", "build", selected)).toBeNull();
  expect(accounts).toBe(0);
});

test("default checks use the managed project environment and Codex stage account", () => {
  const selections: unknown[] = [];
  expect(selectCloudCheckConfig(lane.worktreeDir, "lane", "build", sources({
    account: (project, requestedId) => { selections.push([project, requestedId]); return { kind: "available", account }; },
  }))).toMatchObject({ environmentId: "asenvcfg_fixture", account });
  expect(selections).toEqual([[lane.project, "chosen"]]);
});

test("a direct hook and a Claude stage select through the project's Codex pool", () => {
  const selections: unknown[] = [];
  const selected = sources({ account: (project, requestedId) => { selections.push([project, requestedId]); return { kind: "available", account }; } });
  selectCloudCheckConfig(lane.worktreeDir, undefined, undefined, selected);
  selectCloudCheckConfig(lane.worktreeDir, "lane", "build", { ...selected,
    lane: () => ({ ...lane, stages: [{ ...stage, effectiveRole: { engine: "claude" } }] } as Pipeline) });
  expect(selections).toEqual([[lane.project, null], [lane.project, null]]);
});

for (const environment of ["bad environment", "environment-legacy"]) test(`invalid setup refuses before account selection: ${environment}`, () => {
  let accounts = 0;
  expect(() => selectCloudCheckConfig(lane.worktreeDir, "lane", "build", sources({
    environment: () => environment, account: () => { accounts++; return { kind: "available", account }; },
  }))).toThrow("project's Codex Cloud environment");
  expect(accounts).toBe(0);
});

test("unconfigured projects select local checks before account selection", () => {
  let accounts = 0;
  const unconfigured = sources({ environment: () => "", account: () => { accounts++; throw new Error("must not select an account"); } });
  expect(selectCloudCheckConfig(lane.worktreeDir, "lane", "build", unconfigured)).toBeNull();
  expect(selectCloudCheckConfig(lane.worktreeDir, undefined, undefined, unconfigured)).toBeNull();
  expect(selectCloudCheckConfig(lane.worktreeDir, undefined, undefined, { ...unconfigured, project: () => null })).toBeNull();
  expect(accounts).toBe(0);
});

test("unknown lanes, foreign checkouts and unknown stages refuse", () => {
  expect(() => selectCloudCheckConfig(lane.worktreeDir, "missing", undefined, sources({ lane: () => null }))).toThrow("lane checkout");
  expect(() => selectCloudCheckConfig("/fixture/other", "lane", undefined, sources())).toThrow("lane checkout");
  expect(() => selectCloudCheckConfig(lane.worktreeDir, "lane", "missing", sources())).toThrow("lane stage");
});

test("project account refusals and exhaustion cannot select another account", () => {
  for (const kind of ["not_allowed", "exhausted", "unavailable"] as const) {
    expect(() => selectCloudCheckConfig(lane.worktreeDir, "lane", "build", sources({
      account: () => ({ kind, accountId: "chosen", resetsAt: null, allowedAccountIds: [] }),
    }))).toThrow(`account ${kind}`);
  }
});

test("resolved configuration rechecks environment and account authority", () => {
  let environment = "asenvcfg_fixture", allowed = true;
  const selected = selectCloudCheckConfig(lane.worktreeDir, "lane", "build", sources({
    environment: () => environment,
    account: () => allowed ? { kind: "available", account } : { kind: "unavailable", allowedAccountIds: [] },
  }));
  selected!.assertCurrent!();
  environment = "";
  expect(() => selected!.assertCurrent!()).toThrow("configuration changed");
  environment = "asenvcfg_other";
  expect(() => selected!.assertCurrent!()).toThrow("configuration changed");
  environment = "asenvcfg_fixture";
  allowed = false;
  expect(() => selected!.assertCurrent!()).toThrow("account unavailable");
});
