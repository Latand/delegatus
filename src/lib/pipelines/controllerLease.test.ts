import { Database } from "bun:sqlite";
import { expect, test, spyOn } from "bun:test";
import { SqliteStateCollection } from "@/lib/state/sqliteStateStore";
import { viewerLoopMonitor } from "@/lib/viewerLoopMonitor";
import { buildPipeline, loadPipelines, savePipelines, withPipelineControllerMutation, withPipelineMutation } from "./store";

const fixtureLane = (id: string) => {
  const lane = buildPipeline({ id, task: "Evidence race", project: "fixture", repoDir: "/repo",
  stages: [{ id: "build", kind: "run", prompt: "Build", next: null,
    effectiveRole: { roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null } }],
  srcPath: null, srcConversationId: null, now: "2026-10-14T00:00:00.000Z", state: "draft" });
  lane.state = "paused";
  return lane;
};

test("an uncheckpointed nested controller edit cannot alter the next snapshot", async () => {
  savePipelines([fixtureLane("pristine-controller")]);
  await withPipelineControllerMutation(rows => {
    rows[0]!.stages[0]!.effectiveRole.model = "gpt-controller-edit";
  });
  await withPipelineControllerMutation(rows => {
    expect(rows[0]!.stages[0]!.effectiveRole.model).toBeNull();
  });
});

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
    await persist([candidate]);
  }).then(() => null, error => error);
  await reading;
  const previous = process.env.LLV_PIPELINE_LOCK_WAIT_MS;
  process.env.LLV_PIPELINE_LOCK_WAIT_MS = "100";
  let writerError: unknown;
  try {
    await withPipelineMutation(async (rows, persist) => {
      rows[0]!.stateDetail = "operator changed lane";
      await persist([rows[0]!]);
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
    await persist([rows[0]!]);
    await withPipelineMutation(async (fresh, write) => {
      fresh[1]!.stateDetail = "neighbor changed";
      await write([fresh[1]!]);
    });
    rows[0]!.stateDetail = "second checkpoint";
    await persist();
    // A default checkpoint must not adopt the neighbor's unseen revision.
    rows[1]!.stateDetail = "stale neighbor";
    await expect(persist([rows[1]!])).rejects.toThrow("controller snapshot changed");
  });
  expect(loadPipelines().map(row => row.stateDetail)).toEqual(["second checkpoint", "neighbor changed"]);
});

test("a conflicting batch writes none of its decided results", async () => {
  savePipelines([fixtureLane("first"), fixtureLane("neighbor")]);
  await withPipelineControllerMutation(async (rows, persist) => {
    await withPipelineMutation(async (fresh, write) => {
      fresh[1]!.stateDetail = "neighbor changed";
      await write([fresh[1]!]);
    });
    rows[0]!.stateDetail = "uncommitted first";
    rows[1]!.stateDetail = "stale neighbor";
    await expect(persist(rows)).rejects.toThrow("controller snapshot changed");
  });
  expect(loadPipelines().map(row => row.stateDetail)).toEqual([null, "neighbor changed"]);
});

test("controller checkpoints defer immediately behind an admitted writer", async () => {
  savePipelines([fixtureLane("first")]);
  await withPipelineControllerMutation(async (rows, persist) => {
    await withPipelineMutation(async () => {
      rows[0]!.stateDetail = "deferred checkpoint";
      await expect(persist([rows[0]!])).rejects.toThrow("controller snapshot changed");
    });
  });
  expect(loadPipelines()[0]!.stateDetail).toBeNull();
});

test("the controller hold observer measures a sub-warning-threshold checkpoint", async () => {
  savePipelines([fixtureLane("measured-hold")]);
  const prototype = SqliteStateCollection.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
  const original = prototype.persistSession!;
  const observed: number[] = [];
  prototype.persistSession = function(this: unknown, ...args: unknown[]) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350);
    return original.apply(this, args);
  };
  try {
    await withPipelineControllerMutation(async (rows, persist) => {
      rows[0]!.stateDetail = "measured checkpoint";
      await persist([rows[0]!]);
    }, heldMs => observed.push(heldMs));
  } finally {
    prototype.persistSession = original;
  }
  expect(observed).toHaveLength(1);
  expect(observed[0]).toBeGreaterThanOrEqual(300);
  expect(observed[0]).toBeLessThan(1_000);
});

