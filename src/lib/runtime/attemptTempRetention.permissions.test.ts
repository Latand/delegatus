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
