import { afterEach, describe, expect, jest, test } from "bun:test";
import fs from "node:fs";

import { LANE_BRANCH } from "@/lib/laneReview/gitFixture";
import { realExec, type ExecPort, type ExecResult } from "@/lib/workflows/provision";
import { Aborted, createTaskFilesCaches } from "./cache";
import { createBulkFixture, createTaskFixture, spyExec, type TaskFixture } from "./fixture";
import { documentBaseDir, laneFiles, parseTree, readBlob, resolveFile, sortRows, type TaskFile, type TaskFilesLane } from "./files";

const fixtures: TaskFixture[] = [];
const keep = <T extends TaskFixture>(fixture: T): T => { fixtures.push(fixture); return fixture; };
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.cleanup(); });

const deps = (exec = realExec) => ({ exec, caches: createTaskFilesCaches() });
const okLane = (answer: TaskFilesLane) => {
  if (answer.status !== "ok") throw new Error(`lane unavailable: ${answer.reason}`);
  return answer;
};
const byPath = (files: readonly TaskFile[], path: string) => files.find((file) => file.path === path)!;

/** Lets pending promise work run until the condition holds. Microtasks only,
    so no wall clock decides the outcome; a condition that never holds fails. */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let turn = 0; turn < 20_000; turn += 1) {
    if (condition()) return;
    await Promise.resolve();
    if (turn % 100 === 99) await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`never reached: ${what}`);
}

/** An exec port whose diff calls wait until the test releases them. Its other
    calls answer at once from a fixed commit pair. Every call is counted. */
