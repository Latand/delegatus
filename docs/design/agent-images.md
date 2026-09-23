# Show every image an agent looks at

Design for [#2075](https://github.com/Latand/delegatus/issues/2075). Builds on
#1498, which gave tool results ordered image blocks but draws them as a
collapsed chip inside the tool card's disclosure.

## The originating requirement

GitHub issue #2075, opened by the operator on 2026-09-23. The issue is public
and is quoted verbatim (Outcome and Requirements sections):

> ## Outcome
>
> Whenever an agent looks at an image, the operator sees that image in the
> conversation, rendered the same way as the images the operator attaches: an
> inline thumbnail with a tap to open it full screen, whatever engine, engine
> version or tool call the agent used. No "[image output]" text, no hidden
> "Show image" toggle as the default, no raw path or base64 in its place.
>
> ## Requirements
>
> - Research first over real transcripts on this machine (Claude projects,
>   Codex sessions, Copilot session-state) across recent engine versions: every
>   shape in which an agent views or produces an image, how often each occurs,
>   and which engine and version emits it. Count them and name example
>   transcript paths (not committed).
> - One rendering path in the feed for all of them, identical to
>   operator-attached images: thumbnail inline, full-screen viewer on tap,
>   dimensions/size shown quietly, the same during the live turn and after it
>   settles, on phone and desktop.
> - Images referenced by path are served through the existing safe media
>   route; missing files show a clear "image no longer on disk" placeholder.
> - Tests with invented fixtures for each shape; no real transcript content,
>   paths or rasters committed.

The pinned task adds these rules: reuse the component that draws
operator-attached images; serve path-referenced images through the existing
media route with no new unauthenticated file reads, and keep the path fences;
do not add base64 to `/api/files` or the feed payload when the file is already
on disk (reference it instead); en and uk for new text.

## Decision in one paragraph

Every image an agent sees becomes an image block, and a block holds either
inline bytes or a file path. `ImageCard` draws every block as a thumbnail by
default. It is the component that already draws pasted and attached images.
On a tool row, the thumbnails sit under the one-line summary and outside the
`<details>` body, so they show while the line is closed on the phone, and a
row that carries a picture never folds into a collapsed command group. Path
blocks load through `GET /api/artifact`, and a failed load asks the same
route's `mode=meta` why, so the card can say "no longer on disk" or "outside
the folders Delegatus serves". The live overlay draws a live `view_image` /
`Read` / `view` row's path through the same card. A settled code-mode `exec`
row claims those live rows by the paths it viewed. Copilot's picture is joined
from its `session.binary_asset` record. No new route, no new state, and no
bytes are added to any payload.

## Research

### Method

Everything was read-only. A scanner script and its outputs are kept outside the
repository with the example transcript paths (the notes directory under the
lane's `/var/tmp` evidence home). It covered:

- **Claude**: the shared projects store, including subagent transcripts: 1,633
  transcripts, 3.4 GB. The store keeps about five weeks, so its "on disk" count
  equals the window.
- **Codex**: every account's `sessions`, the default `sessions`, and the
  archived and retired rollouts. That is 2,512 rollouts (5.5 GB) in the window
  and 6,738 rollouts on disk that match an image pattern, going back to CLI
  0.46.0.
- **Copilot**: every `session-state/*/events.jsonl` (5 sessions, all 1.0.87
  smoke tests with no image). One isolated observation was added. With
  `COPILOT_HOME` pointed at a scratch directory, Copilot 1.0.87 was asked to
  `view` an invented 48×48 PNG. This settled the persisted shape, because the
  store holds no sample of it.
- **Live overlay**: the runtime journal (`runtime-events.sqlite`), read-only.
  Its rolling window covers the current day. `imageView` items were counted in
  the item and delta events.
- **Today's rendering**: I ran the real parser (`buildFeed`) from an export of
  this branch's HEAD over one invented fixture per shape. The "Today" column
  below comes from that run and from reading the renderers.

"Window" means transcripts modified since 2026-08-20: Claude Code
2.1.220–2.1.280, Codex CLI 0.148.0–0.155.1, Copilot 1.0.87. "On disk" means
every transcript still present.

### Every shape

Counts are images unless marked *calls* or *records*. File:line references are
to this branch's HEAD.

| # | Engine · shape | Versions seen | Window | On disk | Where the bytes live | Today's rendering |
|---|---|---|---|---|---|---|
| 1 | **Claude `Read` of a raster**: `tool_result.content[]` `{type:"image", source:{type:"base64"}}` | 2.1.220–2.1.280 | 3,333 in 368 transcripts | same | Inline base64, **twice** in 3,324 of them: the content block and `toolUseResult.file.base64` | Tool card with image blocks (`parse.ts:2946-2951` → `toolOutputFromBlocks` `parse.ts:723`). Drawn as a **chip** ("W×H · KB show") in the card body (`ToolCard.tsx:229`). The body is closed on the phone (`ToolCard.tsx:335`), and two adjacent Reads fold into a collapsed command group (`parse.ts:995`, `parse.ts:3372`). Up to three taps to see the picture. |
| 2 | **Claude `Read` of PDF pages**: the text result "PDF pages extracted", then a separate `isMeta` user record of image blocks | 2.1.233 | 18 in 2 | same | Inline base64 in the meta record. The rendered pages are also in `toolUseResult.file.outputDir` | Standalone thumbnails (`parse.ts:2937` → `pushImage` `parse.ts:1625` → `FeedItem.tsx:123`). Visible, but detached from the Read row |
| 3 | **Claude MCP or other tool returning an image** (screenshots, browser tools): same `tool_result` image block, often after a text block | — | 0 | 0 | Inline base64 | Same path as #1, verified with a text-plus-image fixture: a chip inside the card |
| 4 | **Codex code mode**: `custom_tool_call` `exec` whose input calls `tools.view_image({path, detail})` then `image(r.image_url)`. The picture is in the later `custom_tool_call_output` | 0.144.0–0.155.1 | 898 *calls* → 1,992 in 254 rollouts | 1,535 *calls* → 3,220 in 468 | Inline `data:` URL in the output record. The call carries only the path literal. One call can loop over paths (up to 8 pictures per output seen) | Exec card, summary "Read x.png" (`parse.ts:1007`). Output through `toolOutput` (`parse.ts:2886`). Same **chip** as #1 |
| 5 | **Codex `exec` output images without `view_image`**: `image()` of a screenshot or a generated file; `js_repl`; the `wait` continuation, where a yielded exec's picture lands in a later output item | exec 0.144.0–0.155.1; js_repl 0.114.0; wait 0.144.5–0.147.0 | 107 in 4 | 254 in 23 | Inline `data:` URL | Same as #4 (`parse.ts:2869`, `parse.ts:2886`) |
| 6 | **Codex direct `view_image`**: `function_call` + `function_call_output` `[{type:"input_image", image_url:"data:…"}]` | 0.46.0–0.146.0 (image output from 0.111.0) | 0 | 962 *calls* → 917 in 154 | Inline `data:` URL | Tool card, **chip** (`parse.ts:2869`). A failed view ("unable to locate image at …", 28 on disk) stays an error line |
| 7 | **Codex `view_image_tool_call` event**: `event_msg {call_id, path}` beside #6 | 0.125.0–0.128.0 | 0 | 126 *records* in 10 | **Path only**. 119 files still exist; 6 are gone under home and 1 is gone under `/tmp`. The bytes are also inline in the paired #6 output | A record card showing the **raw path**, visible even with service rows hidden (`parse.ts:2816` → `FeedItem.tsx:130`) |
| 8 | **Codex MCP screenshot** through `function_call_output` input_image (playwright, chrome-devtools, browser, `screenshot`, an emoji-pack tool) | 0.47.0–0.145.0 | 0 | 370 in 110 | Inline `data:` URL | Tool card, **chip** |
| 9 | **Codex `mcp_tool_call_end`** with `{type:"image", data, mimeType}` in `result.Ok.content` | 0.117.0–0.146.0 | 0 | 106 *records* in 14 | Inline base64, a duplicate of #8's output | Hidden service row for a non-Viewer server (`parse.ts:2790`). Correct as is, because #8 carries the picture |
| 10 | **Codex app-server `imageView` thread item** `{type:"imageView", id, path}` (schema `ImageViewThreadItem`, CLI 0.155.1) | 0.155.1 | journal only: 4 completed, all with ids `exec-<uuid>` (code mode) | 0 in rollouts | **Path only**. All 4 files had already been deleted by the time of the scan | **Live**: a one-line row "view_image <path>" with no picture (`liveTurn.ts:281-283`, `LiveTurnRows.tsx:350`). Its id never matches the canonical exec call id (`liveTurnHandoff.ts:37-41`), so it stays **beside** the settled exec row until the turn settles. **Parsed thread item**: a tool row whose output is the raw path (`parse.ts:2432-2434`) |
| 11 | **Copilot `view` of a raster**: `session.binary_asset {assetId:"sha256:…", type:"image", mimeType, byteLength, data, description}` comes first, then `tool.execution_complete` whose `result.binaryResultsForLlm[]` references the `assetId` **without** data | 1.0.87 | 0 (5 smoke sessions) | 0; 1 isolated probe | Inline base64 in the asset record. The tool args carry the path | "Viewed image file successfully." text only (`parse.ts:3127-3134`). `renderCopilot` has no branch for `session.binary_asset`, so the bytes are dropped (`parse.ts:3107-3143`) |
| 12 | **Codex image generation**: `image_generation_call {result:<base64>, revised_prompt}` + `event_msg image_generation_end {saved_path}`; live `imageGeneration {savedPath}` | 0.122.0–0.147.0 | 0 | 239 calls + 246 ends in ~165 | Inline raw base64 (about 2.4 MB each) plus a saved file | Two record cards and no picture (`parse.ts:2892`, `parse.ts:2816`). Live: an "imagegen" row (`parse.ts:2442`) |
| 13 | **Codex legacy direct view**: `view_image` output text "attached local image path", then the picture as a following `message` input_image from the user role | 0.46.0–0.50.0 | 0 | 17 in 3 | Inline `data:` URL | Drawn as a user-side attachment, attributed to the operator |
| 14 | **Codex user-input `localImage` / `local_images`** (an attachment, not agent viewing) | 0.112.0–0.149.0 | 1 | 541 in 181 | Path (often a `/tmp` clipboard file). Always paired with an inline `input_image` in the `response_item` message | The `user_message` event row keeps the text only (`parse.ts:2747`). The paired message draws the inline picture. A thread-item `localImage` outside the inbox becomes the note "Attachment: localImage" (`parse.ts:675-680`) |
| — | *Baseline: operator paste or attachment* (Claude image block; Codex `input_image` data URL; composer inbox path) | all | 198 Claude, 151 Codex | 1,288 Codex | Inline, or an inbox path through `/api/inbox` | **Thumbnail** with a lightbox on click (`FeedItem.tsx:123` `ImageCard`; `FeedItem.tsx:124` `InboxImageCard`) |

What reaches the live overlay for any engine: a tool row carries only its
name, status and bounded args (`liveTurn.ts:23-37`), and the journal bounds the
overlay to 64 KB of text. No bytes ever reach it. The only picture-bearing live
signal is the path on #10 (and a `Read`'s `file_path`).

### What the numbers say

- **Two shapes carry nearly everything recent**: Claude `Read` (#1, 3,333) and
  Codex code mode (#4 and #5, 2,099). Both already carry the bytes inline and
  are one component default away from the requirement. They hide behind three
  layers: a chip, a closed disclosure on the phone, and command-group folding.
- **Path-only shapes are rare and short-lived.** #7 is old. #10 is new, live,
  and its files are often deleted within minutes (all 4 in the journal window).
  That is exactly the case the "no longer on disk" placeholder covers.
- **Copilot** records its pictures in a way the parser has never read (#11).
  Nothing is lost on disk, because the bytes sit in `session.binary_asset`.
- **Image generation** (#12) and the legacy injected view (#13) have not
  appeared in five weeks.

## Design

### 1. One image block, two sources

`ToolOutputBlock`'s image variant (`parse.ts:48`) and the feed `image` item
(`parse.ts:283`) take one source, exactly one of:

- `data` + `media`: inline base64 already in the transcript line the client
  has, unchanged from today;
- `path`: an absolute (or `~/`) path with a raster extension in the inbox
  policy's set (png, jpg/jpeg, gif, webp; never SVG).

`w`, `h` and `bytes` stay optional. When the transcript has both inline bytes
and a path (Claude Read, code mode), **inline wins**. The file may have changed
or gone since, and inline is what the agent saw. The Claude parser keeps
ignoring `toolUseResult.file.base64` when the content block carries the same
bytes, so nothing gets doubled.

### 2. One component: `ImageCard`

`ImageCard` (`src/components/feed/cards/ImageCard.tsx`) already draws pasted
and attached images and #1498's tool pictures. It becomes the only image
renderer in the feed and the live overlay:

- **Default view is the thumbnail everywhere.** The `initialView="chip"` call
  goes away. The chip stays only as the state "Collapse" leaves behind, which is
  the operator's choice, and the default is no longer a hidden toggle.
- **The source is `data` or `path`.** A data source builds the `data:` URI as
  today. A path source uses `artifactContentUrl(path)`
  (`src/components/preview/artifactResource.ts:26`) with `loading="lazy"` and
  `decoding="async"`.
- **A quiet caption** `W×H · N KB` sits beside the existing "Collapse" control
  in the muted caption style. Dimensions come from the props, or from
  `naturalWidth`/`naturalHeight` once the image loads (code-mode and path images
  arrive without them). The size comes from `bytes` or the base64 length. A path
  source shows dimensions only, because an `<img>` cannot read the length and
  an extra request only to learn a byte count is not worth it.
- **Tap or click opens the existing `Lightbox`**, unchanged.
- **Failure placeholder (path source).** On `onError`, the card makes one
  `fetch(artifactMetaUrl(path))` and maps its typed code to a pill styled like
  `InboxImageCard`'s gone state: the file's basename, then the reason, with the
  full path only in `title`:
  - `not-found` → "image no longer on disk";
  - `access-denied` → "image outside the folders Delegatus serves";
  - anything else → "image can't be shown".

  An inline block whose data fails the policy keeps today's degradation (a text
  line), which #1498 required.

New strings (en / uk):

| Key | en | uk |
|---|---|---|
| `render.imageGone` | image no longer on disk | зображення вже немає на диску |
| `render.imageOutsideRoots` | image outside the folders Delegatus serves | зображення поза теками, які показує Delegatus |
| `render.imageUnavailable` | image can't be shown | зображення не вдається показати |

`render.imageOutput` stays only in the flattened preview used for copy, speech
and failure detail. It never renders as a row.

### 3. Where a tool's pictures sit

**Options:**

- **A. Force the tool card open and draw thumbnails in its body.** This
  contradicts mobile v2 (#1439: a tool line on the phone is one closed line
  until tapped). It still loses to command-group folding.
- **B. Push the pictures as sibling `image` rows after the tool row.** This is
  what Claude did before #1498. The picture becomes detached from its call, the
  live-row claim has no identity to key on, and it reverses #1498's decision.
- **C. Draw thumbnails on the tool line itself, under the summary and outside
  the `<details>` body.** (Chosen.)

With C, `ToolLine` (`ToolCard.tsx:310`) renders the event's image blocks in a
wrapping row directly under its `<summary>`, aligned with the summary text,
whether the line is open or closed, on desktop, on the phone and in
collapsed-tools mode. The body's `ToolOutputBlocks` then renders only the text
blocks, so no picture is drawn twice. `foldableTool` (`parse.ts:995`) returns
false for an event that carries an image block, so a picture never hides
inside a folded command group. Its neighbours still fold around it.

A capture run can put dozens of thumbnails into a transcript. The feed already
bounds the DOM with its render window (`LogFeed.tsx:394`, `LogFeed.tsx:686`),
and off-screen rows skip layout and paint through `content-visibility`, so no
extra lazy-decode layer is added.

### 4. Parser changes, shape by shape

| # | Change |
|---|---|
| 1, 3, 4, 5, 6, 8 | None in the parser. They already yield inline image blocks, and §2 and §3 make them visible. |
| 7 | `view_image_tool_call` stops producing a record card. It records `path` on the call with that `call_id` (whichever of the event and the output arrives first). The line draws the inline block when the output had one, and a path block otherwise. |
| 10 (parsed) | `renderCodexThreadItem`'s `imageview` branch (`parse.ts:2432`) emits the tool row with a path image block, and no raw path as output text. |
| 10 (live) | `LiveToolRow` draws a path `ImageCard` under the line when the row is `view_image`, `Read` or `view` and its `path`/`file_path` has a raster extension. The same condition covers Claude's live `Read` for the moment before its echo lands. The parser records `viewedPaths` on a code-mode exec event from the literal `tools.view_image({path})` arguments that orchestration parsing already extracts (`parse.ts:1249`). `canonicalAssistantItems` (`liveTurnHandoff.ts:140`) lets such a row claim live `view_image` rows whose path matches. Direct `view_image` calls are still claimed by id. |
| 11 | `renderCopilot` keeps a bounded map of recent `session.binary_asset` records (type image, a policy mime, within `MAX_INBOX_IMAGE_BYTES`, oldest evicted past 32). On `tool.execution_complete`, each `binaryResultsForLlm` image becomes an inline block from the map. If its asset fell outside the loaded window, it becomes a path block from the call's `path` arg instead. The blocks pass to `addOutput` like Codex's. |
| 14 | A thread-item `localImage` outside the inbox becomes a path `image` item, and the "Attachment: localImage" note goes away (`parse.ts:675-680`). Rollout `local_images` stay as they are, because the paired inline message already draws them. |
| 2, 9, 12, 13 | Unchanged. #2 already draws thumbnails; #9 is a duplicate. #12 and #13 are deferred. |

### 5. Live turn and settled turn look the same

Both states draw one `ImageCard` thumbnail under a one-line tool summary.
While the turn runs, a path-bearing live row loads the file through the
route. When the canonical row lands, it claims the live row by id (a direct
call or a Claude Read) or by viewed path (code mode), and draws the same
picture from the inline bytes. The size, position, caption and lightbox do not
change. If the file is deleted between the two, the live row shows the
placeholder and the settled row shows the picture, because the bytes the agent
saw are in the transcript.

### 6. Payloads

- `/api/files`: untouched.
- Feed payload: inline shapes are already in the transcript lines the tail
  sends. The parser adds no bytes, and a Read's second base64 copy stays
  ignored.
- Path shapes: the only transfer is the `<img>`'s own lazy request to
  `/api/artifact`. Nothing is read or inlined on the server for the feed, the
  live overlay or `/api/files`.

## Media route and security

**Route: `GET /api/artifact?path=…`** (and `mode=meta` for the failure reason).
This is the existing single-file route behind the document preview (#875), and
it already classifies png/jpeg/gif/webp as images. It was chosen over
`/api/image` for these reasons:

- it opens with `O_NOFOLLOW` against the realpath and reads everything through
  one pinned descriptor, while `/api/image` does a `readFile`;
- it enforces a byte bound (64 MB by default), while `/api/image` reads any
  size;
- it checks that the file's content matches its extension;
- it answers with a **typed failure code** (`not-found`, `access-denied`, …),
  which the placeholder needs to tell "gone" from "fenced". `/api/image`
  returns untyped JSON errors;
- it serves `nosniff` and a sandbox CSP.

`/api/image` stays as the markdown image route. `/api/inbox` serves inbox names
only.

**Fences, unchanged:**

- `rejectCrossOrigin` on the request;
- the `LLV_TOKEN` cookie gate in `src/proxy.ts`. Only the report-frame prefix is
  exempt, and this design does not use it;
- lexical, then realpath, containment under `$HOME`.

There is no new route, no new root and no new unauthenticated read. The client
builds path sources only for raster extensions, so SVG never reaches an
`<img>` from this path.

**What the fence costs:** a picture outside `$HOME`, such as a `/tmp`
clipboard file or a `/var/tmp` capture, is refused with `access-denied`. It
shows the "outside the folders Delegatus serves" pill with its basename, never
a raw path in the row. On disk this affects 1 of 126 #7 events, plus #14 files
that already have inline copies. Widening the roots is a security decision the
spec excludes, so it is deferred below.

**Privacy of the rendered row:** the pill shows a basename. The full path
lives only in the `title` tooltip, as `InboxImageCard` already does. Nothing
here is published.

## Test plan

Every fixture is invented. Rasters are built in the test from a few literal
bytes (a 1×1 PNG), and no image file is committed, since the publication gate
flags committed rasters. Paths are invented (`/w/shot.png`, `~/w/shot.png`).
Ids are short placeholders, not UUIDs. Tests run by path only, never as a
directory sweep.

| Shape | Fixture (invented) | Assertion |
|---|---|---|
| 1 Claude Read | a `Read` tool_use; a tool_result with one image block; a `toolUseResult.file` with dimensions and the duplicate base64 | parse: one tool event, one inline block with w/h/bytes, no standalone image item. DOM: a thumbnail `<img>` under the closed line at phone width; no "show" chip; caption `1×1 · 0 KB`; tap opens the lightbox |
| 1 ×2 adjacent | two Reads with images in one assistant turn | parse: two tool rows and no `cmd-group` |
| 2 Claude PDF pages | a Read of `/w/doc.pdf` with pages; a text result; an `isMeta` record with two image blocks | two thumbnails (regression guard: unchanged) |
| 3 Claude MCP | `mcp__browser__take_screenshot`; result `[text, image]` | text in the body; a thumbnail on the line, in order |
| 4 Codex exec + view_image | `custom_tool_call` exec with `tools.view_image({path:"/w/shot.png"})` + `image(r.image_url)`; output `[input_text, input_image data URL]` | thumbnail on the exec line; `viewedPaths` = [`/w/shot.png`] |
| 4 multi | an exec whose output carries three input_images | three thumbnails, wrapping, none clipped at 390 px |
| 5 wait | an exec that yields, then a `wait` output carrying input_image | thumbnail on the `wait` row |
| 6 Codex view_image | `function_call view_image` + output `[input_image]` | thumbnail; the failure output "unable to locate image at …" stays an error line |
| 7 view_image_tool_call | the event before the output, and after it (two orders) | no record card; one thumbnail from the inline output. With no inline output, a path thumbnail whose `src` is `/api/artifact?path=…` |
| 8 Codex MCP screenshot | playwright `function_call_output [input_text, input_image]` | as 3 |
| 9 mcp_tool_call_end | a non-Viewer server with an image result | still a hidden service row |
| 10 imageView parsed | `event_msg item_completed {item:{type:"imageView", id:"exec-1", path:"/w/shot.png"}}` | a tool row with a path thumbnail and no raw path text |
| 10 imageView live | a live item `{name:"view_image", args:{path}}` and a canonical exec row with `viewedPaths` containing it | while unclaimed: a thumbnail under the live line. Once the exec lands: the live row is claimed, and exactly one thumbnail remains |
| 10 Claude live Read | a live `Read` row with a png `file_path` | a path thumbnail; once the canonical row lands, one thumbnail from inline data |
| 11 Copilot | `tool.execution_start view {path}`; `session.binary_asset {assetId:"sha256:ab", …, data}`; `tool.execution_complete` with `binaryResultsForLlm [{assetId:"sha256:ab"}]` | an inline thumbnail on the Read row. The same log with the asset line cut from the window gives a path thumbnail |
| 14 localImage | a thread-item userMessage `[text, {type:"localImage", path:"/w/shot.png"}]` | a path thumbnail, no "Attachment: localImage" note |
| Missing file | a path block; `<img>` error; meta stubbed to `404 {code:"not-found"}` / `403 {code:"access-denied"}` / `415` | the pill reads `render.imageGone` / `render.imageOutsideRoots` / `render.imageUnavailable`, in en and uk; no raw path in the text |
| Baseline | pasted Claude image; Codex `input_image`; composer inbox path | unchanged thumbnails (regression guard) |

Where they live: shape cases in `src/components/feed/parse.test.ts` and
`src/components/feed/copilot.parse.test.ts`; the card in
`src/components/feed/cards/ToolCard.imageOutput.dom.test.tsx`, whose chip
expectations flip to thumbnails; the live cases in
`src/components/conversation/liveTurnToolRows.dom.test.tsx` and
`liveTurnHandoff.test.ts`; the placeholder in a DOM test beside `ImageCard`;
the keys in the existing i18n completeness test.

**Rendered evidence** goes through the existing conversation-window driver,
`src/components/conversation/conversationWindow.browser.test.tsx`, as one more
`describe` block over an `agent-images` case of
`conversationWindowEvidence.fixture.tsx`. The case renders one conversation per
engine (shapes 1, 3, 4, 10 with a served file and a gone one, 11) and a live
`view_image` row through the production parser and feed rows. Its rasters are
drawn on a canvas at load time, and the driver answers `/api/artifact` from a
PNG it encodes in place, so no raster is committed. Frames: 390×844 in both
colour schemes, 430×932 and 1280×800, in en and uk.

Before and after frames stay local under `/var/tmp/agent-images/`. The gates
the driver asserts are: no sideways overflow, every image control at least
44 px on the phone, every thumbnail drawn and outside a closed disclosure, no
"show" chip and no "[image output]" text, no folded command group, the gone
file as a pill naming it, and the viewer opening on tap.

**Gates:**

- `bunx tsc --noEmit --incremental false`, logged to a file with its exit code
  checked;
- the touched tests, by path;
- `bun run build` under an isolated config root (`LLV_STATE_DIR` in a temp
  directory);
- `bun scripts/privacy-publication-gate.ts --base <merge-base>`.

## Deferred — not currently justified

- **Codex image generation (#12)**: 0 in the window; last seen at CLI 0.147.0.
  The agent produced the image rather than looked at one. If it returns,
  `image_generation_call.result` maps onto an inline block and `saved_path` onto
  a path block through the same card, at one parser branch.
- **Legacy injected view (#13)**: 17 on disk, CLI 0.46–0.50 only. Re-attributing
  the following user-role image to the preceding `view_image` call needs a
  lookahead rule for a shape no current engine writes.
- **Attaching Claude PDF page images (#2) to their Read row**: they already
  render as thumbnails. Moving them saves no taps.
- **Serving pictures outside `$HOME`**: this would widen a security fence the
  spec keeps.
- **Folding `InboxImageCard` into `ImageCard`**: the inbox card's delete control
  is inbox-specific. Both already draw the same thumbnail and lightbox.
- **Byte size for path-sourced pictures**: would need a meta request per
  thumbnail.
- **Moving markdown images from `/api/image` to `/api/artifact`**: a separate
  hardening with no bearing on this requirement.

## Validation against the requirement

- *"Whenever an agent looks at an image … whatever engine, engine version or
  tool call"*: every viewing shape in the table (1, 3–8, 10, 11) ends in an
  `ImageCard` thumbnail. Shape 2 already does. Shape 9 is a duplicate of 8.
  Shapes 12 and 13 are absent from current engines and are deferred with their
  counts.
- *"No '[image output]' text, no hidden 'Show image' toggle as the default, no
  raw path or base64 in its place"*: the chip default and the closed-body and
  folded-group layers go (§2, §3); the raw-path rows for 7 and 10 go (§4); the
  placeholder string stays only in the copy and speech text.
- *"Thumbnail inline, full-screen viewer on tap, dimensions/size shown
  quietly"*: §2.
- *"The same during the live turn and after it settles"*: §5.
- *"On phone and desktop"*: §3 puts thumbnails outside the phone's closed
  disclosure. The evidence covers both.
- *"Served through the existing safe media route; missing files show a clear
  'image no longer on disk' placeholder"*: the media route section and the §2
  placeholder.
- *"Tests with invented fixtures for each shape"*: the test plan table.
