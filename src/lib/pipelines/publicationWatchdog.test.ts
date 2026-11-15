import { expect, test, spyOn } from "bun:test";
import { fs, path, spawnSync, tickPipelines, interruptedPublication, loadPipelines, savePipelines } from "./engine.fixture";
import { seatAgendaAsks } from "@/lib/attention/seatAgenda";
import { laneNeedKind, laneRouteKey } from "@/lib/attention/routeTypes";
import { acquirePublicationFileLock, releasePublicationFileLock, pipelinePublicationInFlight, publishPipelineBranch } from "./git";
import { settlePendingStageGit } from "./engine";
import { isStoredPipeline } from "./store";
import { cpuWaitElapsed } from "../runtime/cpuAdmissionBudget";

const NOW = Date.parse("2026-11-01T12:00:00Z");

/** A separate process owns the actual recorded inode until it exits. Its
 * ready acknowledgment precedes both the watchdog and induced expiry. */
async function silentPublisher(lock: string, runLock?: string) {
  const sharedFd = await acquirePublicationFileLock(lock);
  expect(sharedFd).not.toBeNull();
  const runFd = runLock ? await acquirePublicationFileLock(runLock) : null;
  if (runLock) expect(runFd).not.toBeNull();
  const child = Bun.spawn([process.execPath, "-e", `
    import fs from "node:fs";
    import { createInterface } from "node:readline";
    fs.fstatSync(3);
    if (process.argv[2]) fs.fstatSync(4);
    console.log("ready");
    createInterface({ input: process.stdin }).on("line", line => {
      if (line === "exit") process.exit(0);
    });
  `, lock, ...(runLock ? [runLock] : [])], { stdio: ["pipe", "pipe", "pipe", sharedFd!, ...(runFd === null ? [] : [runFd])], env: process.env });
  const reader = child.stdout.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const ready = await Promise.race([reader.read(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("publisher did not acknowledge readiness")), 5_000);
    })]);
    expect(new TextDecoder().decode(ready.value)).toBe("ready\n");
    expect(child.exitCode).toBeNull();
  } catch (error) { child.kill(); await child.exited; throw error; }
  finally {
    clearTimeout(timer); reader.releaseLock();
    releasePublicationFileLock(sharedFd!);
    if (runFd !== null) releasePublicationFileLock(runFd);
  }
  return child;
}

