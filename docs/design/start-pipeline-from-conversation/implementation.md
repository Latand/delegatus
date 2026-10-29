> start a pipeline from an existing conversation.

Source: operator ask dated 2026-09-16, operator-asks record, as supplied in this stage's pinned requirement. The sentence above is the supplied wording; the earlier Cloud design's longer problem statement is a synthesis.

# Start a pipeline from a conversation: implementation

Status: ready for backend and UI implementation. No operator decision is outstanding.

The operator chose variant 3, “Меню картки → чернетка на картці”, on 2026-10-27 at 00:27:14 UTC, with an empty comment. This settles the entry point and presentation: the task card's menu creates an editable draft on that task. Start is a separate action.

## Evidence and scope

Product references below were read at `1cfb0bcc3f19af561f06eeb82f176f67400a090e`. The selected prototype is on `pipeline/finish-the-one-approved-extra-prototype-5f3fa751`, preserved by `refs/backup/seat188/proto-5f3fa751-0bdd06a66` at `0bdd06a66`. Its sources are `docs/design/start-pipeline-from-conversation/prototype-v2/{README.md,prototype.fixture.tsx,prototype.css}` at that ref. They are absent from this implementation base; read them from the ref or the preserved prototype checkout. Keep those sources available to the UI and visual stages.

The primary decision record is prototype review `pr_f6d64eb6`, read with `read_prototype_review`. All eight variant-3 review composites were opened and visually inspected: `.artifacts/start-pipeline-from-conversation-v2/review/variant-3-{desktop,phone}-{en,uk}-{light,dark}.png` in the prototype checkout. Each combines frames a and b, covering all sixteen selected frames: 1440×900 and 390×844. These are existing prototype evidence, with no claim that implementation frames have been rendered.

Observed in those frames:

- Desktop: a tall row in the compact task menu names the source conversation and branch. The expanded card holds dashed Builder and Reviewer pills, Start in the lane's tail, and the Builder's open first-message panel with Edit.
- Phone: the task menu is a sheet. Creation opens the existing pipeline screen over that task; stages and their configuration controls precede the first message, and Start pipeline sits at the foot.
- The initial message contains the problem, constraints, work already discussed and remaining work. It is editable before anything is sent.

Earlier answers were checked through project-scoped and cross-project transcript/memory searches, the prototype decision, and `docs/design/pipeline-from-conversation.md`. The latter proposes checkout custody, blocking source sends and agent adoption options. Those proposals were never implemented and the selected prototype does not establish those requirements. This document defines a fresh pipeline from a committed source revision. The earlier design remains historical context; its unanswered questions do not reopen the selected interaction.

## Existing paths to reuse

The mounted path is `src/app/page.tsx` → `Viewer.tsx` → `ProjectDashboard.tsx`. The dashboard renders `KanbanBoard` on desktop and `MobileTaskScreen` / `MobilePipelineScreen` for those phone navigation entries. `KanbanCard.tsx` mounts `PipelineBlock` and, when a waiting pill is opened, `StageDraftPanel`. These are reached product paths. The two prototype fixtures, the old conversation-menu proposal, and `PipelineTemplatePicker` are reference material for this flow; this action does not open the template picker or add a conversation-menu/composer entry.

