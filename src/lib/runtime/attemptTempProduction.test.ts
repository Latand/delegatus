import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";
import { buildPipeline, savePipelines } from "@/lib/pipelines/store";
import type { PipelineStageAttempt } from "@/lib/pipelines/types";
import { materializeStructuredHostAccess } from "./structuredSpawn";
import { withAgentConfigSandbox } from "./agentConfigSandbox";
import { sweepStaleTempDirs } from "@/lib/tempSweep";

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


test("interrupted gate roots are adopted in bounded batches and retire as old orphans", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-gate-discovery-")); roots.push(root);
  const directory = path.join(root, "delegatus-local-gate-fixture"); fs.mkdirSync(directory);
  fs.mkdirSync(path.join(directory, ".git")); fs.writeFileSync(path.join(directory, "data"), "disposable checkout");
  const { AttemptTempStore, sweepAttemptTemps } = await import("./attemptTempRetention");
  const production = await import("./attemptTempProduction");
  const store = new AttemptTempStore(path.join(root, "owners.sqlite"));
  const now = Date.parse("2030-01-01T00:00:00Z");
  fs.utimesSync(directory, new Date(now - 2 * 86400000), new Date(now - 2 * 86400000));
  try {
    expect(await production.adoptOrphanGateTemps(store, [{ path: root, via: "" }], 1)).toBe(1);
    expect(await production.adoptOrphanGateTemps(store, [{ path: root, via: "" }], 1)).toBe(0);
    const report = await sweepAttemptTemps(store, { now: () => now, state: production.attemptTempState,
      capBytes: 0, scan: () => ({ ownNamespace: null, processes: [] }) });
    expect(report.removed).toBe(1); expect(fs.existsSync(directory)).toBeFalse();
  } finally { store.close(); }
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
  fs.symlinkSync(path.join(owner.directory, "packages"), path.join(pipeline.worktreeDir!, "nested/node_modules"), "dir");
  expect(await attemptTempState(owner)).toBe("live");
  pipeline.stages[0]!.effectiveRole = { ...role, access: "read-only" };
  pipeline.stages[0]!.outputs = ["evidence"]; savePipelines([pipeline]);
  expect(await attemptTempState(owner)).toBe("live");
  expect(await attemptTempState({ ...owner, directory: path.join(root, "llv-stage-config-fixture") })).toBe(state === "committing" ? "live" : "settled");
  pipeline.state = "closed"; pipeline.cursor = null; pipeline.closedAt = "2026-10-22T12:02:00Z"; savePipelines([pipeline]);
  expect(await attemptTempState(owner)).toBe("closed");
});
