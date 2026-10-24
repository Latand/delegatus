import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordWorktreeSweep, type SweptPipeline, type WorktreeSweepReport } from "./worktreeSweep";
import { readWorktreePage, relativeCheckout, WorktreePageError } from "./worktreeDrilldown";

const at = "2026-10-23T10:00:00.000Z";
const observedAt = "2026-10-22T09:00:00.000Z";
const originalState = process.env.LLV_STATE_DIR;
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-drilldown-"));
  process.env.LLV_STATE_DIR = root;
});
afterEach(() => {
  if (originalState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = originalState;
  fs.rmSync(root, { recursive: true, force: true });
});

export function report(count = 10): WorktreeSweepReport {
  return { at, mode: "on", repositories: [path.join(root, "repository")],
    kept: Array.from({ length: count }, (_, index) => ({ path: path.join(root, "repository", "worktrees", `checkout-${index}`),
      repository: path.join(root, "repository"), pipelineId: `lane-${index}`, reason: "local-only-commits", bytes: index * 1024,
      observedAt: index ? observedAt : at })),
    keptCounts: { "local-only-commits": count }, keptBytes: {}, removed: [], removedBytes: 0, trimmed: [], trimmedBytes: 0, errors: [] };
}
const owners = (): SweptPipeline[] => [{ id: "lane-0", task: "Preserve the export", repoDir: path.join(root, "repository"),
  worktreeDir: path.join(root, "repository", "worktrees", "checkout-0"), branch: "lane-0", state: "completed" }];
function rejects(cursor: string | null, status: number, code: string) {
  let caught;
  try { readWorktreePage(cursor); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(WorktreePageError);
  expect(caught).toMatchObject({ status, code });
}

test("the projection and sweep load under Node without SQLite or state writes", async () => {
  const build = await Bun.build({
    entrypoints: [path.join(import.meta.dir, "worktreeDrilldown.ts"), path.join(import.meta.dir, "worktreeSweep.ts")],
    outdir: path.join(root, "bundle"), target: "node", format: "cjs", external: ["next/*", "bun:*"],
  });
  expect(build.success).toBe(true);
  const node = process.env.LLV_TEST_NODE_BIN || Bun.which("node");
  if (!node) throw new Error("projection import check requires Node on PATH");
  const state = path.join(root, "state");
  const probe = Bun.spawn([node, "-e", `
    for (const file of process.argv.slice(1)) {
      const module = require(file);
      if (typeof module.readWorktreePage === "function") {
        try { module.readWorktreePage(null); throw new Error("SQLite unexpectedly available"); }
        catch (error) {
          if (!(error instanceof module.WorktreePageError) || error.status !== 503 || error.code !== "unavailable") throw error;
        }
      }
    }
  `, ...build.outputs.map(output => output.path)], {
    env: { ...process.env, NODE_PATH: path.resolve("node_modules"), NODE_ENV: "production",
      HOME: root, XDG_CONFIG_HOME: path.join(root, "config"), LLV_STATE_DIR: state, TMPDIR: root },
    stdout: "pipe", stderr: "pipe",
  });
  const [exit, error] = await Promise.all([probe.exited, new Response(probe.stderr).text()]);
  expect({ exit, error }).toEqual({ exit: 0, error: "" });
  expect(fs.existsSync(state)).toBe(false);
});

test("the sweep producer persists all rows, task and original observation time; primary-key pages survive restart without the full report", () => {
  recordWorktreeSweep(report(), owners());
  fs.unlinkSync(path.join(root, "worktree-sweep-report.json"));
  const first = readWorktreePage(null);
  expect(first).toMatchObject({ at, total: 10, start: 0 });
  expect(first.rows).toHaveLength(4);
  expect(first.rows[0]).toEqual({ task: "Preserve the export", pipelineId: "lane-0", repository: "repository", checkout: "worktrees/checkout-0", reason: "local-only-commits", bytes: 0, observedAt: at });
  expect(first.rows[1]!.observedAt).toBe(observedAt);
  const child = spawnSync(process.execPath, ["--eval", `import { readWorktreePage } from ${JSON.stringify(path.join(import.meta.dir, "worktreeDrilldown.ts"))}; console.log(JSON.stringify(readWorktreePage(process.argv[1])));`, first.nextCursor!], { env: process.env, encoding: "utf8", timeout: 30_000 });
  expect(child.status).toBe(0);
  const second = JSON.parse(child.stdout);
  expect(second.start).toBe(4);
  expect(second.rows[0].checkout).toBe("worktrees/checkout-4");
  const last = readWorktreePage(second.nextCursor);
  expect(last.rows.map(row => row.checkout)).toEqual(["worktrees/checkout-8", "worktrees/checkout-9"]);
  expect(last.nextCursor).toBeNull();
  expect(readWorktreePage(last.previousCursor).start).toBe(4);
  const db = new Database(path.join(root, "worktree-drilldown.sqlite"), { readonly: true });
  try {
    const plan = db.query("EXPLAIN QUERY PLAN SELECT body FROM retained WHERE id > ? ORDER BY id LIMIT ?").all(4, 4);
    expect(JSON.stringify(plan)).toContain("SEARCH retained USING INTEGER PRIMARY KEY");
  } finally { db.close(); }
});

test("new snapshots invalidate cursors even at the same report time; malformed and out-of-range cursors are refused", () => {
  recordWorktreeSweep(report());
  const cursor = readWorktreePage(null).nextCursor!;
  for (const invalid of ["", "../report", "x".repeat(1000), cursor.replace(/:4$/, ":6"), cursor.replace(/:4$/, ":9999999999")]) rejects(invalid, 400, "invalid_cursor");
  recordWorktreeSweep(report(1));
  rejects(cursor, 409, "snapshot_changed");
  expect(readWorktreePage(null).rows).toHaveLength(1);
});

test("an empty report is distinct from absent data; the sweep replaces a snapshot held by a reader", () => {
  rejects(null, 503, "unavailable");
  recordWorktreeSweep(report(0));
  expect(readWorktreePage(null)).toMatchObject({ total: 0, rows: [], nextCursor: null });
  const filename = path.join(root, "worktree-drilldown.sqlite");
  const db = new Database(filename, { readonly: true });
  try {
    db.exec("BEGIN");
    expect(db.query("SELECT total FROM snapshot").get()).toEqual({ total: 0 });
    expect(() => recordWorktreeSweep(report(2))).not.toThrow();
    expect(readWorktreePage(null).total).toBe(2);
    expect(db.query("SELECT total FROM snapshot").get()).toEqual({ total: 0 });
    db.exec("ROLLBACK");
  } finally { db.close(); }
});

test("a locked projection answers unavailable until the sweep replaces it", () => {
  recordWorktreeSweep(report(1));
  const db = new Database(path.join(root, "worktree-drilldown.sqlite"));
  try {
    db.exec("BEGIN EXCLUSIVE");
    rejects(null, 503, "unavailable");
    recordWorktreeSweep(report(2));
    expect(readWorktreePage(null).total).toBe(2);
  } finally { db.close(); }
});

test("the next sweep repairs a damaged projection", () => {
  const filename = path.join(root, "worktree-drilldown.sqlite");
  fs.writeFileSync(filename, "unreadable snapshot");
  rejects(null, 503, "unavailable");
  expect(() => recordWorktreeSweep(report(2))).not.toThrow();
  expect(readWorktreePage(null).total).toBe(2);
});

test("unrecorded values stay unknown and all checkouts are relative to repository or home", () => {
  const snapshot = report(1);
  delete snapshot.kept[0]!.observedAt;
  delete snapshot.kept[0]!.bytes;
  recordWorktreeSweep(snapshot);
  expect(readWorktreePage(null).rows[0]).toMatchObject({ task: null, observedAt: null, bytes: null });
  expect(relativeCheckout(path.join(root, "sibling"), path.join(root, "repository"))).toBe("../sibling");
  expect(relativeCheckout(path.join(os.homedir(), "checkouts", "tree"))).toBe("~/checkouts/tree");
  expect(relativeCheckout(root).startsWith("~/")).toBe(true);
});

test.each([
  ["C:/repository", "C:/profile", "D:/private/checkouts/tree", "…/tree"],
  ["C:/repository", "D:/profile", "D:/profile/checkouts/tree", "~/checkouts/tree"],
  ["C:/repository", "D:/profile", "E:/private/checkouts/tree", "…/tree"],
  ["C:/repository", "D:/profile", "C:/repository/worktrees/tree", "worktrees/tree"],
  [undefined, "C:/profile", "D:/private/checkouts/tree", "…/tree"],
  ["//server/share/repository", "C:/profile", "//other/share/private/tree", "…/tree"],
] as const)("Windows display and persisted pages: repository=%s home=%s checkout=%s", (repository, home, checkout, display) => {
  const snapshot = report(6);
  snapshot.kept[2] = { path: checkout, repository, reason: "retention" };
  const basename = path.win32.basename;
  const relative = path.win32.relative;
  const isAbsolute = path.win32.isAbsolute;
  const separator = Object.getOwnPropertyDescriptor(path, "sep")!;
  // Exercise the real producer and reader with Windows display semantics on
  // every host. Filesystem joins retain the host's native scratch paths.
  const mocks = [spyOn(path, "basename").mockImplementation(basename),
    spyOn(path, "relative").mockImplementation(relative),
    spyOn(path, "isAbsolute").mockImplementation(isAbsolute),
    spyOn(os, "homedir").mockReturnValue(home)];
  try {
    Object.defineProperty(path, "sep", { ...separator, value: "\\" });
    expect(relativeCheckout(checkout, repository)).toBe(display);
    recordWorktreeSweep(snapshot);
    const first = readWorktreePage(null);
    expect(first.rows.map(row => row.checkout)).toEqual(["worktrees/checkout-0", "worktrees/checkout-1", display, "worktrees/checkout-3"]);
    const last = readWorktreePage(first.nextCursor);
    expect(last.rows.map(row => row.checkout)).toEqual(["worktrees/checkout-4", "worktrees/checkout-5"]);
    expect(readWorktreePage(last.previousCursor)).toEqual(first);
    const response = JSON.stringify([first, last]);
    expect(response).not.toContain(checkout);
    expect(response).not.toContain("private");
    for (const row of [...first.rows, ...last.rows]) {
      expect(path.win32.isAbsolute(row.checkout)).toBe(false);
      expect(path.posix.isAbsolute(row.checkout)).toBe(false);
    }
  } finally {
    Object.defineProperty(path, "sep", separator);
    for (const mock of mocks) mock.mockRestore();
  }
});

test.skipIf(process.platform === "win32")("POSIX checkout names that resemble Windows paths remain readable", () => {
  const snapshot = report(6);
  snapshot.kept[1]!.path = path.join(root, "repository", "C:", "tree");
  snapshot.kept[2]!.path = path.join(root, "repository", "\\tree");
  recordWorktreeSweep(snapshot);
  expect(readWorktreePage(null).rows.map(row => row.checkout)).toEqual(["worktrees/checkout-0", "C:/tree", "\\tree", "worktrees/checkout-3"]);
});

test.each(["C:/private/tree", "D:\\private\\tree", "//server/share/tree", "/private/tree"])("Windows absolute checkout %s still refuses the whole page", checkout => {
  recordWorktreeSweep(report(6));
  const db = new Database(path.join(root, "worktree-drilldown.sqlite"));
  try {
    const row = readWorktreePage(null).rows[2]!;
    db.prepare("UPDATE retained SET body = ? WHERE id = 3").run(JSON.stringify({ ...row, checkout }));
  } finally { db.close(); }
  const isAbsolute = path.win32.isAbsolute;
  const guard = spyOn(path, "isAbsolute").mockImplementation(isAbsolute);
  try { rejects(null, 503, "unavailable"); }
  finally { guard.mockRestore(); }
});

test("an oversized row refuses the whole projection without losing its preceding snapshot", () => {
  recordWorktreeSweep(report(1));
  const large = owners(); large[0]!.task = "я".repeat(65536);
  expect(() => recordWorktreeSweep(report(2), large)).not.toThrow();
  expect(readWorktreePage(null).total).toBe(1);
  expect(JSON.parse(fs.readFileSync(path.join(root, "worktree-sweep-report.json"), "utf8")).kept).toHaveLength(2);
  expect(fs.readdirSync(root).filter(name => name.startsWith(".worktree-drilldown-"))).toEqual([]);
});

test.each(["missing-row", "invalid-row", "invalid-meta"])("a damaged %s projection fails closed", damage => {
  recordWorktreeSweep(report(1));
  const db = new Database(path.join(root, "worktree-drilldown.sqlite"));
  try {
    if (damage === "missing-row") db.exec("DELETE FROM retained");
    if (damage === "invalid-row") db.exec("UPDATE retained SET body = '{}'");
    if (damage === "invalid-meta") db.exec("UPDATE snapshot SET total = -1");
  } finally { db.close(); }
  rejects(null, 503, "unavailable");
});
