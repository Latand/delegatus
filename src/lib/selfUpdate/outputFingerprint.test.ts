import { afterEach, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { outputFingerprint } from "./outputFingerprint";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), "output-inventory-")); roots.push(root);
  fs.mkdirSync(join(root, "node_modules/sub"), { recursive: true });
  fs.writeFileSync(join(root, "node_modules/a"), "first");
  fs.writeFileSync(join(root, "node_modules/sub/z"), "last");
  fs.symlinkSync("../missing", join(root, "node_modules/sub/link"));
  fs.symlinkSync(".", join(root, "node_modules/cycle"));
  return root;
}

// The original receipt format, independent of the worker's implementation.
async function legacyFingerprint(dir: string, output: string) {
  const hash = createHash("sha256"), pending = [output.replace(/\/$/, "")];
  let visited = 0;
  while (pending.length) {
    if (++visited > 250_000) throw new Error("limit");
    const entry = pending.pop()!, file = join(dir, entry), stat = await fs.promises.lstat(file, { bigint: true });
    hash.update(JSON.stringify([entry, String(stat.dev), String(stat.ino), String(stat.mode)]));
    if (stat.isDirectory()) {
      for (const name of (await fs.promises.readdir(file)).sort().reverse()) pending.push(`${entry}/${name}`);
    } else if (stat.isFile() || stat.isSymbolicLink()) {
      hash.update(JSON.stringify([String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs),
        stat.isSymbolicLink() ? await fs.promises.readlink(file) : null]));
    } else throw new Error("unsupported");
  }
  return hash.digest("hex");
}

function worker(transform: (source: string) => string, observe?: (child: ChildProcess) => void) {
  return ((command: string, args: string[], options: SpawnOptions) => {
    expect(command).toBe(process.execPath);
    expect(Object.keys(options.env!)).toEqual([]);
    expect(args.slice(0, 3)).toEqual(["--no-env-file", "--no-install", "--eval"]);
    const argv = [...args]; argv[3] = transform(argv[3]!);
    const child = spawn(command, argv, options); observe?.(child); return child;
  }) as typeof spawn;
}

test("matches the original ordered digest with dangling and cyclic symlinks and ignores release configuration", async () => {
  const root = fixture();
  fs.writeFileSync(join(root, ".env"), "BUN_OPTIONS=--preload ./missing-preload.ts\n");
  fs.writeFileSync(join(root, "bunfig.toml"), 'preload = ["./unexpected.ts"]\n');
  fs.writeFileSync(join(root, "unexpected.ts"), 'throw new Error("Release configuration was loaded");');
  expect(await outputFingerprint(root, "node_modules/", undefined, worker(source => source))).toBe(await legacyFingerprint(root, "node_modules/"));
  expect(await outputFingerprint(root, "node_modules/a")).toBe(await legacyFingerprint(root, "node_modules/a"));
});

for (const variant of ["add", "remove", "replace", "write", "symlink"]) {
  test(`changes the digest after ${variant}`, async () => {
    const root = fixture(), before = await outputFingerprint(root, "node_modules/");
    if (variant === "add") fs.writeFileSync(join(root, "node_modules/new"), "new");
    if (variant === "remove") fs.unlinkSync(join(root, "node_modules/a"));
    if (variant === "replace") { fs.renameSync(join(root, "node_modules/a"), join(root, "old")); fs.writeFileSync(join(root, "node_modules/a"), "first"); }
    if (variant === "write") fs.writeFileSync(join(root, "node_modules/a"), "changed");
    if (variant === "symlink") { fs.unlinkSync(join(root, "node_modules/sub/link")); fs.symlinkSync("elsewhere", join(root, "node_modules/sub/link")); }
    expect(await outputFingerprint(root, "node_modules/")).toBe(await legacyFingerprint(root, "node_modules/"));
    expect(await outputFingerprint(root, "node_modules/")).not.toBe(before);
  });
}

test("refuses changes to an already visited entry during the walk", async () => {
  const root = fixture();
  const mutate = worker(source => source.replace('const first = walk(), second = walk();', `
    const first = walk(); fs.writeFileSync(join(directory, "node_modules/a"), "changed"); const second = walk();`));
  await expect(outputFingerprint(root, "node_modules/", undefined, mutate)).rejects.toThrow("inventory failed");
});

test("refuses a transient addition even when both receipt digests would agree", async () => {
  const root = fixture();
  const mutate = worker(source => source.replace('const first = walk(), second = walk();', `
    const first = walk(); fs.writeFileSync(join(directory, "node_modules/new"), "new");
    fs.unlinkSync(join(directory, "node_modules/new")); const second = walk();`));
  await expect(outputFingerprint(root, "node_modules/", undefined, mutate)).rejects.toThrow("inventory failed");
});

