import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, spyOn, test } from "bun:test";
import { buildPipeline, savePipelines } from "@/lib/pipelines/store";
import type { PipelineStageAttempt } from "@/lib/pipelines/types";
import { materializeStructuredHostAccess } from "./structuredSpawn";
import { withAgentConfigSandbox } from "./agentConfigSandbox";
import { runTempSweep, sweepStaleTempDirs } from "@/lib/tempSweep";
import { statePath } from "@/lib/configDir";

const roots: string[] = [];
afterEach(() => { savePipelines([]); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

test("production settlement retires the attempt scratch and config sandbox", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-stage-production-")); roots.push(root);
  const role = { roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null } as const;
  const pipeline = buildPipeline({ id: "temp-lane", task: "Temp lifetime", project: "fixture", repoDir: root,
    stages: [{ id: "build", kind: "run", prompt: "Fixture", next: null, effectiveRole: role }],
    srcPath: null, srcConversationId: null, now: "2026-10-22T12:00:00Z" });
  pipeline.state = "running";
  const attempt: PipelineStageAttempt = { n: 1, state: "passed", launchId: "temp-launch", effectiveRole: role,
    conversationId: "fixture-conversation", sessionId: null, agentPath: null, paneId: null, flowId: null,
    startedAt: "2026-10-22T12:00:00Z", completedAt: "2026-10-22T12:01:00Z", input: null, activatedBy: null,
    output: "done", verdict: { status: "pass" }, error: null };
  pipeline.runs = [{ stageId: "build", attempts: [attempt] }];
  savePipelines([pipeline]);
  const access = materializeStructuredHostAccess({ readOnly: false, sandbox: "full" }, { ...process.env }, null, root,
    { pipelineId: pipeline.id, launchId: "temp-launch", retainUntilClose: false });
  const sandbox = access.env.LLV_AGENT_SANDBOX_ROOT;
  if (sandbox) roots.push(sandbox);
  const child = withAgentConfigSandbox({ NODE_ENV: "test" }, access.env);
  fs.writeFileSync(path.join(access.env.TMPDIR!, "review-export"), "settled scratch");
  // Main has no attempt retirement tick: its existing stale sweep leaves the
  // fresh settled root behind. This fallback makes that regression observable.
  const modulePath = "./attemptTempProduction";
  const production = await import(modulePath).catch(() => null);
  if (production) {
    const { AttemptTempStore, sweepAttemptTemps } = await import("./attemptTempRetention");
    const store = new AttemptTempStore();
    try { await sweepAttemptTemps(store, { state: production.attemptTempState, scan: () => ({ ownNamespace: null, processes: [] }) }); }
    finally { store.close(); }
  } else {
    await sweepStaleTempDirs({ roots: [{ path: root, via: "" }], maxAgeMs: 86400000, scan: { ownNamespace: null, processes: [] } });
  }
  expect(fs.existsSync(access.scratchDirectory!)).toBeFalse();
  if (sandbox) {
    expect(child.XDG_CONFIG_HOME).toBe(path.join(sandbox, "config"));
    expect(fs.existsSync(sandbox)).toBeFalse();
  }
});


test("foreign and gate-named directories with no creation record survive registration, the capped tick and the legacy sweep", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-foreign-survival-")); roots.push(root);
  const foreign = ["merge-gate-state-fixture", "merge-privacy-state-fixture", "delegatus-local-gate-fixture", "delegatus-cpu-wait.fixture", "unrelated-project-cache"]
    .map(name => { const directory = path.join(root, name); fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, "data"), "foreign"); return directory; });
  const orphan = path.join(root, "llv-stage-orphan"); fs.mkdirSync(orphan); fs.writeFileSync(path.join(orphan, "data"), "owned");
  const { AttemptTempStore, sweepAttemptTemps } = await import("./attemptTempRetention");
  const production = await import("./attemptTempProduction");
  const store = new AttemptTempStore(path.join(root, "owners.sqlite"));
  const now = Date.now() + 30 * 86400000;
  try {
    for (const directory of foreign) {
      expect(() => store.register({ directory, pipelineId: null, launchId: "foreign", retainUntilClose: false, createdAt: 0 })).toThrow("not an owned directory");
      expect(fs.existsSync(path.join(directory, ".delegatus-attempt-owner"))).toBeFalse();
    }
    store.register({ directory: orphan, pipelineId: "missing-lane", launchId: "orphan", retainUntilClose: false, createdAt: now - 2 * 86400000 });
    const report = await sweepAttemptTemps(store, { now: () => now, state: production.attemptTempState,
      capBytes: 0, scan: () => ({ ownNamespace: null, processes: [] }) });
    expect(report.removed).toBe(1); expect(fs.existsSync(orphan)).toBeFalse();
    const legacy = await runTempSweep({ NODE_ENV: "test", LLV_TEMP_SWEEP: "on", LLV_TEMP_SWEEP_MAX_AGE_HOURS: "24" },
      { roots: [{ path: root, via: "" }], now: () => now, scan: { ownNamespace: null, processes: [] } });
    expect(legacy?.removed).toEqual([]);
    for (const directory of foreign) expect(fs.readFileSync(path.join(directory, "data"), "utf8")).toBe("foreign");
  } finally { store.close(); }
});