| Existing code | Reuse and evidence |
| --- | --- |
| `src/lib/pipelines/engine.ts:13436`, `types.ts:1345` | `createPipelineFromRequest` with `autoStart:false`, ordinary stages and task links. It stores a draft with no worktree or attempt. `engine.creation.test.ts:2184` asserts no provisioning/spawn, including after ticks. |
| `src/lib/pipelines/engine.ts:13520` | A draft with `baseBranch` requires `baseRef`. Supply both from local Git. `engine.creation.test.ts:2321` asserts the pin survives Start. |
| `src/lib/pipelines/store.ts:2032`, `:2290` | Atomic creation-key replay and normal generated pipeline branch/worktree identity. No new draft store or checkout ownership mode. |
| `src/lib/pipelines/preflight.ts:140`, `git.ts:173` | Read-only repository admission and local resolution of a pinned commit. Call preflight directly before creation: the generic engine can initialize plain folders, which this action must refuse. |
| `src/lib/pipelines/engine.ts:15025` | Existing `start` mutation validates graph, engines and task location, then enters provisioning. The controller provisions a fresh worktree from the pinned SHA; `git.ts:196` shows the checkout operation. `engine.creation.test.ts:2351` exercises draft start through provisioning/spawn. |
| `src/components/kanban/stageDrafts.ts:106`, `StageDraft.tsx:70` | Shared draft editor, optimistic Save, stage digest checking, conflict recovery and unconfirmed-write checking. `KanbanStages.dom.test.tsx:600`, `:626`, `:649`, `:670` cover these behaviors. |
| `src/components/pipelines/StagePlaceholderPane.tsx:86`, `StagesSheet.tsx` | The placeholder pane already edits roles/runtime and offers removal/reorder; StagesSheet currently displays stages and messages. Mount the existing pane from desktop configuration as the phone already does. Add the small append-stage control over existing `add-stage`; reuse existing mutation guards. `engine.settlement.test.ts:635` covers draft graph editing. |
| `src/components/kanban/pipelinePorts.ts:44`, `src/hooks/useFiles.ts` | Existing pipeline reads/writes and confirmed snapshot replacement. The new creation client applies the returned record through the same snapshot mechanism and emits the existing pipelines-changed event. |
| `src/lib/selection/resolve.ts:115`, `src/lib/mcp/selectedContextTarget.ts:359` | Keyed canonical conversation lookup. Never scan the transcript corpus to resolve one id. |
| `src/lib/mcp/bindings.ts:2896`, `src/lib/session/messagesPage.ts` | Pinned descriptor/root checks and normalized, bounded visible-message reading. `messagesPage.test.ts:82`, `:121`, `:253`, `:283` cover dialects, filtering, redaction/bounds and bounded empty pages. |
| `src/components/kanban/KanbanBoard.tsx:1490`, `compactMenuModel.ts:58`, `compactMenu.tsx:40` | Card menu handler, explicit compact layout and tall row. A new action must be included in `cardLayout`; arbitrary extra handlers are otherwise omitted. |
| `src/components/mobile/MobileTaskScreen.tsx:1017`, `MobilePipelineScreen.tsx:474` | Task sheet and existing pipeline/stage-configuration navigation. Mobile first-message editing uses the same `StageDrafts` and `StageDraftMessage` implementation. |

These references describe observed code/tests. New guarantees below require the implementation tests specified later.

## Server contract

Use one new route, `src/app/api/pipelines/from-conversation/route.ts`, with GET for the menu's source preview and POST to create the draft. Keep the generic `POST /api/pipelines`, MCP `create_pipeline`, and existing PATCH contract unchanged. A new MCP tool is unnecessary for the selected operator action.

The backend owns a browser-safe type-only file, `src/lib/pipelines/conversationDraftContract.ts`, publishing the following request/response types. The UI imports its types without modifying it.

### Preview

`GET /api/pipelines/from-conversation?conversationId=<id>&taskId=<id>` resolves one source. It returns:

```ts
{
  ok: true,
  source: {
    conversationId: string,
    title: string,
    branch: string,
    head: string,             // full local commit SHA
    sourceRevision: string,   // opaque hash of the resolved source facts
    canCreate: boolean,
    refusal?: { code: string; error: string }
  }
}
```

A known source with a dirty working tree returns `canCreate:false` with `SOURCE_HAS_CHANGES`. Unknown, inaccessible or missing resources use the errors below. GET writes no pipeline, task, repository or transcript, and returns no message bodies. Its imported-source metadata fallback may read a bounded transcript header/tail; it never assembles the first message. It exists because `FileEntry` carries cwd/worktree metadata but does not carry a reliable live Git branch. Fetch only while the card's menu is open; keep results in that mounted menu and discard them on close. No background polling or new global cache.

### Create

`POST /api/pipelines/from-conversation` accepts exactly:

```ts
{
  conversationId: string,
  taskId: string,
  sourceRevision: string,
  clientRequestId: string
}
```

Reject unknown fields and malformed/non-string ids, including supplied repository, transcript path, branch, task text, stages or `autoStart`. The browser cannot select a filesystem path or substitute source text. Bound `clientRequestId` to 128 characters and the JSON body using the existing bounded JSON reader. A successful initial call returns `201 {ok:true,pipeline:Pipeline}`; replay returns `200` with the same current pipeline. It always creates with `autoStart:false`. A newly created result has no attempts and does not request a controller tick. A replay may return a pipeline that has since started; the UI renders its returned state.

Call `createPipelineFromRequest` with `briefer:{kind:"operator"}`, `allowOperatorDraftWithoutLineage:true`, no `src`, and its existing `creationRequest` option. Store the validated conversation source through the internal creation option defined below, atomically with the draft. The key is namespaced for this route and the authenticated human principal; its digest covers the normalized request fields. Check the existing indexed creation-key lookup after authority checks and before recapturing source content. A committed replay returns the original pipeline even when the source has subsequently advanced. Different request fields under one key return 409 `idempotency_conflict`. `createPipelineWithDelivery` also checks the key within its transaction, so two simultaneous submissions converge.

After success, record the direct operator request through `recordOperatorRequest`, keyed by the returned pipeline id as the generic create route does. Replays share that activity key.