test.skipIf(process.platform === "win32")("refuses an unsupported FIFO without opening it", async () => {
  const root = fixture();
  expect(spawnSync("mkfifo", [join(root, "node_modules/fifo")]).status).toBe(0);
  await expect(outputFingerprint(root, "node_modules/")).rejects.toThrow("inventory failed");
});

for (const source of ['process.exit(7)', String.raw`process.stdout.write("a".repeat(64)+"\n"); process.exit(7)`, 'process.kill(process.pid, "SIGKILL")', 'process.stdout.write("invalid")', 'process.stdout.write("a".repeat(1000)); setInterval(() => {}, 1000)']) {
  test(`refuses child failure: ${source.slice(0, 22)}`, async () => {
    await expect(outputFingerprint(fixture(), "node_modules/", undefined, worker(() => source))).rejects.toThrow();
  });
}

test("refuses spawn failure", async () => {
  const missing = ((_: string, args: string[], options: SpawnOptions) => spawn("/missing-inventory-runtime", args, options)) as typeof spawn;
  await expect(outputFingerprint(fixture(), "node_modules/", undefined, missing)).rejects.toThrow();
});

test("refuses a missing output", async () => {
  await expect(outputFingerprint(fixture(), "missing/")).rejects.toThrow("inventory failed");
});

test("an already aborted signal starts no child", async () => {
  const controller = new AbortController(); controller.abort();
  let spawned = false;
  expect(() => outputFingerprint(fixture(), "node_modules/", controller.signal, worker(s => { spawned = true; return s; }))).toThrow();
  expect(spawned).toBe(false);
});

test("an abort during child setup also waits for its exit", async () => {
  const controller = new AbortController(); let child: ChildProcess | undefined;
  const start = worker(() => 'setInterval(() => {}, 1000)', c => { child = c; controller.abort(); });
  await expect(outputFingerprint(fixture(), "node_modules/", controller.signal, start)).rejects.toThrow("cancelled");
  expect(child!.signalCode).toBe("SIGKILL");
  expect(() => process.kill(child!.pid!, 0)).toThrow();
});

test("cancellation during a real walk rejects after the child exits, then permits reopening", async () => {
  const root = fixture(), controller = new AbortController();
  let child: ChildProcess | undefined;
  const start = worker(source => source.replace('const stat = fs.lstatSync(file, { bigint: true });', `
    const stat = fs.lstatSync(file, { bigint: true });
    if (visited === 2) { process.stderr.write("walking"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); }`), c => {
    child = c; c.stderr!.once("data", () => controller.abort());
  });
  await expect(outputFingerprint(root, "node_modules/", controller.signal, start)).rejects.toThrow("cancelled");
  expect(controller.signal.aborted).toBe(true);
  expect(child!.signalCode).toBe("SIGKILL");
  expect(() => process.kill(child!.pid!, 0)).toThrow();
  expect(await outputFingerprint(root, "node_modules/")).toBe(await legacyFingerprint(root, "node_modules/"));
});

test("the deadline kills a stalled worker and waits for close", async () => {
  const root = fixture(); let child: ChildProcess | undefined;
  let ready = false;
  const done = outputFingerprint(root, "node_modules/", undefined, worker(() => 'process.stderr.write("ready"); setInterval(() => {}, 1000)', c => {
    child = c; c.stderr!.once("data", () => { ready = true; });
  }), 1_000);
  await expect(done).rejects.toThrow("timed out");
  expect(ready).toBe(true);
  expect(child!.signalCode).toBe("SIGKILL");
  expect(() => process.kill(child!.pid!, 0)).toThrow();
});

test("accepts exactly 250000 entries and refuses one more in a fresh worker", async () => {
  const root = fs.mkdtempSync(join(tmpdir(), "inventory-limit-")); roots.push(root);
  const output = join(root, "node_modules"); fs.mkdirSync(output);
  // Keep per-inode link counts small across supported filesystems.
  for (let bucket = 0; bucket < 250; bucket++) {
    const directory = join(output, String(bucket)); fs.mkdirSync(directory);
    const seed = join(directory, "seed"); fs.writeFileSync(seed, "");
    const count = bucket === 0 ? 998 : 999;
    for (let i = 1; i < count; i++) fs.linkSync(seed, join(directory, String(i)));
  }
  expect(await outputFingerprint(root, "node_modules/")).toBe(await legacyFingerprint(root, "node_modules/"));
  fs.writeFileSync(join(output, "extra"), "");
  await expect(outputFingerprint(root, "node_modules/")).rejects.toThrow("inventory failed");
}, 120_000);
