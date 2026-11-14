# Owner relay media

Requirement, 2026-11-14, paraphrased from the verified owner requirement pinned to this stage: Claude/Codex relay agents must inspect returned pictures, reuse references in image tools and attach them to replies. The seat verifies a production photo after merge/deploy.

## Evidence and transport

Here **R** means `src/lib/externalRelay`, **M** means `src/lib/mcp`. Read the checkout, tests, earlier implementation/review transcripts and PR #4040’s open diff. No suites or paired-service calls ran.

**Premise confirmed:** `M/bindings.ts:9200` → `R/ownerServiceTools.ts:151` → cached batch (`:93`) → `toolLoop.ts:255,307–341` preserves authorized service JSON as an output string, bounded by 64 KiB aggregate. The adapter copies it (`ownerServiceTools.ts:113–119`); `M/server.ts:5265` returns one JSON text block. Metadata survives; pixels are never downloaded/constructed. `R/runner.ts:880` excludes owners from `toolResultMedia`. `ownerRun.ts:72–86` instructs fetching missing document extraction, establishing no vision support.

Hosted calls collect images at `runner.ts:1229`: `toolResultMedia.ts:39–94` decodes `media[]` / `selected_frames[].file`, validates/downloads via `prepareInboundMedia`, then supplies Claude native image input or Codex paths (`runner.ts:968–974,1032`). Tests cover bytes, deduplication, limits/cleanup (`toolResultMedia.test.ts:20–108`) and both next-round engines (`runner.test.ts:5149`). Owner tests cover text/pending retries (`ownerServiceTools.test.ts:70,283`), and `M/relayServiceTools.test.ts:4` establishes receipt-free calls. MCP vision remains untested.

