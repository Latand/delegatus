# Relay v2, install side: rich answers, URL buttons and media out

## Amendment: mentions, photo references and media input (2026-10-19)

The service contract `docs/design/relay-protocol-v2.md` at `efeac13c`
supersedes the older exclusions and separate-photo rules below. This slice
adds no flags for mentions or carousel composition. Reply-chain negotiation
and compaction remain outside this amendment.

- `protocol.ts`, `mediaInputValidation.ts`, `poller.ts`, and the rich fixture preserve the new guide,
  mention annotations, message media, and document extraction metadata.
  Advertise `relay_media_in` only when offered, with `requester_context`.
  Validate four refs, 20 MiB per file, 40 MiB distinct bytes, ready metadata,
  trigger/direct-parent membership, 16,000 scalars per document and 32,000
  total. Seed refs stay opaque and pass through the existing service-tool
  schema; the service resolves their private image identities.
- `answerV2.ts`, `ownerAnswer.ts`, `ownerRun.ts`, and `runner.ts` preserve
  original source offsets. Mentions require rich format, at most 16 sorted,
  non-overlapping, nonblank spans of 1–128 scalars in one ordinary text leaf.
  Admit only final-request author/requester keys; exclude self, anonymous and
  explicitly tagged non-person identities and numeric keys. The service's
  private admitted-person map remains the final authority for bot/channel
  identities that the public wire cannot distinguish. Invalid annotations
  raise 400 `malformed`; never repair offsets or silently drop annotations.
  The owner tool maps malformed mention fields to the same error. Owner
  transcript reads opt into source-preserving extraction through
  `scanner/lastAssistantMessage.ts` and `spawnNotice/production.ts`, including
  continuation reads; ordinary notice/review readers keep their defaults.
  Reverse continuation scans join byte fragments before UTF-8 decoding, so
  a read boundary cannot change a Unicode scalar or its mention offset.
- Explicit photo refs require rich format and media output. Accept only
  standalone `![](attachment:id)` blocks, one contiguous run containing all
  selected photos once, in attachment order. Syntax, ordering, duplicate,
  foreign and non-photo refs raise 422 `invalid_format`; missing selected
  uploads raise 422 `attachment_not_ready`. Absent refs leave composition to
  the service: one photo block or a two-to-four-photo carousel, then separate
  non-photo sends. Validate against stable staged IDs after upload; preserve
  annotations on completion, and remove them together with rich syntax on an
  explicit plain fallback.
- `client.ts` gains an authenticated streaming download using the existing
  DNS pinning and redirect refusal. Only
  `/requests/{request_id}/media/{media_ref}` is constructed, with bearer,
  version and lease headers. No supplied URL or filename becomes a path.
  `mediaInput.ts` writes exclusive, generated files below private run scratch,
  using pipeline backpressure and counters before each write. Enforce exact
  content length, negotiated MIME, per-file and aggregate byte limits while
  streaming; cancellation, interruption and authorization loss discard partial
  files. Transfers run under the lesser of 30 seconds and the request deadline,
  with a labelled Viewer span and fresh authority checks after awaits.
  Original bytes remain untrusted; document extraction is supplied by the
  service and validated locally, with no local execution or extraction call.
- The runner downloads only admitted ready refs after lease acknowledgement,
  exposes paths as untrusted context to both answer profiles, attaches images
  through native Codex image flags or a streamed Claude user frame, and removes them
  with the owned run directory. The shared headless launcher streams the prepared Claude frame with backpressure
  under `agent.stdin-file`; `ephemeral.ts` carries only private input references.
  Existing conversation state and logs retain
  no credential, download URL or original bytes. HTTP service refusals retain
  their exact status/code; local cap/type/availability failures use 413
  `too_large`, 415 `unsupported_media_type`, 422 `media_unavailable` and 409
  `lease_lost`. Malformed metadata uses 400 `malformed`.

Shared path audit: descriptor → stored features → claim → request parser →
tool-index hydration → ordinary/owner prompts → tool rounds/owner answer
registry → staging/upload → completion/retry → answer history. Document and
media fields also reach conversation prompt digests/cursors, so downloads are
passed as ephemeral prompt context rather than persisted input mutations.
The shared tool loop checks seed-ref membership and readiness before dispatch;
the service retains role checks and private image adaptation.
No file-ID or destination authority is added. No performance gain is claimed.

Design only. Base: `49648aba0d4f6f9c4c1c3f45f78d1cf3844d6c18` on main,
read 2026-10-17. Every `file:line` below is at that commit unless it names a
lane branch. Contract: the relay service's `docs/design/relay-protocol-v2.md`
at its main `71edd6cb` (merged 2026-10-17, review passed), read with
`git show` from a local object and never fetched, checked out or run. This
document cites the service only through that contract's wire shapes. Where
this document and the contract differ, the contract wins.

## Originating requirement

Two operator messages to the Delegatus seat, 2026-10-17, given here as a
publication-safe paraphrase. The task fences their wording off from published
files, so it is not copied, translated or excerpted.

- About 09:15 UTC, seat chat. A relay answer run on Codex should be allowed
  to generate pictures with Codex's own built-in image generation; the
  service's hosted generator is not the one to use for this. A relay answer
  should be able to send a picture (Claude cannot generate one). In general
  the relay may want to send any picture, or documents and similar files,
  and that has to be supported.
- About 10:50 UTC, decision form. Media out: yes, build the install's half as
  soon as the service agrees the format. Longer replies and real formatting
  ship together with media. The comment asked for rich Markdown whenever an
  answer is over 4,000 characters or uses tables, long text and similar
  structure, maybe with buttons. The service must know how and when to use
  rich Markdown, so the install passes it the formatting instructions, and
  the answer is converted and sent as a rich message, whose limit is above
  4,000 characters.

Outcome the brief pins for this install, in its own five parts:

1. Negotiate `relay_rich_messages` and `relay_media_out` exactly as the
   contract says, and persist what was negotiated. Without them, behaviour
   stays byte-identical to today.
2. The relay agent receives `input.format` as its formatting guide and
   answers in `rich_markdown` when it fits. The answer is validated locally
   against the contract limits before it is sent.
3. An agent of any engine can attach files it produced or selected. They go
   up through the lease-bound PUT, are referenced in `answer.attachments`,
   and are checked with the existing document-sending rules (allowed roots,
   size, type).
4. Codex relay runs may use Codex's native image generation when media out is
   negotiated, and the generated image becomes an attachment. Claude cannot
   generate, but can attach.
5. Owner runs (`ownerRun.ts`) also return rich text, buttons and attachments.

## 1. Answer in short

- **Negotiation.** The claim adds `relay_rich_messages`, and with it
  `relay_media_out`, only when the stored descriptor lists them and the local
  switch `relay:rich_media` is not off. A claimed request is v2 only when its
  own `request.features` names the feature. Without `request.features` every
  prompt, schema, CLI argument and completion byte stays as today, and the
  existing hash fixtures prove it.
- **Formatting guide.** `input.format` reaches the model verbatim as a trusted
  `<format>` section next to `<service_instructions>`. The answer schema gains
  `format` and `buttons`, and gains `attachments` only for Codex runs with
  media out.
- **Local validation.** A new `answerV2.ts` checks every limit the contract
  names before the completion is sent. Plain answers stay at 4,000 code
  points even when `request.answer.max_chars` says 32,000. Rich answers are
  checked for 32,000 code points, 128,000 UTF-8 bytes, raw HTML, inline media,
  non-https and `tg:` links, blocks, depth and table columns. Buttons and
  captions are checked too. A part that fails its check takes one
  deterministic step down: rich becomes plain if it fits, a bad button or
  attachment is dropped, and the answer record says which. A 4xx refusal of a
  v2 field gets one resend as plain text.
- **Attachments.** A restricted run can attach only images its own Codex run
  generated. An owner run can attach any file under the operator's document
  roots, checked by the same `readUnderRoots`, signature and secret rules as
  `telegram_bot_send_document`. Bytes are copied once into the run directory,
  hashed, then uploaded with
  `PUT /requests/{request_id}/attachments/{attachment_id}`. The upload
  carries the lease header and SHA-256, under a content-derived id, so a
  retry is the same PUT. Uploads run inside the request deadline while
  heartbeats continue. A lost lease on a PUT completes nothing, as a lost
  heartbeat does today.
