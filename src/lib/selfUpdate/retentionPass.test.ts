import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { runRetentionPass } from "./retentionPass";
import type { LauncherRecord } from "./launcher";
import type { RetentionInputs } from "./retention";
import { quarantineTree } from "./gatedTrash";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture(count = 12) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "llv-retention-pass-"))); roots.push(root);
  const releasesDir = path.join(root, "releases"); fs.mkdirSync(releasesDir);
  const now = Date.UTC(2030, 0, 1);
  const dirs = Array.from({ length: count }, (_, i) => {
    const dir = path.join(releasesDir, `npm-1.0.${i}`); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
    const at = new Date(now - (count - i + 2) * 86_400_000);
    fs.utimesSync(path.join(dir, "package.json"), at, at); fs.utimesSync(dir, at, at); return dir;
  });
  const record = { checkout: null, releasesDir, releasePointer: path.join(root, "release.json"),
    launcher: {}, web: {}, runtimeHost: {} } as LauncherRecord;
  fs.writeFileSync(record.releasePointer, JSON.stringify({ dir: dirs[0] }));
  const inputs: RetentionInputs = {};
  const options = { reportFile: path.join(root, "retention.json"), env: { LLV_SELF_UPDATE_KEEP_RELEASES: "1" }, now,
    current: () => ({ record, inputs }), fence: () => true, launch: { executable: process.execPath, entry: path.join(import.meta.dir, "retentionPass.fixture.ts"), args: [root] } };
  const ended = () => expect(() => process.kill(Number(fs.readFileSync(path.join(root, "helper-pid"), "utf8")), 0)).toThrow();
  return { root, dirs, record, inputs, options, ended };
}

test.each([
  { releases: 0, journals: 0 }, { releases: 6, journals: 0 }, { releases: 0, journals: 1 },
  { releases: 6, journals: 1 }, { releases: 6, journals: 5 },
])("Darwin retention keeps uncertain data without procfs ($releases releases, $journals journals)", async ({ releases, journals }) => {
  const h = fixture(releases + journals);
  if (!releases && !journals) fs.rmdirSync(h.record.releasesDir);
  const quarantines: { dir: string; gate: string; journal: string; original: Buffer; fd: number }[] = [];
  const launch = { executable: process.execPath, entry: path.resolve(import.meta.dir, "../retention.worker.ts") };
  const claims: string[] = [];
  const fence = (claim: string) => { claims.push(claim); return true; };
  if (releases) h.inputs.rollbackPackage = h.dirs[1]!;
  const bunOptions = process.env.BUN_OPTIONS;
  const probeDir = process.env.LLV_TEST_RETENTION_PROBE_DIR;
  process.env.BUN_OPTIONS = `--preload=${path.join(import.meta.dir, "retentionPass.darwin.fixture.ts")}`;
  process.env.LLV_TEST_RETENTION_PROBE_DIR = h.root;
  try {
    for (const [index, dir] of h.dirs.slice(releases).entries()) {
      const journal = path.join(h.root, `package-trash-${index}.json`);
      const row = quarantineTree(dir, journal);
      if (!row) throw new Error(`could not quarantine ${dir}`);
      const original = fs.readFileSync(journal);
      const fd = fs.openSync(path.join(row.trash, "package.json"), "r");
      quarantines.push({ dir, gate: row.gate, journal, original, fd });
      fs.chmodSync(row.gate, 0);
    }
    const reason = "process-inventory-unavailable:darwin";
    const backlog = journals > 4;
    for (const start of backlog ? [0, 4] : [0]) {
      const entryMarkers = ["helper-lease.mjs", "retention.worker.ts"].map(entry => path.join(h.root, `${entry}.pid`));
      for (const marker of entryMarkers) fs.rmSync(marker, { force: true });
      const report = await runRetentionPass(h.record, h.inputs, { ...h.options, launch, fence });
      for (const marker of entryMarkers) {
        const pid = Number(fs.readFileSync(marker, "utf8"));
        expect(pid).toBeGreaterThan(1);
        expect(() => process.kill(pid, 0)).toThrow();
      }
      expect(report.errors).toEqual([]);
      expect(claims).toEqual([]);
      expect(report.removed).toEqual([]);
      expect(report.reclaimedCacheBytes).toBe(0);
      expect(JSON.parse(fs.readFileSync(h.options.reportFile, "utf8"))).toEqual(report);
      const visited = [...quarantines.slice(start), ...quarantines.slice(0, start)].slice(0, 4);
      expect(report.kept).toEqual([
        ...h.dirs.slice(0, releases).map((dir, i) => ({ dir, reason: i === 0 ? "active" : i === 1 ? "rollback" : reason, bytes: 0 })),
        ...visited.map(({ dir }) => ({ dir, reason, bytes: 0 })),
        ...(backlog ? [{ dir: h.record.releasesDir, reason: `${reason}:recovery-backlog (1 unvisited journal)`, bytes: 0 }] : []),
      ]);
      for (const dir of h.dirs.slice(0, releases)) expect(fs.readFileSync(path.join(dir, "package.json"), "utf8")).toBe("{}");
      for (const { dir, gate, journal, original, fd } of quarantines) {
        expect(fs.existsSync(dir)).toBe(false);
        expect(fs.readFileSync(journal)).toEqual(original);
        expect(fs.statSync(gate).mode & 0o777).toBe(0);
        expect(fs.fstatSync(fd).nlink).toBe(1);
        const content = Buffer.alloc(2);
        expect(fs.readSync(fd, content, 0, content.length, 0)).toBe(content.length);
        expect(content.toString()).toBe("{}");
      }
    }
    const procReads = path.join(h.root, "proc-reads");
    expect(fs.existsSync(procReads) ? fs.readFileSync(procReads, "utf8").trim().split("\n") : []).toEqual([]);
  } finally {
    if (bunOptions === undefined) delete process.env.BUN_OPTIONS; else process.env.BUN_OPTIONS = bunOptions;
    if (probeDir === undefined) delete process.env.LLV_TEST_RETENTION_PROBE_DIR; else process.env.LLV_TEST_RETENTION_PROBE_DIR = probeDir;
    for (const { gate, fd } of quarantines) {
      fs.closeSync(fd);
      if (fs.existsSync(gate)) fs.chmodSync(gate, 0o700);
    }
  }
}, 30_000);

