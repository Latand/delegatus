import fs from "node:fs";

export type AttemptEvidenceBinding = { original: string; identity: string; pipelineId?: string | null; launchId?: string | null };

/** The evidence writer publishes ownership before its final `files` array.
 * Read just that bounded header, even for a multi-megabyte manifest. The file
 * list describes captures; it grants no ownership or deletion authority. */
export function readAttemptEvidenceBinding(filename: string): AttemptEvidenceBinding {
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== BigInt(1) || process.getuid && before.uid !== BigInt(process.getuid())) throw new Error("invalid-evidence-manifest");
    const header = Buffer.alloc(65536), used = fs.readSync(fd, header, 0, header.length, 0), text = header.subarray(0, used).toString("utf8");
    let end = -1, quoted = false, escaped = false, depth = 0;
    for (let index = 0; index < text.length; index++) {
      const character = text[index];
      if (quoted) { if (escaped) escaped = false; else if (character === "\\") escaped = true; else if (character === '"') quoted = false; continue; }
      if (depth === 1 && character === '"' && /^"files"\s*:\s*\[/.test(text.slice(index))) { end = index; break; }
      if (character === '"') quoted = true;
      else if (character === "{" || character === "[") depth++;
      else if (character === "}" || character === "]") depth--;
    }
    const value = (end >= 0 ? JSON.parse(text.slice(0, end).replace(/,\s*$/, "") + "}")
      : before.size <= BigInt(used) ? JSON.parse(text) : null) as AttemptEvidenceBinding | null;
    if (!value || typeof value.original !== "string" || typeof value.identity !== "string" || !/^\d+:\d+$/.test(value.identity)
      || value.pipelineId !== undefined && value.pipelineId !== null && typeof value.pipelineId !== "string"
      || value.launchId !== undefined && value.launchId !== null && typeof value.launchId !== "string") throw new Error("invalid-evidence-binding");
    if (end >= 0) {
      const tail = Buffer.alloc(1024), size = Number(before.size);
      const length = fs.readSync(fd, tail, 0, Math.min(1024, size), Math.max(0, size - 1024));
      if (!/\]\s*}\s*$/.test(tail.subarray(0, length).toString("utf8"))) throw new Error("incomplete-evidence-manifest");
    }
    const after = fs.fstatSync(fd, { bigint: true }), current = fs.lstatSync(filename, { bigint: true });
    if (current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino || after.nlink !== BigInt(1)
      || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) throw new Error("evidence-manifest-changed");
    return { original: value.original, identity: value.identity, pipelineId: value.pipelineId, launchId: value.launchId };
  } finally { fs.closeSync(fd); }
}
