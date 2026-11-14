import { plantKeepMarker, removeKeepMarkers } from "./keepMarker.testSupport";
import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { attemptTempJournalPath } from "@/lib/tempSweep";
import { TemporaryDataStore, type TemporaryDataCandidate } from "./temporaryDataStore";
import { sweepTemporaryData, temporaryDataProtection, TEMPORARY_DATA_RETENTION_MS as WEEK, type TemporaryDataPorts } from "./temporaryDataRetention";

const roots: string[] = [], stores: TemporaryDataStore[] = [];
const NOW = Date.UTC(2035, 0, 15);
afterEach(() => { removeKeepMarkers(); for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture(directory = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "temporary-retention-")); roots.push(root);
  const scope = path.join(root, "evidence"), candidate = path.join(scope, "lane", directory ? "captures" : "capture.png");
  fs.mkdirSync(path.dirname(candidate), { recursive: true });
  if (directory) { fs.mkdirSync(candidate); fs.writeFileSync(path.join(candidate, "screen.png"), "capture"); }
  else fs.writeFileSync(candidate, "capture");
  const store = new TemporaryDataStore(path.join(root, "retention.sqlite")); stores.push(store);
  const stat = fs.lstatSync(candidate);
  const row: TemporaryDataCandidate = { directory: candidate, scope, kind: "lane-evidence", owner: "lane-fixture", identity: `${stat.dev}:${stat.ino}`,
    adoptedAt: NOW - WEEK - 1, checkedAt: 0, bytes: 0, reason: "fixture" };
  store.register(row);
  const ports: TemporaryDataPorts = { now: () => NOW, mounts: () => [], claim: async () => () => {},
    authority: async () => ({ expiresAt: NOW - 1, reason: "young", revision: "one", current: () => true }), references: async () => true };
  return { root, store, row, ports };
}

async function runRecovery(f: ReturnType<typeof fixture>, mode: string, time: number) {
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "temporaryDataRetention.fixture.ts"), f.store.filename, mode, String(time)], { stdout: "pipe", stderr: "pipe" });
  const [output, error] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(await child.exited, error).toBe(0);
  return output;
}

function trashOf(f: ReturnType<typeof fixture>) {
  return (JSON.parse(fs.readFileSync(attemptTempJournalPath(f.row.directory), "utf8")) as { trash: string }).trash;
}

for (const replay of [false, true]) {
  for (const mode of [0o555, 0o600]) {
    test(`permission hold restores the owner path (mode=${mode.toString(8)}, replay=${replay})`, async () => {
      const f = fixture(), inode = fs.lstatSync(f.row.directory).ino;
      const cache = path.join(f.row.directory, "gomod");
      fs.mkdirSync(cache); fs.writeFileSync(path.join(cache, "module"), "retained module");
      let target = f.row.directory;
      if (replay) {
        expect(await runRecovery(f, "crash", NOW)).toBe("quarantined\n");
        target = trashOf(f);
      }
      fs.chmodSync(path.join(target, "gomod"), mode);
      try {
        // Reproduce a legacy native-removal failure with its real intent left
        // behind, then recover in a new process with a reopened ledger.
        if (replay) await expect(fs.promises.rm(target, { recursive: true, force: true })).rejects.toMatchObject({ code: "EACCES" });
        for (const time of [NOW + 60001, NOW + 120002]) {
          const report = JSON.parse(await runRecovery(f, "recover", time));
          expect(report).toMatchObject({ checked: 1, removed: 0, kept: { "permission-repair-needed": 1 } });
          expect(fs.lstatSync(f.row.directory).ino).toBe(inode);
          expect(fs.statSync(cache).mode & 0o777).toBe(mode);
          // Reading a child of a directory without search permission must wait
          // until the test restores that permission in its cleanup.
          if (mode === 0o555) expect(fs.readFileSync(path.join(cache, "module"), "utf8")).toBe("retained module");
          expect(f.store.get(f.row.directory)?.reason).toBe("permission-repair-needed");
          expect(fs.readdirSync(path.dirname(f.row.directory)).filter(name => name.startsWith(".delegatus-trash-") || name.startsWith(".delegatus-sweep-"))).toEqual([]);
        }
      } finally {
        for (const current of new Set([target, f.row.directory, ...(fs.existsSync(attemptTempJournalPath(f.row.directory)) ? [trashOf(f)] : [])])) {
          if (fs.existsSync(path.join(current, "gomod"))) fs.chmodSync(path.join(current, "gomod"), 0o755);
        }
      }
      expect(fs.readFileSync(path.join(cache, "module"), "utf8")).toBe("retained module");
      expect(JSON.parse(await runRecovery(f, "recover", NOW + 180003))).toMatchObject({ removed: 1, errors: 0 });
      expect(f.store.get(f.row.directory)).toBeNull();
    });
  }
}

