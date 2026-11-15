import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, spyOn, test } from "bun:test";
import { removeAttemptTree, snapshotAttemptProtection, allocatedAttemptBytes, attemptTempUtilityImage } from "./attemptTempFilesystem";
import * as removal from "./attemptTempRemoval";
import { attemptTempFailureDetail } from "./attemptTempDiagnostics";
import { attemptMutationCurrent } from "./attemptMutationFence";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    // Only the fixture's own entries need restoration after a refused removal.
    const restore = (directory: string) => {
      fs.chmodSync(directory, 0o700);
      for (const entry of fs.readdirSync(directory, { withFileTypes: true }))
        if (entry.isDirectory()) restore(path.join(directory, entry.name));
    };
    restore(root);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "llv-permission-")); roots.push(parent);
  const directory = path.join(parent, "llv-stage-expired"), cache = path.join(directory, "module-cache");
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, "payload"), "cache");
  fs.chmodSync(cache, 0o555);
  return { parent, directory, cache };
}
const allowed = () => true;
// Native work runs in an owned child. Mark dispatch before refusing so the
// repair tests observe its modes independently of deletion, as the child does.
const refuseRemoval = (reason: string) => spyOn(removal, "removeTreeWithinAttemptBudget").mockImplementation(async (_directory, started) => {
  started();
  throw new Error(reason);
});
const repair = (directory: string, dispatch = allowed, authority = allowed) =>
  removeAttemptTree(directory, directory, async () => true, false, dispatch, authority, true);

test.skipIf(process.platform !== "linux").each(["uv/sdists-v9/.git", ".git/worktrees/fixture/gitdir"])(
  "protection versions marker content independently of directory metadata (%s)", async relative => {
    const f = fixture(), marker = path.join(f.directory, relative);
    fs.mkdirSync(path.dirname(marker), { recursive: true }); fs.writeFileSync(marker, "");
    const protection = await snapshotAttemptProtection(f.directory);
    expect(protection.current()).toBeTrue();
    const before = fs.lstatSync(marker, { bigint: true }), nativeStat = fs.lstatSync.bind(fs);
    fs.writeFileSync(marker, "gitdir: /external\n");
    // Model a filesystem whose metadata cannot distinguish the rewrite.
    // The content proof must refuse even with the original marker stat.
    const stat = spyOn(fs, "lstatSync").mockImplementation(((file: fs.PathLike, options?: unknown) =>
      String(file) === marker ? before : nativeStat(file, options as { bigint: false })) as typeof fs.lstatSync);
    try { expect(protection.current()).toBeFalse(); }
    finally { stat.mockRestore(); }
    const alias = path.join(f.parent, "marker-alias");
    fs.linkSync(marker, alias);
    const latest = await snapshotAttemptProtection(f.directory);
    expect(attemptMutationCurrent(latest.mutationDirectories ?? [], () => {
      const current = latest.current();
      expect(current).toBeTrue();
      fs.writeFileSync(alias, "gitdir: /changed-external\n");
      return current;
    })).toBeFalse();
    expect(fs.statSync(f.cache).mode & 0o777).toBe(0o555);
    expect(fs.readFileSync(path.join(f.cache, "payload"), "utf8")).toBe("cache");
  });

test.skipIf(process.platform !== "linux")("expired native removal repairs an own read-only cache without a container", async () => {
  const f = fixture(), previous = process.env.PATH;
  process.env.PATH = f.parent;
  try { await repair(f.directory); expect(fs.existsSync(f.directory)).toBeFalse(); }
  finally { process.env.PATH = previous; }
});

test.skipIf(process.platform !== "linux").each([0o000, 0o444, 0o555])(
  "permission repair preserves regular file mode %i", async mode => {
    const f = fixture(), payload = path.join(f.cache, "payload");
    fs.chmodSync(payload, mode);
    const rm = refuseRemoval("fixture stops after repair");
    try {
      await expect(repair(f.directory)).rejects.toThrow("fixture stops after repair");
      expect(fs.statSync(f.cache).mode & 0o777).toBe(0o755);
      expect(fs.statSync(payload).mode & 0o777).toBe(mode);
    } finally { rm.mockRestore(); fs.chmodSync(payload, 0o600); }
  });

