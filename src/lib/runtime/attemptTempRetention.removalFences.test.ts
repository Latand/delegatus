import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, spyOn, test } from "bun:test";
import { statePath } from "@/lib/configDir";
import { loadPipelines, savePipelines } from "@/lib/pipelines/store";
import { attemptTempJournalPath } from "@/lib/tempSweep";
import { attemptTempAuthority } from "./attemptTempProduction";
import { AttemptTempStore, sweepAttemptTemps } from "./attemptTempRetention";
import { finishedLane } from "./attemptTempRetention.testSupport";

const NOW = Date.parse("2030-01-20T00:00:00Z");
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const restore of cleanup.splice(0).reverse()) await restore();
});

function fixture() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "llv-removal-fence-"));
  cleanup.push(() => {
    const writable = (directory: string) => {
      fs.chmodSync(directory, 0o700);
      for (const entry of fs.readdirSync(directory, { withFileTypes: true }))
        if (entry.isDirectory()) writable(path.join(directory, entry.name));
    };
    writable(parent);
    fs.rmSync(parent, { recursive: true, force: true });
  });
  const directory = path.join(parent, "llv-stage-expired"), cache = path.join(directory, "cache");
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, "payload"), "retained cache");
  fs.chmodSync(cache, 0o555);
  const prior = loadPipelines();
  const lane = finishedLane(parent, "2029-12-01T00:00:00Z");
  expect(prior.some(row => row.id === lane.id)).toBeFalse();
  // A refusal deliberately retains this fixture's claim and journal. Clear
  // its private claim only during cleanup, before restoring persisted rows.
  cleanup.push(() => {
    fs.rmSync(statePath("attempt-retirements", createHash("sha256").update(lane.id).digest("hex") + ".json"), { force: true });
    savePipelines(prior);
  });
  savePipelines([...prior, lane]);
  const store = new AttemptTempStore(path.join(parent, "owners.sqlite"));
  cleanup.push(() => store.close());
  store.register({ directory, pipelineId: lane.id, launchId: "fixture", retainUntilClose: true, createdAt: 1 });
  const previousPath = process.env.PATH, bin = path.join(parent, "bin");
  fs.mkdirSync(bin);
  for (const command of ["find", "du"]) fs.symlinkSync(`/usr/bin/${command}`, path.join(bin, command));
  cleanup.push(() => { process.env.PATH = previousPath; });
  process.env.PATH = bin;
  const authority: typeof attemptTempAuthority = (owner, inventory) => attemptTempAuthority(owner, inventory, () => NOW);
  const sweep = (scan = () => ({ ownNamespace: null, processes: [] as Array<{ pid: number; namespace: null; stamped: boolean; paths: string[] }> })) =>
    sweepAttemptTemps(store, { now: () => NOW, maxRoots: 1, authority,
      state: async (owner, inventory) => (await authority(owner, inventory)).state, scan });
  const journal = () => JSON.parse(fs.readFileSync(attemptTempJournalPath(directory), "utf8")) as { trash: string };
  return { parent, directory, cache, store, sweep, journal };
}

