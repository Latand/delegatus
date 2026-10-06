import crypto from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { statePath } from "@/lib/configDir";
import { sniffAgrees } from "@/lib/artifact/serve";
import { loadTasks, mutateTasks } from "@/lib/tasks/store";
import type { BoardTask } from "@/lib/tasks/types";
import { withFileTransaction } from "@/lib/state/fileTransaction";
import { admittedSource, expandPrototypeInput, PrototypeError, PROTOTYPE_LIMITS, unreadableSource } from "./input";
import { openedAt } from "./pinned";
import type { PrototypeMedia, PrototypeReviewRound, PublishPrototypeInput } from "./types";

const MIME: Record<string, PrototypeMedia["mime"]> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".mp4": "video/mp4", ".webm": "video/webm",
};
export const prototypeRoot = () => statePath("prototype-reviews");
/** Under the publication lock, retire only directories marked by this store. */
async function removeOrphanCopies(): Promise<void> {
  const live = new Set(loadTasks().flatMap(task => (task.prototypeReviews ?? []).filter(round => !round.mediaRemovedAt).map(round => round.id)));
  for (const entry of await fs.readdir(prototypeRoot(), { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^(pr_[a-f0-9]{32}|\.publish-[A-Za-z0-9]+)$/.test(entry.name)) continue;
    if (live.has(entry.name)) continue;
    const directory = path.join(prototypeRoot(), entry.name);
    const marker = path.join(directory, "manifest.json");
    try {
      const info = await fs.lstat(marker);
      if (!info.isFile() || info.size > 100) continue;
      const manifest = JSON.parse(await fs.readFile(marker, "utf8"));
      if (Object.keys(manifest).length !== 1 || !/^pr_[a-f0-9]{32}$/.test(manifest.id)
        || (entry.name.startsWith("pr_") && entry.name !== manifest.id)) continue;
    } catch { continue; }
    await fs.rm(directory, { recursive: true, force: true });
  }
}
export function roundDirectory(id: string): string {
  if (!/^pr_[a-f0-9]{32}$/.test(id)) throw new PrototypeError("invalid review id");
  return path.join(prototypeRoot(), id);
}
/** Where a stored copy lies under the store's resolved root. The root may be
    reached through a link (a chosen state directory); nothing below it may. */
export function storedMediaPath(realRoot: string, reviewId: string, media: PrototypeMedia): string {
  if (!/^pr_[a-f0-9]{32}$/.test(reviewId)) throw new PrototypeError("invalid review id");
  return path.join(realRoot, reviewId, mediaFilename(media));
}
export function mediaFilename(media: PrototypeMedia): string {
  if (!/^[a-f0-9]{64}$/.test(media.id) || !Object.values(MIME).includes(media.mime)) throw new PrototypeError("invalid stored media");
  const ext = media.mime.split("/")[1] === "jpeg" ? "jpg" : media.mime.split("/")[1];
  return `${media.id}.${ext}`;
}
export function roundMedia(round: PrototypeReviewRound): PrototypeMedia[] {
  return round.variants.flatMap(v => [...v.frames.flatMap(f => [f.image, ...(f.original ? [f.original] : [])]), ...v.videos.map(v => v.media)]);
}
export function sniffPrototype(mime: PrototypeMedia["mime"], head: Buffer): boolean {
  if (mime === "video/mp4") return head.length >= 16 && head.readUInt32BE(0) >= 16
    && head.subarray(4,8).toString("ascii") === "ftyp" && /^(isom|iso[2-9]|mp4[12]|avc1|dash|M4V |MSNV)$/.test(head.subarray(8,12).toString("ascii"));
  if (mime === "video/webm") return head.length >= 8 && head.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]))
    && head.includes(Buffer.from("webm"));
  return sniffAgrees(mime, head);
}
async function copyMedia(raw: string, staging: string): Promise<PrototypeMedia> {
  const mime = MIME[path.extname(raw).toLowerCase()];
  if (!mime) throw new PrototypeError("media must be PNG, JPEG, WebP, MP4 or WebM");
  const max = mime.startsWith("video/") ? PROTOTYPE_LIMITS.videoBytes : PROTOTYPE_LIMITS.imageBytes;
  const real = await admittedSource(raw);
  let handle;
  try {
    handle = await fs.open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
    const pinned = await handle.stat();
    // The roots are checked against the file that was opened, never against the path again.
    if (!pinned.isFile() || !await openedAt(handle, real)) throw unreadableSource(raw);
    if (pinned.size > max) throw new PrototypeError(`one ${mime.startsWith("video/") ? "video" : "image"} exceeds ${max} bytes`);
    const buffer = Buffer.alloc(Math.min(max + 1, pinned.size + 1));
    let size = 0;
    while (size < buffer.length) {
      const read = await handle.read(buffer, size, buffer.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size !== pinned.size || (await handle.stat()).size !== pinned.size || size > max) throw new PrototypeError("media changed while publishing; nothing was published");
    const data = buffer.subarray(0,size);
    if (!sniffPrototype(mime,data.subarray(0,512))) throw new PrototypeError("content does not match the media type",415);
    const media = { id: crypto.createHash("sha256").update(data).digest("hex"), mime, bytes: size };
    await fs.writeFile(path.join(staging,mediaFilename(media)), data, { flag: "wx", mode: 0o600, flush: true }).catch(error => {
      if (error.code !== "EEXIST") throw error;
    });
    return media;
  } catch (error) {
    if (error instanceof PrototypeError) throw error;
    throw unreadableSource(raw);
  } finally { await handle?.close(); }
}
export function mutatePrototypeRound<T>(taskId: string, reviewId: string, change: (round: PrototypeReviewRound, task: BoardTask) => T): T {
  return mutateTasks(tasks => {
    const task = tasks.find(t => t.id === taskId);
    const round = task?.prototypeReviews?.find(r => r.id === reviewId);
    if (!task || !round) throw new PrototypeError("review not found",404);
    const before = JSON.stringify(round);
    const result = change(round,task);
    if (JSON.stringify(round) === before) return { tasks: undefined, result };
    task.updatedAt = new Date().toISOString();
    return { tasks, result };
  });
}
export function findPrototypeRound(taskId: string, reviewId: string): PrototypeReviewRound | undefined {
  return loadTasks().find(t => t.id === taskId)?.prototypeReviews?.find(r => r.id === reviewId);
}
/** Metadata is a task extension in the existing revisioned, linked SQLite store. */
export async function publishPrototype(input: PublishPrototypeInput, taskId: string, source: PrototypeReviewRound["source"]): Promise<PrototypeReviewRound> {
  const publicationKey = `${source.conversationId ?? "operator"}:${input.clientRequestId}`;
  const inputDigest = crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const id = `pr_${crypto.createHash("sha256").update(publicationKey).digest("hex").slice(0,32)}`;
  const replay = () => {
    const existing = loadTasks().flatMap(t => t.prototypeReviews ?? []).find(r => r.publicationKey === publicationKey);
    if (existing && (existing.inputDigest !== inputDigest || existing.taskId !== taskId)) throw new PrototypeError("publication key already belongs to another payload",409);
    return existing;
  };
  const held = replay(); if (held) return held;
  await fs.mkdir(prototypeRoot(), { recursive: true, mode: 0o700 });
  return withFileTransaction(path.join(prototypeRoot(),"publication.lock"),"prototype publication is busy",async () => {
    const held = replay(); if (held) return held;
    await removeOrphanCopies();
    const expanded = await expandPrototypeInput(input);
    const count = expanded.variants.reduce((n,v) => n + (v.frames ?? []).reduce((n,f) => n + (f.originalPath ? 2 : 1),0) + (v.videos?.length ?? 0),0);
    if (count > PROTOTYPE_LIMITS.media) throw new PrototypeError(`review exceeds ${PROTOTYPE_LIMITS.media} media files`);
    if (expanded.variants.some(v => !v.frames?.length && !v.videos?.length)) throw new PrototypeError("every variant needs at least one frame or video");
    const staging = await fs.mkdtemp(path.join(prototypeRoot(),".publish-"));
    let committed = false;
    const removed: string[] = [];
    try {
      await fs.writeFile(path.join(staging,"manifest.json"),JSON.stringify({ id }), { mode: 0o600, flush: true });
      const round: PrototypeReviewRound = { id, taskId, project: "", title: input.title, publicationKey, inputDigest, source,
        createdAt: new Date().toISOString(), variants: [] };
      let bytes = 0, imageBytes = 0;
      const copy = async (raw: string) => {
        const media = await copyMedia(raw,staging); bytes += media.bytes;
        if (media.mime.startsWith("image/")) imageBytes += media.bytes;
        if (bytes > PROTOTYPE_LIMITS.setBytes || imageBytes > PROTOTYPE_LIMITS.imageSetBytes) throw new PrototypeError("review exceeds 192 MiB total or 48 MiB of images");
        return media;
      };
      for (const variant of expanded.variants) {
        const frames = [];
        for (const frame of variant.frames ?? []) {
          const image = await copy(frame.path);
          if (!image.mime.startsWith("image/")) throw new PrototypeError("frames must be images");
          const original = frame.originalPath ? await copy(frame.originalPath) : undefined;
          if (original && !original.mime.startsWith("image/")) throw new PrototypeError("originals must be images");
          frames.push({ image, ...(original ? { original } : {}), caption: frame.caption, ...(frame.width ? { width: frame.width } : {}), ...(frame.lang ? { lang: frame.lang } : {}) });
        }
        const videos = [];
        for (const video of variant.videos ?? []) {
          const media = await copy(video.path);
          if (!media.mime.startsWith("video/")) throw new PrototypeError("videos must be MP4 or WebM");
          videos.push({ media, caption: video.caption });
        }
        round.variants.push({ number: variant.number, name: variant.name, description: variant.description, frames, videos });
      }
      // The publication lock owns this id. An earlier interrupted copy has no metadata.
      await fs.rm(roundDirectory(id),{ recursive: true, force: true });
      await fs.rename(staging,roundDirectory(id));
      mutateTasks(tasks => {
        const task = tasks.find(t => t.id === taskId);
        if (!task) throw new PrototypeError("task not found",404);
        round.project = task.project;
        /* The task's history budget. The new round supersedes every undecided
           one before it, so those leave first, oldest first, bytes and all. A
           decision is never dropped: a task whose budget is all decisions
           takes no further round. */
        const history = [...task.prototypeReviews ?? []];
        const dropped: string[] = [];
        const over = () => history.length + 1 > PROTOTYPE_LIMITS.taskRounds
          || Buffer.byteLength(JSON.stringify([...history,round])) > PROTOTYPE_LIMITS.taskMetadataBytes;
        while (over()) {
          const at = history.findIndex(r => !r.decision);
          if (at < 0) throw new PrototypeError(`this task already holds ${history.length} decided prototype rounds, the most its history keeps (${PROTOTYPE_LIMITS.taskRounds} rounds, ${PROTOTYPE_LIMITS.taskMetadataBytes} bytes of metadata). Nothing was published. Publish the next round on a follow-up task`,409);
          dropped.push(history.splice(at,1)[0]!.id);
        }
        if (dropped.length) task.prototypeReviews = history;
        removed.push(...dropped);
        const all = tasks.flatMap(t => (t.prototypeReviews ?? []).map(r => ({ task: t, round: r })));
        const now = Date.now();
        for (const item of all) {
          if (!item.round.mediaRemovedAt && item.task.status === "done" && now - Date.parse(item.task.doneAt ?? item.task.updatedAt) > 30 * 86400_000) {
            item.round.mediaRemovedAt = round.createdAt; removed.push(item.round.id);
          }
        }
        const live = all.filter(item => !item.round.mediaRemovedAt);
        let total = bytes + live.reduce((n,item) => n + roundMedia(item.round).reduce((n,m) => n + m.bytes,0),0);
        let rounds = live.length + 1;
        for (const item of live.sort((a,b) => a.round.createdAt.localeCompare(b.round.createdAt))) {
          if (total <= PROTOTYPE_LIMITS.storeBytes && rounds <= PROTOTYPE_LIMITS.storedRounds) break;
          item.round.mediaRemovedAt = round.createdAt; removed.push(item.round.id);
          total -= roundMedia(item.round).reduce((n,m) => n + m.bytes,0); rounds--;
        }
        task.prototypeReviews = [...task.prototypeReviews ?? [],round];
        task.updatedAt = round.createdAt;
        // Bytes arrive before the metadata commit. A failed commit removes this owned directory.
        return { tasks, result: undefined };
      });
      committed = true;
      for (const old of removed) await fs.rm(roundDirectory(old),{ recursive: true, force: true });
      return round;
    } finally {
      await fs.rm(staging,{ recursive: true, force: true });
      if (!committed) await fs.rm(roundDirectory(id),{ recursive: true, force: true });
    }
  });
}
