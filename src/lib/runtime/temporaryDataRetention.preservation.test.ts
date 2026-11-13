import { plantKeepMarker, removeKeepMarkers } from "./keepMarker.testSupport";
import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { TemporaryDataStore } from "./temporaryDataStore";
import { sweepTemporaryData } from "./temporaryDataRetention";
import { attemptTempJournalPath, removeTreeViaTrash } from "@/lib/tempSweep";
import * as treeSweep from "@/lib/tempSweep";

// A replay fixture must cross the irreversible-removal boundary. A refusal
// before started() now restores the original root and clears its journal (W4).
const roots: string[] = [], stores: TemporaryDataStore[] = [];
afterEach(() => { removeKeepMarkers();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

// Complete a real cross-process write after the queue's empty read and before
// the final readiness poll. Wrap only the production dispatch callbacks so
// earlier held/validate probes cannot consume the injection on either path.
for (const replay of [false, true]) for (const mutation of ["none", "backup", "unrelated"]) {
  test(`final queue readiness: ${mutation} (replay=${replay})`, async () => {
    const lateBackup = mutation === "backup";
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "retention-final-queue-")); roots.push(root);
    const scope = path.join(root, "evidence"), directory = path.join(scope, "captures");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "payload"), "capture bytes");
    const stat = fs.lstatSync(directory), journal = attemptTempJournalPath(directory);
    let store = new TemporaryDataStore(path.join(root, "ledger.sqlite")); stores.push(store);
    store.register({ directory, scope, kind: "lane-evidence", owner: "fixture", identity: `${stat.dev}:${stat.ino}`,
      adoptedAt: 0, checkedAt: 0, bytes: 0, reason: "fixture" });
    if (replay) {
      await expect(removeTreeViaTrash(directory, { journal, disposable: true, held: () => false,
        remove: async (_trash, started) => { started(); throw new Error("fixture interrupted removal"); }
      })).rejects.toThrow("fixture interrupted removal");
      store.close(); stores.splice(stores.indexOf(store), 1);
      store = new TemporaryDataStore(path.join(root, "ledger.sqlite")); stores.push(store);
    }
    const read = fs.readSync;
    let observed = false, trash = "", inFinalDispatch = false;
    const finalDispatch = (dispatch: (current: string) => boolean) => (current: string) => {
      inFinalDispatch = true;
      try { return dispatch(current); }
      finally { inFinalDispatch = false; }
    };
    const remove = treeSweep.removeTreeViaTrash, finish = treeSweep.finishTreeTrash;
    const freshSpy = spyOn(treeSweep, "removeTreeViaTrash").mockImplementation((target, options) =>
      remove(target, { ...options, dispatch: options.dispatch && finalDispatch(options.dispatch) }));
    const replaySpy = spyOn(treeSweep, "finishTreeTrash").mockImplementation((intent, held, nativeRemove, validate, disposable, dispatch) =>
      finish(intent, held, nativeRemove, validate, disposable, dispatch && finalDispatch(dispatch)));
    const queueSpy = spyOn(fs, "readSync").mockImplementation(((...args: unknown[]) => {
      try { return (read as (...values: unknown[]) => unknown)(...args); }
      catch (error) {
        if (!observed && inFinalDispatch && (error as NodeJS.ErrnoException).code === "EAGAIN") {
          observed = true;
          trash = JSON.parse(fs.readFileSync(journal, "utf8")).trash;
          if (mutation !== "none") execFileSync(process.execPath, ["-e",
            'require("node:fs").writeFileSync(process.argv[1], "irreplaceable backup")',
            lateBackup ? path.join(trash, "worktree-backup.json") : path.join(root, "unrelated-log")]);
        }
        throw error;
      }
    }) as typeof fs.readSync);
    try {
      const report = await sweepTemporaryData(store, { now: () => 2000000000000, mounts: () => [],
        claim: async () => () => {}, references: async () => true,
        authority: async () => ({ expiresAt: 1, reason: "expired", revision: "fixture", current: () => true }) });
      expect(observed).toBeTrue();
      expect(report.errors).toBe(0);
      expect(report.removed).toBe(lateBackup ? 0 : 1);
      expect(fs.existsSync(journal)).toBeFalse();
      expect(fs.existsSync(trash)).toBeFalse();
      if (lateBackup) {
        expect(report.kept["fence-changed"]).toBe(1);
        expect(fs.lstatSync(directory).ino).toBe(stat.ino);
        expect(fs.readFileSync(path.join(directory, "payload"), "utf8")).toBe("capture bytes");
        expect(fs.readFileSync(path.join(directory, "worktree-backup.json"), "utf8")).toBe("irreplaceable backup");
        expect(store.get(directory)?.identity).toBe(`${stat.dev}:${stat.ino}`);
      } else {
        expect(fs.existsSync(directory)).toBeFalse();
        expect(store.get(directory)).toBeNull();
        if (mutation === "unrelated") expect(fs.readFileSync(path.join(root, "unrelated-log"), "utf8")).toBe("irreplaceable backup");
      }
    } finally { queueSpy.mockRestore(); replaySpy.mockRestore(); freshSpy.mockRestore(); }
  });
}

