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

An agent publishes a set with one new Delegatus tool, `publish_frames`, in the
short form by naming a directory. The server copies the frames into the
installation's state directory, so the set outlives the worktree. The set has
one entry point: one row with its title and its counts, standing where the
turn that published it ends, under the orchestrator's answer and above the
message field. That is where the feed's tail is when the answer arrives, so
the row is on screen at that moment at every width. Four ways to open the row
were prototyped. The recommendation is **variant 4**: the row expands in place
into a collage grouped by variant, a tile opens the image viewer the feed
already has, and each variant has its own "Choose" button that writes the
reply into the message field. Any frame is 2 presses away, plus a sideways
drag of the variant's row on the phone; a chosen variant is 2 presses with no
scroll at any width. It adds no new full-screen surface.

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
| A Delegatus tool call is a feed row with its own card | parsed at `src/components/feed/parse.ts:552` and `:3063`, drawn at `src/components/feed/FeedItem.tsx:317` by `src/components/runtime/McpCallCard.tsx:131` | Where the publication is read from. Its own row is replaced by the set's row at the end of the turn |
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

So a small build is justified: one tool, one store, one row that replaces the
publishing call's row. The viewer, the serving fence and the reply seam are reused as they are.

## 2. How an agent publishes a set

### The call

A new tool on the Delegatus MCP server, `publish_frames`. It has three forms.

**The short form**, for the usual case: a directory the capture driver wrote.
This is the whole call for the 24 frames of this lane's fixture:

```json
{
  "title": "Step between my own messages",
  "dir": "/var/tmp/lane/frames",
  "variants": ["In the header", "A row above the message field",
               "In the message field's own row", "Keys and menu rows"],
  "clientRequestId": "…"
}
```

The server reads the variant, the width and the language of each frame from
its file name, by one convention that the capture drivers already follow:

```
variant-<N>-<anything>-<width>-<lang>-<moment>.png
variant-4-pane-440-en-open.png  →  variant 4, width 440, language en, caption "pane open"
```

- Words are split on `-` and `_`.
- `variant-N` (or a leading `vN`) is the variant. `variant-0` is a frame of no
  variant: the pane as it is today.
- The first number from 240 to 3840 is the viewport width.
- The first word that is an interface language (`en`, `uk`) is the language.
- The words left over are the caption.
- Frames are ordered by variant, then by name with numbers compared as
  numbers; frames of no variant come last.
- `variants` is the list of titles in order; the first title belongs to
  variant 1. Without it the variants have numbers and no titles.
- A file whose name says none of this is published as a plain captioned frame.
  Files that are not PNG, JPEG or WebP are skipped.

The rule is `frameFromFileName` and `framesFromFileNames` in the model file,
with a test that uses this lane's own file names.

**The full form**, for the exceptions: names that follow no convention, a
caption that needs a sentence, an order the names do not give.

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

**Show an existing set again**, in the caller's own conversation:

```json
{ "setId": "fs_…", "clientRequestId": "…" }
```

All three answer with the set's id, its title and two counts. The answer
carries no bytes and no paths. The third form copies nothing.

It is a new tool because the two nearest ones have the wrong lifetime.
`suggest_replies` is over when the operator answers, and a set must stay
readable afterwards. `telegram_bot_send_media` sends outward.

### How a lane's set reaches the orchestrator's chat

The lane's agent publishes the set, and the operator sits in the
orchestrator's chat. The first draft of this note joined the two with a second
call by the orchestrator, which took the id from the lane's final message. That
rests on two agents' prose, and when either forgets, the operator sees nothing,
which is today's state. The path below reads no agent's text.

1. The server writes the source of every set itself: the conversation, and the
   pipeline and stage when the caller is a stage. So the server can answer
   "which sets did this stage publish" with no help.
2. `get_pipeline { pipelineId, stageId }`, which answers one stage's verdict,
   findings and summary today, also answers `frameSets: [{ setId, title,
   variants, frames }]` for that attempt.
3. The seat tick wake is the server's own message into the orchestrator's chat
   that says a child has settled (`seatTickWakeMessage`,
   `src/lib/monitor/report.ts:225`). Each child is one line
   (`seatTickBullet`, `:166`), and the controller already attaches the child's
   last words to it (`:169`, `src/lib/monitor/childFinalMessage.ts:38`). It
   attaches the child's sets the same way, one line each:
   `frames: fs_… "Step between my own messages" (4 variants, 24 frames)`.
