import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, spyOn, test } from "bun:test";
import { statePath } from "@/lib/configDir";
import { loadPipelines, savePipelines } from "@/lib/pipelines/store";
import { attemptTempJournalPath, removeTreeViaTrash } from "@/lib/tempSweep";
import { attemptTempAuthority } from "./attemptTempProduction";
import { AttemptTempStore, sweepAttemptTemps } from "./attemptTempRetention";
import { finishedLane } from "./attemptTempRetention.testSupport";
import { attemptMutationCurrent } from "./attemptMutationFence";
import { removeAttemptTree } from "./attemptTempFilesystem";
import { Database } from "bun:sqlite";
import { RecordedCheckStore } from "@/lib/recordedChecks/store";

const NOW = Date.parse("2030-01-20T00:00:00Z");

test.skipIf(process.platform !== "linux").each([false, true])(
  "a post-quarantine fence refusal restores consumer links in the same tick (recreate=%s)", async recreate => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "llv-trash-restore-"));
    cleanup.push(() => fs.rmSync(parent, { recursive: true, force: true }));
    const container = path.join(parent, "container"), directory = path.join(container, "llv-stage-expired");
    const consumer = path.join(parent, "consumer"), dependency = path.join(consumer, "node_modules/dependency");
    fs.mkdirSync(path.join(directory, "cache"), { recursive: true });
    fs.writeFileSync(path.join(directory, "cache/payload"), "expired");
    fs.mkdirSync(path.join(consumer, ".git"), { recursive: true });
    fs.mkdirSync(path.join(consumer, "node_modules"));
    const store = new AttemptTempStore(path.join(parent, "registry/owners.sqlite"));
    cleanup.push(() => store.close());
    store.register({ directory, pipelineId: null, launchId: "fixture", retainUntilClose: true, createdAt: 1 });
    const previousPath = process.env.PATH, bin = path.join(parent, "bin");
    fs.mkdirSync(bin);
    for (const command of ["find", "du"]) fs.symlinkSync(`/usr/bin/${command}`, path.join(bin, command));
    cleanup.push(() => { process.env.PATH = previousPath; });
    process.env.PATH = bin;
    const nativeStat = fs.lstatSync.bind(fs);
    let injected = false;
    const stat = spyOn(fs, "lstatSync").mockImplementation(((file: fs.PathLike, options?: unknown) => {
      const value = nativeStat(file, options as { bigint: false });
      if (!injected && String(file).includes(".delegatus-trash-") && String(file).endsWith("/cache")
        && String(new Error().stack).includes("at attemptMutationCurrent")
        && String(new Error().stack).includes("at removeAttemptTree")) {
        injected = true;
        fs.symlinkSync(path.join(directory, "cache"), dependency);
      }
      return value;
    }) as typeof fs.lstatSync);
    cleanup.push(() => { stat.mockRestore(); });
    const sweep = (now: number) => sweepAttemptTemps(store, { now: () => now, maxRoots: 1, state: async () => "expired",
      scan: () => ({ ownNamespace: null, processes: [{ pid: 1, namespace: null, stamped: false, paths: [consumer] }] }) });
    const report = await sweep(NOW);
    stat.mockRestore();
    const firstTick = { original: fs.existsSync(directory), link: fs.existsSync(path.join(dependency, "payload")),
      journal: fs.existsSync(attemptTempJournalPath(directory)), trash: fs.readdirSync(container).filter(name => name.startsWith(".delegatus-trash-")) };
    // Reproduce the predecessor's stuck-trash variant if the first tick left
    // the path missing. A correct first tick already owns the original name.
    if (recreate && !fs.existsSync(directory)) fs.mkdirSync(directory);
    const next = await sweep(NOW + 120_000);
    expect(injected).toBeTrue();
    expect(report).toMatchObject({ removed: 0, errors: 0, deferred: 1 });
    expect(report.outcomes[0].reason).toContain("attempt mutation fence filesystem proof changed");
    expect(firstTick).toEqual({ original: true, link: true, journal: false, trash: [] });
    expect(next).toMatchObject({ removed: 0, errors: 0 });
    expect(fs.readFileSync(path.join(directory, "cache/payload"), "utf8")).toBe("expired");
    expect(fs.readFileSync(path.join(dependency, "payload"), "utf8")).toBe("expired");
    expect(fs.existsSync(attemptTempJournalPath(directory))).toBeFalse();
    expect(fs.readdirSync(container).filter(name => name.startsWith(".delegatus-trash-"))).toEqual([]);
    expect(store.has(directory)).toBeTrue();
  });