test.each([true, false])("crash after durable intent before rename recovers (directory=%s)", async directory => {
  const f = fixture(directory), inode = fs.lstatSync(f.row.directory).ino;
  expect(await runRecovery(f, "crash-before-rename", NOW)).toBe("intent-written\n");
  expect(fs.lstatSync(f.row.directory).ino).toBe(inode);
  const trash = trashOf(f);
  expect(fs.existsSync(trash)).toBeFalse();
  expect(JSON.parse(await runRecovery(f, "recover", NOW + 60001))).toMatchObject({ removed: 1, errors: 0 });
  expect(JSON.parse(await runRecovery(f, "recover", NOW + 120002))).toMatchObject({ checked: 0, removed: 0, errors: 0 });
  expect(fs.existsSync(f.row.directory)).toBeFalse();
  expect(fs.existsSync(attemptTempJournalPath(f.row.directory))).toBeFalse();
  expect(f.store.get(f.row.directory)).toBeNull();
});

test("preservation written during downtime restores the quarantined owner path", async () => {
  const f = fixture(), inode = fs.lstatSync(f.row.directory).ino;
  expect(await runRecovery(f, "crash", NOW)).toBe("quarantined\n");
  const trash = trashOf(f), backup = "only preservation record\n";
  fs.writeFileSync(path.join(trash, "worktree-backup.json"), backup);
  for (const time of [NOW + 60001, NOW + 120002]) {
    expect(JSON.parse(await runRecovery(f, "recover", time))).toMatchObject({ removed: 0, errors: 1, kept: { "preservation-record": 1 } });
    expect(fs.lstatSync(f.row.directory).ino).toBe(inode);
    expect(fs.readFileSync(path.join(f.row.directory, "screen.png"), "utf8")).toBe("capture");
    expect(fs.readFileSync(path.join(f.row.directory, "worktree-backup.json"), "utf8")).toBe(backup);
    expect(fs.existsSync(trash)).toBeFalse();
    expect(fs.existsSync(attemptTempJournalPath(f.row.directory))).toBeFalse();
  }
  fs.unlinkSync(path.join(f.row.directory, "worktree-backup.json"));
  expect(JSON.parse(await runRecovery(f, "recover", NOW + 180003))).toMatchObject({ removed: 1, errors: 0 });
  expect(f.store.get(f.row.directory)).toBeNull();
});

