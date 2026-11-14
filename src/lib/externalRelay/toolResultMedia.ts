import { z } from "zod";
import { ExternalRelayError } from "./client";
import { prepareInboundMedia, previewImageContent, type InboundFile } from "./mediaInput";
import { hasInboundMedia, isInboundImage, MAX_INPUT_MEDIA_REFS, MAX_INPUT_MEDIA_TOTAL_BYTES, validateMediaInput, type MediaRequest } from "./mediaInputValidation";
import type { PairedRelay } from "./store";
import { canonical, type ToolProjection } from "./toolLoop";

const descriptor = z.object({
  ref: z.string().max(64).optional(), kind: z.string().max(32),
  availability: z.enum(["ready", "too_large", "unsupported_type", "missing", "protected"]),
  mime_type: z.string().max(100).optional(), byte_size: z.number().optional(),
  filename: z.string().max(256).optional(), expires_at: z.string().max(64).optional(),
});
const safeCauses = new Set(["not_found", "protected", "too_large", "unsupported_media_type", "malformed", "media_unavailable", "download_deadline", "unauthorized", "rate_limited"]);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Request-local files, shared admission with inbound originals, and no URL path.
 * Only already authorized read projections enter here; no tool output is stored. */
export function createToolResultMedia(relay: Pick<PairedRelay, "api_base" | "credential">, request: MediaRequest, runDir: string,
  options: Parameters<typeof prepareInboundMedia>[3], inbound?: Pick<Awaited<ReturnType<typeof prepareInboundMedia>>, "files" | "dispose">) {
  const initialFiles = inbound?.files ?? [];
  const lifetime = new AbortController();
  options = { ...options, signal: AbortSignal.any([options.signal, lifetime.signal]) };
  const initial = validateMediaInput(request);
  const identityOf = (media: unknown) => {
    const parsed = descriptor.safeParse(media);
    return canonical(parsed.success ? parsed.data : media);
  };
  const seen = new Map(initial.map(media => [media.ref, identityOf(media)]));
  const outcomes = new Map(initial.map(media => [media.ref, "Image supplied as inbound media."]));
  let count = initial.length, bytes = initial.reduce((sum, media) => sum + (media.byte_size ?? 0), 0);
  const files: InboundFile[] = [];
  const expiry = new Map(initial.map(media => [media.ref, Date.parse(media.expires_at ?? "")]));
  const now = options.now ?? Date.now;
  const frameRefs = new Set<string>();
  const seedRefs = new Set(initialFiles.filter(file => isInboundImage(file.mime_type)).map(file => file.ref));
  const hasSeed = seedRefs.has.bind(seedRefs);
  seedRefs.has = ref => !disposed && !options.signal.aborted && hasSeed(ref) && now() < options.deadlineAt && (expiry.get(ref) ?? 0) > now();
  const availableFiles = new Map(initialFiles.map(file => [file.ref, file]));
  const resultRefs = new WeakMap<ToolProjection, string[]>();
  const previews = new Map<string, ReturnType<typeof previewImageContent>>();
  let disposed = false;
  let disposing: Promise<void> | undefined;
  const owned: { dispose: () => Promise<void> }[] = inbound ? [inbound] : [];
  const processed = new WeakSet<ToolProjection>();
  const check = () => { options.signal.throwIfAborted(); options.authorize(); if (disposed) throw new ExternalRelayError("media_unavailable", 422); if (now() >= options.deadlineAt) throw new ExternalRelayError("lease_lost", 409); };
  return {
    files, seedRefs: seedRefs as ReadonlySet<string>,
    seedRefusal(ref: string) { return frameRefs.has(ref) ? "video_frame_seed_unsupported" : "media_ref_unavailable_or_expired"; },
    attachment(ref: string) {
      check();
      if ((expiry.get(ref) ?? Infinity) <= now()) throw new ExternalRelayError("media_ref_expired", 422);
      const file = availableFiles.get(ref);
      if (!file?.snapshot) throw new ExternalRelayError("media_ref_unavailable", 422);
      return file;
    },
    async collect(results: readonly ToolProjection[]) {
      for (const result of results) {
        if (processed.has(result)) continue;
        processed.add(result);
        if (result.effect === "action" || result.status !== "ok" || !result.output) continue;
        check();
        let output: unknown;
        try { output = JSON.parse(result.output); } catch { continue; }
        if (!object(output)) continue;
        const candidates: unknown[] = Array.isArray(output.media) ? [...output.media] : [];
        if (Array.isArray(output.selected_frames)) for (const frame of output.selected_frames)
          {
          const file = object(frame) ? frame.file : undefined;
          if (object(file) && typeof file.ref === "string") frameRefs.add(file.ref);
          candidates.push(file);
        }
        if (!candidates.length) {
          if (result.tool === "get_profile_photo") result.media_notes = ["Image unavailable: no request-local media ref was returned."];
          continue;
        }
        const notes: string[] = [];
        const refs: string[] = []; resultRefs.set(result, refs);
        // Bound both work and notes even for an untrusted, oversized descriptor list.
        for (const candidate of candidates.slice(0, MAX_INPUT_MEDIA_REFS)) {
          check();
          const parsed = descriptor.safeParse(candidate);
          if (!parsed.success) { notes.push("Image unavailable: malformed media descriptor."); continue; }
          const media = parsed.data;
          if (media.availability !== "ready") { notes.push(`Image unavailable: ${media.availability}.`); continue; }
          if (media.kind !== "photo") { notes.push("Image unavailable: unsupported_media_type."); continue; }
          if (!media.ref) { notes.push("Image unavailable: missing media ref."); continue; }
          if (!hasInboundMedia(request)) { notes.push("Image unavailable: relay_media_in was not negotiated."); continue; }
          if (!isInboundImage(media.mime_type)) { notes.push("Image unavailable: unsupported_media_type."); continue; }
          try {
            // Use the same metadata validator and streaming downloader. The synthetic
            // message only scopes descriptors; request, lease and credential are unchanged.
            const projection: MediaRequest = { request_id: request.request_id, lease_id: request.lease_id, features: request.features,
              input: { respond_to: "tool_result", conversation: [{ id: "tool_result", reply_to: null, media: [{ ...media, kind: "photo", ref: media.ref }] }], documents: [] } };
            validateMediaInput(projection);
            const identity = identityOf(media);
            if (Date.parse(media.expires_at!) <= now()) throw new ExternalRelayError("media_unavailable", 422);
            if (seen.has(media.ref)) {
              if (seen.get(media.ref) !== identity) throw new ExternalRelayError("malformed", 400);
              if (availableFiles.has(media.ref)) refs.push(media.ref);
              notes.push(outcomes.get(media.ref)!);
              continue;
            }
            if (count >= MAX_INPUT_MEDIA_REFS || bytes + media.byte_size! > MAX_INPUT_MEDIA_TOTAL_BYTES)
              throw new ExternalRelayError("too_large", 413);
            // Charge attempts too: failed downloads cannot reset the request budget.
            seen.set(media.ref, identity); expiry.set(media.ref, Date.parse(media.expires_at!)); count++; bytes += media.byte_size!;
            const prepared = await prepareInboundMedia(relay, projection, runDir, options);
            if (disposed) { await prepared.dispose(); check(); }
            owned.push(prepared);
            check();
            files.push(...prepared.files);
            for (const file of prepared.files) {
              if (!frameRefs.has(file.ref)) seedRefs.add(file.ref); availableFiles.set(file.ref, file); refs.push(file.ref);
              const note = "Image attached.";
              outcomes.set(file.ref, note); notes.push(note);
            }
          } catch (error) {
            check();
            if (error instanceof ExternalRelayError && error.code === "lease_lost") throw error;
            const note = `Image unavailable: ${error instanceof ExternalRelayError && safeCauses.has(error.code) ? error.code : "download_failed"}.`;
            if (seen.get(media.ref) === identityOf(media) && !outcomes.has(media.ref)) outcomes.set(media.ref, note);
            notes.push(note);
          }
        }
        if (candidates.length > MAX_INPUT_MEDIA_REFS) notes.push("Additional images unavailable: too_large.");
        result.media_notes = notes;
      }
    },
    async images(results: readonly ToolProjection[]) {
      const images: Awaited<ReturnType<typeof previewImageContent>>[] = [];
      const included = new Map<string, number>();
      const projections: ToolProjection[] = results.map(result => ({ ...result, media_images: [] }));
      for (const [position, original] of results.entries()) for (const ref of resultRefs.get(original) ?? []) {
        const result = projections[position]!;
        check();
        if ((expiry.get(ref) ?? 0) <= now()) { result.media_notes = ["Image unavailable: media_unavailable."]; continue; }
        const prior = included.get(ref);
        if (prior !== undefined) { result.media_images!.push({ ref, image_index: prior }); continue; }
        if (images.length >= MAX_INPUT_MEDIA_REFS) continue;
        try {
          let preview = previews.get(ref);
          if (!preview) { preview = previewImageContent(availableFiles.get(ref)!, options.signal, check); previews.set(ref, preview); }
          const image = await preview;
          check();
          if ((expiry.get(ref) ?? 0) > now()) {
            const index = images.length; images.push(image); included.set(ref, index);
            result.media_images!.push({ ref, image_index: index });
          }
          else result.media_notes = ["Image unavailable: media_unavailable."];
        }
        catch { check(); result.media_notes = [...(result.media_notes ?? []).slice(0, 10), "Image unavailable: preview_failed."]; }
        check();
      }
      return { content: images, projections };
    },
    assertImages(projections: readonly ToolProjection[]) {
      check();
      for (const result of projections) for (const image of result.media_images ?? [])
        if ((expiry.get(image.ref) ?? 0) <= now()) throw new ExternalRelayError("media_unavailable", 422);
    },
    dispose() {
      return disposing ??= (async () => {
      disposed = true; lifetime.abort();
      previews.clear(); seedRefs.clear(); frameRefs.clear(); availableFiles.clear(); seen.clear(); outcomes.clear(); expiry.clear(); files.length = 0;
      for (const prepared of owned.splice(0)) await prepared.dispose();
      })();
    },
  };
}
