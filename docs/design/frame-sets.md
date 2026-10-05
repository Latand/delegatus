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
reply into the message field. A variant is one row of tiles whatever it
holds, so the collage is as tall for this lane's own 126 frames as for 24,
and it fits the feed at every width measured. A variant's row begins with the
first frame of each width it was captured at, so right after the collage
opens every variant shows a desktop, a pane and a phone frame at every width
measured, and each of them is 2 presses away with nothing dragged. A chosen
variant is 2 presses with no scroll at any width and either size. The later
moments of a width are steps in the viewer from its first frame, a sideways
drag of the variant's row in a narrow pane, or the "+N" tile on the desktop.
It adds no new full-screen surface.

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
The whole directory is one set. This is the whole call for the 126 frames
this lane's own driver writes when it is run as section 3 says, with `dir`
the driver's output directory (`.artifacts/frame-sets/` in the lane's
worktree, written here without the worktree's own path):

```json
{
  "title": "Show an agent's frames from the conversation",
  "dir": "<worktree>/.artifacts/frame-sets",
  "variants": ["Expands in place", "Full-screen viewer",
               "Two side by side", "Collage that zooms"],
  "clientRequestId": "…"
}
```

It gives a set of four variants with 24, 24, 24 and 36 frames and 18 frames
of no variant: the pane as it is today and the twelve arrivals. The model
test takes the list of names the driver writes (`driverFrameNames`, which the
driver itself checks against what it wrote), reads it by the rule below, and
gets no refusal.

The server reads the variant, the width and the language of each frame from
its file name, by the convention the design lanes' capture runs already
follow:

```
variant-<N>-<anything>-<width>-<lang>-<moment>.png
variant-4-pane-440-en-open.png  →  variant 4, width 440, language en, caption "pane open"
```

- Words are split on `-` and `_`.
- `variant-N` (or a leading `vN`) is the variant. `variant-0` is a frame of no
  variant: the pane as it is today.
- The viewport width is the first number from 240 to 3840 that follows the
  variant. A number before the variant is part of the caption, so
  `pr-2521-variant-2-390-en.png` is 390 px wide. A name with no variant gives
  its first such number. A viewport written `1440x900` gives 1440.
- The first word that is an interface language (`en`, `uk`) is the language.
- The words left over are the caption.
- Frames are ordered by variant, then by name with numbers compared as
  numbers; frames of no variant come last. Inside a variant the name is
  therefore the order. A driver that wants its moments in the order it took
  them numbers them: `…-en-1-closed.png`, `…-en-2-open.png`. Without the
  number they stand by the alphabet (`chosen`, `closed`, `frame`, `open`),
  which is how this lane's frames stood until this round. Its driver now
  writes the number, so variant 3 begins `desktop-1440-en-1-closed`,
  `…-2-open`, `…-3-frame`, `…-4-chosen`, `desktop-1440-uk-1-closed`: by pane,
  then by language, then by moment. The number stays in the caption
  ("desktop 2 open").
- The order is the viewer's order. The collage takes one thing from the
  frames' widths instead: a variant's row begins with the first frame of each
  captured width and goes on by name (section 3). So an agent renames nothing
  to have its phone frames seen.
- `variants` is the list of titles in order; the first title belongs to
  variant 1. Without it the variants have numbers and no titles.
- A file whose name says none of this is published as a plain captioned frame.
  Files that are not PNG, JPEG or WebP are skipped.
- Only the directory's own files are read. A subdirectory is left out with
  everything in it: this lane's driver keeps its page bundle in `bundle/`
  under its output directory (3.6 MB of JavaScript), and a capture run may
  keep older runs beside the current one. Frames in a subdirectory are
  published by naming that subdirectory.
- The caption's words are the name's words, in whatever language the driver
  wrote them. The variant, the width and the language in front of them come
  from the frame's own fields and read the same in every interface language.

Where the convention holds. The fourth review read the rule against seven
real directories of design lanes under `/var/tmp`, 16 to 106 frames each,
named with `variant-N` and with `vN`: every one gave variants and widths.
It does not hold for every driver in the repository:
`scripts/capture-board-geometry.ts` names its frames by a tag and a moment,
with no variant. Such a directory is published whole and is a plain album: its
frames are the frames of no variant, the closed row counts them, the viewer
steps through them, and there is no "Choose", because there is nothing to
choose between. That is the right reading of a run that compares nothing.

The rule is `frameFromFileName` and `framesFromFileNames` in the model file,
with a test that uses this lane's own file names and a name from a
subdirectory.

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
4. The feed draws a set's row from that line and leaves the line itself out
   of the wake's shown text, so one turn names a set once. The agent still
   reads the line. The wake starts the turn in which the orchestrator tells
   the operator about the lane, and the row closes that turn like any other
   set's row (see "Where the row stands"). No agent mentioned the id and
   nobody made a second call.

