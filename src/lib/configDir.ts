import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isStagingMode, STAGING_STATE_DIRNAME } from "@/lib/staging";
import { admitOperatorDirectory, mayRunStateStartupMutation } from "@/lib/stateOwnership";
import { stateMutationRefusal } from "@/lib/state/stateMutationBarrier";

import { APP_DIR, APP_DIR_NAMES, appDirIn, appDirLinkPending, FORMER_APP_DIR, linkAppDirIn } from "../../bin/appDir.mjs";

function configRoot(): string {
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
}

function cacheRoot(): string {
  return process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
}

const resolvedAppDirs = new Map<string, string>();

/**
 * The app dir under the config root: `delegatus` for a new install, the
 * `agent-log-viewer` spelling for an existing one (`bin/appDir.mjs`).
 */
export function appConfigDir(): string {
  const root = configRoot();
  const held = resolvedAppDirs.get(root);
  if (held) return held;
  const dir = appDirIn(root);
  /* Held once it exists, so `statePath()` stays free of filesystem calls
     (#1987) and a process never switches spellings under itself. A fresh
     home is asked again until its first write creates the dir, and a
     relative root is always asked again: it names another directory after a
     `chdir`. */
  if (path.isAbsolute(root) && fs.existsSync(dir)) resolvedAppDirs.set(root, dir);
  return dir;
}

/**
 * Resolve a config file under the app dir at call time: the app dir's copy
 * wins, and the former live-log-viewer copy is returned only when it is the
 * one that exists. Callers read the returned path and treat a missing file as
 * "no override", so falling through to the (possibly absent) app-dir path is
 * safe.
 */
export function configFilePath(name: string): string {
  return resolveWithFallback(configRoot(), name);
}

/**
 * Resolve a cache entry (file or dir) under the app dir with the same
 * app-dir-first, former-dir-fallback logic as {@link configFilePath}.
 */
export function cacheEntryPath(name: string): string {
  return resolveWithFallback(cacheRoot(), name);
}

function resolveWithFallback(root: string, name: string): string {
  const preferred = path.join(appDirIn(root), name);
  if (fs.existsSync(preferred)) return preferred;
  const former = path.join(root, FORMER_APP_DIR, name);
  if (fs.existsSync(former)) return former;
  return preferred;
}

const linkedRoots = new Set<string>();

/**
 * The one-time name move of an existing install (rename-delegatus.md §4.2):
 * `<config>/delegatus` becomes a link to the `agent-log-viewer` data, which
 * stays where it is. A state-mutating startup step (#1905), so against the
 * operator's own directories only the serving Viewer or the runtime host,
 * after the Viewer's activation opened the barrier, performs it; a build, a
 * test or a script stands down, and a later call retries. Exported for tests.
 */
export function ensureAppDirLink(root: string = configRoot()): void {
  if (linkedRoots.has(root)) return;
  /* Two lstats settle the common cases for good: the link (or a new
     install's real dir) is already there, or there is no existing install. */
  if (!appDirLinkPending(root)) {
    linkedRoots.add(root);
    return;
  }
  const link = path.join(root, APP_DIR);
  if (!mayRunStateStartupMutation(link)) return;
  if (stateMutationRefusal(link) !== null) return;
  const outcome = linkAppDirIn(root);
  if (outcome === "failed") {
    console.error(`[delegatus] could not link ${link} to the existing app dir; the existing name keeps working`);
  }
  linkedRoots.add(root);
}

/** Test seam: the app dir and the link step are settled once per config root
    per process. */
export function resetAppDirForTests(): void {
  resolvedAppDirs.clear();
  linkedRoots.clear();
}

/* Viewer-owned mutable state used to live under ~/.claude/viewer-state and
   ~/.claude/viewer-inbox — inside another tool's directory. It now lives in
   the app's own config dir; the first access copies the legacy content over,
   so flows, workflows, tasks, push subscriptions and inbox images survive
   the move. The legacy dirs are left in place untouched. */
const migrated = new Set<string>();

/* Completion marker inside the target dir. A bare "target exists" check
   cannot distinguish a finished migration from a dir that fresh state writes
   created after an interrupted one — only the sentinel says the legacy
   content actually arrived. */
const MIGRATED_SENTINEL = ".migrated-from-legacy";

/**
 * Copy-once move of a legacy dir into its new home; exported for tests.
 *
 * The copy lands in a temp sibling first and reaches the target through an
 * atomic rename, so a crash mid-copy leaves no half-filled target. A target
 * that exists without the sentinel (state writes raced an earlier failed
 * attempt) heals by copying the legacy entries it is missing, never
 * overwriting newer files. Failures are logged and stay un-memoized, so the
 * next call retries instead of silently accepting an empty state dir.
 */