4. The feed draws a set's row from that line. The wake starts the turn in
   which the orchestrator tells the operator about the lane, and the row closes
   that turn like any other set's row (see "Where the row stands"). No agent
   mentioned the id and nobody made a second call.

Only two things draw a row: a `publish_frames` call, and a `frames:` line in a
record the server delivered itself. Text an agent or the operator typed that
looks like such a line draws nothing.

One thing here was read and not run: that a delivered wake can be told from
typed text in both engines' transcripts (the server marks what it delivers,
`<!-- llv:structured-user … -->`, `src/lib/runtime/codexAppServerHost.ts:590`).
The build lane confirms it for Claude before it relies on it. If it does not
hold, step 2 still gives the orchestrator the id with no prose from the lane,
and the orchestrator's `publish_frames { setId }` is the one remaining call.

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
| The whole store | 2 GB and 200 sets | Past either, the oldest sets go first, see below |

Lifetime: a set is kept while the task its source lane is bound to is open,
and for 30 days after that task closes. A set with no task is kept for 30 days
after it was last opened. Removal deletes the manifest and every blob no other
set names.

When the store is past a bound, sets go in this order until it is under it:
first the sets whose keeping time has passed, oldest first; then, if every set
left belongs to an open task, the set that was opened longest ago, whatever its
task. A new publication is never refused because the store is full. The removed
set's row stays and says what happened.

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

Linked installations exchange rows over their own protocol
(`src/lib/links/agentFeed.ts:10`, `src/lib/links/laneFeed.ts`); a directory in
the state folder is never part of it, so `frame-sets/` stays on the machine
that published. A set's row seen from a linked machine therefore has a title
and counts and no bytes. The build draws that as the same state a removed set
has: the row says the frames are not on this machine, and it does not open.

### Where the row stands

The publishing call is a record in the transcript, and the parser already
turns a Delegatus call into a feed row (`src/components/feed/parse.ts:552`).
Today that row reads "MCP · VIEWER Running MCP tool: publish_frames"; that is
the `0` frame in the prototypes. The first draft put the set's row there, in
the call's own place.

A real turn shows why that fails. Delegatus calls never fold into a group
(`foldableTool`, `src/components/feed/parse.ts:1078`), so an orchestrator's
turn is a column of call rows, and the answer that follows is often longer
than the screen. The feed holds its tail, so when the answer arrives the
screen shows the end of the answer. The fixture's last turn now has that
shape: seven Delegatus calls, the publication fifth among them, and an answer
with a table that is about two feeds tall on the desktop and over three in a
narrow pane. Measured at the moment the answer arrives
(`arrival-*` in `evidence/frame-sets/measurements.json`):

| Where the row stands | Desktop 1440 | 440 px pane | Phone 390 |
|---|---|---|---|
| In the call's own place | off screen, 667 px up (686 uk) | off screen, 1288 px up (1326 uk) | off screen, 1495 px up (1618 uk) |
| Closing the turn | on screen, no scroll | on screen, no scroll | on screen, no scroll |

A rule for agents ("publish as the last call before the answer") does not fix
it: the answer alone is taller than the feed at every width.

So the row **closes the turn that published it**: it is drawn after the last
row of that turn, under the answer, and the call's own row leaves the feed, so
there is still exactly one row for the set. This is the place reply drafts
already use (`src/components/feed/SuggestedReplies.tsx:227`), and it is next to
the message field the choice is written into.

What the build does in each case:

- **The answer arrives while the operator is at the tail.** The row is on
  screen, as measured.
- **The operator has scrolled up.** The feed's own way-back row returns to the
  tail, and the row is there. Nothing new is added for this.
- **The turn is still running.** The row follows the turn's last row, so it is
  under whatever came last, and it ends up under the answer.
- **The conversation goes on.** The row stays at the end of its turn and
  scrolls away with it, like the answer it belongs to.
- **Two sets in one turn.** Two rows, in publication order.