for (const directory of [true, false]) {
  test(`a refusal thrown after quarantine restores before releasing the claim (directory=${directory})`, async () => {
    const f = fixture(directory), inode = fs.lstatSync(f.row.directory).ino;
    let calls = 0, released = false;
    const report = await sweepTemporaryData(f.store, { ...f.ports,
      references: async () => { if (++calls === 2) throw new Error("references-unavailable"); return true; },
      claim: async () => () => {
        expect(fs.lstatSync(f.row.directory).ino).toBe(inode);
        expect(fs.existsSync(attemptTempJournalPath(f.row.directory))).toBeFalse();
        released = true;
      },
    });
    expect(calls).toBe(2); expect(released).toBeTrue();
    expect(report).toMatchObject({ removed: 0, errors: 1, kept: { "references-unavailable": 1 } });
    expect(JSON.parse(await runRecovery(f, "recover", NOW + 60001))).toMatchObject({ removed: 1, errors: 0 });
  });

  for (const mode of ["crash-before-rename", "crash"]) {
    test(`dry-run preserves the ${mode} intent (directory=${directory})`, async () => {
      const f = fixture(directory);
      await runRecovery(f, mode, NOW);
      const journal = attemptTempJournalPath(f.row.directory), before = fs.readFileSync(journal, "utf8");
      const target = mode === "crash" ? trashOf(f) : f.row.directory, inode = fs.lstatSync(target).ino;
      const report = await sweepTemporaryData(f.store, { ...f.ports, now: () => NOW + 60001, mode: "dry-run",
        claim: async () => { throw new Error("dry-run claimed"); },
      });
      expect(report.removed).toBe(0);
      expect(fs.lstatSync(target).ino).toBe(inode);
      expect(fs.readFileSync(journal, "utf8")).toBe(before);
    });
  }

  test(`replay leaves a replaced trash identity and its journal untouched (directory=${directory})`, async () => {
    const f = fixture(directory);
    await runRecovery(f, "crash", NOW);
    const trash = trashOf(f), journal = attemptTempJournalPath(f.row.directory), before = fs.readFileSync(journal, "utf8");
    fs.renameSync(trash, trash + "-original");
    fs.writeFileSync(trash, "replacement");
    for (const time of [NOW + 60001, NOW + 120002]) {
      expect(JSON.parse(await runRecovery(f, "recover", time)).removed).toBe(0);
      expect(fs.existsSync(f.row.directory)).toBeFalse();
      expect(fs.readFileSync(trash, "utf8")).toBe("replacement");
      expect(fs.readFileSync(directory ? path.join(trash + "-original", "screen.png") : trash + "-original", "utf8")).toBe("capture");
      expect(fs.readFileSync(journal, "utf8")).toBe(before);
    }
  });

  for (const mode of ["references-held", "references-error", "authority-error"]) {
    test(`replay restores pre-dispatch ${mode} and later retires (directory=${directory})`, async () => {
      const f = fixture(directory), inode = fs.lstatSync(f.row.directory).ino;
      expect(await runRecovery(f, "crash", NOW)).toBe("quarantined\n");
      const trash = trashOf(f), reason = mode === "references-held" ? "live-reference" : mode === "references-error" ? "references-unavailable" : "authority-unavailable";
      for (const time of [NOW + 60001, NOW + 120002]) {
        expect(JSON.parse(await runRecovery(f, mode, time))).toMatchObject({ removed: 0, errors: mode === "references-held" ? 0 : 1, kept: { [reason]: 1 } });
        expect(fs.lstatSync(f.row.directory).ino).toBe(inode);
        expect(fs.readFileSync(directory ? path.join(f.row.directory, "screen.png") : f.row.directory, "utf8")).toBe("capture");
        expect(fs.existsSync(trash)).toBeFalse();
        expect(fs.existsSync(attemptTempJournalPath(f.row.directory))).toBeFalse();
      }
      expect(JSON.parse(await runRecovery(f, "recover", NOW + 180003))).toMatchObject({ removed: 1, errors: 0 });
    });
  }

  test(`a crash after restoration completes intent cancellation (directory=${directory})`, async () => {
    const f = fixture(directory), inode = fs.lstatSync(f.row.directory).ino;
    expect(await runRecovery(f, "crash", NOW)).toBe("quarantined\n");
    expect(await runRecovery(f, "crash-after-restore", NOW + 60001)).toBe("restored\n");
    expect(fs.lstatSync(f.row.directory).ino).toBe(inode);
    expect(fs.existsSync(attemptTempJournalPath(f.row.directory))).toBeTrue();
    expect(JSON.parse(await runRecovery(f, "recover", NOW + 120002))).toMatchObject({ removed: 1, errors: 0 });
    expect(fs.existsSync(attemptTempJournalPath(f.row.directory))).toBeFalse();
  });

  for (const control of ["replacement", "preservation", "binding", "both-paths"]) {
    test(`pre-rename recovery preserves ${control} (directory=${directory})`, async () => {
      const f = fixture(directory);
      expect(await runRecovery(f, "crash-before-rename", NOW)).toBe("intent-written\n");
      const journal = attemptTempJournalPath(f.row.directory), trash = trashOf(f), before = fs.readFileSync(journal, "utf8");
      if (control === "replacement") {
        fs.renameSync(f.row.directory, f.row.directory + "-original");
        if (directory) { fs.mkdirSync(f.row.directory); fs.writeFileSync(path.join(f.row.directory, "screen.png"), "replacement"); }
        else fs.writeFileSync(f.row.directory, "replacement");
      } else if (control === "preservation") plantKeepMarker(path.join(f.row.scope, ".delegatus-keep"), "hold");
      else if (control === "binding") fs.writeFileSync(journal, JSON.stringify({ ...JSON.parse(before), identity: "changed" }));
      else fs.writeFileSync(trash, "conflicting trash");
      const expectedJournal = fs.readFileSync(journal, "utf8"), inode = fs.lstatSync(f.row.directory).ino;
      for (const time of [NOW + 60001, NOW + 120002]) {
        const report = JSON.parse(await runRecovery(f, "recover", time));
        expect(report.removed).toBe(0); expect(report.errors).toBe(1);
        expect(fs.lstatSync(f.row.directory).ino).toBe(inode);
        expect(fs.readFileSync(directory ? path.join(f.row.directory, "screen.png") : f.row.directory, "utf8")).toBe(control === "replacement" ? "replacement" : "capture");
        if (control === "preservation") {
          expect(report.kept["keep-marker"]).toBe(1);
          expect(fs.existsSync(journal)).toBeFalse();
        } else expect(fs.readFileSync(journal, "utf8")).toBe(expectedJournal);
      }
      if (control === "preservation") {
        removeKeepMarkers();
        expect(JSON.parse(await runRecovery(f, "recover", NOW + 180003))).toMatchObject({ removed: 1, errors: 0 });
      }
    });
  }
}

