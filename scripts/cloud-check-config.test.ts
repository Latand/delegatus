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


const servingCases = [
  { version: 5, archived: false, fault: "" }, { version: 6, archived: false, fault: "" },
  { version: 5, archived: true, fault: "" }, { version: 6, archived: true, fault: "" },
  { version: 5, archived: false, fault: "mixed" }, { version: 5, archived: false, fault: "missing" },
  { version: 5, archived: false, fault: "future" }, { version: 5, archived: false, fault: "migration" },
] as const;
for (const { version, archived, fault } of servingCases) test(`Cloud discovery reads serving format ${version}, archive=${archived}, fault=${fault || "none"} without startup mutation`, async () => {
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
  const { Database } = await import("bun:sqlite");
  const { buildPipeline, pipelineStateCollectionSeeds, isStoredPipeline } = await import("../src/lib/pipelines/store");
  const { initializeStateCollections } = await import("../src/lib/state/sqliteStateStore");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "checks-read-"));
  const home = path.join(dir, "home"), scratch = path.join(dir, "tmp"), checkout = path.join(dir, "checkout-pipeline-checks-lane");
  const state = path.join(home, ".config", "delegatus", "state"), filename = path.join(state, "state.sqlite");
  for (const entry of [state, scratch, checkout]) fs.mkdirSync(entry, { recursive: true });
  try {
    const record = buildPipeline({ id: "checks-lane", task: "Check publication", project: "fixture", repoDir: path.join(dir, "checkout"),
      stages: [{ id: "build", kind: "run", prompt: "Build", next: null,
        effectiveRole: { roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null } }],
      srcPath: null, srcConversationId: null, now: "2026-11-05T00:00:00.000Z" });
    expect(isStoredPipeline(record)).toBe(true);
    initializeStateCollections(filename, pipelineStateCollectionSeeds().map((seed, index) => ({ ...seed,
      schemaVersion: version, compatibleSchemaVersions: undefined, loadRecords: () => index === (archived ? 1 : 0) ? [record] : [] })));
    const db = new Database(filename);
    db.exec("DROP INDEX pipeline_repository_resolver_capacity");
    if (fault === "mixed") db.exec("UPDATE state_collections SET schema_version=6 WHERE collection='pipelines_archive'");
    if (fault === "missing") db.exec("DELETE FROM state_collections WHERE collection='pipelines_archive'");
    if (fault === "future") db.exec("UPDATE state_collections SET schema_version=7");
    if (fault === "migration") db.exec("UPDATE state_collections SET migration_id='unknown' WHERE collection='pipelines'");
    fs.writeFileSync(path.join(state, "pipelines.json"), "stale invalid mirror");
    fs.writeFileSync(path.join(state, "pipelines-archive.json"), "stale invalid mirror");
    const snapshot = () => JSON.stringify({
      schema: db.query("SELECT name,sql FROM sqlite_master ORDER BY name").all(),
      markers: db.query("SELECT * FROM state_collections ORDER BY collection").all(),
      rows: db.query("SELECT * FROM state_rows ORDER BY collection,row_key").all(),
      changes: db.query("SELECT * FROM state_changes ORDER BY collection,revision,row_key").all(),
    });
    const before = snapshot();
    try {
      const child = Bun.spawn([process.execPath, "-e", `
        const { setStateOwnershipPathsForTests } = await import("./src/lib/stateOwnership.ts");
        setStateOwnershipPathsForTests({ home: process.env.HOME, tempRoots: [process.env.TMPDIR] });
        const { cloudCheckConfig } = await import("./scripts/cloud-check-config.ts");
        let refused = false;
        try {
          const result = await cloudCheckConfig(process.env.CHECKOUT, "checks-lane", "build");
          if (result !== null) throw new Error("unconfigured checks changed execution selection");
        } catch (error) {
          if (!process.env.CHECK_FAULT || !String(error).includes("complete recognized format five or six pair")) throw error;
          refused = true;
        }
        if (refused !== Boolean(process.env.CHECK_FAULT)) throw new Error("incompatible configuration was accepted");
        if (!refused && ${version} === 5) {
          const { findPipelineRecord } = await import("./src/lib/pipelines/store.ts");
          let blocked = false;
          try { findPipelineRecord("checks-lane"); }
          catch (error) { if (error?.name !== "StateStartupMutationRefused") throw error; blocked = true; }
          if (!blocked) throw new Error("controller startup no longer requires its owner");
        }
      `], { cwd: path.resolve(import.meta.dir, ".."), env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"),
        LLV_STATE_OWNER: "tool", LLV_STATE_DIR: state, LLV_GATE_STATE_DIR: state, TMPDIR: scratch, NODE_ENV: "production", CHECKOUT: checkout, CHECK_FAULT: fault },
        stdout: "pipe", stderr: "pipe" });
      const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, output + errors).toBe(0);
      expect(snapshot()).toBe(before);
    } finally { db.close(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}, 30_000);
