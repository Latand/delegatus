import fs from "node:fs";
import { normalizeSessionLine } from "@/lib/session/reader";
import { messageTextDigest } from "@/lib/runtime/messageTextDigest";

/** The next journaled user occurrence after a hook's byte cursor. Read work
 * is bounded independently of transcript length; never join by words alone. */
export function nativeOccurrenceAfter(filename: string, engine: "claude" | "codex", offset: number, digest?: string, excluded: ReadonlySet<string> = new Set()) {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filename, "r");
    const size = fs.fstatSync(fd).size;
    if (offset < 0 || offset >= size) return null;
    const bytes = Buffer.alloc(Math.min(size - offset, 256000));
    const read = fs.readSync(fd, bytes, 0, bytes.length, offset);
    // An incomplete record has no occurrence identity yet.
    let position = 0;
    for (;;) {
      const end = bytes.subarray(0, read).indexOf(10, position);
      if (end < 0) break;
      const occurrenceOffset = offset + position;
      const line = bytes.subarray(position, end).toString("utf8");
      position = end + 1;
      try {
        const row = JSON.parse(line);
        const user = normalizeSessionLine(engine, row).find(({ record }) => record.kind === "message" && record.role === "user");
        if (user?.record.kind === "message") {
          const occurrenceDigest = messageTextDigest(user.record.text);
          const key = `native:${messageTextDigest(line)}`;
          if ((!digest || occurrenceDigest === digest) && !excluded.has(key)) return { key, digest: occurrenceDigest, offset: occurrenceOffset };
        }
      } catch { /* A concurrently appended partial record is retried later. */ }
    }
  } catch { /* No materialized transcript yet. */ }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  return null;
}

/** Some CLIs journal the submitted input before running its hook. Only the
 * native occurrence id can select that row from a repeated-text transcript. */
export function nativeHookCursor(filename: string, engine: "claude" | "codex", nativeId: string) {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filename, "r");
    const size = fs.fstatSync(fd).size, start = Math.max(0, size - 256000);
    const bytes = Buffer.alloc(size - start);
    fs.readSync(fd, bytes, 0, bytes.length, start);
    let activeTurn: string | undefined;
    // Tail boundaries can split UTF-8 characters. Keep offsets in the original
    // byte buffer rather than re-encoding replacement characters from its text.
    let position = 0;
    for (;;) {
      const end = bytes.indexOf(10, position);
      if (end < 0) break;
      const offset = start + position;
      const line = bytes.subarray(position, end).toString("utf8");
      position = end + 1;
      try {
        const row = JSON.parse(line);
        const user = normalizeSessionLine(engine, row).find(({ record }) => record.kind === "message" && record.role === "user");
        if (engine === "codex" && row.payload?.turn_id) activeTurn = row.payload.turn_id;
        const id = engine === "claude" ? row.uuid : row.payload?.turn_id ?? activeTurn;
        if (id === nativeId && user?.record.kind === "message") return { offset, key: `native:${messageTextDigest(line)}`, digest: messageTextDigest(user.record.text) };
      } catch { /* Skip the partial first or last line in a bounded tail. */ }
    }
    return { offset: size, key: undefined, digest: undefined };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { offset: 0, key: undefined, digest: undefined };
    throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
