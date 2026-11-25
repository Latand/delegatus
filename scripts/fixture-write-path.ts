import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

/** The caller owns a freshly allocated root. Symlinks used as fixture inputs
 * are read-only, including links to files that do not exist yet. */
export function fixtureWritePath(root: string, file: string): string {
  const target = path.resolve(root, file);
  const relative = path.relative(root, target);
  const refuse = (reason: string) => new Error(`Fixture write refused for ${file}: ${reason}`);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw refuse("target must be inside the fixture's temporary root");
  }
  if (realpathSync(root) !== root) throw refuse("temporary root is no longer at its original path");
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    const entry = lstatSync(current, { throwIfNoEntry: false });
    if (!entry) break;
    if (entry.isSymbolicLink()) throw refuse("target traverses a symbolic link");
    if (entry.isFile() && entry.nlink > 1) throw refuse("target traverses a hard-linked file");
  }
  return target;
}