// Reproduces the independent review with the real ledger, quarantine writer
// and native remover. Each control changes one proof independently.
for (const replay of [false, true]) for (const seam of ["close", "authority"]) for (const mutation of ["marker", "ancestor-marker", "authority", "backup", "nested-backup", "checkout", "content", "queue-unavailable", "queue-overflow", "none"]) {
  test(`final ${seam} fence: ${mutation} (replay=${replay})`, async () => {
   const root = fs.mkdtempSync(path.join(os.tmpdir(), "retention-preservation-")); roots.push(root);
   const scope = path.join(root, "evidence"), directory = path.join(scope, "lane", "captures");
   fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, "capture.png"), "capture");
   const nested = path.join(directory, "nested"), checkout = path.join(root, "checkout");
   fs.mkdirSync(nested); fs.linkSync(path.join(directory, "capture.png"), path.join(root, "outside-link")); fs.mkdirSync(checkout); fs.mkdirSync(path.join(checkout, ".git"));
   const stat = fs.lstatSync(directory), journal = attemptTempJournalPath(directory);
   let store = new TemporaryDataStore(path.join(root, "ledger.sqlite")); stores.push(store);
   store.register({ directory, scope, kind: "lane-evidence", owner: "fixture", identity: `${stat.dev}:${stat.ino}`,
     adoptedAt: 0, checkedAt: 0, bytes: 0, reason: "fixture" });
   if (replay) {
     await expect(removeTreeViaTrash(directory, { journal, disposable: true, held: () => false,
       remove: async (_trash, started) => { started(); throw new Error("fixture interruption during native removal"); }
     })).rejects.toThrow("fixture interruption");
     expect(fs.existsSync(journal)).toBeTrue();
     store.close(); stores.splice(stores.indexOf(store), 1);
     store = new TemporaryDataStore(path.join(root, "ledger.sqlite")); stores.push(store);
   }
   let mounts = 0, armed = false, closed = false, planted = false, allowed = true, plantedPath = "";
   const plant = () => {
     planted = true;
     if (mutation === "marker") plantKeepMarker(path.join(plantedPath, ".delegatus-keep"), "keep");
     if (mutation === "ancestor-marker") plantKeepMarker(path.join(scope, ".delegatus-keep"), "keep");
     if (mutation === "authority") allowed = false;
     if (mutation === "content") fs.writeFileSync(path.join(root, "outside-link"), "late content");
     if (mutation === "checkout") fs.symlinkSync(directory, path.join(checkout, "late-link"));
     if (mutation === "backup" || mutation === "nested-backup") {
       const target = mutation === "nested-backup" ? path.join(plantedPath, "nested") : plantedPath;
       fs.mkdirSync(path.join(target, "worktree"));
       fs.writeFileSync(path.join(target, "worktree", "only-copy.bundle"), "irreplaceable fixture backup");
       fs.writeFileSync(path.join(target, "worktree-backup.json"), "{}");
     }
   };
   const read = fs.readFileSync, open = fs.opendirSync, readQueue = fs.readSync;
   const queueSpy = spyOn(fs, "readSync").mockImplementation(((...args: unknown[]) => {
     if (planted && mutation === "queue-unavailable") throw Object.assign(new Error("fixture queue failure"), { code: "EIO" });
     if (planted && mutation === "queue-overflow") {
       const buffer = args[1] as Buffer;
       buffer.writeInt32LE(-1); buffer.writeUInt32LE(0x4000, 4); buffer.writeUInt32LE(0, 8); buffer.writeUInt32LE(0, 12);
       return 16;
     }
     return (readQueue as (...values: unknown[]) => unknown)(...args);
   }) as typeof fs.readSync);
   const mountSpy = spyOn(fs, "readFileSync").mockImplementation(((file: unknown, ...args: unknown[]) => {
     const value = (read as (...a: unknown[]) => unknown)(file, ...args);
     if (String(file) === "/proc/self/mountinfo" && ++mounts === 5) armed = true;
     return value;
   }) as typeof fs.readFileSync);
   const directorySpy = spyOn(fs, "opendirSync").mockImplementation(((file: fs.PathLike, ...args: unknown[]) => {
     const stream = (open as (...a: unknown[]) => fs.Dir)(file, ...args);
     if (armed && !closed && String(file).includes(".delegatus-trash-")) {
       const close = stream.closeSync.bind(stream);
       stream.closeSync = () => {
         close(); closed = true; plantedPath = path.basename(String(file)) === "nested" ? path.dirname(String(file)) : String(file);
         if (seam === "close") plant();
       };
     }
     return stream;
   }) as typeof fs.opendirSync);
   try {
     const report = await sweepTemporaryData(store, { now: () => 2000000000000, claim: async () => () => {}, references: async (_row, _target, inventory) => {
       await inventory.targets(checkout); return true;
     },
       authority: async () => ({ expiresAt: 1, reason: "expired", revision: "fixture", current: () => {
       if (closed && !planted && seam === "authority") plant();
       return allowed;
     } }) });
     expect(planted, JSON.stringify({ report, mounts, armed, closed })).toBeTrue();
     expect(report.errors).toBe(0);
     expect(report.removed).toBe(mutation === "none" ? 1 : 0);
     if (mutation === "none") {
       expect(fs.existsSync(directory)).toBeFalse();
       expect(store.get(directory)).toBeNull();
       return;
     }
     expect(fs.lstatSync(directory).ino).toBe(stat.ino);
     expect(fs.readFileSync(path.join(directory, "capture.png"), "utf8")).toBe(mutation === "content" ? "late content" : "capture");
     expect(fs.existsSync(journal)).toBeFalse();
     if (mutation === "backup" || mutation === "nested-backup") {
       const target = mutation === "nested-backup" ? path.join(directory, "nested") : directory;
       expect(fs.readFileSync(path.join(target, "worktree", "only-copy.bundle"), "utf8")).toBe("irreplaceable fixture backup");
       expect(fs.readFileSync(path.join(target, "worktree-backup.json"), "utf8")).toBe("{}");
     }
     if (mutation === "checkout") expect(fs.realpathSync(path.join(checkout, "late-link"))).toBe(directory);
   } finally { directorySpy.mockRestore(); mountSpy.mockRestore(); queueSpy.mockRestore(); }
  });
}