In the build this is one derived row in the list `LogFeed` already maps
(`src/components/LogFeed.tsx:1985`), keyed by the set's id. There is no new
store keyed by conversation and no polling.

## 3. Where the operator opens it: four variants

All four share the closed state: one row in the feed, closing the turn that
published the set, with an icon, the set's title, "4 variants · 24 frames" and
a chevron. Under 560 px the row keeps the title whole and says "24 frames"
only; the first round cut the title to 19 characters on the phone. They differ
in what the row opens.

| № | What opens | Where |
|---|---|---|
| **1** | The row expands in place: variant tabs, one large frame, a filmstrip, "Choose N". A tap on the frame opens the feed's viewer | In the feed |
| **2** | A full-screen viewer with variant tabs on top, the frame, a filmstrip below and "Choose N" | Over the window, as the image viewer is |
| **3** | Two variants side by side at the same width and language, each with its own tabs and "Choose N", one strip of widths and languages for both | Over the window; stacked on the phone |
| **4** | The row expands in place into a collage: one section per variant with its number, title, "Choose N" and its frames as tiles at their own proportions. A tile opens the feed's viewer on that frame | In the feed, then the existing viewer |

Variant 4 has two forms, chosen by the row's own width, so a board pane is
narrow even in a wide window:

- **From 560 px up**, a variant's frames fill its row at their own
  proportions. From 960 px two variants stand side by side. At 1440 the four
  variants make a 2 × 2 block 344 px tall.
- **Under 560 px** the height is what runs out. Each variant gets its header
  and one row of tiles, 60 px tall with a mouse and 72 px tall with a touch
  pointer. A row that is wider than the pane scrolls sideways.

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
of an orchestrator's morning. Only the conversation evidence fixture imports
it. No product file changed.

```
?case=frame-sets&variant=0|1|2|3|4&lang=en|uk[&pane=440][&place=call][&arrive=hold]
```

- `variant=0` is the pane as it is today.
- `place=call` keeps the row in the publishing call's place, for the
  comparison in section 2. The default is the end of the turn.
- `arrive=hold` keeps the last answer back until the driver delivers it.

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
`frame` and `chosen`, and one `arrival-<place>-…` frame per width and
language. That is 114 frames; the run takes about three minutes.

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
- its box intersects no other interactive element, no other feed row, and
  nothing else in the row it stands in, which is the answer above it;
- every probe outside the feed is where it was without the feature: the
  header, the title, the feed's box, the message field, and every button of
  the header, the tools row and the composer (`changedAgainstNoFeature` is
  empty in all 24);
- the page does not scroll sideways;
- the set's title is shown whole (`title.cut` is false in all 24);
- on the phone the entry is 328 × 44 px.

The third check found a real overlap in this round. On the phone an answer's
own action row hangs 6 px below its text
(`src/components/feed/FeedItem.tsx:228`), and the entry's 4 px margin put it
2 px into the copy button's touch area. The entry now starts 8 px below the
answer on a touch pointer.

**Open in place (1 and 4).** Every control of the panel passes the same
hit-test and intersection checks, and the row that was pressed is still on
screen. The feed moves only as far as it must: a panel that fits under its row
moves nothing. In all 12 panes of variants 1 and 4 nothing differs from the
pane without the feature while the panel is open (`open.changedAgainstNoFeature`
is empty), and the feed is still on its tail.

For variant 4 the driver also fails the run unless, right after opening, the
whole collage is inside the feed, every "Choose" button is on screen, and
every variant's row of tiles is inside the feed top to bottom
(`open.collage`).

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

A press the driver makes scrolls its target into view by itself, which hid a
cost in the first round. Before every press the driver now reads whether the
whole target was on screen and how many pixels it had to be brought, down the
feed and sideways along a strip (`presses[].onScreen`, `scrollY`, `scrollX`,
and the totals in `scrolled`).

**The moment the answer arrives.** Twelve more records, `arrival-<place>-…`:
both places the row can stand, at three widths, in two languages. The driver
loads the turn without its answer, delivers the answer, and reads whether the
entry is on screen and how far it is. The numbers are the table in section 2.

## 5. The price of each variant

Measured. "Presses" are the ones the driver made; "scroll" is how far a target
had to be brought into view before a press.

