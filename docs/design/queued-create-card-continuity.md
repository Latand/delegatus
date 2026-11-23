# Accepted creation card continuity

> “keep its visible identity until admission or terminal refusal is reconciled”

Public requirement: issue #3643, comment of 2026-11-04 at 12:13:42 UTC.
The assignment of 2026-11-06 selects this remaining UI outcome.

## Conclusion and accepted scope

Keep an accepted creation visible under its server-issued pipeline ID until
its actual result is known. A later complete catalog without that ID proves
neither refusal nor completion. The current code demonstrably loses this row.

The accepted scope amendment of 2026-11-06 includes the minimal durable-queue
read dependency in this lane. Implement authorized same-ID readback, bounded
reload restoration through the existing files cache, and the UI together.
Complete acceptance remains required. Current readback denies a permitted
member while the creation is queued, and current catalog persistence omits
receipts. Both defects need a source repair.

This planning stage changes only this document. No additional permission is
needed for the described implementation. Queue writes, admission, engine,
lifecycle and authentication settings remain unchanged. There is no new store,
poller, migration or expiry policy. These reversible source choices need no ADR.

## Observed source and evidence

Inspected revision: `6bbb8581ebb8b78eaaaf3a0b809a81a408f99651`.
The assigned checkout, local main tracking ref and forge main agreed at the
initial inspection and the continuation inspection. The two target source files have no changes between
the intake revision `85ef7c47` and this revision.

The complete current issue body and both comments were read before inspecting
source. The latest substantive comment, 2026-11-04 at 20:11:36 UTC, records
the merge of admission work in #3658. It explicitly leaves queued overlay
reconciliation and wider end-to-end acceptance open. Prior conversation
search confirmed the narrow intake ownership; it supplied no earlier completed
UI solution. Memory searches supplied no additional applicable implementation.

| Boundary | Current behavior and source |
| --- | --- |
| HTTP producer | `src/app/api/pipelines/route.ts:191` wakes the controller for queued work; lines 198–208 return the full pipeline plus `queued.reason` and `queued.queuedAt`, with HTTP 202. HTTP 201 means stored creation. |
| Browser producer | `src/components/pipelines/pipelineModel.ts:1283` parses both answers as `PipelineClientResult`, applies `applyPipelineSnapshot(pipeline, true)` and drops the queue metadata from its returned result. |
| Cache admission | `src/hooks/useFiles.ts:990` gives confirmed echoes `requestedGeneration + 1`. Optimistic PATCH uses infinity until confirm/revert. These meanings must stay distinct. |
| Cache settlement | `src/hooks/useFiles.ts:577` deletes every sufficiently old overlay on a complete response, regardless of whether the ID occurs in that response. The 304 and full/delta paths both reach this function. |
| Durable identity | `src/lib/pipelines/creationQueue.ts:44` stores the prepared pipeline and delivery target. Its creation key makes repeated controller admission converge on the same stored record. The browser must retain the returned ID and never repeat POST to check status. |
| Result read | `src/app/api/pipelines/[id]/route.ts:69` returns stored pipeline data, or HTTP 404 with `pipeline_queued` / `pipeline_creation_refused` and `queuedCreation`. A bare 404 supplies neither result. |
| Team authorization | `src/lib/team/workspaceRoute.ts:79` resolves pipeline ownership from `loadPipelinesForList()`. The ID lookup at line 227 supplies no project for an unmaterialized queue entry. Member access is refused before the status handler. Read responses also receive a final scope-signature check. |
| Queue terminal semantics | `src/lib/pipelines/creationQueue.ts:128` retains busy/lease-expired entries and persists other failures as refused records. There is no queue expiry status or expiry timestamp in the current contract. |
| Reload | `src/hooks/useFiles.ts:1058` exposes only the certified raw catalog for persistence; lines 1146–1175 restore and save it. `src/lib/client/filesSnapshotStore.ts` stores one raw catalog with its ETag. Pending overlays are absent. Mixing local rows into this payload would invalidate its meaning. |
| Access loss | `src/hooks/useFiles.ts:764` clears a restored cached snapshot on 401/403; it does not clear all already-loaded overlays. `teamClient.ts` observes session refusal, and `workspacesClient.ts` refreshes membership views, but neither supplies a queued-create owner epoch to this cache. |

### Isolated observation

A scratch export of the inspected revision extended the existing
`src/app/api/pipelines/route.busy.test.ts` fixture. The fixture uses a tiny owned
Git repository, isolated state and a held real registry lease. The final run
registered an in-process no-op controller wake and pinned the Viewer control
URL to a closed port. No product source was edited.