test.skipIf(process.platform !== "linux").each([1, 2])(
  "a refusal after chmod restores every read-only directory and preserves its reason (changed=%i)", async changedAt => {
    const f = fixture(), nested = path.join(f.cache, "nested");
    fs.chmodSync(f.cache, 0o755);
    fs.mkdirSync(nested); fs.writeFileSync(path.join(nested, "payload"), "retained");
    fs.chmodSync(nested, 0o555); fs.chmodSync(f.cache, 0o555);
    const refusal = new Error(`proof refused after chmod ${changedAt}`);
    let changes = 0, observed: unknown;
    try {
      await removeAttemptTree(f.directory, f.directory, async () => true, false, allowed, allowed, true, undefined, {
        permissionChange: (_file, _mode, apply) => {
          apply();
          if (++changes === changedAt) throw refusal;
        },
      });
    } catch (error) { observed = error; }
    expect(changes).toBe(changedAt);
    expect(observed).toBeInstanceOf(Error);
    expect((observed as Error).message).toContain(refusal.message);
    expect((observed as Error).cause).toBe(refusal);
    expect(fs.statSync(f.cache).mode & 0o777).toBe(0o555);
    expect(fs.statSync(nested).mode & 0o777).toBe(0o555);
    expect(fs.readFileSync(path.join(nested, "payload"), "utf8")).toBe("retained");
  });

test.skipIf(process.platform !== "linux").each(["owner", "device", "symlink", "hardlink"] as const)(
  "permission repair respects the %s boundary", async boundary => {
    const f = fixture(), outside = path.join(f.parent, "outside");
    fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, "payload"), "keep"); fs.chmodSync(outside, 0o555);
    const link = path.join(f.directory, "link"); fs.symlinkSync(outside, link);
    const hardlink = path.join(f.directory, "hardlink"); fs.linkSync(path.join(outside, "payload"), hardlink);
    fs.chmodSync(hardlink, 0o444);
    const nativeStat = fs.fstatSync.bind(fs);
    const stat = spyOn(fs, "fstatSync").mockImplementation(((fd: number, options?: { bigint?: boolean }) => {
      const value = nativeStat(fd, options as { bigint: false });
      if (value.ino === fs.lstatSync(f.cache).ino) {
        if (boundary === "owner") return Object.assign(value, { uid: value.uid + 1 });
        if (boundary === "device") return Object.assign(value, { dev: value.dev + 1 });
      }
      return value;
    }) as typeof fs.fstatSync);
    // Observe repair independently of the subsequent native delete.
    const rm = refuseRemoval("fixture stops after repair");
    try {
      await expect(repair(f.directory)).rejects.toThrow("fixture stops after repair");
      expect(fs.statSync(outside).mode & 0o777).toBe(0o555);
      expect(fs.statSync(hardlink).mode & 0o777).toBe(0o444);
      expect(fs.statSync(f.cache).mode & 0o777).toBe(boundary === "owner" || boundary === "device" ? 0o555 : 0o755);
    } finally { stat.mockRestore(); rm.mockRestore(); }
  });

test.skipIf(process.platform !== "linux").each(["dispatch", "authority"] as const)(
  "revoked %s prevents permission repair", async boundary => {
    const f = fixture();
    await expect(repair(f.directory, () => boundary !== "dispatch", () => boundary !== "authority")).rejects.toThrow();
    expect(fs.statSync(f.cache).mode & 0o777).toBe(0o555);
  });

test.skipIf(process.platform === "win32")("permission repair requires expired removal admission", async () => {
  const f = fixture();
  const rm = refuseRemoval("fixture stops before deletion");
  try {
    await expect(removeAttemptTree(f.directory, f.directory, async () => true, false, allowed, allowed, false)).rejects.toThrow();
    expect(fs.statSync(f.cache).mode & 0o777).toBe(0o555);
  } finally { rm.mockRestore(); }
});

test.skipIf(process.platform !== "linux")("an exhausted permission repair budget leaves the tree unchanged", async () => {
  const f = fixture();
  await expect(removeAttemptTree(f.directory, f.directory, async () => true, false, allowed, allowed, true, undefined,
    { budgetMs: 0 })).rejects.toThrow("permission repair time budget exhausted");
  expect(fs.statSync(f.cache).mode & 0o777).toBe(0o555);
});

test.skipIf(process.platform === "win32")("an exhausted measurement budget defers before starting native work", async () => {
  const f = fixture();
  await expect(allocatedAttemptBytes(f.directory, { budgetMs: 0 })).rejects.toThrow("measurement time budget exhausted");
  expect(fs.statSync(f.cache).mode & 0o777).toBe(0o555);
});