test.each([false, true])("a native removal failure retains partial-removal custody until replay (replay=%s)", async replay => {
  const f = fixture(), remove = fs.promises.rm;
  if (replay) await runRecovery(f, "crash", NOW);
  let trash = "";
  const spy = spyOn(fs.promises, "rm").mockImplementation(async (target, options) => {
    if (String(target).includes(".delegatus-trash-")) {
      trash = String(target); fs.unlinkSync(path.join(trash, "screen.png"));
      throw new Error("native-removal-interrupted");
    }
    return remove(target, options);
  });
  try {
    expect(await sweepTemporaryData(f.store, { ...f.ports, now: () => NOW + (replay ? 60001 : 0) })).toMatchObject({ removed: 0, errors: 1, kept: { "native-removal-interrupted": 1 } });
    expect(fs.existsSync(f.row.directory)).toBeFalse();
    expect(fs.existsSync(trash)).toBeTrue();
    expect(fs.existsSync(attemptTempJournalPath(f.row.directory))).toBeTrue();
  } finally { spy.mockRestore(); }
  expect(JSON.parse(await runRecovery(f, "recover", NOW + 120002))).toMatchObject({ removed: 1, errors: 0 });
  expect(fs.existsSync(trash)).toBeFalse();
  expect(fs.existsSync(attemptTempJournalPath(f.row.directory))).toBeFalse();
});

test.each([true, false])("expired evidence is removed through a journal (directory=%s)", async directory => {
  const f = fixture(directory);
  const report = await sweepTemporaryData(f.store, f.ports);
  expect(report.removed).toBe(1); expect(report.removedBytes).toBeGreaterThan(0);
  expect(fs.existsSync(f.row.directory)).toBeFalse(); expect(fs.existsSync(attemptTempJournalPath(f.row.directory))).toBeFalse();
  expect(f.store.get(f.row.directory)).toBeNull();
});

test.each([true, false])("dry-run leaves every candidate and journal untouched (directory=%s)", async directory => {
  const f = fixture(directory), before = fs.lstatSync(f.row.directory);
  const report = await sweepTemporaryData(f.store, { ...f.ports, mode: "dry-run", claim: async () => { throw new Error("dry-run claimed"); } });
  expect(report.wouldRemove).toBe(1); expect(report.removed).toBe(0);
  expect(fs.lstatSync(f.row.directory).ino).toBe(before.ino); expect(fs.existsSync(attemptTempJournalPath(f.row.directory))).toBeFalse();
});

