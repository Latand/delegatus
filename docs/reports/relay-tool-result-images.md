# Images from relay read tools

After deploying this change, select each restricted relay engine in turn and
ask the bot `/ai Describe my current profile photo.` Use a controlled avatar
with recognizable objects or colors. A correct answer describes the visible
image; a protected, missing or refused image produces an explicit reason.
This live check belongs to the seat after deployment. Development checks use
synthetic images and a fake download endpoint only.

## Confirmed service contract

Acceptance 1 was repeated against service revision
`ff616e1956c9234cd9507cd58ad035bfede3e725` through the source API on
2026-11-13. The fixture README, `tool_result_images.json`, and section 4.5 of
`docs/design/relay-slice2-direct-tools.md` agree: `ToolCallResult.output` is
JSON text; avatar/photo descriptors are in `media[]`, while video descriptors
are in `selected_frames[].file`. Ready photos carry a request-local ref.
Unavailable photos carry `too_large`, `unsupported_type`, `missing` or
`protected` without a ref. Width and height are optional. The fixture copy's
byte count and SHA-256 are recorded beside it in
`src/lib/externalRelay/fixtures/relay_v1/README.md`.

## Model input and limits

`src/lib/externalRelay/toolResultMedia.ts` reads authorized, successful read
projections after each restricted tool round. It retains the original output
and adds `media_notes` for attached files and refusals. It passes refs through
`prepareInboundMedia` with the original request, lease, credential, abort
signal and deadline. That path pins the destination, refuses redirects,
streams under byte limits, checks headers, validates image bytes and decoding,
and checks authorization after awaited work. Tool output supplies no fetch URL.

The request shares `MAX_INPUT_MEDIA_REFS` (10),
`MAX_INPUT_MEDIA_FILE_BYTES` (20 MiB) and `MAX_INPUT_MEDIA_TOTAL_BYTES`
(100 MiB) from `src/lib/externalRelay/mediaInputValidation.ts` with inbound
originals. Only `isInboundImage` JPEG/PNG types are attached. Failed downloads
retain their admission charge; repeated refs reuse the first outcome, and
changed metadata is refused. Files and bookkeeping live only for this request.
The existing service endpoint independently enforces pairing, request, live
lease, current rights and transfer quotas.

`src/lib/externalRelay/runner.ts` combines inbound and returned images for the
next model round: Claude uses `writeInboundAgentInput` with its existing 1 MiB
preview limit; Codex receives the validated local paths. Finalization removes
downloaded image files. The native owner tool bridge and reply prompt are unchanged.

The shared projection producer is `createToolLoop`; audience refusals remove
output before collection. Its existing prompt and conversation serializers
include the optional notes. The owner bridge also consumes this projection
type and receives no new required field. No store schema or action verification
path changes. Open changes in #3985 and #3998 were inspected before editing;
the latter's actual diff concerns runtime launch custody.

## Verification

The fixture tests check wire shape and bytes. Downloader tests cover shared
count and byte limits, deduplication, unavailable refs, expiry, malformed
metadata, content/type refusals, download errors, redirects, cancellation,
authorization revocation, lease loss and cleanup. Runner regressions drive
avatar and frame fixtures through actual child input for both engines, plus
unsupported-type fallback. No performance improvement is claimed.

Checked on 2026-11-13 against main `fbc7d2474b`, using fresh scratch exports
after merging the launch-path successor. This repeated the initial checks
against `6b78dc64d2` with the same results.
Heavy checks ran sequentially through the gate wrapper; each test invocation
had its own HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR.

| Check | Result |
|---|---|
| `bunx tsc --noEmit --incremental false` | Passed on the final source export |
| ESLint on the five changed TypeScript files | Passed |
| `bun run test src/lib/externalRelay/toolResultMedia.test.ts` | 28 passed |
| `bun run test src/lib/externalRelay/runner.test.ts` | 333 passed, 4 live probes skipped, 7 pre-existing failures |
| Six new native runner cases | Avatar, frames and bad-type fallback passed for both engines |
| Avatar cases with the unchanged main runner | Both failed with missing image input |
| Seven failing runner cases on main, two fresh invocations | Same seven failures, with identical snapshot assertion bytes or refusal reasons |

The pre-existing failures are the two X2 arrival-order snapshots, actions OFF,
N1 owner switch OFF, slice 3 dark/ineligible snapshots, and two owner failure
attachment checks (`document_forbidden_path`) under the required scratch
isolation. No snapshot or attachment policy was changed. The project's
publication policy blocks new failures; this comparison found none.