test.skipIf(process.platform !== "linux")("a symlink substituted during repair cannot redirect chmod outside the root", async () => {
  const f = fixture(), outside = path.join(f.parent, "outside"); fs.mkdirSync(outside, { mode: 0o555 });
  const nativeOpen = fs.openSync.bind(fs);
  let replaced = false;
  const open = spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
    if (!replaced && String(file).endsWith("/module-cache")) {
      replaced = true; fs.renameSync(f.cache, f.cache + "-original"); fs.symlinkSync(outside, f.cache);
    }
    return nativeOpen(file, flags, mode);
  }) as typeof fs.openSync);
  const rm = refuseRemoval("fixture stops before deletion");
  try {
    await expect(repair(f.directory)).rejects.toThrow(); expect(replaced).toBeTrue();
    expect(fs.statSync(outside).mode & 0o777).toBe(0o555);
  } finally { open.mockRestore(); rm.mockRestore(); }
});

test.skipIf(process.platform !== "linux")("permission repair refuses a replacement root", async () => {
  const f = fixture(), replacement = path.join(f.parent, "replacement");
  fs.mkdirSync(replacement); fs.writeFileSync(path.join(replacement, "payload"), "replacement"); fs.chmodSync(replacement, 0o555);
  const nativeOpen = fs.openSync.bind(fs);
  let replaced = false;
  const open = spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
    if (!replaced && String(file) === f.directory) {
      replaced = true; fs.renameSync(f.directory, f.directory + "-original"); fs.renameSync(replacement, f.directory);
    }
    return nativeOpen(file, flags, mode);
  }) as typeof fs.openSync);
  const rm = refuseRemoval("fixture stops before deletion");
  try {
    await expect(repair(f.directory)).rejects.toThrow("permission repair root changed");
    expect(replaced).toBeTrue(); expect(fs.statSync(f.directory).mode & 0o777).toBe(0o555);
    expect(fs.readFileSync(path.join(f.directory, "payload"), "utf8")).toBe("replacement");
  } finally { open.mockRestore(); rm.mockRestore(); }
});

test("failure diagnostics retain code, signal and stderr ahead of a long command", () => {
  const error = Object.assign(new Error("Command failed: " + "argument ".repeat(500)), {
    code: 73, signal: "SIGTERM", stderr: "fixture permission failure",
  });
  const detail = attemptTempFailureDetail(error).slice(0, 1024);
  for (const part of ["code=73", "signal=SIGTERM", "stderr=fixture permission failure"]) {
    expect(detail).toContain(part);
    expect(detail.indexOf(part)).toBeLessThan(detail.indexOf("Command failed:"));
  }
});

test.skipIf(process.platform !== "linux" || process.env.LLV_ATTEMPT_TEMP_DOCKER_TEST !== "1" || process.getuid?.() === 0)("an unreadable own directory has a namespace protection snapshot and full measurement", async () => {
  const f = fixture(); fs.chmodSync(f.cache, 0o700);
  fs.mkdirSync(path.join(f.cache, "deep"));
  fs.writeFileSync(path.join(f.cache, "deep", "payload"), Buffer.alloc(2 * 1024 ** 2, 1));
  fs.chmodSync(f.cache, 0);
  const previous = process.env.LLV_ATTEMPT_TEMP_CLEANUP_IMAGE;
  process.env.LLV_ATTEMPT_TEMP_CLEANUP_IMAGE = await attemptTempUtilityImage();
  try {
    const snapshot = await snapshotAttemptProtection(f.directory);
    expect(snapshot).toBeDefined();
    expect(await allocatedAttemptBytes(f.directory)).toBeGreaterThanOrEqual(2 * 1024 ** 2);
    // The namespace is read-only; obtaining proof must not repair permissions.
    expect(fs.statSync(f.cache).mode & 0o777).toBe(0);
  } finally {
    if (previous === undefined) delete process.env.LLV_ATTEMPT_TEMP_CLEANUP_IMAGE;
    else process.env.LLV_ATTEMPT_TEMP_CLEANUP_IMAGE = previous;
  }
});

