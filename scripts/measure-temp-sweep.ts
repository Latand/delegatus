/** T2/H3 replay on synthetic procfs, with no access to operator temp roots.
 * Run under gate-slot with isolated HOME, XDG_CONFIG_HOME, LLV_STATE_DIR and
 * TMPDIR. --before uses the original synchronous scan/probe path; --after
 * sends identical work through the production leased-helper client. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanProcesses, runTempSweep } from "../src/lib/tempSweep";
import { diskVolumes, readDiskPressure } from "../src/lib/state/diskPressure";
import { WorktreeSweepWorker } from "../src/lib/pipelines/worktreeSweepWorker";

const after = process.argv.includes("--after");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-sweep-measure-"));
const prior = process.env.SWEEP_TEST_ROOT;
process.env.SWEEP_TEST_ROOT = root;
let worker: WorktreeSweepWorker | undefined;
try {
  const proc = path.join(root, "proc");
  fs.mkdirSync(path.join(proc, "self/ns"), { recursive: true });
  fs.symlinkSync("mnt:[1]", path.join(proc, "self/ns/mnt"));
  for (let i = 1; i <= 340; i++) {
    const directory = path.join(proc, String(i));
    fs.mkdirSync(path.join(directory, "ns"), { recursive: true });
    fs.symlinkSync("mnt:[1]", path.join(directory, "ns/mnt"));
    fs.mkdirSync(path.join(directory, "fd"));
    fs.symlinkSync(root, path.join(directory, "cwd"));
    fs.writeFileSync(path.join(directory, "cmdline"), "fixture\0");
    fs.writeFileSync(path.join(directory, "environ"), "");
    fs.writeFileSync(path.join(directory, "maps"), Array.from({ length: i <= 140 ? 129 : 128 },
      (_, j) => `0-1 r--p 0 00:00 0 /fixture/${i}/${j}`).join("\n"));
  }
  const roots = Array.from({ length: 932 }, (_, i) => {
    const directory = path.join(root, `tree-${i}`);
    fs.mkdirSync(directory);
    return { role: "worktrees", directory };
  });
  if (after) {
    worker = new WorktreeSweepWorker({ executable: process.execPath,
      entry: path.resolve("src/lib/pipelines/worktreeSweep.fixture.ts") });
    (globalThis as typeof globalThis & { __delegatusWorktreeSweepWorker?: WorktreeSweepWorker }).__delegatusWorktreeSweepWorker = worker;
  }
  for (const kind of ["T2", "H3"]) for (let run = 0; run < 4; run++) {
    let last = performance.now(), maxLoopMs = 0;
    const timer = setInterval(() => { const at = performance.now(); maxLoopMs = Math.max(maxLoopMs, at - last); last = at; }, 1);
    try {
      await new Promise(resolve => setTimeout(resolve, 10));
      const cpu = process.cpuUsage(), start = performance.now();
      if (worker) {
        if (kind === "T2") await runTempSweep({ ...process.env, LLV_TEMP_SWEEP: "dry-run" }); else await readDiskPressure();
      } else {
        const scan = scanProcesses(proc);
        if (scan.processes.length !== 340 || scan.processes.reduce((n, row) => n + row.paths.length, 0) !== 44_000)
          throw new Error("fixture shape changed");
        if (kind === "H3") diskVolumes(roots);
      }
      const wallMs = performance.now() - start, used = process.cpuUsage(cpu);
      await new Promise(resolve => setTimeout(resolve, 10));
      console.log(JSON.stringify({ mode: after ? "after" : "before", kind, run, processes: 340,
        paths: 44_000, roots: roots.length, wallMs, cpuMs: (used.user + used.system) / 1000, maxLoopMs, load: os.loadavg() }));
    } finally { clearInterval(timer); }
  }
} finally {
  await worker?.close();
  delete (globalThis as typeof globalThis & { __delegatusWorktreeSweepWorker?: WorktreeSweepWorker }).__delegatusWorktreeSweepWorker;
  if (prior === undefined) delete process.env.SWEEP_TEST_ROOT; else process.env.SWEEP_TEST_ROOT = prior;
  fs.rmSync(root, { recursive: true, force: true });
}