test.skipIf(process.platform !== "linux").each(["keep", "swap"] as const)(
  "native removal revalidates eligibility after its final mount read (%s)", async mutation => {
    const f = fixture(), replacement = path.join(f.parent, "replacement"), moved = path.join(f.parent, "moved-admitted");
    fs.mkdirSync(replacement);
    fs.writeFileSync(path.join(replacement, "payload"), "protected replacement");
    fs.writeFileSync(path.join(replacement, ".delegatus-keep"), "permanent pin");
    const originalIdentity = fs.statSync(f.directory).ino, replacementIdentity = fs.statSync(replacement).ino;
    const nativeRead = fs.readFileSync.bind(fs);
    let injected = false, trash = "";
    const read = spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, options?: unknown) => {
      const value = nativeRead(file, options as BufferEncoding);
      if (file === "/proc/self/mountinfo") {
        const stack = String(new Error().stack);
        if (!injected && stack.includes("at removeAttemptTree") && !stack.includes("at repairAttemptPermissions")) {
          trash = JSON.parse(nativeRead(attemptTempJournalPath(f.directory), "utf8")).trash;
          if (mutation === "keep") fs.writeFileSync(path.join(trash, "cache/.delegatus-keep"), "late pin");
          else { fs.renameSync(trash, moved); fs.renameSync(replacement, trash); }
          injected = true;
        }
      }
      return value;
    }) as typeof fs.readFileSync);
    cleanup.push(() => { read.mockRestore(); });
    const report = await f.sweep();
    expect(injected).toBeTrue();
    expect(report).toMatchObject({ removed: 0, errors: 0 });
    expect(report.outcomes[0].disposition).not.toBe("removed");
    expect(f.store.has(f.directory)).toBeTrue();
    expect(f.journal().trash).toBe(trash);
    const admitted = mutation === "swap" ? moved : trash;
    expect(fs.statSync(admitted).ino).toBe(originalIdentity);
    expect(fs.readFileSync(path.join(admitted, "cache/payload"), "utf8")).toBe("retained cache");
    if (mutation === "keep") expect(fs.readFileSync(path.join(trash, "cache/.delegatus-keep"), "utf8")).toBe("late pin");
    else {
      expect(fs.statSync(trash).ino).toBe(replacementIdentity);
      expect(fs.readFileSync(path.join(trash, "payload"), "utf8")).toBe("protected replacement");
      expect(fs.readFileSync(path.join(trash, ".delegatus-keep"), "utf8")).toBe("permanent pin");
    }
  });

test.skipIf(process.platform !== "linux").each(["mountinfo", "fdinfo", "protection", "protection-refresh", "protection-refresh-keep"] as const)(
  "a dependency or keep marker at the last permission observation holds mode and custody (%s)", async observation => {
    const f = fixture(), consumer = path.join(f.parent, "consumer");
    fs.mkdirSync(path.join(consumer, ".git"), { recursive: true });
    const child = Bun.spawn([process.execPath, "-e", "process.stdout.write('ready\\n'); for await (const chunk of process.stdin) {}"],
      { cwd: consumer, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    cleanup.push(async () => { child.stdin.end(); expect(await child.exited).toBe(0); });
    const reader = child.stdout.getReader();
    try { expect(new TextDecoder().decode((await reader.read()).value)).toBe("ready\n"); }
    finally { reader.releaseLock(); }
    const nativeOpen = fs.openSync.bind(fs), nativeRead = fs.readFileSync.bind(fs), nativeStat = fs.lstatSync.bind(fs);
    let pinned: number | undefined, reads = 0, injected = false, checked = false, refreshes = 0;
    const inject = () => {
      expect(fs.statSync(path.join(f.journal().trash, "cache")).mode & 0o777).toBe(0o555);
      // The reviewer's reproduction writes from another process while the
      // final protection lstat is returning its earlier observation.
      if (observation === "protection-refresh-keep")
        execFileSync(process.execPath, ["-e", 'require("node:fs").writeFileSync(process.argv[1], "late pin")',
          path.join(f.journal().trash, ".delegatus-keep")]);
      else execFileSync(process.execPath, ["-e", 'require("node:fs").symlinkSync(process.argv[1], process.argv[2], "dir")',
        f.directory, path.join(consumer, "dependency")]);
      injected = true;
    };
    const open = spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      const fd = nativeOpen(file, flags, mode);
      if (String(file).startsWith("/proc/self/fd/") && String(file).endsWith("/cache")) pinned = fd;
      return fd;
    }) as typeof fs.openSync);
    cleanup.push(() => { open.mockRestore(); });
    const read = spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, options?: unknown) => {
      const value = nativeRead(file, options as BufferEncoding);
      if (!injected && pinned !== undefined && (observation === "mountinfo" || observation === "fdinfo")
        && file === (observation === "mountinfo" ? "/proc/self/mountinfo" : `/proc/self/fdinfo/${pinned}`)
        && ++reads === 2) inject();
      return value;
    }) as typeof fs.readFileSync);
    cleanup.push(() => { read.mockRestore(); });
    const stat = spyOn(fs, "lstatSync").mockImplementation(((file: fs.PathLike, options?: unknown) => {
      const value = nativeStat(file, options as { bigint: false });
      // The protection callback's final inode read is later than mount/fd inventory.
      const stack = String(new Error().stack);
      if (String(file) === path.join(consumer, ".git") && stack.includes("at permissionChange") && stack.includes("at unchangedAll")) checked = true;
      if (!injected && observation === "protection" && pinned !== undefined
        && String(file).endsWith("/cache") && stack.includes("at permissionChange") && !stack.includes("at current")) inject();
      if (!injected && observation === "protection-refresh" && pinned !== undefined && checked
        && String(file).endsWith("/cache") && stack.includes("at permissionChange") && stack.includes("at current")) inject();
      // The final proof reads protection and expired evidence. Mutate after
      // the last returned cache stat, so another ordering of those reads
      // cannot pass this case without a common change fence.
      if (!injected && observation === "protection-refresh-keep" && pinned !== undefined && checked
        && String(file).endsWith("/cache") && stack.includes("at permissionChange") && stack.includes("at current")
        && ++refreshes === 2) inject();
      return value;
    }) as typeof fs.lstatSync);
    cleanup.push(() => { stat.mockRestore(); });
    const report = await f.sweep(() => ({ ownNamespace: null, processes: [
      { pid: child.pid, namespace: null, stamped: false, paths: [fs.readlinkSync(`/proc/${child.pid}/cwd`)] },
    ] }));
    expect(injected).toBeTrue();
    expect(report).toMatchObject({ removed: 0, errors: 0, deferred: 1 });
    expect(f.store.has(f.directory)).toBeTrue();
    const retained = path.join(f.journal().trash, "cache");
    expect(fs.statSync(retained).mode & 0o777).toBe(0o555);
    expect(fs.readFileSync(path.join(retained, "payload"), "utf8")).toBe("retained cache");
    if (observation === "protection-refresh-keep") expect(fs.readFileSync(path.join(f.journal().trash, ".delegatus-keep"), "utf8")).toBe("late pin");
    else expect(fs.readlinkSync(path.join(consumer, "dependency"))).toBe(f.directory);
  });

