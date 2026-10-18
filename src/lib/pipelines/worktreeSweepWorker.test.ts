import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";
import { WorktreeSweepWorker, stopWorktreeSweepWorker } from "./worktreeSweepWorker";
import { SWEEP_CACHE_TREES } from "./worktreeSweepCache";
import { runWorktreeSweep } from "./worktreeSweep";

const roots: string[] = [];
const workers: WorktreeSweepWorker[] = [];
const previous = process.env.SWEEP_TEST_ROOT;
afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.close();
  await stopWorktreeSweepWorker();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  if (previous === undefined) delete process.env.SWEEP_TEST_ROOT; else process.env.SWEEP_TEST_ROOT = previous;
});
function fixture(flag?: string, timeoutMs = 10_000) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-worker-")); roots.push(root);
  fs.mkdirSync(path.join(root, "tree/nested"), { recursive: true });
  fs.writeFileSync(path.join(root, "tree/nested/file"), "original");
  process.env.SWEEP_TEST_ROOT = root;
  const worker = launch(flag, timeoutMs);
  return { root, worker };
}
function launch(flag?: string, timeoutMs = 10_000) {
  const worker = new WorktreeSweepWorker({ executable: process.execPath, entry: path.join(import.meta.dir,"worktreeSweep.fixture.ts"), args: flag ? [flag] : [] },timeoutMs);
  workers.push(worker); return worker;
}
const counters = (report: unknown) => (report as {cacheStats:{allocationHits:number;allocationMisses:number}}).cacheStats;

test("real worker reuses unchanged inventories, invalidates deep writes, and revalidates after owner restart", async () => {
  const { root, worker } = fixture();
  const first = await worker.run("dry-run");
  const second = await worker.run("dry-run");
  expect(counters(first)).toMatchObject({allocationHits:0,allocationMisses:1});
  expect(counters(second)).toMatchObject({allocationHits:1,allocationMisses:1});
  const file = path.join(root,"tree/nested/file");
  fs.writeFileSync(file, "changed".repeat(8192));
  const deadline = Date.now() + 10_000;
  let changed;
  do {
    changed = await worker.run("dry-run");
    if (counters(changed).allocationMisses > 1) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  } while (Date.now() < deadline);
  expect(counters(changed).allocationMisses).toBeGreaterThan(1);
  expect(changed!.kept[0].bytes).toBeGreaterThan(first.kept[0].bytes!);
  await worker.close();
  fs.writeFileSync(file, "offline".repeat(16384));
  const restarted = await launch().run("dry-run");
  expect(counters(restarted).allocationMisses).toBe(1);
  expect(restarted.kept[0].bytes).toBeGreaterThan(changed!.kept[0].bytes!);
  expect(JSON.parse(fs.readFileSync(path.join(root,"cache.json"),"utf8")).version).toBe(1);
},30_000);

for (const flag of ["--malformed", "--exit", "--oversize", "--hang"]) test(`worker refuses ${flag} and its contained process ends`, async () => {
  const { root, worker } = fixture(flag, 2_000);
  await worker.run("dry-run"); // explicit readiness before inducing failure
  await expect(worker.run("on")).rejects.toThrow();
  if (flag === "--hang") {
    const pid = Number(fs.readFileSync(path.join(root,"busy-pid"),"utf8"));
    expect(() => process.kill(pid,0)).toThrow();
  }
  expect(fs.readFileSync(path.join(root,"tree/nested/file"),"utf8")).toBe("original");
  // The failed worker has closed before replacement may start.
  expect((await worker.run("dry-run")).errors).toEqual([]);
},20_000);

test("production entry runs off thread against isolated empty state", async () => {
  const report = await runWorktreeSweep({ LLV_WORKTREE_SWEEP: "dry-run" });
  expect(report?.errors).toEqual([]);
  expect(report?.removed).toEqual([]);
},30_000);


test("a restored full cache admits a new root within its persistent bound across real worker restarts",async()=>{
  const {root,worker}=fixture();
  fs.writeFileSync(path.join(root,"cache.json"),JSON.stringify({version:1,owner:"old-owner",rows:
    Array.from({length:SWEEP_CACHE_TREES},(_,i)=>[path.join(root,`past-${i}`),{key:"past-owner",at:1_000,candidates:[]}])}));
  await worker.run("dry-run");await worker.close();
  expect(JSON.parse(fs.readFileSync(path.join(root,"cache.json"),"utf8")).rows).toHaveLength(SWEEP_CACHE_TREES);
  await launch().run("dry-run");
  expect(JSON.parse(fs.readFileSync(path.join(root,"cache.json"),"utf8")).rows).toHaveLength(SWEEP_CACHE_TREES);
},30_000);
