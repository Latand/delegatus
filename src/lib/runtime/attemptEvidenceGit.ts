import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AttemptTempBudgetDeferred } from "./attemptTempDiagnostics";

export const MAX_ATTEMPT_EVIDENCE_BLOBS = 8192;
const LOOKUP_MS = 2000;
const GIT_LINE_END = process.platform === "win32" ? /\r?\n/ : "\n";

export type AttemptEvidenceFallback = "repository-unavailable" | "object-format" | "object-store-unverified"
  | "evidence-index-unavailable" | "lookup-limit" | "git-lookup" | "git-deadline";
type Blob = { id: string; bytes: number };
type BlobLookup = { present: Set<string>; fallback?: never } | { fallback: AttemptEvidenceFallback };

function git(cwd: string, args: string[], timeout: number, batch?: { input: string; objects: string }): Promise<string> {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^GIT_/i.test(name)) delete env[name];
  }
  return new Promise((resolve, reject) => {
    const child = execFile("git", args, { cwd, timeout, env: { ...env,
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull, GIT_NO_REPLACE_OBJECTS: "1",
      GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0",
      ...(batch ? { GIT_OBJECT_DIRECTORY: batch.objects } : {}),
    }, killSignal: "SIGKILL", maxBuffer: MAX_ATTEMPT_EVIDENCE_BLOBS * 80 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
    child.stdin?.on("error", () => { /* The exit and complete response determine the result. */ });
    child.stdin?.end(batch?.input);
  });
}

const within = (file: string, directory: string) => file === directory || file.startsWith(directory + path.sep);

function objectStoreIdentity(objects: string) {
  // An alternate may point into the tree being retired. The primary store
  // alone must be sufficient before we use Git as the retained copy.
  const alternates = path.join(objects, "info", "alternates");
  if (fs.lstatSync(alternates, { throwIfNoEntry: false })) return null;
  const stat = fs.statSync(objects, { bigint: true });
  return stat.isDirectory() ? `${stat.dev}:${stat.ino}` : null;
}

function checkoutIdentity(repo: string) {
  const stat = fs.lstatSync(path.join(repo, ".git"), { bigint: true });
  if (stat.isDirectory()) return `${stat.dev}:${stat.ino}`;
  return stat.isFile() ? `${stat.dev}:${stat.ino}:${stat.ctimeNs}` : null;
}

/** A complete response from one local object store. A partial result grants
 * no permission to omit a file. */
export async function attemptEvidenceRepository(repoDir: string | undefined, source: string, original: string,
  remaining: () => number) {
  const run = async (cwd: string, args: string[], batch?: { input: string; objects: string }) => {
    const available = Math.floor(remaining());
    const deferred = "attempt evidence preservation deadline exceeded during Git lookup; retry next tick";
    if (available <= 0) throw new AttemptTempBudgetDeferred(deferred);
    try {
      return await git(cwd, args, Math.min(available, LOOKUP_MS), batch);
    } catch (error) {
      if (available <= LOOKUP_MS && gitTimedOut(error)) throw new AttemptTempBudgetDeferred(deferred);
      throw error;
    }
  };
  const failure = (error: unknown): { fallback: AttemptEvidenceFallback } => {
    if (error instanceof AttemptTempBudgetDeferred) throw error;
    return { fallback: gitTimedOut(error) ? "git-deadline" : "git-lookup" };
  };
  // The lane path must name a repository root. Git's ancestor discovery is
  // insufficient for a folder whose repository disappeared.
  const repo = repoDir && path.isAbsolute(repoDir)
    ? await fs.promises.realpath(repoDir).catch(() => null) : null;
  if (!repo || within(repo, source) || within(repo, original)) return { fallback: "repository-unavailable" } as const;
  try {
    const [top, objectPath, format, end, ...rest] = (await run(repo,
      ["rev-parse", "--show-toplevel", "--path-format=absolute", "--git-path", "objects", "--show-object-format"])).split(GIT_LINE_END);
    if (end !== "" || rest.length || !path.isAbsolute(top) || await fs.promises.realpath(top) !== repo)
      return { fallback: "repository-unavailable" } as const;
    if (format !== "sha1") return { fallback: "object-format" } as const;
    const objects = await fs.promises.realpath(objectPath);
    if (within(objects, source) || within(objects, original)) return { fallback: "object-store-unverified" } as const;
    const identity = objectStoreIdentity(objects), checkout = checkoutIdentity(repo);
    if (!identity || !checkout) return { fallback: "object-store-unverified" } as const;
    const current = () => fs.realpathSync(repoDir!) === repo
      && checkoutIdentity(repo) === checkout && fs.realpathSync(objectPath) === objects && objectStoreIdentity(objects) === identity;
    return { current, async contains(blobs: readonly Blob[]): Promise<BlobLookup> {
      try {
        const input = blobs.map(blob => blob.id).join("\n") + "\n";
        const stdout = await run(repo, ["cat-file", "--batch-check"], { input, objects });
        const lines = stdout.split(GIT_LINE_END);
        if (lines.pop() !== "" || lines.length !== blobs.length || !current()) return { fallback: "git-lookup" };
        const present = new Set<string>();
        for (const [index, { id, bytes }] of blobs.entries()) {
          const line = lines[index];
          if (line === `${id} blob ${bytes}`) present.add(id);
          else if (line !== `${id} missing`) return { fallback: "git-lookup" };
        }
        return { present };
      } catch (error) { return failure(error); }
    } };
  } catch (error) { return failure(error); }
}

function gitTimedOut(error: unknown) {
  const result = error as { killed?: boolean; code?: unknown };
  return result.killed && result.code === null;
}
