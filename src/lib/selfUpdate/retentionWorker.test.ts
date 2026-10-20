import { afterEach, expect, test, spyOn } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { RetentionWorker } from "./retentionWorker";
import { retentionProcessScan, retentionBytes, retentionScanWithObserver, validRetentionScan } from "./retentionInspection";

const roots: string[] = [];
const workers: RetentionWorker[] = [];
afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function root() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-retention-worker-")); roots.push(root); return root; }
function launch(directory: string, failure: string) {
  const worker = new RetentionWorker({ executable: process.execPath, entry: path.join(import.meta.dir, "retention.fixture.ts"), args: [directory, failure] }, 2_000);
  workers.push(worker); return worker;
}

function procFixture() {
  const directory = root(); const proc = path.join(directory, "proc"); const release = path.join(directory, "release");
  fs.mkdirSync(release);
  fs.mkdirSync(path.join(proc, "self/ns"), { recursive: true }); fs.symlinkSync("mnt:[fixture]", path.join(proc, "self/ns/mnt"));
  const base = path.join(proc, "123"); fs.mkdirSync(path.join(base, "ns"), { recursive: true }); fs.mkdirSync(path.join(base, "fd"));
  fs.symlinkSync("mnt:[fixture]", path.join(base, "ns/mnt"));
  fs.writeFileSync(path.join(base, "stat"), "123 (fixture) S " + "0 ".repeat(20));
  for (const link of ["cwd", "root", "exe"]) fs.symlinkSync(directory, path.join(base, link));
  for (const file of ["cmdline", "environ", "maps"]) fs.writeFileSync(path.join(base, file), "");
  return { directory, proc, release, base };
}

test.each(["cwd", "exe", "fd", "maps", "environ"])("missing %s evidence of a live process retains installation-wide uncertainty", file => {
  const h = procFixture();
  fs.rmSync(path.join(h.base, file), { recursive: true });
  expect(retentionProcessScan(h.release, h.proc).uncertain).toMatchObject([{ pid: 123, roots: [h.release] }]);
});

test("an exited process is omitted but a reused PID remains uncertain", () => {
  const h = procFixture(); const original = fs.readFileSync; let reads = 0;
  let state = "Z";
  const read = spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (String(file) === path.join(h.base, "stat") && ++reads > 1) {
      const values = Array(21).fill("0"); values[0] = state; values[19] = "1";
      return "123 (fixture) " + values.join(" ");
    }
    return Reflect.apply(original, fs, [file, ...args]);
  }) as typeof original);
  try {
    expect(retentionProcessScan(h.release, h.proc).uncertain).toEqual([]);
    state = "S"; reads = 0;
    expect(retentionProcessScan(h.release, h.proc).uncertain).toMatchObject([{ pid: 123, reason: "identity:unavailable" }]);
  } finally { read.mockRestore(); }
});

test("a foreign mount namespace translates bind-mounted cwd, descriptors and mappings", () => {
  const h = procFixture();
  fs.unlinkSync(path.join(h.base, "ns/mnt")); fs.symlinkSync("mnt:[container]", path.join(h.base, "ns/mnt"));
  fs.writeFileSync(path.join(h.proc, "self/mountinfo"), "1 0 8:1 / / rw - ext4 /dev/fixture rw\n2 1 0:4 net:[456] /run/netns/fixture rw - nsfs nsfs rw\n");
  fs.writeFileSync(path.join(h.base, "mountinfo"), `1 0 8:1 /unrelated /app rw - ext4 /dev/fixture rw\n2 0 8:1 ${h.release} /app rw - ext4 /dev/fixture rw\n`);
  for (const link of ["cwd", "root", "exe"]) { fs.unlinkSync(path.join(h.base, link)); fs.symlinkSync("/app", path.join(h.base, link)); }
  fs.symlinkSync("/app/open", path.join(h.base, "fd/1"));
  fs.symlinkSync("socket:[456]", path.join(h.base, "fd/2"));
  fs.writeFileSync(path.join(h.base, "maps"), "0-1 r--p 0 0 0 /app/mapped.so\n");
  const scan = retentionProcessScan(h.release, h.proc);
  expect(scan.uncertain).toEqual([]);
  expect(scan.processes[0]!.paths).toContain(h.release);
  expect(scan.processes[0]!.paths).toContain(path.join(h.release, "open"));
  expect(scan.processes[0]!.paths).toContain(path.join(h.release, "mapped.so"));
  fs.unlinkSync(path.join(h.base, "mountinfo"));
  expect(retentionProcessScan(h.release, h.proc).uncertain).toMatchObject([{ reason: "mountinfo:ENOENT", roots: [h.release] }]);
});