The real POST handler returned HTTP 202. Its returned pipeline went through
the actual cache's existing confirmed-echo method. Two controlled complete
catalogs omitted the ID:

| Observation | Value |
| --- | --- |
| Rows immediately after echo | 1 |
| Rows after first complete catalog | 0 |
| Rows after second complete catalog | 0 |
| Durable queue state after both catalogs | queued |
| Member's actual project access | member |
| Same member reading the queued ID | 403, `workspace_forbidden` |
| Owner reading that queued ID | 404, `pipeline_queued` |
| Same member after actual queue admission | 200 |
| Stored rows after two admission passes | 1 |

Final observation run: one expected failing continuity assertion and one
passing authorization/readback control; two unrelated tests filtered out;
exit status 1. This establishes the cache defect and the readback dependency.
It does not establish browser rendering, final-await protection or head-green
behavior. The browser's `createPipeline` function was traced in source; this
probe feeds its observed cache call directly. Full browser creation remains
untested at this stage.

Private evidence under `LLV_EVIDENCE_DIR`: `architecture-observation.json`,
`architecture-observation.patch`, `architecture-queued-continuity-base-3.log`.
The manifest preserves the exact command and fixture changes. Earlier logs
remain: the first encountered a fixture home-alias mismatch before assertions;
the second reproduced the defect but its default controller wake received 401.
Only the final locally bounded run is the acceptance evidence above.

## Current overlaps and keep-list

The first inspection inventoried 22 open pull requests. The continuation
inventoried 23 by their actual changed-file lists and inspected relevant diffs.
The two source targets and their direct model/cache test files had no open-PR
overlap in that inventory. Shared rendered-evidence files do have overlap:

| Open work | Actual overlapping areas | Rule for this lane |
| --- | --- | --- |
| #3716 | Task-files forwarding in `issue1695Evidence.fixture.tsx`; task album cases in `kanbanBoard.browser.test.tsx` | Add a separate scenario branch and describe block; preserve forwarding and album assertions. |
| #3682 | Accounts imports/scenario and spending assertions in those same files; account cases in the phone driver; account geometry captures | Preserve account cases, imports and captures. |
| #3650 | Settings routing in the common fixture; settings/voice/menu cases in desktop and phone drivers; settings geometry capture | Preserve the current settings host and all existing cases. |
| Available local account-billing work | Same fixture imports/fetch forwarding and appended desktop/phone browser cases | Treat these unpublished hunks as owned work. Re-read before editing shared drivers. |

Supporting UI paths also overlap: #3719 adds delivery/composer keys, #3716
adds files/preview keys, #3682 changes account keys, and #3650 adds settings
keys in both locale dictionaries. #3716 and #3650 also add shared browser
harness functions. Preserve those namespaces and functions; use a dedicated
creation-status key prefix. No open PR in this inventory changes
`PipelineBlock.tsx`, `PipelineSection.tsx`, `ProjectDashboard.tsx` or
`PipelineTemplatePicker.tsx`.

One registered checkout was present without the inspected tracked files and
therefore appeared as whole-file deletions. Its unpublished work remains
unknown; intentional deletion and free ownership cannot be inferred. Three missing historical
checkouts from intake remain unknown. No cleanup or restoration is authorized.

The available overlap inventory and patches are retained privately in
`open-pr-files.json`, `supporting-ui-overlaps.json` and `local-overlaps.json`.
Re-read open heads and source main immediately before implementation and after
any main movement. The original inventory and evidence remain preserved.

Keep server admission, controller/engine, integration and diagnostics work
intact, including #3710, #3668 and the now-merged #3725. Preserve document,
composer and settings work. Preserve the mechanical wait-note behavior from
#3534. Its wording change does not supply creation continuity.

Primary UI changes: `pipelineModel.ts`,
`useFiles.ts` and their direct tests. A truthful visible creation status also
needs small, explicit consumers in the existing pipeline presentation layer:
`src/components/pipelines/PipelineBlock.tsx`,
`src/components/kanban/PipelineSection.tsx`, and the direct draft/open callers
where queued actions must be disabled. Update both `src/lib/i18n/en.ts` and
`src/lib/i18n/uk.ts` for any new key. These are supporting UI changes to review
for overlap before implementation. Preserve those surfaces' existing design.

### Read dependency: actual shared functions

