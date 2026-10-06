import { constants } from "node:fs";
import fs from "node:fs/promises";
import { NextRequest, NextResponse } from "next/server";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { refuseAnonymous, teamActor } from "@/lib/team";
import { parseByteRange } from "@/lib/artifact/serve";
import { streamWindow } from "@/lib/artifact/localFile";
import { PrototypeError } from "./input";
import { openedAt } from "./pinned";
import { prototypeRoot, roundMedia, sniffPrototype, storedMediaPath } from "./store";
import { prototypeWorld, taskForPrototype, type PrototypeWorld } from "./world";

/** Only descriptor-pinned bytes named by this task's stored manifest. */
export async function prototypeMediaGET(request: NextRequest,taskId: string,reviewId: string,mediaId: string,
  kind: "image" | "video",world: PrototypeWorld = prototypeWorld): Promise<NextResponse> {
  const rejected = rejectCrossOrigin(request); if (rejected) return rejected;
  const anonymous = refuseAnonymous(teamActor(request)); if (anonymous) return anonymous;
  let handle;
  try {
    const task = taskForPrototype(taskId,world.caller(request));
    const round = task.prototypeReviews?.find(r => r.id === reviewId);
    const media = round && !round.mediaRemovedAt ? roundMedia(round).find(m => m.id === mediaId && m.mime.startsWith(`${kind}/`)) : null;
    if (!media) throw new PrototypeError("media not found",404);
    const candidate = storedMediaPath(await fs.realpath(prototypeRoot()),reviewId,media);
    handle = await fs.open(candidate,constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const pinned = await handle.stat();
    // The open file itself must be the store's copy: a round directory swapped for a link answers from elsewhere.
    if (!pinned.isFile() || pinned.size !== media.bytes || !await openedAt(handle,candidate)) throw new PrototypeError("stored media is unavailable",404);
    const head = Buffer.alloc(Math.min(512,pinned.size));
    await handle.read(head,0,head.length,0);
    if (!sniffPrototype(media.mime,head)) throw new PrototypeError("stored media type disagrees",415);
    const range = parseByteRange(request.headers.get("range"),pinned.size);
    if (range === "unsatisfiable") {
      await handle.close(); handle = undefined;
      return new NextResponse(null,{ status: 416, headers: { "content-range": `bytes */${pinned.size}` } });
    }
    const { start,end } = range ?? { start: 0, end: pinned.size - 1 };
    const stream = streamWindow(handle,start,end,request.signal,30_000); handle = undefined;
    return new NextResponse(stream,{ status: range ? 206 : 200, headers: {
      "content-type": media.mime, "content-length": String(end-start+1), "accept-ranges": "bytes",
      "cache-control": "private, no-store", "x-content-type-options": "nosniff", "content-security-policy": "sandbox; default-src 'none'",
      ...(range ? { "content-range": `bytes ${start}-${end}/${pinned.size}` } : {}),
    } });
  } catch (error) {
    await handle?.close();
    return NextResponse.json({ error: error instanceof PrototypeError ? error.message : "stored media is unavailable" },{ status: error instanceof PrototypeError ? error.status : 404 });
  }
}