test("kernel threads permit only absent executable and environment, and still inspect open files", () => {
  const h = procFixture(); const values = Array(21).fill("0"); values[0] = "S"; values[6] = String(0x200000);
  fs.writeFileSync(path.join(h.base, "stat"), "123 (fixture) " + values.join(" "));
  fs.unlinkSync(path.join(h.base, "exe")); fs.symlinkSync(h.release, path.join(h.base, "fd/1"));
  const original = fs.readFileSync;
  const read = spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (String(file) === path.join(h.base, "environ")) throw Object.assign(new Error("no userspace environment"), { code: "ESRCH" });
    return Reflect.apply(original, fs, [file, ...args]);
  }) as typeof original);
  try {
    const scan = retentionProcessScan(h.release, h.proc);
    expect(scan.uncertain).toEqual([]); expect(scan.processes[0]!.paths).toContain(h.release);
    fs.rmSync(path.join(h.base, "fd"), { recursive: true });
    expect(retentionProcessScan(h.release, h.proc).uncertain).toMatchObject([{ reason: "fd:ENOENT" }]);
  } finally { read.mockRestore(); }
});

test("an inaccessible live process is reported as uncertainty instead of aborting the inventory", () => {
  const directory = root();
  fs.mkdirSync(path.join(directory, "self/ns"), { recursive: true });
  fs.symlinkSync("mnt:[fixture]", path.join(directory, "self/ns/mnt"));
  fs.mkdirSync(path.join(directory, "123"));
  fs.writeFileSync(path.join(directory, "123/stat"), "123 (fixture) S " + "0 ".repeat(20));
  const original = fs.readlinkSync;
  const read = spyOn(fs, "readlinkSync").mockImplementation(((entry: fs.PathLike, ...args: unknown[]) => {
    if (String(entry) === path.join(directory, "123/ns/mnt")) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return Reflect.apply(original, fs, [entry, ...args]);
  }) as typeof original);
  try {
    const scan = retentionProcessScan(directory, directory);
    expect(scan.complete).toBeTrue();
    expect(scan).toMatchObject({ uncertain: [{ pid: 123, reason: "ns/mnt:EACCES" }] });
  } finally { read.mockRestore(); }
});

test.each(["refused", "malformed", "empty-scope", "complete"])("a read-only observer %s preserves uncertainty or supplies a validated inventory", kind => {
  const directory = root();
  fs.mkdirSync(path.join(directory, "self/ns"), { recursive: true });
  fs.symlinkSync("mnt:[fixture]", path.join(directory, "self/ns/mnt"));
  fs.mkdirSync(path.join(directory, "123"));
  fs.writeFileSync(path.join(directory, "123/stat"), "123 (fixture) S " + "0 ".repeat(20));
  let calls = 0;
  const scan = retentionScanWithObserver(directory, () => {
    calls++;
    if (kind === "refused") throw new Error("observer refused");
    if (kind === "malformed") return { complete: false };
    return { complete: true, ownNamespace: "mnt:[fixture]", processes: [],
      uncertain: kind === "empty-scope" ? [{ pid: 123, reason: "fd:EACCES", roots: [] }] : [] };
  }, directory);
  expect(calls).toBe(1);
  expect(validRetentionScan(scan)).toBeTrue();
  expect(scan.uncertain).toHaveLength(kind === "complete" ? 0 : 1);
});

