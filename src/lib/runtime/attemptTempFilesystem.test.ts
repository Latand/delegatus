import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { statePath } from "@/lib/configDir";
import { execFile } from "node:child_process";
import { afterEach, expect, spyOn, test } from "bun:test";
import { attemptReferencesClear, inspectAttemptTree, attemptTempUtilityImage, removeAttemptTree, repositoryReferencesAttemptTemp, RepositoryLinkInventory,
  RETAINED_CHECKOUT_READ_MAX_AGE_MS, type RetainedCheckoutReads } from "./attemptTempFilesystem";
import { AttemptTempStore, sweepAttemptTemps } from "./attemptTempRetention";
const exec = promisify(execFile);
const roots: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const root = () => { const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-stage-filesystem-")); roots.push(directory); return directory; };

test.skipIf(process.platform !== "linux")("a bound Unix socket keeps its attempt root", async () => {
  const parent = root(), directory = path.join(parent, "actual/llv-stage-holder");
  fs.mkdirSync(directory, { recursive: true });
  const aliasParent = path.join(parent, "alias"); fs.symlinkSync(path.dirname(directory), aliasParent, "dir");
  const alias = path.join(aliasParent, path.basename(directory));
  const fd = fs.openSync(directory, "r");
  const socket = `/proc/self/fd/${fd}/held.sock`;
  const server = net.createServer();
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
    expect(await attemptReferencesClear(directory, directory, { ownNamespace: null, processes: [] })).toBeFalse();
    expect(await attemptReferencesClear(alias, alias, { ownNamespace: null, processes: [] })).toBeFalse();
  } finally {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    fs.closeSync(fd);
  }
});

test.skipIf(process.platform !== "linux")("registered inspection streams beyond the legacy entry ceiling", async () => {
  // Empty fixtures keep allocation small while exercising an actual tree
  // larger than the old 200,000-entry inspection ceiling. The fixture is made
  // and removed by native tools inside this test's own budget; a synchronous
  // removal in the shared hook outlived the hook timeout on loaded hosts.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-stage-filesystem-"));
  try {
    for (let group = 0; group < 21; group++) {
      await exec("sh", ["-c", 'mkdir "$1" && cd "$1" && seq 0 9999 | xargs touch', "sh", path.join(directory, String(group))], { timeout: 60_000 });
    }
    expect(await inspectAttemptTree(directory)).toBeTrue();
  } finally {
    await exec("rm", ["-rf", "--", directory], { timeout: 60_000 });
  }
}, 150_000);

function repositoryProcesses(parent: string, count: number) {
  return Array.from({ length: count }, (_, n) => {
    const repository = path.join(parent, `repository-${n}`), cwd = path.join(repository, "work");
    fs.mkdirSync(path.join(repository, ".git"), { recursive: true }); fs.mkdirSync(cwd);
    return { pid: 10_000 + n, namespace: null, stamped: false, paths: [cwd] };
  });
}

test("a settled root retires beside more than 32 unrelated checkouts; a linking checkout still holds it", async () => {
  const parent = root(), directory = path.join(parent, "llv-stage-busy-machine"); fs.mkdirSync(directory);
  const processes = repositoryProcesses(parent, 40);
  const scan = () => ({ ownNamespace: null, processes });
  expect(await attemptReferencesClear(directory, directory, scan(), async () => true)).toBeTrue();
  fs.mkdirSync(path.join(parent, "repository-39/nested"));
  fs.symlinkSync(path.join(directory, "packages"), path.join(parent, "repository-39/nested/node_modules"), "dir");
  expect(await attemptReferencesClear(directory, directory, scan(), async () => true)).toBeFalse();
});

test("a missing process cwd cannot become a cached no-checkout result", async () => {
  const parent = root(), directory = path.join(parent, "llv-stage-unproven-cwd"); fs.mkdirSync(directory);
  const repository = path.join(parent, "checkout"), cwd = path.join(repository, "work");
  fs.mkdirSync(path.join(repository, ".git"), { recursive: true }); fs.mkdirSync(cwd);
  const inventory = new RepositoryLinkInventory();
  const scan = { ownNamespace: null, processes: [{ pid: 41, namespace: null, stamped: false, paths: [cwd] }] };
  fs.rmSync(cwd, { recursive: true });
  await expect(attemptReferencesClear(directory, directory, scan, async () => true, inventory)).rejects.toThrow();
  expect(inventory.walks).toHaveLength(0);
});

test("an unreadable process cwd cannot become a cached no-checkout result", async () => {
  const parent = root(), directory = path.join(parent, "llv-stage-unreadable-cwd"); fs.mkdirSync(directory);
  const repository = path.join(parent, "checkout"), cwd = path.join(repository, "work");
  fs.mkdirSync(path.join(repository, ".git"), { recursive: true }); fs.mkdirSync(cwd);
  const inventory = new RepositoryLinkInventory();
  const scan = { ownNamespace: null, processes: [{ pid: 42, namespace: null, stamped: false, paths: [cwd] }] };
  fs.chmodSync(repository, 0);
  try {
    await expect(attemptReferencesClear(directory, directory, scan, async () => true, inventory)).rejects.toMatchObject({ code: "EACCES" });
    expect(inventory.walks).toHaveLength(0);
  } finally { fs.chmodSync(repository, 0o700); }
});

test.each(["absent", "unreadable", "restored"] as const)("the final removal check observes a checkout changed during container observation (%s)", async change => {
  const parent = root(), directory = path.join(parent, "llv-stage-final-boundary");
  fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, "payload"), "keep");
  const repository = path.join(parent, "checkout"), cwd = path.join(repository, "work");
  fs.mkdirSync(path.join(repository, ".git"), { recursive: true }); fs.mkdirSync(cwd);
  const store = new AttemptTempStore(path.join(parent, "owners.sqlite"));
  store.register({ directory, pipelineId: "closed-lane", launchId: "fixture", retainUntilClose: false, createdAt: 1 });
  store.measure(directory, 4096); store.release(directory);
  const inventory = new RepositoryLinkInventory();
  let changed = false;
  let containerObservations = 0;
  const oldRepository = `${repository}-old`;
  const directoryReads = fs.promises as unknown as {
    readdir: (target: fs.PathLike, options: { withFileTypes: true }) => Promise<fs.Dirent[]>;
  };
  const readdir = directoryReads.readdir.bind(directoryReads);
  const denied = change === "unreadable" ? spyOn(directoryReads, "readdir").mockImplementation(async (target, options) => {
    if (changed && path.resolve(String(target)) === repository) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    return readdir(target, options);
  }) : undefined;
  const mutate = () => {
    changed = true;
    if (change === "absent") fs.renameSync(repository, oldRepository);
    if (change === "unreadable") fs.chmodSync(repository, 0);
    if (change === "restored") {
      fs.renameSync(repository, oldRepository);
      fs.mkdirSync(path.join(repository, ".git"), { recursive: true });
      fs.mkdirSync(path.join(repository, "work"));
      fs.symlinkSync(directory, path.join(repository, "dependency"), "dir");
    }
  };
  const references = (original: string, current: string, scan: Parameters<typeof attemptReferencesClear>[2]) =>
    attemptReferencesClear(original, current, scan, async () => {
      containerObservations++;
      if (containerObservations === 3) mutate();
      return true;
    }, inventory);
  let now = 2;
  const sweep = (processes: Array<{ pid: number; namespace: null; stamped: boolean; paths: string[] }>) => sweepAttemptTemps(store, { now: () => now, maxRoots: 1, capBytes: 0,
    state: async () => {
      try {
        const before = fs.lstatSync(repository);
        if (!before.isDirectory() || before.isSymbolicLink()) return "unknown";
        await repositoryReferencesAttemptTemp(repository, directory, directory, inventory);
        const after = fs.lstatSync(repository);
        return after.isDirectory() && !after.isSymbolicLink() && `${before.dev}:${before.ino}` === `${after.dev}:${after.ino}`
          ? "closed" : "unknown";
      } catch { return "unknown"; }
    }, references, scan: () => ({ ownNamespace: null, processes }) });
  const processes = [{ pid: 42, namespace: null, stamped: false, paths: [cwd] }];
  try {
    const result = await sweep(processes);
    expect(changed).toBeTrue();
    expect(containerObservations).toBeGreaterThanOrEqual(3);
    expect(result.removed).toBe(0);
    expect(fs.readFileSync(path.join(directory, "payload"), "utf8")).toBe("keep");
    if (change === "absent") fs.renameSync(oldRepository, repository);
    if (change === "unreadable") { fs.chmodSync(repository, 0o700); changed = false; }
    if (change === "restored") fs.unlinkSync(path.join(repository, "dependency"));
    now += 60_001;
    expect((await sweep([])).removed).toBe(1);
    expect(fs.existsSync(directory)).toBeFalse();
  } finally { denied?.mockRestore(); fs.chmodSync(change === "unreadable" ? repository : parent, 0o700); store.close(); }
});

