import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, spyOn, test } from "bun:test";
import { AttemptTempStore, sweepAttemptTemps, type AttemptTempState } from "./attemptTempRetention";
import { attemptTempJournalPath } from "@/lib/tempSweep";
import { RepositoryLinkInventory, repositoryReferencesAttemptTemp } from "./attemptTempFilesystem";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    const restore = (directory: string) => {
      fs.chmodSync(directory, 0o700);
      for (const entry of fs.readdirSync(directory, { withFileTypes: true }))
        if (entry.isDirectory()) restore(path.join(directory, entry.name));
    };
    restore(root); fs.rmSync(root, { recursive: true, force: true });
  }
});
const NOW = Date.parse("2030-01-20T00:00:00Z");
function fixture() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "llv-permission-retention-")); roots.push(parent);
  const directory = path.join(parent, "llv-stage-expired"), cache = path.join(directory, "module-cache");
  fs.mkdirSync(cache, { recursive: true }); fs.writeFileSync(path.join(cache, "payload"), "cache");
  const store = new AttemptTempStore(path.join(parent, "owners.sqlite"));
  store.register({ directory, pipelineId: null, launchId: "fixture", retainUntilClose: true, createdAt: NOW - 20 * 86400000 });
  fs.chmodSync(cache, 0o555);
  return { parent, directory, cache, store };
}
const emptyScan = () => ({ ownNamespace: null, processes: [] });

test.skipIf(process.platform !== "linux")("repair keeps checkout validation work independent of its file count", async () => {
  const counts: number[] = [];
  for (const files of [10, 1000]) {
    const f = fixture(), checkout = path.join(f.parent, "consumer");
    fs.mkdirSync(path.join(checkout, ".git"), { recursive: true });
    for (let n = 0; n < 12; n++) fs.mkdirSync(path.join(checkout, `directory-${n}`));
    fs.chmodSync(f.cache, 0o700);
    for (let n = 0; n < files; n++) fs.writeFileSync(path.join(f.cache, `file-${n}`), "cache");
    fs.chmodSync(f.cache, 0o555);
    let checks = 0;
    const unchanged = RepositoryLinkInventory.prototype.unchangedAll;
    const observe = spyOn(RepositoryLinkInventory.prototype, "unchangedAll").mockImplementation(function (this: RepositoryLinkInventory) {
      checks++; return unchanged.call(this);
    });
    try {
      const report = await sweepAttemptTemps(f.store, { now: () => NOW, maxRoots: 1, scan: emptyScan, references: async () => true,
        state: async (owner, inventory) => {
          await repositoryReferencesAttemptTemp(checkout, owner.directory, owner.directory, inventory);
          return "expired";
        } });
      expect(report).toMatchObject({ removed: 1, errors: 0 });
      counts.push(checks);
    } finally { observe.mockRestore(); f.store.close(); }
  }
  console.log("permission repair checkout validations", counts);
  expect(counts[1]).toBeLessThanOrEqual(counts[0] * 2);
});

test.skipIf(process.platform !== "linux")("an expired root with a read-only module cache retires without a container", async () => {
  const f = fixture(), previousPath = process.env.PATH;
  const bin = path.join(f.parent, "bin"); fs.mkdirSync(bin);
  for (const command of ["find", "du"]) fs.symlinkSync(`/usr/bin/${command}`, path.join(bin, command));
  process.env.PATH = bin;
  try {
    const report = await sweepAttemptTemps(f.store, { now: () => NOW, maxRoots: 1, state: async () => "expired", scan: emptyScan, references: async () => true });
    expect(report).toMatchObject({ checked: 1, removed: 1, errors: 0 });
    expect(fs.existsSync(f.directory)).toBeFalse(); expect(f.store.has(f.directory)).toBeFalse();
    expect(fs.existsSync(attemptTempJournalPath(f.directory))).toBeFalse();
    expect(fs.readdirSync(f.parent).some(name => name.startsWith(".delegatus-trash-"))).toBeFalse();
  } finally { process.env.PATH = previousPath; f.store.close(); }
});