Use `queueWhenBusy:false` for this route. A pre-admission state-lock refusal returns 503 `store_busy`, `retryable:true`; no queue entry or draft exists. This keeps uncertain-response recovery on the existing durable pipeline creation key and avoids adding a second receipt/queue system. Repeating the same request after a timeout resolves the same key. Never choose a new key automatically after an ambiguous response. A successful replay must retain edits already made to that draft.

### Identity, repository, branch and commit

1. Canonicalize the durable conversation id through the registry and use its latest generation. Obtain cwd from that generation's launch profile; for imported conversations missing that field, hydrate only its registered transcript's metadata through the existing targeted, pinned reader (`tailLines:1`, avoiding `readSession`). Never fall back to the dashboard's project folder or the server cwd. Claude/Codex metadata hydration already exists; a registered Copilot source with usable launch cwd can use the same Git and message path. Missing cwd is a refusal.
2. Resolve cwd to its real, existing directory and run uncached `preflightPipelineRepo`. Require a non-bare Git working tree, a named local branch, and an existing HEAD commit. Use the returned top-level working-tree directory as `repoDir`. For a linked worktree this remains the source worktree's top level, so its local Git objects and refs are authoritative. Use `projectInfoFromCwd`/canonical project resolution for grouping; do not derive a second project key from the sibling's name.
3. Read the symbolic branch and `HEAD^{commit}` with bounded asynchronous Git commands, sanitizing ambient Git discovery variables as preflight does. Refuse detached/unborn HEAD. Record the full SHA as both the create request's `baseRef` and the draft's `lastPassedCommit`; set `baseBranch` to the source branch. Here `baseBranch` also names the eventual merge target. Creation and Start perform no fetch to replace this pin.
4. Require clean tracked and untracked state (`git status --porcelain`, with optional index writes disabled). Refuse dirty state with “Commit the conversation's changes before creating a pipeline.” Ignored files retain Git's normal behavior. No auto-commit, stash, file copy or source checkout takeover occurs. This prevents the selected draft from silently omitting unfinished source work.
5. Derive `sourceRevision` from the canonical id, generation identity/path, transcript device/inode/size, real repository and Git-common-directory identity, branch and HEAD. Recheck those facts after capture and before persistence. POST refuses `SOURCE_CHANGED` if they differ from the menu preview. Transcript append changes the cutoff; a replacement/symlink swap is refused. Keep one request deadline, propagate cancellation, and close descriptors.
6. Leave `branch` and `worktreeDir` to `pipelineIdentity`. Start creates the normal `pipeline/<slug>-<id>` branch in a new managed worktree **from the pinned conversation commit**. The menu shows the source branch; the resulting draft uses the normal generated lane identity. Source conversation activity and later commits do not retarget the saved draft. The source stays usable because the pipeline works in its own checkout.

Example: source branch `fix/export-retry` at commit A creates a draft with `baseBranch=fix/export-retry` and `baseRef=A`. If that branch moves to B before Start, the new pipeline branch still starts at A. The ordinary source-branch merge target remains `fix/export-retry`. No GitHub read is required, and a repository without a remote works locally through existing pipeline delivery rules.

The normal Start preflight may refuse if `repoDir` has disappeared. It must retain that failure rather than switching to main or another checkout. Repository selection is not part of the new inline editor. Existing generic repository changes remain their existing explicit action, which clears the pin as `update-draft` already does; do not preserve a conversation pin across a repository move.

### Builder's first message

Use deterministic source excerpts. Draft creation launches no agent to summarize the conversation and incurs no model generation.

Open the registered transcript with `openPinnedTranscript`. Read `kind:message`, roles user/assistant only, through `readMessagesPage` at the descriptor's captured size. Use at most six recent visible messages, up to 700 characters each, a total scan allowance of 1 MiB, and at most four page reads sharing that allowance. Reverse the retained records into chronological order. Include the first user request when available from the bounded search-head reader (up to 1,000 characters, redacted before clipping). Read that head through the pinned descriptor alias or an equivalent identity-bound helper, never by reopening an unchecked path. Deduplicate the first request if it is already among the retained messages. If neither source has usable visible text, refuse `SOURCE_TEXT_UNAVAILABLE`; the task title alone is insufficient.

Compose the editable extra text from the source title, source conversation reference and capture cutoff, the first request and recent messages labelled by role. State that the recent section is an excerpt when messages or characters were omitted; retain the source reference so the Builder can read earlier context. Assistant statements remain attributed statements, including claims that tests passed. This initial seed is a bounded quotation of the conversation; it makes no claim to be an exhaustive summary. The prototype's authored sample brief is an example of the editable result.

Keep the complete stored Builder prompt within `MAX_STAGE_PROMPT_LENGTH` (currently 8,000 JavaScript string units), including wiring, separators, labels and the source reference. Reserve those overheads first and fit excerpt text within the remainder; clip at Unicode code-point boundaries. Never append arbitrary metadata after checking the limit. Redact the visible `text` projection with the existing hardened redactor; never use the non-enumerable `sourceText`, reasoning, tool bodies, traces or hook attachments. Render literal reserved wiring tokens found inside excerpts as ordinary visible text, so quoted source data cannot acquire template semantics.

