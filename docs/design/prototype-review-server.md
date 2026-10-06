# Task prototype review: server and interface contract

This implementation follows the operator's 2026-10-06 task review request and
supersedes draft #2521. This stage supplies the server and typed interface
hooks. The card button, review modal or phone sheet, voice input reuse and
orchestrator notice are the following interface stage on this same branch.
Their browser evidence and measurements belong to that stage.

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

Bounds: 9 variants, 240 media files including originals, 4 MiB per image,
64 MiB per video, 48 MiB images and 192 MiB total per round. At publication,
copies on tasks completed over 30 days ago are retired, then oldest copies are
retired until the store holds at most 200 rounds and 2 GiB of declared media.
Retirement keeps all round metadata and decisions, marks media unavailable and
removes owned copies. The next publication removes marked orphan copies from
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
  task and `needsYouCount`. `/api/files` also exposes `prototypeReviewNotices`;
  the kanban model already counts waiting reviews once in needs-you totals.
- `openPrototypeReview(target)` and `usePrototypeReviewJump(onOpen)` share the
  notice/card navigation event. Its target names the task and review to open.
  The interface focuses the task before opening the requested round.

The interface stage reuses the existing image viewer, modal and mobile sheet,
composer microphone, and suggested-notice components. It supplies en/uk labels,
keyboard selection and the unsaved-comment guard, then extends the existing
kanban and conversation browser drivers. Captures stay under
`$HOME/Projects/delegatus-wt/handoff/prototype-review/`; commit measurements only.

Production-seam tests are `src/lib/prototypeReview/http.test.ts` and
`src/lib/prototypeReview/decision.integration.test.ts`. The latter uses the
existing fake engine fixture with the real send handler, registry, runtime
journal and retry leaf. Task sync, prompt and needs-you regressions extend their
existing test files. Run every file in a separate process with isolated
`LLV_STATE_DIR`, `HOME`, `TMPDIR` and a closed `LLV_VIEWER_CONTROL_URL`.