test.each(["young", "open-lane", "owner-missing"])("%s authority retains evidence", async reason => {
  const f = fixture();
  const report = await sweepTemporaryData(f.store, { ...f.ports, authority: async () => ({ expiresAt: reason === "young" ? NOW + 1 : null, reason, revision: "one", current: () => true }) });
  expect(report.removed).toBe(0); expect(report.kept[reason]).toBe(1); expect(fs.existsSync(f.row.directory)).toBeTrue();
});

test.each(["ancestor", "descendant"])("a %s keep marker retains evidence", async where => {
  const f = fixture(); plantKeepMarker(path.join(where === "ancestor" ? path.dirname(f.row.directory) : f.row.directory, ".delegatus-keep"), "keep");
  const report = await sweepTemporaryData(f.store, f.ports);
  expect(report.removed).toBe(0); expect(report.kept["keep-marker"]).toBe(1);
});

test.each(["worktree", "worktree-backup.json", "bundles", ".git"])("%s preservation survives", async name => {
  const f = fixture(); fs.writeFileSync(path.join(f.row.directory, name), "only copy");
  const report = await sweepTemporaryData(f.store, f.ports);
  expect(report.removed).toBe(0); expect(report.kept["preservation-record"]).toBe(1);
  expect(fs.readFileSync(path.join(f.row.directory, name), "utf8")).toBe("only copy");
});

test("an embedded lifecycle journal keeps its containing candidate", async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.row.directory, `.delegatus-sweep-${"b".repeat(64)}.json`), "recovery owner");
  const report = await sweepTemporaryData(f.store, f.ports);
  expect(report.removed).toBe(0); expect(report.kept["lifecycle-control"]).toBe(1);
  expect(fs.existsSync(f.row.directory)).toBeTrue();
});

test.each(["claim", "initial-authority", "references", "dispatch-authority"])("revocation at %s prevents removal", async seam => {
  const f = fixture(); let allowed = true, authorities = 0;
  const report = await sweepTemporaryData(f.store, { ...f.ports,
    claim: async () => { if (seam === "claim") allowed = false; return () => {}; },
    authority: async () => { authorities++; if (seam === "initial-authority" || seam === "dispatch-authority" && authorities === 2) allowed = false;
      return { expiresAt: allowed ? NOW - 1 : null, reason: "open-lane", revision: "one", current: () => allowed }; },
    references: async () => { if (seam === "references") allowed = false; return true; },
  });
  expect(report.removed).toBe(0); expect(fs.existsSync(f.row.directory)).toBeTrue();
  expect(fs.existsSync(attemptTempJournalPath(f.row.directory))).toBeFalse();
});

test("a keep marker planted during the last protection listing blocks dispatch", async () => {
  const f = fixture(), marker = path.join(f.row.scope, ".delegatus-keep");
  let mountReads = 0, armed = false, planted = false;
  const read = fs.readFileSync, original = fs.opendirSync;
  const readSpy = spyOn(fs, "readFileSync").mockImplementation(((file: unknown, ...args: unknown[]) => {
    const result = (read as (...values: unknown[]) => unknown)(file, ...args);
    if (String(file) === "/proc/self/mountinfo" && ++mountReads === 5) armed = true;
    return result;
  }) as typeof fs.readFileSync);
  const spy = spyOn(fs, "opendirSync").mockImplementation(((directory: fs.PathLike, ...args: unknown[]) => {
    const stream = (original as (...values: unknown[]) => fs.Dir).call(fs, directory, ...args);
    if (armed && !planted && String(directory).includes(".delegatus-trash-")) {
      plantKeepMarker(marker, "late hold"); planted = true;
    }
    return stream;
  }) as typeof fs.opendirSync);
  try {
    const identity = fs.lstatSync(f.row.directory).ino;
    const report = await sweepTemporaryData(f.store, { ...f.ports, mounts: undefined });
    expect(planted).toBeTrue(); expect(report.removed).toBe(0);
    expect(fs.lstatSync(f.row.directory).ino).toBe(identity); expect(fs.existsSync(attemptTempJournalPath(f.row.directory))).toBeFalse();
  } finally { spy.mockRestore(); readSpy.mockRestore(); }
});