test.skipIf(process.platform !== "linux")("fresh pass processes resume a bounded cursor past permanently kept releases off the caller loop", async () => {
  const h = fixture();
  for (const dir of h.dirs.slice(1, 5)) {
    const at = fs.statSync(dir).mtime;
    fs.mkdirSync(path.join(dir, ".git")); fs.writeFileSync(path.join(dir, ".git/config"), "fixture");
    fs.utimesSync(dir, at, at);
  }
  const original = fs.readdirSync;
  const read = spyOn(fs, "readdirSync").mockImplementation(((directory: fs.PathLike, ...args: unknown[]) => {
    if (String(directory).startsWith(h.record.releasesDir)) throw new Error("release walk on caller loop");
    return Reflect.apply(original, fs, [directory, ...args]);
  }) as typeof original);
  try {
    const first = await runRetentionPass(h.record, h.inputs, h.options); h.ended();
    expect(first.errors).toEqual([]); expect(first.removed).toEqual([]);
    expect(first.kept.map(row => row.reason)).toContain("pass-budget");
    const second = await runRetentionPass(h.record, h.inputs, h.options); h.ended();
    expect(second.errors).toEqual([]);
    expect(second.removed.map(row => row.dir)).toEqual(h.dirs.slice(5, 8));
    expect(fs.existsSync(h.dirs[0]!)).toBeTrue(); expect(fs.existsSync(h.dirs.at(-1)!)).toBeTrue();
    for (const dir of h.dirs.slice(1, 5)) expect(fs.existsSync(dir)).toBeTrue();
  } finally { read.mockRestore(); }
}, 60_000);

test.skipIf(process.platform !== "linux")("a pass reads fresh owner inputs across its IPC wait and closes its helper", async () => {
  const h = fixture(4); let entered!: () => void; let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  const running = runRetentionPass(h.record, h.inputs, { ...h.options, current: async () => {
    if (first) { first = false; entered(); await held; }
    return { record: h.record, inputs: h.inputs };
  } });
  try {
    await Promise.race([started, running.then(() => { throw new Error("pass completed before its safety read"); })]);
    h.inputs.inFlight = [h.dirs[1]!]; release();
    const report = await running;
    expect(report.errors).toEqual([]);
    expect(report.kept).toContainEqual(expect.objectContaining({ dir: h.dirs[1], reason: "in-flight" }));
    expect(fs.existsSync(h.dirs[1]!)).toBeTrue(); h.ended();
  } finally { release(); await running; }
}, 30_000);

