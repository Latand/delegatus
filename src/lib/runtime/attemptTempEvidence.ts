import { copyAttemptEvidenceWithinBudget } from "./attemptTempCopy";
import { attemptTempRemaining, checkAttemptTempDeadline } from "./attemptTempDeadline";
import { AttemptTempBudgetDeferred } from "./attemptTempDiagnostics";
import { attemptEvidenceRepository, MAX_ATTEMPT_EVIDENCE_BLOBS, type AttemptEvidenceFallback } from "./attemptEvidenceGit";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { attemptTreeHasNoEvidence, ledgerLinkedEvidence } from "./attemptTempFilesystem";
import { statePath } from "@/lib/configDir";
import { fsyncPath, writeJsonDurably } from "@/lib/state/durableJson";
import { isPreservedMedia } from "@/lib/artifact/evidenceFormats";

const signature = (stat: fs.BigIntStats) => [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");

export type AttemptEvidenceSelection = {
  skippedTracked: { count: number; bytes: number };
  selectionFallback?: AttemptEvidenceFallback;
};
type AttemptEvidenceResult = {
  current: () => boolean;
  namespaceOnly: boolean;
  destination?: string;
  selection?: AttemptEvidenceSelection;
};

/** Preserve captures and explicit artifacts before ordinary retirement.
 * Media already stored as a blob by the lane's repository can be omitted.
 * When the lookup cannot prove that, keep the source media.
 * The returned synchronous fence detects edits during the final owner read. */
export async function preserveAttemptEvidence(directory: string, original: string, identity: string,
  retention?: { pipelineId: string | null; launchId: string; repoDir?: string; repoCurrent?: () => boolean;
    register: (destination: string) => void }): Promise<AttemptEvidenceResult> {
  const until = performance.now() + attemptTempRemaining(30_000);
  const budget = () => {
    checkAttemptTempDeadline();
    if (performance.now() >= until) throw new AttemptTempBudgetDeferred("attempt evidence preservation deadline exceeded; retry next tick");
  };
  if (fs.realpathSync(directory) !== directory) throw new Error("linked attempt evidence source");
  const source = new Map<string, string>(), saved = new Map<string, string>();
  const files: Array<{ relative: string; artifact: boolean }> = [];
  let repositoryCurrent: (() => boolean) | undefined;
  const walk = async (relative: string, artifact = false) => {
    budget();
    const file = path.join(directory, relative), stat = await fs.promises.lstat(file, { bigint: true });
    const protectedFile = artifact || isPreservedMedia(relative);
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
        if (entry.isDirectory() || protectedChild || isPreservedMedia(child)) await walk(child, protectedChild);
      }
    } else if (protectedFile) {
      if (!stat.isFile()) throw new Error("attempt evidence is not a regular file");
      source.set(relative, signature(stat)); files.push({ relative, artifact });
    }
  };
  const current = () => {
    try {
      if (fs.realpathSync(directory) !== directory) return false;
      const root = fs.lstatSync(directory);
      if (`${root.dev}:${root.ino}` !== identity) return false;
      for (const [relative, expected] of source) {
        budget();
        if (signature(fs.lstatSync(path.join(directory, relative), { bigint: true })) !== expected) return false;
      }
      for (const [file, expected] of saved) {
        budget();
        if (fs.realpathSync(path.dirname(file)) !== path.dirname(file)
          || signature(fs.lstatSync(file, { bigint: true })) !== expected) return false;
      }
      return repositoryCurrent?.() ?? true;
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
  const digest = async (file: string, identifyBlob = false) => {
    budget();
    if (!fs.lstatSync(file).isFile()) throw new Error("attempt evidence is not a regular file");
    if (fs.realpathSync(path.dirname(file)) !== path.dirname(file)) throw new Error("linked attempt evidence parent");
    const hash = createHash("sha256");
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) throw new Error("attempt evidence is not a regular file");
      const blob = identifyBlob ? createHash("sha1").update(`blob ${stat.size}\0`) : undefined;
      let bytes = 0;
      for await (const chunk of fs.createReadStream(file, { fd, autoClose: false })) {
        budget();
        bytes += chunk.length;
        hash.update(chunk);
        blob?.update(chunk);
      }
      if (bytes !== stat.size) throw new Error("attempt evidence changed during hashing");
      return { hash: hash.digest("hex"), blob: blob && { id: blob.digest("hex"), bytes } };
    } finally { fs.closeSync(fd); }
  };
  const selection: AttemptEvidenceSelection = { skippedTracked: { count: 0, bytes: 0 } };
  const digests = new Map<string, Awaited<ReturnType<typeof digest>>>();
  let tracked = new Set<string>();
  if (retention?.pipelineId) {
    const candidates = files.filter(file => !file.artifact);
    if (candidates.length > MAX_ATTEMPT_EVIDENCE_BLOBS) selection.selectionFallback = "lookup-limit";
    else if (candidates.length) {
      const repository = await attemptEvidenceRepository(retention.repoDir, directory, original,
        () => attemptTempRemaining(until - performance.now()));
      budget();
      if (repository.fallback) selection.selectionFallback = repository.fallback;
      else {
        let explicitlyLinked: Set<string> | undefined;
        try { explicitlyLinked = new Set(ledgerLinkedEvidence(original)); }
        catch { selection.selectionFallback = "evidence-index-unavailable"; }
        if (explicitlyLinked) {
          const blobs = new Map<string, { id: string; bytes: number }>();
          for (const { relative } of candidates) {
            if (explicitlyLinked.has(relative)) continue;
            const result = await digest(path.join(directory, relative), true);
            digests.set(relative, result);
            if (result.blob) blobs.set(result.blob.id, result.blob);
          }
          if (blobs.size) {
            const result = await repository.contains([...blobs.values()]);
            budget();
            if (result.fallback) selection.selectionFallback = result.fallback;
            else {
              tracked = result.present;
              if (tracked.size) repositoryCurrent = () => repository.current() && (retention.repoCurrent?.() ?? true);
            }
          }
        }
      }
    }
  }
  const manifest: Array<{ path: string; savedPath: string; hash: string }> = [];
  for (const { relative } of files) {
    const file = path.join(directory, relative);
    const { hash, blob } = digests.get(relative) ?? await digest(file);
    if (blob && tracked.has(blob.id)) {
      selection.skippedTracked.count++;
      selection.skippedTracked.bytes += blob.bytes;
      continue;
    }
    if (!manifest.length) retention?.register(destination);
    let savedPath = path.join("files", relative), target = path.join(destination, savedPath);
    if (fs.existsSync(target) && (await digest(target)).hash !== hash) {
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
        await copyAttemptEvidenceWithinBudget(file, temporary);
        if ((await digest(temporary)).hash !== hash) throw new Error("attempt evidence copy differs");
        if (!copyCurrent()) throw new Error("attempt evidence destination changed");
        fsyncPath(temporary); fs.renameSync(temporary, target); fsyncPath(path.dirname(target));
      } finally { if (copyCurrent()) fs.rmSync(copyRoot, { recursive: true, force: true }); }
    }
    if ((await digest(target)).hash !== hash) throw new Error("attempt evidence backup differs");
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
  if (manifest.length) writeJsonDurably(path.join(destination, "manifest.json"), { original, identity,
    pipelineId: retention?.pipelineId ?? null, launchId: retention?.launchId ?? null, ...selection, files: manifest });
  return { current, namespaceOnly: false, selection, ...(manifest.length ? { destination } : {}) };
}
