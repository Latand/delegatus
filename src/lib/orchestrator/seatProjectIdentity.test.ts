import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/* #1874 on a fresh state directory: a repository gets its first commit, the
   seat is designated, and only then is an origin added — so the folder's
   identity moves from its local-path key to its remote key under the seat. */
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-seat-project-identity-"));
const RESTORE = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, LLV_STATE_DIR: process.env.LLV_STATE_DIR };
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
process.env.HOME = SANDBOX;
process.env.XDG_CONFIG_HOME = path.join(SANDBOX, "config");
fs.mkdirSync(process.env.LLV_STATE_DIR, { recursive: true });

const { globalCache } = await import("@/lib/scanner/caches");

/* Every git change is followed by what ten seconds do in production: the cwd
   resolution cache expires, so the next read sees the folder as it now is. */
function git(...args: string[]): void {
  execFileSync("git", args, { stdio: "ignore" });
  globalCache("project-info-cwd-v2").clear();
}

function freshRepository(name: string): string {
  const repo = path.join(SANDBOX, name);
  fs.mkdirSync(repo);
  git("init", "-q", "-b", "main", repo);
  git("-C", repo, "-c", "user.email=builder@example.invalid", "-c", "user.name=builder", "commit", "-q", "--allow-empty", "-m", "init");
  return repo;
}

const addOrigin = (repo: string, name: string) => git("-C", repo, "remote", "add", "origin", `https://example.invalid/acme/${name}.git`);

const { executeOrchestratorSeatRequest } = await import("./seatCommand");
const { orchestratorSeatFor, orchestratorRevocations } = await import("./seats");
const { activeSeatsByCurrentProject, orchestratorSeatForCurrentProject, recordSeatProjectSuccessions } = await import("./seatProjectIdentity");
const { authorizedManagerSeats } = await import("./authority");
const { permitAttentionHandoff } = await import("@/lib/mcp/toolAllowlist");
const { createPipelineFromRequest, defaultPipelinePorts } = await import("@/lib/pipelines/engine");
const { projectPipelineEvents } = await import("@/lib/lifecycle/projector");
const { appendLifecycleEvents, readLifecycleJournal } = await import("@/lib/lifecycle/journal");
const { reconcileSeatTick, runSeatTickCheck } = await import("@/lib/monitor/seatTickController");
const { DEFAULT_SEAT_TICK_POLICY } = await import("@/lib/monitor/seatTick");
const { defaultSeatTickSettings, readSeatTickSettings, writeSeatTickSettings } = await import("@/lib/monitor/seatTickSettings");
const { readSeatTickState, readSeatTickStateFile, writeSeatTickState } = await import("@/lib/monitor/seatTickState");
const { emptySeatTickState } = await import("@/lib/monitor/types");
const { canonicalProject } = await import("@/lib/projects/aliases");
const { projectSuccessionFor, recordProjectSuccessions } = await import("@/lib/projects/succession");
const { projectCatalogSnapshotFromRaw } = await import("@/lib/scanner/projectCatalog");
const { projectForCwd } = await import("@/lib/scanner/describe");
import type { SeatCommandDependencies } from "./seatCommand";
import type { ConversationMessage } from "@/lib/delivery";
import type { Pipeline } from "@/lib/pipelines/types";
import type { RawEntry } from "@/lib/scanner/discover";