test("uncertainty never narrows by process ownership or directory permissions", () => {
  const directory = root(); fs.chmodSync(directory, 0o700);
  fs.mkdirSync(path.join(directory, "self/ns"), { recursive: true });
  fs.symlinkSync("mnt:[fixture]", path.join(directory, "self/ns/mnt"));
  fs.mkdirSync(path.join(directory, "123"));
  fs.writeFileSync(path.join(directory, "123/stat"), "123 (fixture) S " + "0 ".repeat(20));
  fs.writeFileSync(path.join(directory, "123/status"), "Uid:\t2000\t2000\t2000\t2000\nCapPrm:\t0000000000000000\n");
  expect(retentionProcessScan(directory, directory).uncertain).toMatchObject([{ pid: 123, roots: [directory] }]);
});
for (const failure of ["exit", "hang", "malformed", "truncated", "oversize", "partial", "wrong-kind"]) {
  test(`real retention helper fails closed on ${failure} and ends its recorded process`, async () => {
    const directory = root(); const worker = launch(directory, failure);
    expect(await worker.bytes(directory)).toBe(0); // helper readiness before the induced failure
    const pid = Number(fs.readFileSync(path.join(directory, "helper-pid"), "utf8"));
    await expect(worker.scan(directory)).rejects.toThrow();
    await worker.close();
    expect(() => process.kill(pid, 0)).toThrow();
    await expect(worker.bytes(directory)).rejects.toThrow();
  }, 15_000);
}

test("production byte walks stay off the caller loop and preserve allocation semantics", async () => {
  const directory = root(); fs.mkdirSync(path.join(directory, "tree"));
  fs.writeFileSync(path.join(directory, "tree/file"), "fixture".repeat(1024));
  fs.linkSync(path.join(directory, "tree/file"), path.join(directory, "tree/link"));
  fs.symlinkSync("missing", path.join(directory, "symlink"));
  const expected = retentionBytes(directory);
  const worker = new RetentionWorker(); workers.push(worker);
  const lstat = spyOn(fs, "lstatSync").mockImplementation(() => { throw new Error("byte traversal on caller"); });
  try { expect(await worker.bytes(directory)).toBe(expected); } finally { lstat.mockRestore(); }
  await worker.close();
});

test.skipIf(process.platform !== "linux")("a real scan stays off the caller and either proves completeness or refuses inaccessible processes", async () => {
  const directory = root(); const worker = new RetentionWorker(); workers.push(worker);
  const original = fs.readdirSync;
  const read = spyOn(fs, "readdirSync").mockImplementation(((directory: fs.PathLike, ...args: unknown[]) => {
    if (String(directory) === "/proc") throw new Error("process scan on caller");
    return Reflect.apply(original, fs, [directory, ...args]);
  }) as typeof original);
  try {
    const result = await worker.scan(directory).then(scan => ({ scan }), error => ({ error }));
    if ("scan" in result) { expect(result.scan.complete).toBeTrue(); expect(result.scan.ownNamespace).toBeTruthy(); }
    else expect(result.error.message).toBe("partial retention process scan");
  } finally { read.mockRestore(); await worker.close(); }
}, 15_000);

test.skipIf(process.platform !== "linux").each(["missing-namespace", "unreadable-process", "missing-evidence"])("a partial proc tree fails closed: %s", kind => {
  const directory = root(); fs.mkdirSync(path.join(directory, "self/ns"), { recursive: true });
  if (kind !== "missing-namespace") fs.symlinkSync("mnt:[fixture]", path.join(directory, "self/ns/mnt"));
  fs.mkdirSync(path.join(directory, "123"));
  if (kind === "missing-evidence") {
    fs.mkdirSync(path.join(directory, "123/ns")); fs.symlinkSync("mnt:[fixture]", path.join(directory, "123/ns/mnt"));
    fs.writeFileSync(path.join(directory, "123/stat"), "123 (fixture) S " + "0 ".repeat(20));
  }
  if (kind === "missing-namespace") expect(() => retentionProcessScan(directory, directory)).toThrow();
  else expect(retentionProcessScan(directory, directory).uncertain).toMatchObject([{ pid: 123, roots: [directory] }]);
});