test.skipIf(process.platform !== "linux").each([
  ["proof", "filesystem proof changed"],
  ["authority", "authority changed"],
  ["budget", "time budget exhausted"],
  ["watch", "directory watch unavailable"],
] as const)("a throwing post-quarantine %s fence restores before returning its reason", async (refusal, reason) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "llv-trash-fence-"));
  cleanup.push(() => fs.rmSync(parent, { recursive: true, force: true }));
  const directory = path.join(parent, "root"), journal = path.join(parent, "intent.json");
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, "payload"), "retained");
  const identity = fs.statSync(directory).ino;
  let removals = 0, fences = 0;
  await expect(removeTreeViaTrash(directory, { journal, disposable: true, held: () => false,
    remove: async () => { removals++; },
    validate: trash => {
      if (trash === directory) return true;
      fences++;
      return attemptMutationCurrent([refusal === "watch" ? path.join(parent, "missing") : trash], () => {
        if (refusal === "proof") fs.writeFileSync(path.join(trash, "late"), "preserve");
        return true;
      }, refusal === "budget" ? 0 : 30_000, () => refusal !== "authority");
    },
  })).rejects.toThrow(`attempt temp deferred: attempt mutation fence ${reason}`);
  expect(fences).toBe(1);
  expect(removals).toBe(0);
  expect(fs.statSync(directory).ino).toBe(identity);
  expect(fs.readFileSync(path.join(directory, "payload"), "utf8")).toBe("retained");
  if (refusal === "proof") expect(fs.readFileSync(path.join(directory, "late"), "utf8")).toBe("preserve");
  expect(fs.readdirSync(parent)).toEqual(["root"]);
});