| Work and observed head | Compared source | Integration order |
| --- | --- | --- |
| #3710, `edb2bf0664e74444627a40418581db77d9e80109` | Published diff and matching clean local checkout change `creationQueue.ts`: suffix selection, `queuedPipelineCreationStatus`, new `exactQueuedCreationStatus`, queue writes and drain. They add `.admission` / `.admission.refused` beside legacy files. | Keep its writes, witness, caller checks and drain intact. Add the narrow reader beside the current status reader without rewriting admission. If the branches converge, reconcile its suffix/identity protocol first, then the read projection, then rerun authorization and materialization tests against that combined source. The status-reader hunk is the real shared-function conflict. |
| #3668, `25783bad3409d324eba222159b60dde76820235b` | Published integration diff changes engine/store/types and integration machinery; no queue reader, HTTP GET, workspace lookup, files cache or snapshot-store hunk. Available clean successor `baeb2d5ee3df99be228d050fcba7b5498ee1ab64` has no difference from main in the named read/UI targets. | No read-function sequencing dependency demonstrated. Preserve its metadata and integration behavior; do not import unrelated changes from the successor. |
| #3716, `3258105806cadc36e3d003a1ff6b70dc8fd78dc5` | `workspaceRoute.ts:74` changes `taskProject` to a keyed task lookup, immediately before `pipelineProject`. | Preserve that task lookup. Apply only the pipeline read lookup and exact read-route fence changes; resolve adjacent context without replacing the file. Preserve its browser-driver additions. |
| Merged admission #3658, `24bbef5f405fa716ec882f90c51847cdecd2a886` | Current POST still returns the queued echo and current queue keeps busy/lease-expired requests. | Consume this behavior; retain POST, deadline, queue write and drain unchanged. |

The available #3710 checkout has no unpublished tracked delta; its committed
queue diff matches the published head. Both the available original #3668
branch checkout and successor are at `baeb2d5e`, ahead of the published head;
neither has an unpublished tracked delta or a target read/UI blob difference
from current main. A separate available scratch checkout has unpublished
`pipelineModel.ts` source-link/draft changes and a route-policy assertion;
comparison shows that functionality already exists in current main. Preserve
the current `from`/`attachDraftLink` behavior when adding queued handling.
This is blob evidence, not an ownership claim about missing historical work.
The initializing checkout and the three intake-missing checkouts remain
UNKNOWN. No original launch outcome or review budget is reset.

### Minimal server read repair

Use the existing ID GET for restoration and reconciliation. The existing list
route and `/api/files` remain authoritative stored-pipeline lists; adding queued
rows to them would corrupt their current catalog meaning. A queue-wide list is
unnecessary when the existing browser snapshot retains known receipt IDs.

1. In `src/lib/pipelines/creationQueue.ts:92`, add a narrow, validated read
   projection for a single ID beside the existing status reader. Read only the
   supported filenames for that ID, including refused records. Validate the ID
   alphabet, length, version, embedded pipeline ID and project before treating
   the record as authority. Return only project and a compact creation receipt
   for the HTTP consumer. Do not expose the delivery target, admission bindings,
   creation keys, prompts, full spec or private filesystem error messages.
   Retain the existing status function's behavior for its other consumers.
   Damaged, oversized, contradictory or unreadable evidence is unavailable;
   missing evidence is unknown. Neither grants access or means refusal.
2. In `src/lib/team/workspaceRoute.ts:79,227`, introduce a read-only pipeline
   target resolver for exactly GET/HEAD `/api/pipelines/[id]`. Use the existing
   keyed `findPipelineRecord` (`store.ts:2428`) first, then the validated queue
   projection. Leave the existing resolver used for PATCH, nested actions,
   `sourcePipelineId` and copied parents unchanged. A query `project` never
   overrides persisted ownership. Missing/conflicting project evidence fails
   closed. The same current workspace access rule admits a creator and another
   permitted member; creation history gives no continuing privilege.
3. In `src/app/api/pipelines/[id]/route.ts:69`, retain stored-first resolution,
   existing 200 detail and 404 queued/refused codes. Add a compact receipt on
   queued/refused answers with ID, project, title, task IDs, queue time and safe
   status/reason; it is read-only UI data, never a synthetic stored pipeline.
   Recheck the actual returned record's project immediately before encoding.
   A queued record that materializes during the read must resolve to the same
   stored ID. If evidence moves or contradicts itself, leave it unresolved.
4. Preserve the existing final `scopeSignature` check around awaited handlers.
   For this exact ID-read path include owner/solo fast paths in the before/after
   signature comparison, so loss of owner status or a transition into team mode
   during an await cannot bypass the check. Do not change fast paths on writes
   or unrelated routes. Capture the initial signature before target resolution,
   recheck after its awaits and immediately before releasing the response.
   Revalidate the record's project too: an unchanged member signature alone
   cannot authorize a record that changed project. Cancel a prepared response
   when authority changed. No protected response may be cached across members.

