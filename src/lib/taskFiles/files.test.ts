import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";

import { LANE_BRANCH } from "@/lib/laneReview/gitFixture";
import { realExec } from "@/lib/workflows/provision";
import { createTaskFilesCaches } from "./cache";
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
    await new Promise((resolve) => setTimeout(resolve, 5));
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
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    expect(await queued).toMatchObject({ status: 499 });
    await new Promise((resolve) => setTimeout(resolve, 5));
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

  test("a git call that never ends answers busy at the request deadline and leaves no slot taken", async () => {
    const fixture = keep(createTaskFixture());
    const never = () => new Promise<never>(() => {});
    const shared = { exec: never as unknown as typeof realExec, caches: createTaskFilesCaches() };
    const answer = await Promise.race([laneFiles(fixture.lane(), shared, { deadlineMs: 30 }), new Promise((resolve) => setTimeout(() => resolve("hung"), 1500))]);
    expect(answer).toEqual({ lane: "lane-fixture", status: "unavailable", reason: "busy" });
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