test.skipIf(process.platform !== "linux")("an external hardlink made after fstat keeps its permissions through retention", async () => {
  const f = fixture(), outside = path.join(f.parent, "retained-link"), previousPath = process.env.PATH;
  const payload = path.join(f.cache, "payload");
  fs.chmodSync(payload, 0o444);
  const identity = fs.statSync(payload);
  const bin = path.join(f.parent, "bin"); fs.mkdirSync(bin);
  for (const command of ["find", "du"]) fs.symlinkSync(`/usr/bin/${command}`, path.join(bin, command));
  process.env.PATH = bin;
  const nativeStat = fs.fstatSync.bind(fs);
  let linked = false;
  const stat = spyOn(fs, "fstatSync").mockImplementation(((fd: number, options?: { bigint?: boolean }) => {
    const value = nativeStat(fd, options as { bigint: false });
    if (!linked && value.dev === identity.dev && value.ino === identity.ino) {
      // Create a real external alias after the repair has read nlink=1.
      // The directory has already been repaired, so link creation is allowed.
      fs.linkSync(fs.realpathSync(`/proc/self/fd/${fd}`), outside);
      linked = true;
    }
    return value;
  }) as typeof fs.fstatSync);
  try {
    const report = await sweepAttemptTemps(f.store, { now: () => NOW, maxRoots: 1, state: async () => "expired", scan: emptyScan, references: async () => true });
    expect(linked).toBeTrue();
    expect(report).toMatchObject({ checked: 1, removed: 1, errors: 0 });
    expect(fs.readFileSync(outside, "utf8")).toBe("cache");
    expect(fs.statSync(outside).ino).toBe(identity.ino);
    expect(fs.statSync(outside).mode & 0o777).toBe(0o444);
    expect(fs.existsSync(f.directory)).toBeFalse(); expect(f.store.has(f.directory)).toBeFalse();
    expect(fs.existsSync(attemptTempJournalPath(f.directory))).toBeFalse();
    expect(fs.readdirSync(f.parent).some(name => name.startsWith(".delegatus-trash-"))).toBeFalse();
  } finally { stat.mockRestore(); process.env.PATH = previousPath; f.store.close(); }
});

test.skipIf(process.platform === "win32").each(["live", "unknown", "settled", "orphan", "keep", "git", "references", "dry-run", "revision", "expiry"] as const)(
  "an ineligible root is never permission-repaired (%s)", async reason => {
    const f = fixture();
    if (reason === "keep") { fs.chmodSync(f.cache, 0o755); fs.writeFileSync(path.join(f.cache, ".delegatus-keep"), "pin"); fs.chmodSync(f.cache, 0o555); }
    if (reason === "git") fs.writeFileSync(path.join(f.directory, ".git"), "gitdir: ../outside\n");
    const states = new Set(["live", "unknown", "settled", "orphan"]);
    const state = (states.has(reason) ? reason : "expired") as AttemptTempState;
    if (reason === "orphan" || reason === "expiry") f.store.requireRootExpiry(f.directory, NOW + 86400000);
    try {
      const report = await sweepAttemptTemps(f.store, { now: () => NOW, maxRoots: 1, state: async () => state,
        authority: async () => ({ state, expiresAt: reason === "expiry" ? NOW + 86400000 : NOW - 1, revision: "fixture", isCurrent: () => reason !== "revision" }),
        scan: emptyScan, references: async () => reason !== "references", mode: reason === "dry-run" ? "dry-run" : "on" });
      expect(report.removed).toBe(reason === "dry-run" ? 1 : 0);
      expect(fs.statSync(f.cache).mode & 0o777).toBe(0o555);
      expect(fs.readFileSync(path.join(f.cache, "payload"), "utf8")).toBe("cache");
      expect(f.store.has(f.directory)).toBeTrue();
      expect(fs.existsSync(attemptTempJournalPath(f.directory))).toBeFalse();
    } finally { f.store.close(); }
  });

test.skipIf(process.platform !== "linux" || process.env.LLV_ATTEMPT_TEMP_DOCKER_TEST !== "1" || process.getuid?.() === 0).each(["remove", "keep", "late-keep"] as const)(
  "an expired unreadable tree preserves namespace protection (%s)", async kind => {
    const f = fixture(); fs.chmodSync(f.cache, 0o700); fs.mkdirSync(path.join(f.cache, "deep"));
    const pin = path.join(f.cache, "deep", ".delegatus-keep");
    if (kind === "keep") fs.writeFileSync(pin, "pin");
    if (kind !== "late-keep") fs.chmodSync(f.cache, 0);
    let injected = false;
    try {
      const report = await sweepAttemptTemps(f.store, { now: () => NOW, maxRoots: 1, state: async () => "expired", scan: emptyScan,
        references: async () => {
          if (kind === "late-keep" && !injected) {
            fs.chmodSync(f.cache, 0o700); fs.writeFileSync(pin, "late pin"); fs.chmodSync(f.cache, 0); injected = true;
          }
          return true;
        } });
      expect(report.removed).toBe(kind === "remove" ? 1 : 0);
      if (kind !== "remove") {
        fs.chmodSync(f.cache, 0o700); expect(fs.readFileSync(pin, "utf8")).toContain("pin");
      }
      if (kind === "late-keep") expect(injected).toBeTrue();
      if (kind === "remove") expect(report.errors).toBe(0);
    } finally { f.store.close(); }
  });