test.skipIf(process.platform !== "linux")("native removal after the final fence cannot follow a rebound ancestor", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "review-ancestor-rm-"));
  const container = path.join(parent, "container"), directory = path.join(container, "llv-stage-expired"), cache = path.join(directory, "cache");
  const archive = path.join(parent, "archive"), moved = path.join(archive, "held-container"), replacement = path.join(parent, "replacement");
  fs.mkdirSync(cache, { recursive: true }); fs.writeFileSync(path.join(cache, "payload"), "original expired payload");
  fs.mkdirSync(archive); fs.mkdirSync(replacement);
  const store = new AttemptTempStore(path.join(parent, "registry/owners.sqlite"));
  store.register({ directory, pipelineId: null, launchId: "fixture", retainUntilClose: true, createdAt: 1 });
  const previousPath = process.env.PATH, bin = path.join(parent, "bin"); fs.mkdirSync(bin);
  for (const command of ["find", "du"]) fs.symlinkSync("/usr/bin/" + command, path.join(bin, command)); process.env.PATH = bin;
  const nativeStat = fs.lstatSync.bind(fs), nativeRead = fs.readFileSync.bind(fs);
  let armed = false, reads = 0, injected = false, trash = "", protectedPath = "";
  const read = spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, options?: unknown) => {
    const stack = String(new Error().stack);
    // Arm at the last mount observation before the native removal fence.
    if (file === "/proc/self/mountinfo" && stack.includes("at assertAttemptMountsClear") && !stack.includes("repairAttemptPermissions")) armed = true;
    return nativeRead(file as never, options as never);
  }) as typeof fs.readFileSync);
  const stat = spyOn(fs, "lstatSync").mockImplementation(((file: fs.PathLike, options?: unknown) => {
    const value = nativeStat(file, options as { bigint: false });
    const stack = String(new Error().stack);
    if (armed && !injected && String(file).endsWith("/cache") && stack.includes("at attemptMutationCurrent") && ++reads === 2) {
      trash = JSON.parse(nativeRead(attemptTempJournalPath(directory), "utf8")).trash;
      const pinned = path.join(replacement, path.basename(trash));
      fs.mkdirSync(path.join(pinned, "cache"), { recursive: true });
      fs.writeFileSync(path.join(pinned, "cache", "payload"), "protected replacement");
      fs.writeFileSync(path.join(pinned, ".delegatus-keep"), "pin");
      protectedPath = pinned;
      fs.renameSync(container, moved); fs.symlinkSync(replacement, container, "dir"); injected = true;
    }
    return value;
  }) as typeof fs.lstatSync);
  try {
    const report = await sweepAttemptTemps(store, { now: () => Date.parse("2030-01-20T00:00:00Z"), maxRoots: 1, state: async () => "expired",
      scan: () => ({ ownNamespace: null, processes: [] }), references: async () => true });
    const result = { injected, reads, removed: report.removed, outcomes: report.outcomes.map(row => [row.disposition, row.reason]),
      protectedKept: fs.existsSync(path.join(protectedPath, ".delegatus-keep")), protectedPayload: fs.existsSync(path.join(protectedPath, "cache", "payload")),
      movedOriginal: fs.existsSync(path.join(moved, path.basename(trash), "cache", "payload")) };
    console.log(JSON.stringify(result));
    expect(store.has(directory)).toBeTrue();
    expect(injected).toBeTrue();
    expect(result.protectedKept).toBeTrue();
    expect(result.protectedPayload).toBeTrue();
    expect(result.movedOriginal).toBeTrue();
    expect(fs.existsSync(path.join(moved, path.basename(attemptTempJournalPath(directory))))).toBeTrue();
  } finally {
    stat.mockRestore(); read.mockRestore(); process.env.PATH = previousPath; store.close();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});


test.skipIf(process.platform !== "linux")("a final protection read cannot admit chmod after an ancestor is rebound", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "review-ancestor-"));
  const container = path.join(parent,"container"), directory = path.join(container,"llv-stage-expired"), cache = path.join(directory,"cache");
  const archive = path.join(parent,"archive"), moved = path.join(archive,"held-container"), replacement = path.join(parent,"replacement");
  fs.mkdirSync(cache,{recursive:true});fs.writeFileSync(path.join(cache,"payload"),"retain mode");fs.chmodSync(cache,0o555);
  fs.mkdirSync(archive);fs.writeFileSync(path.join(archive,".delegatus-keep"),"permanent pin");
  fs.mkdirSync(replacement);
  const store = new AttemptTempStore(path.join(parent,"registry/owners.sqlite"));
  store.register({directory,pipelineId:null,launchId:"fixture",retainUntilClose:true,createdAt:1});
  const previousPath = process.env.PATH, bin=path.join(parent,"bin");fs.mkdirSync(bin);
  for (const command of ["find","du"])fs.symlinkSync("/usr/bin/"+command,path.join(bin,command));process.env.PATH=bin;
  const nativeStat=fs.lstatSync.bind(fs);let reads=0,injected=false,trash="";
  const stat=spyOn(fs,"lstatSync").mockImplementation(((file:fs.PathLike,options?:unknown)=>{
    const value=nativeStat(file,options as {bigint:false});const stack=String(new Error().stack);
    if(!injected&&String(file).endsWith("/cache")&&stack.includes("at permissionChange")&&stack.includes("at attemptMutationCurrent")&&stack.includes("at current")&&++reads===2){
      trash=JSON.parse(fs.readFileSync(attemptTempJournalPath(directory),"utf8")).trash;
      const replacementCache=path.join(replacement,path.basename(trash),"cache");fs.mkdirSync(replacementCache,{recursive:true});fs.writeFileSync(path.join(replacementCache,"payload"),"protected replacement");fs.writeFileSync(path.join(replacement,path.basename(trash),".delegatus-keep"),"pin");
      fs.renameSync(container,moved);fs.symlinkSync(replacement,container,"dir");injected=true;
    }
    return value;
  }) as typeof fs.lstatSync);
  try{
    const report=await sweepAttemptTemps(store,{now:()=>Date.parse("2030-01-20T00:00:00Z"),maxRoots:1,state:async()=>"expired",scan:()=>({ownNamespace:null,processes:[]}),references:async()=>true});
    const movedCache=path.join(moved,path.basename(trash),"cache");
    const mode=fs.statSync(movedCache).mode&0o777;
    console.log(JSON.stringify({injected,reads,mode,report,owner:store.has(directory),journal:fs.existsSync(attemptTempJournalPath(directory)),movedPayload:fs.readFileSync(path.join(movedCache,"payload"),"utf8")}));
    expect(store.has(directory)).toBeTrue();
    expect(injected).toBeTrue();expect(report.removed).toBe(0);expect(mode).toBe(0o555);
  }finally{
    stat.mockRestore();process.env.PATH=previousPath;store.close();
    const restore=(dir:string)=>{fs.chmodSync(dir,0o700);for(const entry of fs.readdirSync(dir,{withFileTypes:true}))if(entry.isDirectory())restore(path.join(dir,entry.name));};restore(parent);fs.rmSync(parent,{recursive:true,force:true});
  }
});

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const restore of cleanup.splice(0).reverse()) await restore();
});