test("the active loop monitor logger retains operation scopes across a visible gap", () => {
  const lines: string[] = [];
  const restore = viewerLoopMonitor.setLogSink(line => lines.push(line));
  try {
    viewerLoopMonitor.run("pipelines.controller-mutation", () => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 550);
    });
    viewerLoopMonitor.tick();
  } finally {
    restore();
  }
  const diagnostic = lines.find(line => line.startsWith("[viewer loop-gap] "));
  expect(diagnostic).toBeDefined();
  expect(JSON.parse(diagnostic!.slice("[viewer loop-gap] ".length)).operations)
    .toContainEqual(expect.objectContaining({ name: "pipelines.controller-mutation" }));
});


test("a competing SQLite writer after controller lease acquisition yields before the checkpoint", async () => {
  savePipelines([fixtureLane("first")]);
  const prototype = SqliteStateCollection.prototype as unknown as {
    acquireLease(this: { filename: string }, wait?: number): Promise<string>;
  };
  const original = prototype.acquireLease;
  let holder: Database | undefined;
  let release: ReturnType<typeof setTimeout> | undefined;
  let last = performance.now(), maxGap = 0, acknowledgments = 0;
  const probe = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now; }, 5);
  prototype.acquireLease = async function(this: { filename: string }, wait?: number) {
    const token = await original.call(this, wait);
    holder = new Database(this.filename);
    holder.exec("BEGIN IMMEDIATE");
    release = setTimeout(() => { holder!.exec("ROLLBACK"); }, 100);
    return token;
  };
  try {
    await withPipelineControllerMutation(async (rows, persist) => {
      rows[0]!.stateDetail = "checkpoint after contention";
      await persist([rows[0]!]);
      acknowledgments++;
    });
    await Bun.sleep(10);
    expect(maxGap).toBeLessThanOrEqual(50);
    expect(acknowledgments).toBe(1);
    expect(loadPipelines()[0]!.stateDetail).toBe("checkpoint after contention");
  } finally {
    prototype.acquireLease = original;
    clearInterval(probe); clearTimeout(release); holder?.close();
  }
});


test("preparation tolerates an unrelated row write while each selected row retains its fence", async () => {
  savePipelines([fixtureLane("selected"),fixtureLane("peer")]);
  const { withControllerPipelineScope } = await import("./controllerScope");
  const prototype = SqliteStateCollection.prototype as unknown as { prepareControllerSnapshot: (...args: unknown[]) => Promise<unknown> };
  const original = prototype.prepareControllerSnapshot;
  let changed = false;
  const prepare = spyOn(prototype,"prepareControllerSnapshot").mockImplementation(async function(this: unknown, ...args) {
    const result = await original.apply(this,args);
    if (!changed) {
      changed = true;
      const db = new Database(`${process.env.LLV_STATE_DIR}/state.sqlite`);
      try {
        db.query("UPDATE state_rows SET value_json=json_set(value_json,'$.stateDetail','fresh peer'),row_revision=row_revision+1 WHERE collection='pipelines' AND row_key='peer'").run();
        db.query("UPDATE state_collections SET revision=revision+1 WHERE collection='pipelines'").run();
      } finally { db.close(); }
    }
    return result;
  });
  try {
    await withControllerPipelineScope(["selected"], () => withPipelineControllerMutation(async (rows,persist,assertCurrent) => {
      expect(rows.map(row => row.id)).toEqual(["selected"]);
      assertCurrent(rows[0]!);
      rows[0]!.stateDetail = "selected result";
      await persist(rows);
    }));
  } finally { prepare.mockRestore(); }
  expect(loadPipelines().map(row => row.stateDetail)).toEqual(["selected result","fresh peer"]);
});