test.each([
  ["namespace-only", "control"], ["namespace-only", "activate"], ["namespace-only", "checkout-disappears"], ["namespace-only", "reopen-absent"],
  ["permission-fallback", "control"], ["permission-fallback", "activate"], ["permission-fallback", "checkout-disappears"], ["permission-fallback", "reopen-absent"],
] as const)("namespace dispatch validates its final snapshot (%s, %s)", async (removalPath, change) => {
  const parent = root(), directory = path.join(parent, "llv-stage-namespace-dispatch"), bin = path.join(parent, "bin");
  fs.mkdirSync(directory); fs.mkdirSync(bin);
  const payload = path.join(directory, "payload"), dispatched = path.join(parent, "dispatched");
  fs.writeFileSync(payload, "keep");
  const docker = path.join(bin, "docker");
  fs.writeFileSync(docker, `#!/bin/sh
case "$1" in
  ps) exit 0 ;;
  run)
    for arg do
      case "$arg" in type=bind,source=*,target=/attempt) source=\${arg#type=bind,source=}; source=\${source%,target=/attempt} ;; esac
    done
    test -n "$source" || exit 2
    printf started > "$DOCKER_DISPATCH_MARKER"
    find "$source" -depth -mindepth 1 -delete
    ;;
  *) exit 2 ;;
esac
`);
  fs.chmodSync(docker, 0o700);
  const previousPath = process.env.PATH, previousImage = process.env.LLV_ATTEMPT_TEMP_CLEANUP_IMAGE;
  const previousMarker = process.env.DOCKER_DISPATCH_MARKER;
  process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
  process.env.LLV_ATTEMPT_TEMP_CLEANUP_IMAGE = "fixture-image";
  process.env.DOCKER_DISPATCH_MARKER = dispatched;
  const rm = spyOn(fs.promises, "rm").mockImplementation(async () => {
    if (removalPath === "permission-fallback") throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    return undefined;
  });
  let producerState = "closed", checkoutReadable = true;
  const guard = async () => {
    await Promise.resolve();
    if (change === "activate") producerState = "live";
    if (change === "checkout-disappears") checkoutReadable = false;
    if (change === "reopen-absent") producerState = "unknown";
    return true;
  };
  const dispatchGuard = () => producerState === "closed" && checkoutReadable;
  try {
    let error: unknown;
    try { await removeAttemptTree(directory, directory, guard, removalPath === "namespace-only", dispatchGuard); }
    catch (caught) { error = caught; }
    if (change === "control") {
      expect(error).toBeUndefined();
      expect(fs.existsSync(dispatched)).toBeTrue();
      expect(fs.existsSync(directory)).toBeFalse();
    } else {
      expect(String(error)).toContain("authority changed before namespace removal");
      expect(fs.existsSync(dispatched)).toBeFalse();
      expect(fs.readFileSync(payload, "utf8")).toBe("keep");
    }
  } finally {
    rm.mockRestore();
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousImage === undefined) delete process.env.LLV_ATTEMPT_TEMP_CLEANUP_IMAGE;
    else process.env.LLV_ATTEMPT_TEMP_CLEANUP_IMAGE = previousImage;
    if (previousMarker === undefined) delete process.env.DOCKER_DISPATCH_MARKER;
    else process.env.DOCKER_DISPATCH_MARKER = previousMarker;
  }
});

test.each([
  ["namespace-only", "control"], ["namespace-only", "producer-changed"], ["namespace-only", "checkout-unreadable"], ["namespace-only", "root-replaced"],
  ["permission-fallback", "control"], ["permission-fallback", "producer-changed"], ["permission-fallback", "checkout-unreadable"], ["permission-fallback", "root-replaced"],
] as const)("final namespace rmdir revalidates authority and root identity (%s, %s)", async (pathKind, change) => {
  const parent = root(), directory = path.join(parent, "llv-stage-final-rmdir"), bin = path.join(parent, "bin");
  fs.mkdirSync(directory); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(directory, "payload"), "keep");
  const originalIdentity = fs.lstatSync(directory), identity = `${originalIdentity.dev}:${originalIdentity.ino}`;
  const docker = path.join(bin, "docker"), completion = path.join(parent, "docker-complete");
  fs.writeFileSync(docker, `#!/bin/sh
case "$1" in
  ps) exit 0 ;;
  run)
    for arg do
      case "$arg" in type=bind,source=*,target=/attempt) source=\${arg#type=bind,source=}; source=\${source%,target=/attempt} ;; esac
    done
    test -n "$source" || exit 2
    find "$source" -depth -mindepth 1 -delete || exit
    if test "$FINAL_RMDIR_CHANGE" = root-replaced; then mv "$source" "$source-original"; mkdir "$source"; printf replacement > "$source/payload"; fi
    printf done > "$FINAL_RMDIR_COMPLETE"
    ;;
  *) exit 2 ;;
esac
`);
  fs.chmodSync(docker, 0o700);
  const previous = { PATH: process.env.PATH, image: process.env.LLV_ATTEMPT_TEMP_CLEANUP_IMAGE,
    change: process.env.FINAL_RMDIR_CHANGE, complete: process.env.FINAL_RMDIR_COMPLETE };
  process.env.PATH = `${bin}${path.delimiter}${previous.PATH ?? ""}`;
  process.env.LLV_ATTEMPT_TEMP_CLEANUP_IMAGE = "fixture-image";
  process.env.FINAL_RMDIR_CHANGE = change;
  process.env.FINAL_RMDIR_COMPLETE = completion;
  const rm = spyOn(fs.promises, "rm").mockImplementation(async () => {
    if (pathKind === "permission-fallback") throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    return undefined;
  });
  const dispatchGuard = () => !fs.existsSync(completion) || change !== "producer-changed" && change !== "checkout-unreadable";
  try {
    let error: unknown;
    try { await removeAttemptTree(directory, directory, async () => true, pathKind === "namespace-only", dispatchGuard); }
    catch (caught) { error = caught; }
    if (change === "control") {
      expect(error).toBeUndefined();
      expect(fs.existsSync(directory)).toBeFalse();
    } else {
      expect(fs.existsSync(completion)).toBeTrue();
      expect(String(error)).toMatch(change === "root-replaced" ? /identity changed before namespace rmdir/ : /authority changed before namespace rmdir/);
      if (change === "root-replaced") {
        const replacement = fs.lstatSync(directory);
        expect(`${replacement.dev}:${replacement.ino}`).not.toBe(identity);
        expect(fs.readFileSync(path.join(directory, "payload"), "utf8")).toBe("replacement");
      } else {
        expect(`${fs.lstatSync(directory).dev}:${fs.lstatSync(directory).ino}`).toBe(identity);
        expect(fs.readdirSync(directory)).toEqual([]);
      }
    }
  } finally {
    rm.mockRestore();
    if (previous.PATH === undefined) delete process.env.PATH; else process.env.PATH = previous.PATH;
    if (previous.image === undefined) delete process.env.LLV_ATTEMPT_TEMP_CLEANUP_IMAGE; else process.env.LLV_ATTEMPT_TEMP_CLEANUP_IMAGE = previous.image;
    if (previous.change === undefined) delete process.env.FINAL_RMDIR_CHANGE; else process.env.FINAL_RMDIR_CHANGE = previous.change;
    if (previous.complete === undefined) delete process.env.FINAL_RMDIR_COMPLETE; else process.env.FINAL_RMDIR_COMPLETE = previous.complete;
  }
});