Only two things draw a row: a `publish_frames` call, and a `frames:` line in a
record the server delivered itself. Text an agent or the operator typed that
looks like such a line draws nothing.

A turn draws one row for one set. The rows of a turn are keyed by the set's
id, so when the wake's `frames:` line names a set and the orchestrator also
calls `publish_frames { setId }` for it in the same turn, the feed draws that
set once, at the end of the turn. The same set shown again in a later turn
gets a row there too, which is what the third form is for.

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
- **variants**, up to 9, each a number from 1 to 9 and a title of up to 60
  characters. The number is
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

A variant's title is up to 60 characters. It stands whole beside its "Choose"
button, and in a 390 px pane it has 230 px there. The fixture's longest
title, 32 characters, fills one line of that, so 60 characters are about two.

### Where the frames are read from

A published path is read through the fence the image route already applies
(`admittedAs`, `src/lib/artifact/localFile.ts:63`): under the home directory,
or under an evidence root, which is `/var/tmp` unless the installation set
`LLV_EVIDENCE_ROOTS` (`:39`). The realpath is checked against the same roots,
only PNG, JPEG and WebP are taken, and the bytes must agree with the
extension. So a set can hold exactly what a thumbnail in the feed could show,
and the installation keeps a single fence.

The four places a lane's frames usually are:

| Where the frames are | Read? | Why |
|---|---|---|
| `.artifacts/` in the lane's worktree | yes | under the home directory; this is where the capture drivers write by default |
| The stage's own directory (`$TMPDIR` of a stage, under the state directory's `scratch/`) | yes | under the home directory; it is removed when the stage settles, and the set keeps its own copies |
| `/var/tmp/…` | yes | the evidence root |
| `/tmp/…`, the operating system's temporary directory | no | under neither root |

The review of the second round showed why the last row matters: this lane's
own frames were written to a directory under `/tmp` twice, once by the author
and once by the reviewer, because the lane's specification puts `HOME` and
`TMPDIR` of a test run there and the output directory was pointed at the same
place. Two answers were weighed.

