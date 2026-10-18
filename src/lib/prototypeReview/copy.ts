import crypto from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { openedAt } from "@/lib/artifact/localFile";
import { sniffAgrees } from "@/lib/artifact/serve";
import { admittedSource, PrototypeError, PROTOTYPE_LIMITS, unreadableSource } from "./input";
import type { PrototypeMedia } from "./types";

const MIME: Record<string, PrototypeMedia["mime"]> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".mp4": "video/mp4", ".webm": "video/webm",
};
export function mediaFilename(media: PrototypeMedia): string {
  if (!/^[a-f0-9]{64}$/.test(media.id) || !Object.values(MIME).includes(media.mime)) throw new PrototypeError("invalid stored media");
  const ext = media.mime.split("/")[1] === "jpeg" ? "jpg" : media.mime.split("/")[1];
  return `${media.id}.${ext}`;
}
export function sniffPrototype(mime: PrototypeMedia["mime"], head: Buffer): boolean {
  if (mime === "video/mp4") return head.length >= 16 && head.readUInt32BE(0) >= 16
    && head.subarray(4,8).toString("ascii") === "ftyp" && /^(isom|iso[2-9]|mp4[12]|avc1|dash|M4V |MSNV)$/.test(head.subarray(8,12).toString("ascii"));
  if (mime === "video/webm") return head.length >= 8 && head.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]))
    && head.includes(Buffer.from("webm"));
  return sniffAgrees(mime, head);
}
export async function copyMedia(raw: string, staging: string, admit: (raw: string) => Promise<string> = admittedSource): Promise<PrototypeMedia> {
  const mime = MIME[path.extname(raw).toLowerCase()];
  if (!mime) throw new PrototypeError("media must be PNG, JPEG, WebP, MP4 or WebM");
  const max = mime.startsWith("video/") ? PROTOTYPE_LIMITS.videoBytes : PROTOTYPE_LIMITS.imageBytes;
  const real = await admit(raw);
  let handle;
  try {
    // Opened before it is known to be a file, so a pipe under that name must not hold the open.
    handle = await fs.open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const pinned = await handle.stat();
    // The roots are checked against the file that was opened, never against the path again.
    if (!pinned.isFile() || !await openedAt(handle, real)) throw unreadableSource(raw);
    if (pinned.size > max) throw new PrototypeError(`one ${mime.startsWith("video/") ? "video" : "image"} exceeds ${max} bytes`);
    const buffer = Buffer.alloc(Math.min(max + 1, pinned.size + 1));
    let size = 0;
    while (size < buffer.length) {
      // Bound each synchronous hashing slice, including a maximum-size video.
      const read = await handle.read(buffer, size, Math.min(256 * 1024, buffer.length - size), size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size !== pinned.size || (await handle.stat()).size !== pinned.size || size > max) throw new PrototypeError("media changed while publishing; nothing was published");
    return await writeMediaCopy(buffer.subarray(0,size), mime, staging);
  } catch (error) {
    if (error instanceof PrototypeError) throw error;
    throw unreadableSource(raw);
  } finally { await handle?.close(); }
}

/** The same validator and durable copy for bytes recovered from a transcript. */
export async function writeMediaCopy(data: Buffer, mime: PrototypeMedia["mime"], staging: string): Promise<PrototypeMedia> {
  const max = mime.startsWith("video/") ? PROTOTYPE_LIMITS.videoBytes : PROTOTYPE_LIMITS.imageBytes;
  if (data.length > max) throw new PrototypeError("media exceeds the copy bound");
  if (!sniffPrototype(mime,data.subarray(0,512))) throw new PrototypeError("content does not match the media type",415);
  const hash = crypto.createHash("sha256");
  for (let at = 0; at < data.length; at += 256 * 1024) {
    hash.update(data.subarray(at, at + 256 * 1024));
    if (at + 256 * 1024 < data.length) await new Promise<void>(resolve => setImmediate(resolve));
  }
  const media = { id: hash.digest("hex"), mime, bytes: data.length };
  await fs.writeFile(path.join(staging,mediaFilename(media)), data, { flag: "wx", mode: 0o600, flush: true }).catch(error => {
    if (error.code !== "EEXIST") throw error;
  });
  return media;
}
