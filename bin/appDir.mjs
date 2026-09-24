import { lstatSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";

/**
 * The one answer to "which folder under the config (or cache) root is the
 * app's" (docs/design/rename-delegatus.md §4.2). Plain ESM with no imports
 * beyond node builtins, so the launcher scripts in `bin/`, the TypeScript
 * sources and the shell entry points all resolve the same folder.
 *
 * - A real `<root>/delegatus` directory is a new install and wins. A real
 *   `<root>/agent-log-viewer` beside it means two installs; one line says so.
 * - Otherwise an existing `<root>/agent-log-viewer` is used, spelled that way,
 *   because every path an existing install recorded (registry transcript
 *   paths, account homes, absolute symlinks into `shared/`, the runtime-host
 *   socket) uses that spelling. `<root>/delegatus` exists there only as the
 *   link {@link linkAppDirIn} makes, which is not "a real directory".
 * - Neither exists: `<root>/delegatus`, created by the first write as before.
 *
 * Nothing here moves or copies data.
 */
export const APP_DIR = "delegatus";
/** The app dir every install before the rename used. */
export const LEGACY_APP_DIR = "agent-log-viewer";
/** The app dir before that one, still read as a fallback for config files. */
export const FORMER_APP_DIR = "live-log-viewer";
/** Every name the app dir has had, newest first. */
export const APP_DIR_NAMES = [APP_DIR, LEGACY_APP_DIR, FORMER_APP_DIR];

function isRealDirectory(candidate) {
  try { return lstatSync(candidate).isDirectory(); } catch { return false; }
}

function isDirectory(candidate) {
  try { return statSync(candidate).isDirectory(); } catch { return false; }
}

function linkPresent(candidate) {
  try { lstatSync(candidate); return true; } catch { return false; }
}

const warnedRoots = new Set();

function warnTwoInstalls(root, preferred, legacy) {
  if (warnedRoots.has(root)) return;
  warnedRoots.add(root);
  console.warn(`[delegatus] both ${preferred} and ${legacy} are real directories; using ${preferred}, and ${legacy} is not read.`);
}

/** The app dir under `root` (a config root or a cache root). */
export function appDirIn(root) {
  const preferred = join(root, APP_DIR);
  const legacy = join(root, LEGACY_APP_DIR);
  if (isRealDirectory(preferred)) {
    if (isRealDirectory(legacy)) warnTwoInstalls(root, preferred, legacy);
    return preferred;
  }
  if (isDirectory(legacy)) return legacy;
  return preferred;
}

/**
 * The one-time step for an existing install: `<root>/delegatus` becomes a
 * relative symlink to `agent-log-viewer`, so the name users see reaches every
 * file while the data and its recorded spelling stay where they are. One
 * `symlink(2)`, no copy. Reversal is removing the link.
 *
 * It is a state-mutating startup step, and deciding who may run it is the
 * caller's job (`src/lib/configDir.ts` asks the #1905 gates first). Returns
 * `linked` when this call made the link, `present` when something already
 * holds the name, `none` when there is no existing install to link to, and
 * `failed` when the filesystem refused (the link is a convenience, so a
 * refusal changes nothing that resolves).
 */
export function linkAppDirIn(root) {
  const preferred = join(root, APP_DIR);
  if (linkPresent(preferred)) return "present";
  if (!isRealDirectory(join(root, LEGACY_APP_DIR))) return "none";
  try {
    symlinkSync(LEGACY_APP_DIR, preferred, "dir");
    return "linked";
  } catch (error) {
    return error?.code === "EEXIST" ? "present" : "failed";
  }
}

/** Whether {@link linkAppDirIn} has anything left to do under `root`. */
export function appDirLinkPending(root) {
  return !linkPresent(join(root, APP_DIR)) && isRealDirectory(join(root, LEGACY_APP_DIR));
}

/** Test seam: the two-installs warning is once per root per process. */
export function resetAppDirWarningsForTests() {
  warnedRoots.clear();
}