Reading `/tmp` for a publication was turned down. In the container
installation the Viewer sees the host's `/var/tmp` (`docker-compose.yml:42`)
and has a `/tmp` of its own, so the same call would work on one installation
and find no file on another. It would also be a second set of roots beside
the image route's, and `/var/tmp` was made the evidence root so that agents
have one place outside the home directory (#2084).

So the roots stay, and the refusal does the work. It is one sentence that
names every place that is read and the command that moves the frames, and it
is the whole answer: nothing is published in part. For the short form called
with this lane's first directory the agent reads exactly this:

```
/tmp/fs-lane/out is outside what Delegatus reads. Frames are read from: your
worktree (the capture drivers write to .artifacts/ in it); the stage's own
directory ($TMPDIR); /var/tmp. Nothing was published. Copy the frames and call
again with the copy: cp -r /tmp/fs-lane/out /var/tmp/frames-fs-lane-out
```

(One line in the tool's answer; wrapped here.) The full form answers the same
for the first frame it cannot read, with the frame's own path in front and
the same copy command for its directory. The evidence roots in the sentence
are the installation's own, so an installation that changed them names its
own. The rule and the sentence are `frameSourceRoot` and `frameSourceRefusal`
in the model file; the test checks the four places above against the image
route's own `admittedAs` and holds the sentence word for word.

An agent that follows the note does not meet the refusal: the driver's
default output is in the worktree. Isolating a test run needs `HOME`,
`TMPDIR` and the state directory under `/tmp`; the output directory stays
where the driver puts it.

### Where the files live and for how long

- `<state>/frame-sets/<setId>/manifest.json` holds the record.
- `<state>/frame-sets/blobs/<sha256>.<ext>` holds the bytes, named by their
  hash. A frame published twice, or a set shown in two conversations, is stored
  once.
- The write happens in the Viewer process, reached through the control call
  the other mutating tools use (`src/lib/mcp/bindings.ts:6603` is the pattern).
  The MCP server process itself writes nothing into the state directory.
- A published path is read through the fence the image route already applies;
  see "Where the frames are read from" above.

Bounds, each refused with the bound named in the error:

| Bound | Value | Why |
|---|---|---|
| Frames per set | 240 | A driver writes variants × widths × languages × moments. This lane's directory is 126 frames for four variants; nine variants at that density are 216, and a few frames of no variant. The first bound, 60, refused this lane's own directory. The collage's height no longer depends on the count (section 3), so the bound is about storage only |
| Variants per set | 9 | One digit, so a key press and a printed number are the same thing |
| One frame | 4 MB | The 126 captures of this lane average 68 KB and the largest is 127 KB; 4 MB leaves room for a long full-page capture at double density |
| One set | 48 MB | This lane's 126 frames are 8.8 MB; 240 at the same average are under 17 MB |
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
only; the first round cut the title to 19 characters on the phone. The row
starts where the answer's text starts: at the first glyph of the answer,
which on the desktop and in a board pane is 36 px right of the answer's row
(the avatar's gutter) and is where the feed's tool cards start too. On the
phone there is no gutter. They differ in what the row opens.

| № | What opens | Where |
|---|---|---|
| **1** | The row expands in place: variant tabs, one large frame, a filmstrip, "Choose N". A tap on the frame opens the feed's viewer | In the feed |
| **2** | A full-screen viewer with variant tabs on top, the frame, a filmstrip below and "Choose N" | Over the window, as the image viewer is |
| **3** | Two variants side by side at the same width and language, each with its own tabs and "Choose N", one strip of widths and languages for both | Over the window; stacked on the phone |
| **4** | The row expands in place into a collage: one section per variant with its number, title, "Choose N" and its frames as tiles at their own proportions. A tile opens the feed's viewer on that frame | In the feed, then the existing viewer |

Variant 4 has two forms, chosen by the row's own width, so a board pane is
narrow even in a wide window. In both a variant is **one row of tiles**,
whatever it holds, so the collage is as tall with 36 frames in a variant as
with 6:

- **From 560 px up**, a variant's frames stand in its row at their own
  proportions. When they all fit, they fill it. When they do not, the row
  holds the first that fit and ends with one tile, "+21", that opens the
  viewer on the first frame the row has no room for. From 960 px two variants
  stand side by side. At 1440 the four variants of the six-frame set make a
  2 × 2 block 344 px tall.
- **Under 560 px** the height is what runs out. Each variant gets its header
  and one row of tiles that scrolls sideways when it is wider than the pane.
  The row is 60 px tall with a mouse and 72 px with a touch pointer when the
  feed has the room, and gives up height, down to 48 px, before the collage
  would be taller than the feed.

**What a row begins with.** A driver names its frames pane by pane, so by
name a variant of this lane's set is eight desktop frames, then eight of the
pane, then eight of the phone. A row of the first frames by name showed three
moments of the desktop and left the first phone frame sixteen frames away,
in every variant. So a row begins with the first frame of each width the
variant was captured at, in the order the widths first appear, and then goes
on with the rest by name (`widthsFirst` in the model). With three widths the
first three tiles are a desktop, a pane and a phone frame, and they are on
screen at every width measured. The viewer keeps the set's own order: a tile
opens it on that frame, and the next steps are that width's later moments
(in this lane's set seven steps cover a width's eight frames, and the fourth
step is its first Ukrainian frame). A set whose names say no width keeps its
order by name.

**Frames of no variant** (the pane as it is today, a measurement) are no
choice, so they get no tiles. They stand in one last row under the variants,
"Without a variant · 18 frames", which opens the viewer on the first of them.
They are also in the viewer's own order after the last variant, and in the
closed row's count.

In both forms a variant's title is shown whole beside its "Choose" button. A
title too long for one line wraps to a second; it is never cut, because the
title is what tells the variants apart before a press.

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
?case=frame-sets&variant=0|1|2|3|4&lang=en|uk[&pane=440][&set=lane][&place=call][&arrive=hold]
```

- `variant=0` is the pane as it is today.
- `set=lane` publishes a set of a real lane's size in place of the 24-frame
  one, see below.
- `place=call` keeps the row in the publishing call's place, for the
  comparison in section 2. The default is the end of the turn.
- `arrive=hold` keeps the last answer back until the driver delivers it.

There are two fixture sets, both synthetic: every frame is drawn on a canvas
when the page loads, with its variant number printed in the corner.

- **Six frames a variant**: four variants at three widths in two languages,
  24 frames. Every variant is measured over this one.
- **A lane's size** (`set=lane`): this lane's own capture directory as the
  short form reads it. The list of names is the one the driver writes, and
  each frame's variant, width, language, caption and place in the order come
  from its name by the publication's rule: 24, 24, 24 and 36 frames in the
  four variants and 18 of no variant, 126 in all. Its variant titles are
  longer, so two of them wrap to a second line in a narrow pane. Variant 4 is
  measured over this one too.

The pictures are drawn and no real lane's files are read, because a raster
is admitted to the repository only when an in-repo generator reproduces it.

```
LLV_CONVERSATION_BROWSER_TEST=1 CHROME_BIN=<chromium> \
  bun test src/components/conversation/conversationWindow.browser.test.tsx -t "frame sets"
```

Frames go to `LLV_FRAME_SETS_OUT` (default `.artifacts/frame-sets/`, not
committed): per variant, width and language, the moments `1-closed`,
`2-open`, `3-frame` and `4-chosen`; for variant 4 over the lane-sized set,
`5-lane-open` and `6-lane-frame`; the pane without the feature as
`variant-0-…-1-closed`; and one `arrival-<place>-…` frame per width and
language. That is 126 frames; the run takes about three minutes. The page
the driver serves is built into `bundle/` under the same directory, which the
short form does not read (section 2).
Run it with the default output directory: `publish_frames` reads the worktree
and does not read `/tmp` (section 2).

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
- the entry's left edge is the left edge of the answer's first glyph
  (`closed.leftOfAnswer` is 0 in all 24): 61 px on the desktop, 329 px in the
  440 px pane's window, 13 px on the phone, where the entry is 364 × 44 px.

The third review found that this last check read nothing. It compared the
entry with the box of the answer's row, and the entry was aligned to that
same box, so the difference was always 0 while the row stood 36 px left of
the text on the desktop and in the pane, in the avatar's gutter. The driver
now reads the first glyph of the answer (`Range.getClientRects`), and the row
is aligned to the answer's text column.

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
whole collage is inside the feed, every "Choose" button is on screen, every
variant has exactly one row of tiles, and that row is inside the feed top to
bottom (`open.collage`). It reads every variant's title too
(`open.collage.titles`) and fails the run when one is cut: by an ellipsis, by
a box narrower or shorter than its text, or by the feed's edge. And it reads
which captured widths have a tile wholly on screen in each variant
(`open.collage.widthsOnScreen`) and fails the run when a variant shows no
frame of 1440, of 440 or of 390. All four variants show all three in all six
panes.

**A set of a real lane's size.** Six more records,
`variant-4-<pane>-<lang>-lane-set`: variant 4 over the 126-frame set at the
three widths in both languages. The same closed checks, the same open checks,
and the run fails when a "Choose" is past the feed's edge, the collage is
taller than the feed, a variant has a second row, a title is cut, a variant
shows no frame of one of the three widths, or the row of the frames of no
variant is off screen. All six pass. In the 440 px pane
and on the phone three of the four English titles and one Ukrainian title
stand on two lines, and none is cut. The driver then goes to variant 3's
first phone frame, which is its seventeenth frame by name, to the first frame
of no variant, and to a chosen reply. The run fails when that phone frame
costs more than two presses, a drag of a strip, a scroll of the feed, or a
step in the viewer (`toFrame.count`, `scrolled`, `stepsInViewer`). In all six
it is two presses and nothing else.

**Open full screen (2 and 3).** The surface covers the window while it is
open, by design, on the layer the image viewer uses. Its own controls pass the
hit-test and intersection checks and stay inside the window, and on the phone
each is at least 44 × 44 px. After a choice the surface is gone and the field
is visible.

**The walk.** In every pane the driver goes to variant 3's first phone frame
(its fifth frame by name in the six-frame set) and
reads which frame is shown, steps one back and one forward (by arrow keys on
the desktop, by a touch swipe on the phone), then reloads, chooses variant 3
from the closed row, reads the reply out of the message field, types more
after it and confirms the feed still holds three own messages, so nothing was
sent. All 24 pass.

After the choice the driver also reads the set's row. In variants 2 and 3 the
surface is gone and the closed row is the last thing in the feed, so it has
to be whole (`choose.entryWholeAfter`). The third review saw it half under
the feed's edge on the phone: a reply of two lines makes the message field
taller, and the feed then puts itself back where it was. The prototype holds
a feed that was on its tail there; in the build the feed does it itself
(step 2 of the build).

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
| Open, desktop 1440 | 509 px of the feed | the window | the window | 344 px of a 619 px feed |
| Open, 440 px pane | 374 px of the feed | the window | the window | 420 px of a 519 px feed |
| Open, phone 390 | 377 px of the feed | the window | the window | 516 px of a 643 px feed |
| Controls on screen when open | 13 | 13 | 17 (14 on the phone) | 29; 21 on the phone |
| To variant 3's first phone frame (its fifth by name), desktop | 3 presses | 3 presses | 3 presses | 2 presses |
| The same, 440 px pane | 3 presses | 3 presses | 3 presses | 2 presses |
| The same, phone | 3 presses | 3 presses | 3 presses + 223 px sideways (276 uk) | 2 presses, nothing dragged |
| To choose variant 3, every width | 3 presses, no scroll | 3 presses, no scroll | 3 presses, no scroll | 2 presses, no scroll |
| To choose variant 1 | 2 presses | 2 presses | 2 presses | 2 presses |
| Feed leaves its tail when opened | no | no | no | no |
| New surface to build | a panel with tabs and a filmstrip | tabs, a filmstrip and a button added to `Lightbox` | a compare surface with two tab rows | a card with tiles; the viewer as it is, plus swipe |

Every number above is for the set of six frames a variant. Variant 4, the
recommendation, was measured again over the set of this lane's own size: 24,
24, 24 and 36 frames in the variants and 18 of no variant.

| Variant 4 | 6 frames a variant (24 in all) | A lane's size (126 in all) |
|---|---|---|
| Open, desktop 1440 | 344 px of a 619 px feed | 438 px of a 619 px feed |
| Open, 440 px pane | 420 px of a 519 px feed | 438 px of a 519 px feed |
| Open, phone 390 | 516 px of a 643 px feed | 550 px of a 643 px feed |
| Rows of tiles a variant | 1 | 1 |
| Widths with a frame on screen, per variant, every pane | 3 of 3 | 3 of 3 |
| Controls on screen when open | 29; 21 on the phone | 22; 26 in the 440 px pane |
| To choose variant 3, every width | 2 presses, no scroll | 2 presses, no scroll |
| Variant 3's first phone frame is, by name | its 5th of 6 | its 17th of 24 |
| To that frame, desktop | 2 presses | 2 presses, no step in the viewer |
| The same, 440 px pane | 2 presses, nothing dragged | 2 presses, nothing dragged |
| The same, phone | 2 presses, nothing dragged | 2 presses, nothing dragged |
| The same with the row in the order of the names (the third round) | 2 presses; + 39 px sideways on the phone | desktop: 2 presses and 13 steps in the viewer; pane: a drag of 1376 px; phone: a drag of 1648 px |
| To the first frame of no variant | the set has none | 2 presses, no scroll |
| Feed leaves its tail when opened | no | no |

The last-but-two row is what the third round's note left out. Its price table
went to "variant 3's fifth frame", which in the lane-sized set is the
neighbouring desktop frame, so it read "2 presses and 1 step". The fourth
review measured the walk to the first phone frame in that round's build: the
"+21" tile opens the viewer on the fourth frame and the phone's first is the
seventeenth, and in the narrow form the strip had to be dragged 3.6 widths of
the row in the pane and 4.5 on the phone, for each of the four variants.

The larger set is taller by 94 px on the desktop, 18 px in the pane and 34 px
on the phone. In each that is the row of the frames of no variant (28 px and
its gap, 44 px on the phone). In the narrow form the four strips give up 4 px
each to make room for it, 60 to 56 px in the pane and 72 to 68 px on the
phone. On the desktop the two rows of tiles are also taller, 150 px where the
six-frame set's are 121 px: three tiles of three different widths and "+21"
do not fill a row at 120 px and a fourth tile does not fit, so the row grows
to the rule's limit.

How large a frame is before a zoom:

| | 1 in place | 2 full screen | 3 side by side | 4 collage: a tile of a 1440 / 440 / 390 frame |
|---|---|---|---|---|
| Desktop 1440 | 576 px wide for a 1440 frame | the window | half the window | 193 × 121, 66 × 121, 55 × 121 px |
| 440 px pane | 362 px wide for a 1440 frame | the window | half the window | 96 × 60, 33 × 60, 28 × 60 px |
| Phone 390 | the pane's width | the window | half the height; a phone frame is about 145 px wide | 115 × 72, 44 × 72, 44 × 72 px |

What variant 4 shows without any scroll, right after it opens:

| | Desktop 1440 | 440 px pane | Phone 390 |
|---|---|---|---|
| "Choose" buttons on screen, either set | 4 of 4 | 4 of 4 | 4 of 4 |
| Variant titles shown whole, either set | 4 of 4 | 4 of 4 | 4 of 4, in both languages |
| Widths with a frame on screen, per variant, either set | desktop, pane, phone | desktop, pane, phone | desktop, pane, phone |
| Tiles wholly on screen, per variant, 6 frames a variant | 6 of 6 | 6 of 6 | 4 of 6: one of each width and a second desktop frame; the rest by a sideways drag of that row |
| The same, a lane's size | 3 of 24 (3 of 36): one of each width, and "+21" ("+33") | 4 of 24: one of each width and a second desktop frame; the rest by a sideways drag | 3 of 24: one of each width; the rest by a sideways drag |
| A tile of a desktop / pane / phone capture, a lane's size | 240 × 150, 187 × 150, 69 × 150 px | 90 × 56, 70 × 56, 26 × 56 px | 109 × 68, 85 × 68, 44 × 68 px |
| Width of the pane the tiles fill, 6 frames a variant | all of it | all but 16 px | all of it |

In the lane-sized set a tile of the 440 px pane's capture is wider than in
the six-frame set (70 × 56 px in the pane, 33 × 60 px there) because this
lane's driver captures the 1000 × 800 window around the pane; the six-frame
set draws that frame 440 px wide. In the 440 px pane a phone capture's tile
is 26 px wide (28 px in the six-frame set): enough to see that the variant
has a phone frame and to press it with a mouse, and the viewer is where it
is read. With a touch pointer a tile is never narrower than 44 px.

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
  tile is 193 px wide on the desktop (about 7 times smaller than the frame),
  the tiles fill the pane, the whole collage is 344 px tall, and the narrow
  form is prototyped and measured as built.

### What the review of the second round found, and what changed

The second review confirmed the measurements and the verdict on each variant,
and found two things.

- **The publication refused this lane's own frames.** They lay under `/tmp`,
  which the fence does not read, and the note did not say what an agent would
  be told. Section 2 now lists what is read, holds the refusal word for word,
  and says why `/tmp` stays unread.
- **Two of the four Ukrainian variant titles were cut on the phone**
  ("Рядок над полем повідомле…"), and the driver did not look. Two causes,
  both removed. The title had an ellipsis; it now wraps and is never cut. And
  on the phone the set's row started 36 px right of the answer's text, a
  tenth of the pane; it now starts with the text, so the row is 364 px wide
  on the phone where it was 328 px. With that the six-frame set's longest
  title fits on one line, and the driver fails the run if any title is cut.

On the phone that gave four whole tiles a variant where three were, and the
walk to variant 3's fifth frame drags 39 px where it dragged 75 px. The same
change moved the row 36 px too far left on the desktop and in the pane, which
the third review found.

Three smaller things from the same review:

- The file-name rule took the first number from 240 to 3840 as the width, so
  `pr-2521-variant-2-390-en.png` was 2521 px wide and `1440x900` was no width.
  The width is now read after the variant, and `WxH` gives its width.
- In the viewer on the phone the caption is cut by the viewer's own header,
  and it began with the variant's title, so the width and the language of the
  frame were the part that was lost. The caption now reads "3 · phone 390 ·
  en · title", and on the phone the header still shows only "3 · телефон
  39…": about 14 characters beside the counter and the four buttons. The
  order helps and does not settle it. The build gives the caption a line of
  its own under the viewer's header on a narrow screen (step 4 below).
- A tile has no printed width or language; they are in its tooltip and in the
  viewer's caption. A label on each of 24 tiles is chrome the collage does
  without: a variant's tiles stand in the agent's order at their own
  proportions, so the wide one is the desktop and the narrow ones the pane
  and the phone, and the language is one press away.

Reading the current frames as pictures (I looked at the captures at all three
widths in both languages):

- On the desktop the variant number printed on a frame and the place of the
  variant's control can be read on the tile without a zoom.
- In a 440 px pane a tile of a desktop frame is 96 px wide. It tells the
  frames apart and shows where the control is; reading it takes one press into
  the viewer. This is the limit of a 440 px pane, and the note does not claim
  more for it.
- On the phone the first four tiles of each variant are whole and the fifth
  is past the pane's edge.
- On the phone all four variant titles are whole in both languages, each on
  one line.

### What the review of the third round found, and what changed

The third review reran the driver, read all 114 frames and confirmed the
closed state and the verdict on each variant. It found three things in the
recommended one.

- **The short form refused this lane's own directory.** The driver wrote 114
  frames and a set held at most 60, so the first real set of a design lane
  would have been refused whole, and the short form had no way to take a part
  of a directory. A directory is now one set: the bound is 240 frames, with
  the reason in section 2. A filter in the short form was weighed and turned
  down: it would make the agent choose which of its frames the operator may
  see, and the collage no longer needs fewer frames to stay small. The names
  inside a variant stood by the alphabet (`chosen`, `closed`, `frame`,
  `open`); the driver now numbers its moments, and the model test publishes
  the driver's real list of names and checks the order.
- **With a set of this lane's size the collage was 1130 px tall in the
  desktop's feed**, four rows a variant, with "Choose 3" and "Choose 4" past
  the edge. Every capture and every price had been taken with six frames a
  variant. A variant is now one row whatever it holds, with "+N" for the
  rest in the wide form; the narrow form's strip gives up height before the
  collage outgrows the feed; the frames of no variant, which had no tiles and
  no way in but stepping through the viewer, have their own row. The driver
  opens a second set of this lane's size at the three widths in both
  languages and fails the run on the defect the review found. The price
  tables above show both sizes.
- **The set's row stood 36 px left of the answer's text on the desktop and in
  the 440 px pane**, in the avatar's gutter, and the driver's check could not
  see it. The row is aligned to the answer's first glyph, where the tool
  cards start, and the check reads the glyph. The row is 1354 px wide on the
  desktop where it was 1390 px, and 378 px in the pane where it was 414 px;
  in the pane the tiles of six frames now leave 16 px of the row unfilled
  where they left 52 px.

Opening the lane-sized set also showed that the feed could end a few pixels
off its tail after an in-place open, because it estimates the height of rows
that are off screen; on the phone that was enough to bring the feed's
way-back row in and cut the collage. A move that means the tail now holds it
through the next frames.

Smaller things from the same review:

- After a choice on the phone the closed row was half under the feed's edge
  in variants 2 and 3. Fixed in the prototype and checked, see section 4; the
  build makes it the feed's own.
- The wake's `frames:` line would stand as text beside the row drawn from it,
  naming one set twice in a turn. The feed leaves the line out of the shown
  text (section 2).
- No capture showed a variant title on two lines. The lane-sized set's
  titles are longer, and its captures show two lines in the pane and on the
  phone.
- The viewer's caption on the phone is still cut; that is step 4 of the
  build.

Reading the new frames as pictures (I looked at the lane-sized captures at
all three widths in both languages, and at the closed rows on the desktop and
in the pane):

- On the desktop each variant shows three desktop captures large enough to
  read the variant number and the place of the control, then "+21". The four
  "Choose" buttons stand in two columns at the right edge of each half, and
  the row "Without a variant · 18 frames" closes the card. Nothing is cut.
- In the 440 px pane and on the phone the tile after the third is cut by the
  pane's edge, which is what says the strip goes on sideways.
- The closed row's left edge is on the line of the answer's text and of the
  list markers above it at every width.

That round's reading ended with the advice that a lane which wants its phone
frames seen first names them first. The fourth review turned it down, and it
is gone from this note; see below.

### What the review of the fourth round found, and what changed

The fourth review reran the driver over an export of the commit, got the
committed measurements byte for byte, confirmed the closed state in all 30
panes and the verdict on each variant, and found one thing in the
recommended one.

- **Over a set of a real lane's size every variant showed three nearly
  identical desktop frames, and the pane's and the phone's frames were far
  away.** A variant's frames stand pane by pane in their names, and the row
  took the first by name. In variant 3 the first pane frame was the ninth of
  24 and the first phone frame the seventeenth. The price the note had left
  out is in section 5: 13 steps in the viewer on the desktop, a drag of
  1376 px in the 440 px pane and of 1648 px on the phone, for each of the
  four variants. The note's own price row went to "the fifth frame", a
  neighbouring desktop frame, and its advice to name the phone frames first
  moved the work to the agent: by the naming convention that is renaming
  files, and the review's real lane directories of 106 and 80 frames sort the
  same way.
- **What changed.** A variant's row begins with the first frame of each width
  it was captured at and goes on by name (`widthsFirst`, used by both forms
  of the collage). The agent renames nothing and the publication's rule is
  unchanged. Right after opening, every variant shows a desktop, a pane and a
  phone frame at 1440, in the 440 px pane and on the phone, in both
  languages, over both sets. The driver reads that and fails the run when a
  width is missing. Its walk now goes to variant 3's first phone frame in
  both sets (the fifth by name in one, the seventeenth in the other) and
  fails the run when that costs more than two presses, any drag or scroll, or
  a step in the viewer. The price table has the row for both sets.
- **What that cost.** On the desktop the lane-sized collage is 438 px tall
  where it was 382 px, because three tiles of different widths leave the row
  room to grow; it is inside the 619 px feed with every "Choose" on screen.
  The narrow form's height did not change. A phone capture's tile is 26 px
  wide in a 440 px pane.

Smaller things from the same review, each answered in the section named:

- The driver's output directory holds a `bundle/` subdirectory, and the note
  did not say whether the short form reads subdirectories. It reads the
  directory's own files only (section 2, with a test).
- A set named by the wake's `frames:` line and shown by
  `publish_frames { setId }` in the same turn would have drawn two rows. A
  turn's rows are keyed by the set's id (section 2).
- "A convention the capture drivers already follow" was true of the design
  lanes' names only: `capture-board-geometry` writes no variant. Section 2 now says whose convention it is and what such a
  directory becomes.
- The lane-sized set's captions were English words in a Ukrainian interface,
  and the viewer's caption on the phone was cut after "3 · desktop 1 …". A
  caption's words are the file name's words, which no interface language
  translates. So the viewer's caption now leads with what is read from the
  frame's own fields, "3 · 390 · en", then the name's words and the
  variant's title. On the phone the header shows "3 · 390 · en · …": the
  variant, the width and the language are whole and the words after them are
  what is cut. Giving the caption its own line is still step 4 of the build.

Reading the new frames as pictures (I looked at the lane-sized captures of
variant 4 at all three widths in Ukrainian, and at the viewer opened on the
phone frame on the phone):

- On the desktop each variant shows one desktop, one pane and one phone
  capture, 150 px tall, then "+21" ("+33" in variant 4). The three are told
  apart by their proportions at a glance, and the variant number printed on
  each is readable.
- In the 440 px pane a row is a desktop tile, a pane tile, a narrow phone
  tile, a second desktop tile, and a fifth tile cut by the pane's edge, which
  says the strip goes on.
- On the phone a row is a desktop tile, a pane tile, a phone tile and a
  fourth tile cut by the edge.
- The viewer opened from the phone tile shows the phone frame at the pane's
  full width, "65 / 126".

### Recommendation: variant 4

It matches the words of the request most closely: a button, it expands, it
shows the collage the agent left. It takes the fewest presses to a frame and to
a choice at every width, and it adds the least: one card in the feed and one
gesture in the existing viewer. It builds no second full-screen surface, which
is the kind of addition the operator has turned down before.

What it gives up, plainly:

- No side-by-side view. Two variants are compared by stepping between two
  frames in the viewer.
- A variant shows one row of frames and no more. The row begins with the
  first frame of each captured width, so with three widths those three are
  on screen at every width measured. With six frames a variant a third of
  them are a sideways drag away on the phone; with 24, the other 21 are
  behind "+21" on the desktop or a sideways drag in a narrow pane, or steps
  in the viewer from their width's first frame (up to seven in this lane's
  set).
- Of a width's frames the one on screen is the first by name. In this lane's
  set that is the closed state in English; the Ukrainian one is four steps on
  in the viewer.
- The frames of no variant have a row and no tiles.
- More than four variants are not measured. Four and the row of the frames
  of no variant fill a 440 px pane's feed and the phone's with the strips at
  56 and 68 px; a fifth variant brings the strips to their least, 48 px, and
  past that the collage is taller than the feed and the feed scrolls.
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
   forms, the file-name convention over a directory's own files (no
   subdirectories), the store, the bounds, the two read routes,
   removal by lifetime and by the store's bounds. The model file's types and
   rules move to `src/lib/frameSets/`.
2. The set's row as a derived row that closes its turn, aligned to the
   answer's text column, and the card in it: the closed row and the collage
   in both forms, one row of tiles a variant that begins with the first frame
   of each captured width, with "+N" in the wide form, the
   strip's height taken from the feed's own between 48 px and 60 px (72 px
   with a touch pointer), the row of the frames of no variant, in English and
   Ukrainian. The publishing call's own row leaves the feed. The states "no
   longer kept" and "not on this machine". A feed on its tail stays on it
   when the message field grows under a chosen reply.
3. `frameSets` in the `get_pipeline` stage answer and the `frames:` line in
   the seat tick wake, the row drawn from that line, and the line left out of
   the wake's shown text. One row for one set id in a turn, whichever of the
   two named it.
4. Swipe in `Lightbox` for an unzoomed picture, and on a narrow screen the
   caption on a line of its own under the header, so a frame's width and
   language are read whole.
5. `frameSet` in `telegram_bot_send_media`.
6. One paragraph in the agent prompt contract: a design or UI lane publishes
   its frames with `publish_frames`, by directory, in one call: the whole
   directory is the set, up to 240 frames. Names follow the convention of
   section 2, and a driver numbers its moments so that a variant's frames
   stand in the order they were taken. Nothing is renamed for the collage's
   sake. It says where a driver writes them: the driver's default under `.artifacts/` in the worktree, or a
   directory under `/var/tmp`; a run isolated under `/tmp` keeps its output
   directory (`LLV_FRAME_SETS_OUT` for the conversation driver) out of `/tmp`.
   Nothing in it asks an agent to pass an id on.
7. The prototype files are deleted. The driver block stays and is pointed at
   the real card, with the same closed, open, lane-sized and arrival
   measurements.

## What this round did not prove

- **Claude transcripts.** The prototype runs over a Codex transcript only. A
  Claude tool call becomes the same kind of feed row and the row is derived
  from the parsed turn, so the same code serves both; the build lane runs the
  driver block over a Claude transcript too.
- **The wake's `frames:` line**, as said in section 2.
- **The store.** Nothing is copied yet: `publish_frames`, the store and its
  two routes are the build lane's. That the Viewer can read a lane's worktree
  and write its state directory in the container installation too was read in
  the code (the compose file mounts the home directory) and not run.
- **The strip's height** follows the feed in the prototype only downwards:
  60 px (72 px with a touch pointer) when there is room, less when there is
  not, 48 px at least. The build may also let a tall pane have larger tiles.
- **The viewer's caption on the phone** is still cut in the captures after
  the variant, the width and the language, as said in section 5; the fix is
  in `Lightbox`, a product file this lane does not change.
- **Other mixes of widths.** Both sets are captured at three widths. A
  variant captured at more widths than its row has room for (five on the
  desktop's half row, say) shows the first of them, and the rest are behind
  "+N" or a drag; that follows from the rule and is in no capture.
- **The refusal for `/tmp`** is a pure rule with a test. The tool that would
  say it is the build lane's.
- **Sets with other shapes.** Two sets are measured: six frames a variant,
  and this lane's own directory. A set with more than four variants, and a
  row between 560 and 960 px wide (one column of the wide form, which no
  measured pane has), are covered by the layout rule's test (`collageRow`)
  and by no capture.
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
| "it expands" | Variant 4 opens in place, in the feed, and the feed stays on its tail, with 24 frames and with this lane's own 126 |
| "shows the photos, the collage the agent left" | In each variant a frame of every captured width at its own proportions, one row a variant, the rest one press or a drag away; kept after the worktree is gone |
| "the design needs thinking through" | Four working prototypes, measured, reviewed four times as the operator would, revised, with a recommendation |
| Nothing on top of anything while closed | Measured in 24 panes, section 4 |
| Frames an agent left reach the operator | A driver's whole directory is one call; this lane's own 126 names pass the rule in a test. Read from the worktree, the stage's directory and `/var/tmp`; a directory under `/tmp` is refused with the command that moves it, section 2 |
| A chosen variant lands in the field, editable | Measured in 24 panes, section 4 |
