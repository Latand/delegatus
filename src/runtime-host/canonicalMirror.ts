import fs from "node:fs";

import { retryTransientNetwork } from "@/lib/git/transientFailure";
import {
  canonicalRevisionQuery,
  isExactRevision,
  REQUESTED_REVISION_REFUSAL,
  revisionNotFoundMessage,
} from "@/lib/runtime/canonicalRevision";

export interface CanonicalMirrorOptions {
  deploymentDir: string;
  mirrorDir: string;
  remote: string;
}

export interface CanonicalMirrorDependencies {
  /** `timeoutMs` bounds one network attempt; a runner that cannot enforce it
      is still bounded by the adapter action's own deadline. */
  run(argv: string[], options?: { timeoutMs?: number }): Promise<string>;
  /** Injected in tests; a real wait otherwise. */
  sleep?(ms: number): Promise<void>;
  /** Told each time a transient network failure is about to be retried, so
      the deployment can say "network unavailable, retrying" meanwhile. */
  onRetry?(detail: string): void;
}

/* A resolver that fails one lookup in six refused two deploys outright
   (#2220). Three attempts two and four seconds apart ride that out; each
   fetch is bounded at 25 seconds, so the worst case (3 × 25 s + 6 s = 81 s)
   stays inside the 110-second `resolve-revision` action deadline. A refused
   login, a missing repository and anything unrecognized fail at once. */
const MIRROR_NETWORK_BACKOFF_MS = [2_000, 4_000] as const;
const MIRROR_FETCH_TIMEOUT_MS = 25_000;

function retryMirrorNetwork<T>(dependencies: CanonicalMirrorDependencies, operation: () => Promise<T>): Promise<T> {
  return retryTransientNetwork(operation, {
    backoffMs: MIRROR_NETWORK_BACKOFF_MS,
    sleep: dependencies.sleep,
    onRetry: dependencies.onRetry,
    action: "retry the deploy",
  });
}

async function isValidBareMirror(directory: string, run: CanonicalMirrorDependencies["run"]): Promise<boolean> {
  try {
    return (await run(["git", "--git-dir", directory, "rev-parse", "--is-bare-repository"])).trim() === "true";
  } catch {
    return false;
  }
}

function syncDirectory(directory: string): void {
  const fd = fs.openSync(directory, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

export async function ensureCanonicalMirror(
  options: CanonicalMirrorOptions,
  dependencies: CanonicalMirrorDependencies,
): Promise<void> {
  fs.mkdirSync(options.deploymentDir, { recursive: true, mode: 0o700 });
  const incomingDir = `${options.mirrorDir}.incoming`;
  if (!await isValidBareMirror(options.mirrorDir, dependencies.run)) {
    fs.rmSync(options.mirrorDir, { recursive: true, force: true });
    await retryMirrorNetwork(dependencies, async () => {
      fs.rmSync(incomingDir, { recursive: true, force: true });
      await dependencies.run(["git", "clone", "--mirror", options.remote, incomingDir]);
    });
    if (!await isValidBareMirror(incomingDir, dependencies.run)) throw new Error("canonical mirror clone is invalid");
    fs.renameSync(incomingDir, options.mirrorDir);
    syncDirectory(options.deploymentDir);
  } else {
    fs.rmSync(incomingDir, { recursive: true, force: true });
  }
  await dependencies.run(["git", "--git-dir", options.mirrorDir, "remote", "set-url", "origin", options.remote]);
  await retryMirrorNetwork(dependencies, () => dependencies.run(
    ["git", "--git-dir", options.mirrorDir, "fetch", "--prune", "origin", "+refs/heads/*:refs/heads/*"],
    { timeoutMs: MIRROR_FETCH_TIMEOUT_MS },
  ));
}

/**
 * Resolves a requested deploy revision to the immutable commit it names, in the
 * canonical mirror (#1033). A branch ref resolves to the tip the canonical
 * repository holds right now; an explicit SHA resolves to itself when the
 * mirror actually carries that object — `rev-parse --verify <40-hex>` alone
 * echoes any well-formed hex string back, which is why the `^{commit}` peel is
 * the check that matters.
 */
export async function resolveCanonicalRevision(
  requested: string,
  options: Pick<CanonicalMirrorOptions, "mirrorDir" | "remote">,
  dependencies: CanonicalMirrorDependencies & { ensureMirror(): Promise<void> },
): Promise<string> {
  const query = canonicalRevisionQuery(requested);
  if (!query) throw new Error(REQUESTED_REVISION_REFUSAL);
  await dependencies.ensureMirror();
  let revision: string;
  try {
    revision = await dependencies.run(["git", "--git-dir", options.mirrorDir, "rev-parse", "--verify", query]);
  } catch {
    throw new Error(revisionNotFoundMessage(requested, options.remote));
  }
  if (!isExactRevision(revision)) throw new Error("canonical repository returned an invalid revision");
  return revision;
}