Store this text only in the Builder's `stage.prompt`, after the normal task wiring. Leave `pipeline.spec` unset for this action: a second immutable copy would defeat edits to the first message. The task title stays pinned through existing prompt rendering. The saved stage prompt is the captured brief and survives reloads/retries without rereading the source; edits use existing stage-digest protection. Review/fix receive the existing stage-output relay and pinned task. The normal role scaffold and access/verdict instructions are added by `renderStagePrompt` when an attempt launches. Do not add another prompt renderer or frozen transcript artifact.

### Initial stages and task binding

Seed the prototype's two ordinary run stages, using project role defaults and no engine/account/model pins:

| id | role | prompt input | pass | fail |
| --- | --- | --- | --- | --- |
| `builder` | `builder` | task wiring + captured editable text | `reviewer` | Existing builder failure behavior |
| `reviewer` | `reviewer` | previous output wiring | end | `builder`, `maxRounds:2`, `onExhausted:"advance"` |

This matches the prototype's named pills and fail edge. The current client `buildReview` template contains a retired `review-loop`; do not copy that stage kind or change the global template for this feature. Role defaults, account eligibility, normalization and graph validation come from the existing engine. Preserve its explicit exhausted-review state; no new completion policy is introduced.

Require the submitted task to exist on this installation and belong to the canonical source project. Verify that the task holds the source conversation using its durable assignments and `assignmentHoldsIdentity` (canonical conversation identity first, launch/path fallback for legacy rows). A stage conversation's existing task assignment counts. Do not create a task or add an assignment as a side effect of this action. A stale/unbound card is refused with `SOURCE_NOT_ON_TASK`, then refreshed by the UI.

Set `taskIds:[taskId]`, `finishesTask:false`, and `task` to the nonempty first line of the stored task text, within `MAX_TASK_LENGTH`. Preserve task text, details, status, assignments and manual work links. Standard local/remote task-execution and proactive-work refusals still apply.

Keep `srcPath` and `srcConversationId` null, using the engine's existing operator-draft-without-lineage path. Source context needs a separate optional `Pipeline.conversationSource` value:

```ts
conversationSource?: {
  conversationId: string;
  branch: string;
  head: string;
  capturedAt: string;
};
```

This distinction follows a real consumer: `engine.ts:8790` passes `srcConversationId` as the container's `creatorConversationId` at spawn admission. `registry.admission.test.ts:488` and `spawnAdmission.test.ts:183` show that a reviewer creator causes refusal; no operator authority marker on the draft overrides that reading. Using the selected conversation as the creator would therefore break Start for reviewer sources and could inherit unwanted delegation depth. The operator-created lane has no agent creator. The source id remains a backlink and has no spawn/decision authority. Task membership joins the new pipeline and later attempts to the existing card independently of creator lineage.

Add `conversationSource` only to internal `CreatePipelineOptions`; the new handler supplies it after validation. Attach a copied value before the existing create transaction. The public `CreatePipelineRequest`, generic HTTP create and MCP create schemas gain no source metadata argument. Keep null creator fields through every launch/retry/recovery path, including successor spawn at `engine.ts:7783`, and leave `set-src` as its existing separate, explicit creator action.

Inventory for this additive stored field:

| Path | Required handling |
| --- | --- |
| New handler → `fromConversation.ts` → internal create option → `createPipelineFromRequest` | Sole producer. Validate bounded conversation id/branch, full SHA and ISO cutoff; store alongside the pinned base before any success response. Never reconstruct it from a prompt or client payload. |
| `types.ts` → `store.ts` shape validation, `reviveLoadedPipeline`, `cloneLoadedPipeline` / controller clones, decode and serialization | Optional on older records, validated when present, copied without shared mutable nested references. Existing JSON storage needs no database migration or schema-version bump. Round-trip and independent-copy tests cover it. |
| Draft edits, graph/role edits, Start, retries, close/archive and creation-key replay | Preserve it on the same pipeline id. It is historical source evidence; a later explicit generic repository move clears the execution pin as before while retaining the historical source. `set-src` changes creator authority only and never rewrites this evidence. |
| Generic operator create, MCP create, task-spawn create, refresh/successor create | Default absent. New pipeline ids do not inherit source metadata accidentally. No new creator-authority exemption. |
| Full pipeline GET/list/board snapshots and UI optimistic copies | Preserve the optional value through existing whole-record projections/spreads. Desktop/phone match an existing draft by `conversationSource.conversationId`, and the source link opens that id through existing conversation navigation. |
| Compact MCP list/ack projections and linked-install `src/lib/links/laneFeed.ts` rows | No new fields required. Their current explicit projections omit this source metadata; linked installations receive no transcript context. |