The production reader needs no `readdir`, list scan or new index. Bound reads
to the exact filenames, validate size before parsing, and use asynchronous file
reads for the added request path. Derive the byte ceiling from the existing
create validator's maximum serialized record and test its boundary; do not
truncate a valid receipt. Observe the actual read count with large unrelated
queue history and both cold/warm stores. Claim no latency gain.

Dependency map: HTTP and MCP create both produce these existing queue files;
the controller consumes them and persists a refused file or the same pipeline;
ID GET and MCP status readers currently consume their status. This lane adds
only the browser-facing read projection. Existing lists, copied-parent writes,
admission witnesses, controller cleanup and all settings remain consumers of
their current contracts. Test stored-first precedence with a leftover queue
file. No operation is created, drained, retried, deleted or acknowledged on GET.

## Minimal UI contract

Use one tagged creation receipt owned by the existing files cache. Keep it
separate from ordinary confirmed POST/PATCH overlays and optimistic edits.
Preserve the server's pipeline ID, project and queue timestamp. The durable
creation key stays on the server; never derive a new pipeline or task ID from display text.
Keep receipt metadata out of server `PipelineState` and out of PATCH bodies.

1. Capture the current document/member authority generation before POST. At
   each await boundary, and synchronously before applying or returning a
   result to an opener, verify the operation still belongs to that generation.
   Discard late results from a revoked or replaced owner. A selected workspace
   is a view filter; switching filters must neither transfer ownership nor
   settle the operation.
2. HTTP 202 with valid queue metadata admits a queued receipt and paints its
   card immediately. Preserve ordinary HTTP 201 behavior. A malformed response
   or transport failure remains explicitly uncertain and cannot trigger a
   second POST.
3. A complete catalog lacking the ID retains the queued receipt through any
   number of catalog generations. Incomplete, stale, pinned and conditional
   representations cannot retire it. Materialized server data for the same ID
   wins once, with no intermediate empty render or duplicate card.
4. Reconcile through an existing catalog refresh/revision lifecycle. The
   authorized read contract must supply queued, stored or terminal outcome.
   Coalesce work per receipt; no independent interval or recursive poller.
   A network error, 503, bare 404 or missing catalog row means unresolved.
5. An authoritative refusal replaces the pending status with a local result
   on the same card. Retain its identity and safe reason until locally dismissed.
   Do not manufacture a failed pipeline, completed stage or creation expiry.
   If the authorized contract later gains actual expiry, render that distinct
   terminal outcome. Lease expiration currently leaves the request queued.
6. On session/member loss, cancel outstanding reads, advance the authority
   generation and remove that owner's receipt data before another member can
   render. Show only a generic access message in the current authorized shell.
   Never preserve the previous owner's title or ID in the new member's view.

`createDraftPipeline` currently awaits `attachDraftLink` after creation.
Queued creation must not perform that follow-up PATCH before materialization.
Keep its existing draft/source intent with the same receipt and perform it
only after a stored result, with the authority check immediately before the
effect. Reuse the existing link attachment action; after reload compare actual
work links before offering its existing retry affordance. Never replay a
possibly completed attachment automatically. `PipelineTemplatePicker` and `ProjectDashboard` must not open an
editable builder as though the pending record already exists. A pending card
may expose its read-only receipt; stage actions remain unavailable until stored.

### Bounds and lifecycle

Use the existing cache as sole client owner. Proposed creation-receipt cap:
eight records, including unacknowledged terminal receipts. Reserve a slot
before POST so a ninth request cannot be
accepted and then silently evicted. A second click on an outstanding intent
uses its existing slot. Release reservations on definitive pre-acceptance
refusal, replacement by the materialized server row, terminal dismissal
or authority disposal. Keep unresolved accepted records
within that cap until their result can be recovered; clock passage alone
cannot remove an accepted operation.

Before adopting this cap, verify the create entry points can apply it together
and show a local capacity explanation without deleting unsent drafts. Test
0, 1, 8 and 9 simultaneous intents, including out-of-order answers and a
reservation that loses its owner. Do not increase an existing unrelated cap.

Measure the largest supported receipt rather than guessing its size. Current
input limits include a 4,000-character task, 16,000-character spec and eight
stages with 8,000-character prompts, plus role fields and outputs. The receipt
should reference the one owned echo, avoiding copies per representation.
Retain a compact result after refusal; do not retain duplicate request bodies.
Record peak retained bytes for eight maximum-size echoes in the implementation
evidence. No performance improvement is claimed by this design.