- **Codex image generation**, measured on this machine with Codex CLI 0.162.1
  against a local stub model server (§9). With ChatGPT-mode auth,
  `image_gen__imagegen` is offered inside code mode. It saves PNGs to
  `$CODEX_HOME/generated_images/<thread_id>/<call id>.png`, and the
  `exec --json` stream carries **no item** for it. Its `referenced_image_paths`
  argument read a local image outside the run directory and sent it to the
  provider's `/images/edits` under today's `-s read-only`. A permission profile
  readable only in the run's `cwd` refused that read and still let generation
  work. So an image-enabled run drops `--disable image_generation`, replaces
  `-s read-only` with that profile, and runs in its own `CODEX_HOME` under the
  run directory. The runner takes images from
  `generated_images/<thread_id>/` after the run. The progress parser admits
  the two image-generation item names Codex uses elsewhere, should an exec
  stream ever carry them.
- **Owner runs.** A new Viewer MCP tool, `relay_answer`, lets the owner agent
  set `format`, `buttons` and `attachments` for its final message. It is bound
  in the Viewer through the caller's live owner run, in the same way as lane
  97089d71's `relay_service_tools`. The final message stays the answer text;
  plain text is capped at 4,000 under negotiation, and rich text at 32,000
  when the agent chose it.

## 2. What happens at `49648aba`

| Concern | Today | Where |
|---|---|---|
| Claim features | `requester_context`, `relay_tool_calls`, `relay_tool_actions`, `request_deadline`; `chat_conversations` behind a switch; `relay_owner_tools` only when the switch is on and the stored descriptor lists it | `src/lib/externalRelay/poller.ts:263-270` |
| Descriptor features | re-read before the first claim and every 5 min, stored on the paired relay | `poller.ts:279-326` |
| Request parse | `z.object` strips unknown keys, so `features`, `input.format` and `answer.attachments` would vanish | `src/lib/externalRelay/protocol.ts:125-172` |
| Answer shape | `{action, text, reply_to}`; reply text capped at `request.answer.max_chars`; an unknown `reply_to` becomes `null` | `protocol.ts:238-305` |
| Answer prompt | data sections, then the frame `[Answer with one JSON object … Use at most N characters.]` | `src/lib/externalRelay/prompt.ts:7-41` |
| Frame reuse | conversation turns cut the frame at `lastIndexOf("[Answer with one JSON object")` | `src/lib/externalRelay/runner.ts:648` |
| Completion retry | identical body; 413 on an answer becomes `failed/invalid_answer`; 400/401/404/409/413/426 are terminal; anything else retries to the deadline | `runner.ts:137-186` |
| Decision recorded before delivery | `recorder.finish` then `completeRelayRequest` | `runner.ts:285-302` |
| Run directory | `mkdtemp` under the relay temp root, removed in `finally` and by the orphan sweep | `runner.ts:514-516`, `:804-809`; `poller.ts:146-150` |
| Codex answer profile | `--disable image_generation` among the disabled features, `-s read-only`, shared answer home `<state>/external-relay/codex-homes/<account>` | `src/lib/agent/ephemeral.ts:212-244`, `:76-98` |
| Codex tripwire | any `item.*` other than `agent_message`, `reasoning`, `error` (+ `web_search`, `context_compaction` by profile) is a violation | `src/lib/externalRelay/progress.ts:18-25` |
| Thread id | parsed from `thread.started` only for session runs | `ephemeral.ts:345-346` |
| Owner answer | the final message, scrubbed, truncated at `max_chars`; prompt says "Write plain text of at most N characters" | `src/lib/externalRelay/ownerRun.ts:44`, `:48-55` |
| Owner tools | the Viewer MCP server only | `ownerRun.ts:365-370` |
| Owner caller check | agent, no deputy, conversation named by a live owner run | `src/lib/mcp/bindings.ts:7437-7440`; `src/lib/externalRelay/ownerAuthority.ts:15-29` |
| File sending rules | operator document roots (default `<home>/handoff`), no dot-directory, no state directory, descriptor re-check, regular file, one link, size bound, signature, text secret scan | `src/lib/telegram/bot/documents.ts:82-84`, `:373-431`, `:437-499`; photo decode `src/lib/telegram/bot/service.ts:124-152` |
| Test service | `startTestRelay` JSON-parses every request body | `src/lib/externalRelay/testRelay.ts:25-26` |
| Request window | 120 s, or the service's `deadline_at` | `src/lib/externalRelay/deadline.ts:5`, `:15-31` |

The brief places the image flag at `ephemeral.ts:220`; at this commit
`--disable` is line 222 and `image_generation` line 223.

## 3. The wire deltas this install implements

Field names and limits are the contract's. Negotiation keeps `/api/relay/v1`,
`Delegatus-Relay-Version: 1` and descriptor `versions: [1]`.

| Surface | Delta | Install obligation |
|---|---|---|
| Claim body `features` | add `relay_rich_messages`; add `relay_media_out` only together with it | §5 |
| `Request.features` | array of feature strings, `uniqueItems`, `maxItems: 32`; sent only when a new capability is effective; the service persists it on the claimed request and later polls cannot change it | read once per request; it alone decides v2 |
| `Request.input.format` | const object: `version: "celestia-rich-v1"`, `formats: {plain: 4000, rich_markdown: 32000}`, `guide`, `markdown_subset` (12 names), `max_blocks: 500`, `max_depth: 16`, `max_table_columns: 20`, `buttons {allowed, placement: "answer.buttons", kind: "url", max_rows: 2, max_per_row: 3, max_total: 6, item_schema}`, `forbidden` (7 names); on every negotiated answer request | trusted guidance to the model (§6); its numbers feed validation, each capped by the contract constant |
| `Request.answer.max_chars` | 32,000 under `relay_rich_messages` | never used as the plain cap under negotiation |
| `Request.answer.attachments` | `{max_items: 4, max_total_bytes: 67108864, kinds: ["photo","document","audio","video"]}` with `relay_media_out` | media out is effective only when present |
| `AnswerV2` | `Answer` plus `format` (`plain` default, `rich_markdown`), `buttons` (≤ 2 rows × 1–3 `{text, url}`, text 1–64, url `^https://`, ≤ 2,048), `attachments` (≤ 4 `{attachment_id, kind, caption}`, caption ≤ 1,024, unique ids); closed (`unevaluatedProperties: false`) | §7 |
| Reply rules | `reply` needs nonblank text or ≥ 1 attachment; `ignore` needs empty text, attachments and buttons; under `AnswerV2` an unknown reply ref is refused | §7 |
| Caption | literal text, ≤ 1,024 UTF-16 units and ≤ 1,024 characters | §7 |
| Upload | `PUT /api/relay/v1/requests/{request_id}/attachments/{attachment_id}`, raw bytes; headers: bearer credential, `Delegatus-Relay-Version`, `Delegatus-Relay-Lease`, `Delegatus-Relay-SHA256` (lowercase hex), `Content-Type`, `Content-Length`, `Content-Disposition` with a UTF-8 basename | §8 |
| Upload answers | 201 first success; 200 with the same receipt for identical bytes, MIME and filename under the same id; 409 `attachment_conflict` for different content; an interrupted PUT leaves no usable ref and may be repeated; an expired lease cannot replay | §8.5 |
| `UploadedAttachment` receipt | `attachment_id`, `mime_type` (≤ 100), `filename` (1–128), `byte_size` (1–20,971,520), `sha256`, `expires_at` | checked against what was sent |
| Policy caps | 4 files and 64 MiB per request; photo ≤ 8 MiB, document/audio/video ≤ 20 MiB; images ≤ 20 million pixels; two simultaneous transfers per lease; transfer deadline min(30 s, remaining lease); uploads are no heartbeat | §8 |
| MIME allowlist | photo `image/jpeg`, `image/png`; audio `audio/mpeg`, `audio/mp4`; video `video/mp4`; document `application/pdf`, `text/plain`, `text/markdown`, `text/csv`, `application/json`, `image/jpeg`, `image/png`; HTML, SVG, archives and executables refused | §8.2 |
| Rich limits | 32,000 source code points, 128,000 UTF-8 bytes, rendered ceiling 32,768 including any service prefix, 500 blocks, depth 16, 20 table columns | §7.2 |
| Errors | envelope `{"error": {"code", "message"}}`; 400 `malformed`, 401 `unauthorized`, 404 `not_found`, 409 `lease_lost` / `attachment_conflict` / `already_completed`, 413 `too_large`, 415 `unsupported_media_type`, 422 `invalid_format` / `attachment_not_ready`, 429 `rate_limited` with `retry_after_s` | §7.4, §8.5 |
| Descriptor | optional `limits.max_rich_answer_chars` (32,000) and `limits.media_out`; legacy `max_answer_chars: 4000` stays | not read: per-request limits are authoritative, and the descriptor parse already drops unknown limit keys (`protocol.ts:56-60`) |
| Native generation | stays on the install; the protocol carries no provider or model; the service never calls its hosted image tool for these files | §9 |

Not in this lane: `chain_conversations`, `reply_chain`, the reply-target
guard, `relay_media_in`, inbound `media` refs, `seed_media_refs`.