test("an idle minute tick writes no journal line or report, and a changed condition is reported once across restarts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-idle-tick-")); roots.push(root);
  const { runAttemptTempSweep } = await import("./attemptTempProduction");
  const { AttemptTempStore } = await import("./attemptTempRetention");
  const report = statePath("attempt-temp-report.json");
  fs.rmSync(report, { force: true });
  const lines: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
  const scan = () => ({ ownNamespace: null, processes: [] });
  // Each call opens its own ledger and keeps nothing in memory, as a restarted helper does.
  const tick = async (env: Record<string, string> = {}) => { lines.length = 0; await runAttemptTempSweep({ scan }, { NODE_ENV: "test", LLV_TEMP_SWEEP: "on", ...env }); return [...lines]; };
  try {
    expect(await tick()).toEqual([]);
    expect(fs.existsSync(report)).toBeFalse();
    const held = path.join(root, "llv-stage-held"); fs.mkdirSync(held); fs.writeFileSync(path.join(held, "data"), Buffer.alloc(8192));
    const store = new AttemptTempStore();
    try { store.register({ directory: held, pipelineId: "missing-lane", launchId: "held", retainUntilClose: false, createdAt: Date.now() }); }
    finally { store.close(); }
    const over = await tick({ LLV_ATTEMPT_TEMP_CAP_BYTES: "0" });
    expect(over).toHaveLength(1); expect(over[0]).toContain("measured bytes over cap");
    expect(JSON.parse(fs.readFileSync(report, "utf8")).condition).toEqual({ mode: "on", overCap: true, failing: false });
    const recovered = await tick();
    expect(recovered).toHaveLength(1); expect(recovered[0]).toContain("0 measured bytes over cap");
    const written = fs.readFileSync(report, "utf8");
    expect(await tick()).toEqual([]);
    expect(await tick()).toEqual([]);
    expect(fs.readFileSync(report, "utf8")).toBe(written);
  } finally { log.mockRestore(); }
});


test.each(["passed", "failed", "needs_decision", "skipped", "committing"] as const)("production authority handles %s and holds declared evidence until close", async state => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-production-state-")); roots.push(root);
  const role = { roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null } as const;
  const pipeline = buildPipeline({ id: "state-lane", task: "Temp authority", project: "fixture", repoDir: path.join(root, "repo"),
    stages: [{ id: "build", kind: "run", prompt: "Fixture", next: null, effectiveRole: role }],
    srcPath: null, srcConversationId: null, now: "2026-10-22T12:00:00Z" });
  pipeline.state = "running";
  pipeline.runs = [{ stageId: "build", attempts: [{ n: 1, state, launchId: "state-launch", effectiveRole: role,
    conversationId: "fixture", sessionId: null, agentPath: null, paneId: null, flowId: null,
    startedAt: "2026-10-22T12:00:00Z", completedAt: null, input: null, activatedBy: null, output: null, verdict: null, error: null }] }];
  savePipelines([pipeline]);
  const { attemptTempState } = await import("./attemptTempProduction");
  const owner = { directory: path.join(root, "llv-stage-fixture"), pipelineId: pipeline.id, launchId: "state-launch", retainUntilClose: false, createdAt: 1 };
  expect(await attemptTempState(owner)).toBe(state === "committing" ? "live" : "settled");
  pipeline.runs[0]!.attempts[0]!.retiredLaunches = [{ launchId: "prior-launch", conversationId: null,
    error: "startup retired", retiredAt: "2026-10-22T12:01:00Z" }]; savePipelines([pipeline]);
  expect(await attemptTempState({ ...owner, launchId: "prior-launch" })).toBe("settled");
  expect(await attemptTempState({ ...owner, launchId: "unrecorded-launch" })).toBe("unknown");
  fs.mkdirSync(path.join(pipeline.worktreeDir!, "nested"), { recursive: true });
  if (state !== "committing") {
    const filesystem = await import("./attemptTempFilesystem");
    const changed = spyOn(filesystem, "repositoryReferencesAttemptTemp").mockImplementation(async () => {
      await Promise.resolve(); pipeline.runs[0]!.attempts[0]!.state = "running"; savePipelines([pipeline]); return false;
    });
    try { expect(await attemptTempState(owner)).toBe("unknown"); }
    finally { changed.mockRestore(); }
    pipeline.runs[0]!.attempts[0]!.state = state; savePipelines([pipeline]);
  }
  fs.symlinkSync(path.join(owner.directory, "packages"), path.join(pipeline.worktreeDir!, "nested/node_modules"), "dir");
  expect(await attemptTempState(owner)).toBe("live");
  pipeline.stages[0]!.effectiveRole = { ...role, access: "read-only" };
  pipeline.stages[0]!.outputs = ["evidence"]; savePipelines([pipeline]);
  expect(await attemptTempState(owner)).toBe("live");
  expect(await attemptTempState({ ...owner, directory: path.join(root, "llv-stage-config-fixture") })).toBe(state === "committing" ? "live" : "settled");
  for (const terminal of ["completed", "closed"] as const) {
    pipeline.state = terminal; pipeline.cursor = null; pipeline.closedAt = "2026-10-22T12:02:00Z"; savePipelines([pipeline]);
    expect(await attemptTempState(owner)).toBe("closed");
  }
});
