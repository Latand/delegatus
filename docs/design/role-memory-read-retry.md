# Role-memory reads before dispatch

## Originating requirement

Accepted finding of 2026-10-24, filed under a standing operator instruction of
2026-10-19 to file and fix bugs (there is no direct operator quote for this
finding):

> Stage preparation must automatically recover transient role-memory failures
> within a bound, retain the real safe cause, and never dispatch unfiltered
> input.

The first delivery (#3678) added the bounded retry described in the next three
paragraphs. On 2026-11-06 the finding was reopened with this acceptance: the
privacy revision changes for every change that can affect filtering and for
nothing else; the artifact-fitting path picks its candidate without filtering
the whole prompt again for each try; the emitted prompt and every artifact are
filtered and byte bounded; a changed rule at any await before dispatch
invalidates the stale approval while a request-only write causes no rebuild;
an exhausted window names the window, separates it from a worker deadline and
reports safe phases; equivalent inputs give equivalent redaction; the
180-second bound, every caller field and every fail-closed check stay; no
timeout increase and no privacy bypass. Sections 1 to 4 below are that
revision.

Local pipeline recovery now also defers exhausted retryable preparation automatically; see [Role-memory privacy during stage launch](role-memory-privacy-timeout.md#implementation). The historical diagnosis below retains the original park outcome. Permanent refusals and uncertain reserved launches retain their existing fences.

## Bounded retry (#3678, unchanged)

Stage input preparation waits through transient privacy-worker timeouts and
busy role-memory reads for up to **180 seconds**. Backoff starts at one second,
doubles to a maximum of 30 seconds and yields asynchronously. Nested revision
checks, filtering and prompt/artifact composition share the original cutoff.
Each worker request includes queue time and gets at most 60 seconds, capped
to the time remaining. A result arriving at the cutoff is refused.

No prompt leaves privacy preparation during this wait. The worker still
filters against every stored rule, requires a complete matcher and verifies
the current revision before returning. Preparation checks its revision again
before accepting the result. Revoked operation leases stop retries and results.
The launch-side stability-wait revision read, cached-input revision read and
initial input revision read are inside the same retry mechanism as composition.
The stability-wait read and initial composition share one cutoff. The adapter's
later pre-delivery callback starts a new bounded preparation if needed; its
cached-input revision check is inside that callback's retry. Durable activation
input is updated only after preparation succeeds. The existing activation and
reservation checks still govern dispatch after preparation returns.

Timeout, busy-store, queue-capacity, retirement-timeout and revision-change
diagnostics are eligible for retry. Corruption, permission errors, invalid
replies, oversized requests, failed worker starts/exits, shutdown and unknown
errors refuse immediately. Exhaustion throws `LESSON_PRIVACY_UNAVAILABLE` with
the final category and the 180-second bound; the stage's existing failure path
parks it with that reason. Section 3 replaces how that reason is worded.

## Why the window ran out (evidence of 2026-11-06)

A read-only investigation of the serving release's source and its service
journal covered three refused starts (a UI fix, a review and an earlier
review attempt) and two successful starts on the same day. What it observed:

- Each refused start spent its whole window in one outer attempt. The journal
  shows a sequence of privacy-worker calls of 5 to 15 seconds each in the
  match phase, matcher recompiles of 5 to 7 seconds, and waits of up to about
  16 seconds behind task-export pages in the shared serial worker queue.
- Each refused window contained a `role_memory` write. In one window it was a
  rule; in another it was only a lesson-request row written when an unrelated
  stage reported. Each such write produced `store-changed`, a matcher
  recompile and a fresh composition. The successful windows contained no
  `role_memory` write.
- The final line was `worker-timeout` about 183 seconds after the start. That
  request's 60-second budget had been cut to the window's remainder, so the
  request was stopped by the end of the window while still inside its own
  budget. The refusal still named `worker-timeout`.
- No `worker-queue-full`, `store-busy` or lock wait appeared. A successful
  start also took about 95 seconds to prepare, so the margin is small.

Read in the current source (main at the start of this revision):

- `storedLessonRevision()` (`src/lib/memory/roleStore.ts`) is the file
  identity plus the revision of the whole `role_memory` collection. Lesson
  requests, lesson answers without a lesson, usage marks, problem delivery
  marks and scope bookkeeping all advance it, yet none of them carries text
  the filter reads (`lessonTextsOf` reads only rule rows' `rule` and `why`).
- `composeCurrentStageInput` (`src/lib/pipelines/stageInput.ts`) filters the
  full prompt first. When that is over the limit it filters the previous
  output, then filters a complete re-render for each of up to four excerpt
  sizes, then the specification, then up to four more complete re-renders,
  and in the last fallback filters the already filtered full prompt again: up
  to 12 worker calls in one composition attempt, 8 of them over whole
  candidate prompts. Nested `withCurrentRevision` loops (three attempts at
  each level) rerun calls after a revision change.
- `withPrivacyRetry` (`src/lib/memory/privacyRetry.ts`) reports
  `worker-timeout` when the window passes without any failure, and reports the
  category of a request whose budget the window cut.
- `RoleMemoryChanged` carries no category, so the retry loop logs it as
  `worker-unavailable; refusing` while rethrowing it to the engine's
  role-memory wait (a deferral, which is the intended behaviour).

What remains **unknown**: the exact composed size of the refused inputs (that
they took the artifact path is an inference from their input sizes, which
were close to the 32,000-byte message limit); which pipeline each worker call
belonged to (the journal carries no attempt identity); the host CPU share
during these windows; the cost of each section below on the production store.
This revision claims no speed or resource gain. It removes two mechanisms the
journal shows spending the window (request-only invalidation and repeated
whole-prompt filtering) and names the window honestly. The queue wait stays,
and whether 180 seconds is then always enough is not claimed.

## 1. A privacy revision that moves only with rule rows

**Definition.** For an initialized collection, `storedLessonRevision()`
returns the database file identity (device and inode), the collection's
`imported_at` generation and its durable rule-change counter. The counter
lives in `role_memory_privacy_revision`, independently of rule rows and the
pruned change journal. An absent collection keeps returning the empty string,
the affirmative empty store that lets `runPrivacyWork` skip the worker. The
value is opaque; it need not contain the state path.

**Why rule rows.** Every text the filter withholds comes from a rule row:
active, archived, merged and rewritten versions (`versionedRule` keeps the
prior text as an archived version row). Scope rows (active lists, histories,
targets) and request rows (lesson requests and their answers, usage marks,
problem delivery marks) hold no text the filter reads. So the revision moves
for a new lesson, a rewrite, a revert, an archive or restore, a scope change
of a rule, a curation pass and an import, and stays still for request and
scope bookkeeping.

**Why not a digest of the filtered texts.** The acceptance asks that deleting
(archiving) a rule changes the revision although an archived text is still
filtered. More importantly, a content digest can repeat: a rule rewritten and
then reverted returns to an earlier digest. The worker and the parent each
compare two reads of the revision around their work. With a repeating value, a
worker that matched with the intermediate rules could return a result under
the repeated value. The rule-change counter advances in SQLite triggers on
every insert, update or physical delete of a rule row. Imports, re-imports, collection
replacement and all collection write APIs pass through those triggers. The
counter survives the removal of every rule and change-journal pruning;
transaction rollback rolls it back with the write. Request and scope rows do
not advance it. Every process derives the same value from committed state,
including after restarting its reader or worker.

A maximum revision and count over surviving rule rows can repeat after an
insert/delete cycle. Retaining a separate counter also covers a temporary rule
inserted and deleted in the same transaction. The state schema's existing
startup authority installs the table and triggers for retained databases and
repairs missing objects. An unreadable counter refuses privacy work. The
counter table has one row and no collection foreign key, so a cascading
collection deletion cannot reset it. An integer overflow refuses the write.

**Computation, independent of retained history size.**

1. Keep the physical fast path: file identity from `fs.statSync` plus
   `stateDatabaseSignature`. If neither changed, return the cached value with
   no SQL. This keeps the existing fault-injection surface of the retry tests.
2. Otherwise, in one synchronous read transaction on a dedicated read-only
   connection, read the collection generation and the singleton rule-change
   counter. Before the first rule write, the absent counter row means zero.
3. End the transaction before returning. It is never held across an await.

The connection lives in `src/lib/memory/roleViewSource.ts`. Its dedicated slot
keeps it separate from a cooperative history cursor whose open snapshot could
hide a peer's commit. It uses the same `busy_timeout = 0`,
`openCurrentDatabase` reopening and attribution wrapper as its siblings, with
its own attribution label. Read errors go through `unreadableRoleMemory`:
an allowlisted category, fail closed.

A changed database costs two singleton metadata reads. Rule writes add a
transactional counter update. These operation counts describe the mechanism;
production latency and resource gains remain unmeasured.

**Consumers.** Every reader of the value was checked; each uses it only to
mean "the rules the filter reads have not changed": the matcher cache and its
compile recheck (`roleStore.ts`); `withCurrentRevision` (`privacy.ts`); the
composition fence (`stageInput.ts`); the stability wait, cached input and
Cloud input fence (`engine.ts`); the dispatch token (`structuredSpawn.ts`,
`structuredDeliveryQueue.ts`, both in the Viewer process); the parent and
worker checks (`taskPageWorker.ts`, `taskPage.worker.ts`); and linked-board
caches and fences (`taskPageBuild.ts`, `agentFeed.ts`, `taskExportPrivacy.ts`).
None versions learned-rule selection or scope content; those use
`roleViewVersion`, `roleRowRevisionToken` and the selection rows. Apart from
the files that sections 2 and 3 touch (section 4 lists them), no consumer
changes; each compares the new value with the same check.

**Small classification fix in the same file.** The compile recheck's refusal
("revision moved during compile") carries `store-changed`, a retryable
category. Today it carries no category and falls back to
`worker-unavailable`.

**Release switch.** The format changes once. Values persisted by the previous
release compare unequal on the first read after the switch. This is the same
event as a rule written at that moment. A stability wait starts its two
observations again, about half a second. A first message staged by the
previous release is refused before its native effect, with the existing
revision-change refusal. In `engine.ts`, the existing reconciliation reads
that recorded refusal as proof of non-execution and prepares the launch
again; this was read in the source and has not been run. The later installed
acceptance on this task checks that no launch staged across the switch parks.

## 2. Artifact fitting filters only what leaves

**Invariant.** Composition filters each text that leaves it exactly once, as a
whole, under one revision: the returned prompt and each artifact file it
writes. It filters nothing else. Candidates are chosen by local byte counts;
the chosen one is filtered and measured again.

Filtering is not compositional. A stored text can span a substitution boundary
or the edge of an excerpt, so a prompt is never assembled from separately
filtered pieces. Filtering can also lengthen text: a stored text shorter than
the 14-byte marker (`[learned rule]`, for example a short reason), or one
equal to the marker, grows on replacement; redaction can grow too. Every
decisive size check therefore comes after the filter and the scrub.

Steps for one composition attempt (`composeCurrentStageInput`):

0. Validate the context and the tracked skill paths. Today this runs inside
   `composeResolvedStageText`; one shared helper must run it on every path.
1. Render the full prompt locally, scrub it and measure it. If it fits the
   limit (32,000 bytes minus `reserveBytes`), filter it (one call). If the
   filtered prompt fits, protect existing artifacts, check the revision and
   return it. For every prompt whose unfiltered size fits, this is today's
   behaviour.
2. Otherwise prepare the artifact directory and filter the previous output
   into its artifact (one call; file name, digest and bytes unchanged).
3. Build the ladder locally: excerpt sizes 512, 128, 32 and 4 with the
   specification inline, then the same four with the specification by
   reference. The specification artifact is filtered once, on first need.
   Excerpts come from filtered artifact text, as today. A candidate whose
   scrubbed size is over the limit costs no call.
4. Filter the first candidate that fits (one call). If filtering pushed it over
   the limit, filter the smallest candidate of the ladder once (creating the
   specification artifact if needed). If that is still over, go to step 5.
5. Fallback: filter the full prompt (one call, reused if step 1 already did).
   If it now fits, return it inline. Otherwise use it, without filtering it
   again, as the text of the stage-prompt artifact and filter the short
   wrapper with its
   512-byte excerpt (one call). The wrapper must fit; if it does not, refuse
   with a static reason and send nothing (today this case is unchecked and
   would fail later at the message envelope).
6. Check the revision, write the artifacts and return (unchanged).

| Calls per composition attempt | Today | This design |
| --- | --- | --- |
| Prompt fits | 1 | 1 |
| Artifact path, typical | 3 or more (full, previous output, 1 to 4 renders) | 2 or 3 (previous output, chosen candidate, specification when needed) |
| Artifact path, worst | 12 (8 over whole candidates) | 6 (previous output, specification, two candidates, full prompt, wrapper) |

Each call's cost grows with the text size and the number of compiled matcher
chunks; the per-call cost was not measured.

**Equivalence.** For a chosen candidate the emitted bytes are
`scrub(filter(render(candidate)))`, the same function as today's `render`. The
choice differs from today only where filtering moves a size across the limit.
A full prompt that fits only after filtering now goes to step 2. Step 5 still
returns it inline when no candidate fits. Artifact files are filtered whole;
the fallback artifact is the full prompt filtered once (today it was filtered
twice). The same inputs and revision always give the same output. The
dispatch-side filters in `engine.ts` and `structuredSpawn.ts` still filter
the final message as a whole.

**Bounds.** The returned prompt is at most the limit on every path. Artifact
files hold full inputs and are not bounded, by design. A single filter request
over 2 MiB is still refused as `worker-input-too-large`. The full prompt now
reaches the worker only on the inline and fallback paths.

## 3. An exhausted window names the window

The existing per-preparation async context gains a small record: the current
phase (`composition`, `privacy worker request`, `backoff`), seconds spent in
each, the number of worker requests, whether the latest request's budget was
cut to the window's remainder, the number of reruns after a revision change,
and the last real failure category. Phases are static names; values are counts
and durations; nothing from a prompt, a rule or an error message enters it.

- `run()` in `privacy.ts` counts worker requests. It enters the worker phase
  while any request is outstanding and returns to composition when none is.
  `withCurrentRevision` counts reruns. `withPrivacyRetry` counts backoff.
- `privacyWorkTimeoutMs()` already runs once per submission, in the caller's
  async context; its only caller is the worker queue. It records whether the
  window's remaining time was below 60 seconds and so set the latest
  request's budget. `taskPageWorker.ts` does not change.
- The window is exhausted when the check before work or after a result finds
  the cutoff passed, or when a retryable failure arrives with no time left. A
  `worker-timeout` from a request whose budget was cut to the remainder counts
  as window exhaustion and is left out of the failure record. A
  fractional timer delay can fire just before the exact cutoff; the request's
  clipped budget still determines the cause, and its worker phase is retained
  without another backoff. A
  `worker-timeout` after a full 60-second
  budget with time left stays a retryable failure, as today.
- The refusal reads: `role memory could not be read or filtered; <cause>; retry
  window exhausted after 180 seconds during <phase>; privacy worker requests
  <n> (<s> s), composition <s> s, backoff <s> s, revision reruns <r>; nothing
  was sent`. `<cause>` is the last real failure category, or the new
  allowlisted terminal category `window-exhausted` when there was none. Text
  that names a real cause keeps its current prefix. The same summary is logged
  once.
- A revision-change refusal (`RoleMemoryChanged`) is logged as `store-changed;
  deferring to the caller` and rethrown unchanged. Retrying it inside the
  window would turn the engine's unbounded role-memory wait into a park after
  180 seconds.

The refusal lands in the attempt's park reason, so the summary is attributed
to its attempt without new correlation. A queue, compile and match split per
worker job needs worker-side changes. It belongs to a separate correlation
lane, which is paused and unmerged, and is not duplicated here.

## 4. Unchanged and fenced

- The 180-second window, the 60-second request cap, backoff, the queue of 16,
  the 2 MiB request and reply bounds, worker retirement and lease checks.
- Filtering against every stored rule with a complete matcher; no inline or
  unchecked fallback; the empty-store shortcut.
- Activation, reservation and dispatch-token checks; durable activation input;
  staged recovery; launches whose outcome is unknown, which are never retried
  or adopted by this work; native claim recovery.
- No edits to `taskPageWorker.ts`, `taskPage.worker.ts`, `engine.ts`,
  `structuredSpawn.ts`, `structuredDeliveryQueue.ts` or the state store.
  Touched: `roleStore.ts`, `roleViewSource.ts`, `privacy.ts`,
  `privacyRetry.ts`, `privacyFailure.ts`, `stageInput.ts` and their focused
  tests.
- Learned-rule selection and its byte ceiling.

## Diagnostics and restart

`privacyFailure.ts` defines the only categories allowed in logs and worker
error frames; this revision adds `window-exhausted`. The store translates
exceptions before wrapping them; the worker emits only a category, and its
parent validates that category against the same allowlist. Raw exception
messages, stacks, SQL, paths and rule text are never logged or sent as failure
diagnostics. Unknown errors retain the static fallback category. Each failed
preparation logs its category and whether it will retry or refuse. These
categories diagnose the failing boundary; a timeout alone supplies no
evidence that overload caused it.

The retry budget belongs to one asynchronous preparation, with no persisted
counter. Restarting the Viewer can start a fresh window. This is harmless
because these retries prepare input before dispatch: a failed pass supplies
no agent input, and a replacement process must filter again against current
memory. The existing persisted launch reservation and recovery checks prevent
a replacement from treating uncertain delivery as a new dispatch. Curation's
known-value refresh is an idempotent rewrite; curation undo uses the worker
directly and gains no automatic replay. A restart can extend total waiting
time, while each uninterrupted preparation remains bounded. Repeated restarts
can therefore postpone parking.

## Caller trace

The trace below was checked before changing the shared reader. Existing
synchronous callers retain their synchronous refusal behavior and gain the
safe store diagnostic; they gain no sleeping or automatic replay.

| Entry point | Producers, consumers and checks |
| --- | --- |
| `memory/privacy.ts` | `withoutStoredLessonsAsync`, `renderReportAsync`, `scrubIssueReportAsync`, `refreshCurationKnownValuesAsync` call the shared worker. `withCurrentRoleMemory` wraps complete preparation and revision checks; nested calls share its retry window. `run()` and `withCurrentRevision` feed the window record (section 3). |
| `pipelines/stageInput.ts` | Local stage text, prompt substitutions, previous output and protected artifacts. Filters each text that leaves composition once, whole, before accepting its bytes (section 2). |
| `pipelines/cloudStageInput.ts` | Hosted stage text and learned-rule selection, then transport framing; uses the same current-memory wrapper. Unchanged. |
| `pipelines/engine.ts` | Initial launch preparation and final reservation-side filtering; also synchronous revision checks for cached input, revision-change deferral and embedded flow preparation. Existing durable reservation/recovery remains unchanged. |
| `runtime/structuredSpawn.ts` | Re-prepares and filters first input before delivery, then verifies the revision token at dispatch. |
| `pipelines/runtimeSwitch.ts` | Filters the continuation assembled from the prior attempt. |
| `mcp/bindings.ts` | Linked-seat outgoing messages, bridge reports, issue hints and curation known-value refresh. All async privacy entries retain refusal codes. |
| `links/taskPageWorker.ts` | Shared worker queue and request timeout; reads initial revision, validates worker results and final revision. No inline or unchecked fallback. Direct task-page and undo consumers retain single-call behavior. |
| `taskPage.worker.ts` | Filter/report/issue/known-value work and direct curation undo; returns validated results or an allowlisted diagnostic. |
| `links/taskPageBuild.ts`, `links/agentFeed.ts`, `links/taskExportPrivacy.ts` | Synchronous linked-board construction, cache revision and outgoing page fences. |
| `links/taskFeed.ts` | Synchronous outbound task projection requires complete filtering before the worker serializes linked-board rows. |
| `runtime/structuredDeliveryQueue.ts` | Synchronous revision-token checks before the native first-message effect. No retry or delivery semantics change. |
| `pipelines/git.ts`, `git/agentPublicationIdentity.ts` | Publication and agent-launch environments carry the known-value file path; an unreadable store refuses publication or leaves a missing file that refuses the agent's own push. |
| `scripts/measure-privacy.ts` | Local measurement reads stored texts, then exercises either synchronous filtering or the async entry. |
| `memory/roleStore.ts` | Rule-row revision (section 1), revision tokens, matcher compilation/completeness, stored texts/patterns and publication known-value refresh. Sync publication and linked-board consumers still fail closed. |
| `memory/roleViewSource.ts` | Owns the dedicated read-only connection for the rule-row revision, next to the existing view, curation and profile readers. Reads the collection generation and durable privacy counter; never row texts. |
| `state/sqliteStateStore.ts` | Installs the singleton privacy counter and three rule-row triggers through the existing fenced schema transaction. Every writer inherits transactional revision updates. |

## Byte-ceiling omissions

`roleRender.ts:renderLearnedRulesSelection` intentionally removes the last
optional rule from the largest remaining scope until the rendered block fits.
Rank order comes from selection; protected rules cannot be removed. Engine
launches cap this block at 120,000 bytes (`roleLaunch.ts`). An omission count
such as 145 means those rules provided no instruction context to that engine
start. Their ranking and selection utility are lost for that start; they remain
stored and still participate in outgoing privacy filtering, including archived
rules and reasons. The warning is independent of read failures. This change
leaves selection and its ceiling unchanged.

## Regression evidence

Existing, retained: `src/lib/pipelines/stageInputRetry.test.ts` injects
filesystem read failures at all three launch-side revision reads. One busy read
recovers to one filtered adapter effect; persistent busy reads exhaust 180
seconds with the safe cause; permission failures refuse without a retry. The
existing role-privacy suite covers revision changes, activation cancellation
and reservation recovery. `src/lib/memory/privacyRetry.test.ts` also runs an
independently supervised child with real clocks and a real `TaskPageWorker`
driving leased blocked subprocesses. Thirty seconds of initial preparation
leave about 27 seconds for its last worker request. The normal cap exhausts the
shared 180-second window with a cause-bearing refusal and zero dispatches. A
separate 195-second watchdog fails a worker whose request ignores that
remaining budget, and closes its owned process tree; recorded worker
identities must all be dead afterward. The fast mocked-clock tests retain
their arithmetic and late-result checks.

Assertions that pin the old wording change only where the old text was wrong.
A request cut to the window is now reported as the window, with phase and
counts, while every numeric assertion stays. No test is removed.

Required for this revision. Each test writes through the production writers
and runs the real worker; a spy may count worker calls but must delegate to the
real implementation:

1. **Revision semantics.** The revision changes after a new lesson, a rewrite,
   a revert, an archive (`deleteRule`), a restore, a curation pass, an import
   and a collection re-import. It stays equal after `recordLessonRequest`, an
   answer without a lesson, a problem answer and its delivery mark, and a
   scope-only write. Rewrite then revert gives a third, different value. After
   more than 1,024 request-only writes (past the change floor), a rule write
   is still detected. The worker process and the parent report the same value
   for the same state. Insert/delete cycles, including a peer transaction,
   remain distinct after journal pruning and process restarts. Rolled-back
   writes preserve the committed revision; startup upgrades and partial-schema
   repair retain filtering for existing rules.
2. **Request-only writes cost nothing.** A request-only write at each await
   of a stage launch causes no recompile, no recomposition and no extra worker
   call compared with a run without the write. The awaits are: the first
   filter, artifact directory preparation, each artifact filter, the
   candidate filter, reservation-side filtering, the pre-delivery callback and
   the dispatch authorization. The launch dispatches once.
3. **Rule writes invalidate at every await.** A lesson written at each of the
   same points prevents the stale prompt from being dispatched. The prompt
   that is dispatched withholds the new lesson. No artifact is written before
   the final revision check.
4. **Bounded fit.** An artifact-path composition makes at most the calls in
   the table above: the typical case exactly 2 or 3, and the worst case 6 or
   fewer. Fixtures cover a multibyte specification, previous output near the
   limit and the exact UTF-8 boundary that `stageInput.test.ts` already pins.
5. **Equivalence and no leaks.** The dispatched prompt equals
   `scrub(filter(render(chosen candidate)))` computed with the synchronous
   reference filter. Fixtures place a stored text across the boundary between
   a template line and a substituted value, and across an excerpt edge. Neither
   the prompt nor any artifact contains a stored text.
6. **Growth.** A short stored reason quoted many times pushes the first
   candidate over the limit only after filtering. The result is at most the
   limit, filtered, and within the call bound.
7. **Exhaustion wording.** With mocked clocks:
   - a window that ends in a request cut to the remainder reports
     `window-exhausted` and that phase;
   - a full 60-second worker timeout with time left retries;
   - a window that ends in backoff or composition names that phase;
   - two real timeouts followed by a cut request report `worker-timeout` as
     the cause and the cut request as the phase.
   - a clipped fractional delay that fires before the exact cutoff refuses
     immediately in the worker phase, retaining an earlier genuine cause.

   No message or log line contains fixture rule text.
8. **Deferral kept.** Three reruns after revision changes still surface
   `RoleMemoryChanged` to the engine's role-memory wait, now logged as
   `store-changed`. The stage is not parked.

Each of these induced faults must turn at least one test red, and the build
stage records that it did:

- revert to the whole-collection revision;
- revise only on text digests;
- filter pieces separately and join them;
- drop the size check after filtering;
- count a cut request as `worker-timeout`;
- retry `RoleMemoryChanged` inside the window.

Checks run by explicit file, in isolated state, with fresh logs and actual
exit statuses. The files are any test files the build adds, plus
`roleStore.test.ts`, `privacy.test.ts`, `privacyRetry.test.ts`,
`stageInput.test.ts`, `stageInputRetry.test.ts`,
`controllerArtifacts.test.ts` and `engine.rolePrivacy.test.ts`.
`roleViewSource.ts` and `privacyFailure.ts` have no test file of their own;
items 1 and 7 cover them.

## Deferred — not currently justified

- **Shared queue changes**, such as giving stage preparation priority over
  task-export pages or a separate worker. The queue wait was observed, but a
  queue redesign is outside this requirement, and its effect would need
  measured attribution first.
- **Flattening nested revision loops**, so that only the outermost loop
  reruns. It would save one call per rule change. It would also lower the
  tolerated revision churn at reservation-side filtering from nine reruns to
  three, sending more launches into the retained-launch reconciliation path.
- **Reading only rule rows during matcher compilation.** Compilation reads the
  whole collection snapshot, including scope histories. With section 1 it runs
  only after rule changes; narrowing it is an optimization that needs a
  measurement.
- **Moving the known-value refresh loop to the rule-row revision.** It is not
  on the stage-preparation path.
- **Per-job queue, compile and match attribution.** This belongs to the
  separate correlation lane.
- **Removing the dispatch-side whole-message filters** in `engine.ts` and
  `structuredSpawn.ts`. They are the final fence and outside this scope.
- **Batching all ladder candidates into one worker request.** The match work
  is the same, and large specifications could exceed the 2 MiB request bound.
- **A revision digest over filtered texts.** Rejected in section 1.
- **A longer window or request cap.** Excluded by the requirement.
