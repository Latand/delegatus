import { constants } from "node:fs";
import fs from "node:fs/promises";
import { NextRequest, NextResponse } from "next/server";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { refuseAnonymous, teamActor } from "@/lib/team";
import { parseByteRange } from "@/lib/artifact/serve";
import { openedAt, streamWindow } from "@/lib/artifact/localFile";
import { PrototypeError } from "./input";
import { prototypeRoot, roundMedia, sniffPrototype, storedMediaPath } from "./store";
import { prototypeWorld, taskForPrototype, type PrototypeWorld } from "./world";
import { loadSeatRounds } from "./seatRounds";
import { canonicalProject } from "@/lib/projects/aliases";
import type { PrototypeReviewRound } from "./types";
import { resolveShortId } from "@/lib/shortIds";

/** The round a media read names: the task's, or with no task a seat's own
    pictures, read only from the seat's project. */
function mediaRound(taskId: string,reviewId: string,kind: "image" | "video",caller: ReturnType<PrototypeWorld["caller"]>): PrototypeReviewRound | undefined {
  const rounds = taskId ? taskForPrototype(taskId,caller).prototypeReviews ?? [] : kind === "image" ? loadSeatRounds() : [];
  const resolution = resolveShortId(rounds.map(round => round.id), reviewId);
  if (resolution.kind === "ambiguous") throw new PrototypeError("review id is ambiguous; pass more characters", 409);
  const round = resolution.kind === "match" ? rounds.find(candidate => candidate.id === resolution.value) : undefined;
  if (round && caller.conversationId && (!caller.project || canonicalProject(round.project) !== canonicalProject(caller.project))) throw new PrototypeError("prototype access is limited to the caller's project",403);
  return round;
}
/** Only descriptor-pinned bytes named by this task's stored manifest. */
export async function prototypeMediaGET(request: NextRequest,taskId: string,reviewId: string,mediaId: string,
  kind: "image" | "video",world: PrototypeWorld = prototypeWorld): Promise<NextResponse> {
  const rejected = rejectCrossOrigin(request); if (rejected) return rejected;
  const anonymous = refuseAnonymous(teamActor(request)); if (anonymous) return anonymous;
  let handle;
  try {
    const round = mediaRound(taskId,reviewId,kind,world.caller(request));
    const matchingMedia = round && !round.mediaRemovedAt ? roundMedia(round).filter(m => m.mime.startsWith(`${kind}/`)) : [];
    const mediaResolution = resolveShortId(matchingMedia.map(m => m.id), mediaId);
    if (mediaResolution.kind === "ambiguous") throw new PrototypeError("media id is ambiguous; pass more characters",409);
    const media = mediaResolution.kind === "match" ? matchingMedia.find(m => m.id === mediaResolution.value) : null;
    if (!media) throw new PrototypeError("media not found",404);
    const candidate = storedMediaPath(await fs.realpath(prototypeRoot()),round!.id,media);
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
