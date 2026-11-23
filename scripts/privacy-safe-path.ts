import { lstatSync, readFileSync } from "node:fs";
import { join, parse, relative, resolve, sep } from "node:path";

/** Read a regular file only when every existing path component is non-symlink. */
export function readSafeRegularFile(file: string): Buffer {
  const absolute = resolve(file);
  const root = parse(absolute).root;
  let current = root;
  let metadata = lstatSync(root);
  if (metadata.isSymbolicLink()) throw new Error("unsafe file path");
  for (const segment of relative(root, absolute).split(sep).filter(Boolean)) {
    current = join(current, segment);
    metadata = lstatSync(current);
    if (metadata.isSymbolicLink()) throw new Error("unsafe file path");
  }
  if (!metadata.isFile()) throw new Error("unsafe file path");
  return readFileSync(absolute);
}
