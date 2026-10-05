# Frame sets: show an agent's prototypes and screenshots from the conversation

Design only. Nothing in this lane ships. It delivers this note, four working
prototypes with their numbers printed above the pane, the measurements under
`evidence/frame-sets/`, and a recommendation. The operator answers with a
number and a build lane follows.

## The originating requirement

The operator, 2026-10-05, in the orchestrator seat's chat, as one item of a
longer message (verbatim, typos kept):

> до речі треба нам якийьсь презентер прототипів в оркестратор вбудувати і в
> делегатус щоб можнак було ось десь ти мені дав кнопокчку і воно розгорталося
> і показувало фотки, коллаж, яий агент залпишив, продумать треба теж дизайн.

In English: "by the way, we need some kind of prototype presenter built into
the orchestrator and into Delegatus, so that somewhere you give me a button and
it expands and shows the photos, the collage the agent left; the design needs
thinking through too."

The pinned task adds the constraints this note is checked against: reuse comes
first; nothing new lies on top of existing controls or text while closed; one
entry point; extra chrome kept to the minimum that does the job; desktop 1440,
a 440 px board pane and the phone at 390, in English and Ukrainian; keyboard
and swipe; a chosen variant lands in the message field as an editable reply.

## The answer in one paragraph

An agent publishes a set with one new Delegatus tool, `publish_frames`. The
server copies the frames into the installation's state directory, so the set
outlives the worktree. The tool call is already a row in the conversation, and
that row becomes the one entry point: one line with the set's title and its
counts. Four ways to open it were prototyped. The recommendation is **variant
4**: the row expands in place into a collage grouped by variant, a tile opens
the image viewer the feed already has, and each variant has its own "Choose"
button that writes the reply into the message field. It costs 2 presses to any
frame and 2 presses to a chosen variant, and it adds no new full-screen surface.

## 1. What exists today

| What | Where | What it gives a frame set |
|---|---|---|
| Every picture in the feed is one card: a thumbnail, a tap opens the viewer | `src/components/feed/cards/ImageCard.tsx:71` | The thumbnail and the "file is gone" pill |
| The full-screen viewer: zoom, pan, ←/→ and edge buttons through a list of pictures, a counter, a caption | `src/components/feed/Lightbox.tsx:73`, keys at `:118`, edge buttons at `:264` | The whole zoom surface. It has no swipe: its stage is `touch-none` and a drag pans (`:221`) |
| The list the viewer steps through, built from the conversation's own records | `src/components/feed/imageGallery.ts:67`, provided at `src/components/LogFeed.tsx:1765` | A viewer opened from a set can be handed the set's frames the same way (`ImageGalleryProvider`) |
| A run of image-only markdown lines in an agent's message draws as a wrapping row of thumbnails | `src/components/feed/markdown.tsx:269`, each at most 240 px tall (`:223`) | A contact sheet that works today with no build, see the next section |
| Local images are served by path under the home directory and the evidence roots (`/var/tmp`), with a realpath check and a byte sniff | `src/app/api/image/route.ts:33`, `src/app/api/artifact/route.ts:88`, roots at `src/lib/artifact/localFile.ts:39` | The fence a published path is read through |
| The operator's attachments are stored in the inbox directory and served by name | `src/components/feed/InboxImage.tsx:22`, `src/app/api/inbox/route.ts:19` | The precedent for bytes kept by the installation and named without a path |
| A task's album: every picture its agents looked at, grouped by stage, behind one button on the card | `src/components/taskAlbum/AlbumButton.tsx:24` (card), `:59` (phone), `src/components/taskAlbum/TaskAlbum.tsx:85`, bytes at `src/app/api/tasks/[id]/album/image/route.ts:21` | The precedent for a route that can name only a picture an index already holds |
| Reply drafts under the orchestrator's message: a pill writes its text into the message field | `src/components/feed/SuggestedReplies.tsx:227`, the write at `:344`, the seam at `src/components/TmuxComposer.tsx:1489` | The "choose" action. The prototypes call the same function |
| A Delegatus tool call is a feed row with its own card | parsed at `src/components/feed/parse.ts:552` and `:3063`, drawn at `src/components/feed/FeedItem.tsx:317` by `src/components/runtime/McpCallCard.tsx:131` | The entry point, with no new place in the pane |
| Telegram photos: one photo or an album of 2 to 10, read from the operator's document roots | `src/lib/telegram/bot/service.ts:916`, the limit at `:952`; a file in the state directory is refused at `src/lib/telegram/bot/documents.ts:348` | The outward path, see section 6 |
| Evidence directories: committed measurements as JSON; rasters stay in `.artifacts/` (ignored) or under `/var/tmp` | `evidence/`, `.gitignore:81`, `scripts/capture-directory.ts:48` | Why frames are never committed: the publication gate admits a raster only when an in-repo generator reproduces it |