test("a capture created during the final container observation is preserved before reclaim", async () => {
  const parent = root(), directory = path.join(parent, "llv-stage-late-capture");
  fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, "payload"), "keep");
  const repository = path.join(parent, "checkout"); fs.mkdirSync(path.join(repository, ".git"), { recursive: true });
  const identity = fs.lstatSync(directory), identityKey = `${identity.dev}:${identity.ino}`;
  const evidenceKey = createHash("sha256").update(directory).update("\0").update(identityKey).digest("hex");
  const store = new AttemptTempStore(path.join(parent, "owners.sqlite"));
  store.register({ directory, pipelineId: "closed-lane", launchId: "late-capture", retainUntilClose: false, createdAt: 1 });
  store.measure(directory, 4096); store.release(directory);
  let stateReads = 0;
  let now = 2;
  const sweep = () => sweepAttemptTemps(store, { now: () => now, maxRoots: 1, capBytes: 0,
    state: async () => {
      stateReads++;
      if (stateReads === 3) fs.writeFileSync(path.join(directory, "frame.png"), "late frame");
      return "closed";
    }, references: async () => true, scan: () => ({ ownNamespace: null, processes: [] }) });
  try {
    const first = await sweep();
    expect(stateReads).toBeGreaterThanOrEqual(3);
    expect(first.removed).toBe(0);
    expect(fs.readFileSync(path.join(directory, "frame.png"), "utf8")).toBe("late frame");
    now += 60_001;
    expect((await sweep()).removed).toBe(1);
    const saved = path.join(statePath("evidence", "attempt-temp", evidenceKey), "files/frame.png");
    expect(fs.readFileSync(saved, "utf8")).toBe("late frame");
  } finally { store.close(); }
});

test("one tick shares checkout walks and invalidates a negative result after a late link", async () => {
  const parent = root(), first = path.join(parent, "llv-stage-first"), second = path.join(parent, "llv-stage-second");
  fs.mkdirSync(first); fs.mkdirSync(second);
  const processes = repositoryProcesses(parent, 34);
  let now = 1_000;
  const inventory = new RepositoryLinkInventory({ now: () => now, freshMs: 10_000, budgetMs: 30_000 });
  for (const directory of [first, second])
    expect(await attemptReferencesClear(directory, directory, { ownNamespace: null, processes }, async () => true, inventory)).toBeTrue();
  expect(inventory.walks.length).toBe(34);
  // Checkouts are read in name order; repository-9 is the last one.
  fs.symlinkSync(second, path.join(parent, "repository-9/work/late-link"), "dir");
  // Unchanged checkouts reuse their inventory. A nested directory change
  // invalidates just that checkout's negative result immediately.
  expect(await attemptReferencesClear(second, second, { ownNamespace: null, processes }, async () => true, inventory)).toBeFalse();
  expect(inventory.walks.length).toBe(35);
  now += 10_001;
  expect(await attemptReferencesClear(second, second, { ownNamespace: null, processes }, async () => true, inventory)).toBeFalse();
  expect(inventory.walks.length).toBe(69);
  now += 20_000;
  await expect(attemptReferencesClear(second, second, { ownNamespace: null, processes }, async () => true, inventory)).rejects.toThrow("tick budget");
});

test("a looping checkout link fails no reference check, and a link into the root beside it still holds the root", async () => {
  const parent = root(), directory = path.join(parent, "llv-stage-beside-loop"); fs.mkdirSync(directory);
  const processes = repositoryProcesses(parent, 1), work = path.join(parent, "repository-0/work");
  const clear = () => attemptReferencesClear(directory, directory, { ownNamespace: null, processes }, async () => true);
  // A link to itself, and a link whose path runs through that loop.
  fs.symlinkSync(path.join(work, "loop"), path.join(work, "loop"));
  fs.symlinkSync(path.join(work, "loop/inner"), path.join(work, "through-loop"));
  expect(await clear()).toBeTrue();
  // A loop inside the attempt root is still named by its lexical target.
  fs.symlinkSync(path.join(directory, "self"), path.join(directory, "self"));
  const intoLoop = path.join(work, "into-root-loop"); fs.symlinkSync(path.join(directory, "self"), intoLoop);
  expect(await clear()).toBeFalse();
  fs.unlinkSync(intoLoop);
  expect(await clear()).toBeTrue();
  fs.symlinkSync(directory, path.join(work, "dependency"), "dir");
  expect(await clear()).toBeFalse();
});

test("reads kept across ticks serve unchanged checkouts; a changed or aged checkout is read again", async () => {
  const parent = root(), directory = path.join(parent, "llv-stage-kept-reads"); fs.mkdirSync(directory);
  const processes = repositoryProcesses(parent, 3);
  const retained: RetainedCheckoutReads = new Map();
  let now = 1_000;
  const tick = () => new RepositoryLinkInventory({ now: () => now, retained });
  const clear = (inventory: RepositoryLinkInventory) =>
    attemptReferencesClear(directory, directory, { ownNamespace: null, processes }, async () => true, inventory);
  const first = tick();
  expect(await clear(first)).toBeTrue();
  expect(first.walks).toHaveLength(3);
  now += 60_000;
  const second = tick();
  expect(await clear(second)).toBeTrue();
  expect(second.walks).toHaveLength(0);
  const link = path.join(parent, "repository-1/work/late-link");
  fs.symlinkSync(directory, link, "dir");
  now += 60_000;
  const third = tick();
  expect(await clear(third)).toBeFalse();
  expect(third.walks).toEqual([path.join(parent, "repository-1")]);
  fs.unlinkSync(link);
  now += RETAINED_CHECKOUT_READ_MAX_AGE_MS + 1;
  const fourth = tick();
  expect(await clear(fourth)).toBeTrue();
  expect(fourth.walks).toHaveLength(3);
});

