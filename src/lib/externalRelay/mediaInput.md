# Inbound album budgets

The client accepts ten media descriptors on a message, and ten descriptors
across the trigger and its direct reply parent combined. Repeated descriptors
still count toward the request count; distinct refs count toward the byte
budget. An eleventh descriptor retains `too_large` (413) at media validation.
The negotiated message schema also refuses it. History scope, MIME checks,
lease authorization, expiration and cleanup retain their existing rules.

| Budget | Before | After | Reason |
|---|---|---|---|
| Message descriptors | 4 | 10 | A complete photo album fits one message. |
| Request descriptors/downloads | 4 | 10 | The whole album fits the request; downloads remain sequential and distinct refs download once. |
| Original bytes per file | 20 MiB | 20 MiB | Keeps existing document support and covers a Telegram photo. |
| Distinct original bytes per request | 40 MiB | 100 MiB | Covers ten photos of 10 MiB each, with margin over Telegram's decimal 10 MB photo limit. Metadata, response lengths and streamed bytes enforce the same constants. |
| Download deadline | min(30 seconds, remaining lease, ref lifetime) | unchanged | Ten transfers share the existing request deadline; there is no extra request lifetime. |
| Image decode | 20 million pixels, 3 seconds per decode | unchanged | Originals are validated one at a time. Claude preview decoding uses the same limits. |
| Claude image bytes | original, up to 20 MiB | at most 1 MiB per image | Small images at most 1568 pixels on either side stay byte-identical; larger images become JPEG previews at 1568 pixels, quality 80, falling back to 768 pixels, quality 70 when needed. |
| Claude text block | no separate cap | shares the frame's remaining bytes | The full frame counts UTF-8, JSON escaping, wrappers and actual preview bytes together. Valid claim context can exceed 1 MiB after a second JSON encoding. |
| Claude native input frame | no separate cap | 32 MiB serialized JSON | A 1 MiB claim can expand sevenfold when the prompt escapes `<` and the JSONL frame escapes those backslashes. Ten 1 MiB previews add about 13.34 MiB of base64; 32 MiB covers both with room for framing. The frame guard retains headroom for CLI-added context within the engine request limit. |
| Codex native input | local original paths | unchanged, up to ten paths / 100 MiB originals | No inline image copy is added by the relay. Even base64 expansion of all originals is under 134 MiB. |
| Extracted document text | 16000 scalars each / 32000 total | unchanged | Album support adds images without expanding text context. |
| Outbound answer attachments | 4 / 64 MiB | unchanged | The outbound protocol is independent of inbound message media. |
| Image-generation seed selection | 4 refs | 10 refs | Both image tools accept ready inbound images and successfully downloaded read-tool images from this request, following the service's advertised seed schema. |

Downloads stream to private files, and JSONL encoding streams to a private
file. The client never holds an album of original byte buffers in memory.
Claude previews decode sequentially, retain at most one encoded preview at a
time, and use the existing pixel ceiling. Original paths remain available to
tools and Codex; preview conversion does not replace source files. Disk use
for originals is bounded by 100 MiB and the Claude spool by 32 MiB. Cancellation
or lost authorization removes the incomplete spool; run cleanup removes all
originals and the spool. No latency or throughput improvement is claimed.

The producer/consumer chain is claim parsing (`protocol.ts`) → final projection
validation (`mediaInputValidation.ts`) → streamed download (`mediaInput.ts`)
→ `runner.ts`. Restricted Codex passes original paths to `runEphemeralAgent`;
restricted Claude passes the bounded stream-JSON file. Owner runs receive
original paths in their existing inbound context for tool reads. Claim polling
and tool loops share the same validation module. Capabilities absent from a
claim still strip additive media, and compact/legacy requests stay unchanged.
Existing immutable service fixtures describe their pinned protocol revisions;
the album regression extends the real `richRequest`/`requestSchema` builders
in `runner.test.ts`, exercises both native inputs, checks all ten downloads
and observes an answered completion and original cleanup. `mediaInput.test.ts`
covers count/byte refusal, valid escaped real-builder context with one or ten
photos, a near-limit claim containing `<` with ten substantial JPEGs, the exact
100 MiB download boundary and fresh-process reset. The native
writer accepts exactly 32 MiB, refuses one extra byte and removes the partial
spool in two fresh processes.

External limits checked on 2026-10-31:

- [Telegram Bot API](https://core.telegram.org/bots/api#sendphoto): 10 MB per uploaded photo; [albums](https://core.telegram.org/bots/api#sendmediagroup) contain 2–10 items.
- [Claude API request limits](https://platform.claude.com/docs/en/api/overview#request-size-limits): 128 MB for Messages. [Claude vision](https://platform.claude.com/docs/en/build-with-claude/vision): 10 MB base64 per image directly, 5 MB on Bedrock; at least 100 images per API request. The relay's new turn stays below those byte and count limits, leaving room for the CLI envelope and prior context. The CLI still owns context management; this budget cannot guarantee arbitrary accumulated history will fit.
- [OpenAI vision](https://developers.openai.com/api/docs/guides/images-vision): 512 MB payload and 1500 images per request. Ten originals, even base64-encoded, fit those transport limits; model context limits still apply.


Owner service-tool answers use the same request collector, downloader, validator
and preview encoder as the hosted loop. MCP returns image blocks beside metadata,
without structured content when images are present. Each result maps refs to the
zero-based image block index in media_images. Each answer allows ten images
and at most 14 MiB serialized, each preview at most 1 MiB. Its request-local cache
holds at most ten encoded previews (10 MiB before base64, about 13.34 MiB
after encoding) and is cleared on disposal. Initial and returned
originals share ten distinct attempts and 100 MiB reserved bytes, including failed
downloads. Downloads end after the earliest of 30 seconds, lease deadline and ref
expiry. Invalid, unavailable and unsupported media retain bounded cause text.
Small JPEG/PNG originals remain byte-identical; the pixel/decoder limits above
apply to every image. The collector is request-local and clears files and caches
on completion, cancellation or revocation. Recovery owns its scratch through the
existing run ledger. Originals use private directories and files (0700/0600).

The service seat's contract statement, received 2026-11-14, confirms that photo
and current-participant avatar refs are valid seeds on the two mirrored image
tools, including edit_canvas. Downloadable video-frame refs are viewable but
cannot be image seeds. It also confirms re-uploading downloaded originals through
the existing attachment PUT and answer attachment_id contract. These photo/frame
and re-upload facts rely on that statement where the older fixtures have no copy;
no production calls were made. The avatar seed fixture mirrors the advertised
1–10 unique refs and both negotiation features. The client keeps its stricter
100 MiB request budget. No additional wire field or unresolved client contract
question remains. Native service-agent support belongs to the paired service;
production photo acceptance belongs to the release owner after merge/deploy.

relay_answer accepts exactly one path or media_ref per attachment. A ref resolves
only to an unexpired original successfully downloaded in this request, with
identity, size and digest rechecked in the existing attachment worker. It grants
no scratch directory access. The same four-item, 64 MiB answer, 20 MiB file and
8 MiB photo limits, upload validation, replacement and late-answer custody apply.
Previews never replace attachment originals. In code mode, emit MCP image blocks
with image(block), preserving the text metadata separately.

Native relay calls protect their server-resolved transcript and its directory
before returning media (0600/0700), allowing at most three seconds for its first
file to appear and rejecting missing, linked or changed context.
Native engine context is the persistence exception: images may stay in Claude
session artifacts or Codex rollouts for continuation. Deleting context removes
its owned artifacts. Journal projections, answer history, catalog titles and
search text exclude pixels and media refs; they leave native context intact.