test.skipIf(process.platform !== "linux").each(["linux", "darwin", "win32"])(
  "native removal requires an available common fence (%s branch)", async platform => {
    for (const mutation of ["link", "keep", "expired"] as const) {
      const parent = fs.mkdtempSync(path.join(os.tmpdir(), "llv-portable-fence-"));
      cleanup.push(() => fs.rmSync(parent, { recursive: true, force: true }));
      const directory = path.join(parent, "attempt"), checkout = path.join(parent, "checkout");
      fs.mkdirSync(directory); fs.mkdirSync(checkout);
      fs.writeFileSync(path.join(directory, "payload"), "protected");
      const previous = Object.getOwnPropertyDescriptor(process, "platform")!;
      let observations = 0, error: unknown;
      Object.defineProperty(process, "platform", { ...previous, value: platform });
      try {
        await removeAttemptTree(directory, directory, undefined, false, () => attemptMutationCurrent([directory, checkout], () => {
          const clear = !fs.existsSync(path.join(checkout, "dependency")) && !fs.existsSync(path.join(directory, ".delegatus-keep"));
          fs.lstatSync(directory);
          if (++observations === 2) {
            if (mutation === "link") execFileSync(process.execPath, ["-e", 'require("node:fs").symlinkSync(process.argv[1], process.argv[2], "dir")',
              directory, path.join(checkout, "dependency")]);
            else fs.writeFileSync(path.join(directory, ".delegatus-keep"), "late pin");
          }
          return clear;
        }, mutation === "expired" ? 0 : 30_000));
      } catch (caught) { error = caught; }
      finally { Object.defineProperty(process, "platform", previous); }
      expect(error).toBeDefined();
      expect(observations).toBe(platform === "linux" && mutation !== "expired" ? 2 : 0);
      if (platform !== "linux") expect(String(error)).toContain("fence unavailable on this platform");
      else if (mutation === "expired") expect(String(error)).toContain("time budget exhausted");
      else if (mutation === "link") expect(fs.readlinkSync(path.join(checkout, "dependency"))).toBe(directory);
      else expect(fs.readFileSync(path.join(directory, ".delegatus-keep"), "utf8")).toBe("late pin");
      expect(fs.readFileSync(path.join(directory, "payload"), "utf8")).toBe("protected");
    }
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
  const retainedRoot = () => fs.existsSync(attemptTempJournalPath(directory)) ? journal().trash : directory;
  return { parent, directory, cache, store, sweep, journal, retainedRoot, lane };
}

test.skipIf(process.platform !== "linux").each(["owner", "pipeline", "hold"] as const)(
  "a relevant database change during the final protection read preserves permissions (%s)", mutation => {
    return (async () => {
      const f = fixture();
      if (mutation === "hold") new RecordedCheckStore().close();
      const database = new Database(mutation === "owner" ? f.store.filename : statePath("state.sqlite"));
      cleanup.push(() => database.close());
      cleanup.push(() => { if (mutation === "hold") database.run("DELETE FROM recorded_check_roots WHERE id='late-hold'"); });
      const nativeStat = fs.lstatSync.bind(fs);
      let injected = false, reads = 0;
      const stat = spyOn(fs, "lstatSync").mockImplementation(((file: fs.PathLike, options?: unknown) => {
        const value = nativeStat(file, options as { bigint: false });
        const stack = String(new Error().stack);
        if (!injected && String(file).endsWith("/cache") && stack.includes("at permissionChange")
          && stack.includes("at attemptMutationCurrent") && stack.includes("at current") && ++reads === 2) {
          if (mutation === "owner") database.run("UPDATE roots SET launchId='replacement' WHERE directory=?", [f.directory]);
          else if (mutation === "pipeline") database.run("UPDATE state_rows SET row_revision=row_revision+1 WHERE collection='pipelines' AND row_key=?", [f.lane.id]);
          else database.run("INSERT INTO recorded_check_roots(id,directory,identity,held) VALUES('late-hold',?,'fixture',1)", [f.directory]);
          injected = true;
        }
        return value;
      }) as typeof fs.lstatSync);
      cleanup.push(() => { stat.mockRestore(); });
      const report = await f.sweep();
      expect(injected).toBeTrue();
      expect(report).toMatchObject({ removed: 0, errors: 0, deferred: 1 });
      expect(report.outcomes[0].reason).toContain("authority changed");
      expect(f.store.has(f.directory)).toBeTrue();
      const cache = path.join(f.retainedRoot(), "cache");
      expect(fs.statSync(cache).mode & 0o777).toBe(0o555);
      expect(fs.readFileSync(path.join(cache, "payload"), "utf8")).toBe("retained cache");
    })();
  });

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
      expect(fs.statSync(path.join(f.retainedRoot(), "cache")).mode & 0o777).toBe(0o555);
      // The reviewer's reproduction writes from another process while the
      // final protection lstat is returning its earlier observation.
      if (observation === "protection-refresh-keep")
        execFileSync(process.execPath, ["-e", 'require("node:fs").writeFileSync(process.argv[1], "late pin")',
          path.join(f.retainedRoot(), ".delegatus-keep")]);
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
    const retained = path.join(f.retainedRoot(), "cache");
    expect(fs.statSync(retained).mode & 0o777).toBe(0o555);
    expect(fs.readFileSync(path.join(retained, "payload"), "utf8")).toBe("retained cache");
    if (observation === "protection-refresh-keep") expect(fs.readFileSync(path.join(f.retainedRoot(), ".delegatus-keep"), "utf8")).toBe("late pin");
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
        expect(fs.statSync(path.join(f.retainedRoot(), "cache")).mode & 0o777).toBe(0o555);
        fs.writeFileSync(path.join(f.retainedRoot(), ".delegatus-keep"), "late checkout pin");
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
    const retained = f.retainedRoot();
    expect(fs.readFileSync(path.join(retained, ".delegatus-keep"), "utf8")).toBe("late checkout pin");
    expect(fs.readFileSync(path.join(retained, "cache/payload"), "utf8")).toBe("retained cache");
    expect(fs.statSync(path.join(retained, "cache")).mode & 0o777).toBe(0o555);
  });