## Should this be built at all

The default answer is no, so here is what the operator gets with no build.
An agent can write image-only markdown lines that point at files under
`/var/tmp`, and the feed draws them as a row of thumbnails that open the
viewer. The orchestrator can add `suggest_replies` pills "Variant 1" to
"Variant 4". Both work at this commit.

That path stops in four places, and each one is in the request:

- There is no closed state. Twenty-four thumbnails at up to 240 px each fill
  several screens of the message. The operator asked for a button that expands.
- The pictures die with their files. A lane's `.artifacts/` goes with its
  worktree, and a stage's scratch directory
  (`src/lib/runtime/structuredSpawn.ts:179`) goes when the stage settles.
- There are no variants: no grouping, no number beside a frame, no way to say
  which frame is which width and language.
- The pills retire the moment the operator sends anything
  (`src/lib/suggestions/types.ts:33`), and they sit apart from the pictures.

So a small build is justified: one tool, one store, one card in an existing
row. The viewer, the serving fence and the reply seam are reused as they are.

## 2. How an agent publishes a set

### The call

A new tool on the Delegatus MCP server, `publish_frames`. It has two forms.

Create a set, called by the agent that has the files:

```json
{
  "title": "Step between my own messages",
  "variants": [{ "number": 1, "title": "In the header" }],
  "frames": [
    { "path": "/var/tmp/lane/1-desktop-1440-en.png", "variant": 1,
      "caption": "at rest", "width": 1440, "lang": "en" }
  ],
  "clientRequestId": "…"
}
```

Show an existing set, called by the orchestrator in its own conversation:

```json
{ "setId": "fs_…", "clientRequestId": "…" }
```

Both answer with the set's id, its title and two counts. The answer carries no
bytes and no paths. The second form copies nothing: it only puts a row for the
same set into the caller's conversation, which is how a set a lane published
reaches the orchestrator's chat.

It is a new tool because the two nearest ones have the wrong lifetime.
`suggest_replies` is over when the operator answers, and a set must stay
readable afterwards. `telegram_bot_send_media` sends outward.

### What a set is

The shape is in `src/components/conversation/frameSets.prototype.model.ts`
(`FrameSet`, `Frame`, `FrameSetInput`), with the refusal rules in
`frameSetInputDefects` and a test beside it.

- **title**, up to 120 characters.
- **variants**, up to 9, each a number from 1 to 9 and a title. The number is
  the one printed on the frames and typed back by the operator. A set with no
  variants is a plain album of screenshots.
- **frames**, in the agent's order, each with an optional variant number, a
  caption up to 200 characters, the viewport width it was taken at and the
  interface language in it. Width and language are what a side-by-side compare
  pairs frames by.
- **source**, written by the server from the calling conversation: the
  conversation, its pipeline and stage when it is a stage, and the worktree's
  commit at the moment of the call. A caller cannot supply it, which is the
  rule `stage_report` follows for provenance.

### Where the files live and for how long

- `<state>/frame-sets/<setId>/manifest.json` holds the record.
- `<state>/frame-sets/blobs/<sha256>.<ext>` holds the bytes, named by their
  hash. A frame published twice, or a set shown in two conversations, is stored
  once.
- The write happens in the Viewer process, reached through the control call
  the other mutating tools use (`src/lib/mcp/bindings.ts:6603` is the pattern).
  The MCP server process itself writes nothing into the state directory.
- A published path is read through the fence the image route already applies:
  under the home directory or an evidence root, realpath checked, PNG, JPEG or
  WebP only, and the bytes must agree with the extension.

Bounds, each refused with the bound named in the error:

| Bound | Value | Why |
|---|---|---|
| Frames per set | 60 | The largest real set so far had "dozens"; past 60 a collage stops being a glance |
| Variants per set | 9 | One digit, so a key press and a printed number are the same thing |
| One frame | 4 MB | The 102 captures of this lane average 62 KB and the largest is 107 KB; 4 MB leaves room for a long full-page capture at double density |
| One set | 48 MB | 60 frames at the typical size, with headroom |
| The whole store | 2 GB and 200 sets | Past either, the oldest sets that are not kept go first |

Lifetime: a set is kept while the task its source lane is bound to is open,
and for 30 days after that task closes. A set with no task is kept for 30 days
after it was last opened. Removal deletes the manifest and every blob no other
set names.

After the worktree is removed nothing changes for the operator: the set holds
its own copies, and the manifest still names the lane and the commit. After the
set itself is removed, its row stays in the transcript and says the frames are
no longer kept, the way `ImageCard` says a file is gone from disk.

### Privacy

Frames stay inside the installation. They are served only by the
installation's own origin, behind the same-origin gate the image routes use.
Nothing is uploaded and nothing is committed, so the publication gate is
untouched. The transcript carries only the set's id, title and counts. Two
reads serve a set:

- `GET /api/frame-sets/<setId>` answers the manifest.
- `GET /api/frame-sets/<setId>/<sha256>` answers one frame, and can name only a
  frame that manifest lists, like the album's image route.

An id-based route is chosen over `/api/artifact?path=` so that no path inside
the state directory reaches the browser.

One thing I did not read: what a linked installation syncs. The build lane
must keep `frame-sets/` out of it.

### How the set reaches the conversation

The call is a record in the caller's transcript. The parser already turns a
Delegatus tool call into a feed row, and `McpCallCard` already draws that row.
The build adds one presentation there for `publish_frames`. There is no new
store keyed by conversation, no polling and no second place in the pane. Today
the row reads "MCP · VIEWER Running MCP tool: publish_frames"; that is the
`0` frame in the prototypes.

## 3. Where the operator opens it: four variants

All four share the closed state: one row in the feed, where the tool call's
row already is, with an icon, the set's title, "4 variants · 24 frames" and a
chevron. They differ in what the row opens.

| № | What opens | Where |
|---|---|---|
| **1** | The row expands in place: variant tabs, one large frame, a filmstrip, "Choose N". A tap on the frame opens the feed's viewer | In the feed |
| **2** | A full-screen viewer with variant tabs on top, the frame, a filmstrip below and "Choose N" | Over the window, as the image viewer is |
| **3** | Two variants side by side at the same width and language, each with its own tabs and "Choose N", one strip of widths and languages for both | Over the window; stacked on the phone |
| **4** | The row expands in place into a collage: one section per variant with its number, title, "Choose N" and its frames as tiles. A tile opens the feed's viewer on that frame | In the feed, then the existing viewer |

Common to all four:

- **Keys.** ←/→ step frames (in 3, the shared width and language). In 1 and 2
  a digit picks a variant. Esc closes a full-screen surface. A text field keeps
  its own keys.
- **Swipe.** A sideways swipe over the frame steps it. The feed's viewer has
  no swipe today, so the prototypes add it while that viewer is open by
  pressing its own edge buttons. In the build this is a small change inside
  `Lightbox`: a sideways touch on an unzoomed picture steps. Every picture in
  the product gains it.
- **Choosing.** "Choose N" writes "Variant N (title)." into the message field
  through `appendComposerDraft`, the function a suggested reply uses. The field
  takes focus. Nothing is sent. A full-screen surface closes when it has
  written the reply, so the field is visible.

### How the prototypes are built and run

`src/components/conversation/frameSets.prototype.tsx` mounts the production
pane (`BranchPane`; on the phone inside `MobileShell`) over a Codex transcript
of an orchestrator's morning that ends with the tool call. Only the
conversation evidence fixture imports it
(`?case=frame-sets&variant=0|1|2|3|4&lang=en|uk&pane=440`). No product file
changed. The entry is drawn inside the tool call's own feed row, which is the
place the build's card takes.

The fixture set is synthetic: four variants at three widths in two languages,
24 frames, each drawn on a canvas when the page loads with its variant number
printed in the corner. No real lane's frames are used, because no in-repo
driver at this commit regenerates one.