| | 1 in place | 2 full screen | 3 side by side | 4 collage |
|---|---|---|---|---|
| Closed row | 32 px; 44 px on the phone | same | same | same |
| The call row it replaces | 30 px; 44 px on the phone | same | same | same |
| The feed is taller by | 6 px; 8 px on the phone | same | same | same |
| Open, desktop 1440 | 509 px of the feed | the window | the window | 344 px of the feed |
| Open, 440 px pane | 374 px of the feed | the window | the window | 434 px of a 519 px feed |
| Open, phone 390 | 354 px of the feed | the window | the window | 530 px of a 643 px feed |
| Controls on screen when open | 13 (12 on the phone) | 13 | 17 (14 on the phone) | 29; 21 on the phone |
| To variant 3's fifth frame, desktop | 3 presses | 3 presses | 3 presses | 2 presses |
| The same, 440 px pane | 3 presses | 3 presses | 3 presses | 2 presses |
| The same, phone | 3 presses + 19 px sideways | 3 presses | 3 presses + 223 px sideways (276 uk) | 2 presses + 75 px sideways |
| To choose variant 3, every width | 3 presses, no scroll | 3 presses, no scroll | 3 presses, no scroll | 2 presses, no scroll |
| To choose variant 1 | 2 presses | 2 presses | 2 presses | 2 presses |
| Feed leaves its tail when opened | no | no | no | no |
| New surface to build | a panel with tabs and a filmstrip | tabs, a filmstrip and a button added to `Lightbox` | a compare surface with two tab rows | a card with tiles; the viewer as it is, plus swipe |

How large a frame is before a zoom:

| | 1 in place | 2 full screen | 3 side by side | 4 collage: a tile of a 1440 / 440 / 390 frame |
|---|---|---|---|---|
| Desktop 1440 | 576 px wide for a 1440 frame | the window | half the window | 193 × 121, 66 × 121, 55 × 121 px |
| 440 px pane | 362 px wide for a 1440 frame | the window | half the window | 96 × 60, 33 × 60, 28 × 60 px |
| Phone 390 | the pane's width | the window | half the height; a phone frame is about 145 px wide | 115 × 72, 44 × 72, 44 × 72 px |

What variant 4 shows without any scroll, right after it opens:

| | Desktop 1440 | 440 px pane | Phone 390 |
|---|---|---|---|
| "Choose" buttons on screen | 4 of 4 | 4 of 4 | 4 of 4 |
| Tiles wholly on screen, per variant | 6 of 6 | 6 of 6 | 3 of 6; the rest by a sideways drag of that row |
| Width of the pane the tiles fill | all of it | all but 17 px | all of it |

### What the review of the first round found, and what changed

The first round's captures were read by a reviewer acting as the operator.

- **Variant 1 is turned down.** A 1440 frame is 576 px wide in it on the
  desktop and 362 px in a 440 px pane, too small to judge, so it needs a
  fourth press into the viewer. Its 13 controls serve a view the operator
  passes through. In a 440 px pane with a portrait frame its filmstrip is half
  below the feed's edge.
- **Variant 3 is turned down.** On the phone a phone frame is about 145 px
  wide, it puts 17 controls on a new full-screen surface, and "Choose 1" of
  the left column stands right against the right column's tabs.
- **Variant 2 stays only as a fallback**, and only as tabs, a filmstrip and a
  button added to the existing `Lightbox`. A second viewer beside it is turned
  down.
- **Variant 4 survives, in a different shape from the first round.** Then, on
  the desktop, six 97 × 84 px tiles filled 45% of the pane's width, a 1440
  frame was shrunk about 15 times, and the fourth row was cut by the feed's
  edge. In a 440 px pane it was 896 px tall in a feed of about 475 px, with
  "Choose 3" and "Choose 4" below the edge, and the note priced it at "2
  presses" because the driver's press scrolled by itself. Now a 1440 frame's
  tile is 193 px wide on the desktop (about 7.5 times smaller than the frame),
  the tiles fill the pane, the whole collage is 344 px tall, and the narrow
  form is prototyped and measured as built.

Reading the current frames as pictures (I looked at the captures at all three
widths in both languages):

- On the desktop the variant number printed on a frame and the place of the
  variant's control can be read on the tile without a zoom.
