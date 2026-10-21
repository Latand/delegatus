import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { runRetentionPass } from "./retentionPass";
import type { LauncherRecord } from "./launcher";
import type { RetentionInputs } from "./retention";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture(count = 12) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-retention-pass-")); roots.push(root);
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
    current: () => ({ record, inputs }), launch: { executable: process.execPath, entry: path.join(import.meta.dir, "retentionPass.fixture.ts"), args: [root] } };
  const ended = () => expect(() => process.kill(Number(fs.readFileSync(path.join(root, "helper-pid"), "utf8")), 0)).toThrow();
  return { root, dirs, record, inputs, options, ended };
}

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