Background reads need one abortable request per operation at most, finite
per-request deadlines, cancellation on disposal and no work without a mounted
authorized consumer. Check ownership after response acquisition and body
decoding, before cache mutation, before follow-up link attachment and before
navigation. Test reversal at each boundary and prove removal of the final
check makes the corresponding test fail.

### Reload through the existing scoped cache

Extend the existing single `FilesSnapshotRecord` envelope in
`src/lib/client/filesSnapshotStore.ts`, without adding an IndexedDB database,
object store or key. Keep `text` and `etag` exclusively the certified raw
catalog. Add a bounded, versioned receipt field outside that payload: owner
scope, known IDs/projects, compact card identity, queued time, unresolved or
terminal status, and any pending local draft-link intent. Store neither full
request bodies nor server authority credentials. ID GET remains the source of
truth for these accepted operations' results.

The existing implementation only persists on first idle/hide and skips equal
ETags (`useFiles.ts:1161`). Receipt changes must schedule an immediate bounded
write even when ETag is unchanged, and may be persisted before a raw catalog
exists. Serialize writes through this cache owner so an older idle write cannot
erase a newly accepted receipt. Recheck owner generation after store reads and
before writes. Revocation clears memory and persisted receipt data and fences
late write completion; a new owner cannot inherit the old queued write.
Paint acceptance immediately, but finish the create callback and navigation only
after this persistence attempt settles under its deadline. Return an explicit
persistence warning if it fails. Within the existing IndexedDB transaction,
preserve other same-owner receipt IDs when two documents update the envelope;
an old catalog writer must not replace a newer receipt set. No second store or
background coordinator is needed. Verify reload immediately after the callback,
without relying on an idle event, a hidden-tab event or a changed ETag.

Keep the catalog's current seven-day validity rule separate from unresolved
receipt retention. Do not drop a receipt because the raw catalog is old, absent
or replaced. Retain at most eight receipts within the existing 24 MB envelope,
with a measured smaller receipt budget; reserve space before creation, never
evict an accepted operation to admit another. Release it only for materialized
server data, local terminal dismissal or authority disposal. Catalog eviction
cannot evict unresolved receipts. Old snapshot versions have no receipts.
When ID GET materializes before the catalog catches up, keep the compact ID
locator until the persisted certified catalog actually includes that ID. Paint
the returned real record immediately. Retiring its reload locator in that gap
would reproduce disappearance on the next reload. Persist settlement and
locator retirement in one envelope write; both count toward the same bound.

On reload read candidate receipt IDs without painting their title, project or
reason. Establish the current member and confirmed workspace scope using the
existing team/workspace clients, then GET only those IDs with at most two
concurrent requests and one in-flight request per ID. Paint each compact receipt
only after its fresh authorized read, under the same owner generation. A stored
answer becomes the one real row; refused becomes the same result card; 401/403
disposes protected content. A transient error leaves a generic status-unavailable
placeholder until current access can be certified. No reload or navigation
performs POST. Unsupported storage or a failed write must expose that reload
recovery is unavailable; preserve the current card and offer no retry that
recreates work. Test this explicitly rather than claiming durable recovery
when the browser refused persistence.

Subscribe the cache to the existing team client's identity/refusal notifications
and the workspace client's confirmed membership/project view. Add only passive
snapshot/subscription exports to those two clients if required. The selected
workspace and optimistic placement are view state, never authority. A scope
change invalidates the local owner generation before notifying receipt readers,
hides affected private rows, and requests fresh authorized readback through the
current refresh lifecycle. Returning to a permitted workspace can reread its
known ID; it cannot adopt another member's receipt. Bind draft completion and
opener callbacks to the captured generation too.

Reconcile receipts at the existing cache's catalog completion, visibility and
explicit refresh events, including 304. Coalesce concurrent events into one
pass; use a five-second request/body deadline, cancel on disposal or loss of
authority, and perform no retries until the next existing event or explicit
read retry. Eight receipts imply at most eight ID reads per pass. A quiet catalog
must still let the existing refresh cadence obtain a terminal result. An older
queued answer cannot replace a newer materialized/refused result. These bounds
are proposed implementation constants, with behavioral tests, not measurements.

## Visible states and surfaces

