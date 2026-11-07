import { afterEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";

import { NextRequest } from "next/server";

import { artifactResponseHeaders } from "@/lib/artifact/serve";
import type { Pipeline } from "@/lib/pipelines/types";
import { realExec } from "@/lib/workflows/provision";
import { createTaskFilesCaches } from "./cache";
import { createTaskFixture, OTHER_TASK, PDF_HEAD, PNG, spyExec, SUMMARY_MD, TASK, type TaskFixture } from "./fixture";
import { taskFileContentGET, taskFilesGET, type TaskFilesDependencies, type TaskFilesScope } from "./http";

const fixtures: TaskFixture[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.cleanup(); });

type World = {
  fixture: TaskFixture;
  lanes: Map<string, Pipeline>;
  scope: TaskFilesScope;
  deps: TaskFilesDependencies;
  calls: string[][];
  head: string;
};

function world(options: { big?: boolean; scope?: TaskFilesScope; caps?: Parameters<typeof createTaskFilesCaches>[0] } = {}): World {
  const fixture = createTaskFixture({ big: options.big });
  fixtures.push(fixture);
  const lanes = new Map<string, Pipeline>([["lane-fixture", fixture.lane()], ["lane-other", fixture.otherLane()]]);
  const spy = spyExec(realExec);
  const state = { scope: options.scope ?? null } as { scope: TaskFilesScope };
  const deps: TaskFilesDependencies = {
    task: (id) => (id === TASK || id === OTHER_TASK ? { id } : null),
    pipeline: (id) => lanes.get(id) ?? null,
    scope: () => state.scope,
    exec: spy.exec,
    caches: createTaskFilesCaches(options.caps),
  };
  const result = { fixture, lanes, deps, calls: spy.calls, head: fixture.headSha() } as World;
  Object.defineProperty(result, "scope", { get: () => state.scope, set: (value: TaskFilesScope) => { state.scope = value; } });
  return result;
}

const url = (path: string) => `http://localhost:3000${path}`;
const req = (path: string, init: { headers?: Record<string, string>; signal?: AbortSignal } = {}) => new NextRequest(url(path), { headers: { host: "localhost:3000", ...init.headers }, signal: init.signal });
const content = (w: World, file: string, extra = "", lane = "lane-fixture", head = w.head) =>
  `/api/tasks/${TASK}/files/content?lane=${lane}&head=${head}&file=${encodeURIComponent(file)}${extra}`;
const getContent = (w: World, file: string, extra = "", init: Parameters<typeof req>[1] = {}, lane = "lane-fixture", head = w.head, task = TASK) =>
  taskFileContentGET(req(content(w, file, extra, lane, head), init), task, w.deps);
const blobReads = (w: World) => w.calls.filter((call) => call.includes("cat-file")).length;

describe("the file list", () => {
  test("answers the task's lane with metadata only and reads no blob", async () => {
    const w = world();
    const response = await taskFilesGET(req(`/api/tasks/${TASK}/files?lanes=lane-fixture`), TASK, w.deps);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json();
    expect(body.omitted).toBe(0);
    expect(body.lanes).toHaveLength(1);
    expect(body.lanes[0]).toMatchObject({ lane: "lane-fixture", status: "ok", head: w.head, headSource: "branch" });
    expect(body.lanes[0].files[0]).toMatchObject({ path: "docs/handoff/notes.md", declaredBy: "design" });
    expect(blobReads(w)).toBe(0);
  });

  test("a lane bound to another task, an unknown lane and an unreadable project are only counted as omitted", async () => {
    const w = world();
    w.scope = { canReadFile: (project) => project !== "repo-secret" };
    w.lanes.set("lane-secret", { ...w.fixture.lane(), id: "lane-secret", project: "repo-secret" });
    const response = await taskFilesGET(req(`/api/tasks/${TASK}/files?lanes=lane-fixture,lane-other,lane-secret,lane-nope`), TASK, w.deps);
    const body = await response.json();
    expect(body.lanes.map((lane: { lane: string }) => lane.lane)).toEqual(["lane-fixture"]);
    expect(body.omitted).toBe(3);
  });

  test("rejects a missing, oversized or malformed lanes parameter and an unknown task", async () => {
    const w = world();
    const status = async (query: string, task = TASK) => (await taskFilesGET(req(`/api/tasks/${task}/files${query}`), task, w.deps)).status;
    expect(await status("")).toBe(400);
    expect(await status("?lanes=a,b,c,d,e,f")).toBe(400);
    expect(await status("?lanes=../x")).toBe(400);
    expect(await status("?lanes=lane-fixture", "task-missing")).toBe(404);
    expect(w.calls).toEqual([]);
  });

  test("a foreign origin is refused and spawns no git", async () => {
    const w = world();
    const response = await taskFilesGET(req(`/api/tasks/${TASK}/files?lanes=lane-fixture`, { headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } }), TASK, w.deps);
    expect(response.status).toBe(403);
    expect(w.calls).toEqual([]);
  });

  test("a reader revoked while git ran gets the workspace refusal, not the list", async () => {
    const w = world();
    let reads = 0;
    w.scope = { canReadFile: () => (reads += 1) <= 1 };
    const response = await taskFilesGET(req(`/api/tasks/${TASK}/files?lanes=lane-fixture`), TASK, w.deps);
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("workspace_forbidden");
  });
});

