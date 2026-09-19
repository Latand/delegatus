import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A lane the server has admitted and the board has not drawn yet (#1836).
 *
 * The production failure, over the production pieces: a pipeline is admitted by
 * the real create path into an isolated state directory, the device read is the
 * one the browser polls (with its own registry and task-file loaders — nothing
 * is injected), the client cache is the board's real data layer, and the board
 * is the projection the operator was actually looking at.
 *
 * What went wrong in production: `create_pipeline` answered a pipeline at
 * 08:28:04, its build stage was live by 08:29, and `request_attention` on it
 * answered TARGET_LOST a minute later. `/api/files` is a whole-corpus scan of
 * about fourteen seconds served stale-while-revalidate, so the browser's
 * payload did not carry the pipeline or its task — and a card that does not
 * exist has no anchor to land on.
 *
 * The state directory is set BEFORE the stores are imported, because they
 * resolve their paths at import.
 */

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-attention-landing-"));
const previousStateDir = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = sandbox;

const PROJECT = "repo-fixture";
const DEVICE = "device-desktop";
const NOW = 1_800_000_000;
/** A real repository, because the create path really does preflight it. */
const REPO = path.join(sandbox, PROJECT);
fs.mkdirSync(REPO, { recursive: true });
execFileSync("git", ["init", "-q", "--initial-branch=main", REPO], { stdio: "ignore" });

const { allCards, cardAnchors, conversationOwners, kanbanFocusIndex } = await import("@/components/kanban/kanbanFocus");
const { buildKanbanModel } = await import("@/components/kanban/kanbanModel");
const { createFocusHandoffBus } = await import("@/components/attention/focusHandoffBus");
const { runFocusHandoff } = await import("@/components/attention/navigate");
const { buildSchemeLayout } = await import("@/components/scheme/layout");
const { buildTaskBands } = await import("@/components/scheme/taskBands");
const { projectTaskWorkflows } = await import("@/components/tasks/taskWorkflowModel");
const { createFilesClientCache } = await import("@/hooks/useFiles");
const { createPipelineFromRequest, defaultPipelinePorts } = await import("@/lib/pipelines/engine");
const { savePipelines } = await import("@/lib/pipelines/store");
const { createTask } = await import("@/lib/tasks/commands");
const { mutateTasksFile, saveTasks } = await import("@/lib/tasks/store");
const { resetPresenceForTest } = await import("@/lib/view/presenceStore");
const { attentionForDevice, attentionRecordsForSurface, raiseAttentionRequest } = await import("./service");
const { attentionFile } = await import("./store");

type Pipeline = import("@/lib/pipelines/types").Pipeline;
type BoardTask = import("@/lib/tasks/types").BoardTask;
type FocusTarget = import("./types").FocusTarget;
type FilesData = import("@/hooks/useFiles").FilesData;

afterAll(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

/** The production create path, with the two adapters a test process cannot
    have: there is no transcript corpus to resolve the creator's lineage from,
    and no scanner configuration naming the project. Everything else — the
    validation, the repo preflight against the real repository above, the
    admission and the registry write — is the one the route calls. */
const ports = {
  ...defaultPipelinePorts(),
  sourcePathAllowed: () => true,
  conversationIdForPath: () => "conversation_creator",
  projectForCwd: () => PROJECT,
};

/** One board task and one pipeline filed under it, admitted by the server, as
    `create_pipeline` leaves them: `provisioning`, nothing spawned. */
async function admitLane(text: string): Promise<{ pipeline: Pipeline; task: BoardTask }> {
  const created = mutateTasksFile((state) => {
    const outcome = createTask(state.tasks, { project: PROJECT, text, placement: "unplaced" }, state.recentCreates, { attachmentExists: () => true });
    return { state: outcome.ok && !outcome.replay ? { tasks: outcome.tasks, recentCreates: outcome.recentCreates } : undefined, result: outcome };
  });
  if (!created.ok) throw new Error(`task refused: ${created.error}`);
  const task = created.task;
  const admitted = await createPipelineFromRequest({
    task: text,
    repoDir: REPO,
    taskIds: [task.id],
    src: "/transcripts/creator.jsonl",
    stages: [
      { id: "build", kind: "run", prompt: "Build it", next: "review" },
      { id: "review", kind: "run", prompt: "Review it", next: null },
    ] as never,
  }, ports);
  if (!admitted.pipeline) throw new Error(`pipeline refused: ${admitted.error}`);
  return { pipeline: admitted.pipeline, task };
}

function clearState(): void {
  savePipelines([]);
  saveTasks([]);
  fs.rmSync(attentionFile(), { force: true });
  resetPresenceForTest();
}

/** The browser's data layer, fed by a scan that is behind — which is the whole
    of the production condition. `carrying` is what the next completed scan
    finally returns, so the replacement below is a real revalidation and not a
    second apply. */
function clientCache(carrying: () => { pipelines: Pipeline[]; tasks: BoardTask[] }) {
  let scans = 0;
  const cache = createFilesClientCache(async () => {
    scans += 1;
    const rows = carrying();
    return new Response(JSON.stringify({ files: [], flows: [], workflows: [], ...rows }), {
      status: 200,
      headers: { ETag: `"scan-${scans}"` },
    });
  });
  return { cache, scans: () => scans };
}

/** The kanban board this data draws, as a focus bus the navigator can use. */
function boardFor(read: () => FilesData) {
  const bus = createFocusHandoffBus();
  const moved: string[] = [];
  let anchors = new Map<string, string>();
  let index: ReturnType<typeof kanbanFocusIndex> | null = null;
  const publish = () => {
    const data = read();
    const pipelines = [...data.pipelines];
    const tasks = [...data.tasks];
    const layout = buildSchemeLayout([], [], [], [], [], pipelines, [], new Set(), new Set(), [], new Set(), { now: NOW });
    const projection = projectTaskWorkflows(tasks, pipelines, [], []);
    const bands = buildTaskBands(layout, { tasks, projection, untitled: "Untitled task" });
    const model = buildKanbanModel({ bands, tasks, pipelines, projection, files: [], now: NOW });
    const cards = allCards(model);
    anchors = cardAnchors(cards, conversationOwners(cards, []));
    index = kanbanFocusIndex(model, anchors, PROJECT);
    bus.setBoard({
      project: PROJECT,
      index,
      moveTo: (destination) => {
        const anchor = destination.anchorKeys.find((key) => anchors.has(key));
        if (!anchor) return false;
        moved.push(anchor);
        return true;
      },
      restoreCamera: () => false,
    });
    return { cards, anchors };
  };
  return { bus, moved, publish, rectFor: (key: string) => index?.rectFor(key) ?? null };
}

function requestFor(target: FocusTarget, now: Date) {
  return raiseAttentionRequest({
    origin: "root-agent",
    target,
    frameAtCreation: { project: PROJECT, rect: { x: 0, y: 0, w: 0, h: 0 }, boardRevision: null },
    intent: "show",
    reason: "The lane you just asked for is running.",
    directedAt: DEVICE,
  }, { now }).request;
}

test("a lane the server admitted is on the board before anything requests attention", async () => {
  clearState();
  const { pipeline, task } = await admitLane("A lane just created\nWhat the lane is for");

  /* Nobody has asked for anything: no attention request exists. The read the
     browser is already making every few seconds carries the admission. */
  const view = attentionForDevice(DEVICE);
  expect(view.live).toEqual([]);
  expect(view.records?.pipelines.map((row) => row.id)).toEqual([pipeline.id]);
  expect(view.records?.tasks.map((row) => row.id)).toEqual([task.id]);

  /* The scan the board draws from is the one that is behind. */
  let scanCarries = { pipelines: [] as Pipeline[], tasks: [] as BoardTask[] };
  const { cache } = clientCache(() => scanCarries);
  await cache.revalidate();
  const board = boardFor(() => cache.read());
  expect(board.publish().cards).toHaveLength(0);

  /* The poll lays the rows into the data layer, exactly as the client does. */
  for (const row of view.records!.pipelines) cache.applyPipeline(row, true);
  for (const row of view.records!.tasks) cache.applyTask(row);

  const drawn = board.publish();
  expect(drawn.cards).toHaveLength(1);
  expect(drawn.cards[0]!.title).toBe("A lane just created");
  /* Title, the band from its taskIds, and one pending slot per stage. */
  expect(drawn.cards[0]!.pipelines[0]!.pipeline.id).toBe(pipeline.id);
  expect(drawn.cards[0]!.pipelines[0]!.waiting).toBe(2);
  expect([...drawn.anchors.keys()]).toEqual([
    `task::${task.id}`,
    `group::pipeline::${pipeline.id}`,
    `slot::${pipeline.id}::build`,
    `slot::${pipeline.id}::review`,
  ]);
});

const laneTargets = ["the pipeline", "one of its stages", "its board task"] as const;

for (const what of laneTargets) {
  test(`attention on ${what}, raised at once against a stale board, lands on the lane`, async () => {
    clearState();
    const { pipeline, task } = await admitLane("A lane just created\nWhat the lane is for");
    const target: FocusTarget = what === "the pipeline"
      ? { kind: "pipeline", pipelineId: pipeline.id }
      : what === "one of its stages"
        ? { kind: "stage", pipelineId: pipeline.id, stageId: "build" }
        : { kind: "task", taskId: task.id };
    const request = requestFor(target, new Date());

    let scanCarries = { pipelines: [] as Pipeline[], tasks: [] as BoardTask[] };
    const { cache } = clientCache(() => scanCarries);
    await cache.revalidate();
    const board = boardFor(() => cache.read());
    board.publish();

    /* The failure as production had it: the browser's payload is the stale
       scan, so the board holds no card for the lane. */
    const stale = await runFocusHandoff(request, board.bus, { timeoutMs: 20, pollMs: 5 });
    expect(stale.resolution).toBe("lost");

    /* The poll that delivers the request delivers the rows behind it. */
    const view = attentionForDevice(DEVICE);
    expect(view.records?.pipelines.map((row) => row.id)).toEqual([pipeline.id]);
    for (const row of view.records!.pipelines) cache.applyPipeline(row, true);
    for (const row of view.records!.tasks) cache.applyTask(row);
    board.publish();

    const landed = await runFocusHandoff(request, board.bus, { timeoutMs: 200, pollMs: 5 });
    expect(landed.resolution).toBe("exact");
    expect(landed.moved).toBe(true);
    /* One move, onto the one card the lane draws — whichever of its anchors the
       target named resolves to that same card. */
    expect(board.moved).toHaveLength(1);
    expect(board.publish().anchors.get(board.moved[0]!)).toBe(board.publish().anchors.get(`task::${task.id}`)!);

    /* The real row arrives on the next completed scan and replaces the pushed
       one in place: one band, the same frame, and no second move. */
    const anchorKey = `group::pipeline::${pipeline.id}`;
    const before = board.rectFor(anchorKey);
    scanCarries = { pipelines: [{ ...pipeline, state: "running" } as Pipeline], tasks: [task] };
    await cache.revalidate();
    const settled = board.publish();
    expect(settled.cards).toHaveLength(1);
    expect(cache.read().pipelines).toHaveLength(1);
    expect(cache.read().pipelines[0]!.state).toBe("running");
    expect(cache.read().tasks).toHaveLength(1);
    expect(board.rectFor(anchorKey)).toEqual(before);
    expect(board.moved).toHaveLength(1);
  });
}

test("a pipeline the server does not hold carries no record and still answers TARGET_LOST", async () => {
  clearState();
  await admitLane("A lane just created\nWhat the lane is for");
  const request = requestFor({ kind: "pipeline", pipelineId: "pl-does-not-exist" }, new Date());

  const view = attentionForDevice(DEVICE);
  expect(view.records?.pipelines.some((row) => row.id === "pl-does-not-exist")).toBe(false);

  const { cache } = clientCache(() => ({ pipelines: [], tasks: [] }));
  await cache.revalidate();
  const board = boardFor(() => cache.read());
  for (const row of view.records?.pipelines ?? []) cache.applyPipeline(row, true);
  for (const row of view.records?.tasks ?? []) cache.applyTask(row);
  board.publish();

  const outcome = await runFocusHandoff(request, board.bus, { timeoutMs: 60, pollMs: 5 });
  expect(outcome.resolution).toBe("lost");
  expect(outcome.moved).toBe(false);
  expect(board.moved).toHaveLength(0);
});

test("a lane the client holds and the server does not comes back as a withdrawal, with its reason", async () => {
  clearState();
  const { pipeline } = await admitLane("A lane just created\nWhat the lane is for");

  /* Held by the client out of the push above, and then gone from the registry:
     refused, or never materialized. */
  expect(attentionForDevice(DEVICE, { echoedPipelineIds: [pipeline.id] }).records?.withdrawn).toEqual([]);
  savePipelines([]);
  const after = attentionForDevice(DEVICE, { echoedPipelineIds: [pipeline.id] });
  expect(after.records?.withdrawn).toEqual([{ id: pipeline.id, reason: "never-materialized" }]);
});

test("a lane admitted long ago is not re-pushed on every poll", async () => {
  clearState();
  const { pipeline } = await admitLane("An older lane\nStill running");
  const aged = { ...pipeline, createdAt: new Date(Date.now() - 20 * 60_000).toISOString() } as Pipeline;
  savePipelines([aged]);

  expect(attentionForDevice(DEVICE).records).toBeNull();

  /* Still pushed the moment something names it: this is the window on
     unasked-for rows, not on what a request is owed. */
  const request = requestFor({ kind: "pipeline", pipelineId: pipeline.id }, new Date());
  expect(attentionForDevice(DEVICE).records?.pipelines.map((row) => row.id)).toEqual([pipeline.id]);
  expect(request.target).toEqual({ kind: "pipeline", pipelineId: pipeline.id });
});

test("the phone's rows-only read carries a freshly admitted lane and touches no request", async () => {
  clearState();
  const { pipeline, task } = await admitLane("A lane just created\nWhat the lane is for");
  requestFor({ kind: "pipeline", pipelineId: pipeline.id }, new Date());
  const recordBefore = fs.readFileSync(attentionFile(), "utf8");

  /* The phone names no device, so it gets the rows and nothing else. */
  const surface = attentionRecordsForSurface();
  expect(Object.keys(surface)).toEqual(["records"]);
  expect(surface.records?.pipelines.map((row) => row.id)).toEqual([pipeline.id]);
  expect(surface.records?.tasks.map((row) => row.id)).toEqual([task.id]);

  /* Reading it offered, swept and answered nothing: the attention record is
     byte for byte what it was, and the request still waits for a desktop. */
  expect(fs.readFileSync(attentionFile(), "utf8")).toBe(recordBefore);

  savePipelines([]);
  expect(attentionRecordsForSurface({ echoedPipelineIds: [pipeline.id] }).records?.withdrawn)
    .toEqual([{ id: pipeline.id, reason: "never-materialized" }]);
});