test.skipIf(process.platform !== "linux" || process.env.LLV_ATTEMPT_TEMP_DOCKER_TEST !== "1")("namespace command failures expose their status before the command", async () => {
  const f = fixture(), bin = path.join(f.parent, "bin"); fs.mkdirSync(bin);
  const command = path.join(bin, "docker");
  fs.writeFileSync(command, '#!/bin/sh\nif [ "$1" = ps ]; then exit 0; fi\necho "fixture namespace failure" >&2\nexit 73\n', { mode: 0o700 });
  const previousPath = process.env.PATH, previousImage = process.env.LLV_ATTEMPT_TEMP_CLEANUP_IMAGE;
  process.env.PATH = bin + path.delimiter + previousPath; process.env.LLV_ATTEMPT_TEMP_CLEANUP_IMAGE = "fixture-image";
  try {
    let failure: unknown;
    try { await removeAttemptTree(f.directory, f.directory, async () => true, true, allowed); } catch (error) { failure = error; }
    expect(failure).toBeDefined();
    const detail = attemptTempFailureDetail(failure).slice(0, 1024);
    expect(detail).toContain("code=73"); expect(detail).toContain("signal=null");
    expect(detail).toContain("stderr=fixture namespace failure");
    expect(fs.existsSync(f.directory)).toBeTrue();
  } finally {
    process.env.PATH = previousPath;
    if (previousImage === undefined) delete process.env.LLV_ATTEMPT_TEMP_CLEANUP_IMAGE; else process.env.LLV_ATTEMPT_TEMP_CLEANUP_IMAGE = previousImage;
  }
});

test.skipIf(process.platform !== "linux" || process.env.LLV_ATTEMPT_TEMP_DOCKER_TEST !== "1")(
  "an explicit no-evidence requirement also holds for expired removal", async () => {
    const f = fixture(), capture = path.join(f.directory, "frame.png");
    fs.writeFileSync(capture, "keep capture");
    await expect(removeAttemptTree(f.directory, f.directory, async () => true, true, allowed, allowed, true)).rejects.toThrow();
    expect(fs.readFileSync(capture, "utf8")).toBe("keep capture");
  });

test.skipIf(process.platform !== "linux" || process.env.LLV_ATTEMPT_TEMP_DOCKER_TEST !== "1" || process.getuid?.() === 0).each([false, true])(
  "namespace deletion rechecks opaque descendants after its last await (changed=%s)", async changed => {
    const f = fixture(); fs.chmodSync(f.cache, 0o700); fs.mkdirSync(path.join(f.cache, "deep")); fs.chmodSync(f.cache, 0);
    const image = await attemptTempUtilityImage();
    const protection = await snapshotAttemptProtection(f.directory, 30_000, true);
    expect(protection.namespace).toBeDefined(); expect(protection.current()).toBeTrue();
    const before = fs.statSync(f.cache);
    const guard = async () => {
      if (changed) await exec("docker", ["run", "--rm", "--pull=never", "--network=none", "--user=0", "--mount",
        `type=bind,source=${f.directory},target=/attempt`, "--entrypoint", "/bin/sh", image, "-c",
        `mkdir /attempt/module-cache/deep/new; chown ${process.getuid!()} /attempt/module-cache/deep/new`], { timeout: 15_000 });
      return true;
    };
    const removal = removeAttemptTree(f.directory, f.directory, guard, false, allowed, allowed, true, protection.namespace);
    if (changed) {
      await expect(removal).rejects.toThrow();
      expect(fs.statSync(f.cache).ctimeMs).toBe(before.ctimeMs);
      expect(protection.current()).toBeTrue(); // Native frontier cannot see the hidden edit.
      fs.chmodSync(f.cache, 0o700); expect(fs.existsSync(path.join(f.cache, "deep/new"))).toBeTrue();
    } else { await removal; expect(fs.existsSync(f.directory)).toBeFalse(); }
  });