The saved first message and `conversationSource` are immutable capture evidence until ordinary first-message editing changes the message. Branch/head provenance remains the original capture after such an edit. There is no additional source store or retained transcript copy.

### Authority and errors

Wrap both handlers in `workspaceRoute("/api/pipelines/from-conversation", ...)`, run `rejectCrossOrigin`, and require `operatorBrowserRequest` for this browser-only action. In solo mode this requires a verified browser session. In team mode a signed-in member also needs the existing workspace action permission for this action, including its preview. Check `canAct` on the resolved projects in both methods; a view-only member gets no creation preview. Agent capabilities, internal service credentials and anonymous loopback requests do not grant this new action.

The wrapper already recognizes `conversationId` and `taskId`. Also assert access to the server-resolved source, task and real repository project before reading content or creating a record; match them after canonicalization. Recheck permission immediately before the mutation and on a creation-key replay. No path/branch/text from the browser participates in resolution. Do not weaken the existing generic pipeline or MCP authority paths.

| Condition | Result and effect |
| --- | --- |
| Malformed/extra fields or invalid request key | 400, no write |
| Foreign origin, unauthenticated/agent caller, or forbidden workspace | 403 through the existing authority errors, no source content |
| Unknown conversation/task | 404 after authorization, no write |
| Missing/deleted cwd, non-Git/bare directory, detached/unborn HEAD | 409 `SOURCE_WORKING_COPY_UNAVAILABLE` or `SOURCE_BRANCH_UNAVAILABLE`; never initialize a repository |
| Dirty source | 409 `SOURCE_HAS_CHANGES`, keep source untouched |
| Card no longer holds source, or project mismatch | 409 `SOURCE_NOT_ON_TASK` / `SOURCE_PROJECT_MISMATCH`, no write |
| Preview facts changed, transcript replaced or source unreadable | 409 `SOURCE_CHANGED` / `SOURCE_TEXT_UNAVAILABLE`; refresh preview explicitly |
| Git/read deadline or pre-admission lock contention | 503 with a retryable code; no retained draft/queue |
| Engine/account/task-location validation | Preserve the existing structured failure or draft warning; no invented fallback runtime |
| A valid replay | Same current pipeline; no second draft, overwrite, worktree or launch |

Use asynchronous Git commands under a single bounded request deadline. Keep transcript reads bounded as above, outside the pipeline write lease. Register `pipelines.from-conversation.preview`, `pipelines.from-conversation.capture` and `pipelines.from-conversation.create` in `viewerLoopMonitor.ts`, and wrap those operations through `withViewerOperation`. Add no controller sweep, startup import, schema migration, new cache or full-store scan. This design claims no performance improvement.

## Frontend states

The source is explicit in the menu before creation. Build candidates from the task's currently held local conversation rows with a canonical id; deduplicate generations by canonical id. Prefer rows with recorded cwd. If several qualify, use the most recently active one (descending `mtime`, then canonical id). If none carries cwd metadata, preview the latest local conversation so server-side metadata hydration can still admit imported sources. This deterministic choice adds no picker: the row names the actual chosen conversation and branch. Recompute when the menu next opens, never silently switch a selected source while its request is pending. A server refusal prompts refresh; it never silently chooses another conversation.

| State | Desktop | Phone and common behavior |
| --- | --- | --- |
| No task or no local conversation candidate | Omit the action. Existing card/menu actions remain available. | Omit it from the task sheet; remote-only rows cannot start work locally. |
| Preview pending | Show the existing tall-row shape with the conversation title and a localized checking state. | Same sheet row. Disable only this action until the branch/eligibility is server-resolved. |
| Ready | “Pipeline from conversation…” / “Пайплайн з розмови…” with title and source branch, as frame 3a. | Same words/hint in `MobileSheetRow`. |
| Preview unavailable/dirty | Disabled row with the specific localized reason and retry where transient. | Show the reason in the sheet, with no fabricated branch. |
| Creating | Close the menu, expand that card and show an immediate temporary preparing area. POST once with a stable key. | Close the sheet and show preparation on the task; navigate only once a real pipeline id exists. Creation waits for server-computed source text/identity; the area has no fake pipeline id or editable speculative text. |
| Draft ready | Apply the returned pipeline snapshot, open Builder's existing draft panel, and show ordinary task-density stage pills with Start in the lane tail (frame 3b). | Push the existing pipeline screen over the same task. Show stages/configuration, the Builder first-message section, Edit, and the fixed Start pipeline foot. Returning to the task still shows that lane. |
| Edit message | Use `StageDraftMessage`/`StageDrafts`, including Save, Cancel, conflicts and unconfirmed-write recovery. | Mount the same editor/store; do not implement a phone-only save path. |
| Edit stages | A waiting stage's Configure action mounts the existing `StagePlaceholderPane` in the existing stages sheet; role/runtime choices, removal and ordering use that pane. A shared + Stage control appends through `add-stage`. | Existing configuration sheet mounts the same pane; the same + Stage control appends a stage. Keep these controls reachable from both surfaces. |
| Start | Flush or resolve unsaved stage edits, then send the existing PATCH `action:"start"` once. | Same operation from the footer. Disable Start while text/graph edits are unsaved, saving, conflicted or unconfirmed, with a localized reason beside it. Start is server-validated and launches work, so do not optimistically announce running. |
| Started | Replace with the server-returned provisioning/running lane; current stage opens through normal pipeline navigation. | Remove draft-only footer and first-message edit action once the stage starts; existing stage/conversation screens remain reachable. |
| Create refused | Remove only the temporary preparing area; keep task/source unchanged, show the error on that card with Retry. | Stay on the task with an in-place error. Retry known transient failures with the same request. `SOURCE_CHANGED` requires a new preview and explicit retry with a new logical key. |
| Create response lost | Keep the pending request identity and show Check again; repeat the identical POST to resolve its durable key. | Do not create another request key, jump to a guessed lane, or announce failure without reconciling. |
| Start refused/response lost | Keep the saved draft and edits. A known refusal shows its reason beside Start. For an unknown outcome, read that pipeline before retry: provisioning/running means Start landed. | Same recovery; no second launch or rollback over a confirmed server state. |