test.skipIf(process.platform !== "linux")("a process entering quarantined trash during the final owner IPC is refused at the closed gate", async () => {
  const h = fixture(4);
  h.options.env.LLV_SELF_UPDATE_KEEP_RELEASES = "1";
  const target = h.dirs[1]!;
  let refusal: NodeJS.ErrnoException | undefined;
  let tried = false;
  const current = async () => {
    if (fs.existsSync(path.join(h.root, "trash-scan-complete")) && !tried) {
      const gate = fs.readdirSync(h.record.releasesDir).map(name => path.join(h.record.releasesDir, name))
        .find(directory => path.basename(directory).startsWith(`.delegatus-trash-${path.basename(target)}-`));
      if (gate) {
        tried = true;
        const holder = spawn(process.execPath, ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000)"], {
          cwd: path.join(gate, path.basename(target)), env: { PATH: process.env.PATH, NODE_ENV: "test", HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
            TMPDIR: process.env.TMPDIR, LLV_STATE_DIR: process.env.LLV_STATE_DIR, LLV_VIEWER_CONTROL_URL: process.env.LLV_VIEWER_CONTROL_URL },
          stdio: ["ignore", "pipe", "ignore"],
        });
        await new Promise<void>((resolve, reject) => {
          holder.once("error", error => { refusal = error; resolve(); });
          holder.stdout!.once("data", () => { holder.kill("SIGKILL"); reject(new Error("holder entered a closed gate")); });
        });
      }
    }
    return { record: h.record, inputs: h.inputs };
  };
  const report = await runRetentionPass(h.record, h.inputs, { ...h.options, current,
    launch: { ...h.options.launch, args: [h.root, "arrival-during-second-current"] } });
  expect(report.errors).toEqual([]);
  expect(tried).toBeTrue();
  expect(refusal?.code).toBe("EACCES");
  expect(report.removed.some(row => row.dir === target)).toBeTrue();
  expect(fs.readdirSync(h.record.releasesDir).some(name => name.startsWith(".delegatus-trash-"))).toBeFalse();
  h.ended();
}, 30_000);

test.skipIf(process.platform !== "linux").each(["abort", "deadline"])("%s ends a ready pass and pre-aborted work never dispatches", async kind => {
  const h = fixture(); const abort = new AbortController(); let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  let expire!: () => void;
  const running = runRetentionPass(h.record, h.inputs, { ...h.options, signal: abort.signal,
    schedule: kind === "deadline" ? callback => { expire = callback; return () => {}; } : undefined, current: async () => {
    entered(); await held; return { record: h.record, inputs: h.inputs };
  } });
  try {
    await Promise.race([started, running]);
    if (kind === "abort") abort.abort(); else expire();
    await expect(running).rejects.toThrow(kind === "abort" ? "retention owner stopped" : "retention pass deadline"); h.ended();
  } finally { release(); await running.catch(() => {}); }
  fs.unlinkSync(path.join(h.root, "helper-pid"));
  abort.abort();
  await expect(runRetentionPass(h.record, h.inputs, { ...h.options, signal: abort.signal })).rejects.toThrow();
  expect(fs.existsSync(path.join(h.root, "helper-pid"))).toBeFalse();
});

test.skipIf(process.platform !== "linux").each(["malformed", "invalid-report"])("a %s pass reply refuses success and closes its recorded helper", async failure => {
  const h = fixture();
  await expect(runRetentionPass(h.record, h.inputs, { ...h.options, launch: { ...h.options.launch, args: [h.root, failure] } })).rejects.toThrow();
  h.ended();
  for (const dir of h.dirs) expect(fs.existsSync(dir)).toBeTrue();
});

test.skipIf(process.platform !== "linux").each([true, false])("the owner raises its hold fence before answering a removal claim (fenced %p)", async fenced => {
  const h = fixture(4); const target = h.dirs[1]!;
  const claims: string[] = []; let delayed = 0; let refusedHold = false;
  const report = await runRetentionPass(h.record, h.inputs, { ...h.options,
    fence: claim => { claims.push(claim); return fenced; },
    current: async () => {
      // A delayed reply: a hold attempted meanwhile on a claimed release is
      // refused by the owner's fence, never acquired behind the reply.
      if (claims.includes(target) && !delayed++) {
        await new Promise(resolve => setTimeout(resolve, 50));
        if (fenced) refusedHold = true; else h.inputs.rollbackPointers = [JSON.stringify({ dir: target })];
      }
      return { record: h.record, inputs: structuredClone(h.inputs) };
    } });
  expect(report.errors).toEqual([]);
  expect(claims).toContain(target);
  if (fenced) {
    expect(refusedHold).toBeTrue();
    expect(report.removed.map(row => row.dir)).toContain(target);
  } else {
    // An owner that cannot fence authorizes no removal at all.
    expect(report.removed).toEqual([]);
    for (const dir of h.dirs) expect(fs.existsSync(path.join(dir, "package.json"))).toBeTrue();
    expect(report.kept).toContainEqual(expect.objectContaining({ dir: h.dirs[2], reason: "owner-unfenced" }));
  }
  h.ended();
}, 30_000);
