# A cold conversation link survives an unavailable projection

Status: design for one implementation lane. Base: `587b78ca` on `main`.

## 1. Originating requirement

On 2026-10-26, around 13:15 UTC, the operator reported through the operator
request audit that a conversation would not open at all. The verbatim report
and the later operator decision are kept in the private task record and are
not reproduced here. That later decision, dated 2026-11-06, asked the agents to
set up the browser access they needed themselves. The access setup is done and
is out of scope.

The requirement in plain terms: a person who follows a link to a conversation
sees that conversation open, or sees why it has not opened yet. They never sit
on an unrelated board with no explanation.

The lane closes the defect in the source. Deploying the fix and repeating the
four cold opens as the intended member on the installed Delegatus happen in a
later stage of the same task.

## 2. What was observed

The evidence comes from cold opens on 2026-11-06 between 13:11 and 13:18 UTC
on the installation at `37556e0b`. A saved browser member with the `member`
role ran them. Each run used a fresh Chromium, the real `/#c=<conversation id>`
link, and a 120 s budget for the transcript's text to appear. Conversation A
is the second attempt of a visual-critic stage. Conversation B is its first
attempt. Both are beyond the plain catalog's cap. The per-run JSON request
records and screenshots are in the worker's retained private evidence
directory. I read them directly and looked at the frames myself.

| Run | Start (UTC) | Viewport | Outcome |
|---|---|---|---|
| A desktop | 13:11:18 | 1440×900 | no content in 120 s; `500` at 110.2 s |
| A phone | 13:14:03 | 390×844 | content at 14.8 s |
| B desktop | 13:14:26 | 1440×900 | no content in 120 s; `500` at 97.5 s |
| B phone | 13:16:28 | 390×844 | content at 31.5 s |
| A desktop rerun | ~13:17 | 1440×900 | content at 27.8 s |
| B desktop rerun | ~13:17 | 1440×900 | content at 26.2 s |

These are single observations under the host's load at that time. They support
no comparison between desktop and phone speed.

### 2.1 The request sequence in the records

The records keep the URL with its query string for every failed or aborted
request and for every response of 400 or above. They keep only the pathname for
the first 80 successful API responses. In the failing desktop run for A:

1. At 8.6 s, `GET /api/files?view=summary` (the plain catalog) answers `200`.
   The target is not in it.
2. The link then asks for its own scope with
   `/api/files?view=summary&path=<conversation id>`. A request for that scope
   is aborted at 76.0 s.
3. From 76.8 s the presence heartbeat names the target's project; before that
   it named the Overview. So the link resolved and selected the target's project.
4. The client then asks for a second scope,
   `/api/files?view=summary&path=<transcript path>`. At 110.2 s that request
   receives `500`. The worker's journal reading puts
   `FilesProjectionQueueError … waited 30216ms … past 30000ms` at 13:13:08.
   That matches 13:11:18.2 plus 110.2 s.
5. The final frame at about 121 s shows the target's project board with its
   seat window expanded. The header reads `reconnecting · showing <time>` and
   no reader for the target is open.

The failing desktop run for B has the same shape. Its id-scope request is
aborted at 67.1 s and its transcript-path scope gets `500` at 97.5 s. Its final
frame is the same.

All six runs ask for both scopes. Five records show the transcript-path URL
explicitly. The sixth (B desktop rerun) shows a further successful
`/api/files` response 1.3 s after the id-scope abort, and its query string was
not recorded. In the passing runs the second scope answered within seconds and
the transcript opened scrolled to its latest message. The scroll offset plus
the client height equals the scroll height in all four passing records.

### 2.2 Correction to the earlier attribution

The earlier diagnosis said the desktop link stayed on the orchestrator because
the first projection was unavailable. The records show something else. The
first pinned scope answered, and the link resolved and selected its project.
The `500` belongs to a second, client-initiated cold scope. While that second
scope was pending, the target was no longer on the board.

## 3. The source chain

### 3.1 Server: a queue refusal for a scope with nothing to serve becomes a 500

- `src/app/api/files/projectionQueue.ts:85-95` rejects a queued build with
  `FilesProjectionQueueError("expired")` once it has waited `maxWaitMs`.
  Lines 133-136 reject a new build with `("full")` when `maxDepth` builds are
  waiting. The bounds are 16 and 30 s (`operatorProjection.ts:263-264`).
