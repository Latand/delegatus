import { ExternalRelayError } from "./errors";

export type InputMedia = { ref: string; kind: "photo" | "document"; availability: "ready" | "too_large" | "unsupported_type" | "missing" | "protected";
  mime_type?: string; filename?: string; byte_size?: number; expires_at?: string };
export type MediaRequest = { request_id: string; lease_id: string; features?: string[]; input: {
  respond_to: string | null; conversation: { id: string; reply_to: string | null; media?: InputMedia[] }[];
  documents: { text: string; message_id?: string; media_ref?: string; extraction?: "complete" | "truncated" | "unavailable" }[] } };
const MiB = 1024 * 1024;
export const inputMediaExtensions: Record<string, string> = { "image/jpeg": ".jpg", "image/png": ".png", "application/pdf": ".pdf", "text/plain": ".txt", "text/markdown": ".md", "text/csv": ".csv", "application/json": ".json" };
const fail = (code: string, status: number): never => { throw new ExternalRelayError(code, status); };
const validId = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id);
export const hasInboundMedia = (request: Pick<MediaRequest, "features">) => request.features?.includes("relay_media_in") === true;
/** Validate the final claimed projection, never an earlier history/tool map. */
export function validateMediaInput(request: MediaRequest): InputMedia[] {
  if (!hasInboundMedia(request)) return [];
  if (!request.features?.includes("requester_context")) fail("malformed", 400);
  const trigger = request.input.conversation.find(message => message.id === request.input.respond_to);
  const allowed = new Set([trigger?.id, trigger?.reply_to].filter((id): id is string => !!id));
  const refs = new Map<string, InputMedia>(); let count = 0, bytes = 0;
  for (const message of request.input.conversation) for (const media of message.media ?? []) {
    if (++count > 4) fail("too_large", 413);
    if (!allowed.has(message.id) || !validId(media.ref) || !["photo", "document"].includes(media.kind)
      || !["ready", "too_large", "unsupported_type", "missing", "protected"].includes(media.availability)
      || media.filename !== undefined && (!media.filename || Array.from(media.filename).length > 128 || /[\\/\p{Cc}]/u.test(media.filename) || [".", ".."].includes(media.filename))) fail("malformed", 400);
    if (media.byte_size !== undefined && (!Number.isSafeInteger(media.byte_size) || media.byte_size < 1)) fail("malformed", 400);
    if ((media.byte_size ?? 0) > 20 * MiB) fail("too_large", 413);
    if (media.availability === "ready") {
      if (!media.byte_size || !media.mime_type || !media.expires_at || !Number.isFinite(Date.parse(media.expires_at))) return fail("malformed", 400);
      if (!(Object.hasOwn(inputMediaExtensions, media.mime_type)) || media.kind === "photo" && !media.mime_type.startsWith("image/")) fail("unsupported_media_type", 415);
    }
    const previous = refs.get(media.ref);
    if (previous && JSON.stringify(previous) !== JSON.stringify(media)) fail("malformed", 400);
    if (!previous) { refs.set(media.ref, media); bytes += media.byte_size ?? 0; }
  }
  if (bytes > 40 * MiB) fail("too_large", 413);
  let extracted = 0;
  for (const doc of request.input.documents) {
    if (!doc.message_id || !allowed.has(doc.message_id) || !doc.media_ref || !refs.has(doc.media_ref)
      || !request.input.conversation.some(message => message.id === doc.message_id && message.media?.some(media => media.ref === doc.media_ref && media.kind === "document"))
      || !["complete", "truncated", "unavailable"].includes(doc.extraction ?? "") || Array.from(doc.text).length > 16000
      || doc.extraction === "unavailable" && doc.text !== "") fail("malformed", 400);
    extracted += Array.from(doc.text).length;
  }
  if (extracted > 32000) fail("too_large", 413);
  const ordered: InputMedia[] = [], seen = new Set<string>();
  for (const message of [trigger, request.input.conversation.find(message => message.id === trigger?.reply_to)])
    for (const media of message?.media ?? []) if (!seen.has(media.ref)) { seen.add(media.ref); ordered.push(refs.get(media.ref)!); }
  return ordered;
}

/** Seed adaptation grants only the ready image refs already in this claim.
 * The service still enforces roles and resolves private source identities. */
export function admittedSeedMedia(request: MediaRequest, args: Record<string, unknown>): boolean {
  if (!Object.hasOwn(args, "seed_media_refs")) return true;
  const refs = args.seed_media_refs;
  if (!hasInboundMedia(request) || !request.features?.includes("requester_context") || !Array.isArray(refs) || refs.length < 1 || refs.length > 4 || new Set(refs).size !== refs.length) return false;
  const media = validateMediaInput(request);
  return refs.every(ref => validId(ref) && media.some(item => item.ref === ref && item.availability === "ready" && item.mime_type?.startsWith("image/")));
}