Route trace: `src/app/page.tsx` mounts `Viewer`; `Viewer` consumes `useFiles`
and passes rows to `ProjectDashboard`. Desktop reaches `KanbanBoard`; the
responsive dashboard selects the mobile board/task/pipeline screens.
`PipelineBlock` is shared across card, task and screen densities;
`MobilePipelineCard` embeds its card density. `PipelineSection.pipelineProgress`
currently distinguishes provisioning and stage work, without a creation-queue
state. Reuse these components and their typography.

The root layout provides `TeamSessionGuard`. Separate activity and team pages
do not render the affected board and need no new receipt UI. Returning from
them and returning through mobile Back are lifecycle tests. The mobile layout
boundary is either width below 640 or height below 600; set both dimensions
explicitly in evidence.

The following English phrases define localized meanings; implement all new
keys in both shipped dictionaries.

| State | Defining visible text | Required behavior |
| --- | --- | --- |
| Accepted | Accepted — waiting to create | Same card and pipeline ID from the 202 echo; no running-agent claim. |
| Lagging catalog | Still waiting to create | Same card after two or more complete missing-ID catalogs; no fabricated queue rank, percentage or ETA. |
| Materialized | Existing actual pipeline status | One card, server data wins; normal actions resume. A draft remains a draft. |
| Refused | Creation refused, followed by safe reason | Same result card until acknowledged; no automatic create retry. |
| Read unavailable | Creation status unavailable | Retain accepted identity, expose bounded read retry; do not claim refusal. |
| Access revoked | Access unavailable | Previous receipt content is absent; generic shell message only. |
| Restoration | Checking accepted creation | Generic placeholder while current authority/readback is pending; no prior-owner content. |
| Persistence unavailable | Reload recovery unavailable | Same in-document card, explicit storage limitation, no duplicate create. |

Keep the task title, associated task/card position and ordinary neighboring
cards. Put status first and reason on its own line; show each fact once per
surface. Keep IDs in existing disclosure/tooltip affordances. No new modal,
progress animation, toast-only result or alternate board layout is needed.
The pending receipt must not activate an agent composer or stage mutation.
Queue lease expiry is a queued-state behavioral test. There is no creation-expiry
render state or translation to implement in this change.

## Implementation slices and exact test ownership

These are proposed hunks, not completed source changes. Keep receipt metadata
in a separate `FilesData`/cache field and compose it in the existing card
presentation. A compact restored receipt must not masquerade as a full
`Pipeline` or enter a pipeline PATCH. The original POST echo may remain in
memory for immediate continuity, owned once by the cache.

| Slice | Product hunks | Direct existing tests and acceptance |
| --- | --- | --- |
| 1. Authorized durable read | `src/lib/pipelines/creationQueue.ts` single-ID read projection; `src/lib/team/workspaceRoute.ts` exact ID-read target resolution/final scope fence; `src/app/api/pipelines/[id]/route.ts` missing-stored-record branch | `src/lib/team/workspaceAccess.test.ts` real team fixture and concurrent revocation; `src/app/api/pipelines/route.busy.test.ts` real 202/GET/drain/refusal; `[id]/route.test.ts` response shape and unchanged stored detail. No list or POST product hunk. |
| 2. Receipt ownership and reload | `src/hooks/useFiles.ts` receipt admission, composition, settlement, refresh, disposal and snapshot hooks; `src/lib/client/filesSnapshotStore.ts` bounded optional envelope metadata and observable persistence failure; passive subscribe/read exports in `src/components/team/teamClient.ts` and `workspacesClient.ts` | `src/hooks/useFiles.test.ts`, `useFiles.dom.test.tsx`, `useFiles.snapshot.dom.test.tsx`: lag, stale reads, authority, capacity, equal-ETag persistence, fresh-document restoration and write ordering. Use their existing store/fetch seams. |
| 3. Creation and presentation | `src/components/pipelines/pipelineModel.ts:1226,1283,1352` tagged 202 result and guarded completion; `PipelineTemplatePicker.tsx` opener/attachment gating; `src/components/ProjectDashboard.tsx` receipt propagation; `PipelineBlock.tsx` and `src/components/kanban/PipelineSection.tsx` receipt-only status/actions; `src/lib/i18n/en.ts`, `uk.ts` matching keys | `src/components/pipelines/pipelineModel.test.ts` real response contract, 201 preservation, no premature PATCH or opener; existing DOM/browser cases for consumers. Preserve draft source metadata and unrelated drafts. |
| 4. Rendered integration | Existing `issue1695Evidence.fixture.tsx`, `issue1695BrowserHarness.ts`, desktop and phone browser drivers listed below | Actual POST/GET seams with controlled catalogs. Record requests, same ID, card counts, localized text and geometry across the complete matrix. |