If this task already shows a draft with the same `conversationSource.conversationId`, the action opens that draft/editor. During one pending create, suppress duplicate submissions for that source/task. Existing running pipelines stay visible; creating a later draft remains possible through a fresh intentional action. There is no global one-pipeline-per-conversation constraint.

Implement the small shared `DraftStageControls.tsx` as composition around `StagePlaceholderPane` and an append-role control. The append action names the last pass stage explicitly through `after`, uses a unique id derived with the existing stage-id helper, and supplies current graph/stage digests. Reuse role catalog and optimistic stage helpers from `pipelineModel.ts`; inspect the returned graph on any refusal. This is the missing UI glue: the current card has no generic add-stage button. A general graph editor is outside this feature.

Keep the preview and creation client/store shared between desktop and phone so breakpoint changes retain a pending key and unsaved text. Let it live with the dashboard and subscribe the card and phone leaf; clear settled transient state and abort an obsolete preview on close. Today `KanbanBoard.tsx:439` owns `StageDrafts`. Lift that instance to `ProjectDashboard` and pass it to the board and phone pipeline screen, retaining an optional local default for standalone board/test callers. Reuse that single stage-draft store for text. Saving edits shows the new words immediately and rolls back/reopens on known failure, as it already does.

Add both shipped locales in `src/lib/i18n/en.ts` and `uk.ts`. Reuse existing draft/edit/start/engine error strings where they fit. Scope style changes to this flow. Carry the prototype's draft-bubble Edit clearance and dark primary-button treatment into product styles. The composer strip/menu changes belong to unchosen variants. Buttons must be siblings of clickable lane surfaces, with propagation handled; do not nest a Start button inside another button/link or copy the prototype's DOM insertion helpers into product code.

## Builder ownership and integration order

Backend completes and is reviewed before UI starts. The contract above is fixed for both builders. Backend may add/modify only its row below; UI may add/modify only its row. Each reads the other's code. A contract defect goes back to the backend owner as a repair; the UI stage does not patch server files. No builder edits this design document.

| Owner | Files |
| --- | --- |
| Backend | New `src/app/api/pipelines/from-conversation/route.ts` and `route.test.ts`; new `src/lib/pipelines/conversationDraftContract.ts`, `fromConversation.ts`, `fromConversation.test.ts`; `src/lib/pipelines/{types.ts,engine.ts,store.ts}` and `engine.creation.test.ts` / `store.test.ts` for the additive source field/internal option; `src/lib/viewerLoopMonitor.ts` for its operation label. Only if identity-bound excerpt reuse requires extraction: new `src/lib/session/pinnedTranscript.ts` and its tests, plus the import-only extraction in `src/lib/mcp/bindings.ts`. Existing exported pinned/targeted readers can be reused directly to avoid that extraction. |
| UI | New `src/components/pipelines/conversationDraftClient.ts`, `useConversationDraft.ts`, `conversationDraftClient.test.ts`, `useConversationDraft.dom.test.tsx`, shared `DraftStageControls.tsx` and its adjacent DOM test; `src/components/ProjectDashboard.tsx`; `src/components/kanban/{KanbanBoard.tsx,KanbanCard.tsx,compactMenuModel.ts,StageDraft.tsx,StagesSheet.tsx,stageDrafts.ts,pipelinePorts.ts,kanbanBoard.css}`; `src/components/pipelines/{PipelineBlock.tsx,pipelineBlock.css,pipelineModel.ts}` as needed for the tail Start slot; `src/components/mobile/{MobileTaskScreen.tsx,MobilePipelineScreen.tsx}`; `src/lib/i18n/{en.ts,uk.ts}`; adjacent DOM tests; existing `src/components/kanban/{kanbanBoard.browser.test.tsx,issue1695Evidence.fixture.tsx,issue1695BrowserHarness.ts}` for rendered evidence. |

