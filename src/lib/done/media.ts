import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { statePath } from "@/lib/configDir";
import { openAdmitted, streamWindow } from "@/lib/artifact/localFile";
import { mediaFilename, sniffPrototype } from "@/lib/prototypeReview/copy";
import type { PrototypeMedia } from "@/lib/prototypeReview/types";
import { withFileTransaction } from "@/lib/state/fileTransaction";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/capabilityHeader";
import { refuseAnonymous, teamActor } from "@/lib/team";
import type { DoneFrame } from "./types";

/** This owner retains at most 128 pairs / 64 MiB, oldest capture first.
 * A single in-flight copy adds at most two 4 MiB images. No lane owns these files.
 * The bounded manifest is persisted; restarts neither reset the cap nor re-admit
 * an evicted URL. Acknowledgement undo may reuse a copy until retention removes it.
 */
export const DONE_MEDIA_ITEMS = 128;
export const DONE_MEDIA_BYTES = 64 * 1024 * 1024;
export const doneMediaRoot = () => statePath("done-media");
interface Entry { owner: string; directory: string; frame: DoneFrame; media: PrototypeMedia[]; at: number }
export type DoneFrameCopy = (src: string, staging: string) => Promise<PrototypeMedia | null>;
const directoryOf = (owner: string) => crypto.createHash("sha256").update(owner).digest("hex");
export const storedDoneFrame = (frame: DoneFrame) => frame.unavailable || frame.src.startsWith("/api/image?done=");
const url = (owner: string, media: PrototypeMedia) => `/api/image?${new URLSearchParams({ done: owner, media: media.id })}`;