## 4. Where each delta lands

| File | Change |
|---|---|
| `src/lib/externalRelay/switches.ts:4-15` | `RelaySwitch` gains `relay:rich_media`; `readRelaySwitches()` returns `rich_media: value["relay:rich_media"] !== false` (on unless explicitly off) |
| `src/lib/externalRelay/poller.ts:263-270` | `relayClaimCapabilities` appends `relay_rich_messages` when `rich_media` and `relay.features` lists it, then `relay_media_out` when it is listed too |
| `src/lib/externalRelay/protocol.ts:125-172` | `requestSchema` gains `features` (strings ≤ 64, ≤ 32, unique), `input.format` (§6.1 shape) and `answer.attachments` (contract const), each `.optional().catch(undefined)`, as `chat` does at `:166`. A malformed value turns its feature off locally and never declines the request |
| `protocol.ts:238-341` | `ExternalRelayAnswer` and the `answered` completion widen to optional `format`, `buttons`, `attachments`; the legacy schemas and `checkedAnswer` stay byte for byte |
| new `src/lib/externalRelay/answerV2.ts` | `answerCapabilities(request, engine)`, the effective limits, `withAnswerParts(schema, caps)`, `checkedAnswerV2`, the Markdown pre-check, button and caption checks (§7) |
| `src/lib/externalRelay/prompt.ts:7-87` | the `<format>` section and the negotiated frame, only when `caps.rich` (§6) |
| `src/lib/externalRelay/runner.ts` | caps from the parsed request after `:205`; schema choice at `:673` through `withAnswerParts`; `imageGeneration` passed to `runEphemeralAgent` at `:665-686`; decision through `checkedAnswerV2` at `:729-731`; attachment staging after the run and upload inside `finish` before `completeRelayRequest` (`:300-302`); v2 status handling in `completeRelayRequest` (`:166-184`); owner registry open before `:655`, closed after `:719`, removed in `finally` |
| new `src/lib/externalRelay/attachments.ts` | the relay kind table, staging from generated images and from document roots, attachment ids, `Content-Disposition`, `uploadAnswerAttachments` (§8) |
| `src/lib/externalRelay/client.ts:82-192` | `relayPutBytes`: same DNS pinning, redirect refusal, response cap and error parsing as `relayCall`, raw body, extra headers, total deadline signal (§8.4) |
| `src/lib/agent/ephemeral.ts:32-48`, `:199-286`, `:345-346` | `imageGeneration?: { readableRoot: string }`; per-run home; profile flags; thread id always parsed when image generation is on; `thread_id` returned on the result (§9) |
| `src/lib/externalRelay/progress.ts:7-25` | `profile.imageGeneration` admits item types `image_generation` and `image_generation_call` (§9.4) |
| `src/lib/externalRelay/ownerRun.ts:24-64` | `<format>` in the owner prompt, the negotiated closing sentence, `ownerAnswer` limits and staged parts (§10) |
| new `src/lib/externalRelay/ownerAnswer.ts` | request-scoped registry on `globalThis`, `relayAnswerOp(conversationId, args)` (§10.2) |
| `src/lib/externalRelay/ownerAuthority.ts:15-29` | export `liveOwnerRelayRequest(conversationId)` over `liveOwnerRelayRun`, shared with lane 97089d71 (§12) |
| `src/lib/mcp/server.ts:119`, `:209-219`, `:3583`, `:4560`; `src/lib/mcp/bindings.ts:7954` | the `relay_answer` name, schema, description, receipt sets and binding (§10.2) |
| `src/lib/telegram/bot/documents.ts`, `service.ts:124-152` | move the photo checks of `photoBlob` into an exported `checkPhotoBytes(bytes)` in `documents.ts` and call it from both; behaviour unchanged |
| `src/lib/externalRelay/answers.ts:31-62` | `features?: string[]` on the record; `answer` widens with `format`, `buttons`, attachment metadata and per-part drop reasons; never a local path |
| `src/lib/externalRelay/testRelay.ts:20-38` | hand the handler the raw `Buffer` and parse JSON only for `application/json` |
| `docs/design/relay.md` | one revision line pointing here; §B.6.1's "No other acting tools" row notes the image profile |

## 5. Negotiation and persistence

**Claim.** `relayClaimCapabilities` (`poller.ts:264-270`) keeps its current
result and appends:

```ts
const rich = switches.rich_media && relay?.features?.includes("relay_rich_messages");
const media = rich && relay?.features?.includes("relay_media_out");
// ...features, ...(rich ? ["relay_rich_messages"] : []), ...(media ? ["relay_media_out"] : [])
```

Gating on the stored descriptor follows `relay_owner_tools`. The contract
keeps unknown claim features inert, but this install already handles
services that refuse unknown features (`client.ts:25-28`, `poller.ts:386-392`),
so it announces only what the service advertises. The descriptor is
re-read every 5 minutes (`poller.ts:337`), so a service switch-on reaches the
claim within one refresh, with no pairing or restart.

**Default on, explicit off.** The service's own rollout switch is the gate;
a local default-off switch would need a manual step before anything works.
`relay:rich_media: false` in `external-relay/switches.json` stops both
announcements at the next poll, for an operator who needs to back out. One
switch covers both features because media out requires rich messages and they
ship together.

**Tests whose fixtures reach the enabled path.** None today: no relay
fixture's stored `features` lists either string (searched
`src/lib/externalRelay/*.test.ts` and `fixtures/`). The poller test that
compares features with `CLAIM_FEATURES` uses a relay without them and stays
true. The switches test that pins `readRelaySwitches()` with `toEqual` gains
the key; it is listed in §14.

**Effective set per request.** `answerCapabilities(request, engine)`:

| Field | Value |
|---|---|
| `rich` | `request.features` includes `relay_rich_messages` and `input.format` parsed |
| `media` | `rich`, `request.features` includes `relay_media_out`, and `answer.attachments` parsed |
| `plainMax` | `rich ? min(4000, format.formats.plain) : request.answer.max_chars` (see the malformed-guide rule below) |
| `richMax` | `min(32000, format.formats.rich_markdown, request.answer.max_chars)` |
| `buttons` | `rich && format.buttons.allowed` with rows/per-row/total capped by 2/3/6 |
| `attach` | `media`, with `max_items ≤ 4`, `max_total_bytes ≤ 64 MiB`, kinds from the request |
| `generate` | `media && engine === "codex"` and not an owner run |

The service persisted its effective set when it leased the request, so a
local switch flipped after the claim changes nothing for that request: the
caps come from the request alone. A request that names `relay_rich_messages`
but carries an `input.format` that fails to parse is run as a legacy request
whose local copy has `answer.max_chars` lowered to 4,000. Its prompt, schema
and check are then today's at the plain cap, and a legacy
`{action, text, reply_to}` body is a valid `AnswerV2`.

**Persisting what was negotiated.** The service holds the authoritative copy
on the leased request. The install records `features` (the request's list,
filtered to known strings) on its answer record through `answerRecorder`
(`runner.ts:248-257`, `answers.ts:31-62`), next to the raw `input` it already
keeps. Nothing resumes from it: a restart completes the lease
`failed/install_restarted` (`poller.ts:126-138`), whose body does not depend on
features.

**Byte identity.** With no `request.features`, `caps.rich` and `caps.media`
are false and every new branch is skipped. The prompt builders, schemas,
Codex and Claude arguments, `checkedAnswer` and completion bodies are the
same functions on the same inputs. The pins are the existing hash fixtures
(`fixtures/legacy-prompt-hashes.json`, `actions-off-2a-hashes.json`,
`switches-off-2b-hashes.json`, `owner-tools-off-runner-hashes.json`,
`owner-tools-off-v3-hashes.json`).

## 6. The formatting guide

### 6.1 Parsing

```ts
const formatGuide = z.object({
  version: z.string().min(1).max(64),
  formats: z.object({ plain: z.number().int().min(1), rich_markdown: z.number().int().min(1) }),
  guide: boundedString(4000),
  markdown_subset: z.array(boundedString(64)).max(64),
  max_blocks: z.number().int().min(1), max_depth: z.number().int().min(1), max_table_columns: z.number().int().min(1),
  buttons: z.object({ allowed: z.boolean(), max_rows: z.number().int().min(0), max_per_row: z.number().int().min(0),
    max_total: z.number().int().min(0) }).passthrough(),
  forbidden: z.array(boundedString(64)).max(64),
}).passthrough();
```

The model sees the object exactly as received. Validation takes the smaller
of each received number and the contract constant, so a changed guide can
only tighten local checks. An unknown `version` is still shown and used.

### 6.2 Restricted answers

`answerPrompt` (`prompt.ts:7-41`), when `caps.rich`, inserts after
`<owner_instructions>`:

```
<format>
{json(input.format)}
</format>
```

`<format>` is not added to the list of data sections in the opening sentence
(`prompt.ts:34`), because the contract makes it trusted service guidance,
like `<service_instructions>`. `toolRoundPrompt` reuses `answerPrompt`, so
tool rounds get it unchanged. `conversationTurnPrompt` (`prompt.ts:77-84`)
adds the same section to its static `sections`, so it is covered by the
digest and resent only when it changes.

The frame keeps its prefix `[Answer with one JSON object`, which
`runner.ts:648` cuts on. Its last sentence, `Use at most N characters.`, is
replaced by:

> format "plain" sends text as written, at most {plainMax} characters.
> format "rich_markdown" renders the Markdown subset in <format>, at most
> {richMax} characters: use it for tables, lists, headings, code or a reply
> longer than {plainMax} characters, and follow <format>. buttons holds up to
> {rows} rows of up to {perRow} links {"text", "url"}, each url https; use []
> for none.

With `caps.generate` it adds:

> When the message asks for a picture you may create one with your image
> tool. attachments lists up to {max_items} files to send after the text:
> only images you created in this turn, by the path your image tool reported,
> with kind "photo" (or "document" to send the original file) and a plain
> caption of at most 1024 characters. Use [] for none.

The progress sentence stays as today. Added bytes, computed from the strings
(not measured with the real builder): the guide serializes to 1,065 bytes,
the section tags add 19 and the frame text about 650, plus about 330 with
`caps.generate`. No test bounds the restricted prompt's size; searched
`prompt.test.ts`, `runner.test.ts` and `ownerTier.test.ts`.

### 6.3 Schemas

`withAnswerParts(schema, caps)` extends `answerSchema`, `handoffAnswerSchema`,
`replyAnswerSchema` and `roundSchema(...)` (`protocol.ts:204-260`) so every
schema that can carry a reply can carry the parts. The Codex output schema
needs every property required and `additionalProperties: false` at each
level, so empty values carry "none":

```ts
format: { type: "string", enum: ["plain", "rich_markdown"] },
buttons: { type: "array", items: { type: "array", items: {
  type: "object", additionalProperties: false, required: ["text", "url"],
  properties: { text: { type: "string" }, url: { type: "string" } } } } },
// caps.generate only:
attachments: { type: "array", items: {
  type: "object", additionalProperties: false, required: ["path", "kind", "caption"],
  properties: { path: { type: "string" }, kind: { type: "string", enum: ["photo", "document"] },
    caption: { type: "string" } } } },
```

Limits stay out of the schema, as today, and are enforced by §7. A Claude
restricted run gets `format` and `buttons` only, since it can read no file
(relay.md §B.6.1) and so has nothing to attach.

### 6.4 Token budget for a 32,000-character answer

Tool-call arguments and structured output are output tokens, and the
contract asks the install to check that a full-length answer fits the
generation budget. Measured from local Claude transcripts (newest 400 files,
assistant records with a single text block of at least 1,500 characters):
the highest ratio of characters to output tokens was 2.52 for Ukrainian text
(380 records) and 3.09 for English (92 records). Lower ratios include hidden
reasoning tokens. A 32,000-character Ukrainian answer is therefore at least
about 12,700 output tokens before JSON escaping and reasoning. Codex, and
Claude Code's configured maximum for the selected model, were not measured
here; §15 lists the probe the build stage runs. The prompt asks for rich
answers only when the content needs them, so most answers stay far below the
cap.

## 7. Local validation

### 7.1 Order

`checkedAnswerV2(value, request, caps, options)` replaces `checkedAnswer`
only when `caps.rich`. It runs the existing action rules first (handoff,
ignore, call), then:

1. `reply_to`: a known id or `null`, as `protocol.ts:299-303` already maps it.
2. `format`: anything other than `rich_markdown` is `plain`.
3. Text: plain must be at most `plainMax` code points. Rich must pass §7.2;
   if it fails and the text is at most `plainMax`, it is sent as plain. A
   failing rich text longer than `plainMax` makes the decision invalid, which
   gives today's `failed/invalid_answer`.
4. Buttons: each failing button is dropped, and a row left empty is dropped.
5. Attachments: references only (§8.1); each failing reference is dropped.
6. Reply rules: `reply` needs nonblank text or at least one attachment that
   survives staging (rechecked after §8.3); `ignore` sends `text: ""` with no
   buttons or attachments.

The largest body this produces is a 128,000-byte rich text plus six buttons
of at most 2,048-character urls and four attachment entries with 1,024-unit
captions: under 160 KB of JSON, far inside the 1,048,576-byte envelope the
contract keeps. Every drop and downgrade is written to the answer record as
`{part, index, reason}`. Nothing is added to the posted text: the owner path
can see refusals at tool time (§10), and a restricted run has finished by
then.

### 7.2 Rich text pre-check

One linear pass over the text, with `\r\n` normalised. Fenced code (```` ``` ````
or `~~~`, closed at a matching fence or at the end) and inline code spans are
skipped by the content rules and count as one block each.

| Rule | Check |
|---|---|
| Length | `[...text].length ≤ richMax` and `Buffer.byteLength(text) ≤ 128000` |
| `raw_html` | `<` followed by a letter, `/`, `!` or `?`, unless escaped as `\<`; this also refuses `<https://…>` autolinks |
| `inline_media` | `![` … `](` |
| Links | every `[label](target)`: `target` parses with `URL`, protocol `https:`, no username or password, host not a non-public IP literal (§7.3); `tg:` targets fail as `tg_links` |
| Reference definitions and footnotes | a line `^\s{0,3}\[[^\]]+\]:` or a `[^…]` marker: outside the subset |
| Blocks | paragraph, heading, code block, each table row and list item count one each; each quote container also counts once at every nesting level, along with its inner blocks; `≤ max_blocks` |
| Depth | list nesting (indent steps) plus `>` levels, `≤ max_depth` |
| Table columns | cells of each pipe-table row, split on unescaped `|` outside code, `≤ max_table_columns` |

The service's parser is the authority, and this pass refuses only what the
contract names. Constructs the contract leaves unnamed (thematic breaks,
setext headings, task-list markers) pass through, and the service's 422
`invalid_format` handles them (§7.4). Every list item and quote container is
counted independently, so the local pass never admits more contract-defined
blocks than the service can accept. Table separator syntax has no rendered row;
the header and every body row count once. The service also counts its own prefix toward the
32,768 rendered ceiling; a 32,000 source cap leaves 768 characters for it,
and the install cannot see the prefix.

### 7.3 Buttons and captions

- Button text: trimmed nonblank, no `[\x00-\x1f\x7f]`, 1–64 code points.
- Button url: at most 2,048 characters; `new URL(url)` succeeds with protocol
  `https:` and no username or password. The host is not `localhost`, not
  under `.localhost`, and not an IPv4 or IPv6 literal in a loopback, private,
  link-local, unique-local, CGNAT or unspecified range. The original string
  is sent; the parse is only a check. Targets are never fetched.
- Shape: at most `rows` rows, each 1–`perRow` buttons, at most `total` in
  all.
- Caption: `caption.length ≤ 1024` (JavaScript string length counts UTF-16
  units, so 512 astral emoji pass and 513 fail) and at most 1,024 code
  points. A longer caption is cut at a code-point boundary below both limits
  and the cut is recorded. A caption is posted literally, as the contract
  says.

### 7.4 Completion statuses under v2

`completeRelayRequest` (`runner.ts:137-186`) keeps every current rule for
legacy bodies. For a body carrying v2 parts:

| Answer | Action |
|---|---|
| 422 `invalid_format`, 415, or 400 `malformed` | one resend without `format: "rich_markdown"`, buttons or attachments, if the text is nonblank and at most `plainMax`; otherwise `failed/invalid_answer`. These codes prove the body was not accepted |
| 422 `attachment_not_ready` | one resend without attachments, under the same text rule |
| 413 | today's rule: `failed/invalid_answer` (`:169-172`) |
| 409 `already_completed` | delivery `accepted`; the claim settles terminal |
| 409 `lease_lost`, 404, 401, 426 | terminal, as today |
| 429 | wait `retry_after_s` if it fits before `until`, then the identical body |
| network, 5xx | identical body, as today |

422 is not on today's terminal list, so without this table an
`invalid_format` would be retried with the same body until the deadline. Each
resend happens only after an explicit 4xx, and `already_completed` appears
only if a changed body follows an accepted one.

## 8. Attachments

### 8.1 Sources

| Run | What it may attach | How it names it |
|---|---|---|
| Restricted Codex with `caps.generate` | images its own run wrote under `<run CODEX_HOME>/generated_images/<thread_id>/` | the path its image tool reported, in `answer.attachments[].path`; only the basename is used, resolved in that one directory |
| Restricted Claude | nothing: no file access (relay.md §B.6.1) | no field in its schema |
| Owner (Claude or Codex, full agent) | any file under the operator's document roots | absolute path through `relay_answer` (§10) |

A restricted run answers chat members, and its text is data from other
people, so it gets no way to name a file outside its own output. An owner run
carries operator authority and full host access, and already sends files
with `telegram_bot_send_document` under the same roots. Its own generated
images live in a dot-directory (`~/.codex`), which the roots refuse, so the
owner agent copies a picture under a root first. The refusal text already
says to (`documents.ts:351`).

### 8.2 The relay kind table

The table is the intersection of the contract's allowlist and the existing
document rules. It sits in `attachments.ts`; `DOCUMENT_EXTENSIONS`
(`contracts.ts:275`) stays as it is, so `telegram_bot_send_document` keeps
its own types.

| Kind | Extensions (resolved file decides) | MIME | Max bytes | Content check |
|---|---|---|---|---|
| photo | `.png .jpg .jpeg` | `image/png`, `image/jpeg` | 8 MiB | signature, then `checkPhotoBytes`: full decode, at most 20 million pixels, width + height ≤ 10,000, ratio ≤ 20 (`service.ts:133-147`) |
| document | `.pdf .txt .log .md .markdown .csv .json .png .jpg .jpeg` | per `documents.ts:46-58` | 20 MiB | signature for PDF, PNG and JPEG (`documents.ts:474-478`); text classes through `documentBytesSecret` (`:330-336`) |
| audio | `.mp3 .m4a` | `audio/mpeg`, `audio/mp4` | 20 MiB | MP3: `ID3` or an MPEG frame sync in the first bytes; M4A: `ftyp` at offset 4 |
| video | `.mp4` | `video/mp4` | 20 MiB | `ftyp` at offset 4 |

`.html` is left out because the contract refuses HTML. A generated photo over
8 MiB is sent as a document, with the original bytes, and the change is
recorded. The total stays at most 64 MiB and `max_total_bytes`, the count at
most `max_items`, and each kind must be in `answer.attachments.kinds`.

### 8.3 Staging

For each accepted reference, in answer order:

1. **Generated image.** `basename(path)` must match `^[A-Za-z0-9_-]{1,96}\.png$`
   and be in the listing of the run's `generated_images/<thread_id>/` taken
   after the run (§9.3). The runner builds the path itself from that
   directory and the basename, and reads it with the descriptor checks of
   `readUnderRoots` (`O_NOFOLLOW | O_NONBLOCK`, the `/proc/self/fd` re-check,
   regular file, one link, bounded read; `documents.ts:395-430`), factored
   out as `readExactFile(path, maxBytes)`. The root, dot-directory and
   state-directory rules do not fit here: a session run's home is inside the
   state directory (`conversations.ts:43`), whose path can pass through a
   dot-directory. Then the photo or document checks of §8.2 apply.
2. **Document root file.** `readUnderRoots(path, roots, documentEnvironment,
   maxBytesForKind, admit)` with the operator's roots (`store.documentRoots()`
   or `<home>/handoff`), then the extension class, signature, secret scan and
   photo checks of §8.2. The wire filename is the `filename` argument or the
   basename: 1–128 characters, no slash, backslash, control character or
   leading dot, and it keeps the file's type class, as `documents.ts:452-470`
   requires.