test("last protection reads recheck descendant markers and authority before deletion", async () => {
  const f = fixture(), markerName = ".delegatus-keep";
  let mountReads = 0, armed = false, planted = false, allowed = true;
  const read = fs.readFileSync, original = fs.opendirSync;
  const readSpy = spyOn(fs, "readFileSync").mockImplementation(((file: unknown, ...args: unknown[]) => {
    const result = (read as (...values: unknown[]) => unknown)(file, ...args);
    if (String(file) === "/proc/self/mountinfo" && ++mountReads === 5) armed = true;
    return result;
  }) as typeof fs.readFileSync);
  const spy = spyOn(fs, "opendirSync").mockImplementation(((directory: fs.PathLike, ...args: unknown[]) => {
    const stream = (original as (...values: unknown[]) => fs.Dir).call(fs, directory, ...args);
    if (armed && !planted && String(directory).includes(".delegatus-trash-")) {
      const close = stream.closeSync.bind(stream);
      stream.closeSync = () => {
        close();
        plantKeepMarker(path.join(String(directory), markerName), "late hold");
        allowed = false;
        planted = true;
      };
    }
    return stream;
  }) as typeof fs.opendirSync);
  try {
    const inode = fs.lstatSync(f.row.directory).ino;
    const report = await sweepTemporaryData(f.store, { ...f.ports,
      authority: async () => ({ expiresAt: NOW - 1, reason: "expired", revision: "stable", current: () => allowed }),
      mounts: undefined,
    });
    expect(planted).toBeTrue(); expect(allowed).toBeFalse();
    expect(report).toMatchObject({ removed: 0, errors: 0 });
    expect(fs.lstatSync(f.row.directory).ino).toBe(inode);
    expect(fs.existsSync(path.join(f.row.directory, markerName))).toBeTrue();
    expect(fs.existsSync(attemptTempJournalPath(f.row.directory))).toBeFalse();
  } finally { spy.mockRestore(); readSpy.mockRestore(); }
});

test.each([true, false])("a keep marker appearing after quarantine restores the candidate (%s)", async directory => {
  const f = fixture(directory); let calls = 0;
  const report = await sweepTemporaryData(f.store, { ...f.ports, references: async (_row, target) => {
    if (++calls === 2) plantKeepMarker(path.join(path.dirname(target), ".delegatus-keep"), "new hold"); return true;
  } });
  expect(report.removed).toBe(0); expect(fs.existsSync(f.row.directory)).toBeTrue();
  expect(fs.existsSync(attemptTempJournalPath(f.row.directory))).toBeFalse();
});

test.each([true, false])("a keep marker created by the final mount read retains the same candidate (%s)", async directory => {
  const f = fixture(directory), marker = path.join(f.row.scope, ".delegatus-keep");
  const read = fs.readFileSync; let mountReads = 0, planted = false;
  const readSpy = spyOn(fs, "readFileSync").mockImplementation(((file: unknown, ...args: unknown[]) => {
    const result = (read as (...values: unknown[]) => unknown)(file, ...args);
    if (String(file) === "/proc/self/mountinfo" && ++mountReads === 4) { plantKeepMarker(marker, "keep"); planted = true; }
    return result;
  }) as typeof fs.readFileSync);
  try {
    const report = await sweepTemporaryData(f.store, { ...f.ports, mounts: undefined });
    expect(planted).toBeTrue(); expect(report.removed).toBe(0);
    expect(fs.existsSync(f.row.directory)).toBeTrue(); expect(fs.existsSync(marker)).toBeTrue();
  } finally { readSpy.mockRestore(); }
});

test("a replacement identity and a symlink never grant removal", async () => {
  const f = fixture(); fs.renameSync(f.row.directory, f.row.directory + "-old"); fs.symlinkSync(f.row.directory + "-old", f.row.directory);
  const report = await sweepTemporaryData(f.store, f.ports);
  expect(report.removed).toBe(0); expect(fs.readFileSync(path.join(f.row.directory, "screen.png"), "utf8")).toBe("capture");
});

