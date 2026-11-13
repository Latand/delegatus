import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { attemptTempJournalPath, finishTreeTrash, mountPointsUnder, removeTreeViaTrash } from "@/lib/tempSweep";
import { writeJsonDurably } from "@/lib/state/durableJson";
import { readEnvelope } from "@/lib/recordedChecks/wire";
import { withFileTransactionAsync } from "@/lib/state/fileTransaction";
import { restoreRefusedAttemptTrash } from "@/lib/pipelines/retirementClaim";
import { RepositoryLinkInventory, type RetainedCheckoutReads } from "./attemptTempFilesystem";
import { TemporaryDataStore, type TemporaryDataCandidate } from "./temporaryDataStore";
import { assertRetentionTestPath, RetentionTestSafetyError } from "@/lib/retentionTestSafety";

export const TEMPORARY_DATA_RETENTION_MS = 7 * 86400000;
const MAX_PROTECTION_ENTRIES = 200000;
export const PRESERVATION_NAMES = new Set(["worktree", "worktree-backup.json", "preservation", "bundles", ".git"]);
const lifecycleControlName = (name: string) => name.startsWith(".delegatus-trash-")
  || name.startsWith(".delegatus-sweep-") && name.endsWith(".json");
export type TemporaryDataAuthority = { expiresAt: number | null; reason: string; revision: string; current: () => boolean; pipelineIds?: string[] };
export type TemporaryDataPorts = {
  authority: (row: TemporaryDataCandidate) => Promise<TemporaryDataAuthority>;
  references: (row: TemporaryDataCandidate, target: string, inventory: RepositoryLinkInventory) => Promise<boolean>;
  claim: (row: TemporaryDataCandidate) => Promise<() => void>;
  mounts?: typeof mountPointsUnder;
  now?: () => number; clock?: () => number; budgetMs?: number; mode?: "on" | "dry-run";
  onRemoved?: (row: TemporaryDataCandidate) => void;
  checkoutReads?: RetainedCheckoutReads;
};
const identity = (stat: fs.Stats) => `${stat.dev}:${stat.ino}`;
const signature = (stat: fs.BigIntStats) => [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");

/** A private synchronous change queue covers the entire validation interval.
 * Access/read events are excluded. Missing watches, overflow and watch loss
 * refuse removal; no descriptor survives dispatch. */
function mutationCurrent(files: readonly string[], directories: readonly string[], validate: () => boolean, deadline: number) {
  if (process.platform !== "linux") return false;
  const ffi = createRequire(import.meta.url)(`bun:${"ffi"}`) as typeof import("bun:ffi");
  const library = ffi.dlopen("libc.so.6", {
    inotify_init1: { args: ["i32"], returns: "i32" },
    inotify_add_watch: { args: ["i32", "cstring", "u32"], returns: "i32" },
    poll: { args: ["ptr", "u64", "i32"], returns: "i32" },
  });
  let fd = -1, mountFd = -1;
  try {
    fd = library.symbols.inotify_init1(0x800 | 0x80000); // NONBLOCK | CLOEXEC
    if (fd < 0) return false;
    const watched = new Map<number, Set<string> | null>();
    const add = (file: string, names: Set<string> | null, directory: boolean) => {
      // MODIFY, ATTRIB, MOVE, CREATE, DELETE, self changes; do not follow links.
      const wd = library.symbols.inotify_add_watch(fd, Buffer.from(file + "\0"), 0xfc6 | 0x2000000 | 0x20000000 | (directory ? 0x1000000 : 0));
      if (wd < 0) return false;
      const previous = watched.get(wd);
      watched.set(wd, previous === null || names === null ? null : new Set([...(previous ?? []), ...names]));
      return true;
    };
    const requested = new Map<string, Set<string> | null>();
    const observe = (directory: string, name?: string) => {
      const previous = requested.get(directory);
      if (previous === null || name !== undefined && previous?.has(name)) return true;
      const names = name === undefined ? null : new Set([...(previous ?? []), name]);
      requested.set(directory, names);
      return add(directory, names, true);
    };
    // Traverse in filesystem order: hop/.. climbs the physical directory
    // reached through hop. Never normalize a link's remaining components.
    // Install each parent watch before reading its child, so a binding change
    // during watch discovery also invalidates the final validation interval.
    const wholeDirectories = new Set(directories);
    const physicalDirectories = new Set<string>();
    let steps = 0;
    for (const file of new Set([...files, ...directories])) {
      if (!path.isAbsolute(file)) return false;
      // Reuse only physical parents whose bindings are already watched. A
      // flat capture tree then visits its shared ancestry once per dispatch.
      const parent = path.dirname(file);
      let reached = physicalDirectories.has(parent) ? parent : path.parse(file).root, hops = 0, missing = false;
      const pending = file.slice(reached.length).split(path.sep).filter(Boolean);
      while (pending.length) {
        if (performance.now() >= deadline || ++steps > MAX_PROTECTION_ENTRIES) return false;
        const name = pending.shift()!;
        if (name === ".") continue;
        if (name === "..") { reached = path.dirname(reached); continue; }
        if (!observe(reached, name)) return false;
        const current = path.join(reached, name);
        const stat = fs.lstatSync(current, { throwIfNoEntry: false });
        if (!stat) { missing = true; break; } // Its existing parent watches the missing name.
        if (stat.isSymbolicLink()) {
          if (++hops > 256) return false;
          const link = fs.readlinkSync(current);
          if (path.isAbsolute(link)) reached = path.parse(link).root;
          pending.unshift(...link.split(path.sep).filter(Boolean));
        } else {
          reached = current;
          if (pending.length && !stat.isDirectory()) return false;
          if (stat.isDirectory()) physicalDirectories.add(reached);
        }
      }
      if (!missing && wholeDirectories.has(file)) {
        if (!physicalDirectories.has(reached) && !fs.lstatSync(reached).isDirectory()) return false;
        if (!observe(reached)) return false;
      }
    }
    // Object watches also detect writes through hardlinks outside the tree.
    for (const file of files) {
      if (performance.now() >= deadline) return false;
      if (fs.lstatSync(file, { throwIfNoEntry: false }) && !add(file, null, false)) return false;
    }
    mountFd = fs.openSync("/proc/self/mountinfo", fs.constants.O_RDONLY);
    const poll = Buffer.alloc(8);
    poll.writeInt32LE(mountFd); poll.writeInt16LE(2, 4); // POLLPRI
    if (!validate()) return false;
    const buffer = Buffer.allocUnsafe(4096);
    while (performance.now() < deadline) {
      let count: number;
      try { count = fs.readSync(fd, buffer, 0, buffer.length, null); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EAGAIN") return false;
        return library.symbols.poll(ffi.ptr(poll), BigInt(1), 0) === 0;
      }
      if (!count) return false;
      for (let offset = 0; offset < count;) {
        if (offset + 16 > count) return false;
        const wd = buffer.readInt32LE(offset), length = buffer.readUInt32LE(offset + 12);
        if (offset + 16 + length > count || !watched.has(wd)) return false;
        const name = buffer.subarray(offset + 16, offset + 16 + length).toString().replace(/\0.*$/, "");
        if (!name || watched.get(wd) === null || watched.get(wd)!.has(name)) return false;
        offset += 16 + length;
      }
    }
    return false;
  } catch { return false; }
  finally {
    if (fd >= 0) fs.closeSync(fd);
    if (mountFd >= 0) fs.closeSync(mountFd);
    library.close();
  }
}

/** Protection and measured bytes come from the same bounded, physical walk.
 * Every directory and file is checked again after asynchronous observations.
 * Incomplete measurements retain their reason instead of inventing a size. */
export function temporaryDataProtection(row: TemporaryDataCandidate, target: string, clock: () => number, deadline: number) {
  const root = fs.lstatSync(target), entries = new Map<string, string>(), listings = new Map<string, Set<string>>();
  if (identity(root) !== row.identity || root.isSymbolicLink() || !root.isDirectory() && !root.isFile()
    || process.getuid && root.uid !== process.getuid()) throw new Error("identity-changed");
  const parents = new Map<string, string>();
  for (let parent = path.dirname(row.directory);;) {
    const stat = fs.lstatSync(parent, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(parent) !== parent || stat.dev !== BigInt(root.dev)) throw new Error("indirect-parent");
    if (fs.existsSync(path.join(parent, ".delegatus-keep"))) throw new Error("keep-marker");
    parents.set(parent, signature(stat));
    if (parent === row.scope) break;
    const next = path.dirname(parent);
    if (parent === next || !row.directory.startsWith(row.scope + path.sep)) throw new Error("invalid-scope");
    parent = next;
  }
  const pending = [target], seen = new Set<string>();
  let bytes = 0;
  while (pending.length) {
    if (clock() >= deadline || entries.size >= MAX_PROTECTION_ENTRIES) throw new Error("protection-budget");
    const file = pending.pop()!, stat = fs.lstatSync(file, { bigint: true });
    if (stat.dev !== BigInt(root.dev) || stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory()) throw new Error("indirect-tree");
    const name = path.basename(file);
    if (name === ".delegatus-keep") throw new Error("keep-marker");
    if (file !== target && lifecycleControlName(name)) throw new Error("lifecycle-control");
    if (PRESERVATION_NAMES.has(name)) throw new Error("preservation-record");
    entries.set(file, signature(stat));
    const key = `${stat.dev}:${stat.ino}`;
    if (!seen.has(key)) { seen.add(key); bytes += Number(stat.blocks) * 512; }
    if (stat.isDirectory()) {
      const names = new Set<string>();
      const stream = fs.opendirSync(file);
      try {
        for (let entry; (entry = stream.readSync());) {
          if (pending.length + entries.size >= MAX_PROTECTION_ENTRIES || clock() >= deadline) throw new Error("protection-budget");
          names.add(entry.name);
          pending.push(path.join(file, entry.name));
        }
      } finally { stream.closeSync(); }
      listings.set(file, names);
    }
  }
  return { bytes, files: [...entries.keys()], directories: [...parents.keys(), ...listings.keys()], current: () => {
    try {
      if (![...entries, ...parents].every(([file, before]) => signature(fs.lstatSync(file, { bigint: true })) === before)) return false;
      // Directory clocks can share a kernel granule. Compare the actual names
      // too so a marker created within that granule cannot evade the fence.
      for (const [file, before] of listings) {
        const stream = fs.opendirSync(file); let count = 0;
        try { for (let entry; (entry = stream.readSync());) if (++count > before.size || !before.has(entry.name)) return false; }
        finally { stream.closeSync(); }
        if (count !== before.size) return false;
      }
      // Markers are valid at every level, including the candidate's own root.
      // Recheck after listings close so a marker created at that boundary is
      // visible even when directory timestamps share a kernel granule.
      if ([...parents.keys(), ...listings.keys()].some(directory => fs.existsSync(path.join(directory, ".delegatus-keep")))) return false;
      return true;
    } catch { return false; }
  } };
}

type FileIntent = { version: 1; kind: "temporary-file"; directory: string; trash: string; identity: string; uid: number };
function fileIntent(row: TemporaryDataCandidate, journal: string): FileIntent {
  const intent = readEnvelope(journal) as FileIntent;
  if (intent.version !== 1 || intent.kind !== "temporary-file" || intent.directory !== row.directory || intent.identity !== row.identity
    || typeof intent.trash !== "string" || path.dirname(intent.trash) !== path.dirname(row.directory)
    || !path.basename(intent.trash).startsWith(`.delegatus-trash-${path.basename(row.directory)}-`)) throw new Error("journal-binding-changed");
  return intent;
}

function restoreCandidate(row: TemporaryDataCandidate, journal: string) {
  assertRetentionTestPath(row.directory);
  if (!fs.existsSync(journal)) return;
  if (fs.realpathSync(path.dirname(row.directory)) !== path.dirname(row.directory)) throw new Error("indirect-parent");
  const intent = readEnvelope(journal) as { kind?: unknown };
  if (intent.kind !== "temporary-file") { restoreRefusedAttemptTrash(row.directory, row.identity); return; }
  const file = fileIntent(row, journal), target = fs.lstatSync(file.trash, { throwIfNoEntry: false });
  const original = fs.lstatSync(row.directory, { throwIfNoEntry: false });
  const owned = (stat: fs.Stats | undefined) => stat?.isFile() && !stat.isSymbolicLink() && identity(stat) === row.identity
    && stat.uid === file.uid && (!process.getuid || stat.uid === process.getuid());
  if (owned(original) && !target) { fs.unlinkSync(journal); return; }
  if (original || !owned(target)) throw new Error("quarantine-identity-changed");
  fs.renameSync(file.trash, row.directory); fs.unlinkSync(journal);
}

/** The same admission as automatic copies serializes overlapping discovery.
 * Journals bind to an existing row; losing that row grants no recovery power. */
export function sweepTemporaryData(store: TemporaryDataStore, ports: TemporaryDataPorts, admission = store.filename + ".sweep") {
  assertRetentionTestPath(admission);
  return withFileTransactionAsync(admission, "temporary data retention", async () => {
    const now = ports.now ?? Date.now, clock = ports.clock ?? (() => performance.now());
    const deadline = clock() + (ports.budgetMs ?? 5000), mounts = ports.mounts ?? mountPointsUnder;
    const retained: RetainedCheckoutReads = ports.checkoutReads ?? new Map();
    const repositories = new Set<string>(), discoveries = new Set<string>();
    // Keep the watch inputs local to this consumer; the shared inventory's
    // discovery, caching and validation contracts remain authoritative.
    const inventory = new class extends RepositoryLinkInventory {
      override repositoryOf(cwd: string, pids: readonly (number | null)[] = []) {
        for (let directory = cwd;;) {
          discoveries.add(path.join(directory, ".git"));
          const parent = path.dirname(directory);
          if (parent === directory) break;
          directory = parent;
        }
        return super.repositoryOf(cwd, pids);
      }
      override targets(repository: string, discovered = false) {
        repositories.add(repository);
        return super.targets(repository, discovered);
      }
    }({ now: clock, budgetMs: Math.max(0, deadline - clock()), retained, freshMs: ports.checkoutReads ? undefined : 10000 });
    const report = { checked: 0, removed: 0, removedBytes: 0, wouldRemove: 0, wouldRemoveBytes: 0, kept: {} as Record<string, number>, errors: 0 };
    for (const row of store.due(now(), 128)) {
      assertRetentionTestPath(row.directory);
      assertRetentionTestPath(row.scope);
      if (clock() >= deadline) break;
      report.checked++;
      store.record(row.directory, now() + 60000, row.bytes, "pending");
      let release: (() => void) | undefined;
      let claimed = false, mutationStarted = false;
      let bytes = row.bytes, reason = "held";
      let nextCheck = now() + 60000;
      const journal = attemptTempJournalPath(row.directory);
      try {
        const candidateName = path.basename(row.directory);
        if (lifecycleControlName(candidateName)) {
          reason = "lifecycle-control";
          nextCheck = now() + 3600000;
          continue;
        }
        if (!fs.lstatSync(row.directory, { throwIfNoEntry: false }) && !fs.existsSync(journal)) {
          ports.onRemoved?.(row); store.forget(row.directory); reason = "absent"; continue;
        }
        if (!fs.lstatSync(row.directory, { throwIfNoEntry: false }) && fs.existsSync(journal)) {
          const intent = readEnvelope(journal) as { directory?: unknown; identity?: unknown; trash?: unknown };
          if (intent.directory !== row.directory || intent.identity !== row.identity || typeof intent.trash !== "string"
            || path.dirname(intent.trash) !== path.dirname(row.directory)
            || !path.basename(intent.trash).startsWith(`.delegatus-trash-${path.basename(row.directory)}-`)) throw new Error("journal-binding-changed");
          if (!fs.lstatSync(intent.trash, { throwIfNoEntry: false })) {
            if (fs.realpathSync(path.dirname(row.directory)) !== path.dirname(row.directory)) throw new Error("indirect-parent");
            // Both resources are absent: settle a crash after removal without
            // asking a vanished manifest to authorize bookkeeping cleanup.
            fs.unlinkSync(journal); ports.onRemoved?.(row); store.forget(row.directory); reason = "absent"; continue;
          }
        }
        // A claim also protects replay when a previous process died in trash.
        if (ports.mode !== "dry-run") {
          release = await ports.claim(row);
          claimed = true;
          // The durable writer can stop before rename, or after restoration
          // but before cancelling its intent. Reconcile only the recorded
          // original identity; competing paths and identities remain fenced.
          if (fs.lstatSync(row.directory, { throwIfNoEntry: false }) && fs.existsSync(journal)) restoreCandidate(row, journal);
        }
        assertRetentionTestPath(row.directory);
        const authority = await ports.authority(row);
        assertRetentionTestPath(row.directory);
        let currentAuthority = authority;
        const due = () => currentAuthority.expiresAt !== null && now() >= currentAuthority.expiresAt && authority.current() && currentAuthority.current();
        if (!due()) {
          if (ports.mode !== "dry-run") restoreCandidate(row, journal);
          reason = authority.reason;
          nextCheck = authority.expiresAt !== null && authority.expiresAt > now() ? authority.expiresAt
            : authority.expiresAt === null ? now() + 3600000 : nextCheck;
          continue;
        }
        let target = row.directory;
        let file: FileIntent | undefined;
        if (fs.existsSync(journal)) {
          const intent = readEnvelope(journal) as { kind?: unknown; directory?: unknown; identity?: unknown; trash?: unknown };
          if (intent.kind === "temporary-file") file = fileIntent(row, journal);
          if (intent.directory !== row.directory || intent.identity !== row.identity || typeof intent.trash !== "string"
            || path.dirname(intent.trash) !== path.dirname(row.directory)
            || !path.basename(intent.trash).startsWith(`.delegatus-trash-${path.basename(row.directory)}-`)) throw new Error("journal-binding-changed");
          target = intent.trash;
        }
        if (!fs.existsSync(target)) {
          if (target === row.directory && !fs.existsSync(journal)) { store.forget(row.directory); reason = "absent"; continue; }
          if (!fs.existsSync(row.directory) && due()) {
            // Crash after native removal and before settling its intent. This
            // removes only our bookkeeping; no surviving resource is touched.
            fs.unlinkSync(journal); store.forget(row.directory); reason = "absent"; continue;
          }
          throw new Error("quarantine-unavailable");
        }
        let protection: ReturnType<typeof temporaryDataProtection>;
        const dispatch = (current: string) => {
          assertRetentionTestPath(current);
          const checkouts = [...repositories].flatMap(repository => {
            const read = retained.get(repository);
            return read ? [...read.directories.map(directory => directory.path), ...read.lexicalTargets] : [repository];
          });
          const files = [...protection.files, ...checkouts, ...discoveries];
          const directories = [...protection.directories, ...[...repositories].flatMap(repository => retained.get(repository)?.directories.map(directory => directory.path) ?? [])];
          let admitted = false;
          try { admitted = mutationCurrent(files, directories, () => clock() < deadline
            && store.get(row.directory)?.identity === row.identity
            && mounts(current).length === 0
            && inventory.unchangedAll()
            && protection?.current() === true
            // Authority may change during the final filesystem snapshot reads.
            // Keep its current check adjacent to the native removal edge.
            && due(), performance.now() + Math.max(0, deadline - clock()));
          } catch { reason = "mutation-fence-unavailable"; return false; }
          if (!admitted) reason = "fence-changed";
          return admitted;
        };
        const validate = (current: string) => {
          assertRetentionTestPath(current);
          return dispatch(current);
        };
        const held = async (current: string) => {
          assertRetentionTestPath(current);
          protection = temporaryDataProtection(row, current, clock, deadline);
          bytes = protection.bytes;
          const clear = await ports.references(row, current, inventory);
          assertRetentionTestPath(current);
          if (!clear) { reason = "live-reference"; return true; }
          currentAuthority = await ports.authority(row);
          assertRetentionTestPath(current);
          if (currentAuthority.revision !== authority.revision || !validate(current)) { reason = "fence-changed"; return true; }
          return false;
        };
        if (await held(target)) {
          if (claimed) restoreCandidate(row, journal);
          continue;
        }
        if (ports.mode === "dry-run") { report.wouldRemove++; report.wouldRemoveBytes += bytes; reason = "due"; continue; }
        const stat = fs.lstatSync(target);
        let removed = false;
        if (stat.isDirectory()) {
          const remove = (current: string, started: () => void) => {
            mutationStarted = true; started();
            return fs.promises.rm(current, { recursive: true, force: true });
          };
          removed = fs.existsSync(journal) ? await finishTreeTrash(journal, held, remove, validate, true, dispatch)
            : await removeTreeViaTrash(row.directory, { journal, held, remove, validate, dispatch, disposable: true });
          if (!removed) restoreRefusedAttemptTrash(row.directory, row.identity);
        } else {
          if (!file) {
            file = { version: 1, kind: "temporary-file", directory: row.directory,
              trash: path.join(path.dirname(row.directory), `.delegatus-trash-${path.basename(row.directory)}-${randomUUID()}`), identity: row.identity, uid: stat.uid };
            if (!validate(row.directory)) { reason = "fence-changed"; continue; }
            writeJsonDurably(journal, file);
            fs.renameSync(row.directory, file.trash);
          }
          const moved = fs.lstatSync(file.trash);
          if (!moved.isFile() || moved.uid !== file.uid || identity(moved) !== row.identity) throw new Error("file-identity-changed");
          if (!await held(file.trash) && validate(file.trash)) {
            mutationStarted = true;
            fs.unlinkSync(file.trash); fs.unlinkSync(journal); removed = true;
          } else if (!fs.existsSync(row.directory) && identity(fs.lstatSync(file.trash)) === row.identity) {
            fs.renameSync(file.trash, row.directory); fs.unlinkSync(journal);
          }
        }
        if (removed) { report.removed++; report.removedBytes += bytes; ports.onRemoved?.(row); store.forget(row.directory); reason = "removed"; }
      } catch (error) {
        if (error instanceof RetentionTestSafetyError) throw error;
        reason = error instanceof Error ? error.message : "inspection-unavailable"; report.errors++;
        // Protection and reference inspection can throw before dispatch, even
        // on replay. Return that verified resource to its owner in this call.
        // A native removal error keeps the intent and partial tree in custody.
        if (claimed && !mutationStarted) {
          try { restoreCandidate(row, journal); }
          catch (restoreError) { reason += `; restoration: ${restoreError instanceof Error ? restoreError.message : "unavailable"}`; }
        }
      }
      finally {
        try { release?.(); } catch { report.errors++; }
        if (reason !== "removed" && reason !== "absent") {
          store.record(row.directory, nextCheck, bytes, reason);
          report.kept[reason] = (report.kept[reason] ?? 0) + 1;
        }
      }
    }
    return report;
  });
}