- `src/app/api/files/operatorProjection.ts:498-503` serves the scope's last
  representation on a queue refusal only `if (cached)`. A scope that was never
  built rethrows. A caller that joined the in-flight build (`:431`) and the
  caller that started it (`:553-557`) both reject.
- `GET` (`:605-619`) does not catch the error.
- For a member, `src/lib/team/workspaceFilesResponse.ts:36` awaits that `GET`,
  so the throw passes the responder's existing conversion of a non-200/304
  source into `503 board unavailable` (`:62-64`).
- `src/lib/team/workspaceRoute.ts:261-270` rethrows everything except a
  `WorkspaceRefusal`, and Next answers `500`.

### 3.2 Client: a resolved link moves its pin to a new cold scope and drops its row

- `src/components/Viewer.tsx:126-129` (`filesRequestPin`) pins a pending link
  by its hash identity, here the conversation id. After the link resolves, it
  pins `catalogPin.path`, which is the transcript path.
- On resolution, `Viewer.tsx:966-975` calls `openPinnedFile(hit, true)`
  (`:901-930`). That dispatches a `resolve` with `requested: true`, because the
  row is pin-only (`catalogHoldsWithoutPin`). It also clears `pendingHash`.
  On the next render the request pin changes from the conversation id to the
  transcript path.
- On the server those are two different pinned scans
  (`src/lib/scanner/scanCache.ts:998-1000` keys the scan by the pin value) and
  two different projection scopes (`operatorProjection.ts:247-254`). Each one
  is a whole-catalog projection built through the same bounded queue.
- `src/hooks/useFiles.ts:467-488` answers the new scope with a stand-in until
  its own response lands, and the stand-in removes every pin-only row by
  design. `Viewer.tsx:323-341` keeps `lastOpenedRow` only when an earlier
  render saw both the pin and the row. On a resolution render the scope has
  already moved, so the row is never captured. The board therefore has no row
  for the focused path, and nothing opens until the second scope answers.
- When that answer is a `500`, `useFiles.ts:668` and `:539-549` increment
  `catalogFailures`, which is the header's `reconnecting · showing <time>`.
  `useFiles.ts:1437-1461` retries with the existing doubling backoff, starting
  at 1 s with a 30 s ceiling. Whether the retry after the `500` fired before
  the 120 s budget ended is not in the record.
- While a link is pending, nothing on screen says so
  (`Viewer.tsx:2109-2124` draws only the final not-found notice).

A pin by conversation id already covers the target. `src/lib/scanner/index.ts:209-213`
expands a `conversation_…` pin to the conversation's latest generation and its
family, so the second scope adds no row that the first lacked.

### 3.3 Not established

- Why the first pinned scope took about 55–65 s (queue wait, build or scan).
  No server timing was recorded for successful responses.
- What filled the queue between 13:12 and 13:13 UTC.
- Whether the first pinned scope alone would always have answered within
  120 s under that load. It answered in about 55–65 s in two runs.
- The cause of the original report on 2026-10-26. It cannot be reproduced
  from this record.
- Why the phones passed. They issued the same two pins. My inference is that
  their second scope answered quickly at that moment, perhaps because the
  pinned scan was warm from the desktop run of the same conversation just
  before. I see no platform difference in the code.

## 4. Design

Three changes, each the smallest one that reaches its part of the chain. The
queue bounds, the workspace responder, the retry backoff and every
authorization check stay as they are.

### S1. Server: a controlled `503` at the HTTP boundary

In `src/app/api/files/operatorProjection.ts`, `GET` catches
`FilesProjectionQueueError` around `getFiles(...)` and returns:

- status `503` and `cache-control: no-store`;
- `x-llv-files-projection-cache: unavailable`;
- a JSON body
  `{ "error": "files projection unavailable", "code": "files_projection_unavailable", "reason": "expired" | "full" }`
  with no rows, no ETag and no build stamp;
- `server-timing: files-worker-queue;dur=<waited>;desc="<reason>"`.