// The entry's hop/.. reaches the physical parent of hop's target. The final
// fence must observe that binding even after inventory validation has ended.
for (const replay of [false, true]) for (const binding of ["target", "hop", "parent", "lexical-target"]) for (const timing of ["early", "close", "authority", "none"]) {
  test(`checkout alias traversal: ${binding} ${timing} (replay=${replay})`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "retention-alias-")); roots.push(root);
    const scope = path.join(root, "evidence"), directory = path.join(scope, "lane", "captures");
    fs.mkdirSync(directory, { recursive: true });
    const content = Buffer.from([0, 1, 255, 10, 128]);
    fs.writeFileSync(path.join(directory, "capture.png"), content);
    const checkout = path.join(root, "checkout"), aliases = path.join(root, "aliases");
    const physical = path.join(root, "physical"), safe = path.join(root, "safe");
    fs.mkdirSync(path.join(checkout, ".git"), { recursive: true }); fs.mkdirSync(aliases);
    fs.mkdirSync(path.join(physical, "child"), { recursive: true }); fs.mkdirSync(safe);
    fs.symlinkSync(path.join(physical, "child"), path.join(aliases, "hop"));
    fs.symlinkSync(safe, path.join(physical, "target"));
    fs.symlinkSync("hop/../target", path.join(aliases, "entry"));
    fs.symlinkSync(binding === "lexical-target" ? `${aliases}/hop/../target` : path.join(aliases, "entry"), path.join(checkout, "dependency"));
    const stat = fs.lstatSync(directory), journal = attemptTempJournalPath(directory);
    let store = new TemporaryDataStore(path.join(root, "ledger.sqlite")); stores.push(store);
    store.register({ directory, scope, kind: "lane-evidence", owner: "fixture", identity: `${stat.dev}:${stat.ino}`,
      adoptedAt: 0, checkedAt: 0, bytes: 0, reason: "fixture" });
    if (replay) {
      await expect(removeTreeViaTrash(directory, { journal, disposable: true, held: () => false,
        remove: async (_trash, started) => { started(); throw new Error("fixture interruption during native removal"); }
      })).rejects.toThrow("fixture interruption");
      expect(fs.existsSync(journal)).toBeTrue();
      store.close(); stores.splice(stores.indexOf(store), 1);
      store = new TemporaryDataStore(path.join(root, "ledger.sqlite")); stores.push(store);
    }
    let mounts = 0, armed = false, closed = false, planted = false;
    const plant = () => {
      planted = true;
      if (binding === "target" || binding === "lexical-target") {
        fs.unlinkSync(path.join(physical, "target")); fs.symlinkSync(directory, path.join(physical, "target"));
      } else {
        const replacement = path.join(root, "replacement");
        fs.mkdirSync(path.join(replacement, "child"), { recursive: true });
        fs.symlinkSync(directory, path.join(replacement, "target"));
        if (binding === "hop") {
          fs.unlinkSync(path.join(aliases, "hop")); fs.symlinkSync(path.join(replacement, "child"), path.join(aliases, "hop"));
        } else {
          fs.renameSync(physical, path.join(root, "old-physical")); fs.symlinkSync(replacement, physical);
        }
      }
    };
    const read = fs.readFileSync, open = fs.opendirSync;
    const mountSpy = spyOn(fs, "readFileSync").mockImplementation(((file: unknown, ...args: unknown[]) => {
      const value = (read as (...a: unknown[]) => unknown)(file, ...args);
      if (String(file) === "/proc/self/mountinfo" && ++mounts === 5) {
        armed = true;
        if (timing === "early") plant();
      }
      return value;
    }) as typeof fs.readFileSync);
    const directorySpy = spyOn(fs, "opendirSync").mockImplementation(((file: fs.PathLike, ...args: unknown[]) => {
      const stream = (open as (...a: unknown[]) => fs.Dir)(file, ...args);
      if (armed && !closed && String(file).includes(".delegatus-trash-")) {
        const close = stream.closeSync.bind(stream);
        stream.closeSync = () => { close(); closed = true; if (timing === "close") plant(); };
      }
      return stream;
    }) as typeof fs.opendirSync);
    try {
      const report = await sweepTemporaryData(store, { now: () => 2000000000000, claim: async () => () => {},
        references: async (_row, target, inventory) => {
          const targets = await inventory.targets(checkout);
          return !targets.some(value => [directory, target].some(candidate => value === candidate || value.startsWith(candidate + path.sep)));
        }, authority: async () => ({ expiresAt: 1, reason: "expired", revision: "fixture", current: () => {
          if (closed && !planted && timing === "authority") plant();
          return true;
        } }) });
      expect(planted).toBe(timing !== "none");
      expect(report.errors).toBe(0);
      expect(report.removed).toBe(timing === "none" ? 1 : 0);
      expect(fs.existsSync(journal)).toBeFalse();
      if (timing === "none") {
        expect(fs.existsSync(directory)).toBeFalse();
        expect(store.get(directory)).toBeNull();
      } else {
        expect(fs.lstatSync(directory).ino).toBe(stat.ino);
        expect(fs.readFileSync(path.join(directory, "capture.png"))).toEqual(content);
        expect(store.get(directory)?.identity).toBe(`${stat.dev}:${stat.ino}`);
      }
    } finally { directorySpy.mockRestore(); mountSpy.mockRestore(); }
  });
}
