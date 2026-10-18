import { afterEach, expect, test, spyOn } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { RetentionWorker } from "./retentionWorker";
import { retentionProcessScan, retentionBytes } from "./retentionInspection";

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
  expect(() => retentionProcessScan(directory, directory)).toThrow();
});

test.skipIf(process.platform !== "linux")("a complete proc fixture retains physical aliases, argv, environment and mapped paths", () => {
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
  const scan = retentionProcessScan(release, proc);
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
