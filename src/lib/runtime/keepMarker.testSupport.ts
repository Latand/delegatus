import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The one way a test writes a `.delegatus-keep` marker.
 *
 * Retention honours a marker for ever, so a marker a test leaves behind pins its
 * whole tree: a run that dies between planting and cleaning leaves a root that
 * no sweep removes. The helper confines every marker to the test process's own
 * temp root (`os.tmpdir()`, which the test preload points at a root of the run)
 * and remembers it, so the file's `afterEach` removes it whether the test passed
 * or failed. `keepMarker.guard.test.ts` rejects a test file that writes the
 * marker any other way.
 */
export const KEEP_MARKER = ".delegatus-keep";

const planted = new Set<string>();

function physical(target: string): string {
  // Resolve the deepest existing ancestor so a symlinked parent cannot hide an escape.
  const tail: string[] = [];
  let current = path.resolve(target);
  for (;;) {
    try { return path.join(fs.realpathSync(current), ...tail.reverse()); }
    catch {
      const parent = path.dirname(current);
      if (parent === current) return path.join(current, ...tail.reverse());
      tail.push(path.basename(current)); current = parent;
    }
  }
}

/** True when `file` lies strictly inside this process's temp root. */
export function insideTestTempRoot(file: string): boolean {
  const root = physical(os.tmpdir()), resolved = physical(file);
  const relative = path.relative(root, resolved);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** Writes a keep marker at `file` (default text: a human pin) inside the test temp root. */
export function plantKeepMarker(file: string, text = "operator pin"): string {
  if (path.basename(file) !== KEEP_MARKER) throw new Error(`not a keep marker path: ${file}`);
  if (!insideTestTempRoot(file)) throw new Error(`a test keep marker must live inside the test temp root: ${file}`);
  planted.add(file);
  fs.writeFileSync(file, text);
  return file;
}

/** Markers planted and not yet removed. */
export function plantedKeepMarkers(): string[] { return [...planted]; }

/** Call from `afterEach`. Removes every planted marker that still exists, even when its tree was moved or removed. */
export function removeKeepMarkers(): void {
  for (const file of planted) {
    try {
      if (fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) fs.unlinkSync(file);
    } catch { /* already gone with its root */ }
  }
  planted.clear();
}
