import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { computeDestructivePolicy, publishDestructiveGuard } from "./destructiveGuard";

/** All effects of a guard test are confined to directories this fixture minted. */
export function guardFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "destructive-guard-test-")));
  const home = path.join(root, "home"), cwd = path.join(root, "worktree"), tmp = path.join(root, "tmp");
  const state = path.join(home, ".config/delegatus/state");
  for (const directory of [cwd, tmp, state, ...[".claude", ".codex", ".ssh", "Projects/a", "Projects/b", ".config/delegatus/accounts/claude/managed", ".config/delegatus/accounts/codex/managed"].map(name => path.join(home, name))]) fs.mkdirSync(directory, { recursive: true });
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_CACHE_HOME: path.join(home, ".cache"),
    LLV_STATE_DIR: state, TMPDIR: tmp, LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1", CODEX_HOME: path.join(home, ".codex"), CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    LLV_CODEX_HOME: path.join(home, ".codex"), LLV_CLAUDE_HOME: path.join(home, ".claude"), LLV_STATE_OWNER: undefined };
  // The production launch refresh also reads this explicit operator policy.
  // Every named protected tree is fake and was created immediately above.
  fs.writeFileSync(path.join(state, "destructive-guard-protected.json"), JSON.stringify([home]));
  const installed = publishDestructiveGuard(env);
  const policy = computeDestructivePolicy(env, { home, accounts: [env.CODEX_HOME, env.CLAUDE_CONFIG_DIR], projects: [path.join(home, "Projects/a"), path.join(home, "Projects/b")] });
  fs.writeFileSync(installed.policyFile, JSON.stringify(policy), { mode: 0o600 });
  const stamp = path.join(installed.directory, "test-policy-stamp");
  fs.writeFileSync(stamp, policy.digest);
  Object.assign(env, { PATH: installed.directory + ":/usr/bin:/bin:/usr/local/bin:" + path.dirname(process.execPath),
    BASH_ENV: path.join(installed.directory, "shell-env.sh"),
    LLV_DESTRUCTIVE_GUARD_BOUND_PATH: installed.directory + ":/usr/bin:/bin:/usr/local/bin:" + path.dirname(process.execPath), LLV_DESTRUCTIVE_GUARD_RM: "/bin/rm", LLV_DESTRUCTIVE_GUARD_FAST_STAMP: stamp, LLV_DESTRUCTIVE_GUARD_POLICY_DIGEST: policy.digest,
    LLV_DESTRUCTIVE_GUARD_DIR: installed.directory, LLV_DESTRUCTIVE_GUARD_BUN: process.execPath,
    LLV_DESTRUCTIVE_GUARD_POLICY: installed.policyFile, LLV_DESTRUCTIVE_GUARD_OWN: [cwd, tmp].join(":"), LLV_DESTRUCTIVE_GUARD_FAST: [cwd, tmp].join(":"),
    LLV_DESTRUCTIVE_GUARD_CALLER: "c".repeat(64),
    LLV_DESTRUCTIVE_GUARD_JOURNAL: path.join(state, "destructive-guard/refusals.ndjson") });
  const assertOwned = (target: string) => {
    const resolved = fs.realpathSync(target);
    if (!resolved.startsWith(root + path.sep)) throw Error("test target is outside its own temporary tree");
  };
  const cleanup = () => { assertOwned(root + "/home"); fs.rmSync(root, { recursive: true, force: true }); };
  const run = (tool: string, args: string[], overrides: Record<string, string | undefined> = {}) => {
    assertOwned(cwd); assertOwned(home); assertOwned(tmp);
    return Bun.spawnSync([path.join(installed.directory, tool), ...args], { cwd, env: { ...env, ...overrides }, stdout: "pipe", stderr: "pipe" });
  };
  return { root, home, cwd, tmp, state, env: env as NodeJS.ProcessEnv, installed, policy, assertOwned, cleanup, run };
}

/** Feed real writer output through the production lifecycle and attempt
 * recorder, with a registered synthetic conversation. Only delivery records. */
export async function ingestGuardFixture(f: ReturnType<typeof guardFixture>, engine: "claude" | "codex") {
  const { agentRegistry, closeAgentRegistryForTests } = await import("./registry");
  const { buildPipeline, withPipelineMutation, loadPipelinesForList } = await import("@/lib/pipelines/store");
  const { readLifecycleJournal } = await import("@/lib/lifecycle/journal");
  const { DestructiveRefusalIngester, destructiveRefusalPorts, guardRefusalsForState } = await import("./destructiveGuard.refusals");
  const previous = process.env.LLV_STATE_DIR;
  closeAgentRegistryForTests(); process.env.LLV_STATE_DIR = f.state;
  try {
    const transcript = f.tmp + "/registered.jsonl"; fs.writeFileSync(transcript, "");
    const registry = agentRegistry();
    const launch = registry.beginSpawnRequest({ engine, cwd: f.cwd, spawnCapabilityDigest: f.env.LLV_DESTRUCTIVE_GUARD_CALLER!, launchProfile: { title: "Guarded cleanup" } });
    if (launch.kind !== "created") throw Error("fixture launch was not created");
    registry.completeSpawn(launch.receipt.launchId, { key: { engine, sessionId: "guard-native" }, artifactPath: transcript, cwd: f.cwd,
      accountId: "fixture", status: "live", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null });
    const conversation = registry.conversation(launch.receipt.conversationId)!;
    const now = "2026-11-17T12:00:00.000Z";
    const pipeline = buildPipeline({ id: "pipeline_guard", task: "Guarded cleanup", project: "guard-project", repoDir: f.cwd, stages: [{ id: "build", kind: "run", prompt: "fixture", next: null, effectiveRole: { roleId: null, engine, model: null, effort: null, access: "read-write", promptScaffold: null } } as import("@/lib/pipelines/types").PipelineStage], srcPath: null, srcConversationId: null, now });
    pipeline.state = "running";
    pipeline.runs[0]!.attempts.push({ n: 1, state: "running", conversationId: conversation.id, startedAt: now, completedAt: null, effectiveRole: { ...pipeline.stages[0]!.effectiveRole!, roleId: "builder", promptScaffold: "Build the fixture." },
      launchId: "guard-launch", sessionId: "guard-session", agentPath: transcript, paneId: null, flowId: null, input: null, activatedBy: null, output: null, verdict: null, error: null } as import("@/lib/pipelines/types").PipelineStageAttempt);
    pipeline.cursor = { stageId: "build", state: "running", input: null, activatedBy: null } as import("@/lib/pipelines/types").Pipeline["cursor"];
    await withPipelineMutation(async (pipelines, persist) => { pipelines.push(pipeline); await persist(); });
    const notices: string[] = [], errors: string[] = [];
    const ports = await destructiveRefusalPorts();
    await new DestructiveRefusalIngester(f.state, { ...ports, notify: async (_id, _project, row) => { notices.push(row.id); }, error: reason => { errors.push(reason); } }).ingest();
    const refusal = guardRefusalsForState(f.state)[conversation.id];
    const events = readLifecycleJournal().events.filter(event => event.type === "destructive_refused");
    const attempt = loadPipelinesForList().find(row => row.id === pipeline.id)!.runs[0]!.attempts[0]!;
    return { conversationId: conversation.id, refusal, events, attempt, notices, errors };
  } finally {
    closeAgentRegistryForTests();
    if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
  }
}