test.each(["alive", "queued", "long-wait", "unreadable-budget", "oversized-budget", "corrupt-budget", "exited", "deadline", "fresh-deadline", "finished", "legacy", "replaced", "missing", "many-waits-fresh", "many-waits-stale", "foreign-holder", "reused-pid", "run-fence-missing", "run-fence-replaced"] as const)(
  "the real publication watchdog reconciles a silent publisher: %s", async kind => {
    const { h, box, pipeline } = await interruptedPublication();
    const operation = pipeline.delivery!.operation!;
    const executor = operation.executor!;
    // The old Viewer is gone. The publisher still holds the inherited fence,
    // with no stdout or mtime heartbeat during the simulated silent interval.
    executor.pid = 0;
    executor.identity = null;
    delete executor.finished;
    delete executor.result;
    const waitRoot = path.join(path.dirname(executor.lock), "watchdog-wait");
    fs.mkdirSync(waitRoot);
    executor.command = { deadline: new Date(NOW + 600_000).toISOString(), waitRoot };
    savePipelines([pipeline]);
    const runLock = executor.lock + ".run";
    fs.writeFileSync(runLock, "");
    const stat = fs.statSync(runLock);
    executor.runLock = { path: runLock, identity: `${stat.dev}:${stat.ino}` };
    savePipelines([pipeline]);
    const child = await silentPublisher(executor.lock, runLock);
    const stale = new Date(NOW - 120_000);
    fs.utimesSync(executor.lock, stale, stale);
    let intruder: Awaited<ReturnType<typeof silentPublisher>> | undefined;
    let clock: { mockRestore(): void } | undefined;
    try {
      if (kind === "exited" || kind === "foreign-holder" || kind === "reused-pid") {
        child.stdin.write("exit\n");
        child.stdin.flush();
        expect(await child.exited).toBe(0);
        if (kind !== "exited") intruder = await silentPublisher(executor.lock);
        if (kind === "reused-pid") {
          executor.pid = intruder!.pid;
          executor.identity = "earlier-process-generation";
          savePipelines([pipeline]);
        }
      }
      if (kind === "deadline" || kind === "fresh-deadline" || kind === "queued" || kind === "long-wait") {
        executor.command.deadline = new Date(NOW - 30_000).toISOString();
        if (kind === "queued") fs.writeFileSync(path.join(waitRoot, "wait.json"), JSON.stringify({ start: NOW - 90_000, end: NOW }));
        if (kind === "long-wait") fs.writeFileSync(path.join(waitRoot, "wait.json"), JSON.stringify({ start: NOW - 12 * 60_000, end: NOW }));
        if (kind === "fresh-deadline") fs.utimesSync(executor.lock, new Date(NOW), new Date(NOW));
        savePipelines([pipeline]);
      }
      if (kind === "unreadable-budget" || kind === "oversized-budget" || kind === "corrupt-budget") {
        executor.command.deadline = new Date(NOW - 30_000).toISOString();
        savePipelines([pipeline]);
      }
      if (kind === "unreadable-budget") fs.rmdirSync(waitRoot);
      if (kind === "corrupt-budget") fs.writeFileSync(path.join(waitRoot, "broken.json"), "{");
      if (kind === "oversized-budget") {
        for (let n = 0; n < 257; n++) fs.writeFileSync(path.join(waitRoot, `${n}.json`), "{}");
      }
      if (kind === "legacy") {
        delete executor.command;
        savePipelines([pipeline]);
      }
      if (kind === "finished") {
        executor.finished = true;
        savePipelines([pipeline]);
      }
      if (kind === "replaced" || kind === "missing") {
        fs.renameSync(executor.lock, executor.lock + ".old");
        if (kind === "replaced") {
          fs.writeFileSync(executor.lock, "");
          fs.utimesSync(executor.lock, stale, stale);
        }
        // A missing/replaced inode must not borrow the original's age either.
        pipeline.createdAt = stale.toISOString();
        savePipelines([pipeline]);
      }
      if (kind === "run-fence-missing" || kind === "run-fence-replaced") {
        fs.renameSync(runLock, runLock + ".old");
        if (kind === "run-fence-replaced") fs.writeFileSync(runLock, "");
      }
      if (kind === "many-waits-fresh" || kind === "many-waits-stale") {
        for (let index = 0; index < 256; index++) fs.writeFileSync(path.join(waitRoot, `${index}.json`), JSON.stringify({ start: NOW - 720_000, end: NOW - 720_000, closed: true }));
        fs.writeFileSync(path.join(waitRoot, "wait.json"), JSON.stringify({ start: NOW - 720_000, end: NOW, closed: true }));
        executor.command!.deadline = new Date(NOW - 660_000).toISOString();
        // Exercise the full execution reader before the bounded observer.
        expect(cpuWaitElapsed(waitRoot, NOW)).toBe(720_000);
        if (kind === "many-waits-fresh") fs.utimesSync(executor.lock, new Date(NOW), new Date(NOW));
        savePipelines([pipeline]);
      }
      clock = spyOn(Date, "now").mockReturnValue(NOW);
      // Drive the controller's real committing watchdog before the next
      // tick's opportunistic remote reconciliation can heal an exited writer.
      await settlePendingStageGit(h.ports);
      const current = loadPipelines()[0]!;
      const need = laneNeedKind(current);
      if (need) current.attentionRoute = { key: laneRouteKey(current, need), owner: "seat", seat: "conversation_seat" };
      const asks = seatAgendaAsks({ files: [], pipelines: [current] }, NOW / 1000, current.project);
      if (["alive", "queued", "long-wait", "unreadable-budget", "oversized-budget", "corrupt-budget", "legacy", "many-waits-fresh", "many-waits-stale"].includes(kind)) {
        expect(current).toMatchObject({ state: "running", cursor: { stageId: "build", state: "committing" } });
        expect(current.stateDetail).not.toContain("no progress");
        expect(asks).toEqual([]);
        expect(child.exitCode).toBeNull();
        expect(fs.statSync(executor.lock).mtimeMs).toBe(kind === "many-waits-fresh" ? NOW : stale.getTime());
        expect(pipelinePublicationInFlight(current)).toMatchObject({ ok: true, remote: "unreachable" });
        if (kind === "alive" || kind === "long-wait" || kind.startsWith("many-waits")) {
          const restarted = spawnSync(process.execPath, ["-e", `
            import { findPipelineRecord } from "./src/lib/pipelines/store";
            import { pipelinePublicationInFlight } from "./src/lib/pipelines/git";
            Date.now = () => ${NOW};
            const result = pipelinePublicationInFlight(findPipelineRecord(process.argv[1]));
            if (!result.ok) throw new Error(result.error);
          `, pipeline.id], { cwd: process.cwd(), env: process.env, encoding: "utf8", timeout: 10_000 });
          expect(restarted.status, restarted.stderr).toBe(0);
        }
        if (kind.startsWith("many-waits")) {
          clock!.mockRestore();
          clock = spyOn(Date, "now").mockReturnValue(NOW + 660_001);
          await settlePendingStageGit(h.ports);
          expect(loadPipelines()[0]!.state).toBe("needs_decision");
          expect(loadPipelines()[0]!.stateDetail).toContain("deadline has expired");
          expect(loadPipelines()[0]!.delivery!.operation!.id).toBe(operation.id);
          expect(child.exitCode).toBeNull();
          return;
        }
        await tickPipelines([], h.ports);
        expect(loadPipelines()[0]!.state).toBe("running");
        if (kind === "unreadable-budget" || kind === "oversized-budget" || kind === "corrupt-budget" || kind === "legacy") {
          const fallbackDeadline = kind === "legacy"
            ? stale.getTime() + 25 * 60_000 + 10 * 60_000
            : Date.parse(executor.command!.deadline) + 10 * 60_000;
          clock!.mockRestore();
          clock = spyOn(Date, "now").mockReturnValue(fallbackDeadline - 1);
          await settlePendingStageGit(h.ports);
          expect(loadPipelines()[0]!.state).toBe("running");
          clock!.mockRestore();
          clock = spyOn(Date, "now").mockReturnValue(fallbackDeadline + 1);
          await settlePendingStageGit(h.ports);
          expect(loadPipelines()[0]).toMatchObject({ state: "needs_decision", delivery: { operation: { id: operation.id } } });
          if (kind === "legacy") expect(loadPipelines()[0]!.stateDetail).toContain("has no progress");
          else expect(loadPipelines()[0]!.stateDetail).toContain("its recorded command deadline has expired");
        }
      } else {
        expect(current.state).toBe("needs_decision");
        expect(current.stateDetail).toContain(`publication ${operation.id} has no progress for ${kind === "fresh-deadline" ? 0 : 120}s`);
        if (kind === "deadline" || kind === "fresh-deadline") expect(current.stateDetail).toContain("its recorded command deadline has expired");
        expect(current.stateDetail).toContain(`takeover with expectedOwner ${pipeline.id} and expectedEpoch 1`);
        expect(asks).toHaveLength(1);
      }
      expect(current.delivery!.operation!.id).toBe(operation.id);
      expect(current.runs[0]!.attempts[0]!.state).toBe("passed");
      expect(h.spawnInputs).toHaveLength(1);
      expect(box.order).toEqual(["commit"]);
    } finally {
      clock?.mockRestore();
      if (intruder) { if (intruder.exitCode === null) intruder.kill(); await intruder.exited; }
      if (child.exitCode === null) child.kill();
      await child.exited;
      if (fs.existsSync(executor.lock + ".old")) {
        fs.rmSync(executor.lock, { force: true });
        fs.renameSync(executor.lock + ".old", executor.lock);
      }
      fs.rmSync(waitRoot, { recursive: true, force: true });
      fs.rmSync(`${waitRoot}.confirmed`, { force: true });
      fs.rmSync(runLock, { force: true });
      fs.rmSync(runLock + ".old", { force: true });
    }
  },
);