It also writes one `console.warn` line, because the `500` exception log was the
only record of this event and must not disappear:
`[files projection] <reason> for a scope with nothing to serve: waited <ms>ms; waiting <n>, expired <n>, refused <n>; pinned <yes|no>, summary <yes|no>, agent <yes|no>`.
The values come from `filesProjectionQueueDiagnostics()` and the request's
scope flags. The line carries no path, id or caller identity.

The catch sits in `GET`, so the internal callers that use `getFiles` keep
their current semantics. `prepareBoardSummary` and the bootstrap refinement
(`:639-681`) call `getFiles` directly and treat a throw as "not prepared, retry
later". A `503` response there would read as success and drop the saved
bootstrap. `operatorBoardBody` (`:828-837`) calls `projectionFor` and is
unchanged.

A warm scope keeps today's answer: on a refusal it serves its last
representation as `stale` (`:498-502`). Nothing else changes in the queue:
there is no new limit, no priority and no retry.

### C1. Client: a resolved link keeps the scope that resolved it

The goal is one cold scope per link.

- `CatalogPinState` (`Viewer.tsx:153`) gains `pin: string | null`, the request
  pin under which the row was resolved. The `open` and `resolve` events carry
  it as an optional `pin`. `reduceCatalogPin` stores it, and the `files` event
  keeps it when `currentPath` retargets the path.
- `openPinnedFile(file, hydrated, pin?)` passes it on in both dispatch sites,
  the phone Overview branch and the desktop branch.
- The resolve effect (`:965-976`) passes
  `wantsHashPin ? filesRequestPin(pendingHash, null, true) : null`, and
  `wantsHashPin` joins its dependency list.
- The `useFiles` call (`:273`) requests
  `filesRequestPin(pendingHash, catalogPin?.requested ? (catalogPin.pin ?? catalogPin.path) : null, wantsHashPin)`.

The result: a `#c=` link that needed its own scope keeps requesting
`path=<conversation id>`. That scope is the one that already answered, so the
row stays on the board and no second whole-catalog build is queued. A `#f=`
link keeps its path pin, as before. A row opened from the catalog list or from
search passes no `pin` and keeps today's path pin. The pinned value is always
one the link already sent and the server already authorized.

### C2. Client: the pending link says so, on the existing notice

The pending state is one status strip in the flow of the main column, under the
board and beside the storage alert. The board gives it a line of its own, so no
text of the board, the sidebar, an open conversation or a field is drawn under
it, at any width. The first design drew it as a fixed pill at the bottom edge,
and a rendered review showed that pill over board text at 1440×900 and
1200×800, so the strip replaced it. No new component is added.

- A link shows the notice once it has been pending for 1 s
  (`LINK_PENDING_NOTICE_MS = 1_000`), while `pendingHash` is set and neither
  the not-found notice nor the unknown-fragment notice is up. The 1 s delay
  keeps a fast open from flashing it.
- Text while waiting: `viewer.linkOpening`, "Opening the linked conversation…"
  in English and «Відкриваю розмову за посиланням…» in Ukrainian.
- Text once a catalog request has failed while the link is pending
  (`catalogFailures > 0`): `viewer.linkRetrying`, "The linked conversation has
  not loaded yet. Trying again…" in English and «Розмова за посиланням ще не
  завантажилася. Пробую ще раз…» in Ukrainian.
- The waiting state uses a neutral tone already present in the app's status
  pills. The retrying state uses the warning tone of the not-found notice.
  Both keep `role="status"` and add `data-link-pending-notice` with the state
  name (`opening` or `retrying`) as its value, so tests and drivers can find
  it.
- The notice disappears when the link resolves, when it reaches the existing
  not-found state, or when the person navigates. All three already clear
  `pendingHash`. It has no button: a project click or another link cancels
  the intent, exactly as today.

The recovery path is the existing one: the bounded hydrate backoff refetches
the pinned scope, and the existing resolve effect opens the conversation when
the scope answers, with no reload. The not-found clock (`:1005-1013`) still
starts only on a payload certified for the pinned scope, so a `503` never
turns into a false "no longer available".

## 5. State flow after the change