test("a reused validation never answers the fence that precedes a destructive step", async () => {
  const parent = root(), directory = path.join(parent, "llv-stage-reused-validation"); fs.mkdirSync(directory);
  const processes = repositoryProcesses(parent, 2);
  const inventory = new RepositoryLinkInventory({ validationReuseMs: 60_000 });
  const clear = () => attemptReferencesClear(directory, directory, { ownNamespace: null, processes }, async () => true, inventory);
  expect(await clear()).toBeTrue();
  expect(inventory.unchangedAll()).toBeTrue();
  fs.symlinkSync(directory, path.join(parent, "repository-1/work/late-link"), "dir");
  // Inside the reuse window an observation answers from its last validation.
  expect(await clear()).toBeTrue();
  expect(inventory.walks).toHaveLength(2);
  // The fence reads every directory again, and its refusal ends the reuse.
  expect(inventory.unchangedAll()).toBeFalse();
  expect(await clear()).toBeFalse();
  expect(inventory.walks).toHaveLength(3);
});

test("a directory changed inside the timestamp granule is listed only after the granule has passed", async () => {
  const parent = root(), repository = path.join(parent, "repository"), work = path.join(repository, "work");
  fs.mkdirSync(path.join(repository, ".git"), { recursive: true });
  const directoryReads = fs.promises as unknown as {
    readdir: (target: fs.PathLike, options: { withFileTypes: true }) => Promise<fs.Dirent[]>;
  };
  const readdir = directoryReads.readdir.bind(directoryReads);
  const listedAt: number[] = [];
  const observed = spyOn(directoryReads, "readdir").mockImplementation(async (target, options) => {
    if (String(target) === work) listedAt.push(Date.now());
    return readdir(target, options);
  });
  try {
    fs.mkdirSync(work);
    await new RepositoryLinkInventory().targets(repository);
    expect(listedAt).toHaveLength(1);
    expect(listedAt[0]! - fs.lstatSync(work).ctimeMs).toBeGreaterThanOrEqual(20);
  } finally { observed.mockRestore(); }
});

const checkoutFixture = () => {
  const parent = root(), repository = path.join(parent, "repository"), directory = path.join(parent, "llv-stage-root"), outside = path.join(parent, "outside");
  fs.mkdirSync(path.join(repository, ".git"), { recursive: true }); fs.mkdirSync(path.join(repository, "work"));
  fs.mkdirSync(path.join(directory, "sub"), { recursive: true }); fs.mkdirSync(outside);
  return { repository, directory, outside, work: path.join(repository, "work") };
};
type LstatSync = (target: fs.PathLike, options?: fs.StatSyncOptions) => fs.Stats | undefined;
/** Replaces what lstat reports for chosen paths; everything else is real. */
const reportedStats = (change: (file: string, stat: fs.Stats) => void) => {
  const real = (fs.lstatSync as LstatSync).bind(fs);
  return spyOn(fs as unknown as { lstatSync: LstatSync }, "lstatSync").mockImplementation((target, options) => {
    const stat = real(target, options);
    if (stat) change(String(target), stat);
    return stat;
  });
};

// The real unmount was checked with a mount in a private mount namespace; this
// test drives the same tracking through what lstat reports for the directory.
test("a kept read is repeated when a skipped mount point stops being one", async () => {
  const { repository, directory, work } = checkoutFixture(), mount = path.join(work, "mount");
  fs.mkdirSync(mount); fs.symlinkSync(directory, path.join(mount, "covered-link"), "dir");
  await new Promise(resolve => setTimeout(resolve, 40));
  const retained: RetainedCheckoutReads = new Map();
  const mounted = reportedStats((file, stat) => { if (file === mount) { stat.dev += 1; stat.ino += 1; } });
  try {
    const first = new RepositoryLinkInventory({ retained });
    expect(await repositoryReferencesAttemptTemp(repository, directory, directory, first)).toBeFalse();
    expect(first.unchangedAll()).toBeTrue();
    // Changes inside the mounted file system leave the kept read in use.
    const second = new RepositoryLinkInventory({ retained });
    expect(await repositoryReferencesAttemptTemp(repository, directory, directory, second)).toBeFalse();
    expect(second.walks).toHaveLength(0);
    mounted.mockRestore();
    // Unmounted: the directory below, with its link, is visible again.
    expect(first.unchangedAll()).toBeFalse();
    const third = new RepositoryLinkInventory({ retained });
    expect(await repositoryReferencesAttemptTemp(repository, directory, directory, third)).toBeTrue();
    expect(third.walks).toEqual([repository]);
  } finally { mounted.mockRestore(); }
});

test("a link chain that reaches the attempt root only through a loop or past the kernel's hop limit holds the root", async () => {
  const references = async (build: (fixture: ReturnType<typeof checkoutFixture>) => void) => {
    const fixture = checkoutFixture(); build(fixture);
    return repositoryReferencesAttemptTemp(fixture.repository, fixture.directory);
  };
  // checkout link -> outside alias of a root directory -> a loop inside it
  expect(await references(({ work, directory, outside }) => {
    fs.symlinkSync(path.join(directory, "sub"), path.join(outside, "alias"));
    fs.symlinkSync("loop", path.join(directory, "sub/loop"));
    fs.symlinkSync(path.join(outside, "alias/loop"), path.join(work, "link"));
  })).toBeTrue();
  // checkout link -> outside link -> a loop inside the root
  expect(await references(({ work, directory, outside }) => {
    fs.symlinkSync("loop", path.join(directory, "loop"));
    fs.symlinkSync(path.join(directory, "loop"), path.join(outside, "hop"));
    fs.symlinkSync(path.join(outside, "hop"), path.join(work, "link"));
  })).toBeTrue();
  // a cycle that runs through the root
  expect(await references(({ work, directory, outside }) => {
    fs.symlinkSync(path.join(directory, "back"), path.join(outside, "hop"));
    fs.symlinkSync(path.join(outside, "hop"), path.join(directory, "back"));
    fs.symlinkSync(path.join(outside, "hop"), path.join(work, "link"));
  })).toBeTrue();
  // more hops than the kernel follows, ending inside the root
  expect(await references(({ work, directory, outside }) => {
    let previous = path.join(directory, "sub");
    for (let hop = 0; hop < 45; hop++) { const link = path.join(outside, `hop-${hop}`); fs.symlinkSync(previous, link); previous = link; }
    fs.symlinkSync(previous, path.join(work, "link"));
  })).toBeTrue();
  // an outside link to a missing entry of the root
  expect(await references(({ work, directory, outside }) => {
    fs.symlinkSync(path.join(directory, "missing"), path.join(outside, "hop"));
    fs.symlinkSync(path.join(outside, "hop"), path.join(work, "link"));
  })).toBeTrue();
  // The same shapes away from the root hold nothing and fail nothing.
  expect(await references(({ work, outside }) => {
    fs.symlinkSync("loop", path.join(outside, "loop"));
    fs.symlinkSync(path.join(outside, "loop"), path.join(outside, "hop"));
    fs.symlinkSync(path.join(outside, "hop"), path.join(work, "link"));
    fs.symlinkSync(path.join(work, "self"), path.join(work, "self"));
    let previous = path.join(outside, "end");
    for (let hop = 0; hop < 45; hop++) { const link = path.join(outside, `hop-${hop}`); fs.symlinkSync(previous, link); previous = link; }
    fs.symlinkSync(previous, path.join(work, "long"));
  })).toBeFalse();
});