export function migrateLegacyDir(target: string, legacy: string): void {
  if (process.env.LLV_RESOURCE_OBSERVATION_WORKER === "1") return;
  /* A finished migration has nothing left to decide. Asked first, it spares
     every later `statePath()` the ownership checks below (#1987). */
  if (migrated.has(target)) return;
  /* A migration is a state-mutating startup step (#1905): against the
     operator's own directories only the serving Viewer or the runtime host
     runs it. Everyone else reads what that migration already produced — the
     sentinel has been in place since the move — so standing down is the
     honest answer, never a refusal that would take a reader down with it. */
  if (!mayRunStateStartupMutation(target)) return;
  /* A copy-once move of live state is a startup step, and this one is reached
     from a module scope (`INBOX_DIR`) and from every `statePath()` call. A
     `next build` worker loading route modules therefore ran it against the
     operator's config dir (#1905). It is not memoized when refused: the
     serving Viewer's activation performs it. */
  if (stateMutationRefusal(target) !== null) return;
  const sentinel = path.join(target, MIGRATED_SENTINEL);
  const stamp = () => `${new Date().toISOString()} ${legacy}\n`;
  try {
    if (fs.existsSync(sentinel)) {
      migrated.add(target);
      return;
    }
    if (!fs.existsSync(legacy)) {
      /* Nothing to migrate: mark that decision too, so a legacy dir that
         appears later (a rollback, a restored backup) never clobbers state
         accumulated here in the meantime. */
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(sentinel, stamp());
      migrated.add(target);
      return;
    }
    if (!fs.existsSync(target)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const tmp = `${target}.migrating.${process.pid}`;
      fs.rmSync(tmp, { recursive: true, force: true });
      try {
        fs.cpSync(legacy, tmp, { recursive: true });
        fs.writeFileSync(path.join(tmp, MIGRATED_SENTINEL), stamp());
        fs.renameSync(tmp, target);
      } catch (error) {
        fs.rmSync(tmp, { recursive: true, force: true });
        throw error;
      }
      migrated.add(target);
      return;
    }
    /* Partial target from a pre-sentinel run: fill in whatever legacy
       entries are missing, keep everything already written here. */
    fs.cpSync(legacy, target, { recursive: true, force: false, errorOnExist: false });
    fs.writeFileSync(sentinel, stamp());
    migrated.add(target);
  } catch (error) {
    console.error(`viewer state migration ${legacy} -> ${target} failed; will retry:`, error);
  }
}

/**
 * Root of the viewer's mutable state (flows, workflows, tasks, lineage,
 * events, push keys, limits cache). LLV_STATE_DIR overrides it wholesale —
 * tests and sandboxed runs point it at a scratch dir.
 */
export function stateDir(): string {
  const override = process.env.LLV_STATE_DIR;
  if (isStagingMode()) return stagingStateDir(override);
  if (override) return override;
  const resolved = path.join(appConfigDir(), "state");
  const dir = admitOperatorDirectory(resolved, "state");
  if (dir !== resolved) return dir;
  ensureAppDirLink();
  migrateLegacyDir(dir, path.join(os.homedir(), ".claude", "viewer-state"));
  return dir;
}

/* The staging isolation seam (#659). A staging process must never resolve
   its mutable state (registry, events, board, pipelines, flows, release
   records) into the prod state dir — not by default, not by misconfigured
   override, and never through the legacy migration copy, which would clone
   prod state into staging or stamp sentinels into shared legacy dirs. */
function stagingStateDir(override: string | undefined): string {
  const dir = override || path.join(appConfigDir(), STAGING_STATE_DIRNAME);
  const resolved = path.resolve(dir);
  const prodDirs = [
    ...APP_DIR_NAMES.map((name) => path.join(configRoot(), name, "state")),
    path.join(os.homedir(), ".claude", "viewer-state"),
  ];
  if (prodDirs.some((prod) => path.resolve(prod) === resolved)) {
    throw new Error(`staging mode refuses the production state dir ${resolved}; set LLV_STATE_DIR to a staging-only dir`);
  }
  return dir;
}

/** A file or subdirectory inside the viewer state dir. */
export function statePath(...segments: string[]): string {
  return path.join(stateDir(), ...segments);
}

/** Composer-pasted images the agents receive as file paths. Staging keeps
    its inbox inside the staging state dir, so composer uploads on the
    staging instance never land in (or migrate) the prod inbox. */
export function inboxDir(): string {
  if (isStagingMode()) return statePath("inbox");
  const resolved = path.join(appConfigDir(), "inbox");
  const dir = admitOperatorDirectory(resolved, "inbox");
  if (dir !== resolved) return dir;
  ensureAppDirLink();
  migrateLegacyDir(dir, path.join(os.homedir(), ".claude", "viewer-inbox"));
  return dir;
}