| Option | Judgment |
|---|---|
| **Inline image + metadata: recommended** | [MCP image content](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#image-content) carries base64/MIME. [Claude Code](https://code.claude.com/docs/en/mcp#images-in-tool-results) displays it inline. Installed Codex 0.166.0 [converts image blocks to model input](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/protocol/src/models.rs#L2330), but structured content takes precedence: omit it for image responses. Preserve text-client handling (`M/server.ts:5261,5286`) and HTTP parity (`M/http.ts:288`). |
| File path | Claude Read / Codex view_image can see readable files; existing restricted inputs use them (`R/mediaInput.md`). Requires another call and filesystem/mount admission; fails same-answer acceptance. Context retains stale paths. |
| Both | Adds filesystem access/path retention. Keep originals internal; expose no root. |

`R/ownerMedia.ts:20–33,86,108` instead uses owner-history selectors, a 2 GiB ceiling and retained evidence. All Viewer MCP tools share the text serializer. No inline-image precedent was found; native binding probes remain required.

## Shared mechanism, bounds, privacy

Open one request collector after inbound preparation; share its successful-ref lookup with the owner loop. Collect inside its cached batch before completion, preserving joining, `in_progress` and authority checks. Reuse downloader/validation and extract the existing preview encoder (`R/mediaInput.ts:145–162`). Carry trusted media separately through service success, cursor/short-id copies and response wrappers; only `mcpToolResponse` emits image blocks, associated with descriptors by index. Exclude bytes from JSON text, structured content and receipts; preserve complete refs.

Bounds: JPEG/PNG; original ≤20 MiB; ≤20 million pixels; decoder ≤3 seconds; ≤10 distinct attempts and ≤100 MiB reserved originals across initial/returned media, including failed downloads. Each answer: ≤10 images, ≤14 MiB serialized including existing ≤64 KiB tool text; each preview ≤1 MiB, ≤1568 pixels/side with existing smaller JPEG fallback. Small admissible originals stay byte-identical. Download deadline: min(30 seconds, lease, ref expiry). Reserve before downloading; collect sequentially; identical descriptors reuse downloads, conflicting ones fail. At every size/count limit, unready/expired/non-image result or failed download, return bounded cause text without throwing or echoing refs; retain textual extraction where available. Lease loss closes access. Ref expiry also gates seeds and cached attachment selection; downloaded context gains no renewable ref lifetime. Native context limits remain engine-owned.

Request originals/partials: private run scratch, directories 0700/files 0600, generated filenames; collector disposal removes them on finish/cancel/revocation independently of late-answer staging. Clear registries/caches; crash cleanup follows ownership manifests. Inline images also enter **native context**, the explicit persistence exception: Claude may save session tool-result artifacts; Codex retains rollout image content. Require 0700/0600 storage and native-probe verification. Extend/test context deletion (`src/lib/scanner/deleteTranscript.ts:37`) to remove manifest-owned artifacts where companion deletion misses them. Owner conversations bypass relay-chain deletion (`R/conversations.ts:226–235`), so no three-day or request-end expiry can be promised for native context. Preserve continuation.

Additional persistence needs protection: journal projection currently passes small items unchanged (`src/lib/runtime/engineHostEvents.ts:184,428`). Sanitize relay tool arguments/results before it, retaining identity/status/count only. Tool records already omit bodies (`R/toolLoop.ts:348`). Strip refs from answer-history copies (`R/answers.ts:169`) and catalog title/first-prompt/search projections (`src/lib/scanner/describe.ts:1121`). Keep native context intact. Diagnostics use fixed causes; exclude URLs/descriptors/evidence. Cover reused conversations/cloud fallback.

## References and contract boundary

Older mirrored `R/fixtures/relay_v1/lookup_results.json` exposes no ref input on the image tools; `generate_video` accepts only prompt. `seed_image_roles` alone grants no ref mechanism. PR #4040's service mirror `avatar_seed.json` establishes exactly:

| Tool | Argument |
|---|---|
| `generate_image` | `seed_media_refs` |
| `update_self_profile_photo` | `seed_media_refs`, also alongside `use_current_profile_photo` |

Require negotiated `relay_media_in` and `requester_context`, 1–10 unique refs. No separate editing/ref-taking tool is established. The loop checks advertised tool names, object arguments, cursors and 64 KiB call bodies, without general JSON-Schema validation (`R/toolLoop.ts:263–277`). Today `admittedSeedMedia` admits only ready claim JPEG/PNG refs, ≤4, without checking download success/current expiry (`R/mediaInputValidation.ts:64`). Integrate PR #4040 first: reuse its successful returned-ref set and ten-ref limit; add request-local expiry/identity lookup for initial/returned refs, advertised seed syntax and actionable refusals. Preserve argument order/service denials/uncertainty/charging. Never mutate claim history or share refs between requests.

`relay_answer` accepts paths (`R/protocol.ts:135–140`), stages document-root files (`ownerAnswer.ts:53`; `attachments.ts:237`), uploads bytes and completes with attachment identifiers. No inbound-ref completion field exists. Add a local selector accepting exactly one of path/media_ref, resolving only admitted originals; resolve before the path-only worker, pin/recheck original identity and digest, and reuse staging/upload without a general scratch root. Keep negotiated ≤4 attachments/≤64 MiB, photo ≤8 MiB, other permitted files ≤20 MiB, caption/order/replacement and late-answer custody. Never silently replace originals with previews.

Questions for the paired service seat: Does owner get_media photo output follow the mirrored download/expiry contract? Do both seed tools accept those photo/frame refs? May downloaded inbound images be re-uploaded as answer attachments, including protection rules? Direct ref completion needs agreed negotiation/authorization/expiry/refusal codes. Pending answers, deliver viewing/mirrored seeds; refuse ref attachments as contract-unavailable. Mirror the agreement before enabling reuse.

## Smallest build slices and tests

1. Integrate #4040; share collector/encoder and expiry lookup. Explicit `toolResultMedia.test.ts`, `mediaInput.test.ts`, `avatarSeed.test.ts`: exact bytes, previews, every boundary, duplicates, failures, disposal.
2. Wire owner/MCP; extend `ownerServiceTools.test.ts` and `M/relayServiceTools.test.ts` using SDK client → real server/service/binding → port-0 fixture service. Cover transports/content modes, all failures, retries, revocation and second-request isolation. Probe installed Claude/Codex with local model stubs and external network closed; verify actual provider image input, artifact modes/lifetimes.
3. Seed/contract-permitted attachment binding tests: mirrored tool successes/denials, expiry, ten/eleven refs, mixed origins, upload failure, replacement/late cleanup. Extend owner-answer/attachment/native-reply tests; schema → MCP/binding → owner parts → worker → staging/upload → completion/history/recovery, with empty attachments as the default.
4. Privacy regressions: tiny images and refs in arguments/errors, journals/catalog/history, including engine artifacts. Run touched files only, isolated HOME/XDG/TMPDIR/state and closed Viewer control URL through the gate; then required TypeScript, lint, merge-base privacy and committed-tree publication selection, zero new failures against main.

## Deferred — not currently justified

New endpoints/downloaders, disk-path fallback, durable/cross-request refs, new formats, audio/video playback, charging changes and new engine transports. The paired seat owns native service-agent work. No migration/ADR.
