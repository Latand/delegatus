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
| Claude text block | no separate cap | 1 MiB serialized JSON | Counts UTF-8 and JSON escaping, including the text block wrapper. |
| Claude native input frame | no separate cap | 16 MiB serialized JSON | Ten 1 MiB images occupy about 13.34 MiB in base64; text and framing keep this turn below 15 MiB. The frame guard reserves space for CLI-added context within the engine request limit. |
| Codex native input | local original paths | unchanged, up to ten paths / 100 MiB originals | No inline image copy is added by the relay. Even base64 expansion of all originals is under 134 MiB. |
| Extracted document text | 16000 scalars each / 32000 total | unchanged | Album support adds images without expanding text context. |
| Outbound answer attachments | 4 / 64 MiB | unchanged | The outbound protocol is independent of inbound message media. |
| Image-generation seed selection | 4 refs | unchanged | This separate tool argument follows the service's advertised seed schema. |

Downloads stream to private files, and JSONL encoding streams to a private
file. The client never holds an album of original byte buffers in memory.
Claude previews decode sequentially, retain at most one encoded preview at a
time, and use the existing pixel ceiling. Original paths remain available to
tools and Codex; preview conversion does not replace source files. Disk use
for originals is bounded by 100 MiB and the Claude spool by 16 MiB. Cancellation
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
covers count/byte refusal, the exact 100 MiB boundary and fresh-process reset.

External limits checked on 2026-10-29:

- [Telegram Bot API](https://core.telegram.org/bots/api#sendphoto): 10 MB per uploaded photo; [albums](https://core.telegram.org/bots/api#sendmediagroup) contain 2–10 items.
- [Claude vision](https://platform.claude.com/docs/en/build-with-claude/vision): 32 MB standard request body; 10 MB base64 per image directly, 5 MB on Bedrock; at least 100 images per API request. The relay's new turn stays below those byte and count limits, leaving room for the CLI envelope and prior context. The CLI still owns context management; this budget cannot guarantee arbitrary accumulated history will fit.
- [OpenAI vision](https://developers.openai.com/api/docs/guides/images-vision): 512 MB payload and 1500 images per request. Ten originals, even base64-encoded, fit those transport limits; model context limits still apply.