test("a chain with no verdict inside the hop bound holds the root", async () => {
  const { repository, directory, outside, work } = checkoutFixture();
  let previous = path.join(directory, "sub");
  for (let hop = 0; hop < 300; hop++) { const link = path.join(outside, `hop-${hop}`); fs.symlinkSync(previous, link); previous = link; }
  fs.symlinkSync(previous, path.join(work, "link"));
  await expect(repositoryReferencesAttemptTemp(repository, directory)).rejects.toThrow();
});

test("a link target is resolved with .. applied to the directory its links reach", async () => {
  const { repository, directory, outside, work } = checkoutFixture();
  fs.mkdirSync(path.join(directory, "sibling"));
  fs.symlinkSync(path.join(directory, "sub"), path.join(outside, "alias"));
  fs.mkdirSync(path.join(outside, "sibling"));
  const link = path.join(work, "link");
  fs.symlinkSync(`${outside}/alias/../sibling`, link);
  expect(await repositoryReferencesAttemptTemp(repository, directory)).toBeTrue();
  fs.unlinkSync(link); fs.symlinkSync(`${outside}/alias/../absent`, link);
  expect(await repositoryReferencesAttemptTemp(repository, directory)).toBeTrue();
  // A relative link that climbs inside the checkout and leaves it still
  // resolves to the place it names.
  fs.unlinkSync(link); fs.symlinkSync("../../llv-stage-root/sub", link);
  expect(await repositoryReferencesAttemptTemp(repository, directory)).toBeTrue();
  fs.unlinkSync(link); fs.symlinkSync("../../outside/sibling", link);
  expect(await repositoryReferencesAttemptTemp(repository, directory)).toBeFalse();
});

test("on whole-second timestamps a link made in the second of the read ends the kept read", async () => {
  // Start early in a second so that the fixture, the read and the late link
  // would all share one stored timestamp.
  while (Date.now() % 1_000 > 200) await new Promise(resolve => setTimeout(resolve, 20));
  const { repository, directory, work } = checkoutFixture();
  const wholeSeconds = reportedStats((file, stat) => {
    if (!file.startsWith(repository)) return;
    stat.mtimeMs = Math.floor(stat.mtimeMs / 1_000) * 1_000; stat.ctimeMs = Math.floor(stat.ctimeMs / 1_000) * 1_000;
  });
  try {
    const retained: RetainedCheckoutReads = new Map();
    const first = new RepositoryLinkInventory({ retained });
    expect(await repositoryReferencesAttemptTemp(repository, directory, directory, first)).toBeFalse();
    fs.symlinkSync(directory, path.join(work, "late-link"), "dir");
    expect(first.unchangedAll()).toBeFalse();
    const second = new RepositoryLinkInventory({ retained });
    expect(await repositoryReferencesAttemptTemp(repository, directory, directory, second)).toBeTrue();
  } finally { wholeSeconds.mockRestore(); }
}, 20_000);

test("a link created between directory enumeration and metadata capture cannot become a cached negative", async () => {
  const parent = root(), directory = path.join(parent, "llv-stage-link-race"); fs.mkdirSync(directory);
  const repository = path.join(parent, "repository"), cwd = path.join(repository, "work");
  fs.mkdirSync(path.join(repository, ".git"), { recursive: true }); fs.mkdirSync(cwd);
  const link = path.join(cwd, "node_modules");
  const directoryReads = fs.promises as unknown as {
    readdir: (target: fs.PathLike, options: { withFileTypes: true }) => Promise<fs.Dirent[]>;
  };
  const readdir = directoryReads.readdir.bind(directoryReads);
  let injected = false;
  const observed = spyOn(directoryReads, "readdir").mockImplementation(async (target, options) => {
    const entries = await readdir(target, options);
    if (!injected && target === cwd) { injected = true; fs.symlinkSync(directory, link, "dir"); }
    return entries;
  });
  const inventory = new RepositoryLinkInventory();
  const scan = { ownNamespace: null, processes: [{ pid: 7, namespace: null, stamped: false, paths: [cwd] }] };
  try {
    await expect(attemptReferencesClear(directory, directory, scan, async () => true, inventory)).rejects.toThrow("changed during link inventory");
    expect(await attemptReferencesClear(directory, directory, scan, async () => true, inventory)).toBeFalse();
    expect(fs.existsSync(directory)).toBeTrue();
  } finally { observed.mockRestore(); }
});

test("a nested link added during a later directory read defers the real sweep", async () => {
  const parent = root(), directory = path.join(parent, "llv-stage-race-target"); fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, "payload"), "keep");
  const repository = path.join(parent, "checkout"), earlier = path.join(repository, "a"), later = path.join(repository, "b");
  fs.mkdirSync(path.join(repository, ".git"), { recursive: true }); fs.mkdirSync(earlier); fs.mkdirSync(later);
  const link = path.join(earlier, "dependency");
  const directoryReads = fs.promises as unknown as {
    readdir: (target: fs.PathLike, options: { withFileTypes: true }) => Promise<fs.Dirent[]>;
  };
  const readdir = directoryReads.readdir.bind(directoryReads);
  let injected = false;
  const observed = spyOn(directoryReads, "readdir").mockImplementation(async (target, options) => {
    const entries = await readdir(target, options);
    if (!injected && target === later) { injected = true; fs.symlinkSync(directory, link, "dir"); }
    return entries;
  });
  const store = new AttemptTempStore(path.join(parent, "owners.sqlite"));
  store.register({ directory, pipelineId: "closed-lane", launchId: "fixture", retainUntilClose: false, createdAt: 1 });
  store.measure(directory, 4096); store.release(directory);
  const scan = { ownNamespace: null, processes: [{ pid: 42, namespace: null, stamped: false, paths: [repository] }] };
  const inventory = new RepositoryLinkInventory();
  let now = 2;
  const sweep = () => sweepAttemptTemps(store, { now: () => now, maxRoots: 1, capBytes: 0,
    state: async () => "closed",
    references: (original, current, currentScan) => attemptReferencesClear(original, current, currentScan, async () => true, inventory),
    scan: () => scan });
  try {
    const raced = await sweep();
    expect(injected).toBeTrue();
    expect(raced).toMatchObject({ removed: 0, deferred: 1, errors: 0 });
    expect(fs.readFileSync(path.join(directory, "payload"), "utf8")).toBe("keep");
    observed.mockRestore();
    now += 60_001;
    const retry = await sweep();
    expect(retry).toMatchObject({ removed: 0, held: 1, errors: 0 });
    expect(fs.readlinkSync(link)).toBe(directory);

    fs.unlinkSync(link); store.defer(directory, 0);
    expect(await sweep()).toMatchObject({ removed: 1, errors: 0 });
    expect(fs.existsSync(directory)).toBeFalse();
  } finally { observed.mockRestore(); store.close(); }
});