```
LLV_CONVERSATION_BROWSER_TEST=1 CHROME_BIN=<chromium> \
  bun test src/components/conversation/conversationWindow.browser.test.tsx -t "frame sets"
```

Frames go to `LLV_FRAME_SETS_OUT` (default `.artifacts/frame-sets/`, not
committed): per variant, width and language, the moments `closed`, `open`,
`frame` and `chosen`. The run takes a little over two minutes.

## 4. Proof that nothing is covered

The block "frame sets, design variants" in the conversation-window driver
measures 24 panes: four variants at desktop 1440 × 900, a 440 px pane in a
1000 × 800 window and the phone at 390 × 844 with a touch pointer, in English
and Ukrainian. Each is compared with the same pane at `variant=0`, which is
the pane without the feature. The record is
`evidence/frame-sets/measurements.json`.

**Closed.** For every one of the 24 panes:

- the entry is the only new control on screen;
- a pointer at its centre and at its four corners meets the entry itself;
- its box intersects no other interactive element and no other feed row;
- every probe outside the feed is where it was without the feature: the
  header, the title, the feed's box, the message field, and every button of
  the header, the tools row and the composer (`changedAgainstNoFeature` is
  empty in all 24);
- the page does not scroll sideways;
- on the phone the entry is 328 × 44 px.

**Open in place (1 and 4).** Every control of the panel passes the same
hit-test and intersection checks, and the row that was pressed is still on
screen. Two things differ from the pane without the feature, both the feed's
own behaviour after any scroll up: the feed is off its tail, so its way-back
row appears and the feed's box is 44 px shorter. Nothing outside the feed
moves.

**Open full screen (2 and 3).** The surface covers the window while it is
open, by design, on the layer the image viewer uses. Its own controls pass the
hit-test and intersection checks and stay inside the window, and on the phone
each is at least 44 × 44 px. After a choice the surface is gone and the field
is visible.

**The walk.** In every pane the driver goes to variant 3's fifth frame and
reads which frame is shown, steps one back and one forward (by arrow keys on
the desktop, by a touch swipe on the phone), then reloads, chooses variant 3
from the closed row, reads the reply out of the message field, types more
after it and confirms the feed still holds three own messages, so nothing was
sent. All 24 pass.

## 5. The price of each variant

Measured; "presses" are the ones the driver actually made.

| | 1 in place | 2 full screen | 3 side by side | 4 collage |
|---|---|---|---|---|
| Closed row, desktop | 40 px | 40 px | 40 px | 40 px |
| Closed row, phone | 44 px | 44 px | 44 px | 44 px |
| The tool row it replaces | 30 px desktop, 44 px phone | same | same | same |
| Open, desktop 1440 | 509 px of the feed | the window | the window | 536 px of the feed |
| Open, 440 px pane | 374 px of the feed | the window | the window | 896 px of the feed |
| Open, phone 390 | 354 px of the feed | the window | the window | 944 px of the feed |
| Controls on screen when open | 13 (12 on the phone) | 13 | 17 (14 on the phone) | 29 desktop, 15 in the pane, 19 on the phone |
| Largest a frame is drawn before a zoom | the pane's width, 380 px tall at most | the window | half the window; on the phone half its height | a tile, 84 px tall |
| Presses to variant 3's fifth frame | 3 | 3 | 3 | 2 |
| Presses to choose variant 3 | 3 | 3 | 3 | 2 |
| Presses to choose variant 1 | 2 | 2 | 2 | 2 |
| Feed leaves its tail when opened | yes | no | no | yes |
| New surface to build | a panel with tabs and a filmstrip | a second viewer, or tabs, a filmstrip and a button added to `Lightbox` | a compare surface with two tab rows | a card with tiles; the viewer as it is, plus swipe |

Reading the frames as pictures (I looked at the captures at all three widths
in both languages):

- **1** shows a desktop frame at the pane's width. In a 440 px pane a
  1440 px screenshot is 362 px wide, which is too small to judge, so the
  operator taps again to zoom. The panel then mostly serves as a way into the
  viewer.
- **2** shows the frame as large as the window allows and keeps the tabs and
  the choice beside it. It is the most comfortable for reading one variant
  through. It is also a second viewer next to the one the feed has.
- **3** answers "which of these two" directly on the desktop. On the phone the
  two frames stack and a phone frame is about 145 px wide, which is hard to
  read.
