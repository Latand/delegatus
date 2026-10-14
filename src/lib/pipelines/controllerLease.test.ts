import { expect, test } from "bun:test";
import { buildPipeline, loadPipelines, savePipelines, withPipelineControllerMutation, withPipelineMutation } from "./store";

const fixtureLane = (id: string) => {
  const lane = buildPipeline({ id, task: "Evidence race", project: "fixture", repoDir: "/repo",
  stages: [{ id: "build", kind: "run", prompt: "Build", next: null,
    effectiveRole: { roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null } }],
  srcPath: null, srcConversationId: null, now: "2026-10-14T00:00:00.000Z", state: "draft" });
  lane.state = "paused";
  return lane;
};

test("a writer can change a lane while controller evidence is pending", async () => {
  const lane = fixtureLane("lease-race");
  savePipelines([lane]);
  let entered!: () => void;
  let release!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const evidence = new Promise<void>(resolve => { release = resolve; });
  const controller = withPipelineControllerMutation(async (rows, persist) => {
    const candidate = rows.find(row => row.id === lane.id)!;
    entered();
    await evidence;
    candidate.stateDetail = "stale evidence result";
    persist([candidate]);
  }).then(() => null, error => error);
  await reading;
  const previous = process.env.LLV_PIPELINE_LOCK_WAIT_MS;
  process.env.LLV_PIPELINE_LOCK_WAIT_MS = "100";
  let writerError: unknown;
  try {
    await withPipelineMutation((rows, persist) => {
      rows[0]!.stateDetail = "operator changed lane";
      persist([rows[0]!]);
    });
  } catch (error) { writerError = error; }
  finally {
    if (previous === undefined) delete process.env.LLV_PIPELINE_LOCK_WAIT_MS;
    else process.env.LLV_PIPELINE_LOCK_WAIT_MS = previous;
    release();
  }
  const conflict = await controller;
  expect(writerError).toBeUndefined();
  expect(String(conflict)).toContain("controller snapshot changed");
  expect(loadPipelines()[0]!.stateDetail).toBe("operator changed lane");
});

test("an unrelated writer survives repeated controller checkpoints", async () => {
  savePipelines([fixtureLane("first"), fixtureLane("neighbor")]);
  await withPipelineControllerMutation(async (rows, persist) => {
    rows[0]!.stateDetail = "first checkpoint";
    persist([rows[0]!]);
    await withPipelineMutation((fresh, write) => {
      fresh[1]!.stateDetail = "neighbor changed";
      write([fresh[1]!]);
    });
    rows[0]!.stateDetail = "second checkpoint";
    persist();
    // A default checkpoint must not adopt the neighbor's unseen revision.
    rows[1]!.stateDetail = "stale neighbor";
    expect(() => persist([rows[1]!])).toThrow("controller snapshot changed");
  });
  expect(loadPipelines().map(row => row.stateDetail)).toEqual(["second checkpoint", "neighbor changed"]);
});

test("a conflicting batch writes none of its decided results", async () => {
  savePipelines([fixtureLane("first"), fixtureLane("neighbor")]);
  await withPipelineControllerMutation(async (rows, persist) => {
    await withPipelineMutation((fresh, write) => {
      fresh[1]!.stateDetail = "neighbor changed";
      write([fresh[1]!]);
    });
    rows[0]!.stateDetail = "uncommitted first";
    rows[1]!.stateDetail = "stale neighbor";
    expect(() => persist(rows)).toThrow("controller snapshot changed");
  });
  expect(loadPipelines().map(row => row.stateDetail)).toEqual([null, "neighbor changed"]);
});

test("controller checkpoints defer immediately behind an admitted writer", async () => {
  savePipelines([fixtureLane("first")]);
  await withPipelineControllerMutation(async (rows, persist) => {
    await withPipelineMutation(async () => {
      rows[0]!.stateDetail = "deferred checkpoint";
      expect(() => persist([rows[0]!])).toThrow("controller snapshot changed");
    });
  });
  expect(loadPipelines()[0]!.stateDetail).toBeNull();
});