test("a real sweep rechecks an external symlink alias before removing its target root", async () => {
  const parent = root(), directory = path.join(parent, "llv-stage-linked-root"); fs.mkdirSync(directory);
  const data = path.join(directory, "data"); fs.writeFileSync(data, "owned scratch");
  const safe = path.join(parent, "safe"); fs.mkdirSync(safe); fs.writeFileSync(path.join(safe, "data"), "safe target");
  const alias = path.join(parent, "external-alias"); fs.symlinkSync(safe, alias, "dir");
  const repository = path.join(parent, "checkout"); fs.mkdirSync(path.join(repository, ".git"), { recursive: true });
  fs.symlinkSync(path.join(alias, "data"), path.join(repository, "dependency"));
  const processScan = { ownNamespace: null, processes: [{ pid: 42, namespace: null, stamped: false, paths: [repository] }] };
  const store = new AttemptTempStore(path.join(parent, "owners.sqlite"));
  store.register({ directory, pipelineId: "fixture", launchId: "fixture", retainUntilClose: false, createdAt: 1 });
  const inventory = new RepositoryLinkInventory();
  let firstRead = true;
  try {
    const report = await sweepAttemptTemps(store, {
      now: () => Date.parse("2030-01-01T00:00:00Z"), capBytes: 0, state: async () => "closed",
      scan: () => processScan,
      references: async (original, current, scan) => {
        const clear = await attemptReferencesClear(original, current, scan, async () => true, inventory);
        if (firstRead) {
          firstRead = false;
          fs.unlinkSync(alias);
          fs.symlinkSync(directory, alias, "dir");
        }
        return clear;
      },
    });
    expect(report).toMatchObject({ removed: 0, held: 1, liveHeld: 1, errors: 0 });
    expect(fs.readFileSync(data, "utf8")).toBe("owned scratch");
    expect(fs.lstatSync(path.join(repository, "dependency")).isSymbolicLink()).toBeTrue();
  } finally { store.close(); }
});

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a failed checkout inventory names its real error and retries the recovered checkout in the same run", async () => {
  const parent = root();
  const repository = path.join(parent, "repository"), blocked = path.join(repository, "blocked");
  fs.mkdirSync(blocked, { recursive: true }); fs.chmodSync(blocked, 0);
  const inventory = new RepositoryLinkInventory();
  try {
    await expect(inventory.targets(repository)).rejects.toThrow("permission denied");
    fs.chmodSync(blocked, 0o700);
    expect(await inventory.targets(repository)).toEqual([]);
    expect(inventory.walks).toHaveLength(2);
  } finally { fs.chmodSync(blocked, 0o700); }
});

test.each(["before walk", "during walk"])("an absent checkout refuses inventory and retries after restoration (%s)", async disappearance => {
  const parent = root(), repository = path.join(parent, "checkout"), directory = path.join(parent, "llv-stage-linked");
  fs.mkdirSync(directory);
  if (disappearance === "during walk") fs.mkdirSync(repository);
  const directoryReads = fs.promises as unknown as {
    readdir: (target: fs.PathLike, options: { withFileTypes: true }) => Promise<fs.Dirent[]>;
  };
  const readdir = directoryReads.readdir.bind(directoryReads);
  const observed = spyOn(directoryReads, "readdir").mockImplementation(async (target, options) => {
    const entries = await readdir(target, options);
    if (target === repository && disappearance === "during walk") fs.renameSync(repository, repository + "-previous");
    return entries;
  });
  const inventory = new RepositoryLinkInventory({ now: () => 1_000 });
  try { await expect(inventory.targets(repository)).rejects.toThrow(); }
  finally { observed.mockRestore(); }
  fs.mkdirSync(repository);
  fs.symlinkSync(directory, path.join(repository, "dependency"), "dir");
  expect(await inventory.targets(repository)).toContain(directory);
  expect(inventory.walks).toHaveLength(2);
});

test.skipIf(process.platform === "win32")("a large unrelated checkout allows reclaim and its nested link still holds scratch", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "llv-large-checkout-"));
  const repository = path.join(parent, "checkout"), directory = path.join(parent, "llv-stage-settled");
  fs.mkdirSync(path.join(repository, ".git"), { recursive: true });
  fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, "data"), "retained payload");
  const store = new AttemptTempStore(path.join(parent, "owners.sqlite"));
  try {
    for (let group = 0; group < 21; group++) {
      await exec("sh", ["-c", 'mkdir "$1" && cd "$1" && seq 0 9999 | xargs touch', "sh", path.join(repository, String(group).padStart(2, "0"))], { timeout: 60_000 });
    }
    store.register({ directory, pipelineId: "closed-lane", launchId: "fixture", retainUntilClose: false, createdAt: 1 });
    store.measure(directory, 4096); store.release(directory);
    const link = path.join(repository, "20", "dependency"); fs.symlinkSync(directory, link, "dir");
    const sweep = () => sweepAttemptTemps(store, { now: () => 2, maxRoots: 1, capBytes: 0, state: async () => "closed",
      references: (original, current, scan) => attemptReferencesClear(original, current, scan, async () => true, inventory),
      scan: () => ({ ownNamespace: null, processes: [{ pid: 999, namespace: null, stamped: false, paths: [repository] }] }) });
    // Reuse the full inventory through the real sweep's deletion boundaries.
    const inventory = new RepositoryLinkInventory();
    expect(await sweep()).toMatchObject({ removed: 0, held: 1, liveHeld: 1, errors: 0 });
    expect(fs.readFileSync(path.join(directory, "data"), "utf8")).toBe("retained payload");
    expect(inventory.walks).toHaveLength(1);
    fs.unlinkSync(link); store.defer(directory, 0);
    expect(await sweep()).toMatchObject({ removed: 1, errors: 0 });
    expect(fs.existsSync(directory)).toBeFalse();
    expect(inventory.walks).toHaveLength(2);
  } finally { store.close(); await exec("rm", ["-rf", "--", parent], { timeout: 60_000 }); }
}, 150_000);

test("an absent checkout is never a successful empty inventory", async () => {
  const inventory = new RepositoryLinkInventory();
  const repository = path.join(root(), "gone");
  await expect(inventory.targets(repository)).rejects.toThrow();
  await expect(inventory.targets(repository)).rejects.toThrow();
  expect(inventory.walks).toHaveLength(2);
});