// Inject at the descriptor boundary, after eligibility and quarantine have
// already completed. Assert modes as well as content on the refused tree.
test.skipIf(process.platform !== "linux").each(["move-child", "move-ancestor", "keep"] as const)(
  "repair stops before chmod when a pinned entry changes (%s)", async kind => {
    const f = fixture(), outside = path.join(f.parent, "outside");
    if (kind === "move-ancestor") {
      fs.chmodSync(f.cache, 0o755); fs.mkdirSync(path.join(f.cache, "deep"), { mode: 0o555 });
    }
    const nativeOpen = fs.openSync.bind(fs);
    let injected = false;
    const target = kind === "move-ancestor" ? "deep" : "module-cache";
    const open = spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      const fd = nativeOpen(file, flags, mode);
      if (!injected && String(file).startsWith("/proc/self/fd/") && String(file).endsWith("/" + target)) {
        injected = true;
        const current = fs.realpathSync(String(file));
        if (kind === "keep") {
          fs.chmodSync(current, 0o755); fs.writeFileSync(path.join(current, ".delegatus-keep"), "pin"); fs.chmodSync(current, 0o555);
        } else {
          const moving = kind === "move-ancestor" ? path.dirname(current) : current;
          const priorMode = fs.statSync(moving).mode & 0o777;
          fs.chmodSync(moving, 0o755); fs.renameSync(moving, outside); fs.chmodSync(outside, priorMode);
        }
      }
      return fd;
    }) as typeof fs.openSync);
    try {
      const report = await sweepAttemptTemps(f.store, { now: () => NOW, maxRoots: 1, state: async () => "expired", scan: emptyScan, references: async () => true });
      expect(injected).toBeTrue(); expect(report.removed).toBe(0);
      expect(f.store.has(f.directory)).toBeTrue();
      const trash = JSON.parse(fs.readFileSync(attemptTempJournalPath(f.directory), "utf8")).trash;
      const cache = path.join(trash, "module-cache");
      const retained = kind === "keep" ? cache : kind === "move-ancestor" ? path.join(outside, "deep") : outside;
      expect(fs.statSync(retained).mode & 0o777).toBe(0o555);
      expect(fs.readFileSync(path.join(kind === "keep" ? cache : outside, "payload"), "utf8")).toBe("cache");
      if (kind === "keep") expect(fs.readFileSync(path.join(cache, ".delegatus-keep"), "utf8")).toBe("pin");
    } finally { open.mockRestore(); f.store.close(); }
  });

test.skipIf(process.platform !== "linux")("permission repair observes a late bind mount identity on the same device", async () => {
  const f = fixture(), nativeRead = fs.readFileSync.bind(fs), nativeOpen = fs.openSync.bind(fs);
  let mountedFd: number | undefined;
  const open = spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
    const fd = nativeOpen(file, flags, mode);
    if (String(file).startsWith("/proc/self/fd/") && String(file).endsWith("/module-cache")) mountedFd = fd;
    return fd;
  }) as typeof fs.openSync);
  const read = spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, options?: unknown) => {
    const value = nativeRead(file, options as BufferEncoding);
    if (mountedFd !== undefined && String(file) === `/proc/self/fdinfo/${mountedFd}`)
      return String(value).replace(/mnt_id:\s*\d+/, "mnt_id:\t2147483647");
    return value;
  }) as typeof fs.readFileSync);
  try {
    const report = await sweepAttemptTemps(f.store, { now: () => NOW, maxRoots: 1, state: async () => "expired", scan: emptyScan, references: async () => true });
    expect(mountedFd).toBeDefined(); expect(report.removed).toBe(0);
    const trash = JSON.parse(fs.readFileSync(attemptTempJournalPath(f.directory), "utf8")).trash;
    expect(fs.statSync(path.join(trash, "module-cache")).mode & 0o777).toBe(0o555);
    expect(fs.readFileSync(path.join(trash, "module-cache/payload"), "utf8")).toBe("cache");
  } finally { read.mockRestore(); open.mockRestore(); f.store.close(); }
});
