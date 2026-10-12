import sharp from "sharp";
import { z } from "zod";

import { ExternalRelayError, readRelayBytesUrl, relayCall } from "./client";
import { createUrlAllowed, offersCloneCreate, validCloneName, validCloneUsername } from "./cloneNames";
import { refreshRelayTargets } from "./poller";
import {
  readRelayStore,
  updateRelayStore,
  type PairedRelay,
  type RelayCloneRequest,
} from "./store";

/**
 * «Створити клона» over a paired relay (docs/research/celestia-clone-creation.md,
 * «The flow»): the relay stores the request as the owner's draft and answers a
 * `t.me/newbot` link; Telegram creates the bot when the owner confirms there;
 * the relay provisions it and lists it as a target. This install asks for the
 * link, follows the request until it ends, and keeps the open one on the
 * paired relay so a reopened settings page picks up the wait.
 */

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const time = z.iso.datetime({ offset: true });
const reason = z.string().max(300);
const storageKey = z.string().min(1).max(256).regex(/^[\x21-\x7e]+$/);
export const cloneRequestStartedSchema = z.object({
  request_id: id,
  create_url: z.url(),
  expires_at: time,
});
export const cloneRequestStatusSchema = z.object({
  status: z.enum(["pending", "created", "expired", "failed"]),
  target_id: id.optional(),
  username: z.string().max(32).optional(),
  reason: reason.optional(),
});
export type CloneRequestStatus = z.infer<typeof cloneRequestStatusSchema>;
export const cloneAvatarsSchema = z.object({
  candidates: z
    .array(z.object({ storage_key: storageKey, url: z.url() }).loose())
    .min(1)
    .max(4),
});

/** Uploads larger than this are refused before they are decoded. */
export const CLONE_PHOTO_MAX_BYTES = 8 * 1024 * 1024;
/** Telegram's profile photo is a static JPEG; this side sends it square. */
const PHOTO_SIDE = 640;
const PREVIEW_SIDE = 160;
const CANDIDATE_MAX_BYTES = 5 * 1024 * 1024;

export type ClonePhotoInput =
  | null
  | { kind: "upload"; data: string }
  | { kind: "candidate"; storage_key: string };
type ClonePhotoWire =
  | null
  | { kind: "jpeg"; data: string }
  | { kind: "candidate"; storage_key: string };

/**
 * An uploaded picture as the JPEG Telegram's `setMyProfilePhoto` takes:
 * decoded in full, turned upright, cropped square to 640 px. Anything sharp
 * cannot decode is `photo_unreadable`.
 */
export async function cloneJpeg(base64: string): Promise<Buffer> {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || (base64.length * 3) / 4 > CLONE_PHOTO_MAX_BYTES + 3)
    throw new ExternalRelayError("photo_unreadable", 400);
  const bytes = Buffer.from(base64, "base64");
  try {
    return await sharp(bytes, { failOn: "warning", limitInputPixels: 50_000_000 })
      .rotate()
      .resize(PHOTO_SIDE, PHOTO_SIDE, { fit: "cover" })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 85 })
      .toBuffer();
  } catch {
    throw new ExternalRelayError("photo_unreadable", 400);
  }
}

function pairedRelay(relayId: string): PairedRelay {
  const relay = readRelayStore().relays.find((item) => item.id === relayId);
  if (!relay) throw new ExternalRelayError("not_found", 404);
  if (!offersCloneCreate(relay)) throw new ExternalRelayError("clone_create_unsupported", 409);
  return relay;
}

/** A 429 from the relay is its per-owner daily limit, whatever code it gives. */
async function cloneCall<T>(relay: PairedRelay, route: string, method: "GET" | "POST" | "DELETE", body?: unknown, timeoutMs?: number) {
  try {
    return await relayCall<T>(relay.api_base, route, method, body, relay.credential, {
      maxBytes: relay.limits.max_response_bytes,
      ...(timeoutMs ? { timeoutMs } : {}),
    });
  } catch (error) {
    if (error instanceof ExternalRelayError && error.status === 429)
      throw new ExternalRelayError("clone_daily_limit", 429, error.retryAfterSeconds);
    throw error;
  }
}

type CloneRecords = Pick<PairedRelay, "cloneRequest" | "cloneCreated">;
/** Rewrites the relay's open request and created record together; an absent field leaves the store. */
function setCloneRecords(relayId: string, change: (current: CloneRecords) => CloneRecords) {
  updateRelayStore((store) => ({
    ...store,
    relays: store.relays.map((relay) => {
      if (relay.id !== relayId) return relay;
      const next = change({ cloneRequest: relay.cloneRequest, cloneCreated: relay.cloneCreated });
      if (next.cloneRequest === relay.cloneRequest && next.cloneCreated === relay.cloneCreated) return relay;
      const { cloneRequest: _request, cloneCreated: _created, ...rest } = relay;
      return {
        ...rest,
        ...(next.cloneRequest ? { cloneRequest: next.cloneRequest } : {}),
        ...(next.cloneCreated ? { cloneCreated: next.cloneCreated } : {}),
      };
    }),
  }));
}

/**
 * `POST /clone-requests`: one open request per owner on the relay's side, so a
 * new one replaces the stored one here too. A created clone whose setup the
 * card has not finished is refused as `clone_setup_pending`, so a second
 * creation never replaces the record that lets a reopened card finish it.
 */
