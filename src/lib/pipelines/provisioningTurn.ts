import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";

const host = globalThis as typeof globalThis & {
  __llvProvisioningRepositories?: Map<string, Promise<void>>;
  __llvProvisioningCheckouts?: Map<string, Map<string | null, Promise<void>>>;
};

async function checkoutKey(directory: string): Promise<string | null> {
  try { return await realpath(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
    try { return path.join(await realpath(path.dirname(directory)), path.basename(directory)); }
    catch { return null; }
  }
}

/** Shared refs stay serialized through checkout. Each worktree remains exclusively
 * owned until its dependency preparation and the caller's final checks settle. */
export async function withProvisioningTurn<T>(repository: string, directory: string,
  wait: (predecessor: Promise<void>) => Promise<void>, run: (checkoutReady: () => void) => Promise<T>): Promise<T> {
  const key = await checkoutKey(directory);
  const repositories = host.__llvProvisioningRepositories ??= new Map();
  const byRepository = host.__llvProvisioningCheckouts ??= new Map();
  const checkouts = byRepository.get(repository) ?? new Map<string | null, Promise<void>>();
  byRepository.set(repository, checkouts);
  // An unresolvable path might alias any active checkout in this repository.
  const predecessors = key === null ? [...checkouts.values()]
    : [checkouts.get(key), checkouts.get(null)].filter((held): held is Promise<void> => held !== undefined);
  const finished = Promise.withResolvers<void>();
  checkouts.set(key, finished.promise);
  try {
    if (predecessors.length) {
      const previousCheckouts = Promise.all(predecessors).then(() => {});
      try { await wait(previousCheckouts); } catch (error) { await previousCheckouts; throw error; }
    }
    const previous = repositories.get(repository);
    const git = Promise.withResolvers<void>();
    repositories.set(repository, git.promise);
    const releaseGit = () => {
      git.resolve();
      if (repositories.get(repository) === git.promise) repositories.delete(repository);
    };
    try {
      if (previous) {
        try { await wait(previous); } catch (error) { await previous; throw error; }
      }
      return await run(() => {
        // Git may have created the directory since it entered the queue. Only
        // release early when its physical worktree still has the reserved name.
        if (key === null) return;
        let actual: string;
        try { actual = realpathSync.native(directory); } catch { return; }
        if (actual === key) releaseGit();
      });
    } finally { releaseGit(); }
  } finally {
    finished.resolve();
    if (checkouts.get(key) === finished.promise) checkouts.delete(key);
    if (checkouts.size === 0) byRepository.delete(repository);
  }
}