afterAll(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  for (const [key, value] of Object.entries(RESTORE)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const SEAT = ["conversation", ["33333333", "3333", "4333", "8333", "333333333333"].join("-")].join("_");
const EMPTY_SNAPSHOT = { entries: {}, receipts: {}, lineageEdges: {}, memberships: {}, conversations: {}, conversationAliases: {}, heldDeliveries: {}, deliveryOperationOwners: {} };

function seatDependencies(): SeatCommandDependencies {
  return {
    spawn: async () => ({ status: 200, body: { ok: true, state: "settled", conversationId: SEAT, path: path.join(SANDBOX, "seat.jsonl"), launchId: "launch_seat" } }),
    deliver: async () => ({ ok: true, outcome: "delivered" }),
    conversationTarget: () => null,
    stampRegistryIdentity: () => {},
    projectTasks: () => [],
    summarizeHandoffs: async () => ({ kind: "fallback", reason: "unavailable" }),
    launchSettlement: () => ({ kind: "unknown" }),
    runtimeIdentity: () => ({ engine: null, model: null }),
    resolvedConversation: () => null,
    now: () => new Date().toISOString(),
  };
}

/** request_attention's gate, both halves, over seats and ownership read the
    way production reads them: under the project their folder resolves to now. */
function attention(cwdOf: (id: string) => string | null, ownership: string, target: string) {
  const seats = authorizedManagerSeats({
    activeSeats: () => activeSeatsByCurrentProject(cwdOf),
    revocations: orchestratorRevocations,
    conversationFacts: (id) => ({
      superseded: false,
      hasGeneration: true,
      project: canonicalProject(projectSuccessionFor(ownership, cwdOf(id))?.target ?? ownership),
    }),
    resolveAlias: (id) => id,
  });
  return permitAttentionHandoff({ kind: "agent", conversationId: SEAT } as never, seats, canonicalProject(target));
}

async function codexTranscript(name: string, cwd: string, mtime: number): Promise<RawEntry> {
  const root = path.join(SANDBOX, "sessions");
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, `${name}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: "session_meta", payload: { cwd } }) + "\n");
  fs.utimesSync(file, mtime, mtime);
  return { rootName: "codex-sessions", root, path: file, st: fs.statSync(file) } as RawEntry;
}

test("a seat designated before its origin existed is woken for the lanes of the origin's key, and its attention is accepted", async () => {
  const repo = freshRepository("widgetworks");
  const local = projectForCwd(repo)!;
  const cwdOf = (id: string) => (id === SEAT ? repo : null);

  const designated = await executeOrchestratorSeatRequest(
    { project: local, cwd: repo, mandate: "run the board", clientRequestId: "seat-identity-designate" },
    seatDependencies(),
  );
  expect(designated.status).toBe(200);
  expect(orchestratorSeatFor(local).active?.conversationId).toBe(SEAT);
  const epoch = orchestratorSeatFor(local).active!.seatEpoch;
  /* A conversation the seat ran before the push, as the scanner saw it. */
  const early = await codexTranscript("early", repo, 1_700_000_000);
  await projectCatalogSnapshotFromRaw([early]);

  addOrigin(repo, "widgetworks");
  const remote = projectForCwd(repo)!;
  expect(remote).not.toBe(local);

  const created = await createPipelineFromRequest({
    task: "fix the widget",
    repoDir: repo,
    autoStart: false,
    stages: [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: "build it" }],
  } as never, defaultPipelinePorts(), { allowOperatorDraftWithoutLineage: true });
  const pipeline = created.pipeline!;
  expect(pipeline.project).toBe(remote);

  /* Before any succession is recorded: the seat is still stored under the old
     key, and the tick and attention already treat it as the new key's seat. */
  expect(orchestratorSeatFor(remote).active).toBeNull();
  expect(orchestratorSeatForCurrentProject(remote, cwdOf).active?.conversationId).toBe(SEAT);

  const sent: ConversationMessage[] = [];
  const stateFile = path.join(SANDBOX, "seat-tick.json");
  let lanes: Pipeline[] = [{ ...pipeline, state: "running" } as Pipeline];
  let clock = Date.now();
  const deps = {
    policy: DEFAULT_SEAT_TICK_POLICY,
    readState: (project: string) => readSeatTickState(project, stateFile),
    writeState: (project: string, row: never) => writeSeatTickState(project, row, stateFile),
    appendRecord: () => {},
    ensureCard: () => true,
    proposalIssues: async () => [],
    deliver: async (message: ConversationMessage) => {
      sent.push(message);
      return { ok: true, target: "structured", outcome: "delivered", structured: true } as never;
    },
    sources: {
      /* The production reading of seats: under the project they serve now. */
      seatFor: (project: string) => orchestratorSeatForCurrentProject(project, cwdOf),
      activeSeats: () => activeSeatsByCurrentProject(cwdOf).map((seat) => seat.project),
      pipelines: () => lanes,
      archivedPipelines: () => [],
      tasks: () => [],
      registry: () => ({
        pageSeatChildren: () => ({ file: EMPTY_SNAPSHOT, keys: [], after: null, complete: true, evidenceGap: false }),
        seatTickConversation: () => ({ id: SEAT, turn: { state: "idle" } }),
        conversation: () => ({ turn: { state: "idle" } }),
        conversationForPath: () => null,
        readOnlySnapshot: () => EMPTY_SNAPSHOT,
      }) as never,
      liveness: async () => [],
      lifecycleJournal: readLifecycleJournal,
      latestDeployment: () => ({ state: "unreadable", error: "no ledger" }) as never,
      retirementReport: () => null,
      settings: (project: string) => defaultSeatTickSettings(project),
      openPullRequests: async () => ({ ok: true, pullRequests: [] }) as never,
      wakeState: async () => "retained" as never,
      withdrawWake: async () => "withdrawn" as never,
      now: () => clock,
    },
  };

  const first = await runSeatTickCheck(remote, deps as never);
  expect(first?.project).toBe(remote);
  expect(first?.verdict).toBe("wake");
  expect(sent[0]!.conversationId).toBe(SEAT);
  expect(sent[0]!.text).toContain(pipeline.id);
  expect(attention(cwdOf, local, pipeline.project)).toEqual({ allowed: true, via: "orchestrator" });

  /* The succession, recorded once: the seat moves with its epoch, the old key
     reads as the new one, and the project's history carries one line. */
  expect(recordSeatProjectSuccessions(cwdOf)).toEqual([{ source: local, target: remote, displayName: "widgetworks" }]);
  expect(recordSeatProjectSuccessions(cwdOf)).toEqual([]);
  expect(orchestratorSeatFor(remote).active).toMatchObject({ conversationId: SEAT, seatEpoch: epoch });
  expect(canonicalProject(local)).toBe(remote);
  expect(readLifecycleJournal().events.filter((event) => event.type === "project_moved").map((event) => event.project)).toEqual([remote]);
  expect(attention(() => null, local, pipeline.project)).toEqual({ allowed: true, via: "orchestrator" });

  /* A stage settles past the wake interval: the next wake names the lane. */
  const settled = structuredClone(lanes[0]!);
  settled.runs = [{
    stageId: "build",
    attempts: [{ n: 1, state: "needs_decision", conversationId: null, agentPath: null, startedAt: new Date(clock - 60_000).toISOString(), completedAt: new Date(clock).toISOString() }],
  }] as never;
  lanes = [settled];
  appendLifecycleEvents(projectPipelineEvents([settled]));
  clock += 2 * 60 * 60_000;
  const record = await runSeatTickCheck(local, deps as never);
  expect(record?.project).toBe(remote);
  expect(record?.verdict).toBe("wake");
  expect(record?.reasons).toContain("lane-event");
  expect(sent.at(-1)!.text).toContain(pipeline.id);

  /* One project in the catalog: the conversation from before the push and one
     from after it group together. */
  const late = await codexTranscript("late", repo, 1_700_000_100);
  await projectCatalogSnapshotFromRaw([early, late]);
  const catalog = await projectCatalogSnapshotFromRaw([early, late]);
  expect(catalog.projectCatalog.map((entry) => entry.project)).toEqual([remote]);
});

test("a scan that sees one folder under two keys records the succession", async () => {
  const repo = freshRepository("gadgetworks");
  const local = projectForCwd(repo)!;
  const before = await codexTranscript("gadget-before", repo, 1_700_000_200);
  await projectCatalogSnapshotFromRaw([before]);
  addOrigin(repo, "gadgetworks");
  const remote = projectForCwd(repo)!;
  const after = await codexTranscript("gadget-after", repo, 1_700_000_300);

  const split = await projectCatalogSnapshotFromRaw([before, after]);
  expect(new Set(split.projectCatalog.map((entry) => entry.project))).toEqual(new Set([local, remote]));
  expect(canonicalProject(local)).toBe(remote);
  const joined = await projectCatalogSnapshotFromRaw([before, after]);
  expect(joined.projectCatalog.map((entry) => entry.project)).toEqual([remote]);
});

test("a folder that became a repository moves its directory key, and the seat tick carries its rows", async () => {
  const folder = path.join(SANDBOX, "sprocketworks");
  fs.mkdirSync(folder);
  const directory = projectForCwd(folder)!;
  expect(directory).toMatch(/^dir-/);
  writeSeatTickSettings(directory, { ...defaultSeatTickSettings(directory), enabled: false, reason: "a quiet week" });
  writeSeatTickState(directory, { ...emptySeatTickState(), eventsThrough: 7, accounting: undefined } as never);

  git("init", "-q", "-b", "main", folder);
  addOrigin(folder, "sprocketworks");
  const remote = projectForCwd(folder)!;
  const succession = projectSuccessionFor(directory, folder);
  expect(succession).toMatchObject({ source: directory, target: remote });
  expect(recordProjectSuccessions([succession])).toHaveLength(1);

  /* The sweep carries every tick row whose key an alias has moved. */
  await reconcileSeatTick({
    ownsTraffic: () => true,
    recordSuccessions: () => [],
    sources: { activeSeats: () => [], pipelines: () => [], tasks: () => [] } as never,
  });
  expect(readSeatTickSettings(remote)).toMatchObject({ project: remote, enabled: false, reason: "a quiet week" });
  expect(readSeatTickStateFile()[remote]?.eventsThrough).toBe(7);
});

test("a key that never named the folder is not moved", () => {
  const repo = freshRepository("cogworks");
  addOrigin(repo, "cogworks");
  /* A remote identity (a renamed or re-pointed origin) names every clone of
     that repository, so it is never folded into this checkout. */
  expect(projectSuccessionFor("repo-00000000000000000000000000000000", repo)).toBeNull();
  expect(projectSuccessionFor(projectForCwd(repo)!, repo)).toBeNull();
});

test("request_attention's cross-project refusal names both keys", () => {
  const verdict = permitAttentionHandoff(
    { kind: "agent", conversationId: SEAT } as never,
    [{ conversationId: SEAT, project: "dir-00000000000000000000000000000000" }],
    "repo-00000000000000000000000000000000",
  );
  expect(verdict.allowed).toBe(false);
  if (verdict.allowed) return;
  expect(verdict.refusedAs).toBe("cross-project");
  expect(verdict.error).toContain("dir-00000000000000000000000000000000");
  expect(verdict.error).toContain("repo-00000000000000000000000000000000");
});