async function index(): Promise<Entry[]> {
  try {
    const file = await openAdmitted(path.join(await fs.realpath(doneMediaRoot()), "index.json"));
    try {
      if ((await file.stat()).size > 256 * 1024) throw new Error("done media manifest exceeds its bound");
      const rows: Entry[] = JSON.parse(await file.readFile("utf8"));
      if (!Array.isArray(rows) || rows.length > DONE_MEDIA_ITEMS || rows.some(row => !row || typeof row.owner !== "string" || row.directory !== directoryOf(row.owner)
        || !Number.isFinite(row.at) || !Array.isArray(row.media) || row.media.length < 1 || row.media.length > 2
        || row.media.some(media => !media.mime.startsWith("image/") || !Number.isInteger(media.bytes) || media.bytes < 1 || media.bytes > 4 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(media.id)))) throw new Error("invalid done media manifest");
      if (rows.reduce((total,row)=>total+row.media.reduce((n,m)=>n+m.bytes,0),0)>DONE_MEDIA_BYTES) throw new Error("done media exceeds the byte bound");
      return rows;
    } finally { await file.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
async function save(rows: Entry[]): Promise<void> {
  const next = path.join(doneMediaRoot(), "index.next");
  await fs.rm(next,{force:true});
  await fs.writeFile(next, JSON.stringify(rows), { flag:"wx", mode: 0o600, flush: true });
  await fs.rename(next, path.join(doneMediaRoot(), "index.json"));
}
/** Under the owner lock, remove only this store's named copies and staging.
 * Also recover a crash between manifest commit and orphan removal. */
async function clean(rows: Entry[]): Promise<void> {
  const live = new Set(rows.map(row => row.directory));
  for (const entry of await fs.readdir(doneMediaRoot(), { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^(?:[a-f0-9]{64}|\.copy-[A-Za-z0-9]+)$/.test(entry.name) || live.has(entry.name)) continue;
    await fs.rm(path.join(doneMediaRoot(), entry.name), { recursive: true, force: true });
  }
}
async function owned<T>(work: () => Promise<T>): Promise<T> {
  await fs.mkdir(doneMediaRoot(), { recursive: true, mode: 0o700 });
  return withViewerOperation("done.media", () => withFileTransaction(path.join(doneMediaRoot(), "owner.lock"), "done media is busy", work));
}
export async function preserveDoneFrame(owner: string, frame: DoneFrame, copy: DoneFrameCopy, now: number): Promise<DoneFrame> {
  if (storedDoneFrame(frame)) return frame;
  return owned(async () => {
    const rows = await index();
    await clean(rows);
    const held = rows.find(row => row.owner === owner);
    if (held) return held.frame;
    const staging = await fs.mkdtemp(path.join(doneMediaRoot(), ".copy-"));
    try {
      const after = await copy(frame.src, staging);
      if (!after) return { ...frame, unavailable: true };
      const before = frame.before ? await copy(frame.before, staging) : null;
      const media = [...new Map([after, ...(before ? [before] : [])].map(m => [m.id, m])).values()];
      const filenames = new Set(media.map(mediaFilename));
      for (const name of await fs.readdir(staging)) if (!filenames.has(name)) await fs.unlink(path.join(staging,name));
      const saved = { src: url(owner, after), ...(before ? { before: url(owner, before) } : {}), caption: frame.caption };
      const entry: Entry = { owner, directory: directoryOf(owner), frame: saved, media, at: now };
      rows.push(entry);
      rows.sort((a,b) => a.at - b.at || a.owner.localeCompare(b.owner));
      const bytes = () => rows.reduce((n,row) => n + row.media.reduce((n,m) => n + m.bytes, 0), 0);
      while (rows.length > DONE_MEDIA_ITEMS || bytes() > DONE_MEDIA_BYTES) rows.shift();
      if (!rows.includes(entry)) return { ...frame, unavailable: true };
      await fs.rename(staging, path.join(doneMediaRoot(), entry.directory));
      await save(rows);
      await clean(rows);
      return saved;
    } finally { await fs.rm(staging, { recursive: true, force: true }); }
  });
}
/** Kept acknowledgements retain undo's frames. Removing an item retires its
 * media on the next sweep. Read owners under this lock, after awaited copies. */
export async function removeDoneMedia(owners: readonly string[]): Promise<void> {
  return owned(async () => {
    const rows = await index();
    const removed = new Set(owners);
    const kept = rows.filter(row => !removed.has(row.owner));
    if (kept.length !== rows.length) await save(kept);
    await clean(kept);
  });
}
/** The item id and bounded manifest name the only bytes this route can serve. */
export async function doneMediaGET(req: NextRequest, owner: string, id: string): Promise<NextResponse> {
  return withViewerOperation("done.media", () => serveDoneMedia(req,owner,id));
}
async function serveDoneMedia(req: NextRequest, owner: string, id: string): Promise<NextResponse> {
  const rejected = rejectCrossOrigin(req); if (rejected) return rejected;
  const anonymous = refuseAnonymous(teamActor(req)); if (anonymous) return anonymous;
  if (req.headers.has(VIEWER_SPAWN_CAPABILITY_HEADER)) return NextResponse.json({ error: "finished frames are operator-only" }, { status: 403 });
  let handle;
  try {
    const entry = (await index()).find(row => row.owner === owner);
    const media = entry?.media.find(m => m.id === id);
    if (!entry || !media) return NextResponse.json({ error: "frames were not retained" }, { status: 404 });
    const root = await fs.realpath(doneMediaRoot());
    handle = await openAdmitted(path.join(root, entry.directory, mediaFilename(media)));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== media.bytes) throw new Error("unavailable copy");
    const head = Buffer.alloc(Math.min(stat.size, 512));
    await handle.read(head,0,head.length,0);
    if (!sniffPrototype(media.mime,head)) throw new Error("invalid copy");
    const stream = streamWindow(handle,0,stat.size-1,req.signal,30_000); handle = undefined;
    return new NextResponse(stream, { headers: { "content-type": media.mime, "content-length": String(stat.size), "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
  } catch {
    return NextResponse.json({ error: "frames were not retained" }, { status: 404 });
  } finally { await handle?.close(); }
}