3. The bytes read are written once to `<runDir>/attachments/<n>` with mode
   0600, hashed with SHA-256 and sniffed into a MIME type. The upload sends
   exactly these bytes, so a file that changes after the check cannot change
   what is sent. The run directory's removal (`runner.ts:804-809`,
   `poller.ts:146-150`) removes the copies.

Disk and decode work runs under `withViewerOperation("relay.attachments",
…)`. The reads are bounded by the per-kind cap. The secret scan is the same
synchronous pass `telegram_bot_send_document` runs today, linear at 20 MB by
design (`documents.ts:138-148`).

### 8.4 Upload

`relayPutBytes(apiBase, route, bytes, headers, credential, { signal,
maxBytes })` in `client.ts` reuses `targetWithSignal` (DNS pinned to the first
resolved address, `http:` only to loopback), refuses 3xx, caps the response
body and parses the error envelope the way `relayCall` does (`client.ts:139-178`).
`recordPublishedRelayReference` is not called; it records only the publish
route (`publishedReferences.ts:38-40`).

`PUT {api_base}/requests/{request_id}/attachments/{attachment_id}` with a
raw body and these headers:

| Header | Value |
|---|---|
| authorization | the paired credential as a bearer token, exactly as `relayCall` sends it (`client.ts:123`) |
| `Delegatus-Relay-Version` | `1` |
| `Delegatus-Relay-Lease` | the request's `lease_id` |
| `Delegatus-Relay-SHA256` | 64 lowercase hex characters of the staged bytes |
| `Content-Type` | the MIME type from §8.2 |
| `Content-Length` | the staged byte count |
| `Content-Disposition` | `attachment; filename="<ASCII fallback>"; filename*=UTF-8''<percent-encoded name>` |

- `attachment_id` = `a{n}-{first 16 hex of SHA-256}` (`Id` syntax, ≤ 64), so
  identical bytes at the same position always get the same id.
- The ASCII fallback swaps every byte outside `[A-Za-z0-9._ -]` for `_` and
  keeps the extension. `filename*` carries the real name. The contract asks
  for a UTF-8 filename decoded once; RFC 6266 `filename*` is the standard way
  to send one. The service's own fixtures for this route will confirm it
  (§16).
- Files go one at a time, in answer order. The contract allows two parallel
  transfers per lease, but the link's upload bandwidth is the bound, and one
  at a time keeps the order and the accounting simple.
- Each PUT's deadline is `min(30 s, deadline.at − now − 3 s)`, with 3 s kept
  for the completion. Past `deadline.at` (an owner run may still answer, as
  `runner.test.ts:964` covers), each file gets one 30 s attempt and the
  service decides.
- Uploads run inside `finish` (`runner.ts:274-341`), after
  `recorder.finish` has persisted the decision and before
  `completeRelayRequest`. The heartbeat timer and cadence keep running until
  `finish`'s `finally` (`:316-319`), so the lease stays fresh while bytes
  move. A request released from a hold (`releaseRequested`) skips uploads.

### 8.5 Upload answers and retries

| Answer | Action |
|---|---|
| 201 or 200 | the receipt's `attachment_id`, `byte_size`, `sha256` and `mime_type` must match what was sent; a mismatch drops the file |
| network error, timeout, 5xx | the same PUT, same id and bytes, after 1 s, 2 s, 4 s, until the file's deadline |
| 429 `rate_limited` | the same PUT after `retry_after_s`, if it fits |
| 409 `lease_lost`, 404 | lease gone: no further upload, no completion; the runner returns `null`, as a lost heartbeat does (`runner.ts:433-441`, `:728`) |
| 409 `attachment_conflict`, 400, 413, 415, 422 | drop that file and record the code |
| 401 | drop the rest; the poller learns the credential state on its own call |

After the loop, `answer.attachments` lists the uploaded files in answer
order as `{attachment_id, kind, caption}`. When none uploaded and the text is
blank, the decision becomes `failed/invalid_answer`. The service sends text
first, then each attachment, through the request's own bot, chat and topic;
the install sends no destination.

### 8.6 Lifetimes

Local copies live in the run directory and leave with it. A file uploaded
and then left out of the completion expires on the service at the lease
deadline. A Viewer restart mid-upload ends in the existing orphan sweep:
`failed/install_restarted` and removal of the run directory.

## 9. Codex native image generation

### 9.1 Measurements

Codex CLI 0.162.1 (`codex features list`: `image_generation stable true`),
with the operator's `gpt-6.1-sol` catalog entry (`tool_mode: code_mode_only`)
copied into a private catalog. The flags were this profile's own
(`ephemeral.ts:208-270`) minus `--disable image_generation`, with isolated
HOME, CODEX_HOME and TMPDIR under the stage scratch. The model provider was a
Bun stub on a port-0 loopback listener, `chatgpt_base_url` pointed at the
stub, and `HTTP(S)_PROXY` was a closed loopback port with `NO_PROXY` for
loopback. No request left the machine, no account was used, no image was
generated by a real service. The stub answered with code-mode `exec` calls.