Slice 1 removes the pre-handler 403 for permitted queue reads and must replace
that denial with a validated queued-project check. Slice 2 removes retirement
by catalog generation for queued receipts and replaces it with explicit
readback/authority settlement; ordinary optimistic overlays keep their guards.
Slice 3 removes the premature editable opener and replaces it with the same
card's receipt view. These replacements must all exist before delivery.

Record in the slice-1 fixture: response status/code, returned ID, read principal
class, project permission, queue state, stored count and POST count. For an
absent or unreadable row record an explicit unknown observation even though
there is no final pipeline. Slice 2 adds catalog generation/completeness,
authority generation, visible count and persisted locator count. Slice 4
uses those same transitions and records each frame's state/width/locale/theme.

### Read authorization controls

Exercise both the actual ID handler and its wrapper; a mocked status function
alone cannot prove access. Exercise the existing list and files paths as
negative controls because they can answer before receipt restoration.

| Principal or race | Required result |
| --- | --- |
| Creator with current project permission; another permitted member | Queued and refused ID reads disclose only authorized receipt fields; materialized ID answers normal 200. Both can see existing permitted stored rows. |
| Active member of another project; active team member in no workspace | Queue, refused and stored foreign IDs are denied; query/project hints cannot change that. Existing list/files contain no foreign row or receipt. |
| Anonymous or revoked session | Sign-in refusal through actual team gate; no receipt title, reason, project or ID leaks. Bearer-plus-member tests preserve the existing authority precedence. |
| Creator whose membership was removed | Creation history gives no read exception. Remove protected cached content and fence late completion. |
| Membership removal, project move or owner demotion while params/queue read/handler is awaited | Final current scope and record project check refuses. Remove the final check in an isolated mutation control: the corresponding test must fail. |
| Owner or solo caller at entry, team restriction by completion | Exact ID-read fast path must recheck and refuse changed authority. Existing solo and owner reads still work when stable. |
| Same ID appears in stored registry during queue read | Stored record wins once after checking its actual project; no duplicate card or POST. A stale queued reply cannot downgrade it. |
| Malformed ID, traversal, wrong embedded ID/project, damaged file, contradictory suffix records | No protected projection is emitted. Missing or unavailable evidence remains unknown; it cannot become success or a fabricated terminal result. |

For every relevant await, replace the local owner in the browser tests too:
fetch resolution, body decoding, snapshot read/write, delayed draft completion
and opener callback. Cover a new member with access to the same project: they
may explicitly read its queue record, but must not inherit the previous
member's local operation or draft intent. Selected-workspace changes merely
filter visible permitted receipts; leaving and returning retains the original
ID under the original member. Regrant starts fresh authorization, with no POST.

## Reusable-driver acceptance

Use existing drivers; add one named `accepted queued creation continuity`
describe block and a reusable scenario in their existing fixture/harness.
Current drivers do not have a complete queued-create scenario: their default
fetch interception supplies invented pipeline/catalog answers. Forward this
scenario's POST and ID readback to the owned server's real route handlers.
Use `serveEvidenceFixture` and `openFixture` in
`src/components/kanban/issue1695BrowserHarness.ts`; mount the real `Viewer`.
Controllable delayed catalogs may omit the accepted ID; queue and terminal
outcomes must still originate from the real producer/controller seams.

| Driver | Required cases |
| --- | --- |
| `src/components/kanban/kanbanBoard.browser.test.tsx` | Desktop board and expanded task/pipeline view at 1440 × 900 and intermediate 900 × 900; real create → 202 → two full catalogs → materialized/refused. |
| `src/components/mobile/issue1671Evidence.browser.test.tsx` | 390 × 844 with touch enabled; board, task and pipeline navigation, Back and reload, same states and ID. |
| `scripts/capture-board-geometry.ts` | Reuse if card chrome/layout changes need existing geometry capture. No additional issue-specific driver. |
| `src/components/conversation/conversationWindow.browser.test.tsx` | Add a case only if implementation changes a conversation surface. Preserve its current behavior otherwise. |

For **every reachable state**, capture 390, 900 and 1440 widths in **en and uk,
light and dark**. This is 12 combinations per state per changed surface.
Show the defining state text on the first screen. Capture the receipt on
the board and its opened detail at each width, plus revoked-shell evidence.
Record actual expiry as unsupported until its server contract exists;
unsupported coverage cannot be called passing.

Fixtures include a separate unsent agent draft, another pipeline card and two
pipelines attached to the same task. Assert their identities and drafts remain
unchanged. Include a normal 201 creation and same-ID repeated materialization.
Use realistic maximum-length titles, long safe refusal text, stage names and
non-default runtime fields. Do not copy private data into fixtures or frames.

