# Task prototype review: server and interface contract

This implementation follows the operator's 2026-10-06 task review request and
supersedes draft #2521. The server and the typed hooks come first below; the
interface built on them is described in the last section.

Agents call `publish_prototype_review` with `clientRequestId`, `title` and
`variants: [{number, name, description}]`. The short form adds `dir`; immediate
media files follow `variant-N` or `vN`, width, `en`/`uk` and caption naming.
Matching `-original` and `-changed` image suffixes produce a pair. Subdirectories
are skipped. The full form supplies each variant's `frames` with `path`,
optional `originalPath`, `caption`, optional `width` and `lang`, and `videos`
with `path` and `caption`. A pipeline caller inherits its pipeline's sole task;
a caller outside a pipeline supplies `taskId` in its own project. Replay uses
the same publication key and payload, including after the source disappears.
`read_prototype_review` returns history and the exact saved choice and comment.

Metadata is a task extension in the existing SQLite task store. Private copies
are in `state/prototype-reviews/<review id>/`; no upload occurs. Source reads
reuse the image viewer's home/worktree and evidence roots (normally `/var/tmp`),
realpath admission and byte sniffing. Refusal gives the existing copy instruction.
Images use `/api/image` with task, review and media IDs. MP4 and WebM use the
task's video route, descriptor pinning, MIME sniffing and byte ranges. Both
routes enforce the existing origin and team fences and the caller's project.

The roots are checked against the file that was opened. `O_NOFOLLOW` guards
only a path's last component, so a directory above it swapped for a link
between the check and the open would hand back a file from elsewhere. After
the open, `openedAt` (`src/lib/artifact/localFile.ts`) asks the kernel for
the open file's own name (`/proc/self/fd`) and requires the admitted path;
where the platform publishes no such name the path is resolved again and must
lead to the same inode. Publication copies and both media routes use it, and
so do the path routes (`/api/image?path=`, `/api/artifact`, the report frame
route) through `openAdmitted`: they keep a descriptor only when the open file
lies at the path that was admitted, and read every byte from it. The
store's root is resolved once and may be reached through a link (a chosen
`LLV_STATE_DIR`); nothing below the root may be a link, and a read reports a
copy as available by the same test the route serves it by.

The store is fenced from every path route. `fencedStores()` in
`src/lib/artifact/localFile.ts` names it, and the shared admission
(`admittedAs`, `realpathAdmitted`) refuses a path that lies in it as written or
after its links resolve, so `/api/image?path=`, `/api/artifact`, the report
frame route and the task album cannot hand out a copy, and a stored copy is
never the source of another publication. A copy answers only through its
manifest, its task and its caller.

A task's review belongs to its project, and the board reads have no project
fence. A caller that presents a capability therefore gets `/api/files`,
`/api/tasks` and every task write's answer (create, edit, assignment, send,
spawn, curator) without the rounds, the summary and
`prototypeReviewNotices`; the write answers share one projection,
`taskForResponse`, which leaves the operator's interface the summary; `/api/files` keeps that body in a cache scope of its
own, so the operator's cached body, its ETag and its deltas never reach an
agent. Agents read a review through `read_prototype_review`, which checks the
project.

Bounds: 9 variants, 240 media files including originals, 4 MiB per image,
64 MiB per video, 48 MiB images and 192 MiB total per round. At publication,
copies on tasks completed over 30 days ago are retired, then oldest copies are
retired until the store holds at most 200 rounds and 2 GiB of declared media.
Retirement keeps all round metadata and decisions, marks media unavailable and
removes owned copies.

One task's history is bounded too: 30 rounds and 1 MiB of round metadata,
measured at publication. The new round supersedes every undecided round before
it, so when the budget is full those leave first, oldest first, with their
copies. A decided round is never dropped: its chosen variants, its exact
comment and its time stay. A task whose budget is all decisions takes no
further round; the publication answers 409, says nothing was published and
tells the agent to publish on a follow-up task. A read therefore walks at most
30 rounds per task. The next publication removes marked orphan copies from
deleted tasks or interrupted publication. The task sync v5 wire carries public round metadata,
including decisions, without bytes, URLs or dispatch keys; older peers retain
their previous row shape. The existing 170 KB wire row bound keeps the summary
and as much recent history as fits, prioritizing the waiting round. A shortened
replica sets `historyTruncated`; complete history remains on its owner. A linked
read shows `unavailable: "another-installation"` and cannot
save a decision or dispatch its message.

Only the operator can decide. A decision is immutable, persisted before sending,
and retains its recipient and deterministic message key. The existing composer
send path admits it with operator origin and the exact comment inside the
message. Receipt and admission-ledger recovery handle reloads, lost acknowledgements
and compacted keys. A failed operation retries through the existing retry route;
unknown delivery waits for evidence. With no designated seat the decision stays
saved as `no-orchestrator`; an explicit retry can resolve a subsequently seated
orchestrator. No automatic resend occurs on a read.

A Viewer stopped between the saved decision and the message's admission leaves
a decision whose message was never sent. Reads take the decision's lock, so no
send is in flight when one looks: a message the send path has no record of is
then recorded as `failed`, which is what offers the retry. The retry checks
admission and receipt again before it sends, so repeating it, or reloading,
never sends twice, and a message that is in flight stays `pending` with no
retry.

The decision's lock is one per round, and taking it leaves a queue directory
beside the store's copies. The next publication removes the queue and any lock
file of a round no task holds any more; a round a task still holds, its
pictures retired or not, keeps both.

The interface imports client-safe contracts from
`src/lib/prototypeReview/types.ts` and these hooks from
`src/hooks/usePrototypeReview.ts`:

- `usePrototypeReviewSummary(task)` reads the card state from the existing board
  poll without a request per card. No summary means no review; `waitingReviewId`
  identifies the newest undecided round; `decision` describes the latest choice.
- `usePrototypeReview(taskId, enabled)` returns `data`, `loading`, `error`,
  `saving`, `refresh`, `save({reviewId, chosen, comment})` and `retry(reviewId)`.
  It polls while open, cancels reads on close and discards stale task responses.
  Each media entry includes `available` and `url`; an original stays beside its
  changed frame. Pair and viewer labels combine the variant's number, name and
  the frame's caption. `decision.delivery` exposes state and retry availability.
- `usePrototypeReviewNotices(tasks, project)` returns one notice per waiting
  task and `needsYouCount`. `/api/files` also exposes `prototypeReviewNotices`.
  A waiting review is an entry of the one needs-you queue
  (`buildNeedsYouQueue`, kind `prototype`, one per task), so the header's
  count, the panel, the rail, the phone's badge and sheet and the tab title
  count it; its row opens the task's review and has no «Dismiss», because the
  choice is what clears it. The kanban model marks the card from the same fact.
- `openPrototypeReview(target)` and `usePrototypeReviewJump(onOpen)` share the
  notice/card navigation event. Its target names the task and review to open.
  The interface focuses the task before opening the requested round.


Production-seam tests are `src/lib/prototypeReview/http.test.ts`,
`src/lib/prototypeReview/fences.test.ts` and
`src/lib/prototypeReview/decision.integration.test.ts`. The fences file swaps
a directory for a link exactly while a file is opened, on publication and on
both media routes, and covers the linked state root, the path routes and the
history budget. The integration file uses the existing fake engine fixture
with the real send handler, registry, runtime journal and retry leaf; its
stopped-Viewer case ends a real child process (`decisionStopChild.ts`) between
the saved decision and its admission. Task sync, prompt and needs-you regressions extend their
existing test files. Run every file in a separate process with isolated
`LLV_STATE_DIR`, `HOME`, `TMPDIR` and a closed `LLV_VIEWER_CONTROL_URL`.

## The interface

Everything lives in `src/components/prototypeReview/`. `PrototypeReviewHost`
is mounted once in the Viewer: it opens the review a card or a notice asks
for through `openPrototypeReview`, and hands the waiting notices of the page's
task poll to the orchestrator's composer.

**The card button** (`CardPrototypeButton`, in the card's foot before the
album) is absent while the task has no review. A waiting round this browser has
not opened draws a soft accent fill and a dot (`ready`); once opened and left
undecided it keeps the accent mark without the fill (`opened`, remembered in
`localStorage`); a decided review shows a check and the chosen numbers
(`decided`); a decision whose message failed or is unconfirmed shows an amber
dot in the check's place (`unsent`). A newer round after a decision is `ready`
again. The word "Prototype" is drawn where the foot is at least 480 px wide; a
narrower foot keeps the mark and the dot. A card that waits only on its review
adds no reason line and no dismissal to its foot: the choice is what clears it.
The phone's task screen carries the same entry as a row (`PhonePrototypeRow`).

**The orchestrator's notice** (`PrototypeNoticeRow`) stands above the seat's
message field, where the task chips stand: one line per waiting task with
"Go to prototype". Two lines show on the desktop and one on the phone; the rest
fold behind a count. Where the composer is put away, one chip carries the
notice and its count: on the folded seat's strip and on the phone board's seat
card (`PrototypeNoticeChip`). The action brings the task up on the board, or
pushes its screen on the phone, and opens the review over it.

**The review** (`PrototypeReview`) is a dialog on the desktop and the existing
`MobileSheet` on the phone. The variants are a list beside the stage (a row of
chips on the phone), each with its number, name and description. The stage
shows one picture at a time under a line with the variant's number, its name
and the picture's caption; a strip of thumbnails holds the variant's other
pictures and videos and scrolls sideways. An original and its change are shown
side by side or under a slider over one frame. A click, or the zoom button,
opens the existing `Lightbox` over the whole round, an original right before
its change. A video plays in place from the store's own copy. The choice is the
variant's number box; the comment field carries the composer's microphone
(`useDictation` and `MicButtonView`, wired as the composer wires them). The
saved decision replaces the field: the chosen variants, the comment, the time
and what happened to the message, with a retry where the server allows one.
Earlier rounds open from the header's round buttons.

Keys: Left and Right step through the round's pictures, 1 to 9 toggle a
variant, Escape closes and asks first when a comment was typed or dictated and
not saved. A text field and a playing video keep their own keys.

Rendered evidence comes from the two existing drivers. One `describe` block
in `src/components/kanban/kanbanBoard.browser.test.tsx` runs the `?proto=1`
scenario of the board fixture at 1440, 1000 and 390, in English and Ukrainian,
light and dark: the card button, the notice in the orchestrator's pane and on
the phone's seat card with its jump, the needs-you count with the waiting
reviews' rows and their jump (the count falls by one with each saved choice),
and every state of the review. One `describe` block in
`src/components/conversation/conversationWindow.browser.test.tsx` opens the
orchestrator's composer on the phone (`?case=prototype-notice`) and reads the
notice above the message field, the count folded behind it, the unfolded list
and the jump into the review, in both languages and both themes. Readings are
in `evidence/prototype-review/readings.json` and
`evidence/prototype-review/composer-notice.json`; frames stay under
`$HOME/Projects/delegatus-wt/handoff/prototype-review/`.
