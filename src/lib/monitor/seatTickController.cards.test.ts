import { expect, test } from "bun:test";
import { fs, path, spawn, SANDBOX, NOW, MINUTE, OPEN_LANE, FINISHED_LANE, OVERDUE, harness, offSettings, defaultSeatTickSettings, runSeatTickCheck, readSeatTickState, writeSeatTickState, emptySeatTickState, standingGap } from "./seatTickController.fixture";
import type { DeliveryOutcome } from "./seatTickController.fixture";

test.skipIf(!process.env.LLV_CARD_RESTART_FILE)("closed card restart worker", async () => {
  process.env.LLV_STATE_DIR = path.dirname(process.env.LLV_CARD_RESTART_FILE!);
  const settings = JSON.parse(process.env.LLV_CARD_RESTART_SETTINGS!);
  const rig = harness({ pipelines: OPEN_LANE, settings });
  await runSeatTickCheck(settings.project, { ...rig.deps, ensureCard: undefined });
});

async function restartCheck(file: string, settings: ReturnType<typeof offSettings>) {
  const child = spawn(process.execPath, ["test", "--timeout=60000", import.meta.path, "--test-name-pattern", "^closed card restart worker$"], {
    env: { ...process.env, LLV_CARD_RESTART_FILE: file, LLV_CARD_RESTART_SETTINGS: JSON.stringify(settings) },
    stdio: ["ignore", "pipe", "pipe"], timeout: 45_000, killSignal: "SIGKILL",
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream!.on("data", chunk => { output = (output + chunk).slice(-8_000); });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`restart check exited ${code}: ${output}`)));
  });
}

async function boardCase(run: (file: string) => Promise<void>) {
  const previous = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = fs.mkdtempSync(path.join(SANDBOX, "closed-card-"));
  try { await run(path.join(process.env.LLV_STATE_DIR, "tasks.json")); }
  finally { process.env.LLV_STATE_DIR = previous; }
}

for (const legacy of [false, true]) for (const retainReceipt of [false, true]) test(`closed settings facts stay closed and a new revision opens (${legacy ? "legacy" : "current"}, receipt=${retainReceipt})`, async () => {
  await boardCase(async file => {
    const { loadTasks, mutateTasksFile } = await import("@/lib/tasks/store");
    const { patchTask } = await import("@/lib/tasks/commands");
    const project = "closed-settings";
    const settings = { ...offSettings(), project };
    const check = async () => {
      const rig = harness({ pipelines: OPEN_LANE, settings });
      await runSeatTickCheck(project, { ...rig.deps, ensureCard: undefined });
    };
    await check();
    const first = loadTasks(file).find(task => task.project === project)!;
    expect(first.status).toBe("inbox");
    const close = (id: string) => mutateTasksFile(({ tasks, recentCreates }) => {
      const result = patchTask(tasks, id, { status: "done", ...(legacy ? { details: "" } : {}) });
      if (!result.ok) throw new Error(result.error);
      return { state: { tasks: result.tasks, recentCreates: retainReceipt ? recentCreates : [] }, result: true };
    }, file);
    close(first.id);
    await restartCheck(file, settings);
    await check();
    expect(loadTasks(file).filter(task => task.project === project && task.status !== "done")).toEqual([]);
    settings.updatedAt = new Date(NOW + MINUTE).toISOString();
    settings.wakeIntervalMinutes = 240;
    settings.enabled = true;
    await check();
    const next = loadTasks(file).filter(task => task.project === project && task.status !== "done");
    expect(next).toHaveLength(1);
    expect(next[0]!.id).not.toBe(first.id);
    close(next[0]!.id);
    await check();
    expect(loadTasks(file).filter(task => task.project === project && task.status !== "done")).toEqual([]);
  });
});

for (const legacy of [false, true]) test(`a closed source outage stays closed when reporting is retried (${legacy ? "legacy" : "current"})`, async () => {
  await boardCase(async file => {
    const { loadTasks, mutateTasksFile } = await import("@/lib/tasks/store");
    const { patchTask } = await import("@/lib/tasks/commands");
    const project = "closed-source";
    let gap = standingGap();
    const check = async () => {
      const rig = harness({ pipelines: [...OPEN_LANE, ...FINISHED_LANE].map(lane => ({ ...lane, project })),
        state: { ...OVERDUE, pullRequestGap: gap }, pullRequestsUnavailable: "command-failed", settings: defaultSeatTickSettings(project) });
      await runSeatTickCheck(project, { ...rig.deps, ensureCard: undefined });
      expect(rig.written.at(-1)!.pullRequestGap?.reported).toBe(true);
    };
    await check();
    const first = loadTasks(file).find(task => task.project === project)!;
    expect(first.status).toBe("inbox");
    mutateTasksFile(({ tasks }) => {
      const closed = patchTask(tasks, first.id, { status: "done", ...(legacy ? { details: "" } : {}) });
      if (!closed.ok) throw new Error(closed.error);
      return { state: { tasks: closed.tasks, recentCreates: [] }, result: true };
    }, file);
    gap = { ...gap, attempts: gap.attempts + 1 };
    await check();
    expect(loadTasks(file).filter(task => task.project === project && task.status !== "done")).toEqual([]);
    gap = { ...gap, since: new Date(NOW - 120 * MINUTE).toISOString() };
    await check();
    expect(loadTasks(file).filter(task => task.project === project && task.status !== "done")).toHaveLength(1);
  });
});