export async function createCloneRequest(
  relayId: string,
  input: { name: string; username: string; photo: ClonePhotoInput },
): Promise<RelayCloneRequest> {
  const relay = pairedRelay(relayId);
  if (relay.cloneCreated?.target_id) throw new ExternalRelayError("clone_setup_pending", 409);
  const name = input.name.trim();
  if (!validCloneName(name) || !validCloneUsername(input.username))
    throw new ExternalRelayError("refused_here", 400);
  let photo: ClonePhotoWire = null;
  if (input.photo?.kind === "upload")
    photo = { kind: "jpeg", data: (await cloneJpeg(input.photo.data)).toString("base64") };
  else if (input.photo?.kind === "candidate") {
    if (!storageKey.safeParse(input.photo.storage_key).success) throw new ExternalRelayError("refused_here", 400);
    photo = { kind: "candidate", storage_key: input.photo.storage_key };
  }
  const result = await cloneCall(relay, "/clone-requests", "POST", { name, username: input.username, photo }, 15_000);
  const started = cloneRequestStartedSchema.parse(result.body);
  if (!createUrlAllowed(started.create_url)) throw new ExternalRelayError("malformed", result.status);
  const request: RelayCloneRequest = { ...started, name, username: input.username, requestedAt: new Date().toISOString() };
  let displaced = false;
  setCloneRecords(relayId, (current) => {
    // A clone that reached created while the relay was answering keeps its record.
    if (current.cloneCreated?.target_id) { displaced = true; return current; }
    return { ...current, cloneRequest: request };
  });
  if (displaced) {
    await cloneCall(relay, `/clone-requests/${encodeURIComponent(request.request_id)}`, "DELETE").catch(() => undefined);
    throw new ExternalRelayError("clone_setup_pending", 409);
  }
  return request;
}

/**
 * `GET /clone-requests/{id}`. A request that ended leaves the store. A created
 * one refreshes the relay's targets first, so the settings page's next read
 * lists the new clone, and leaves its record on the relay until the card has
 * set the clone up (`cancelCloneRequest` forgets it).
 */
export async function checkCloneRequest(relayId: string, requestId: string): Promise<CloneRequestStatus> {
  const relay = pairedRelay(relayId);
  const result = await cloneCall(relay, `/clone-requests/${encodeURIComponent(requestId)}`, "GET");
  const status = cloneRequestStatusSchema.parse(result.body);
  if (status.status !== "pending") {
    if (status.status === "created") await refreshRelayTargets(relayId);
    const targets = readRelayStore().relays.find((item) => item.id === relayId)?.targets ?? [];
    setCloneRecords(relayId, (current) => {
      // Only the request open here is recorded; a repeated read of one already recorded keeps it.
      if (current.cloneRequest?.request_id !== requestId) return current;
      if (status.status !== "created") return { ...current, cloneRequest: undefined };
      const target = status.target_id ? targets.find((item) => item.id === status.target_id) : undefined;
      return {
        cloneRequest: undefined,
        cloneCreated: {
          request_id: requestId,
          target_id: status.target_id ?? null,
          name: target?.name || current.cloneRequest.name,
          username: status.username || current.cloneRequest.username,
          photo_failed: status.reason === "photo_failed",
          createdAt: new Date().toISOString(),
        },
      };
    });
  }
  return status;
}

/**
 * `DELETE /clone-requests/{id}`: an open request is cancelled on the relay, and
 * one the relay no longer knows is gone either way. For a created clone's
 * record the card says its setup is done, so only the record is forgotten.
 */
export async function cancelCloneRequest(relayId: string, requestId: string): Promise<void> {
  const relay = pairedRelay(relayId);
  if (relay.cloneCreated?.request_id === requestId && relay.cloneRequest?.request_id !== requestId) {
    setCloneRecords(relayId, (current) => current.cloneCreated?.request_id === requestId ? { ...current, cloneCreated: undefined } : current);
    return;
  }
  try {
    await cloneCall(relay, `/clone-requests/${encodeURIComponent(requestId)}`, "DELETE");
  } catch (error) {
    if (!(error instanceof ExternalRelayError && error.status === 404)) throw error;
  }
  setCloneRecords(relayId, (current) => current.cloneRequest?.request_id === requestId ? { ...current, cloneRequest: undefined } : current);
}

export type CloneAvatarCandidate = { storage_key: string; preview: string };

/**
 * `POST /clone-avatars`: the relay's generator draws up to four portraits.
 * This install downloads each one and hands the page a small JPEG of it, so
 * the browser never contacts the relay's image host; a candidate that cannot
 * be read is left out.
 */
export async function generateCloneAvatars(relayId: string, prompt: string): Promise<CloneAvatarCandidate[]> {
  const relay = pairedRelay(relayId);
  const text = prompt.trim();
  if (!text || [...text].length > 500) throw new ExternalRelayError("refused_here", 400);
  const result = await cloneCall(relay, "/clone-avatars", "POST", { prompt: text }, 120_000);
  const { candidates } = cloneAvatarsSchema.parse(result.body);
  const previews = await Promise.all(candidates.map(async (candidate) => {
    try {
      const bytes = await readRelayBytesUrl(candidate.url, CANDIDATE_MAX_BYTES, { query: true });
      const jpeg = await sharp(bytes, { failOn: "warning" })
        .resize(PREVIEW_SIDE, PREVIEW_SIDE, { fit: "cover" })
        .flatten({ background: "#ffffff" })
        .jpeg({ quality: 80 })
        .toBuffer();
      return { storage_key: candidate.storage_key, preview: `data:image/jpeg;base64,${jpeg.toString("base64")}` };
    } catch {
      return null;
    }
  }));
  const shown = previews.filter((item): item is CloneAvatarCandidate => item !== null);
  if (!shown.length) throw new ExternalRelayError("avatars_unreadable", 502);
  return shown;
}