describe("the content route: threat cases", () => {
  test("a foreign origin is refused before any git or blob read", async () => {
    const w = world();
    const response = await getContent(w, "docs/handoff/summary.md", "", { headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } });
    expect(response.status).toBe(403);
    expect(w.calls).toEqual([]);
  });

  test("malformed parameters are 400 and read nothing", async () => {
    const w = world();
    for (const file of ["../x.md", "/etc/x.md", "docs/../x.md", "./x.md", "a\0b.md", ""]) {
      const response = await taskFileContentGET(req(`/api/tasks/${TASK}/files/content?lane=lane-fixture&head=${w.head}&file=${encodeURIComponent(file)}`), TASK, w.deps);
      expect([response.status, file]).toEqual([400, file]);
    }
    expect((await getContent(w, "docs/readme.md", "", {}, "../lane")).status).toBe(400);
    expect((await getContent(w, "docs/readme.md", "", {}, "lane-fixture", "abc")).status).toBe(400);
    expect((await getContent(w, "docs/readme.md", "", {}, "lane-fixture", w.head.toUpperCase())).status).toBe(400);
    expect(w.calls).toEqual([]);
  });

  test("a lane bound to another task is 404 even when the owner already cached its blob", async () => {
    const w = world();
    expect((await getContent(w, "docs/handoff/summary.md")).status).toBe(200);
    const reads = blobReads(w);
    const refused = await getContent(w, "docs/handoff/summary.md", "", {}, "lane-other");
    expect(refused.status).toBe(404);
    expect((await refused.json()).code).toBe("lane_not_found");
    const unknownTask = await getContent(w, "docs/handoff/summary.md", "", {}, "lane-fixture", w.head, "task-missing");
    expect(unknownTask.status).toBe(404);
    expect(blobReads(w)).toBe(reads);
  });

  test("a member without read access to the lane's project is 403 and gets no bytes, warm or cold", async () => {
    const w = world();
    expect((await getContent(w, "docs/handoff/summary.md")).status).toBe(200);
    w.scope = { canReadFile: () => false };
    const refused = await getContent(w, "docs/handoff/summary.md");
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe("workspace_forbidden");
    w.scope = { canReadFile: (project) => project === "repo-fixture" };
    expect((await getContent(w, "docs/handoff/summary.md")).status).toBe(200);
  });

  test("a project key that moved: the new key reads, an unrelated key is refused", async () => {
    const w = world();
    w.lanes.set("lane-fixture", { ...w.fixture.lane(), project: "repo-moved" });
    const aliases = new Map([["repo-moved", "repo-new"]]);
    const asKey = (key: string): TaskFilesScope => ({ canReadFile: (project) => (aliases.get(project ?? "") ?? project) === key });
    w.scope = asKey("repo-new");
    expect((await getContent(w, "docs/handoff/summary.md")).status).toBe(200);
    w.scope = asKey("repo-unrelated");
    expect((await getContent(w, "docs/handoff/summary.md")).status).toBe(403);
  });

  test("a file the pair does not change, or a head that is not the lane's, is 404 or 409", async () => {
    const w = world();
    w.fixture.git("checkout", "-q", "main");
    w.fixture.write("docs/untouched.md", "# not in the lane\n");
    w.fixture.commit("main only");
    const foreign = w.fixture.git("rev-parse", "HEAD");
    w.fixture.git("checkout", "-q", "--detach");
    expect((await getContent(w, "docs/untouched.md")).status).toBe(404);
    expect((await getContent(w, "src/app.ts", "", {}, "lane-fixture", foreign)).status).toBe(409);
    expect((await getContent(w, "docs/handoff/summary.md", "", {}, "lane-fixture", "1".repeat(40))).status).toBe(409);
  });

  test("a glob, a symlink, a submodule, a deleted file and a lookalike dotfile each refuse", async () => {
    const w = world();
    const code = async (file: string) => { const r = await getContent(w, file); return [r.status, (await r.json()).code]; };
    expect(await code("docs/handoff/*.md")).toEqual([404, "not-listed"]);
    expect(await code("link.md")).toEqual([403, "symlink"]);
    expect(await code("vendor/module.md")).toEqual([415, "unsupported"]);
    expect(await code("src/gone.ts")).toEqual([404, "not-found"]);
    expect(await code(".env.local")).toEqual([415, "unsupported"]);
    expect(await code("docs/binary.md")).toEqual([415, "mime-mismatch"]);
  });

  test("an unreachable repository is 404 and a lane with its commits gone is 409", async () => {
    const w = world();
    w.lanes.set("lane-fixture", { ...w.fixture.lane(), repoDir: `${w.fixture.dir}-absent` });
    expect((await getContent(w, "docs/readme.md")).status).toBe(404);
    w.lanes.set("lane-fixture", { ...w.fixture.lane(), branch: "gone/branch", lastPassedCommit: "" });
    expect((await getContent(w, "docs/readme.md")).status).toBe(409);
  });

  test("a busy line answers 503 with a retry hint", async () => {
    const w = world({ caps: { readSlots: 1, readQueue: 0 } });
    const hold = await w.deps.caches.readGate.acquire();
    const response = await getContent(w, "docs/handoff/summary.md");
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("2");
    hold();
  });
});