test.skipIf(process.platform !== "linux")(
  "a keep marker appearing during final checkout validation preserves permissions", async () => {
    const f = fixture(), consumer = path.join(f.parent, "consumer");
    fs.mkdirSync(path.join(consumer, ".git"), { recursive: true });
    const child = Bun.spawn([process.execPath, "-e", "process.stdout.write('ready\\n'); for await (const chunk of process.stdin) {}"],
      { cwd: consumer, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    cleanup.push(async () => { child.stdin.end(); expect(await child.exited).toBe(0); });
    const reader = child.stdout.getReader();
    try { expect(new TextDecoder().decode((await reader.read()).value)).toBe("ready\n"); }
    finally { reader.releaseLock(); }
    const nativeStat = fs.lstatSync.bind(fs);
    let injected = false;
    const stat = spyOn(fs, "lstatSync").mockImplementation(((file: fs.PathLike, options?: unknown) => {
      const value = nativeStat(file, options as { bigint: false });
      const stack = String(new Error().stack);
      if (!injected && String(file) === path.join(consumer, ".git")
        && stack.includes("at permissionChange") && stack.includes("at unchangedAll")) {
        expect(fs.statSync(path.join(f.journal().trash, "cache")).mode & 0o777).toBe(0o555);
        fs.writeFileSync(path.join(f.journal().trash, ".delegatus-keep"), "late checkout pin");
        injected = true;
      }
      return value;
    }) as typeof fs.lstatSync);
    cleanup.push(() => { stat.mockRestore(); });
    const report = await f.sweep(() => ({ ownNamespace: null, processes: [
      { pid: child.pid, namespace: null, stamped: false, paths: [fs.readlinkSync(`/proc/${child.pid}/cwd`)] },
    ] }));
    expect(injected).toBeTrue();
    expect(report).toMatchObject({ removed: 0, deferred: 1, errors: 0 });
    expect(f.store.has(f.directory)).toBeTrue();
    const trash = f.journal().trash;
    expect(fs.readFileSync(path.join(trash, ".delegatus-keep"), "utf8")).toBe("late checkout pin");
    expect(fs.readFileSync(path.join(trash, "cache/payload"), "utf8")).toBe("retained cache");
    expect(fs.statSync(path.join(trash, "cache")).mode & 0o777).toBe(0o555);
  });