- **4** shows the whole set at once, which is what "collage" asks for, and it
  is the only one that reaches any frame in 2 presses. In a narrow pane it is
  two screens tall, so the last variant's button is a scroll away.

### Recommendation: variant 4

It matches the words of the request most closely: a button, it expands, it
shows the collage the agent left. It is the cheapest on every count that was
measured, and it adds the least: one card in an existing row and one gesture
in the existing viewer. It builds no second full-screen surface, which is the
kind of addition the operator has turned down before.

What it gives up, plainly:

- No side-by-side view. Two variants are compared by stepping between two
  frames in the viewer.
- It is tall in a narrow pane (896 px in a 440 px pane, 944 px on the phone).
  The build should open with one row of tiles per variant on narrow widths and
  the rest behind the variant's own row; that change is small and stays inside
  the card.
- The choice is made from the collage. From inside the viewer it is one more
  press: close, then "Choose N".

If the operator reads variants one at a time far more often than he scans a
set, variant 2 is the second choice, built as an extension of `Lightbox`
(tabs, filmstrip, one button) and opened from the same row.

## 6. The phone and the Telegram report

**The phone** draws the same conversation with the same feed component, so the
same row and the same card appear there with no extra work. The prototypes run
inside the phone shell at 390 px with a touch pointer; every control is at
least 44 px, and the swipe is measured there. The bytes come from the same two
routes. Nothing is stored twice.

**Telegram.** `telegram_bot_send_media` gains one alternative to a list of
paths: `frameSet: { setId, frames?: number[] }`. The server reads the frames
from the store itself. That matters because the path form refuses any file in
the state directory (`src/lib/telegram/bot/documents.ts:348`), and copying
frames into a document root would be the duplicate storage this design avoids.
With no `frames` given, the album is the first frame of each variant, captioned
"N · title", which fits Telegram's limit of 10 photos for up to 9 variants
(`coverFrames` in the model). The report's text says where to open the full
set.

Sending to Telegram is an upload to Telegram, and it stays what it is today:
an explicit call by an agent, to a chat the operator bound, under the bot's
existing rules. Publishing a set never sends anything anywhere by itself.

## What the build lane does

1. `publish_frames` in the MCP server and its Viewer-side write: the store, the
   bounds, the two read routes, removal by lifetime. The model file's types and
   refusal rules move to `src/lib/frameSets/`.
2. A presentation for the tool in `McpCallCard`: the closed row and the chosen
   variant's panel, in English and Ukrainian.
3. Swipe in `Lightbox` for an unzoomed picture.
4. `frameSet` in `telegram_bot_send_media`.
5. One paragraph in the agent prompt contract: a design or UI lane publishes
   its frames with `publish_frames` and the orchestrator shows the set with the
   id.
6. The prototype files are deleted. The driver block stays and is pointed at
   the real card, with the same closed-state measurements.

## Deferred — not currently justified

- **Side-by-side compare (variant 3)** as a second surface. Kept as a
  prototype; build it when the operator asks to see two at once.
- **Tabs and a filmstrip inside the viewer (variant 2).** The second choice
  above.
- **A server-made collage image** for Telegram (one picture of all covers).
  The album of covers needs no image composition.
- **Frame sets in the task album.** The album indexes transcripts for
  pictures; a published set could appear there as its own group. The
  conversation row is the one entry point for now.
- **Pinning a set** so it is never removed, and a list of all sets.
- **Annotations on a frame** (arrows, comments back to the agent).
- **Video and animated captures.** Rasters only.
- **Syncing sets to a linked installation.**
- **A way to publish from the composer** by the operator. Attachments already
  cover that.

## Validation against the request

| The request | The design |
|---|---|
| "built into the orchestrator and into Delegatus" | One tool any agent calls; the orchestrator shows a lane's set by id; the row appears in any conversation pane, desktop and phone |
| "you give me a button" | The row the tool call already has, one per set, in the message flow |
| "it expands" | Variant 4 opens in place, in the feed |
| "shows the photos, the collage the agent left" | Every frame of every variant as tiles, kept after the worktree is gone |
| "the design needs thinking through" | Four working prototypes, measured, with a recommendation |
| Nothing on top of anything while closed | Measured in 24 panes, section 4 |
| A chosen variant lands in the field, editable | Measured in 24 panes, section 4 |
