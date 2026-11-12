import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { statePath } from "@/lib/configDir";
import { fsyncPath, writeJsonDurably } from "@/lib/state/durableJson";
import { reportMediaIndex, reportMediaRoot } from "@/lib/reportMedia/lookup";

const signature = (stat: fs.BigIntStats) => [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
const inside = (file: string, root: string) => file === root || file.startsWith(root + path.sep);

/** The files of an attempt root that the evidence ledger links and that have
 * no kept copy yet, relative to the root. The ledger is the report picture
 * index: a stage report, a bridge report or a task named the picture by this
 * path, and its copy normally lives in that store. Recorded-check evidence has
 * its own custody and holds the root itself. Everything else in a scratch
 * tree, an image of a checked-out source tree for one, is no recorded
 * evidence. An index that cannot be read proves nothing, so it refuses. */
function ledgerLinked(original: string): Set<string> {
  const rows = reportMediaIndex();
  if (rows === null) throw new Error("report picture index is unreadable; attempt evidence cannot be judged");
  const roots = [path.resolve(original)];
  try { roots.push(path.join(fs.realpathSync(path.dirname(original)), path.basename(original))); }
  catch { /* A quarantined original keeps its lexical name. */ }
  const linked = new Set<string>();
  for (const row of rows) {
    const root = roots.find(candidate => inside(path.resolve(row.path), candidate) && path.resolve(row.path) !== candidate);
    if (!root || fs.existsSync(path.join(reportMediaRoot(), row.file))) continue;
    linked.add(path.relative(root, path.resolve(row.path)));
  }
  return linked;
}

/** Preserve the recorded evidence of an attempt root before any retirement.
 * Each call inventories the current tree; a crash needs no migration flag.
 * The returned synchronous fence detects edits during the final owner read. */
export async function preserveAttemptEvidence(directory: string, original: string, identity: string,
  retention?: { pipelineId: string | null; launchId: string; register: (destination: string) => void }): Promise<{ current: () => boolean; destination?: string }> {
  const until = performance.now() + 30_000;
  const budget = () => { if (performance.now() >= until) throw new Error("attempt evidence preservation deadline exceeded"); };
  if (fs.realpathSync(directory) !== directory) throw new Error("linked attempt evidence source");
  const source = new Map<string, string>(), saved = new Map<string, string>();
  const files: string[] = [], linked = ledgerLinked(original);
  const walk = async (relative: string) => {
    budget();
    const file = path.join(directory, relative), stat = await fs.promises.lstat(file, { bigint: true });
    if (stat.isSymbolicLink()) {
      if (linked.has(relative)) throw new Error("linked attempt evidence");
      return;
    }
    if (stat.isDirectory()) {
      source.set(relative, signature(stat));
      const entries = await fs.promises.opendir(file);
      for await (const entry of entries) {
        budget();
        const child = path.join(relative, entry.name);
        if (entry.isDirectory() || linked.has(child)) await walk(child);
      }
    } else if (linked.has(relative)) {
      if (!stat.isFile()) throw new Error("attempt evidence is not a regular file");
      source.set(relative, signature(stat)); files.push(relative);
    }
  };
  const current = () => {
    try {
      if (fs.realpathSync(directory) !== directory) return false;
      const root = fs.lstatSync(directory);
      if (`${root.dev}:${root.ino}` !== identity) return false;
      for (const [relative, expected] of source) {
        if (signature(fs.lstatSync(path.join(directory, relative), { bigint: true })) !== expected) return false;
      }
      for (const [file, expected] of saved) {
        if (fs.realpathSync(path.dirname(file)) !== path.dirname(file)
          || signature(fs.lstatSync(file, { bigint: true })) !== expected) return false;
      }
      return true;
    } catch { return false; }
  };
  // A tree this user cannot read is held for the operator before it gets
  // here; one that turns unreadable meanwhile refuses with its cause.
  await walk("");
  // A linked file the walk did not reach lies behind a symbolic link.
  for (const relative of linked) {
    if (files.includes(relative)) continue;
    let reached: fs.Stats | undefined;
    try { reached = fs.lstatSync(path.join(directory, relative), { throwIfNoEntry: false }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error; }
    if (reached) throw new Error("linked attempt evidence");
  }
  const key = createHash("sha256").update(original).update("\0").update(identity).digest("hex");
  const destination = statePath("evidence", "attempt-temp", key);
  if (files.length) retention?.register(destination);
  const evidenceParent = path.dirname(statePath("evidence"));
  const digest = async (file: string) => {
    budget();
    if (!fs.lstatSync(file).isFile()) throw new Error("attempt evidence is not a regular file");
    if (fs.realpathSync(path.dirname(file)) !== path.dirname(file)) throw new Error("linked attempt evidence parent");
    const hash = createHash("sha256");
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      if (!fs.fstatSync(fd).isFile()) throw new Error("attempt evidence is not a regular file");
      for await (const chunk of fs.createReadStream(file, { fd, autoClose: false })) { budget(); hash.update(chunk); }
    } finally { fs.closeSync(fd); }
    return hash.digest("hex");
  };
  const manifest: Array<{ path: string; savedPath: string; hash: string }> = [];
  for (const relative of files) {
    const file = path.join(directory, relative), hash = await digest(file);
    let savedPath = path.join("files", relative), target = path.join(destination, savedPath);
    if (fs.existsSync(target) && await digest(target) !== hash) {
      savedPath = path.join("versions", hash, relative); target = path.join(destination, savedPath);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    if (fs.realpathSync(path.dirname(target)) !== path.dirname(target)) throw new Error("linked attempt evidence destination");
    if (!fs.existsSync(target)) {
      const copyRoot = fs.mkdtempSync(path.join(path.dirname(target), ".copy-"));
      const copyIdentity = fs.lstatSync(copyRoot), parent = path.dirname(copyRoot);
      const parentIdentity = fs.lstatSync(parent);
      const copyCurrent = () => {
        const current = fs.lstatSync(copyRoot), currentParent = fs.lstatSync(parent);
        return fs.realpathSync(parent) === parent && currentParent.dev === parentIdentity.dev && currentParent.ino === parentIdentity.ino
          && current.isDirectory() && !current.isSymbolicLink() && current.dev === copyIdentity.dev && current.ino === copyIdentity.ino;
      };
      const temporary = path.join(copyRoot, "capture");
      try {
        await fs.promises.copyFile(file, temporary, fs.constants.COPYFILE_EXCL);
        if (await digest(temporary) !== hash) throw new Error("attempt evidence copy differs");
        if (!copyCurrent()) throw new Error("attempt evidence destination changed");
        fsyncPath(temporary); fs.renameSync(temporary, target); fsyncPath(path.dirname(target));
      } finally { if (copyCurrent()) fs.rmSync(copyRoot, { recursive: true, force: true }); }
    }
    if (await digest(target) !== hash) throw new Error("attempt evidence backup differs");
    fsyncPath(target);
    for (let parent = path.dirname(target);; parent = path.dirname(parent)) {
      fsyncPath(parent);
      if (parent === evidenceParent) break;
    }
    const savedStat = fs.lstatSync(target, { bigint: true });
    if (!savedStat.isFile()) throw new Error("attempt evidence destination changed");
    saved.set(target, signature(savedStat));
    manifest.push({ path: relative, savedPath, hash });
  }
  if (!current()) throw new Error("attempt evidence changed during preservation");
  if (files.length) writeJsonDurably(path.join(destination, "manifest.json"), { original, identity,
    pipelineId: retention?.pipelineId ?? null, launchId: retention?.launchId ?? null, files: manifest });
  return { current, ...(files.length ? { destination } : {}) };
}