describe("meta, content and headers", () => {
  const metaOf = async (w: World, file: string) => (await getContent(w, file, "&mode=meta")).json();

  test("meta carries identity and revision; content equals the committed blob; headers equal /api/artifact's", async () => {
    const w = world();
    const meta = await metaOf(w, "docs/handoff/summary.md");
    const blob = crypto.createHash("sha1").update(`blob ${Buffer.byteLength(SUMMARY_MD)}\0${SUMMARY_MD}`).digest("hex");
    expect(meta).toMatchObject({ name: "summary.md", kind: "text", mime: "text/plain; charset=utf-8", size: Buffer.byteLength(SUMMARY_MD), etag: `"g${blob}"`, revision: { head: w.head, headSource: "branch" } });
    expect(meta.baseDir.endsWith("/docs/handoff")).toBe(true);
    expect(meta.frame).toBeUndefined();
    const response = await getContent(w, "docs/handoff/summary.md", "", { headers: { "if-match": meta.etag } });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(SUMMARY_MD);
    const expected = artifactResponseHeaders("text/plain; charset=utf-8", meta.etag, "summary.md", false);
    for (const [name, value] of expected) expect([name, response.headers.get(name)]).toEqual([name, value]);
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const download = await getContent(w, "docs/handoff/summary.md", "&download=1");
    expect(download.headers.get("content-disposition")).toBe('attachment; filename="summary.md"');
  });

  test("If-Match mismatch is 412, a range is 206, a bad range 416", async () => {
    const w = world();
    expect((await getContent(w, "docs/handoff/summary.md", "", { headers: { "if-match": '"gdeadbeef"' } })).status).toBe(412);
    const ranged = await getContent(w, "docs/handoff/summary.md", "", { headers: { range: "bytes=2-9" } });
    expect(ranged.status).toBe(206);
    expect(await ranged.text()).toBe(SUMMARY_MD.slice(2, 10));
    expect(ranged.headers.get("content-range")).toBe(`bytes 2-9/${Buffer.byteLength(SUMMARY_MD)}`);
    expect((await getContent(w, "docs/handoff/summary.md", "", { headers: { range: "bytes=9999-" } })).status).toBe(416);
  });

  test("PNG and PDF come back byte for byte; text is never served as html", async () => {
    const w = world({ big: true });
    const png = await getContent(w, "img/shot.png");
    expect(png.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await png.arrayBuffer()).equals(PNG)).toBe(true);
    const pdf = await getContent(w, "docs/report.pdf", "", { headers: { range: "bytes=0-8" } });
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(await pdf.text()).toBe(PDF_HEAD);
    expect(pdf.headers.get("content-security-policy")).toBe("default-src 'none'; object-src 'none'");
    const md = await getContent(w, "docs/big.md");
    expect(md.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  });

  test("an oversized file answers meta 200 and content 413, and reads no blob", async () => {
    const w = world({ big: true });
    const meta = await metaOf(w, "data/huge.txt");
    expect(meta.size).toBe(9 * 1024 * 1024);
    expect((await getContent(w, "data/huge.txt")).status).toBe(413);
    expect(blobReads(w)).toBe(0);
  });

  test("an earlier head keeps serving after the branch moves on", async () => {
    const w = world();
    const earlier = w.head;
    w.fixture.git("checkout", "-q", "pipeline/lane-fixture");
    w.fixture.write("docs/later.md", "# later\n");
    w.fixture.commit("later");
    w.fixture.git("checkout", "-q", "--detach");
    const response = await getContent(w, "docs/handoff/summary.md", "&mode=meta", {}, "lane-fixture", earlier);
    expect(response.status).toBe(200);
    expect((await response.json()).revision.head).toBe(earlier);
  });
});