test.skipIf(process.platform !== "linux").each(["before-repair", "after-repair"] as const)(
  "native removal refuses a same-device mount added %s", async boundary => {
    const f = fixture(), nativeRead = fs.readFileSync.bind(fs);
    let mounted = boundary === "before-repair", removed = false;
    const read = spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, options?: unknown) => {
      const value = nativeRead(file, options as BufferEncoding);
      if (mounted && file === "/proc/self/mountinfo")
        return String(value).trimEnd() + `\n2147483647 1 0:1 / ${f.cache} rw - tmpfs tmpfs rw\n`;
      return value;
    }) as typeof fs.readFileSync);
    const rm = spyOn(removal, "removeTreeWithinAttemptBudget").mockImplementation(async (_directory, started) => { started(); removed = true; });
    try {
      await expect(removeAttemptTree(f.directory, f.directory, async () => { mounted = true; return true; }, false,
        allowed, allowed, true)).rejects.toThrow("mount boundary");
      expect(removed).toBeFalse();
      expect(fs.statSync(f.cache).mode & 0o777).toBe(0o555);
      expect(fs.readFileSync(path.join(f.cache, "payload"), "utf8")).toBe("cache");
    } finally { read.mockRestore(); rm.mockRestore(); }
  });

test.skipIf(process.platform !== "linux").each(["child", "ancestor"] as const)(
  "a pinned %s moved outside the root keeps its mode before native removal", async kind => {
    const f = fixture(), outside = path.join(f.parent, "outside");
    if (kind === "ancestor") {
      fs.chmodSync(f.cache, 0o755); fs.mkdirSync(path.join(f.cache, "deep"), { mode: 0o555 });
    }
    const nativeOpen = fs.openSync.bind(fs);
    let moved = false;
    const open = spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      const fd = nativeOpen(file, flags, mode);
      if (!moved && String(file).startsWith("/proc/self/fd/") && String(file).endsWith(kind === "child" ? "/module-cache" : "/deep")) {
        moved = true;
        const current = kind === "child" ? f.cache : path.dirname(fs.realpathSync(String(file)));
        const priorMode = fs.statSync(current).mode & 0o777;
        fs.chmodSync(current, 0o755); fs.renameSync(current, outside); fs.chmodSync(outside, priorMode);
      }
      return fd;
    }) as typeof fs.openSync);
    const rm = refuseRemoval("fixture stops before deletion");
    try {
      await expect(repair(f.directory)).rejects.toThrow(); expect(moved).toBeTrue();
      expect(fs.statSync(kind === "child" ? outside : path.join(outside, "deep")).mode & 0o777).toBe(0o555);
      expect(fs.readFileSync(path.join(outside, "payload"), "utf8")).toBe("cache");
    } finally { open.mockRestore(); rm.mockRestore(); }
  });


test.skipIf(process.platform !== "linux")("repair updates protection through an admitted parent alias", async () => {
  const f = fixture(), alias = path.join(f.parent, "alias");
  fs.symlinkSync(f.parent, alias, "dir");
  const directory = path.join(alias, path.basename(f.directory));
  const protection = await snapshotAttemptProtection(directory);
  await removeAttemptTree(directory, directory, async () => true, false, allowed, allowed, true, undefined,
    { permissionChange: protection.permissionChange });
  expect(fs.existsSync(f.directory)).toBeFalse();
});

test.skipIf(process.platform !== "linux").each(["mountinfo", "fdinfo"] as const)(
  "a directory moved during its last %s read keeps its mode without a protection callback", async observation => {
    const f = fixture(), outside = path.join(f.parent, "outside");
    const nativeOpen = fs.openSync.bind(fs), nativeRead = fs.readFileSync.bind(fs);
    let pinned: number | undefined, observations = 0, moved = false;
    const open = spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      const fd = nativeOpen(file, flags, mode);
      if (String(file).startsWith("/proc/self/fd/") && String(file).endsWith("/module-cache")) pinned = fd;
      return fd;
    }) as typeof fs.openSync);
    const read = spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, options?: unknown) => {
      const value = nativeRead(file, options as BufferEncoding);
      const target = observation === "mountinfo" ? "/proc/self/mountinfo" : `/proc/self/fdinfo/${pinned}`;
      if (pinned !== undefined && file === target && ++observations === 2) {
        moved = true;
        fs.chmodSync(f.cache, 0o755); fs.renameSync(f.cache, outside); fs.chmodSync(outside, 0o555);
      }
      return value;
    }) as typeof fs.readFileSync);
    try {
      await expect(repair(f.directory)).rejects.toThrow("entry left its admitted root or mount");
      expect(moved).toBeTrue();
      expect(fs.statSync(outside).mode & 0o777).toBe(0o555);
      expect(fs.readFileSync(path.join(outside, "payload"), "utf8")).toBe("cache");
    } finally { read.mockRestore(); open.mockRestore(); }
  });