| Moment | Request scope | Board | Notice |
|---|---|---|---|
| Page loads with `#c=` | plain catalog | stored or default project | none |
| Plain catalog lacks the target | `path=<id>` (cold) | unchanged; stand-in rows | "Opening…" after 1 s |
| Server queue refuses the scope | `503`; existing backoff schedules a retry | unchanged | "…not loaded yet. Trying again…"; header `reconnecting` (existing) |
| Retry answers `200` with the target | same `path=<id>` scope | target's project; target opens at its latest message | gone |
| Later polls | same `path=<id>`, conditional | target stays open | none |
| Person follows another link or a project first | new intent; old scope's fetch aborted | the new target | follows the new intent |

## 6. Authorization invariants

1. `workspaceRoute` resolves the project of the `path` value, whether a
   conversation id or a transcript path, and refuses a foreign or unknown
   project with `403` before the handler runs (`workspaceRoute.ts:255-260`).
   No session gives `401` (`:247`). Neither path reaches the projection queue.
   S1 runs only inside the handler.
2. The `503` body carries no rows, scope data, ETag or build stamp, so no
   caller can learn anything from it about another scope.
3. A member's request still reaches the operator projection only through
   `createWorkspaceFilesResponder`, which turns every non-200/304 source answer
   into its own `503 board unavailable` without reading its cache
   (`workspaceFilesResponse.ts:62-64`).
4. The read-after check (`workspaceRoute.ts:262-267`) still runs after the
   handler returns, so membership revoked during a queue wait gives `403`.
5. C1 never widens what the client asks for: the retained pin is a value the
   same link already sent and the server already authorized.
6. A `401` or `403` on the pinned scope still runs `accessDenied`
   (`useFiles.ts` 304/401/403 branch), so restored rows are cleared.

## 7. Tests: red on base `587b78ca`, green on the head

Run each file by explicit path through the project's `scripts/gate-slot.sh`
wrapper. Use an isolated `HOME`, `XDG_CONFIG_HOME`, `LLV_STATE_DIR` and
`TMPDIR` under the stage scratch, and set `LLV_VIEWER_CONTROL_URL` to a closed
port. Record each command's own exit status in a fresh log. Prove "red on
base" by running the new cases against a scratch export of `587b78ca` with the
same command.

### `src/app/api/files/route.test.ts` (operator path, production route and queue)

These cases use the module's own queue slot, `globalThis.__llvFilesProjectionQueue`,
replaced with a `createFilesProjectionQueue` whose single active slot holds a
build that has not resolved yet. The queue runs on a clock and a deadline timer
the test owns, with the production bound of 30 s: a request waits until the
queue has armed the build's deadline, and the deadline passes when the test
advances the clock, never after a real delay. They use the worker runtime seam
the existing cold-scope tests use (`setFilesResponseWorkerRuntimeForTests`).

1. **Cold scope, expiry.** A pinned scope with no cached representation gives
   `503` with `code: "files_projection_unavailable"`, `reason: "expired"`,
   `x-llv-files-projection-cache: unavailable` and `cache-control: no-store`.
   The body has no `files` and there is no `etag`. *Red on base*: `GET`
   rejects with `FilesProjectionQueueError`.
2. **Cold scope, full queue.** A second distinct cold scope while the depth is
   taken gives `503` with `reason: "full"`, at once. *Red on base*.
3. **Joined callers.** Two concurrent requests for the same cold scope both
   get `503`, and the queue's diagnostics show one queued build. *Red on base*.
4. **Warm scope.** A scope that holds a cached representation, after its key
   moves, gives `200` with that cached body and
   `x-llv-files-projection-cache: stale`. This is today's behaviour and stays
   green on both.
5. **Recovery.** With the held build released and the real worker, the same
   cold scope then gives `200` with its pinned row.
6. **Internal boundary.** `prepareBoardSummary(true)` with a refusing queue
   still rejects. This guards S1's placement: it fails if the conversion moves
   into `getFiles`.

### `src/lib/team/workspaceAccess.test.ts` (member path, real `/api/files` route)

Add these to the existing member harness, with the same held queue:

7. A member's `path=<own project's conversation id>` gives `503` with no rows.
   *Red on base*: the route rejects.
8. A member's `path=<foreign project's conversation id>` gives
   `403 workspace_forbidden`, and the queue diagnostics do not move.
9. Membership removed while the request waits in the queue gives `403`.
10. No session gives `401`.

### `src/components/Viewer.deepLink.dom.test.tsx` (real Viewer, real `useFiles`)