describe("cache isolation and cost", () => {
  test("a warm open spawns no git, and the owner's cached bytes never reach a refused caller", async () => {
    const w = world();
    expect((await getContent(w, "docs/handoff/summary.md")).status).toBe(200);
    w.calls.length = 0;
    expect((await getContent(w, "docs/handoff/summary.md")).status).toBe(200);
    expect(w.calls).toEqual([]);
    w.scope = { canReadFile: () => false };
    expect((await getContent(w, "docs/handoff/summary.md")).status).toBe(403);
    expect(w.calls).toEqual([]);
  });

  test("eight concurrent identical opens run one cat-file", async () => {
    const w = world();
    const responses = await Promise.all(Array.from({ length: 8 }, () => getContent(w, "docs/handoff/summary.md")));
    expect(responses.map((response) => response.status)).toEqual(Array(8).fill(200));
    expect(blobReads(w)).toBe(1);
    /* One resolution too: the pair's list and the one file's object, not one round per request. */
    expect(w.calls.filter((call) => call.includes("ls-tree"))).toHaveLength(2);
  });

  test("eight concurrent requests for a file the lane never changed share one round of git calls", async () => {
    const w = world();
    const responses = await Promise.all(Array.from({ length: 8 }, () => getContent(w, "src/untouched.ts")));
    expect(responses.map((response) => response.status)).toEqual(Array(8).fill(404));
    expect(w.calls.filter((call) => call.includes("merge-base"))).toHaveLength(1);
  });

  test("an aborted request answers 499 and the shared read still finishes for the others", async () => {
    const w = world();
    const controller = new AbortController();
    const aborted = getContent(w, "docs/handoff/summary.md", "", { signal: controller.signal });
    const other = getContent(w, "docs/handoff/summary.md");
    controller.abort();
    expect([200, 499]).toContain((await aborted).status);
    expect((await other).status).toBe(200);
  });
});

/* §11.4: cold and warm readings of the built routes over the owned fixture.
   Gated, because it writes a readings file for the report and takes a few
   seconds: LLV_TASK_FILES_MEASURE=1 with LLV_EVIDENCE_DIR set. */
