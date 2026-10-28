import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { attemptTreeHasNoEvidence } from "./attemptTempFilesystem";
import { statePath } from "@/lib/configDir";
import { fsyncPath, writeJsonDurably } from "@/lib/state/durableJson";

const media = /\.(?:png|jpe?g|webp|gif|avif|svg|pdf|mp4|webm)$/i;
const signature = (stat: fs.BigIntStats) => [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");

/** Preserve existing captures, including legacy roots, before any retirement.
 * Each call inventories the current tree; a crash needs no migration flag.
 * The returned synchronous fence detects edits during the final owner read. */
export async function preserveAttemptEvidence(directory: string, original: string, identity: string): Promise<{ current: () => boolean; namespaceOnly: boolean }> {
  const until = performance.now() + 30_000;
  const budget = () => { if (performance.now() >= until) throw new Error("attempt evidence preservation deadline exceeded"); };
  if (fs.realpathSync(directory) !== directory) throw new Error("linked attempt evidence source");
  const source = new Map<string, string>(), saved = new Map<string, string>();
  const files: string[] = [];
  const walk = async (relative: string, artifact = false) => {
    budget();
    const file = path.join(directory, relative), stat = await fs.promises.lstat(file, { bigint: true });
    const protectedFile = artifact || media.test(relative);
    if (stat.isSymbolicLink()) {
      if (protectedFile || path.basename(relative) === ".artifacts") throw new Error("linked attempt evidence");
      return;
    }
    if (stat.isDirectory()) {
      source.set(relative, signature(stat));
      const entries = await fs.promises.opendir(file);
      for await (const entry of entries) {
        budget();
        const child = path.join(relative, entry.name), protectedChild = artifact || entry.name === ".artifacts";
        if (entry.isDirectory() || protectedChild || media.test(child)) await walk(child, protectedChild);
      }
    } else if (protectedFile) {
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
  try { await walk(""); }
  catch (error) {
    if (process.platform !== "linux" || !["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    await attemptTreeHasNoEvidence(directory, original);
    if (!current()) throw new Error("attempt evidence source changed");
    return { current, namespaceOnly: true };
  }
  const key = createHash("sha256").update(original).update("\0").update(identity).digest("hex");
  const destination = statePath("evidence", "attempt-temp", key);
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
  if (files.length) writeJsonDurably(path.join(destination, "manifest.json"), { original, identity, files: manifest });
  return { current, namespaceOnly: false };
}