The stub answers pinned scopes with
`pinOverlayPaths: [<target path>]`, as production does. The cases in this group
own the clock (`jest.useFakeTimers`): an answer the case wants late is held on
a promise the case releases, and a held request ends with an `AbortError` when
its signal fires, as a real fetch does. Time passes only by the amounts the
case advances, in steps that read state (the notice kind, the board), so a
paused event loop cannot change what they observe. A retry or a notice that
must not happen is shown absent after the clock has passed the longest retry
delay (30 s).

11. **The pin stays.** The id scope carries the target, and the transcript-path
    scope always answers `503`. The target opens and is still open 1 s later.
    There are zero requests with `path=<transcript path>`, and no
    `reconnecting` state. *Red on base*: the pin moves, the row disappears
    and the `503` raises `catalogFailures`.
12. **Unavailable, then available.** The id scope answers `503` twice, then
    `200`. `[data-link-pending-notice="opening"]` appears after 1 s and
    becomes `retrying` after the first `503`. The target then opens with no
    remount. The notice is gone and the not-found notice never appeared.
    *Red on base*: no pending notice exists.
13. **Target change.** Link A is pending on a held `503`, and the hash changes
    to link B. B opens. When A's scope becomes available, A never opens, the
    hash stays on B, and no request for A's scope starts after the change.
14. **Navigation cancels.** While a link is pending, a project selection
    clears the notice and the intent, and no further request for the link's
    scope starts.
15. The existing cases in the file stay green: archived predecessor, `#f=`,
    the not-found deadline, search selection, and no pin when the plain
    catalog holds the target.

### `src/components/Viewer.test.ts`

16. `reduceCatalogPin` keeps `pin` through `resolve` and a `files` event with
    `currentPath`. `filesRequestPin` with a retained `pin` returns it.

### `src/lib/i18n/i18n.test.ts`

17. The two new keys exist in English and Ukrainian (the existing parity
    test).

## 8. Rendered evidence through the existing kanban driver

Add one `describe` block, "cold conversation link", to
`src/components/kanban/kanbanBoard.browser.test.tsx` over
`issue1695Evidence.fixture.tsx`. Do not add a new driver. The fixture gets a
`scenario=cold-link` branch inside its in-page `/api/files` handler, placed
just before the generic handler. That keeps it away from the scenario-routing
lines that open pull requests edit. The branch:

- leaves two existing fixture conversations with transcript content (A and B)
  out of the plain scope, and leaves a third (X) out as well;
- answers `path=<id>` for each of them with `503 files_projection_unavailable`
  until the driver calls `window.__coldLink.release(id)`, then with `200`
  carrying the row in `files` and `pinOverlayPaths`;
- records every `/api/files` URL in `window.__coldLink.calls`.

The sequence, in each run:

1. Open `#c=X`.
2. Change the hash to `#c=A`.
3. Frame **pending**.
4. Let the first `503` for A arrive.
5. Frame **retrying**.
6. Release X, and assert X never opens.
7. Release A.
8. Frame **opened**: A's transcript is visible and scrolled to its latest
   message.

Then assert `location.hash === "#c=A"`, that no URL in `calls` has a
transcript-path pin, and that `calls` has no request for X's scope after the
hash change.

The runs cover 1440×900, 1200×800, 1000×700, 700×800 (a narrow desktop,
between the named 1000 and 390) and 390×844 (phone), each in `en` and `uk`,
`light` and `dark`. That is 20 runs and 60 frames, written under
`LLV_EVIDENCE_DIR`.

In every frame, the driver measures from text ranges that:

- the notice is inside the viewport and shares no pixel with any other visible
  text range on the page (header, search field, phone top bar, board columns
  and cards, sidebar, seat window title, conversation reader);
- its text meets the contrast floor.

In the opened frame, the transcript
reader is the visible pane, and its scroll offset plus the client height
equals the scroll height.

Run the driver through `scripts/gate-slot.sh` with `LLV_KANBAN_BROWSER_TEST=1`
and `CHROME_BIN`, in isolated state, with a short Chrome `TMPDIR`. Look at every
frame before citing it.

## 9. Files the lane touches