const measured = process.env.LLV_TASK_FILES_MEASURE === "1" && process.env.LLV_EVIDENCE_DIR ? describe : describe.skip;
measured("cold and warm measurements", () => {
  test("five alternating rounds over the same data", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const w = world({ big: true });
    /* A 40 KiB Markdown file, two more lanes at distinct heads, and blobs that overfill the cache. */
    const fx = w.fixture;
    fx.git("checkout", "-q", "pipeline/lane-fixture");
    fx.write("docs/medium.md", "# Medium\n\n" + "A paragraph of synthetic prose for the measurement.\n\n".repeat(780));
    for (let i = 0; i < 5; i += 1) fx.write(`blobs/b${i}.txt`, Buffer.from(`${i}`.repeat(6 * 1024 * 1024)));
    fx.commit("measurement files");
    const head = fx.headSha();
    /* Every open below names this head, which lists the files just added. */
    w.head = head;
    for (const [branch, file] of [["pipeline/m2", "m2.md"], ["pipeline/m3", "m3.md"]] as const) {
      fx.git("checkout", "-q", "-b", branch);
      fx.write(`docs/${file}`, `# ${file}\n`);
      fx.commit(file);
      fx.git("checkout", "-q", "pipeline/lane-fixture");
    }
    fx.git("checkout", "-q", "--detach");
    const lane = fx.lane();
    w.lanes.set("lane-fixture", lane);
    w.lanes.set("lane-m2", { ...lane, id: "lane-m2", branch: "pipeline/m2" });
    w.lanes.set("lane-m3", { ...lane, id: "lane-m3", branch: "pipeline/m3" });

    const sample = async (name: string, mode: "cold" | "warm", work: () => Promise<unknown>) => {
      const spawns = w.calls.length;
      const cpu = process.cpuUsage();
      const started = performance.now();
      await work();
      const latencyMs = performance.now() - started;
      const used = process.cpuUsage(cpu);
      return { name, mode, latencyMs: Math.round(latencyMs * 10) / 10, gitSpawns: w.calls.length - spawns, cpuMs: Math.round((used.user + used.system) / 100) / 10 };
    };
    const open = (file: string, extra = "") => async () => {
      const meta = await getContent(w, file, "&mode=meta");
      const info = await meta.json();
      const response = await getContent(w, file, extra, { headers: { "if-match": info.etag } });
      await response.arrayBuffer();
    };
    const cases: Array<[string, () => Promise<unknown>]> = [
      ["list of 3 lanes", () => taskFilesGET(req(`/api/tasks/${TASK}/files?lanes=lane-fixture,lane-m2,lane-m3`), TASK, w.deps).then((r) => r.json())],
      ["markdown 40 KiB", open("docs/medium.md")],
      ["markdown 1.5 MiB", open("docs/big.md")],
      ["pdf 4 MiB, meta and whole body", open("docs/report.pdf", "")],
      ["8 concurrent identical opens", () => Promise.all(Array.from({ length: 8 }, () => open("docs/medium.md")()))],
      ["8 concurrent distinct opens", () => Promise.all(["docs/medium.md", "docs/big.md", "docs/readme.md", "docs/handoff/summary.md", "docs/handoff/notes.md", "data/table.csv", "img/shot.png", "docs/report.pdf"].map((file) => open(file)()))],
    ];
    const rounds: unknown[] = [];
    const caches = w.deps.caches;
    const createdAt = Date.now();
    for (let round = 0; round < 5; round += 1) {
      const rows = [];
      for (const [name, work] of cases) {
        caches.reset();
        rows.push(await sample(name, "cold", work));
        const ageMs = Date.now() - createdAt;
        rows.push({ ...(await sample(name, "warm", work)), cacheAgeMsAtRead: ageMs });
      }
      rounds.push(rows);
    }
    /* Memory: before, with the blob cache full, and after it is emptied. */
    const mem = () => { const m = process.memoryUsage(); return { rssMiB: Math.round(m.rss / 1048576), heapMiB: Math.round(m.heapUsed / 1048576), externalMiB: Math.round(m.external / 1048576), arrayBuffersMiB: Math.round(m.arrayBuffers / 1048576) }; };
    caches.reset();
    Bun.gc(true);
    const before = mem();
    for (let i = 0; i < 5; i += 1) await open(`blobs/b${i}.txt`)();
    await open("docs/report.pdf")();
    const full = { ...mem(), blobCacheBytes: caches.blobs.bytes, blobCacheEntries: caches.blobs.size };
    caches.reset();
    Bun.gc(true);
    const after = mem();
    expect(full.blobCacheBytes).toBeLessThanOrEqual(24 * 1024 * 1024);
    const dir = path.join(process.env.LLV_EVIDENCE_DIR!, "task-files-measure");
    fs.mkdirSync(dir, { recursive: true });
    const readings = {
      commit: process.env.LLV_MEASURE_COMMIT ?? null, head, at: new Date().toISOString(), cores: os.cpus().length, loadavg: os.loadavg().map((v) => Math.round(v * 100) / 100),
      runtime: `bun ${Bun.version}`, cacheGenerationStartedAt: new Date(createdAt).toISOString(), caps: caches.caps, rounds, memory: { before, full, after },
    };
    fs.writeFileSync(path.join(dir, `readings-${Date.now()}.json`), `${JSON.stringify(readings, null, 2)}\n`);
  }, 300_000);
});