The engine/store changes are limited to carrying and validating the optional source metadata through the existing creation path. The generic create route, public create request/MCP schemas, pipeline PATCH route, runtime host, global templates, task membership writer and conversation composer need no edits. Their existing interfaces supply the remaining behavior. If a builder finds a missing behavior there, report the concrete mismatch before extending scope; retain the file ownership split when assigning its repair.

Open-work collision check on 2026-10-27: open lanes were read with `list_pipelines(state:"open")`, following its cursor through all 37 records. Relevant actual diffs were inspected against this base: task summary UI (`143e8c1b`) touches `MobileTaskScreen.tsx` and `kanbanBoard.css`; publication recovery (`e4df452a`) touches the generic engine; workspace fences (`a264a66b`) touch workspace admission and MCP bindings; the model badge lane (`fe0ae55e`/successor `04b5bc7d`) touches runtime pills and readers; the older prototype lane (`6ec5a459`) remains open. The selected preserved prototype was read separately. Keep changes local to the new row/draft controls, preserve summary/runtime changes when integrated, and avoid the optional MCP extraction if its concurrent edit can be avoided. A final ref check found `origin/main` advanced from this base to `ac965a07e2a6093e95bccf62f207799d46e28a3b`: its sole diff adds phone-composer browser coverage in `src/components/mobile/issue1671Evidence.browser.test.tsx`, outside this contract and ownership split. The assigned HEAD stayed at the recorded base. At implementation/review time compare the same file sets to the then-current base again. No GitHub read gates implementation or the Git-only path.

## Acceptance and checks

Backend tests use synthetic repositories/transcripts and the real new handler plus existing engine/store interfaces. Inspect fixtures before relying on any role or identity. Test behavior and effects; write no assertions about instruction/scaffold wording.

1. A clean named source branch with a commit beyond local main creates a persisted draft on exactly the submitted held task, with null agent creator and validated `conversationSource`. There is no worktree, attempt, spawn, fetch, push or task mutation at creation. A remote-less repository passes too.
2. Commit A is captured, then move the source branch to B after creation and start the draft. The real new worktree's HEAD is A on the generated pipeline branch, and its Builder starts once with that worktree as cwd. Use a Reviewer source for one real-registry case: operator creation and Start succeed with a null container creator; a Reviewer agent calling the new endpoint is refused. A second Start is refused or reconciled from the current pipeline state. A different source branch between preview and POST returns `SOURCE_CHANGED` with no draft.
3. Make the source tracked-dirty, untracked-dirty, detached, unborn, bare, missing or outside a working tree. Each reaches its named server refusal and creates no repository/commit/worktree. Delete cwd after draft creation and verify the ordinary Start failure preserves the pin.
4. Use a retired generation id/alias, then a resumed generation; verify canonical resolution and task identity. A missing legacy cwd never falls back to the dashboard project. Replace the transcript inode or a parent symlink after opening and prove the source check refuses. Do not prove the check by merely reading back values the request just wrote.
5. Normalize Claude/Codex and supported registered Copilot messages. Verify record-kind/role filtering, redaction before clipping, Unicode bounds, total scan/page bounds and empty-source refusal on hostile oversized/tool-only input. Seed fixtures with both an original constraint and later correction; check source ordering/provenance and truncation metadata without testing generated instruction phrases. The stored prompt remains within the engine cap. Append messages after creation and verify the saved draft remains unchanged; Save changes it only through the existing guarded edit. Round-trip through store reload, independent clones and archive and confirm optional metadata survives without aliasing; older records with the field absent remain readable, and malformed metadata is refused.
6. Send two concurrent identical create keys, simulate a lost successful response and replay after source movement and after a draft edit. Observe one stored id, preserved edits and no launch. A changed request under the old key conflicts. Inject `StoreBusyBeforeAdmissionError`: no queue/pipeline exists, and the identical retry succeeds once.
7. Exercise each server authority layer: anonymous loopback, foreign Origin, a valid agent capability (including reviewer), internal service credential, forbidden/view-only team member, source/task on different projects and a source not held by the task. Assert the observable refusal and absence of reads/writes. An authenticated solo operator and an authorized team member can preview/create. Also retain the existing generic create and PATCH authority tests; this route adds no shared exemption.
8. In real UI DOM tests, click the rendered compact-menu row (cover `cardLayout`), hold creation, release success/refusal, edit/cancel/save/conflict, alter stages and Start. Test multiple source ordering, no-source visibility, reopened drafts, breakpoint continuity and unknown-outcome recovery. Server refusal keeps text, source and task intact. Stage/Start entry points remain useful in draft and started states.