- `src/app/api/files/operatorProjection.ts` (S1)
- `src/components/Viewer.tsx` (C1, C2)
- `src/lib/i18n/en.ts` and `src/lib/i18n/uk.ts` (two keys each)
- the tests above
- `src/components/kanban/kanbanBoard.browser.test.tsx` and
  `src/components/kanban/issue1695Evidence.fixture.tsx` (the evidence case)

Untouched: `projectionQueue.ts` and its bounds, `workspaceFilesResponse.ts`,
`workspaceRoute.ts`, `useFiles.ts`, the scanner, and the board's memory or
summary-size work, which belongs to the parent memory and performance task.

## 10. Overlap with open work (checked 2026-11-06)

No open pull request or recent branch changes `operatorProjection.ts`,
`projectionQueue.ts`, `useFiles.ts`, the deep-link code in `Viewer.tsx`,
`workspaceFilesResponse.ts` or `Viewer.deepLink.dom.test.tsx`. The one recent
branch that touched `operatorProjection.ts` is identical to `main` in that
file.

These open pull requests touch files this lane edits, in other hunks:

- The settings window lane edits `Viewer.tsx` imports and its host mounts.
  It also edits the kanban driver, its fixture and harness, and i18n.
- The composer, task files and accounts-row lanes add i18n keys and fixture
  scenario lines next to the fixture's routing block.

Every overlap is a separate hunk, and conflicts would be mechanical. No active
writer blocks this lane.

## 11. Validation against the requirement

- **The link opens, or says why not.** S1 replaces the `500` with a controlled
  `503` that the existing retry recovers from. C1 removes the second cold
  scope that produced the observed `500` and that took the target off the
  board. C2 tells the person that a link is opening or retrying while the
  board underneath stays as it was.
- **The bounds stay.** The queue stays at 16 builds and 30 s. Nothing returns
  an empty success, serves another scope's data, or adds unlimited retry. The
  existing backoff keeps its 30 s ceiling.
- **Under sustained saturation** a link can still wait. It then says so and
  opens when its scope answers. The later installed acceptance shows how long
  that takes on the real host.

## 12. Alternatives considered

- **Serve the global representation for a cold pinned scope.** Rejected. The
  client would certify a scope without the target, and the not-found notice
  would fire falsely after 8 s. It also serves another scope's data.
- **Build inline on the Viewer's main loop when the queue refuses.** Rejected.
  It runs a whole-catalog build on the request thread exactly when the host
  is loaded.
- **Capture `lastOpenedRow` at resolution only.** Rejected as the fix. It
  hides the symptom and still queues a second whole-catalog build for every
  beyond-cap link.
- **A client change alone.** Rejected. A refused cold scope would still be an
  unhandled server exception that is logged and answered as a crash.

## 13. Deferred — not currently justified

- **Cold-first ordering in the projection queue**, so a scope with nothing to
  serve runs before refreshes of scopes that already serve a cached body.
  This needs the queue's composition at the moment of refusal. S1's warning
  line records waiting, expired and refused counts and the scope's kind at
  each refusal, including refusals that produce no successful build. That is
  the measurement a follow-up would cite.
- **Removing a queued build when every caller has aborted.** Builds are
  already joined per scope, so abandoned tabs do not multiply them. There is
  no evidence that abandoned builds filled the queue.
- **Making a pinned scope cheaper than a whole-catalog projection,** such as
  a single-row pin lookup beside the global representation, and reducing the
  member summary body (about 44 MB as measured by the worker). Both belong to
  the parent memory and performance task.
- **A separate header reach label for "server busy" versus "unreachable".**
  The link notice now explains the link itself. The global label is #696 and
  #2071 behaviour.
- **The Back/Forward replay's own 8 s stale timer** (`Viewer.tsx:654-670`).
  It starts whether or not the pinned scope has answered. Under the same load,
  a replayed entry to a beyond-cap conversation could report "no longer
  available" before its scope answers. That is a separate path from a pasted
  or opened link and was not observed here.
- **A `Retry-After` header.** The queue cannot promise a time, and the client
  keeps its own backoff.
- **Raising the queue's depth or wait.** Rejected by the requirement.

## 14. Later stage of the same task

After review and the required checks, a native deploy of the reviewed head
comes next. Then the original four cold opens are repeated: both conversations
at 1440×900 and 390×844, as the saved member, each in a fresh browser. The
acceptance is the transcript content, rendered and usable.
This lane does not mark the task done.