- In a 440 px pane a tile of a desktop frame is 96 px wide. It tells the
  frames apart and shows where the control is; reading it takes one press into
  the viewer. This is the limit of a 440 px pane, and the note does not claim
  more for it.
- On the phone the first three tiles of each variant are whole and the fourth
  is cut by the pane's edge, which is what shows that the row drags.
- On the phone two of the four Ukrainian variant titles are cut by their
  "Choose" button ("Рядок над полем повідомле…"). The full title is in the
  reply the button writes.

### Recommendation: variant 4

It matches the words of the request most closely: a button, it expands, it
shows the collage the agent left. It takes the fewest presses to a frame and to
a choice at every width, and it adds the least: one card in the feed and one
gesture in the existing viewer. It builds no second full-screen surface, which
is the kind of addition the operator has turned down before.

What it gives up, plainly:

- No side-by-side view. Two variants are compared by stepping between two
  frames in the viewer.
- On the phone half of a variant's frames are a sideways drag away, and the
  frames the agent listed first are the ones on screen. A lane that wants the
  phone frames seen first on the phone lists them first.
- In a narrow pane a tile is a thumbnail; judging a frame takes the viewer.
- The choice is made from the collage. From inside the viewer it is one more
  press: close, then "Choose N".

The fallback, if the operator reads variants one at a time far more often
than he scans a set, is variant 2 as an extension of `Lightbox`, opened from
the same row.

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

1. `publish_frames` in the MCP server and its Viewer-side write: the three
   forms, the file-name convention, the store, the bounds, the two read routes,
   removal by lifetime and by the store's bounds. The model file's types and
   rules move to `src/lib/frameSets/`.
2. The set's row as a derived row that closes its turn, and the card in it:
   the closed row and the collage in both forms, in English and Ukrainian. The
   publishing call's own row leaves the feed. The states "no longer kept" and
   "not on this machine".
3. `frameSets` in the `get_pipeline` stage answer and the `frames:` line in
   the seat tick wake, and the row drawn from that line.
4. Swipe in `Lightbox` for an unzoomed picture.
5. `frameSet` in `telegram_bot_send_media`.
6. One paragraph in the agent prompt contract: a design or UI lane publishes
   its frames with `publish_frames`, by directory. Nothing in it asks an agent
   to pass an id on.
7. The prototype files are deleted. The driver block stays and is pointed at
   the real card, with the same closed, open and arrival measurements.

## What this round did not prove

- **Claude transcripts.** The prototype runs over a Codex transcript only. A
  Claude tool call becomes the same kind of feed row and the row is derived
  from the parsed turn, so the same code serves both; the build lane runs the
  driver block over a Claude transcript too.
- **The wake's `frames:` line**, as said in section 2.
- **The strip's height is a constant** in the prototype (60 px, 72 px on a
  touch pointer), tuned to the two narrow fixtures. The build takes it from
  the feed's own height, between 56 and 96 px, so a taller pane gets larger
  tiles.
- **Sets with other shapes.** The fixture has six frames per variant. With
  more, the wide form wraps a variant into further rows and the narrow form
  drags further; the layout rule is tested for wrapping
  (`justifiedRows`), and no capture shows it.
- **Putting the row at the end of the turn** is done in the prototype by
  moving a host node after the feed has drawn. The build draws the row in the
  feed's own list, so the feed's tail-following covers it with no help.

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
| "built into the orchestrator and into Delegatus" | One tool any agent calls; a lane's set reaches the orchestrator's chat through the server's own wake; the row appears in any conversation pane, desktop and phone |
| "you give me a button" | One row per set, under the orchestrator's answer, on screen when the answer arrives (measured at three widths) |
| "it expands" | Variant 4 opens in place, in the feed, and the feed stays on its tail |
| "shows the photos, the collage the agent left" | Every frame of every variant at its own proportions, filling the pane on the desktop; kept after the worktree is gone |
| "the design needs thinking through" | Four working prototypes, measured, reviewed once as the operator would, revised, with a recommendation |
| Nothing on top of anything while closed | Measured in 24 panes, section 4 |
| A chosen variant lands in the field, editable | Measured in 24 panes, section 4 |