Run changed/new tests by explicit path through `scripts/gate-slot.sh` and `bun run test <file>`, one heavy run at a time. Use `checkEnvironment` from `scripts/gate-cache.ts` and then `isolatedEnvironment` from `scripts/local-gate.ts` where manual fixture checks need them. Set private HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR, plus a closed Viewer control URL; keep test/capture output under the stage's scratch export. Never import tests against live state. The backend's two new test files, the touched adjacent engine/store test files and UI's touched adjacent test files are the minimum stage checks. Existing relevant regression files, if their paths are changed or the review brief selects them, include `src/lib/pipelines/engine.creation.test.ts`, `src/components/kanban/KanbanStages.dom.test.tsx`, `src/components/mobile/MobileTaskScreen.dom.test.tsx` and `src/components/mobile/MobilePipelineScreen.dom.test.tsx`. Do not sweep directories.

The UI adds a case to the existing kanban browser driver, over the real product fixture and production CSS, with `LLV_KANBAN_BROWSER_TEST=1` and `CHROME_BIN`. No new capture driver or issue-numbered fixture. Render at 390×844, 915×900 and 1440×900, each in en/uk and light/dark. Cover menu, preparing, saved draft, message editing, stage selection, creation refusal, edit conflict, start refusal and started lane. Use non-default role/runtime selections and long real-looking synthetic titles/branches. Capture server-computed/unknown-result states with held responses. Inspect every PNG; record text-range clipping/overlap, first-screen defining words, target sizes, contrast and sheet focus isolation. Desktop scrollbars must be real. The phone sheet and pipeline footer must leave every message/control reachable, including after scrolling and keyboard opening.

Publication/integration retains privacy-publication, privacy-tracker-audit, runtime-gate and typecheck as required by the pinned brief and repository gates. The publication hook owns broad checks; individual stages run only their explicitly selected files, with no full build/typecheck unless their brief names it. The runtime host and Bun pin are unchanged. This design-only stage requires a whitespace/readability/reference check and the repository privacy gate on this document; it requires no source tests or browser rerender.

Validation performed for this document on 2026-10-27: all selected prototype review composites inspected, code/reference and file-ownership review completed, declared-output whitespace checked, and `bun scripts/privacy-publication-gate.ts --require-known-values --paths docs/design/start-pipeline-from-conversation/implementation.md` passed in a scratch source export with the committed fingerprint catalog and private HOME/config/state/temp/cache directories. No source tests, typecheck, build or browser render were run for this prose-only stage. The final worktree check permits only this declared output; no product file, index or branch was changed.

## Decisions and trade-offs

- Use an authenticated browser route with a preview method. It obtains the actual branch without extending every scanner/FileEntry projection or adding MCP metadata.
- Use a committed snapshot in a normal fresh pipeline worktree. Dirty sources receive an actionable refusal. This preserves pipeline lifecycle/cleanup ownership and the source conversation's ability to continue; exact-checkout transfer is deferred.
- Use the source branch as the merge target and its captured local HEAD as the pin. Later changes do not move an existing draft. Normal generated pipeline identity remains visible on the lane.
- Seed a bounded source excerpt without model summarization. The editable message and source reference make the captured scope reviewable; earlier context is available through the conversation reader.
- Keep the prototype's Builder → Reviewer graph and its fail-edge budget. Compose existing stage controls for changes and add only the missing append action. Neither the global template nor review policy changes here.
- Pick the newest held local conversation when several exist, and show its name/branch before acting. Reopen an existing source draft rather than replacing its edits.
- Keep ordinary publication defaults and `finishesTask:false`. This action creates work on the existing task; it does not declare the task done.

These are implementation choices within the chosen variant. No new operator choice, alternate entry point or additional confirmation screen is required.

## Deferred — not currently justified

- Borrowing the source checkout, copying uncommitted changes, auto-committing/stashing, locking source sends or adopting the current agent as the Builder. Each needs a separate custody/recovery contract.
- Semantic model summaries, complete transcript artifacts, attachment selection and historical-generation selection. The first version captures a bounded editable excerpt and retains its source reference.
- Conversation-menu and composer entry points, a template-selection modal, a new pipeline editor, new stage types, persisted template libraries and pipeline nesting.
- A source picker for cards with many conversations, global pipeline deduplication, and automatic source-to-draft refresh. The named deterministic source and explicit draft edits cover the selected interaction.
- New publication/merge settings, automatic task completion, GitHub prerequisites, runtime-host/deployment changes, and fixes specific to unchosen prototype variants.