test("a changed protection snapshot after a checkout observation retains the tree", async () => {
  const f = fixture();
  const report = await sweepTemporaryData(f.store, { ...f.ports, references: async () => { fs.writeFileSync(path.join(f.row.directory, "late.txt"), "late"); return true; } });
  expect(report.removed).toBe(0); expect(report.kept["fence-changed"]).toBe(1);
});

test.each([true, false])("revoking authority after quarantine restores the original identity (%s)", async directory => {
  const f = fixture(directory); let allowed = true, calls = 0;
  const report = await sweepTemporaryData(f.store, { ...f.ports,
    authority: async () => ({ expiresAt: NOW - 1, reason: "open-lane", revision: "one", current: () => allowed }),
    references: async () => { if (++calls === 2) allowed = false; return true; },
  });
  expect(report.removed).toBe(0); expect(fs.lstatSync(f.row.directory).ino.toString()).toBe(f.row.identity.split(":")[1]);
  expect(fs.existsSync(attemptTempJournalPath(f.row.directory))).toBeFalse();
});

test("live references retain evidence and later due work progresses", async () => {
  const f = fixture();
  const second = { ...f.row, directory: path.join(path.dirname(f.row.directory), "second"), owner: "second" };
  fs.mkdirSync(second.directory); const stat = fs.lstatSync(second.directory); second.identity = `${stat.dev}:${stat.ino}`; f.store.register(second);
  const report = await sweepTemporaryData(f.store, { ...f.ports, references: async row => row.owner === "second" });
  expect(report.checked).toBe(2); expect(report.removed).toBe(1); expect(fs.existsSync(f.row.directory)).toBeTrue();
});

test("young rows schedule at expiry and leave admission for later eligible work", async () => {
  const f = fixture(false);
  const expired = path.join(path.dirname(f.row.directory), "zz-expired.png");
  fs.renameSync(f.row.directory, expired); f.store.forget(f.row.directory); f.row.directory = expired; f.store.register(f.row);
  for (let i = 0; i < 40; i++) {
    const directory = path.join(path.dirname(f.row.directory), `young-${i}`); fs.writeFileSync(directory, "evidence");
    const stat = fs.lstatSync(directory); f.store.register({ ...f.row, directory, owner: "young", identity: `${stat.dev}:${stat.ino}` });
  }
  const report = await sweepTemporaryData(f.store, { ...f.ports, authority: async row => ({ expiresAt: row.owner === "young" ? NOW + WEEK : NOW - 1,
    reason: "young", revision: "fixture", current: () => true }) });
  expect(report).toMatchObject({ checked: 41, removed: 1, errors: 0 });
  expect(f.store.get(path.join(path.dirname(f.row.directory), "young-0"))?.checkedAt).toBe(NOW + WEEK);
});

test("a bounded protection walk refuses large trees and expires its budget", () => {
  const f = fixture(); let time = 0;
  expect(() => temporaryDataProtection(f.row, f.row.directory, () => ++time, 2)).toThrow("protection-budget");
});

test("a flat legacy evidence copy exceeding ten thousand captures can retire", async () => {
  const f = fixture();
  for (let i = 0; i < 10001; i++) fs.writeFileSync(path.join(f.row.directory, `capture-${i}.png`), "");
  const report = await sweepTemporaryData(f.store, { ...f.ports, budgetMs: 20000 });
  expect(report).toMatchObject({ removed: 1, errors: 0 }); expect(fs.existsSync(f.row.directory)).toBeFalse();
});

test("adoption clocks and due checkpoints survive reopening the real ledger", async () => {
  const f = fixture(); const name = f.store.filename;
  f.store.record(f.row.directory, NOW + 1, 4096, "young"); f.store.close(); stores.splice(stores.indexOf(f.store), 1);
  const store = new TemporaryDataStore(name); stores.push(store);
  expect(store.get(f.row.directory)?.adoptedAt).toBe(NOW - WEEK - 1);
  expect(await sweepTemporaryData(store, f.ports)).toMatchObject({ checked: 0, removed: 0 });
  expect(await sweepTemporaryData(store, { ...f.ports, now: () => NOW + 1 })).toMatchObject({ checked: 1, removed: 1 });
});

