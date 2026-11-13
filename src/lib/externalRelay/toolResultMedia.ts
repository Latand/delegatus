import { z } from "zod";
import { ExternalRelayError } from "./client";
import { prepareInboundMedia, type InboundFile } from "./mediaInput";
import { hasInboundMedia, isInboundImage, MAX_INPUT_MEDIA_REFS, MAX_INPUT_MEDIA_TOTAL_BYTES, validateMediaInput, type MediaRequest } from "./mediaInputValidation";
import type { PairedRelay } from "./store";
import { canonical, type ToolProjection } from "./toolLoop";

const descriptor = z.object({
  ref: z.string().max(64).optional(), kind: z.literal("photo"),
  availability: z.enum(["ready", "too_large", "unsupported_type", "missing", "protected"]),
  mime_type: z.string().max(100).optional(), byte_size: z.number().optional(),
  filename: z.string().max(256).optional(), expires_at: z.string().max(64).optional(),
});
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Request-local files, shared admission with inbound originals, and no URL path.
 * Only already authorized read projections enter here; no tool output is stored. */
export function createToolResultMedia(relay: Pick<PairedRelay, "api_base" | "credential">, request: MediaRequest, runDir: string,
  options: Parameters<typeof prepareInboundMedia>[3]) {
  const initial = validateMediaInput(request);
  const identityOf = (media: unknown) => {
    const parsed = descriptor.safeParse(media);
    return canonical(parsed.success ? parsed.data : media);
  };
  const seen = new Map(initial.map(media => [media.ref, identityOf(media)]));
  const outcomes = new Map(initial.map(media => [media.ref, `Image ${media.ref}: supplied as inbound media.`]));
  let count = initial.length, bytes = initial.reduce((sum, media) => sum + (media.byte_size ?? 0), 0);
  const files: InboundFile[] = [];
  const owned: Awaited<ReturnType<typeof prepareInboundMedia>>[] = [];
  const processed = new WeakSet<ToolProjection>();
  const check = () => { options.signal.throwIfAborted(); options.authorize(); };
  return {
    files,
    async collect(results: readonly ToolProjection[]) {
      for (const result of results) {
        check();
        if (processed.has(result)) continue;
        processed.add(result);
        if (result.effect === "action" || result.status !== "ok" || !result.output) continue;
        let output: unknown;
        try { output = JSON.parse(result.output); } catch { continue; }
        if (!object(output)) continue;
        const candidates: unknown[] = Array.isArray(output.media) ? [...output.media] : [];
        if (Array.isArray(output.selected_frames)) for (const frame of output.selected_frames)
          candidates.push(object(frame) ? frame.file : undefined);
        if (!candidates.length) {
          if (result.tool === "get_profile_photo") result.media_notes = ["Image unavailable: no request-local media ref was returned."];
          continue;
        }
        const notes: string[] = [];
        // Bound both work and notes even for an untrusted, oversized descriptor list.
        for (const candidate of candidates.slice(0, MAX_INPUT_MEDIA_REFS)) {
          check();
          const parsed = descriptor.safeParse(candidate);
          if (!parsed.success) { notes.push("Image unavailable: malformed media descriptor."); continue; }
          const media = parsed.data;
          if (media.availability !== "ready") { notes.push(`Image unavailable: ${media.availability}.`); continue; }
          if (!media.ref) { notes.push("Image unavailable: missing media ref."); continue; }
          if (!hasInboundMedia(request)) { notes.push("Image unavailable: relay_media_in was not negotiated."); continue; }
          if (!isInboundImage(media.mime_type)) { notes.push("Image unavailable: unsupported_media_type."); continue; }
          try {
            // Use the same metadata validator and streaming downloader. The synthetic
            // message only scopes descriptors; request, lease and credential are unchanged.
            const projection: MediaRequest = { request_id: request.request_id, lease_id: request.lease_id, features: request.features,
              input: { respond_to: "tool_result", conversation: [{ id: "tool_result", reply_to: null, media: [{ ...media, ref: media.ref }] }], documents: [] } };
            validateMediaInput(projection);
            const identity = identityOf(media);
            if (seen.has(media.ref)) {
              if (seen.get(media.ref) !== identity) throw new ExternalRelayError("malformed", 400);
              notes.push(outcomes.get(media.ref)!);
              continue;
            }
            if (count >= MAX_INPUT_MEDIA_REFS || bytes + media.byte_size! > MAX_INPUT_MEDIA_TOTAL_BYTES)
              throw new ExternalRelayError("too_large", 413);
            // Charge attempts too: failed downloads cannot reset the request budget.
            seen.set(media.ref, identity); count++; bytes += media.byte_size!;
            const prepared = await prepareInboundMedia(relay, projection, runDir, options);
            owned.push(prepared);
            check();
            files.push(...prepared.files);
            for (const file of prepared.files) {
              const note = `Image ${file.ref} attached: ${file.path}`;
              outcomes.set(file.ref, note); notes.push(note);
            }
          } catch (error) {
            check();
            if (error instanceof ExternalRelayError && error.code === "lease_lost") throw error;
            const note = `Image ${media.ref} unavailable: ${error instanceof ExternalRelayError ? error.code : "download_failed"}.`;
            if (seen.get(media.ref) === identityOf(media) && !outcomes.has(media.ref)) outcomes.set(media.ref, note);
            notes.push(note);
          }
        }
        if (candidates.length > MAX_INPUT_MEDIA_REFS) notes.push("Additional images unavailable: too_large.");
        result.media_notes = notes;
      }
    },
    async dispose() { for (const prepared of owned) await prepared.dispose(); },
  };
}
