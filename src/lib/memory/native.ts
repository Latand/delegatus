import fs from "node:fs";
import { normalizeSessionLine } from "@/lib/session/reader";
import { messageTextDigest } from "@/lib/runtime/messageTextDigest";

/** The next journaled user occurrence after a hook's byte cursor. Read work
 * is bounded independently of transcript length; never join by words alone. */
export function nativeOccurrenceAfter(filename: string, engine: "claude" | "codex", offset: number) {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filename, "r");
    const size = fs.fstatSync(fd).size;
    if (offset < 0 || offset >= size) return null;
    const bytes = Buffer.alloc(Math.min(size - offset, 256000));
    const read = fs.readSync(fd, bytes, 0, bytes.length, offset);
    const text = bytes.subarray(0, read).toString("utf8");
    // An incomplete record has no occurrence identity yet.
    for (const line of text.slice(0, text.lastIndexOf("\n")).split("\n")) {
      try {
        const row = JSON.parse(line);
        const user = normalizeSessionLine(engine, row).find(({ record }) => record.kind === "message" && record.role === "user");
        if (user?.record.kind === "message") return { key: `native:${messageTextDigest(line)}`, digest: messageTextDigest(user.record.text) };
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
    const text = bytes.toString("utf8");
    let offset = start;
    let activeTurn: string | undefined;
    for (const line of text.slice(0, text.lastIndexOf("\n")).split("\n")) {
      try {
        const row = JSON.parse(line);
        const user = normalizeSessionLine(engine, row).find(({ record }) => record.kind === "message" && record.role === "user");
        if (engine === "codex" && row.payload?.turn_id) activeTurn = row.payload.turn_id;
        const id = engine === "claude" ? row.uuid : row.payload?.turn_id ?? activeTurn;
        if (id === nativeId && user?.record.kind === "message") return { offset, key: `native:${messageTextDigest(line)}`, digest: messageTextDigest(user.record.text) };
      } catch { /* Skip the partial first or last line in a bounded tail. */ }
      offset += Buffer.byteLength(line) + 1;
    }
    return { offset: size, key: undefined, digest: undefined };
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