Measure text ranges as well as element boxes: zero foreign-text overlaps,
zero clipped state/reason lines, zero text beyond viewport or scroll edges.
Exercise card menus, status tooltips, the picker and opened detail at the
narrowest host width. Verify 44-pixel phone targets, the applicable desktop
accessibility floor, 4.5:1 ordinary text contrast, focus visibility and
keyboard access. Existing modals must keep the background inert. Keep native
desktop scrollbars visible and record their gutter. Inspect every final PNG
visually, without OCR. Close each owned page/context/browser/server in cleanup.

### Behavioral acceptance before visual sign-off

- Real HTTP 202 enters the browser `createPipeline` path and retains one
  visible ID through at least two complete missing-ID catalogs. Base-red and
  head-green use the same test; a hand-authored Pipeline object is insufficient.
- Cover 304, delta, pinned/global simultaneous subscribers, an older response
  arriving last, and disposal between response and body decoding.
- Drain the actual queue twice: one durable row, one visible card. A later
  stale queued response cannot overwrite the materialized result.
- Cause a genuine terminal refusal in an owned queue fixture, then reconcile
  it through the same authorized reader. Missing rows and network failure
  remain unresolved. Distinguish an operation lease expiry from create expiry.
- Change member, revoke workspace membership, move the project, switch the
  selected workspace and sign out at each await. Test foreign-ID reads and
  regrant followed by a fresh success. No prior-member text may reappear.
- Navigate away/back and reload while queued, refused and materialized ahead
  of the catalog. Authorized durable recovery must identify the same operation
  without POST replay. These are mandatory cases in this lane.
- Preserve ordinary optimistic PATCH rollback, stored creation, attached
  links, unsent drafts and unrelated cards. Test cap pressure and cleanup.

Run each explicit file separately in an owned export with isolated `HOME`,
`XDG_CONFIG_HOME`, `TMPDIR`, `LLV_STATE_DIR`, account-home aliases and a closed
Viewer control URL. Use the assigned gate wrapper directly, fresh logs and
the actual exit status; no recorded-check machinery. Direct targets are
`src/hooks/useFiles.test.ts`, `src/hooks/useFiles.dom.test.tsx`,
`src/hooks/useFiles.snapshot.dom.test.tsx`, and
`src/components/pipelines/pipelineModel.test.ts`, plus direct tests for any
presentation component changed. The real HTTP producer case belongs in the
existing `src/app/api/pipelines/route.busy.test.ts` fixture. Browser cases run
by describe-name filter with `LLV_KANBAN_BROWSER_TEST=1` or
`LLV_SWIPE_BROWSER_TEST=1` and `CHROME_BIN`. Do not run a full suite, build or
typecheck in this stage. Normal publication hooks remain authoritative later.

Retain revision, fixture patch, exact command, timings, exit status, request
counts, geometry readings and frames under `LLV_EVIDENCE_DIR`. Require the
fixed three code-review rounds for the authorized read dependency, established
before the first traversal, and two visual-review rounds, plus a final visual check
of frames from the final source. Ordinary deployment and installed acceptance
are subsequent work and must be reported separately.

### Planning-stage verification record

This continuation re-read the issue body and both comments, current source,
23 open PR file lists, relevant published patches and available local deltas.
It re-read the original observation manifest, patch and actual-exit log; it did
not rerun the unchanged product probe. The preserved result is one passing
readback control and one expected continuity failure, exit 1. New hostile-input,
reload and rendered cases above are implementation acceptance, with no claimed
pass at this planning stage. The local Next route-handler and server/client
guides were consulted. A fresh document-only publication privacy check and a
final source/issue/head recheck accompany this document in private evidence.

## Deferred — not currently justified

- Admission deadline changes or reimplementation of #3658.
- The whole one-second latency objective, first-agent readiness and stage
  transition latency; this design claims no speed improvement.
- Discovering unrelated MCP-created queued work across every client.
- A browser receipt database, independent poller, new durable queue, server
  engine refactor, automatic POST replay or fabricated expiry policy.
- Composer, document, settings or board redesign; new capture frameworks.
- Installation changes, deployment, historical uncertain-launch recovery,
  production replay and cleanup.

The implementation is complete only when accepted identity survives catalog
lag and reload, and the authorized actual result replaces it. The read repair
is part of that implementation and requires independent source review. This
document is a completed plan; product head-green and rendered acceptance remain
the builder and review stages' work.
