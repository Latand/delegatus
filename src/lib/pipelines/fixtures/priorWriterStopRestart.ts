/*
 * A Viewer restarted in the middle of a settled-writer stop sequence, as a
 * separate process (severedStageRetry.test.ts, "two surviving earlier agents
 * each spend a whole persisted budget").
 *
 * The test's own process ticks the lane until the first automatic stop is
 * recorded, then hands over. This process starts with nothing in memory: it
 * opens the same registry file and the same pipeline store, binds the same
 * kinds of ports, and ticks the lane on its own clock until it parks.
 * Whatever the engine kept in memory in the first process is gone here, so a
 * budget, a spacing or an operation key that lived only there would show.
 *
 * Ports: the engine's defaults, with git, agent launch and the wall clock
 * stubbed as the test stubs them. Signals are recorded; only those aimed at
 * the conversation named in `signalsLandFor` are delivered, and every target
 * is a recorded identity the engine chose, never one named here.
 *
 * Output: one JSON line on stdout once the lane has parked or the ticks ran
 * out. The environment is the caller's: HOME, XDG_CONFIG_HOME, LLV_STATE_DIR
 * and TMPDIR must already point at the isolated state the test owns.
 */
import "@/lib/testing/fixtureLifetime";
import path from "node:path";

import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";

import { registerPipelineTick } from "../controllerSignal";
import { defaultPipelinePorts, stopSettledPipelineStageWriter, tickPipelines, type PipelinePorts } from "../engine";
import { loadPipelines } from "../store";

type Config = {
  registryPath: string;
  /** The first process's wall clock when it handed over, as the lane recorded it. */
  clockAt: string;
  worktreeDir: string;
  source: string;
  sourceConversationId: string;
  endedTranscripts: string[];
  turnEndTs: number;
  signalsLandFor: string | null;
  stageHead: string;
};

const config = JSON.parse(process.argv[2] ?? "null") as Config | null;
if (!config) throw new Error("usage: priorWriterStopRestart.ts <config json>");

const registry = new AgentRegistry(config.registryPath, undefined, undefined, { sqliteMode: "off" });
setAgentRegistryForTests(registry);
/* A tick this process did not ask for must never run. */
registerPipelineTick(async () => {});

let offsetMs = 0;
const ended = new Set(config.endedTranscripts);
const turnEnd = { text: "Done.", ts: config.turnEndTs };
const stops: string[] = [];
const keys: string[] = [];
const sent: Array<[number, string]> = [];
const spawned: string[] = [];
const defaults = defaultPipelinePorts();
const ports: PipelinePorts = {
  ...defaults,
  engineReadiness: () => "connected",
  cpuPressureHold: () => null,
  cpuAdmissionReconcile: () => {},
  cpuAdmissionSuspend: () => {},
  now: () => new Date(Date.parse(config.clockAt) + offsetMs).toISOString(),
  exec: (rawCommand, rawArgs) => {
    const args = rawCommand === "timeout" ? rawArgs.slice(rawArgs.indexOf("git") + 1) : rawArgs;
    if (args[0] === "rev-parse" && args[1] === "--git-dir") return { code: 0, stdout: ".git\n", stderr: "" };
    if (args[0] === "rev-parse") return { code: 0, stdout: `${config.stageHead}\n`, stderr: "" };
    if (args[0] === "branch") return { code: 0, stdout: `${loadPipelines()[0]?.branch ?? ""}\n`, stderr: "" };
    if (args[0] === "remote") return { code: 2, stdout: "", stderr: "error: No such remote 'origin'\n" };
    return { code: 0, stdout: "", stderr: "" };
  },
  preflightRepo: (repoDir) => ({ ok: true, repoDir, gitCommonDir: path.join(repoDir, ".git"), worktreeParent: path.dirname(repoDir) }),
  roleLookup: (roleId) => roleId === "builder" || roleId === "reviewer"
    ? { engine: "claude", model: "opus", effort: "xhigh", access: "read-write", promptScaffold: "Guidance" }
    : null,
  /* No agent is ever started; a launch here is a failure the caller reads. */
  spawnAgent: async ({ clientAttemptId }) => {
    spawned.push(clientAttemptId);
    throw new Error("this fixture starts no agent");
  },
  stopStageAgent: async () => ({ outcome: "not-running" }),
  stopStagePane: async () => ({ outcome: "not-running" }),
  stageHostResident: async () => false,
  paneAgentAlive: async () => false,
  worktreePresent: () => true,
  headCwd: () => config.worktreeDir,
  sourcePathAllowed: (pathname) => pathname.endsWith(".jsonl"),
  projectForCwd: () => "fixture",
  conversationIdForPath: (pathname) => pathname === config.source ? config.sourceConversationId : defaults.conversationIdForPath(pathname),
  conversationTurnInterrupted: async () => null,
  conversationOperatorStopped: async () => false,
  durableTurnEvidence: async (engine, transcriptPath, ...rest) => ended.has(transcriptPath)
    ? { turn: "terminal", message: turnEnd, lastRecordAt: turnEnd.ts }
    : await defaults.durableTurnEvidence(engine, transcriptPath, ...rest),
  lastMessage: (item) => ended.has(item.path) ? turnEnd : null,
  stopSettledStageWriter: (target, operationId) => {
    stops.push(target.conversationId!);
    keys.push(operationId);
    return stopSettledPipelineStageWriter(target, {
      operationId, client: null,
      termination: {
        signal: (pid, signal) => {
          sent.push([pid, signal]);
          if (target.conversationId === config.signalsLandFor) process.kill(pid, signal);
        },
        graceMs: 20, deadlineMs: 80,
      },
    });
  },
};

const endedEntries = config.endedTranscripts.map(transcript => ({
  path: transcript, root: "claude-projects", name: path.basename(transcript), project: "fixture", title: "stage",
  engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: config.turnEndTs, size: 10, activity: "idle", proc: null, pid: null,
  model: null, pendingQuestion: null, waitingInput: null,
})) as unknown as Parameters<typeof tickPipelines>[0];
const parked = () => loadPipelines()[0]?.state === "needs_decision";

/* The tick right after the restart is early, as is one just short of the
   spacing; the tick that reaches it sends the next stop. Then the lane runs
   on until it parks, and one more tick after that sends nothing. */
const stopsAt: number[] = [];
await tickPipelines(endedEntries, ports);
stopsAt.push(stops.length);
offsetMs += 4_999;
await tickPipelines(endedEntries, ports);
stopsAt.push(stops.length);
offsetMs += 1;
await tickPipelines(endedEntries, ports);
stopsAt.push(stops.length);
for (let round = 0; round < 8 && !parked(); round += 1) {
  offsetMs += 10_000;
  await tickPipelines(endedEntries, ports);
}
const sentAtPark = sent.length;
offsetMs += 60_000;
await tickPipelines(endedEntries, ports);

const lane = loadPipelines()[0]!;
const waiting = lane.runs.at(-1)!.attempts.at(-1)!;
process.stdout.write(`${JSON.stringify({
  stopsAt, stops, keys, sent, sentAfterPark: sent.length - sentAtPark, spawned,
  state: lane.state, stateDetail: lane.stateDetail, attemptState: waiting.state, priorWriterStop: waiting.priorWriterStop ?? null,
})}\n`);
process.exit(0);