for (const legacy of [false, true]) test(`closed wake facts stay closed and a different wake opens (${legacy ? "legacy" : "current"})`, async () => {
  await boardCase(async file => {
    const { loadTasks, mutateTasksFile } = await import("@/lib/tasks/store");
    const { patchTask } = await import("@/lib/tasks/commands");
    const project = "closed-wake";
    const stateFile = path.join(path.dirname(file), "seat-tick.json");
    writeSeatTickState(project, { ...emptySeatTickState(), ...OVERDUE, seatEpoch: 7, accounting: undefined }, stateFile);
    const check = async (now: number) => {
      const rig = harness({ stateFile, now, pipelines: [{ ...OPEN_LANE[0]!, project }], settings: defaultSeatTickSettings(project),
        wakeState: "unknown", delivery: { ok: true, target: null, outcome: "queued", operationId: "closed-wake-op", receipt: {}, structured: true } as DeliveryOutcome });
      await runSeatTickCheck(project, { ...rig.deps, ensureCard: undefined });
    };
    const cards = () => loadTasks(file).filter(task => task.project === project && task.text.includes("monitor-ref: seat-tick-wake-unresolved"));
    const close = (id: string) => mutateTasksFile(({ tasks }) => {
      const result = patchTask(tasks, id, { status: "done", ...(legacy ? { details: "" } : {}) });
      if (!result.ok) throw new Error(result.error);
      return { state: { tasks: result.tasks, recentCreates: [] }, result: true };
    }, file);
    await check(NOW);
    const firstKey = readSeatTickState(project, stateFile).outstandingWake!.clientMessageId;
    await check(NOW + 61 * MINUTE);
    expect(cards()).toHaveLength(1);
    expect(cards()[0]!.text).toContain(firstKey);
    close(cards()[0]!.id);
    await check(NOW + 62 * MINUTE);
    expect(cards().filter(task => task.status !== "done")).toEqual([]);
    await check(NOW + 121 * MINUTE);
    const nextKey = readSeatTickState(project, stateFile).outstandingWake!.clientMessageId;
    expect(nextKey).not.toBe(firstKey);
    await check(NOW + 182 * MINUTE);
    const opened = cards().filter(task => task.status !== "done");
    expect(opened).toHaveLength(1);
    expect(opened[0]!.text).toContain(nextKey);
    close(opened[0]!.id);
    await check(NOW + 183 * MINUTE);
    expect(cards().filter(task => task.status !== "done")).toEqual([]);
  });
});

test("dismissed MCP facts stay closed, while a new epoch or a recovered outage can reopen", async () => {
  await boardCase(async file => {
    const { loadTasks, mutateTasksFile } = await import("@/lib/tasks/store");
    const { patchTask } = await import("@/lib/tasks/commands");
    const project = "closed-mcp";
    const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE });
    let healthy = false;
    const deps = { ...rig.deps, ensureCard: undefined, mcpHealth: () => ({
      status: healthy ? "healthy" as const : "dead" as const, detail: "fixture MCP health",
    }) };
    const check = () => runSeatTickCheck(project, deps);
    const cards = () => loadTasks(file).filter(task => task.project === project
      && task.text.includes("monitor-ref: seat-viewer-mcp-unavailable"));
    await check();
    expect(cards()).toHaveLength(1);
    const first = cards()[0]!;
    mutateTasksFile(({ tasks, recentCreates }) => {
      const closed = patchTask(tasks, first.id, { status: "done" });
      if (!closed.ok) throw new Error(closed.error);
      return { state: { tasks: closed.tasks, recentCreates }, result: true };
    }, file);
    await check();
    expect(cards()[0]!.status).toBe("done");
    rig.seat = { ...rig.seat!, seatEpoch: rig.seat!.seatEpoch + 1 };
    await check();
    expect(cards()).toHaveLength(1);
    expect(cards()[0]!.status).toBe("inbox");
    healthy = true;
    await check();
    expect(cards()[0]!.status).toBe("done");
    healthy = false;
    await check();
    expect(cards()).toHaveLength(1);
    expect(cards()[0]!.status).toBe("inbox");
    healthy = true;
    await check();
    const resolved = cards()[0]!;
    // An operator's later close wins even if it shares the resolution's clock.
    mutateTasksFile(({ tasks, recentCreates }) => {
      const opened = patchTask(tasks, resolved.id, { status: "inbox" }, resolved.updatedAt);
      if (!opened.ok) throw new Error(opened.error);
      const closed = patchTask(opened.tasks, resolved.id, { status: "done" }, resolved.updatedAt,
        { statusActor: { kind: "operator" } });
      if (!closed.ok) throw new Error(closed.error);
      return { state: { tasks: closed.tasks, recentCreates }, result: true };
    }, file);
    healthy = false;
    await check();
    expect(cards()[0]!.status).toBe("done");
  });
});