test.each([1, 2, 3])("an absent consumer checkout keeps scratch at removal observation %i and permits later reclaim", async boundary => {
  const parent = root(), directory = path.join(parent, "llv-stage-restored-consumer");
  fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, "payload"), "keep");
  const repository = path.join(parent, "checkout"), cwd = path.join(repository, "work");
  fs.mkdirSync(cwd, { recursive: true }); fs.mkdirSync(path.join(repository, ".git"));
  const store = new AttemptTempStore(path.join(parent, "owners.sqlite"));
  store.register({ directory, pipelineId: "closed-producer", launchId: "fixture", retainUntilClose: false, createdAt: 1 });
  let now = 1000, reads = 0, containers = 0;
  let inventory = new RepositoryLinkInventory({ now: () => now });
  const processes = [{ pid: 42, namespace: null, stamped: false, paths: [cwd] }];
  const sweep = () => sweepAttemptTemps(store, { now: () => now, capBytes: 0, state: async () => "closed",
    scan: () => ({ ownNamespace: null, processes }),
    references: async (original, current, scan) => {
      if (++reads === boundary) { now += 10001; fs.renameSync(repository, repository + "-previous"); }
      return attemptReferencesClear(original, current, scan, async () => {
        containers++;
        // This is the retained probe's former deletion window. An absent
        // checkout must stop the observation before this await is reached.
        if (reads === boundary) {
          await Promise.resolve();
          fs.mkdirSync(cwd, { recursive: true }); fs.mkdirSync(path.join(repository, ".git"));
          fs.symlinkSync(original, path.join(repository, "dependency"), "dir");
        }
        return true;
      }, inventory);
    } });
  // Discover the consumer before its cwd disappears, as in the retained probe.
  expect(inventory.repositoryOf(cwd)).toBe(repository);
  try {
    expect(await sweep()).toMatchObject({ removed: 0, errors: 0, liveHeld: 1 });
    expect(reads).toBe(boundary); expect(containers).toBe(boundary - 1);
    expect(fs.readFileSync(path.join(directory, "payload"), "utf8")).toBe("keep");
    fs.mkdirSync(cwd, { recursive: true }); fs.mkdirSync(path.join(repository, ".git"));
    const link = path.join(repository, "dependency"); fs.symlinkSync(directory, link, "dir");
    now += 60001; inventory = new RepositoryLinkInventory({ now: () => now });
    expect(await sweep()).toMatchObject({ removed: 0, liveHeld: 1, errors: 0 });
    expect(fs.readFileSync(path.join(directory, "payload"), "utf8")).toBe("keep");
    fs.unlinkSync(link); now += 60001; inventory = new RepositoryLinkInventory({ now: () => now });
    expect(await sweep()).toMatchObject({ removed: 1, errors: 0 });
    expect(fs.existsSync(directory)).toBeFalse();
  } finally { store.close(); }
});

test.skipIf(process.env.LLV_ATTEMPT_TEMP_DOCKER_TEST !== "1" || process.getuid?.() === 0).each(["plain", "capture", "late-capture", "dispatch-capture", "fallback-capture", "bmp-capture", "bmp-dispatch-capture", "bmp-fallback-capture"])("container-owned private files retain evidence and retire empty scratch (%s)", async variant => {
  const kind = variant.replace(/^bmp-/, ""), extension = variant.startsWith("bmp-") ? "BMP" : "png";
  const parent = root(), directory = path.join(parent, "llv-stage-private"); fs.mkdirSync(directory);
  const image = await attemptTempUtilityImage();
  const store = new AttemptTempStore(path.join(parent, "owners.sqlite"));
  cleanups.push(async () => {
    store.close();
    if (fs.existsSync(directory)) await exec("docker", ["run", "--rm", "--pull=never", "--network=none", "--user=0",
      "--mount", `type=bind,source=${directory},target=/attempt`, "--entrypoint", "/bin/sh", image, "-c", "find /attempt -depth -mindepth 1 -delete"], { timeout: 15000 });
  });
  store.register({ directory, pipelineId: "fixture", launchId: "fixture", retainUntilClose: false, createdAt: 1 });
  await exec("docker", ["run", "--rm", "--pull=never", "--network=none", "--user=0", "--mount", `type=bind,source=${directory},target=/attempt`,
    "--entrypoint", "/bin/sh", image, "-c", "mkdir -p /attempt/private/deep; dd if=/dev/zero of=/attempt/private/data bs=1048576 count=4 2>/dev/null; chown -R 12345:12345 /attempt/private; chmod 700 /attempt/private"], { timeout: 15000 });
  try {
    expect(() => fs.readdirSync(path.join(directory, "private"))).toThrow();
    const now = Date.parse("2030-01-01T00:00:00Z");
    const pin = path.join(directory, ".delegatus-keep"); fs.writeFileSync(pin, "keep");
    const sweep = (at: number) => sweepAttemptTemps(store, { now: () => at, state: async () => "closed", scan: () => ({ ownNamespace: null, processes: [] }) });
    expect((await sweep(now)).removed).toBe(0); expect(fs.existsSync(directory)).toBeTrue();
    fs.unlinkSync(pin);
    const writeCapture = () => exec("docker", ["run", "--rm", "--pull=never", "--network=none", "--user=0",
      "--mount", `type=bind,source=${directory},target=/attempt`, "--entrypoint", "/bin/sh", image, "-c",
      `mkdir -p /attempt/private/deep; printf 'private capture' > /attempt/private/deep/frame.${extension}`], { timeout: 15000 });
    const readCapture = async () => (await exec("docker", ["run", "--rm", "--pull=never", "--network=none", "--user=0",
      "--mount", `type=bind,source=${directory},target=/attempt,readonly`, "--entrypoint", "/bin/cat", image,
      `/attempt/private/deep/frame.${extension}`], { timeout: 15000 })).stdout;
    if (kind === "capture") {
      await writeCapture();
      expect((await sweep(now + 60000)).removed).toBe(0);
      expect(await readCapture()).toBe("private capture");
      return;
    }
    if (kind === "dispatch-capture" || kind === "fallback-capture") {
      await expect(removeAttemptTree(directory, directory, async () => { await writeCapture(); return true; }, kind === "dispatch-capture")).rejects.toThrow();
      expect(await readCapture()).toBe("private capture");
      return;
    }
    if (kind === "late-capture") {
      let reads = 0;
      const report = await sweepAttemptTemps(store, { now: () => now + 60000, scan: () => ({ ownNamespace: null, processes: [] }),
        references: async () => true, state: async () => {
          if (++reads === 2) await writeCapture();
          return "closed";
        } });
      expect(reads).toBeGreaterThanOrEqual(2);
      expect(report.removed).toBe(0);
      expect(await readCapture()).toBe("private capture");
      return;
    }
    let report;
    // Other test runs may remove a container between ps and inspect. Production
    // must retain this tree on that incomplete observation, then retry next tick.
    for (let tick = 1; tick <= 4; tick++) {
      report = await sweep(now + tick * 60000);
      if (report.removed) break;
      expect(report.held + report.errors).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(directory, "private"))).toBeTrue();
    }
    expect(report!.errors).toBe(0); expect(report!.removed).toBe(1); expect(report!.removedBytes).toBeGreaterThanOrEqual(4 * 1024 * 1024); expect(fs.existsSync(directory)).toBeFalse();
  } finally { store.close(); }
}, 60000);


test.skipIf(process.platform !== "linux")("an incomplete container inventory cannot authorize deletion", async () => {
  const directory = root();
  const bin = path.join(directory, "bin"); fs.mkdirSync(bin);
  const docker = path.join(bin, "docker");
  fs.writeFileSync(docker, '#!/bin/sh\nif [ "$1" = ps ]; then printf "111111111111\\n"; else printf "[]\\n"; fi\n', { mode: 0o700 });
  const previous = process.env.PATH;
  process.env.PATH = bin + path.delimiter + previous;
  try { expect(await attemptReferencesClear(directory, directory, { ownNamespace: null, processes: [] })).toBeFalse(); }
  finally { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; }
});