| Run | Observed |
|---|---|
| Auth file `{}`, provider without OpenAI auth | `ALL_TOOLS` = `clock__curr_time`, `list_mcp_resource_templates`, `list_mcp_resources`, `read_mcp_resource`: no image tool |
| A synthetic ChatGPT-mode auth file | `ALL_TOOLS` adds `image_gen__imagegen`; a call posts `{prompt, background: "opaque", model: "gpt-image-2", quality: "auto", size: "auto"}` to `{provider base}/images/generations`; the tool returns `{image_url: "data:image/png;base64,…", output_hint: "Generated images are saved to <CODEX_HOME>/generated_images/<thread_id> as <…>/exec-<uuid>.png by default…"}`, and the file is there |
| Same, `exec --json` stdout | only `thread.started`, `turn.started`, the final `agent_message`, `turn.completed`; nothing for the `exec` call or the generation |
| `referenced_image_paths: [<a PNG outside the run directory>]` under `-s read-only` | the file is read and posted to `/images/edits` as a base64 data URL |
| Same, `-c default_permissions=":workspace"` | read and posted |
| Same, `-c default_permissions="relay" -c 'permissions.relay.filesystem={"<run cwd>"="read"}'` | refused: "unable to read referenced image at `…`: No such file or directory"; no `/images/edits` request |
| Plain generation under that profile | `/images/generations` posted, PNG saved in `generated_images/<thread_id>/`, `--output-last-message` written |

Before this design, the restricted Codex profile could read no file, because
command, patch and view tools are all disabled (relay.md §B.6.4). Enabling the
image tool under `-s read-only` would let any chat member's message steer
the agent into sending a local picture to the provider and attaching the
edit. The read-restricted profile closes that.

### 9.2 Launch changes

`EphemeralAgentRequest` gains `imageGeneration?: { readableRoot: string }`,
which the runner sets when `caps.generate`. In `buildEphemeralCommand`, Codex
branch only:

- `--disable image_generation` is left out. `codexSubagentArgs` keeps it
  enabled, since `image_generation` is in `CODEX_SINGLE_AGENT_FEATURES`
  (`src/lib/agent/codexSpawnPolicy.ts:9-18`).
- `-s read-only` (`:244`), or `-c sandbox_mode="read-only"` on resume, becomes
  `-c default_permissions="relay"` and
  `-c permissions.relay.filesystem={"<readableRoot>"="read"}`. Codex refuses
  `sandbox_mode` together with `default_permissions`.
- Non-session runs pass `answerHome(account, path.join(runDir, "codex-home"))`
  (`:76-98` already takes a home), so generated images land under the run
  directory and leave with it. A fresh home measured 944–956 KB after one
  probe run (skills 500 KB, SQLite files), against 940 KB–1.1 MB for the live
  shared answer homes; that is the cost per image-enabled run.
- Session runs keep the conversation's home (`conversations.ts:43`), which
  `resume` needs. The runner lists `generated_images/<sessionId>/` before the
  launch and takes only new names after it. It deletes the new files by their
  recorded paths once the request settles, so pictures do not pile up toward
  the conversation's 32 MiB retirement size (`conversations.ts:131`).
- `readableRoot` is `<runDir>/cwd` (or `conversation.cwd` for sessions), an
  empty directory.
- `tail` records `thread.started.thread_id` whenever `imageGeneration` is set
  (`:345-346` does so only for sessions), and the result carries `threadId`.

Unnegotiated runs keep today's arguments and home byte for byte.

### 9.3 Capture

After `launchedRun.done` (`runner.ts:719`), the runner lists
`<home>/generated_images/<threadId>/` once with `readdir`: a bounded listing
of one directory, written only by this run. The answer's attachment paths are
then resolved against that listing (§8.3). Images the answer does not name
are never sent. A Codex account in API-key mode has no image tool (§9.1),
and the prompt sentence of §6.2 is harmless there.

### 9.4 The progress parser

At 0.162.1 the exec stream carries no image item, so capture does not
depend on the parser. The brief expected an item; the measurement shows
none. Codex does name image generation elsewhere: `image_generation_call` in
rollouts and `imageGeneration` among its live thread items, as
`docs/design/agent-images.md:107` records. With `profile.imageGeneration`,
`mapAgentLine` (`progress.ts:18-25`) therefore admits item types
`image_generation` and `image_generation_call` and maps their start and
completion to a `tool` event named `image_generation`. Every other new type
still trips the fail-closed tripwire of relay.md §B.6.5, and without the
profile both names are still violations.

### 9.5 Claude

A Claude restricted run is unchanged apart from `<format>`, `format` and
`buttons`. A Claude owner run attaches through `relay_answer` like any owner
run.

## 10. Owner runs

### 10.1 Prompt and answer

When `caps.rich`, `ownerRunPrompt` (`ownerRun.ts:24-46`) adds the
`<format>` section. The opening sentence (`:29`) lists `<format>` among the
sections that "may shape only how your reply reads". The closing sentence
`Write plain text of at most ${request.answer.max_chars} characters as your
last message.` (`:44`) becomes:

> Write your last message as plain text of at most {plainMax} characters.
> For tables, lists, headings, code or a longer reply, first call
> relay_answer with format rich_markdown, then write Markdown in the subset
> <format> lists, of at most {richMax} characters. relay_answer also sets up
> to {rows} rows of {perRow} https link buttons{media:, and up to {max_items}
> files to send after your message (photo, document, audio or video) by
> absolute path under your document roots}; never write a path into the
> message itself.

`ownerAnswer(text, request, owner, credentials, staged)` (`:48-55`) scrubs as
today. Plain text is truncated at `plainMax`, the same `…` rule the code
applies today. Rich text is used when `staged.format` is `rich_markdown` and
the scrubbed text passes §7.2. Otherwise the text falls back to plain under
the same truncation. Buttons and captions pass through
`scrubOwnerOutput` too, and a button whose url the scrub changed is dropped.
Owner answers keep `reply_to: owner.messageId`.

Without negotiation none of this runs, and the owner prompt keeps its bytes
(`owner-tools-off-*` hashes, `ownerTier.test.ts:58-71`).

### 10.2 The `relay_answer` tool

- **Schema** (beside `server.ts:4560`):

  ```ts
  relay_answer: z.object({
    format: z.enum(["plain", "rich_markdown"]).optional(),
    buttons: z.array(z.array(z.object({ text: z.string().min(1).max(64), url: z.string().min(1).max(2048) }))
      .min(1).max(3)).max(2).optional(),
    attachments: z.array(z.object({ path: z.string().min(1).max(4096),
      kind: z.enum(["photo", "document", "audio", "video"]), caption: z.string().max(1024).optional(),
      filename: z.string().min(1).max(128).optional() })).max(4).optional(),
  }),
  ```

- **Description**: "Only while you answer a relay message as its owner: how
  your last message is delivered. format rich_markdown renders Markdown up to
  the length the prompt states; buttons are https links; attachments are files
  under your document roots, sent after the message. Each call replaces the
  previous one. Refused in any other conversation and after you answer."
- **Binding** (beside `relay_owner_history`, `bindings.ts:7954`), in order:
  (1) caller `kind: "agent"`, a conversation, no deputy (`:7437-7440`);
  (2) `liveOwnerRelayRequest(conversationId)` finds the live owner run;
  (3) `globalThis.__llvRelayOwnerAnswers` holds an open entry for that request
  with the same relay and target. Any failure answers `relay_answer_unavailable`
  and names no request or chat.
- **Each call** validates everything with §7.3 and §8.2-8.3, stages the copies
  in the request's run directory, and replaces the entry's parts whole. It
  answers `{ format, buttons, attachments: [{ index, kind, filename, bytes }],
  limits }`. A refusal names the class (`document_outside_roots`,
  `document_forbidden_path`, `document_type`, `document_secret`, `too_large`,
  `button_invalid`, `caption_too_long`, `media_not_negotiated`) and never the
  file content. A replaced call's copies are deleted by their recorded paths.
- **Receipts.** In `RECEIPT_FREE_READ_TOOLS` and `OPTIONAL_READ_KEY_TOOLS`
  (`server.ts:209-219`), like `relay_owner_history`. A lost reply that is
  retried replaces the same parts with the same result. It stays out of
  `MUTATING_MCP_TOOL_NAMES` and out of voice classification.
- **Registry lifetime.** The runner opens the entry before `runOwnerAgent`
  (`runner.ts:655`) when `caps.rich`, and closes it right after
  `launchedRun.done` resolves with a result (`:719`), so a staged call that
  arrives after the answer is refused. It reads the parts when it builds the
  body (`:745-753`) and deletes the entry in `finally`. A restart leaves no
  entry, whatever the ledger says.
- **Results** use the normal `McpToolResult` path, which lane 64949d7e sends
  once as text to native clients (`mcpToolResponse`); nothing here is
  tool-specific.

## 11. Threat cases, against every path that answers

