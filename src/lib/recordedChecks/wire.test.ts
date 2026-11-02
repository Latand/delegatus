import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { buildManifest, verifyManifest, digest, fileDigest, retainFile, removeOwnedFile, readEnvelope, writeEnvelope, ownedFile } from "./wire";
import { recordedCheckInput } from "./input";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "recorded-wire-")); roots.push(root);
  fs.writeFileSync(path.join(root, "source.ts"), "export const value = 1;\n");
  const input = { executionEnvironment: {}, cwd: root, deadline: 1_900_000_000_000, executionMs: 1000, selection: ["first", "second"],
    configurationDigest: digest({ fixture: true }), roots: [{ directory: root, purpose: "evidence" as const }],
    inputs: [{ root, file: "source.ts" }], outputs: [{ root, file: "late.patch" }], completion: { root, file: "complete.json" } };
  return { root, input, manifest: await buildManifest(input) };
}
test("the production manifest binds exact source bytes and ordered selection before late outputs exist", async () => {
  const f = await fixture(); await verifyManifest(f.manifest);
  const destination = path.join(f.root, "manifest.json"); writeEnvelope(destination, f.manifest);
  expect(readEnvelope(destination)).toEqual(f.manifest);
  expect(f.manifest.selection).toEqual(["first", "second"]);
  fs.writeFileSync(path.join(f.root, "source.ts"), "changed\n");
  await expect(verifyManifest(f.manifest)).rejects.toThrow("source changed");
});
test("serialization preserves immutable object identity while selection order stays significant", async () => {
  const f = await fixture();
  const reversed = Object.fromEntries(Object.entries(f.manifest).reverse());
  expect(digest(reversed)).toBe(digest(f.manifest));
  expect(digest({ ...f.manifest, selection: [...f.manifest.selection].reverse() })).not.toBe(digest(f.manifest));
});
test("the final admission fence rejects source writes after an awaited verification even with restored bytes and mtime", async () => {
  const f = await fixture(), file = path.join(f.root, "source.ts");
  const unchanged = await verifyManifest(f.manifest), stat = fs.statSync(file), bytes = fs.readFileSync(file);
  unchanged();
  fs.writeFileSync(file, "changed\n"); fs.writeFileSync(file, bytes); fs.utimesSync(file, stat.atime, stat.mtime);
  expect(() => unchanged()).toThrow("source changed after verification");
});
test("root recycling, indirect parents, symlinks, hardlinks and traversal never become evidence authority", async () => {
  const f = await fixture();
  fs.renameSync(path.join(f.root, "source.ts"), path.join(f.root, "target.ts"));
  fs.symlinkSync(path.join(f.root, "target.ts"), path.join(f.root, "source.ts"));
  await expect(verifyManifest(f.manifest)).rejects.toThrow("indirect path");
  fs.unlinkSync(path.join(f.root, "source.ts"));
  fs.linkSync(path.join(f.root, "target.ts"), path.join(f.root, "source.ts"));
  expect(() => ownedFile(f.root, "source.ts")).toThrow("regular file");
  expect(() => ownedFile(f.root, "../target.ts")).toThrow();
  const alias = path.join(f.root, "alias"); fs.symlinkSync(f.root, alias);
  await expect(buildManifest({ ...f.input, roots: [{ directory: alias, purpose: "evidence" }] })).rejects.toThrow("indirect parent");
});
test("foreign roots, repeated selections and unbounded envelopes refuse before registration", async () => {
  const f = await fixture();
  await expect(verifyManifest({ ...f.manifest, outputs: [{ root: path.dirname(f.root), file: "foreign" }] })).rejects.toThrow("outside");
  await expect(buildManifest({ ...f.input, selection: ["same", "same"] })).rejects.toThrow("duplicate");
  expect(() => writeEnvelope(path.join(f.root, "large"), "a".repeat(65536))).toThrow("bound");
  fs.writeFileSync(path.join(f.root, "large"), " ".repeat(65537));
  expect(() => readEnvelope(path.join(f.root, "large"))).toThrow("envelope");
});
test("the tool admits no command, substituted owner or missing action", () => {
  for (const extra of [{ command: ["true"] }, { conversationId: "foreign" }, { deadline: 1 }])
    expect(recordedCheckInput.strict().safeParse({ action: "handoff", ticket: "local.log", ...extra }).success).toBeFalse();
  expect(recordedCheckInput.safeParse({ ticket: "local.log" }).success).toBeFalse();
  expect(recordedCheckInput.parse({ action: "read", cursor: -10 }).cursor).toBe(0);
});
test("the builder retains the realized native configuration root after launch filters its creation hint", async () => {
  const f = await fixture();
  const configuration = path.join(f.root, "llv-stage-config-fixture");
  fs.mkdirSync(path.join(configuration, "config"), { recursive: true });
  const manifest = await buildManifest({ ...f.input, executionEnvironment: { XDG_CONFIG_HOME: path.join(configuration, "config") } });
  expect(manifest.roots.filter(root => root.purpose === "configuration").map(root => root.directory)).toEqual([configuration]);
});
test("an enclosing evidence root never permits configuration bytes as an input, output or completion file", async () => {
  const f = await fixture(), configuration = path.join(f.root, "llv-stage-config-fixture");
  fs.mkdirSync(path.join(configuration, "config"), { recursive: true });
  const file = "llv-stage-config-fixture/config/settings";
  fs.writeFileSync(path.join(f.root, file), "private fixture settings\n");
  const input = { ...f.input, executionEnvironment: { XDG_CONFIG_HOME: path.join(configuration, "config") } };
  await buildManifest(input);
  for (const change of [
    { inputs: [{ root: f.root, file }] }, { outputs: [{ root: f.root, file }] }, { completion: { root: f.root, file } },
  ]) await expect(buildManifest({ ...input, ...change })).rejects.toThrow("cannot archive configuration bytes");
});
test("streamed retention copies owned bytes and leaves existing destinations intact on refusal", async () => {
  const f = await fixture(), source = path.join(f.root, "source.ts"), target = path.join(f.root, "retained");
  await retainFile(source, target, performance.now() + 5000);
  expect(await fileDigest(target)).toBe(await fileDigest(source));
  fs.writeFileSync(target, "existing evidence\n");
  await expect(retainFile(source, target, performance.now() + 5000)).rejects.toThrow();
  expect(fs.readFileSync(target, "utf8")).toBe("existing evidence\n");
  const refused = path.join(f.root, "expired");
  await expect(retainFile(source, refused, performance.now() - 1)).rejects.toThrow("deadline");
  expect(fs.existsSync(refused)).toBeFalse();
});
test("evidence hashing and retention preserve every byte across chunks and partial writes", async () => {
  const f = await fixture(), source = path.join(f.root, "source.ts"), target = path.join(f.root, "complete-copy");
  const bytes = Buffer.from(Array.from({ length: 192 * 1024 + 19 }, (_, index) => index % 251));
  fs.writeFileSync(source, bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  expect(await fileDigest(source)).toBe(sha256);
  const write = fs.write;
  const partial = spyOn(fs, "write").mockImplementation(((fd: number, buffer: Buffer, offset: number, length: number,
    position: number | null, callback: (error: NodeJS.ErrnoException | null, written: number, buffer: Buffer) => void) =>
    write(fd, buffer, offset, Math.min(length, 257), position, callback)) as typeof fs.write);
  try {
    await retainFile(source, target, performance.now() + 5000);
    expect(fs.readFileSync(target).equals(bytes)).toBeTrue();
    expect(await fileDigest(target)).toBe(sha256);
  } finally { partial.mockRestore(); }
});
for (const operation of ["digest", "retain"] as const) test(`an aborted evidence ${operation} preserves its cause and closes each owned descriptor once`, async () => {
  const f = await fixture(), source = path.join(f.root, "source.ts"), target = path.join(f.root, "aborted-copy");
  fs.writeFileSync(source, Buffer.alloc(256 * 1024, 42));
  const controller = new AbortController();
  const descriptors = new Map<number, number>();
  const open = fs.openSync, close = fs.closeSync;
  const opening = spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, ...args: unknown[]) => {
    const fd = open(file, ...args as [string]);
    if (file === source || file === target) descriptors.set(fd, 0);
    return fd;
  }) as typeof fs.openSync);
  const closing = spyOn(fs, "closeSync").mockImplementation(fd => {
    if (descriptors.has(fd)) descriptors.set(fd, descriptors.get(fd)! + 1);
    return close(fd);
  });
  const deadline = spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
  // Abort after real I/O starts, with enough remaining bytes to interrupt the
  // stream. No wall-clock race or fabricated bad descriptor is needed.
  const stream = fs.createReadStream;
  const reading = spyOn(fs, "createReadStream").mockImplementation((...args: Parameters<typeof fs.createReadStream>) => {
    const value = stream(...args);
    value.once("data", () => controller.abort());
    return value;
  });
  const read = fs.read;
  const chunk = spyOn(fs, "read").mockImplementation(((...args: Parameters<typeof fs.read>) => {
    const callback = args.at(-1) as (...args: unknown[]) => void;
    args[args.length - 1] = ((...result: unknown[]) => { controller.abort(); callback(...result); }) as never;
    return read(...args);
  }) as typeof fs.read);
  try {
    const result = await (operation === "digest" ? fileDigest(source) : retainFile(source, target, performance.now() + 5000))
      .then(() => null, error => error as NodeJS.ErrnoException);
    expect(result?.name, result?.stack).toBe("AbortError");
    expect(result?.code).not.toBe("EBADF");
    expect(descriptors.size).toBe(operation === "digest" ? 1 : 2);
    expect([...descriptors.values()]).toEqual([...descriptors.keys()].map(() => 1));
    expect(fs.existsSync(target)).toBeFalse();
    expect(fs.readFileSync(source).length).toBe(256 * 1024);
  } finally { chunk.mockRestore(); reading.mockRestore(); deadline.mockRestore(); opening.mockRestore(); closing.mockRestore(); }
});
test("failed metadata publication removes only its own temporary file", async () => {
  const f = await fixture(), target = path.join(f.root, "destination");
  fs.mkdirSync(target); fs.writeFileSync(path.join(target, "existing"), "keep\n");
  const before = fs.readdirSync(f.root).sort();
  expect(() => writeEnvelope(target, { state: "fixture" })).toThrow();
  expect(fs.readdirSync(f.root).sort()).toEqual(before);
  expect(fs.readFileSync(path.join(target, "existing"), "utf8")).toBe("keep\n");
});
test("copy cleanup refuses a replaced destination even when its path is reused", async () => {
  const f = await fixture(), target = path.join(f.root, "owned-copy");
  const stamp = await retainFile(path.join(f.root, "source.ts"), target, performance.now() + 5000);
  fs.renameSync(target, `${target}.held`); fs.writeFileSync(target, "foreign replacement\n");
  removeOwnedFile(target, stamp);
  expect(fs.readFileSync(target, "utf8")).toBe("foreign replacement\n");
  const owned = path.join(f.root, "second-copy");
  const current = await retainFile(path.join(f.root, "source.ts"), owned, performance.now() + 5000);
  removeOwnedFile(owned, current); expect(fs.existsSync(owned)).toBeFalse();
});
test.skipIf(process.platform !== "linux")("an atomic receipt replacement after open reads the current inode once and still rejects hardlinks", async () => {
  const f = await fixture(), file = path.join(f.root, "receipt");
  writeEnvelope(file, { revision: 1 });
  const stat = fs.fstatSync;
  let changed = false;
  const probe = spyOn(fs, "fstatSync").mockImplementation(((fd: number, options?: fs.StatOptions) => {
    if (!changed && fs.readlinkSync(`/proc/self/fd/${fd}`) === file) {
      changed = true; writeEnvelope(file, { revision: 2 });
    }
    return stat(fd, options);
  }) as typeof fs.fstatSync);
  try { expect(readEnvelope(file)).toEqual({ revision: 2 }); expect(changed).toBeTrue(); }
  finally { probe.mockRestore(); }
  fs.linkSync(file, path.join(f.root, "linked-receipt"));
  expect(() => readEnvelope(file)).toThrow("invalid recorded check envelope");
});
test.skipIf(process.platform !== "linux")("a hostile FIFO receipt refuses before a blocking open can stall its reader", async () => {
  const f = await fixture(), file = path.join(f.root, "pipe");
  expect(spawnSync("mkfifo", [file]).status).toBe(0);
  const source = `import { readEnvelope } from ${JSON.stringify(path.join(import.meta.dir, "wire.ts"))}; readEnvelope(process.argv[1]);`;
  const child = spawnSync(process.execPath, ["-e", source, file], { env: process.env, encoding: "utf8", timeout: 3000 });
  expect(child.error).toBeUndefined();
  expect(child.signal).toBeNull();
  expect(child.status).toBe(1);
  expect(child.stderr).toContain("invalid recorded check envelope");
});

test("separately built native fence modules share one reentrant operation context", async () => {
  const f = await fixture();
  const source = `
    const entry = ${JSON.stringify(path.resolve("src/lib/recordedChecks/hostFence.ts"))};
    const modules = [];
    for (const name of ["first", "second"]) {
      const build = await Bun.build({entrypoints:[entry],outdir:process.argv[1]+"/"+name,target:"bun"});
      if (!build.success) throw new Error("fixture fence build failed");
      modules.push(await import(build.outputs[0].path));
    }
    if (modules[0].withRecordedHostFence === modules[1].withRecordedHostFence) throw new Error("fixture did not create separate modules");
    const owner = {pid:process.pid,startIdentity:"fixture-start",bootEpoch:"fixture-boot"};
    await modules[0].withRecordedHostFence(owner, () => modules[1].withRecordedHostFence(owner, async () => console.log("fenced once")));
  `;
  const child = spawnSync(process.execPath, ["-e", source, f.root], { env: process.env, encoding: "utf8", timeout: 10_000 });
  expect(child.error).toBeUndefined();
  expect(child.signal).toBeNull();
  expect(child.status, child.stderr).toBe(0);
  expect(child.stdout.trim()).toBe("fenced once");
}, 20_000);