test.each([true, false])("a new process recovers the real quarantine writer's intent (directory=%s)", async directory => {
  const f = fixture(directory);
  const run = async (mode: string, time: number) => {
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "temporaryDataRetention.fixture.ts"), f.store.filename, mode, String(time)], { stdout: "pipe", stderr: "pipe" });
    const [output, error] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(await child.exited, error).toBe(0); return output;
  };
  expect(await run("crash", NOW)).toBe("quarantined\n");
  expect(fs.existsSync(attemptTempJournalPath(f.row.directory))).toBeTrue(); expect(fs.existsSync(f.row.directory)).toBeFalse();
  expect(JSON.parse(await run("recover", NOW + 60001))).toMatchObject({ removed: 1, errors: 0 });
  expect(fs.existsSync(attemptTempJournalPath(f.row.directory))).toBeFalse(); expect(f.store.get(f.row.directory)).toBeNull();
});

test("quarantine replay restores the same identity when a keep marker appears at final dispatch", async () => {
  const f = fixture(true), run = async (mode: string, time: number) => {
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "temporaryDataRetention.fixture.ts"), f.store.filename, mode, String(time)], { stdout: "pipe", stderr: "pipe" });
    const [output, error] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(await child.exited, error).toBe(0); return output;
  };
  expect(await run("crash", NOW)).toBe("quarantined\n");
  const before = JSON.parse(fs.readFileSync(attemptTempJournalPath(f.row.directory), "utf8")) as { trash: string };
  const marker = path.join(f.row.scope, ".delegatus-keep"), read = fs.readFileSync;
  let mountReads = 0, planted = false;
  const readSpy = spyOn(fs, "readFileSync").mockImplementation(((file: unknown, ...args: unknown[]) => {
    const result = (read as (...values: unknown[]) => unknown)(file, ...args);
    if (String(file) === "/proc/self/mountinfo" && ++mountReads === 4) { plantKeepMarker(marker, "keep"); planted = true; }
    return result;
  }) as typeof fs.readFileSync);
  try {
    const report = await sweepTemporaryData(f.store, { ...f.ports, now: () => NOW + 60001, mounts: undefined });
    expect(planted).toBeTrue(); expect(report.removed).toBe(0);
    expect(fs.existsSync(f.row.directory)).toBeTrue(); expect(fs.lstatSync(f.row.directory).ino).toBe(Number(f.row.identity.split(":")[1]));
    expect(fs.existsSync(before.trash)).toBeFalse(); expect(fs.existsSync(attemptTempJournalPath(f.row.directory))).toBeFalse();
  } finally { readSpy.mockRestore(); }
});

test.each([true, false])("a restarted process restores evidence when authority is revoked (directory=%s)", async directory => {
  const f = fixture(directory);
  for (const [mode, time] of [["crash", NOW], ["recover-held", NOW + 60001]] as const) {
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "temporaryDataRetention.fixture.ts"), f.store.filename, mode, String(time)], { stdout: "pipe", stderr: "pipe" });
    const [output, error] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(await child.exited, error).toBe(0);
    if (mode === "recover-held") expect(JSON.parse(output)).toMatchObject({ removed: 0, errors: 0 });
  }
  expect(fs.existsSync(f.row.directory)).toBeTrue(); expect(fs.existsSync(attemptTempJournalPath(f.row.directory))).toBeFalse();
});

test.each([true, false])("a restart settles the real post-removal journal without a surviving resource (%s)", async directory => {
  const f = fixture(directory);
  for (const [mode, time] of [["crash-after-remove", NOW], ["recover", NOW + 60001]] as const) {
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "temporaryDataRetention.fixture.ts"), f.store.filename, mode, String(time)], { stdout: "pipe", stderr: "pipe" });
    const [output, error] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(await child.exited, error).toBe(0);
    if (mode === "recover") expect(JSON.parse(output)).toMatchObject({ removed: 0, errors: 0 });
  }
  expect(f.store.get(f.row.directory)).toBeNull(); expect(fs.existsSync(attemptTempJournalPath(f.row.directory))).toBeFalse();
});