| Attempt | Restricted path | Owner path | Stopped by |
|---|---|---|---|
| A member asks the agent to attach `~/.ssh/id_ed25519` or any path | the schema takes a path; only a PNG basename present in this run's `generated_images/<thread_id>/` resolves | `readUnderRoots`: outside roots, dot-directory, state directory | §8.3 |
| A member asks for an "edit" of a local photo | the image tool cannot read outside `<run>/cwd` (§9.1 probe) | the owner already has host access | §9.2 profile |
| A symlink or hard link in the generated directory or a root | `readExactFile` re-checks the opened descriptor and refuses `nlink > 1` | `readUnderRoots`, the same checks | `documents.ts:395-411` |
| A file swapped after the check | bytes copied once and hashed; the PUT sends the copy | same | §8.3 step 3 |
| A text document with a token | not attachable | `documentBytesSecret` refuses it | `documents.ts:481-490` |
| A pixel bomb or truncated image | full decode, ≤ 20 M pixels | same | `checkPhotoBytes` |
| A spoofed extension (HTML named `.png`) | signature check | signature or class check | §8.2 |
| A button whose url is plain http, a `tg:` link, carries a user and password, or names a loopback IP literal | dropped | dropped | §7.3 |
| Raw HTML, an image or a `tg:` link inside rich text | rich refused, plain if it fits | same | §7.2 |
| Another conversation, a sub-agent, the voice gateway or a seat calls `relay_answer` | n/a | refused at binding steps 1-2 | §10.2 |
| `relay_answer` after the answer or after a restart | n/a | entry closed or absent | §10.2 |
| A credential in a caption or button | restricted runs cannot read one | `scrubOwnerOutput` | §10.1 |
| Upload to another host | `relayPutBytes` takes only `relay.api_base`; DNS pinned; redirects refused | same | §8.4 |
| Lease lost during upload | no completion | same | §8.5 |
| A request without `request.features` that carries `input.format` or `answer.attachments` | ignored: v2 needs the feature | same | §5 |
| `relay_media_out` without `relay_rich_messages` | media off | same | §5 |

The same checks run for tool-loop rounds, because every reply-capable schema
goes through `withAnswerParts` and every decision through `checkedAnswerV2`.
Prototype decisions (`prototypeAnswer.ts`) produce short plain text and pass
the plain cap.

## 12. Composition with lanes 05ef830c, 97089d71 and 64949d7e

Read from their branches: 05ef830c at `4729111f` (2026-10-17 14:25 +03:00,
build commit, its last stage failed review on a P1 in `ownerRun.ts`),
97089d71 at `ed622ecb` (design only), 64949d7e at `0f031f5e`. Their landing
order is not settled. This lane keeps its edits additive and expects a
refresh before merge.

**05ef830c (reply-chain conversations).**

- `poller.ts:266`: it sets `features = CLAIM_FEATURES` and drops
  `chat_conversations`; this lane appends after the owner-tools line. Both
  edits fit together.
- `switches.ts`: it renames `chat_conversations` to `chain_conversations`
  (`!== false`); this lane adds `rich_media` to the same returned object, a
  one-line merge.
- `runner.ts`: it rewrites admission (`:541-607`), the owner launch and
  continuation (`:653-770` there) and the conversation release in `finally`.
  This lane touches the request caps (after `:205`, untouched there), the
  schema argument, two `runEphemeralAgent` fields, the decision call, the body
  build and `finish`. The owner registry closes only after `done` resolves
  with a result, outside its `OwnerContinuationRefused` catch, and stays open
  across that catch's `rounds--; continue` retry, as 97089d71 also requires.
- `ownerRun.ts`: it moves the closing paragraph into
  `ownerClosingPrompt(request, hardCapMinutes)` and adds
  `ownerStaticSections` for continuations. If it lands first, this lane puts
  its sentence into `ownerClosingPrompt` and `<format>` into
  `ownerStaticSections`, so a continued owner turn receives them. Their digest
  covers both, so the changed text goes out once on the first continuation
  after deploy. `ownerAnswer` is unchanged there, and its continuation
  observer returns `finalText` through it.
- `prompt.ts`: it changes the `seen` window in `conversationTurnPrompt`; this
  lane adds one static section there.
- `answers.ts`: it adds `chain` to the record and to `finish`'s type; this
  lane adds `features` and widens `answer`, on adjacent lines.
- Session image capture (§9.2) uses `conversation.sessionId`,
  `conversation.cwd` and `conversationCodexHome`, all kept there.

**97089d71 (owner service tools).** It designs `relay_service_tools` with the
same binding shape (`liveOwnerRelayRequest`, a `globalThis` registry opened
before `runner.ts:655` and closed after `:719`). Whichever lane lands first
exports `liveOwnerRelayRequest` from `ownerAuthority.ts`; the second reuses
it. Both append one name after `relay_owner_history` in `MCP_TOOL_NAMES`, one
schema, one description and the receipt sets: an adjacent-lines merge. Both
edit the owner closing paragraph. Its sentence about `<tools>` and this
lane's sentence about format are independent clauses in the same paragraph,
and the second lane re-measures the owner prompt bytes it reports.

**64949d7e (MCP result shape).** `relay_answer` returns an ordinary
`McpToolResult`. That lane sends it once as text to Codex and Claude. No
change is needed here.

**Partner fixtures.** At `71edd6cb` the service has the design only. When its
media-and-rich release ships wire fixtures, the build copies them byte for
byte into `src/lib/externalRelay/fixtures/relay_v1/`, with their hashes in
its README, as earlier slices did, and the protocol and runner tests parse
them.

## 13. Files

New: `src/lib/externalRelay/answerV2.ts`, `attachments.ts`, `ownerAnswer.ts`
and their tests. Changed: `switches.ts`, `poller.ts`, `protocol.ts`,
`prompt.ts`, `runner.ts`, `client.ts`, `progress.ts`, `ownerRun.ts`,
`ownerAuthority.ts`, `answers.ts`, `testRelay.ts` under
`src/lib/externalRelay/`; `src/lib/agent/ephemeral.ts`;
`src/lib/telegram/bot/documents.ts` and `service.ts` (moving the photo
check); `src/lib/mcp/server.ts`, `src/lib/mcp/bindings.ts`;
`docs/design/relay.md` (one revision line). No UI change: the answer record
gains fields that the relay chat views do not render yet.

## 14. Tests

Run each file by explicit path through `scripts/gate-slot.sh bun test <file>`,
with private HOME, XDG_CONFIG_HOME, TMPDIR and `LLV_STATE_DIR` under the OS
temp root, and `LLV_VIEWER_CONTROL_URL` on a closed port. "Red on main" means
the case fails at `49648aba`. Fake agents are the existing bun stub CLIs
(`runner.test.ts:101-106`); the service is `startTestRelay` on port 0.

A stage's scratch `TMPDIR` can pass through `.config`, and the dot-directory
rule then refuses every document-root file; an earlier lane lost three media
cases to that. Tests that place document roots therefore root their private
HOME under `/tmp`, as `ephemeral.probe.test.ts:14` does.

