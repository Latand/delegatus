# Role-memory reads before dispatch

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
The existing activation and reservation checks still govern dispatch after
preparation returns.

Timeout, busy-store, queue-capacity, retirement-timeout and revision-change
diagnostics are eligible for retry. Corruption, permission errors, invalid
replies, oversized requests, failed worker starts/exits, shutdown and unknown
errors refuse immediately. Exhaustion throws `LESSON_PRIVACY_UNAVAILABLE` with
the final category and the 180-second bound; the stage's existing failure path
parks it with that reason.

## Diagnostics and restart

`privacyFailure.ts` defines the only categories allowed in logs and worker
error frames. The store translates exceptions before wrapping them; the
worker emits only a category, and its parent validates that category against
the same allowlist. Raw exception messages, stacks, SQL, paths and rule text
are never logged or sent as failure diagnostics. Unknown errors retain the
static fallback category. Each failed preparation logs its category and whether
it will retry or refuse. These categories diagnose the failing boundary;
a timeout alone supplies no evidence that overload caused it.

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
| `memory/privacy.ts` | `withoutStoredLessonsAsync`, `renderReportAsync`, `scrubIssueReportAsync`, `refreshCurationKnownValuesAsync` call the shared worker. `withCurrentRoleMemory` wraps complete preparation and revision checks; nested calls share its retry window. |
| `pipelines/stageInput.ts` | Local stage text, prompt substitutions, previous output and protected artifacts; filters each before accepting bytes. |
| `pipelines/cloudStageInput.ts` | Hosted stage text and learned-rule selection, then transport framing; uses the same current-memory wrapper. |
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
| `memory/roleStore.ts` | Revision tokens, matcher compilation/completeness, stored texts/patterns and publication known-value refresh. Sync publication and linked-board consumers still fail closed. |

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