test.skipIf(process.platform !== "linux")("a complete inventory above 64 unrelated containers permits retirement", async () => {
  const directory = root(); const bin = path.join(directory, "bin"); fs.mkdirSync(bin);
  const ids = Array.from({ length: 65 }, (_, n) => String(n + 1).padStart(12, "0"));
  const script = `#!/bin/sh
if [ "$1" = ps ]; then
printf '%s\\n' ${ids.join(" ")}
else
for id in "$@"; do case "$id" in [0-9]*) printf '{"Id":"%s","Mounts":[]}\\n' "$id";; esac; done
fi
`;
  fs.writeFileSync(path.join(bin, "docker"), script, { mode: 0o700 });
  const previous = process.env.PATH; process.env.PATH = bin + path.delimiter + (previous ?? "");
  try { expect(await attemptReferencesClear(directory, directory, { ownNamespace: null, processes: [] })).toBeTrue(); }
  finally { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; }
});

test.skipIf(process.platform !== "linux")("a container bind through a physical parent alias retains scratch", async () => {
  const parent = root(), directory = path.join(parent, "actual/llv-stage-mounted");
  fs.mkdirSync(directory, { recursive: true });
  fs.symlinkSync(path.dirname(directory), path.join(parent, "alias"), "dir");
  const alias = path.join(parent, "alias", path.basename(directory));
  const bin = path.join(parent, "bin"); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "docker"), `#!${process.execPath}\nif (process.argv[2] === "ps") console.log("111111111111"); else console.log(${JSON.stringify(JSON.stringify({ Id: "111111111111", Mounts: [{ Type: "bind", Source: directory }] }))});\n`, { mode: 0o700 });
  const previous = process.env.PATH; process.env.PATH = bin + path.delimiter + (previous ?? "");
  try { expect(await attemptReferencesClear(alias, alias, { ownNamespace: null, processes: [] })).toBeFalse(); }
  finally { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; }
});


test.each(["cache/uv/sdists-v9", "uv-cache/sdists-v9", "uvcache/sdists-v9/nested"])("real uv layout %s is disposable", async layout => {
  const directory = root(), marker = path.join(directory, layout, ".git");
  fs.mkdirSync(path.dirname(marker), { recursive: true }); fs.writeFileSync(marker, "");
  expect(await inspectAttemptTree(directory)).toBeTrue();
  fs.writeFileSync(marker, "unknown");
  expect(await inspectAttemptTree(directory)).toBeFalse();
});

test("fixture Git worktrees contained in the attempt can retire", async () => {
  const directory = root(), repo = path.join(directory, "repo"), wt = path.join(directory, "wt");
  fs.mkdirSync(repo);
  await exec("git", ["init", "-q", repo]);
  await exec("git", ["-C", repo, "-c", "user.name=Fixture", "-c", `user.email=${["noreply", "example.invalid"].join("@")}`, "commit", "--allow-empty", "-qm", "fixture"]);
  await exec("git", ["-C", repo, "worktree", "add", "--detach", wt]);
  expect(await inspectAttemptTree(directory)).toBeTrue();
  const external = root();
  await exec("git", ["-C", repo, "worktree", "add", "--detach", path.join(external, "outside")]);
  expect(await inspectAttemptTree(directory)).toBeFalse();
  expect(await inspectAttemptTree(wt)).toBeFalse();
});

test.each([".git", "project/.git", ".delegatus-keep"])("unknown marker %s is retained", async marker => {
  const directory = root(), file = path.join(directory, marker);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "");
  expect(await inspectAttemptTree(directory)).toBeFalse();
});


test.skipIf(process.env.LLV_ATTEMPT_TEMP_DOCKER_TEST !== "1" || process.getuid?.() === 0).each(["uv", "internal", "missing", "external", "unknown", "pin"])("private container marker classifier preserves its boundary (%s)", async kind => {
  const directory = root(), privateRoot = path.join(directory, "private");
  fs.mkdirSync(privateRoot);
  const image = await attemptTempUtilityImage();
  const docker = (script: string) => exec("docker", ["run", "--rm", "--pull=never", "--network=none", "--user=0",
    "--mount", `type=bind,source=${directory},target=/attempt`, "--entrypoint", "/bin/sh", image, "-c", script], { timeout: 15_000 });
  cleanups.push(async () => { await docker("find /attempt -depth -mindepth 1 -delete"); });
  if (kind === "uv") {
    const cache = path.join(privateRoot, "cache/uv/sdists-v9"); fs.mkdirSync(cache, { recursive: true }); fs.writeFileSync(path.join(cache, ".git"), "");
  } else if (kind === "pin") fs.writeFileSync(path.join(privateRoot, ".delegatus-keep"), "keep");
  else if (kind === "internal") {
    const metadata = path.join(privateRoot, "metadata"); fs.mkdirSync(metadata);
    fs.writeFileSync(path.join(privateRoot, ".git"), `gitdir: ${metadata}\n`);
  } else fs.writeFileSync(path.join(privateRoot, ".git"), kind === "unknown" ? "unknown" : `gitdir: ${kind === "missing" ? path.join(privateRoot, "absent") : root()}\n`);
  await docker("chown -R 12345:12345 /attempt/private; chmod 700 /attempt/private");
  expect(() => fs.readdirSync(privateRoot)).toThrow();
  expect(await inspectAttemptTree(directory)).toBe(kind === "uv" || kind === "internal");
}, 60_000);


test.skipIf(process.platform !== "linux")("a closed lane's checkout link stops holding scratch when its real consumer exits", async () => {
  const parent = root(), directory = path.join(parent, "llv-stage-dead-consumer");
  fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, "payload"), "keep");
  const repository = path.join(parent, "checkout"); fs.mkdirSync(path.join(repository, ".git"), { recursive: true });
  fs.symlinkSync(directory, path.join(repository, "dependency"), "dir");
  const store = new AttemptTempStore(path.join(parent, "owners.sqlite"));
  store.register({ directory, pipelineId: "closed-lane", launchId: "fixture", retainUntilClose: false, createdAt: 1 });
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "attemptTempRetention.fixture.ts"), "--hold"], {
    cwd: repository, env: { ...process.env }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  let now = 1000;
  // Read only this fixture's PID. The shared machine's process inventory is
  // outside this test's observations and cannot affect its removal result.
  const scan = () => {
    let cwd: string | undefined;
    try { cwd = fs.readlinkSync(`/proc/${child.pid}/cwd`); } catch { /* Exited consumer. */ }
    return { ownNamespace: null, processes: cwd ? [{ pid: child.pid, namespace: null, stamped: false, paths: [cwd] }] : [] };
  };
  const sweep = () => sweepAttemptTemps(store, { now: () => now, state: async () => "closed", scan,
    references: (original, current, observed) => attemptReferencesClear(original, current, observed, async () => true) });
  try {
    const reader = child.stdout.getReader();
    const ready = await reader.read(); reader.releaseLock();
    expect(new TextDecoder().decode(ready.value)).toBe("ready\n");
    expect(await sweep()).toMatchObject({ removed: 0, liveHeld: 1, errors: 0 });
    expect(fs.readFileSync(path.join(directory, "payload"), "utf8")).toBe("keep");
    child.stdin.end(); expect(await child.exited).toBe(0);
    now += 60001;
    expect(await sweep()).toMatchObject({ removed: 1, errors: 0 });
    expect(fs.existsSync(directory)).toBeFalse();
    expect(fs.lstatSync(path.join(repository, "dependency")).isSymbolicLink()).toBeTrue();
  } finally {
    child.stdin.end();
    if (child.exitCode === null) child.kill();
    await child.exited; store.close();
  }
});