| # | File | Case | Red on main because |
|---|---|---|---|
| 1 | `protocol.test.ts` | a request with `features`, `input.format` and `answer.attachments` keeps all three after `requestSchema`; malformed values are dropped and the request still parses; every service-wire and relay_v1 fixture parses to the same object as before | the fields are stripped |
| 2 | `poller.test.ts` | descriptor lists both → claim ends with `relay_rich_messages`, `relay_media_out`; only `relay_media_out` listed → neither; `relay:rich_media: false` → neither; no listing → features equal today's | never announced |
| 3 | `switches.test.ts` | `rich_media` is on when the key is absent or holds anything other than `false`, and off for `false`; an unreadable or malformed file reads as on; existing assertions gain the key | key absent |
| 4 | `answerV2.test.ts` | plain 4,000 / 4,001 code points with `max_chars` 32,000; rich 32,000 / 32,001 code points; 128,000 / 128,001 UTF-8 bytes; 500 / 501 blocks, including table rows and quote containers; 16,000-character nested bracket scan; depth 16 / 17; 20 / 21 columns; raw HTML, `\<` escaped, `<https://…>`, `![x](https://…)`, `[a](http://…)`, `[a](tg://user?id=1)`, reference definition, footnote; buttons: 2×3 pass, a seventh dropped, label 64 / 65, blank, control character, url 2,048 / 2,049, `http:`, userinfo, an IPv4 loopback literal, a private IPv4 literal, the IPv6 loopback literal, `localhost`; caption 512 / 513 astral emoji; `ignore` with buttons sends none; reply with blank text and one attachment allowed; unknown `reply_to` becomes `null` | module absent |
| 5 | `runner.test.ts` | **negotiation on, rich**: the claimed request carries `features: ["relay_rich_messages"]` and `input.format`; the stub agent answers 5,000 characters of Markdown with a table and one button → the prompt contains `<format>` with the guide JSON verbatim, the schema has `format` and `buttons`, the completion body has `format: "rich_markdown"` and the button | prompt, schema and body lack them |
| 6 | `runner.test.ts` | **plain over cap under negotiation**: 4,001 characters with `format: "plain"`, no Markdown → the text is not sent as plain: rich if valid, else `failed/invalid_answer`; the stub never sees a 4,001-character plain answer | main posts it |
| 7 | `runner.test.ts` | **attachment round-trip**: Codex target, `caps.generate`; the stub CLI emits `thread.started`, writes a decodable 2×2 PNG to `$CODEX_HOME/generated_images/<thread>/exec-1.png` and answers with that path, kind `photo` and a caption → the test service receives a PUT on `/requests/<id>/attachments/a0-<hex>` before `/complete`, with the lease, SHA-256, `image/png`, `Content-Length`, `filename*` and bearer headers and the same bytes; the completion lists `{attachment_id, kind: "photo", caption}`; the first PUT's connection is dropped and the retry reuses the id and gets 200; the run directory, and with it the per-run home, is gone after settlement | no PUT, no attachments |
| 8 | `runner.test.ts` | **lease lost on upload**: PUT answers 409 `lease_lost` → no `/complete`, `runClaimedRequest` resolves `null` | main completes |
| 9 | `runner.test.ts` | **upload refused**: 415 on the PUT → completion without that attachment and the record names `unsupported_media_type`; blank text with its only file dropped → `failed/invalid_answer` | no PUT |
| 10 | `runner.test.ts` | **422 `invalid_format` on completion** → one resend as plain when the text fits, else `failed/invalid_answer`, never a third body | main retries the same body until the deadline |
| 11 | `runner.test.ts` | **hostile path**: the stub answers a valid PNG path outside the run's generated directory → no PUT, record reason `outside_run` | (guard) |
| 12 | `ephemeral.test.ts` | `imageGeneration` set: no `--disable image_generation`; `default_permissions="relay"` and the filesystem table naming the readable root; no `-s read-only`; `CODEX_HOME` under the run directory; unset → today's arguments, element for element; Claude ignores it | options absent |
| 13 | `progress.test.ts` | with `imageGeneration`, `image_generation` and `image_generation_call` items map to a `tool` event; without it they are violations; the 0.162.1 stdout of §9.1 maps to no violation | admitted case is a violation |
| 14 | `ownerTier.test.ts` | **owner path**: rich + media negotiated, owner target, fake owner ports; while observed, the fake agent calls the real `relay_answer` binding (attribution `{kind: "agent", conversationId}`) with `rich_markdown`, one button and one PNG under a document root in the private HOME, then ends with 6,000 characters of Markdown → completion carries the full text, `format`, the button and the uploaded attachment; the same flow without negotiation keeps today's prompt bytes and truncation | tool absent, text truncated at `max_chars` |
| 15 | `ownerAnswer.test.ts` | binding refusals: another conversation, a deputy, a closed entry, no negotiation, a path outside roots, a dot-directory, a text file with a token, a seventh button, a fifth file; a second call replaces the first and deletes its copies | module absent |
| 16 | `client.test.ts` | `relayPutBytes` sends exactly the headers of §8.4, refuses 3xx, parses `{error:{code, retry_after_s}}`, aborts at its deadline | function absent |
| 17 | `attachments.test.ts` | valid MP3/M4A/MP4/PDF structures, audio/video handler mismatch, missing movie track or PDF page tree, HTML renamed `.png`, an 8 MiB + 1 generated photo sent as a document, 64 MiB total, attribution before worker result, abort cleanup, `Content-Disposition` for a Cyrillic name | module absent |
| 18 | `ephemeral.probe.test.ts` (gated by `LLV_ANSWER_PROFILE_PROBE=1`) | the §9.1 runs against a port-0 stub with a synthetic ChatGPT-mode auth file, egress closed by a proxy on a closed loopback port: image tool listed, generation saved under the thread directory, a referenced path outside the readable root refused with no edit request, no image item on stdout. The synthetic token is assembled at run time, so no token-shaped literal is committed | probe absent |

**Guards that must stay green**: the hash fixtures of §5;
`runner.test.ts:2008` (slice 1 launches unchanged), `:2069`, `:2091`, `:2121`;
`ownerTier.test.ts:58-71`; `ephemeral.test.ts:70`, `:102`, `:266` (web search
stays the only tool the closed profile adds without `imageGeneration`);
`src/lib/telegram/bot/service.test.ts` for the moved photo check; the MCP
catalog tests in `src/lib/mcp/server.test.ts` and
`src/runtime-host/mcpRuntimeCompatibility.test.ts`, which see one more name.

**Checks per AGENTS.md**: the touched files above, then typecheck, lint of
changed files and the privacy gate with the committed fingerprints. Required
hosted checks must be green before merge. None of these touch the runtime
host, the Bun pin or `bin/`, so the runtime and native lanes run only as the
hook selects them.

## 15. Rollout and verification

1. Merge with the switch on by default. Nothing changes until the service
   advertises the features.
2. When the service enables them, the descriptor refresh adds them to the
   claim within 5 minutes. The answer record shows `features` on the first
   negotiated request.
3. Stage checks with the service's stage, in a topic: a rich table, a long
   answer over 8,192 characters, two URL buttons, one photo, one PDF, one
   MP3, one MP4, an attachment-only reply, and a Codex-generated image
   requested by a member. The service's design lists the same stage checks
   for its side.
4. Token budget: one real run per engine is asked for a 32,000-character
   answer, and the completion must parse. The build stage records the output
   token count from the transcript. This needs one account call per engine.
5. Back-out: `relay:rich_media: false`; the next claim drops both features,
   and leased requests finish under the caps they were leased with.

## 16. Validation against the requirement

| Requirement part | Where |
|---|---|
| Codex relay runs generate pictures with Codex's own tool | §9; the service never calls its hosted tool for these files (§3) |
| A relay answer can send a picture; Claude cannot generate | §8, §9.5; Claude owner runs attach through `relay_answer` |
| Any picture or document, in general | owner runs: any file under the document roots, four kinds; restricted runs: their own generated images (§8.1) |
| Build our half once the format is agreed | contract `71edd6cb`, §3 |
| Rich Markdown over 4,000 characters or for structure, maybe buttons | §6, §7 |
| The service knows how and when to use rich Markdown; the install passes the formatting instructions | the service authors `input.format.guide`; the install passes it verbatim to every negotiated run (§6) |
| (1) negotiate, persist, byte-identical otherwise | §5 |
| (2) guide to the agent, local validation | §6, §7 |
| (3) any engine attaches, lease-bound PUT, document rules reused | §8, §10 |
| (4) Codex native generation captured, parser accepts the item | §9; at 0.162.1 there is no item to accept, and the parser admits the two known names (§9.4) |
| (5) owner runs return rich text, buttons, attachments | §10 |

## Deferred — not currently justified

- **Document-root files from restricted (member-facing) runs.** Those agents
  read no file today, and their instructions come from chat members. Letting
  them name files under the roots would turn any member's message into a
  request for the operator's shared files. Add only if the operator asks for
  members to receive operator files, with a per-target allowlist.
- **A separate image-generation switch.** The member limit
  (`profile.ts:28-35`) bounds how often a member can ask. Add one if the
  account's image quota becomes a problem.
- **Uploading at `relay_answer` time.** That would let an owner agent see
  service-side refusals during its turn. Local checks cover every limit the
  contract names, so uploads at completion keep one code path.
- **Two parallel uploads per lease.** Bandwidth bounds the transfer;
  revisit if measured uploads miss the window.
- **Re-encoding generated photos over 8 MiB as JPEG.** They are sent as
  documents with the original bytes.
- **Rendering rich answers and attachments in the install's relay chat view.**
  Records keep the metadata; the operator has not asked to see it there.
- **Typed mentions, albums, embedded media, callback, web-app and login
  buttons.** The contract defers them.
- **`chain_conversations`, `relay_media_in`, `seed_media_refs`.** Other lanes
  and a later release.
- **Editing a session's earlier generated images by path.** The read
  restriction refuses them; the image tool's `num_last_images_to_include`
  still works from the conversation.

## Not verified in this stage

- No product code or test ran: the stage is read-only. The red-on-main
  claims follow from the code read at `49648aba`.
- The probe used a synthetic auth file and a stub, so the real image
  service's latency, size and content policy were not observed. One past
  local rollout shows a real generation taking 22.9 s and a 2.7 MB PNG.
- The service's handling of `filename*` and its exact Markdown parser are
  known only from the contract text; its stage checks and wire fixtures will
  confirm them.
- Claude Code's and Codex's output-token ceilings for the configured models
  were not measured (§15 step 4).
- Lane 05ef830c's head may move after `4729111f`; its review is open.