test("the publisher records the actual command budget before dispatch and clears it after settlement", async () => {
  const { h, box, pipeline } = await interruptedPublication();
  pipeline.delivery!.operation!.state = "pending";
  delete pipeline.delivery!.operation!.executor;
  savePipelines([pipeline]);
  let observed = false;
  const exec = h.ports.exec;
  const result = await publishPipelineBranch(pipeline, async (command, args, cwd, env, options) => {
    if (args[0] === "push") {
      observed = true;
      const saved = loadPipelines()[0]!;
      const execution = saved.delivery!.operation!.executor!.command!;
      expect(isStoredPipeline(saved)).toBe(true);
      expect(pipelinePublicationInFlight(saved).ok).toBe(true);
      const runLock = saved.delivery!.operation!.executor!.runLock!;
      expect(runLock.path).not.toBe(saved.delivery!.operation!.executor!.lock);
      expect(options!.additionalInheritedFds).toHaveLength(1);
      const inherited = spawnSync(process.execPath, ["-e", `
        import { findPipelineRecord } from "./src/lib/pipelines/store";
        import { pipelinePublicationInFlight } from "./src/lib/pipelines/git";
        const result = pipelinePublicationInFlight(findPipelineRecord(process.argv[1]));
        if (!result.ok) throw new Error(result.error);
      `, pipeline.id], { cwd: process.cwd(), env: process.env, encoding: "utf8", timeout: 10_000,
        stdio: ["ignore", "pipe", "pipe", options!.inheritFd!, ...options!.additionalInheritedFds!] });
      expect(inherited.status, inherited.stderr).toBe(0);
      for (const invalid of [null, {}, { path: runLock.path, identity: "invalid" }]) {
        const broken = structuredClone(saved);
        broken.delivery!.operation!.executor!.runLock = invalid as never;
        expect(isStoredPipeline(broken)).toBe(false);
      }
      for (const invalid of [null, {}, { deadline: "invalid", waitRoot: execution.waitRoot }, { deadline: execution.deadline, waitRoot: "" }]) {
        const broken = structuredClone(saved);
        broken.delivery!.operation!.executor!.command = invalid as never;
        expect(isStoredPipeline(broken)).toBe(false);
      }
      expect(Date.parse(execution.deadline)).toBeGreaterThan(Date.now());
      expect(Date.parse(execution.deadline)).toBeLessThanOrEqual(Date.now() + options!.timeoutMs!);
      expect(JSON.parse(env!.LLV_CPU_WAIT_ROOTS!)).toContain(execution.waitRoot);
      expect(fs.statSync(execution.waitRoot).isDirectory()).toBe(true);
    }
    return exec(command, args, cwd, env, options);
  }, { acceptedSha: box.passedSha });
  expect(observed).toBe(true);
  expect(result).toMatchObject({ ok: true, remote: "published" });
  expect(loadPipelines()[0]!.delivery!.operation!.executor!.command).toBeUndefined();
});

test("a publisher contender cannot confirm an exited operation with its newly acquired fence", async () => {
  const { h, box, pipeline } = await interruptedPublication();
  const executor = pipeline.delivery!.operation!.executor!;
  executor.pid = 0;
  executor.identity = null;
  delete executor.finished;
  delete executor.result;
  const stale = new Date(NOW - 120_000);
  fs.utimesSync(executor.lock, stale, stale);
  savePipelines([pipeline]);
  const clock = spyOn(Date, "now").mockReturnValue(NOW);
  try {
    const result = await publishPipelineBranch(pipeline, h.ports.exec, { acceptedSha: box.passedSha });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("has no progress for 120s");
  } finally { clock.mockRestore(); }
});