function heldExec(head: string, base: string) {
  const held: Array<{ finish: () => void }> = [];
  const state = { diffs: 0, active: 0, peak: 0, hold: true, signals: [] as Array<AbortSignal | undefined> };
  const exec: ExecPort = async (_command, args, _cwd, _env, options) => {
    if (args.includes("rev-parse")) return { code: 0, stdout: `${head}\n`, stderr: "" };
    if (args.includes("merge-base")) return { code: 0, stdout: `${base}\n`, stderr: "" };
    if (args.includes("show")) return { code: 0, stdout: "1790000000\n", stderr: "" };
    if (args.includes("diff")) {
      state.diffs += 1;
      state.signals.push(options?.signal);
      if (!state.hold) return { code: 0, stdout: "", stderr: "" };
      state.active += 1;
      state.peak = Math.max(state.peak, state.active);
      return new Promise<ExecResult>((resolve) => {
        held.push({ finish: () => { state.active -= 1; resolve({ code: 0, stdout: "", stderr: "" }); } });
      });
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const release = () => { state.hold = false; for (const call of held.splice(0)) call.finish(); };
  return { exec, state, release };
}


describe("the one ls-tree per lane", () => {
  test("gives modes and sizes: a symlink is link, a gitlink is submodule, a huge blob carries its size", async () => {
    const fixture = keep(createTaskFixture({ big: true }));
    const answer = okLane(await laneFiles(fixture.lane(), deps()));
    expect(byPath(answer.files, "link.md")).toMatchObject({ mode: "link", previewable: false });
    expect(byPath(answer.files, "vendor/module.md")).toMatchObject({ mode: "submodule", size: null, previewable: false });
    expect(byPath(answer.files, "data/huge.txt")).toMatchObject({ mode: "file", size: 9 * 1024 * 1024, previewable: false });
    expect(byPath(answer.files, "docs/handoff/summary.md")).toMatchObject({ mode: "file", previewable: true, op: "add", declaredBy: "design" });
    expect(byPath(answer.files, "docs/report.pdf")).toMatchObject({ size: 4 * 1024 * 1024 + 9, previewable: true });
    expect(byPath(answer.files, ".env.local")).toMatchObject({ previewable: false, group: "other" });
    expect(byPath(answer.files, "docs/binary.md")).toMatchObject({ binary: true, mode: "file", previewable: false });
    expect(byPath(answer.files, "src/gone.ts")).toMatchObject({ op: "delete", mode: null, size: null, previewable: false });
  });

  test("runs no git status and exactly one ls-tree for the whole list", async () => {
    const fixture = keep(createTaskFixture());
    const spy = spyExec();
    okLane(await laneFiles(fixture.lane(), deps(spy.exec)));
    expect(spy.calls.filter((call) => call.includes("status"))).toEqual([]);
    expect(spy.calls.filter((call) => call.includes("ls-tree"))).toHaveLength(1);
    expect(spy.calls.filter((call) => call.includes("cat-file"))).toEqual([]);
  });
});

describe("grouping, order and truncation", () => {
  test("declared outputs first, then documents (Markdown first), images, source, other; deletions last", async () => {
    const fixture = keep(createTaskFixture());
    const answer = okLane(await laneFiles(fixture.lane(), deps()));
    const groups = answer.files.map((file) => file.group);
    const live = answer.files.filter((file) => file.op !== "delete");
    expect(live.map((file) => file.group)).toEqual([...live.map((file) => file.group)].sort((a, b) => ["declared", "document", "image", "source", "other"].indexOf(a) - ["declared", "document", "image", "source", "other"].indexOf(b)));
    expect(answer.files.slice(0, 2).map((file) => file.path)).toEqual(["docs/handoff/notes.md", "docs/handoff/summary.md"]);
    expect(answer.files.at(-1)).toMatchObject({ path: "src/gone.ts", op: "delete" });
    expect(groups).toContain("image");
    expect(byPath(answer.files, "docs/readme.md").group).toBe("document");
    expect(byPath(answer.files, "data/table.csv").group).toBe("document");
    expect(byPath(answer.files, "src/added.ts").group).toBe("source");
    const docs = answer.files.filter((file) => file.group === "document").map((file) => file.path);
    expect(docs.indexOf("docs/readme.md")).toBeLessThan(docs.indexOf("data/table.csv"));
  });

  test("truncation happens after the sort, keeps declared and documents, and reports the real total", async () => {
    const fixture = keep(createBulkFixture(250));
    const answer = okLane(await laneFiles(fixture.lane(), deps()));
    expect(answer.files).toHaveLength(200);
    expect(answer.total).toBeGreaterThan(250);
    expect(answer.truncated).toBe(true);
    expect(answer.files[0]).toMatchObject({ path: "outputs/answer.md", group: "declared" });
    expect(answer.files.some((file) => file.path === "zz/last.md")).toBe(true);
    expect(answer.files.some((file) => file.path === "bulk/file-249.txt")).toBe(false);
  });

  test("sortRows is stable on ties and puts a deletion after everything", () => {
    const rows = [
      { path: "z.md", op: "delete" as const, group: "document" as const },
      { path: "b.txt", op: "add" as const, group: "document" as const },
      { path: "a.md", op: "add" as const, group: "document" as const },
    ];
    expect(sortRows(rows).map((row) => row.path)).toEqual(["a.md", "b.txt", "z.md"]);
  });

  test("parseTree reads records and refuses a half record", () => {
    expect(parseTree("100644 blob 0123456789012345678901234567890123456789     12\ta b.md\0")).toEqual([{ mode: "100644", type: "blob", oid: "0123456789012345678901234567890123456789", size: 12, path: "a b.md" }]);
    expect(parseTree("100644 blob abc")).toBeNull();
    expect(parseTree("")).toEqual([]);
  });
});

describe("revisions", () => {
  test("the branch tip, then the last passed commit once the branch is gone, then commits-gone", async () => {
    const fixture = keep(createTaskFixture());
    const head = fixture.headSha();
    const first = okLane(await laneFiles(fixture.lane(), deps()));
    expect(first).toMatchObject({ head, headSource: "branch" });
    expect(first.committedAt).toBe(Date.parse("2026-10-23T08:00:00Z"));
    fixture.git("branch", "-q", "-D", LANE_BRANCH);
    const passed = okLane(await laneFiles({ ...fixture.lane(), lastPassedCommit: head }, deps()));
    expect(passed).toMatchObject({ head, headSource: "last-passed" });
    expect(await laneFiles(fixture.lane(), deps())).toEqual({ lane: "lane-fixture", status: "unavailable", reason: "commits-gone" });
  });

  test("a repository that is not on this machine is repository-missing", async () => {
    const fixture = keep(createTaskFixture());
    expect(await laneFiles({ ...fixture.lane(), repoDir: `${fixture.dir}-absent` }, deps())).toEqual({ lane: "lane-fixture", status: "unavailable", reason: "repository-missing" });
  });
});

describe("a task's interval", () => {
  test("registered committed files stay listed and readable after the lane lands on main, the branch is swept and the cache resets", async () => {
    const fixture = keep(createTaskFixture());
    const head = fixture.headSha();
    const before = okLane(await laneFiles(fixture.lane(), deps()));
    /* A landing: origin/main now contains the head, so the merge base is the head itself. */
    fixture.git("update-ref", "refs/remotes/origin/main", head);
    const landed = okLane(await laneFiles(fixture.lane(), deps()));
    expect(landed.files).toEqual(before.files);
    expect(landed.total).toBe(before.total);
    expect(landed.base).toBe(fixture.lane().baseRef);
    const opened = await resolveFile(fixture.lane(), head, "docs/handoff/summary.md", deps());
    expect("status" in opened).toBe(false);
    /* The branch swept: the last passed commit still names the head. */
    fixture.git("branch", "-q", "-D", LANE_BRANCH);
    const swept = okLane(await laneFiles({ ...fixture.lane(), lastPassedCommit: head }, deps()));
    expect(swept.files).toEqual(before.files);
    expect(swept).toMatchObject({ headSource: "last-passed" });
    const read = await resolveFile({ ...fixture.lane(), lastPassedCommit: head }, head, "docs/handoff/summary.md", deps());
    expect("status" in read).toBe(false);
  });

  test("a head from before the task's base is refused, cold and warm, with and without a remote ref", async () => {
    const fixture = keep(createTaskFixture());
    const historical = fixture.headSha();
    fixture.git("checkout", "-q", LANE_BRANCH);
    fixture.write("docs/handoff/summary.md", "# Changed before the task started\n");
    const taskBase = fixture.commit("before the task");
    fixture.write("docs/result.md", "# This task's result\n");
    fixture.commit("task output");
    fixture.git("checkout", "-q", "--detach");
    for (const remote of [false, true]) {
      if (remote) fixture.git("update-ref", "refs/remotes/origin/main", taskBase);
      else fixture.git("update-ref", "-d", "refs/remotes/origin/main");
      const lane = { ...fixture.lane(), baseRef: taskBase, stages: [] };
      const shared = deps();
      for (const round of ["cold", "warm"]) {
        const refused = await resolveFile(lane, historical, "docs/handoff/summary.md", shared);
        expect({ remote, round, refused }).toMatchObject({ refused: { status: 409, code: "head_unknown" } });
      }
      const tip = await resolveFile(lane, fixture.headSha(), "docs/result.md", shared);
      expect("status" in tip).toBe(false);
    }
  });

  test("a base branch that lags the task's start never widens the interval, cold or warm", async () => {
    const fixture = keep(createTaskFixture());
    const historical = fixture.headSha();
    fixture.git("checkout", "-q", LANE_BRANCH);
    fixture.write("docs/handoff/summary.md", "# Before this task\n");
    const taskBase = fixture.commit("before the task");
    fixture.write("docs/result.md", "# This task\n");
    const middle = fixture.commit("task output");
    fixture.write("docs/later.md", "# Later\n");
    fixture.commit("task output, later");
    fixture.git("checkout", "-q", "--detach");
    /* origin/main still points at the fixture's first commit, older than the task's base. */
    const lane = { ...fixture.lane(), baseRef: taskBase, stages: [] };
    const shared = deps();
    for (const round of ["cold", "warm"]) {
      expect({ round, refused: await resolveFile(lane, historical, "docs/handoff/summary.md", shared) }).toMatchObject({ refused: { status: 409, code: "head_unknown" } });
    }
    const listed = okLane(await laneFiles(lane, shared));
    expect(listed.base).toBe(taskBase);
    expect(listed.files.map((file) => file.path).sort()).toEqual(["docs/later.md", "docs/result.md"]);
    /* A revision inside the task, and the tip, stay readable. */
    for (const [head, file] of [[middle, "docs/result.md"], [fixture.headSha(), "docs/later.md"]] as const) {
      expect("status" in await resolveFile(lane, head, file, shared)).toBe(false);
    }
    /* The same after the lane landed and its branch was swept. */
    fixture.git("update-ref", "refs/remotes/origin/main", fixture.headSha());
    fixture.git("branch", "-q", "-D", LANE_BRANCH);
    const swept = { ...lane, lastPassedCommit: fixture.git("rev-parse", "refs/remotes/origin/main") };
    const after = deps();
    for (const round of ["cold", "warm"]) {
      expect({ round, refused: await resolveFile(swept, historical, "docs/handoff/summary.md", after) }).toMatchObject({ refused: { status: 409, code: "head_unknown" } });
    }
    expect("status" in await resolveFile(swept, middle, "docs/result.md", after)).toBe(false);
  });

  test("an earlier lane revision stays readable after the lane landed", async () => {
    const fixture = keep(createTaskFixture());
    const first = fixture.headSha();
    fixture.git("checkout", "-q", LANE_BRANCH);
    fixture.write("docs/later.md", "# later\n");
    fixture.commit("later");
    fixture.git("checkout", "-q", "--detach");
    fixture.git("update-ref", "refs/remotes/origin/main", fixture.headSha());
    const shared = deps();
    expect("status" in await resolveFile(fixture.lane(), first, "docs/handoff/summary.md", shared)).toBe(false);
    expect("status" in await resolveFile(fixture.lane(), fixture.headSha(), "docs/later.md", shared)).toBe(false);
  });

  test("a lane shares nothing but Git facts with another lane on the same commit pair", async () => {
    const fixture = keep(createTaskFixture());
    const shared = deps();
    const first = fixture.lane();
    const second = { ...fixture.lane(), id: "lane-second", stages: [{ id: "second", name: "Second", outputs: ["src/added.ts"] }] as unknown as typeof first.stages };
    await laneFiles(first, shared);
    const warm = await laneFiles(second, shared);
    expect(warm).toEqual(await laneFiles(second, deps()));
    expect(byPath(okLane(warm).files, "src/added.ts")).toMatchObject({ group: "declared", declaredBy: "second" });
    expect(byPath(okLane(warm).files, "docs/handoff/summary.md").declaredBy).toBeUndefined();
    /* A changed declaration on the same lane and commits is read afresh. */
    const redeclared = { ...first, stages: [{ id: "design", name: "design", outputs: ["data"] }] as unknown as typeof first.stages };
    expect(await laneFiles(redeclared, shared)).toEqual(await laneFiles(redeclared, deps()));
  });
});

describe("caches", () => {
  test("a second identical list spawns only the revision commands", async () => {
    const fixture = keep(createTaskFixture());
    const spy = spyExec();
    const shared = deps(spy.exec);
    okLane(await laneFiles(fixture.lane(), shared));
    const cold = spy.calls.length;
    spy.calls.length = 0;
    const warm = okLane(await laneFiles(fixture.lane(), shared));
    expect(warm.files.length).toBeGreaterThan(5);
    expect(cold).toBeGreaterThan(spy.calls.length);
    expect(spy.calls.every((call) => call.includes("rev-parse") || call.includes("merge-base"))).toBe(true);
  });

  test("eight concurrent identical blob reads spawn one cat-file", async () => {
    const fixture = keep(createTaskFixture());
    const spy = spyExec();
    const shared = deps(spy.exec);
    const resolved = await resolveFile(fixture.lane(), fixture.headSha(), "docs/handoff/summary.md", shared);
    if ("status" in resolved) throw new Error(resolved.code);
    const real = fs.realpathSync(fixture.dir);
    const reads = await Promise.all(Array.from({ length: 8 }, () => readBlob(fixture.lane(), real, resolved, shared)));
    expect(spy.calls.filter((call) => call.includes("cat-file"))).toHaveLength(1);
    expect(reads.every((read) => Buffer.isBuffer(read) && read.toString("utf8").startsWith("# Handoff summary"))).toBe(true);
    await readBlob(fixture.lane(), real, resolved, shared);
    expect(spy.calls.filter((call) => call.includes("cat-file"))).toHaveLength(1);
  });

  test("the blob cache keeps at most 24 MiB and 48 entries, and never keeps one above 8 MiB", async () => {
    const fixture = keep(createTaskFixture());
    const shared = deps();
    const real = fs.realpathSync(fixture.dir);
    shared.caches.blobs.set("big", Buffer.alloc(8 * 1024 * 1024 + 1), 8 * 1024 * 1024 + 1);
    expect(shared.caches.blobs.size).toBe(0);
    for (let i = 0; i < 60; i += 1) shared.caches.blobs.set(`${real}\0${i}`, Buffer.alloc(1024), 1024);
    expect(shared.caches.blobs.size).toBe(48);
    for (let i = 0; i < 6; i += 1) shared.caches.blobs.set(`big-${i}`, Buffer.alloc(7 * 1024 * 1024), 7 * 1024 * 1024);
    expect(shared.caches.blobs.bytes).toBeLessThanOrEqual(24 * 1024 * 1024);
  });

  test("idle entries leave after their age under an injected clock", async () => {
    const fixture = keep(createTaskFixture());
    let t = 0;
    const shared = { exec: realExec, caches: createTaskFilesCaches({}, () => t) };
    okLane(await laneFiles(fixture.lane(), shared));
    expect(shared.caches.lists.size).toBe(1);
    t = 31 * 60_000;
    expect(shared.caches.lists.get(`${fs.realpathSync(fixture.dir)}\0x\0y`)).toBeUndefined();
    const spy = spyExec();
    okLane(await laneFiles(fixture.lane(), { exec: spy.exec, caches: shared.caches }));
    expect(spy.calls.some((call) => call.includes("ls-tree"))).toBe(true);
  });
});

describe("queues", () => {
  test("a read waiting behind two running ones starts only when a slot frees, and a full line answers busy", async () => {
    const fixture = keep(createTaskFixture());
    const shared = { exec: realExec, caches: createTaskFilesCaches({ readSlots: 1, readQueue: 1 }) };
    const resolved = await resolveFile(fixture.lane(), fixture.headSha(), "docs/handoff/summary.md", shared);
    const other = await resolveFile(fixture.lane(), fixture.headSha(), "docs/handoff/notes.md", shared);
    const third = await resolveFile(fixture.lane(), fixture.headSha(), "docs/readme.md", shared);
    if ("status" in resolved || "status" in other || "status" in third) throw new Error("fixture");
    const real = fs.realpathSync(fixture.dir);
    const release = await shared.caches.readGate.acquire();
    const queued = readBlob(fixture.lane(), real, other, shared);
    await until(() => shared.caches.readGate.waiting === 1, "the read waits in line");
    expect(shared.caches.readGate.waiting).toBe(1);
    const refused = await readBlob(fixture.lane(), real, third, shared);
    expect(refused).toMatchObject({ status: 503, code: "busy", retryAfter: 2 });
    release();
    expect(Buffer.isBuffer(await queued)).toBe(true);
  });

  test("an aborted queued read never spawns git", async () => {
    const fixture = keep(createTaskFixture());
    const spy = spyExec();
    const shared = { exec: spy.exec, caches: createTaskFilesCaches({ readSlots: 1, readQueue: 4 }) };
    const resolved = await resolveFile(fixture.lane(), fixture.headSha(), "docs/handoff/summary.md", shared);
    if ("status" in resolved) throw new Error("fixture");
    const hold = await shared.caches.readGate.acquire();
    const controller = new AbortController();
    const queued = readBlob(fixture.lane(), fs.realpathSync(fixture.dir), resolved, shared, controller.signal);
    await until(() => shared.caches.readGate.waiting === 1, "the read waits in line");
    controller.abort();
    expect(await queued).toMatchObject({ status: 499 });
    await until(() => shared.caches.readGate.waiting === 0, "the aborted read leaves the line");
    hold();
    expect(shared.caches.readGate.waiting).toBe(0);
    expect(spy.calls.filter((call) => call.includes("cat-file"))).toEqual([]);
  });

  test("a lane list refused by a full line answers busy instead of waiting", async () => {
    const fixture = keep(createTaskFixture());
    const shared = { exec: realExec, caches: createTaskFilesCaches({ listSlots: 1, listQueue: 0 }) };
    const hold = await shared.caches.listGate.acquire();
    expect(await laneFiles(fixture.lane(), shared)).toEqual({ lane: "lane-fixture", status: "unavailable", reason: "busy" });
    hold();
  });

  test("a request that ends while its Git work runs keeps the slot until that work has ended, and no second pair starts", async () => {
    const fixture = keep(createTaskFixture());
    const git = heldExec(fixture.headSha(), fixture.lane().baseRef);
    const shared = { exec: git.exec, caches: createTaskFilesCaches({ listSlots: 1, listQueue: 0 }) };
    for (let round = 0; round < 3; round += 1) {
      const controller = new AbortController();
      const request = laneFiles(fixture.lane(), shared, { signal: controller.signal });
      if (round === 0) await until(() => git.state.active === 2, "the first pair of diffs is running");
      controller.abort();
      expect(await request).toEqual({ lane: "lane-fixture", status: "unavailable", reason: "busy" });
      /* The abandoned work still owns the only slot, and nothing else started. */
      expect(shared.caches.listGate.running).toBe(1);
      expect(git.state.diffs).toBe(2);
    }
    expect(git.state.peak).toBe(2);
    git.release();
    await until(() => shared.caches.listGate.running === 0, "the slot frees after the work ends");
    expect(shared.caches.listFlights.size).toBe(0);
    /* Once it ended, the next request gets the slot and its own answer. */
    expect(okLane(await laneFiles(fixture.lane(), shared))).toMatchObject({ lane: "lane-fixture", total: 0 });
  });

  test("a request that ends signals its Git children, so the slot frees without waiting for the work", async () => {
    const fixture = keep(createTaskFixture());
    const stopped: boolean[] = [];
    let started = 0;
    const running = Promise.withResolvers<void>();
    const exec: ExecPort = async (_command, args, cwd, env, options) => {
      if (!args.includes("diff")) return realExec(_command, args, cwd, env, options);
      started += 1;
      if (started === 2) running.resolve();
      return new Promise<ExecResult>((resolve) => {
        const done = () => { stopped.push(true); resolve({ code: null, stdout: "", stderr: "command cancelled" }); };
        if (options?.signal?.aborted) done();
        else options?.signal?.addEventListener("abort", done, { once: true });
      });
    };
    const shared = { exec, caches: createTaskFilesCaches({ listSlots: 1, listQueue: 0 }) };
    const controller = new AbortController();
    const request = laneFiles(fixture.lane(), shared, { signal: controller.signal });
    await running.promise;
    controller.abort();
    expect(await request).toMatchObject({ status: "unavailable", reason: "busy" });
    await until(() => shared.caches.listGate.running === 0, "the slot frees after the children closed");
    expect(stopped).toHaveLength(2);
  });

  test("a request cancelled while it waits for a slot starts no Git, and another waiter still completes", async () => {
    const fixture = keep(createTaskFixture());
    const alone = spyExec();
    okLane(await laneFiles(fixture.lane(), { exec: alone.exec, caches: createTaskFilesCaches() }));
    const spy = spyExec();
    const shared = { exec: spy.exec, caches: createTaskFilesCaches({ listSlots: 1, listQueue: 4 }) };
    const hold = await shared.caches.listGate.acquire();
    const cancelled = new AbortController();
    const first = laneFiles({ ...fixture.lane(), id: "lane-first" }, shared, { signal: cancelled.signal });
    const second = laneFiles({ ...fixture.lane(), id: "lane-second" }, shared);
    await until(() => shared.caches.listGate.waiting === 2, "both wait for the slot");
    cancelled.abort();
    expect(await first).toMatchObject({ status: "unavailable", reason: "busy" });
    await until(() => shared.caches.listGate.waiting === 1, "the cancelled request leaves the line");
    expect(spy.calls).toEqual([]);
    hold();
    expect(okLane(await second)).toMatchObject({ lane: "lane-second" });
    expect(spy.calls.length).toBe(alone.calls.length);
  });

  test("two callers of one lane share one run, and the run goes on while either still waits", async () => {
    const fixture = keep(createTaskFixture());
    const git = heldExec(fixture.headSha(), fixture.lane().baseRef);
    const shared = { exec: git.exec, caches: createTaskFilesCaches() };
    const leaving = new AbortController();
    const one = laneFiles(fixture.lane(), shared, { signal: leaving.signal });
    const two = laneFiles(fixture.lane(), shared);
    await until(() => git.state.active === 2, "one pair of diffs is running");
    leaving.abort();
    expect(await one).toMatchObject({ reason: "busy" });
    git.release();
    expect(okLane(await two)).toMatchObject({ total: 0 });
    expect(git.state.diffs).toBe(2);
  });

  test("a git call that never ends answers busy at the request deadline, and its slot is held honestly until that call ends", async () => {
    const fixture = keep(createTaskFixture());
    const git = heldExec(fixture.headSha(), fixture.lane().baseRef);
    const shared = { exec: git.exec, caches: createTaskFilesCaches({ listSlots: 1, listQueue: 0 }) };
    jest.useFakeTimers();
    try {
      const request = laneFiles(fixture.lane(), shared);
      await until(() => git.state.active === 2, "the diffs are running");
      jest.advanceTimersByTime(8_000);
      expect(await request).toEqual({ lane: "lane-fixture", status: "unavailable", reason: "busy" });
    } finally {
      jest.useRealTimers();
    }
    expect(shared.caches.listGate.running).toBe(1);
    git.release();
    await until(() => shared.caches.listGate.running === 0, "the slot frees when the call ends");
  });

  test("a resolution nobody waits for keeps its slot until its Git work ends", async () => {
    const fixture = keep(createTaskFixture());
    const head = fixture.headSha();
    const git = heldExec(head, fixture.lane().baseRef);
    const shared = { exec: git.exec, caches: createTaskFilesCaches({ listSlots: 1, listQueue: 0 }) };
    const controller = new AbortController();
    const resolving = resolveFile(fixture.lane(), head, "docs/handoff/summary.md", shared, controller.signal);
    await until(() => git.state.active === 2, "the pair is being listed");
    controller.abort();
    await expect(resolving).rejects.toBeInstanceOf(Aborted);
    expect(shared.caches.listGate.running).toBe(1);
    const second = await resolveFile(fixture.lane(), head, "docs/handoff/summary.md", shared);
    expect(second).toMatchObject({ status: 503, code: "busy" });
    expect(git.state.diffs).toBe(2);
    git.release();
    await until(() => shared.caches.listGate.running === 0, "the slot frees after the work ends");
  });
});

describe("resolveFile", () => {
  test("refuses what the pair does not list, a symlink, a submodule, a deletion and an unsupported type", async () => {
    const fixture = keep(createTaskFixture());
    const shared = deps();
    const head = fixture.headSha();
    const code = async (file: string) => {
      const result = await resolveFile(fixture.lane(), head, file, shared);
      return "status" in result ? [result.status, result.code] : "ok";
    };
    expect(await code("src/untouched.ts")).toEqual([404, "not-listed"]);
    expect(await code("assets/logo.bin")).toEqual([415, "unsupported"]);
    expect(await code("link.md")).toEqual([403, "symlink"]);
    expect(await code("vendor/module.md")).toEqual([415, "unsupported"]);
    expect(await code("src/gone.ts")).toEqual([404, "not-found"]);
    expect(await code(".env.local")).toEqual([415, "unsupported"]);
    expect(await code("docs/handoff/summary.md")).toBe("ok");
  });

  test("an earlier head stays readable while it is an ancestor, and an unrelated commit is refused", async () => {
    const fixture = keep(createTaskFixture());
    const shared = deps();
    const first = fixture.headSha();
    fixture.git("checkout", "-q", LANE_BRANCH);
    fixture.write("docs/later.md", "# later\n");
    fixture.commit("later");
    fixture.git("checkout", "-q", "--detach");
    const earlier = await resolveFile(fixture.lane(), first, "docs/handoff/summary.md", shared);
    expect("status" in earlier).toBe(false);
    const unrelated = fixture.git("commit-tree", "-m", "x", `${fixture.headSha()}^{tree}`);
    expect(await resolveFile(fixture.lane(), unrelated, "docs/handoff/summary.md", shared)).toMatchObject({ status: 409, code: "head_unknown" });
    expect(await resolveFile(fixture.lane(), "0".repeat(40), "docs/handoff/summary.md", shared)).toMatchObject({ status: 409, code: "head_unknown" });
  });

  test("a warm answer is reused for 60 seconds and then asked again", async () => {
    const fixture = keep(createTaskFixture());
    let t = 0;
    const spy = spyExec();
    const shared = { exec: spy.exec, caches: createTaskFilesCaches({}, () => t) };
    const head = fixture.headSha();
    await resolveFile(fixture.lane(), head, "docs/handoff/summary.md", shared);
    spy.calls.length = 0;
    await resolveFile(fixture.lane(), head, "docs/handoff/summary.md", shared);
    expect(spy.calls).toEqual([]);
    t = 61_000;
    await resolveFile(fixture.lane(), head, "docs/handoff/summary.md", shared);
    expect(spy.calls.length).toBeGreaterThan(0);
  });

  test("literal pathspecs: a glob names no file", async () => {
    const fixture = keep(createTaskFixture());
    expect(await resolveFile(fixture.lane(), fixture.headSha(), "docs/handoff/*.md", deps())).toMatchObject({ status: 404, code: "not-listed" });
  });
});

describe("documentBaseDir", () => {
  test("is the file's directory in the worktree while it exists, else in the checkout", async () => {
    const fixture = keep(createTaskFixture());
    const lane = fixture.lane();
    expect(await documentBaseDir(lane, "docs/handoff/summary.md")).toBe(`${fixture.dir}/docs/handoff`);
    const worktree = `${fixture.dir}-worktree`;
    fs.mkdirSync(worktree);
    try {
      expect(await documentBaseDir({ ...lane, worktreeDir: worktree }, "docs/readme.md")).toBe(`${worktree}/docs`);
      expect(await documentBaseDir({ ...lane, worktreeDir: worktree }, "top.md")).toBe(worktree);
    } finally {
      fs.rmSync(worktree, { recursive: true, force: true });
    }
  });
});