test.skipIf(process.platform !== "linux").each(["same-uid", "foreign-uid"])("a complete proc fixture retains physical aliases, argv, environment and mapped paths: %s", owner => {
  const directory = root(); const proc = path.join(directory, "proc"); const release = path.join(directory, "release");
  fs.mkdirSync(release); fs.symlinkSync(release, path.join(directory, "alias"));
  fs.mkdirSync(path.join(proc, "self/ns"), { recursive: true }); fs.symlinkSync("mnt:[fixture]", path.join(proc, "self/ns/mnt"));
  const base = path.join(proc, "123"); fs.mkdirSync(path.join(base, "ns"), { recursive: true }); fs.mkdirSync(path.join(base, "fd"));
  fs.symlinkSync("mnt:[fixture]", path.join(base, "ns/mnt"));
  fs.writeFileSync(path.join(base, "stat"), "123 (fixture) S " + "0 ".repeat(20));
  for (const link of ["cwd", "root", "exe"]) fs.symlinkSync(directory, path.join(base, link));
  fs.writeFileSync(path.join(base, "cmdline"), path.join(directory, "alias/future.ts") + "\0");
  fs.writeFileSync(path.join(base, "environ"), `CUSTOM=prefix:${release}/vendor:suffix\0`);
  fs.writeFileSync(path.join(base, "maps"), `0-1 r--p 0 0 0 ${release}/mapped.so\n`);
  fs.symlinkSync(release, path.join(base, "fd/1"));
  const originalStat = fs.statSync;
  const stat = spyOn(fs, "statSync").mockImplementation(((entry: fs.PathLike, ...args: unknown[]) => {
    const value = Reflect.apply(originalStat, fs, [entry, ...args]);
    if (owner === "foreign-uid" && String(entry) === base) value.uid++;
    return value;
  }) as typeof originalStat);
  let scan;
  try { scan = retentionProcessScan(release, proc); } finally { stat.mockRestore(); }
  expect(scan.complete).toBeTrue(); expect(scan.processes).toHaveLength(1);
  expect(scan.processes[0]!.paths).toContain(path.join(directory, "alias/future.ts"));
  expect(scan.processes[0]!.paths).toContain(path.join(release, "mapped.so"));
  expect(scan.processes[0]!.references).toContain(`prefix:${release}/vendor:suffix`);
});

test("an over-budget byte walk refuses its partial count", () => {
  const directory = root(); fs.writeFileSync(path.join(directory, "file"), "fixture");
  const original = fs.readdirSync;
  const read = spyOn(fs, "readdirSync").mockImplementation(((file: fs.PathLike, ...args: unknown[]) =>
    String(file) === directory ? Array(200_000).fill("file") : Reflect.apply(original, fs, [file, ...args])) as typeof original);
  try { expect(() => retentionBytes(directory)).toThrow("partial retention byte count"); } finally { read.mockRestore(); }
});

test("a byte walk crossing a device refuses the observation", () => {
  const directory = root(); const file = path.join(directory, "file"); fs.writeFileSync(file, "fixture");
  const original = fs.lstatSync;
  const stat = spyOn(fs, "lstatSync").mockImplementation(((entry: fs.PathLike, ...args: unknown[]) => {
    const value = Reflect.apply(original, fs, [entry, ...args]);
    if (String(entry) === file) value.dev++;
    return value;
  }) as typeof original);
  try { expect(() => retentionBytes(directory)).toThrow("crossed a device"); } finally { stat.mockRestore(); }
});

test("the bundled retention entry performs a real byte request under the pinned runtime", async () => {
  const directory = root(); fs.writeFileSync(path.join(directory, "file"), "fixture".repeat(1024));
  const result = await Bun.build({ entrypoints: [path.join(import.meta.dir, "../retention.worker.ts")], target: "bun", outdir: path.join(directory, "bundle") });
  expect(result.success).toBeTrue();
  const tree = path.join(directory, "tree"); fs.mkdirSync(tree); fs.writeFileSync(path.join(tree, "file"), "fixture");
  const worker = new RetentionWorker({ executable: process.execPath, entry: result.outputs[0]!.path }); workers.push(worker);
  expect(await worker.bytes(tree)).toBe(retentionBytes(tree));
  await worker.close();
}, 30_000);

test.skipIf(process.platform !== "linux")("source and bundled proc observers load without an owner and never create application state", async () => {
  const directory = root(); const source = path.join(import.meta.dir, "../retention.worker.ts");
  const build = await Bun.build({ entrypoints: [source], target: "bun", outdir: path.join(directory, "observer-bundle") });
  expect(build.success).toBeTrue();
  for (const entry of [source, build.outputs[0]!.path]) {
    const config = path.join(directory, "operator-home/.config");
    const result = spawnSync(process.execPath, [entry, "--observe-retention", directory], {
      env: { PATH: process.env.PATH, HOME: path.dirname(config), XDG_CONFIG_HOME: config, TMPDIR: directory,
        NODE_ENV: "production", LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1" }, encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024,
    });
    expect(result.stderr).toBe(""); expect(result.status).toBe(0);
    expect(validRetentionScan(JSON.parse(result.stdout))).toBeTrue();
    expect(fs.existsSync(config)).toBeFalse();
  }
}, 30_000);
