# MCP short ids: no long hashes for agents to retype

Status: design, 2026-10-16. Base commit `02f9301f` on main. Lane: the design
stage of the pipeline pinned to this task.

## 0. Originating requirement

Source: an operator request made by voice on 2026-10-16 and delegated to the
orchestrator seat, which pinned it to this task. In paraphrase: audit
Delegatus's MCP answers and the interfaces around them so that no model ever
has to rewrite a long hash, keep the hashes Delegatus shows as short as
possible, show a hash only where it serves as an id and then only in short
form, and make sure no hash has to be reconstructed or recalled from memory,
because that invites mistakes and hallucinated values. The expected result is
the fixes plus a check that holds this behaviour.

**Scope as read from the call record.** The voice call record and the
delegated text differ in two ways that shape the design:

1. In the call, the request to keep things as short as possible is about the
   hashes themselves; the delegated text widened it to whole answers. This
   design therefore builds hash removal and shortening. Answer sizes are
   measured before and after, as the pinned specification asks, and no general
   answer compaction beyond hashes is built here.
2. In the call, the operator placed the long hashes both in MCP answers and in
   other places they see. Those places include what the operator hears: §1.5
   shows the voice relay reading full task ids and 32-hex project keys aloud,
   so operator-facing text is in scope.

## Summary

Delegatus shows every hash as an 8-character short form. Every guard and lookup
that used to take a full hash accepts any prefix of 7 or more characters and
resolves it server-side against the current record, refusing a stale or
ambiguous value with a clear code. Full values keep working everywhere.
Default MCP answers pass through one output transform in the MCP service that
replaces whole-value hashes with their short forms, and Delegatus-authored
status text, prompts, wakes and reports stop carrying full hashes at their
source. A consent binding (the operator's approval of one exact issue-report
text) keeps checking the full digest server-side, because a short prefix can
be forged there; the operator and the agent stop seeing and copying it. A guard
test fails when a default answer or an agent-facing template carries a hash of
20 or more hex characters.

Ids that are not hashes (task, conversation, launch and operation UUIDs) and
pagination cursors are listed in the audit and deferred with their evidence
(§5).

## 1. Audit

### 1.1 Method and evidence

| Source | What was read | When / revision |
|---|---|---|
| Code | `src/lib/mcp/server.ts` input schemas (`TOOL_INPUT_SCHEMAS`, lines 3717–4520) and descriptions (3327–3716); bindings, projections, the guard sites in the engines and stores, prompt and wake renderers, UI components | base `02f9301f` |
| Live default answers | `list_pipelines {state: open, compact}`, `get_pipeline` default and `stageId`, `list_tasks {openOnly, limit 3}` through this stage's own MCP session | 2026-10-16, about 12:40 UTC |
| Fixture census | A scratch copy of the `answerSizes.test.ts` fixture (240 pipelines from `pipelineCorpus(240, 2)`, 240 tasks, 100 conversations) calling every tool through `createMcpToolService`, counting bytes and hex runs per answer. Run in a scratch export of the base commit with isolated HOME, XDG, TMPDIR and `LLV_STATE_DIR`, the control URL on a closed port, through `scripts/gate-slot.sh` | base `02f9301f`, 2026-10-16 |
| Transcript scan | Every local Claude and Codex transcript modified 2026-10-06 → 2026-10-16 that mentions a guard field (4,549 files); tool calls and their results parsed; 187 files contained guarded calls. For each passed value: did it appear verbatim earlier in the same transcript, and what did the call answer | 2026-10-16 |
| Voice relay | The 25 voice-call transcripts kept in state: the text of relayed reports, the handoffs the voice was told to read, and the voice's own replies | up to 2026-10-16 |

### 1.2 Tool inputs that demand a hash an agent copies

Line numbers are at base `02f9301f`. "Uses" are calls passing the field in the
10-day transcript scan.

| # | Tool · field | Value today | Schema | Server check | Where the agent gets it | Uses (10 d) | Design |
|---|---|---|---|---|---|---|---|
| I1 | `pipeline_action.expectedRevision` (resolve-decision, continue-review, accept-head, convert/revert-legacy-review) | 64-hex SHA-256 of the whole record | `server.ts:3922` `^[0-9a-f]{64}$` | `engine.ts:12393, 12502, 12641, 12669`; replay compares `12386, 12461, 12492, 12632`; `pipelineRevision` `store.ts:31` = `recordRevision` `listAnswers.ts:32` | `get_pipeline` `revision` | 283 | short guard, §2.3 |
| I2 | `pipeline_action.expectedStageDigest` (graph edits) | 64-hex stage or graph digest | `server.ts:3903` `^[0-9a-f]{64}$` | `engine.ts:11175, 11181`; format check `11292` | `get_pipeline` `stageDigests` / `graphDigest` | 469 | short guard |
| I3 | `pipeline_action.acceptedSha` (publish a moved head) | 40-hex commit | `server.ts:3929` `^[0-9a-f]{40}$` | `engine.ts:12799–12811` | stateDetail, wakes, git | 8 | resolved against the passed commit and the worktree HEAD |
| I4 | `flow_action.expectedHead` (agent-decision) | 40-hex commit | `server.ts:4108`; `flows/decisionSchema.ts:9` | `flows/decisions.ts:162` | `get_flow` `decisionContext.expectedHead` (`bindings.ts:5571–5574`) | 0 | short guard against the observed clean head |
| I5 | `update_task.expectedRevision` (pos, placement, hideGroup) | `task-v1:<uuid>` (44 chars) or `task-legacy:<64 hex>` | `server.ts:3822` ("copy the opaque revision") | `tasks/commands.ts:529`; `tasks/revision.ts:21–27` | `list_tasks` / `get_task` `revision` | 0 of 1,844 `update_task` calls | short guard |
| I6 | `role_presets.expectedRevision` | `roles-<v>-<20 hex>` | `server.ts:4442` | `roles/store.ts:353`; `bindings.ts:4808–4810` | `role_presets` read; the mandate's role table (`orchestrator/prompt.ts:634`) | 0 passes (7 calls of the tool) | short guard |
| I7 | `issue_report.digest` (show, publish) | 64-hex content digest | `server.ts:4468`; `issueReports/store.ts:33` | preview file `<digest>.json` (`store.ts:84, 133`) | `issue_report` preview answer `digest` (`bindings.ts:1927`) | 30 | set lookup among stored previews; consent binding stays full (§2.4) |
| I8 | `deploy_exact_sha.revision` | 40-hex commit | `server.ts:4066`; `bindings.ts:3488`; route `api/runtime/deployments/route.ts:147` | `selfUpdate/service.ts:1807–1810` (on the tracked branch) | `git rev-parse` in the seat's own shell | 61 | prefix resolved on the tracked branch (checkout installs), §2.3 |
| I9 | `resend_prototype_review_telegram.reviewId`, `dismiss_attention` prototype `reviewId`, `seat_tick_settings.autonomyDecision.review.reviewId` | `pr_<32 hex>` (SHA-256 prefix, `prototypeReview/store.ts:151`) | `server.ts:3719` `^pr_[a-f0-9]{32}$`; `4301, 4310, 4394` | review round lookups | `publish_prototype_review` answer | 0 in the scan | set lookup among the rounds |
| I10 | `backfill_worktree_projects.project` and every `project` / `expectedProject` argument (26 tools take `project`) | `repo-<32 hex>` / `dir-<32 hex>` (`projects/identity.ts:57`) | `server.ts:4013` `^repo-[0-9a-f]{32}$`; others free strings | `nameResolution.ts:147–185`; `boardReadProject` `bindings.ts:5617` (aliases only) | `project` fields in answers, refusal candidate lists | — | short key resolved once at the MCP boundary, §2.6 |
| I11 | `cursor` on budget-paged reads (`list_conversations`, `agent_fleet` detail) | `mcp-page-<32 hex>` random token | free string | `budgetPage.ts:19–24` (per-process cache, 128 entries, 5 min) | `nextCursor` | — | generate an 8-hex token |
| — | `create_pipeline.baseRef` | any ref | `server.ts:3881` | resolved by git | git | 131 (agents already pass 9- and 12-character SHAs) | nothing to change |
| — | `create_pipeline.delivery.rejectedHead` | 40-hex | `server.ts:3867`; `engine.ts:11666` | engine | PR head | 0 | deferred (§5) |
| — | `nativeCallerProof` | 43-char base64url | `server.ts:4550` | hook proof | injected by the hook, never typed | — | out of scope: a hook-issued capability |

### 1.3 Opaque ids that are not hashes

Inputs that take random record ids, and what the scan saw:

| Field | Form | Tools | Passes (10 d) | Passed value absent earlier in the transcript |
|---|---|---|---|---|
| `taskId`, `taskIds` | UUID, 36 chars | 9 | 3,744 | 10 (0.27%); none of the 9 distinct values is a task on this board now, and one is visibly made up (repeating tail) |
| `conversationId`, `parentConversationId` | `conversation_<uuid>`, 49 | 11, plus `spawn_agent` | 773 | 0 |
| `launchId` | UUID | 1 | 10 | 0 (read from `get_pipeline stageId`) |
| `operationId` | UUID or `seatmsg_…` | 3 | 35 | 0 |
| `cursor` (list reads) | base64url JSON, about 100–180 chars; `search_transcripts` about 1.7 KB | 13 | — | — |

Fabrication on these is about one in 400 passes and fails as not-found. On
deploy SHAs it is one in 20 (§1.6). They are deferred (§5).

### 1.4 Default answer fields that carry a hash

Measured sizes. "Hash chars" counts characters in hex runs of 32 or more.

| Tool (scenario) | Field(s) | Source | Sample: bytes / hash chars | Design |
|---|---|---|---|---|
| `get_pipeline` default/compact | `revision`, `stageDigests{}`, `graphDigest`; `delivery.target.repository` | `bindings.ts:5457–5460`; `listProjection.ts:140–143` | live, 4 stages: 1,474 / 416 · fixture, 2 stages: 770 / 256 | short |
| `get_pipeline stageId` | `stage.stageDigest`, `revision` | `compactAnswers.ts:205`; `bindings.ts:5445` | live: 927 / 128 · fixture: 763 / 128 | short |
| `get_pipeline full:true` | same, plus the record | `bindings.ts:5465` | fixture: 140,231 / 256 | **unchanged** (explicit full read) |
| `create_pipeline` acknowledgement | `stageDigests`, `graphDigest` | `compactAnswers.ts:72–73` | fixture projection: 740 / 192 | short |
| `pipeline_action` acknowledgement | `revision`; digests on graph edits; `reviewContinuation.reviewedHead/currentHead`; `publicationCheck.sha`, `result.sha` | `bindings.ts:2425, 2434, 2456–2457`; `compactAnswers.ts:29–43, 112` | fixture link-task: 322 / 64 | short |
| `stage_report` acknowledgement | `provenance.head` (40) | `compactAnswers.ts:148` | — | short |
| `deployment_status compact`, `deploy_exact_sha` | `sha` / `revision` (40) | `compactAnswers.ts:251`; `bindings.ts:3544` | — | short |
| `list_tasks`, `get_task`, `create_task`, `update_task` | `revision` (`task-v1:<uuid>`), `project` (`repo-<32 hex>`) | `listAnswers.ts:18, 48` | live, 3 rows: 2,654 bytes, 52 bytes of revision and key per row | short |
| `list_pipelines` compact | `delivery.target.repository` | `listProjection.ts:140–143` (shared with `/api/pipelines`, so changed only in the MCP answer) | live | short |
| `seat_tick_settings` write and read | `revision` (64, never consumed by any input) | `bindings.ts:4620, 4655` | fixture: 312 / 64 and 1,376 / 64 | short |
| `role_presets` | `revision`, `previousRevision`; stale refusal text | `roles/mcpMapping.ts:80`; `bindings.ts:4855` | — | short |
| `issue_report` preview, show | `digest`; `approvalForm` option label with the full digest | `bindings.ts:1927, 1978`; `issueReports/approvalForm.ts:29, 43` | — | short digest; form by reference (§2.4) |
| `publish_prototype_review` | `reviewId` (`pr_<32 hex>`) | prototype store | — | short |
| `list_conversations`, `agent_fleet` detail | `nextCursor` `mcp-page-<32 hex>` | `budgetPage.ts:24` | fixture: 11,668 bytes, one token | 8-hex token |
| `search_transcripts` | `project` per hit (`repo-<32 hex>`) | search projection | live | short |
| `list_tasks`, `list_flows`, `agent_activity`, `spawn_agent`, `get_task` details | no hex hash; UUID ids only | — | fixture: 0 hash chars | unchanged |

### 1.5 Agent-facing and operator-facing texts

| Text | Where | Carries | Design |
|---|---|---|---|
| Stage prompt base line | `pipelines/prompts.ts:86` | full base commit (this very stage was told `02f9301f…` in 40 characters) | short |
| Publication repair prompt | `engine.ts:4491, 4495` | full accepted and base SHAs | short |
| Flow review prompt | `flows/prompts.ts:35–36` | full `baseRef` and review HEAD | short |
| Seat wake: settled deploy | `monitor/seatTick.ts:219` | full SHA | short (the matcher at `seatTick.ts:2333` already compares 8 characters) |
| Seat wake: merged lane | `monitor/seatTickSources.ts:1592` | full merged head | short |
| Seat wake and stateDetail: review budget | `seatTick.ts:758`; `engine.ts:3993–3995` | 12-character heads | shared helper (8) |
| Pipeline and flow stateDetail, park and error texts | `engine.ts:4189, 4798, 4804, 7723, 8329, 8334, 8340, 10015, 12512, 12811`; `pipelines/git.ts:494, 1433, 2059, 2066, 2148`; `flows/engine.ts:342, 349` | one or two full SHAs each; shown in MCP answers and in the UI | short at source |
| Engine refusal for a malformed digest | `engine.ts:11292` | demands "a 64-character … digest" | reworded |
| Tool descriptions | `server.ts:3822` (update_task "copy the opaque revision"), `server.ts:3417, 4066` (deploy "full commit SHA", "Full 40-hex commit SHA") | instruct copying full values | reworded, no net growth |
| Project refusal texts | `nameResolution.ts:164, 176, 184` | `name (repo-<32 hex>)` candidate lists; the voice read two of them aloud | short keys |
| Rule reports to the bridge | `monitor/ruleReports.ts:31–36, 44–58, 64–91` | full task UUIDs prefixed to the body so the report log can link cards (`bridge/reportCardRefs.ts`, `reportLog.ts:168`) | titles in the body; card refs stored beside it (§2.7) |
| Issue-report approval form | `issueReports/approvalForm.ts:29, 43` | option label «Так, публікуй звіт <64 hex>» shown to the operator; the seat copies it into `publish_prototype_review` | §2.4 |
| Legacy mandate deploy step | `orchestrator/prompt.ts:462` | "Resolve origin/main to a full 40-hex commit SHA" | no change: it sits in `SHIPPED_DEPLOYS_SECTION`, the v15 text that delivery strips from stored mandates by exact match, so no delivered mandate carries it and it must stay byte-identical. Seats read the `deploy_exact_sha` description, which changes |
| Mandate role table | `orchestrator/prompt.ts:634` (644 on main after #2966) | `Registry revision: roles-<v>-<20 hex>` | short |

Voice relay record (all 25 kept calls): 73 of 217 relayed reports carried at
least one full UUID in the text the voice speaks, 29 handoffs instructed the
voice to read UUIDs "as written", and a 32-hex project key reached the voice's
speech three times (two handoffs and one spoken reply) while it asked which
project the operator meant. 72 of the 73 reports match a rule-report sentence;
the 73rd is a body of more than 55 task ids, cut off before its sentence, which
is what `withConversationCards` produces for a conversation that holds many
cards.

UI: the components already print short SHAs (8 in `pipelineModel.ts:155`,
`PipelineStrip.tsx:681`, `pipelineBlockModel.ts:330`, `VerdictPopover.tsx:188`;
12 in `TaskWorkflowPanel.tsx:59, 64, 81`; 7 in `StagingBadge.tsx:37`,
`DeploymentStatusPill.tsx:56`). Two print a full one: `VerdictPopover.tsx:189`
(the review head in a truncated code element) and `selfUpdateCopy.ts:154`
(the fell-back message). Every component that prints a pipeline or flow
`stateDetail` (`WorkflowStrip.tsx:75–77`, `TaskWorkflowPanel.tsx:58`,
`PipelineHub.tsx:127`, `VerdictPopover.tsx:171`, `pipelineBlockModel.ts:207`,
`operatorAsk.ts:91`, `taskChronologyModel.ts:129`) prints the full SHAs of
§1.5's status texts.

### 1.6 What agents actually did (2026-10-06 → 2026-10-16)

- **64-hex guards are copied faithfully but cost tokens.** 283 `expectedRevision`
  and 469 `expectedStageDigest` passes; every value appeared verbatim earlier in
  the same transcript. 17 revision guards and 1 digest guard were refused as
  stale (`STAGE_CHANGED`); none was malformed. The Claude transcripts among
  the same files hold 1,590 `get_pipeline` calls; each default answer carried
  `(stages + 2) × 64` hash characters.
- **40-hex SHAs agents obtain elsewhere get invented.** 3 of 61
  `deploy_exact_sha` calls passed a 40-hex SHA that appeared nowhere earlier.
  In each, the seat had the 9-character `git log --format=%h` prefix and
  invented the remaining 31 characters; one is the prefix padded with zeros
  (`fe18cb41d0000000…`). The real commits are `fe18cb41d73481f6…`,
  `9e9d395b6cdae36d…` and `8f6f4869a0e7633c…`. All three were refused ("not
  found on the tracked branch") before admission; each seat then ran
  `git rev-parse` and retried. With prefix resolution all three would have
  deployed the commit the seat meant on the first call. The route's own
  comment records the older incident this repeats: a mangled SHA tail once
  deployed a revision that never existed for six hours, and the `ref` form was
  added so no caller carries a SHA through its notes. `deploy_exact_sha` never
  exposed that form.
- **A guard nobody uses still costs every row.** No `update_task` call in
  10 days passed `expectedRevision`, yet every `list_tasks` row carries the
  44-character revision.

## 2. Design

### 2.1 The short form: 8 characters shown, 7 or more accepted

- **Shown: the first 8 hex characters of the hash part, with the value's type
  prefix kept**: `7c0e9b1a` (a 64-hex revision or digest), `fe18cb41` (a SHA),
  `task-v1:0c1d2e3f`, `roles-3-0a1b2c3d`, `repo-1a2b3c4d`, `pr_1a2b3c4d`.
  Eight is already Delegatus's convention: the `bridge_report` contract says
  "a deploy by its 8-character sha", pipeline ids are 8 hex, the deploy wake
  keys use `sha8`, and the UI's pipeline surfaces print 8.
- **Accepted: any string prefix of the full value that keeps its type prefix
  and has at least 7 hex characters**, compared case-insensitively. Seven is
  git's own minimum abbreviation, so every short SHA git prints resolves, and
  so do the 7-character SHAs the self-update surface prints. A full value is a
  prefix of itself, so every full value keeps working.

Collision safety:

- *A guard against one current record* (revision, stage digest, task revision,
  role revision, accepted head, flow head) wrongly accepts a stale value only if
  the new value starts with the same characters: 16⁻⁷ ≈ 3.7 × 10⁻⁹ per stale
  check at 7 characters, 2.3 × 10⁻¹⁰ at 8.
- *A lookup in a set* refuses when more than one member matches, so a
  collision costs one more call and never selects the wrong record. The largest
  set is the tracked branch's history, 3,985 commits reachable from the base:
  the chance that a given 8-character prefix names a second commit is about
  9 × 10⁻⁷ (1.5 × 10⁻⁵ at 7), and it stays under 10⁻⁴ until the branch passes
  430,000 commits.
  For an agent typing a short SHA into git, the object store (about 135,000
  objects) gives about 3 × 10⁻⁵, and git disambiguates commit-ish arguments
  itself.
- *Forgery*: finding a value with a chosen 8-character prefix costs about
  4 × 10⁹ hash evaluations, which is minutes on a GPU. No guard below lets an
  agent gain anything from a forged prefix (§2.4 lists why), except a consent
  binding, which therefore keeps the full value.

### 2.2 One module: `src/lib/shortIds.ts`

Free of server imports, so components can use it too:

- `SHORT_ID_CHARS = 8`, `MIN_SHORT_ID_CHARS = 7`.
- `shortId(value)`: the short form of a 40- or 64-hex hash, a task revision, a
  role revision, a `repo-`/`dir-` project key or a `pr_` review id; any other
  value unchanged.
- `matchesShortId(full, given)`: `given` lowercased is a string prefix of
  `full`, keeps `full`'s type prefix, and has at least 7 hex characters.
- `resolveShortId(candidates, given)`: `{ kind: "match", value }`,
  `{ kind: "ambiguous", candidates }` (each candidate shown by its shortest
  unique prefix, at least 8) or `{ kind: "none" }`.
- `shortenHashesInText(text)`: every standalone 40- or 64-hex run, and every
  embedded project key or review id, replaced by its short form.
- `shortIdsInAnswer(payload)`: the MCP output transform of §2.5.

The 12-character `short()` helpers in `engine.ts:3993` and `seatTick.ts:758`
are replaced by `shortId`.

### 2.3 Server-side resolution and its refusals

**Guards against one record.** The compare at each server check of §1.2
becomes `matchesShortId(current, given)` inside the same transaction that
already holds the record, so the check stays atomic:

| Guard | Stale refusal (existing code kept) | Stored after acceptance |
|---|---|---|
| I1 `expectedRevision` | `STAGE_CHANGED` / `field: expectedRevision` | the full current revision, in the decision, review-continuation, accept-head and legacy-review receipts (`legacyReviewDefinition.ts:323, 343`). A replay with the same `clientRequestId` matches when `matchesShortId(stored, given)`, so a replay that sends the short or the full form both replay |
| I2 `expectedStageDigest` | `STAGE_CHANGED` / `field: expectedStageDigest`; the `11292` format check accepts 7–64 hex | nothing (not stored) |
| I3 `acceptedSha` | if it matches `lastPassedCommit`, publish that; else read the worktree HEAD and, if it matches, treat it as the moved head; if it matches both and they differ, refuse `short_id_ambiguous`; if it matches neither, refuse naming both short forms. Every later check (`verifyPassedHeadIntegration`) runs on the full SHA | the full SHA, as today |
| I4 `expectedHead` | the existing "flow decision HEAD is unavailable, changed or not clean" | the observed full head (`engine.ts` flow settlement reads `decision.expectedHead` as `reviewHeadSha` and `targetSha`, `flows/engine.ts:1334–1335`) |
| I5 task `expectedRevision` | `TASK_REVISION_MISMATCH` | nothing |
| I6 role `expectedRevision` | `role_presets_stale_revision`, with the current registry (its revision short) | nothing |

**Lookups in a set.** One refusal shape: code `short_id_ambiguous`,
`retryable: false`, the field, and up to 8 candidates as short forms with a
title where one exists ("pass more characters"). Unknown values keep their
existing not-found refusal.

| Lookup | Set | Where |
|---|---|---|
| I7 issue-report digest | stored previews in `issueReportsDir()` (`<digest>.json`, excluding `.shown.*` and `.publication.*`), read asynchronously | new `resolveIssueReportDigest` in `issueReports/store.ts`, called at `bindings.ts:1963` |
| I9 review id | the task's rounds, or the seat's rounds when the form has no task | one resolver beside `prototypeReview/store.ts`, used by the three inputs; `autonomyDecision.review.reviewId` is stored resolved |
| I10 project key | known project keys from the shared name directory | §2.6 |

**Deploy prefix (I8).** In `SelfUpdateService.deployRevision`
(`selfUpdate/service.ts`, before the 40-hex check at 1807): a 7–39 character
hex revision is resolved on the tracked branch, after the same `fetchTip` that
`targetOnCurrentBranch` already runs, by listing the tip's ancestors
(`git rev-list <tip>`, about 4,000 lines) and keeping those that start with
the prefix. One match is the target, and every later check (ancestry, green
checks, launcher identity) runs on the full SHA exactly as today. None is the
existing "The requested revision was not found on the tracked branch". Several
is "The short revision <p> names <n> commits on the tracked branch; pass more
characters". The idempotency check at 1791 compares the revision as the caller
sent it, so a replay with the same short value replays; the ledger and the
answer record the full SHA. The route (`route.ts:147`) accepts 7–40 hex for
checkout installs. A managed install, which hands the request to the runtime
host, refuses a short revision with "pass the full SHA or a ref": all 897
`deploymentId` values in the scanned answers name checkout deployments, and
changing the runtime host's resolution is not justified by that (§5). This is
deploy-path code: AGENTS.md makes it high risk, with three review rounds.

### 2.4 A consent binding keeps the full value

`approvalForm.ts` explains why the issue-report approval carries the whole
digest: a short prefix "can be matched by a second text found by trying
wordings, and the yes for one would then publish the other". That holds: an
agent that can choose the wording can grind an 8-character prefix in minutes.
So the binding stays exactly as it is (the stored option label holds the full
digest and `issueReportFormLanguage` compares it whole), and what changes is who
handles the value:

1. `issue_report show` answers `approvalForm: { issueReport: "<short digest>" }`
   in place of the composed form.
2. `publish_prototype_review` accepts `issueReport` (taskId omitted, no
   questions or variants): the server resolves it among stored previews (§2.3),
   composes `issueReportApprovalForm(preview, language)` itself and publishes
   it. The stored round is the same as today, so `issueReportFormLanguage`,
   `issueReportDecisionApproves`, the replicas and older stored forms are
   untouched. A seat that still sends the full composed form keeps working.
3. The decision-form renderers (the web form, the Telegram post in
   `prototypeReview/telegramPost.ts` and the poll in
   `telegram/bot/reviewPolls.ts`) print option labels through
   `shortenHashesInText`. Display only: answers map by option index.

The operator then reads «Так, публікуй звіт 5d41402a» while the server still
checks all 64 characters. Showing all 64 characters added no protection
that a person uses: nobody compares 64 characters. What protects the operator
is that only the newest approval form of this preview, asked after the seat
read the preview back, counts.

The other guards gain nothing from a forged prefix. A pipeline revision or
stage digest changes only through Delegatus's own writes, and grinding a prefix
would take billions of them. An `acceptedSha` collision can only select a moved
head that `verifyPassedHeadIntegration` still requires to be clean merges of
main. The flow decision is accepted only from the flow's implementer
conversation (`decisionOwner`, `flows/decisions.ts:105`), about the commit it
made itself. A deploy prefix resolves only among commits already merged to the
protected branch, and two matches refuse.

### 2.5 Default answers: one output transform in the MCP service

`finish` (`server.ts:2576`) already transforms every result after argument
validation before it is serialized and measured (`withoutPrototypeTaskFields`);
success, refusal and replay results all pass through it. It also applies
`shortIdsInAnswer(result)` unless the call set `full: true`:

- **Whole values**: any string that is entirely a 40- or 64-hex hash, a task
  revision, a role revision, a `repo-`/`dir-` key or a `pr_` id becomes its
  short form. That covers `revision`, `stageDigests`, `graphDigest`,
  `stageDigest`, heads, publication and deployment SHAs, issue digests, review
  ids and project keys wherever a projection puts them, including the shared
  `listProjection` rows, whose UI consumers keep full values. Each of these
  kinds has an input that resolves the short form (§1.2), and no other kind is
  rewritten, so an id with an unknown prefix never turns into something its
  input refuses.
- **Delegatus-authored status text**: `stateDetail`, `error` and `detail`
  strings pass through `shortenHashesInText`. This includes refusal messages
  such as the role-registry stale text at `bindings.ts:4855`.
- **Never rewritten**: caller echoes (`clientRequestId`, `idempotencyKey`) and
  string values under authored-content keys (`text`, `details`, `body`,
  `prompt`, `spec`, `summary`, `findings`, `snippet`, `content`, `comment`,
  `answer`, `title`, `task`), so a `get_task` answer still round-trips into
  `update_task`. An object under such a key (a refusal's `details`, an
  acknowledgement's `task`) is walked like any other.
- `full: true` returns every value as stored: the explicit full read the
  requirement allows. `get_task` has no full flag, so its default is short
  (`list_tasks {ids, full: true}` is the full read of a task).

The transform is idempotent, so a stdio server relaying a Viewer answer, or a
replay of a receipt stored before this change, ends short as well. It is pure
CPU over a byte-bounded answer, with no store read, and the size the service
already records after `finish` becomes the after-measurement in timing
telemetry.

The 128-entry budget-page cache issues `mcp-page-<8 hex>` tokens, drawing again
on a collision with a live key (`budgetPage.ts:24`). A token is bound to its
filters, and a colliding guess returns only a page the caller could read
anyway.

**Dropped or shortened, field by field**: nothing is dropped. Every hash
field that a guard consumes stays and is shortened. `seat_tick_settings`
`revision` is consumed by nothing, but the server instructions promise
"changedFields and revision" on every write, so it stays, shortened. That
instruction sits in #2930's hunk, so it is not edited here.

### 2.6 Project keys

- Output: the transform of §2.5 prints `repo-1a2b3c4d`.
- Input: the service normalizes `project` and `expectedProject` once, beside
  `normalizeBoundedMcpNumerics` (`server.ts:2551`), before the receipt digest:
  a value matching `^(repo|dir)-[0-9a-f]{7,31}$` is resolved against the keys
  of the shared name directory (`nameResolution.ts`). The matching key replaces
  it, several refuse `ambiguous_project` with the existing details shape, and
  none refuses `unknown_project`. Without this, a short key would fall through
  `canonicalProject` and silently read an empty board. The directory is built
  only on this branch, and only when the argument has that shape. The function
  lives in a new `src/lib/mcp/shortIdArgs.ts` and loads the directory lazily.
- The name resolver also indexes each key's short form as an identity, so the
  orchestrator tools resolve it by the same rule. Its refusal texts at
  `nameResolution.ts:164, 176, 184` print short keys, so the voice asks "this
  project or `repo-5e6f7a8b`?".
- `backfill_worktree_projects.project` (`server.ts:4013`) accepts
  `^(repo|dir)-[0-9a-f]{7,32}$`.

### 2.7 Operator-facing reports name work by title

Rule reports are Delegatus's own bridge reports. They break the rule the
`bridge_report` contract sets for seats: "name work by its title and #PR". The
report log needs the ids only to link cards, so the ids move out of the text:

- `ruleReports.ts` writes «title»: … bodies, with no task UUIDs and no
  pipeline ids, and puts the card ids in a new server-derived field
  `cards: string[]` on `BridgeReportInput` (bounded to 16 ids of up to 64
  characters; MCP callers cannot supply it, like `origin`).
- `BridgeReportV1` stores `cards`; `normalizeReport` (`bridge/store.ts:242`)
  accepts its absence on older rows.
- `reportLog.ts:168` links `report.cards` first and keeps body scanning
  (`reportCardRefs`) for older rows.

The voice, Telegram and the report log then show titles. Card links stay.

### 2.8 Delegatus-authored texts, at the source

Every site in §1.5 that interpolates a full SHA wraps it in `shortId`: the stage
prompt base line (reviewers run `git diff 02f9301f..HEAD`, which git resolves),
the repair prompt, the flow review prompt, the two wake lines, the 12-character
budget texts, and the status, park and error texts in `engine.ts`,
`pipelines/git.ts` and `flows/engine.ts`. The source edits make the UI,
Telegram and the voice short. The MCP transform of §2.5 keeps MCP answers short
when a later status text forgets the helper, and the guard test proves that.

Tool descriptions: `update_task.expectedRevision` says "the revision get_task or
list_tasks answered"; `deploy_exact_sha` says "a commit SHA, or its unique
prefix of at least 7 characters on the tracked branch; never a branch name";
the `11292` refusal says the digest is the one get_pipeline answered. The
tools/list payload must not grow; the builder records its byte count before and
after.

### 2.9 The UI follows

- Status lines follow from §2.8, with no component change.
- `VerdictPopover.tsx:189` prints `shortId(attempt.reviewHeadSha)` and keeps the
  full value in `title` (a hover is an explicit full read for a human).
  `selfUpdateCopy.ts:154` prints the short form.
- The decision-form option labels follow from §2.4.
- The existing 7- and 12-character UI renderings stay. They are already short
  and still prefixes of the same commit (§5).

### 2.10 Backward compatibility

| Caller | Before | After |
|---|---|---|
| An agent or script passing full values to any guard | accepted | accepted (a full value is its own prefix) |
| An agent passing the short form it was answered | — | accepted |
| HTTP routes (`/api/pipelines`, task PATCH, the deployments route with a full SHA or a ref) | full | unchanged; the engine and store compares accept short values from any caller |
| Answers with `full: true` | full | unchanged |
| Receipts stored before the change | full | replay short through `finish`; stored decision receipts compare by prefix |
| Previously published approval forms | full label | still approve their own previews |
| Tests reading hashes out of default answers | 64/40 hex | read short forms or use `full: true` |

## 3. Test plan

Each file runs by explicit path through `scripts/gate-slot.sh bun test <file>`,
with HOME, XDG_CONFIG_HOME, TMPDIR and `LLV_STATE_DIR` isolated under the OS
temp root and `LLV_VIEWER_CONTROL_URL` on a closed port. Never sweep
`src/lib/agent/` or `src/app/api/runtime/`.

1. **`src/lib/shortIds.test.ts`** (new): short forms for every kind; values that
   are not hashes stay unchanged; `matchesShortId` accepts the full value, an
   8-character prefix, a 7-character prefix and a mixed-case prefix, and refuses
   6 characters, a wrong prefix and a prefix without its type tag;
   `resolveShortId` returns match, ambiguous (with candidates extended to unique
   prefixes) and none; `shortenHashesInText` leaves UUIDs, 8- to 16-character
   ids and the gate-slot path alone; `shortIdsInAnswer` is idempotent and never
   touches the excluded keys.
2. **Guard tests.** For each guard, four cases: the short form resolves, a stale
   short form is refused with the existing code, the full value still works, and
   (for sets) an ambiguous prefix is refused with `short_id_ambiguous`.
   - I1/I3: decision, continue-review, accept-head and publish cases in new
     tests next to the engine fixtures (`engine.fixture.ts` `continueReview`
     and `acceptHead` already take an explicit revision); a replay with the
     short form after a full first call replays.
   - I2: `graphEdits.test.ts` beside its `STAGE_CHANGED` case at line 316.
   - I4: flow decisions, with the observed full head stored.
   - I5: `tasks/revision.test.ts`. I6: the role store test.
   - I7: two stored previews whose digests share a planted 8-character prefix:
     the 8-character lookup is ambiguous and the 12-character one resolves.
   - I8: `SelfUpdateService.deployRevision` against a scratch git repository
     with a bare remote: the 9-character prefix of the tip deploys the full SHA
     (the zero-padded case of §1.6 replayed as a short prefix); an ambiguous
     prefix (a stubbed ancestor listing with two commits sharing it) refuses;
     a prefix not on the branch is "not found"; the route answers 400 for a short revision on
     a managed install.
   - I9, I10, I11: review-id lookup; an ambiguous short project key; a short key
     reading the same rows as the full key in `list_tasks`; a short page token
     continuing its page.
3. **The guard test on default answers, `src/lib/mcp/shortIds.answers.test.ts`**
   (new). It has its own fixture, with full-length values planted in every
   field that carries one: a 4-stage pipeline with a delivery target keyed
   `repo-<32 hex>`, attempts with 40-hex heads, a stage report with a head, a
   publication operation with a SHA, review-continuation heads, a stateDetail
   and an attempt error each holding a full SHA, tasks keyed `repo-<32 hex>`
   with `task-v1` revisions, a deployment, an issue-report preview and a
   prototype round. It calls the default answers of `list_pipelines`,
   `get_pipeline` (default, compact and `stageId`), `pipeline_action`,
   `create_pipeline`, `list_tasks`, `get_task`, `create_task`, `update_task`,
   `agent_activity`, `spawn_agent` (with a stubbed control returning a recorded
   receipt shape), `stage_report`, `deployment_status`, `seat_tick_settings`,
   `role_presets`, `issue_report` and `publish_prototype_review`, plus every
   other tool's census answer. It **fails** when an answer's JSON holds a hex run
   of 20 or more characters outside a UUID, or a `task-v1:` revision followed by
   more than 8 hex characters. It also asserts that the same calls with
   `full: true` still carry the full planted values. If the census surfaces
   another hash-derived id (lifecycle `evt_` or report `rpt_` ids are the known
   24-hex candidates), it joins `shortIdsInAnswer` as an output-only kind, or
   gets a resolving input before it is shortened.
4. **Template guard** (same threshold): the rendered stage prompt with a 40-hex
   `baseRef` (`prompts.test.ts` near line 340; #2926 edits lines 31–50); the
   repair prompt; the flow review prompt; a seat wake rendered with a settled
   deploy, a merged lane and a review-budget lane
   (`seatTickController.test.ts:661` updated to the short SHA); the status
   builders of §1.5, called with full SHAs; `ruleReports` output, which must hold
   no UUID and must carry `cards`; the report log, which must link cards from
   `cards`; the project refusal texts.
5. **Consent binding**: an approval form for preview A never approves preview B
   when B's digest shares A's first 8 characters (planted digests); the form a
   seat publishes by `issueReport` reference is stored identical to the composed
   form; a full composed form still works.
6. **UI**: `VerdictPopover.render.test.tsx` asserts the short head with the full
   value in `title`. If the kanban browser driver already opens the verdict
   popover, one frame of it, in en and uk, light and dark.
7. **Measurement.** `shortIds.answers.test.ts` writes its census (tool,
   scenario, bytes, hash characters) when `MCP_SIZE_OUTPUT` is set and asserts
   nothing in that mode. The builder copies the file into a scratch export of
   the merge base, runs it there (before) and on the head (after) on the same
   fixture, and commits both rows in `evidence/mcp-short-ids.json` with the
   revisions and the command. The census covers the pinned list (list_pipelines,
   get_pipeline, pipeline_action, create_pipeline, list_tasks, get_task,
   spawn_agent, agent_activity) plus a rendered seat wake. Expected from the
   current fixture (computed from the census; the build measures them):
   get_pipeline 770 → 546 bytes,
   `stageId` 763 → 651, pipeline_action 322 → 266, the create_pipeline
   acknowledgement 740 → 572; the live 4-stage get_pipeline 1,474 → 1,114
   (−24%); list_tasks −52 bytes per row; agent_activity, spawn_agent and
   list_flows unchanged; per wake, −32 bytes per settled deploy or merged lane
   and −8 per review-budget lane.
8. **Project checks**: the type check and changed-file lint the pre-push hook
   runs, `scripts/privacy-publication-gate` from the merge base, the touched
   tests above, and the PR's required hosted checks.

## 4. Build plan

Ordered. Each slice is independently testable. Fenced lanes: #2930 (MCP
process lifetime: `server.ts` lines 8 and 4548–4720, `bindings.ts` 57, 232,
1212–1240, 2083–2190, 5704–5770, `answerSizes.test.ts` 556+, `boardSelection`,
`http`, `largeReads`), #2962 (`server.ts` 3874–3880, `bindings.ts` 2325–2345,
`engine.ts` 122, 1525, 11356, 11515–11740, `compactAnswers.test.ts` 479+),
#2964 (`engine.ts` 1, 4228, 4821–4870; `pipelines/git.ts` 1209–1240), #2926
(`prompts.test.ts` 31–50). No slice edits those hunks. #2966 (the mandate
lane named in the brief) merged on main at 2026-10-16 13:13 UTC and its lane
is completed; it moved `orchestrator/prompt.ts` lines after 512 down by 10. Before finishing, recheck `origin/main`,
and rebase and reverify any slice whose file moved.

1. **Module.** `src/lib/shortIds.ts`, `src/lib/shortIds.test.ts`.
2. **Guards accept short forms** (§2.3).
   - Schemas in `src/lib/mcp/server.ts`: 3719, 3903, 3922, 3929, 4013, 4066 and
     4108 (pattern to 7–40 or 7–64 hex, or a prefix pattern), 4468, and the 3822
     description.
   - `src/lib/pipelines/engine.ts`: 11175, 11181, 11292; 12379–12395,
     12455–12470, 12486–12520, 12605–12672 (compare with `matchesShortId`,
     store the full revision, replay by prefix); 12793–12811 (publish).
     `legacyReviewDefinition.ts` stores the resolved revision.
   - `src/lib/tasks/commands.ts:529`; `src/lib/roles/store.ts:353` with
     `bindings.ts:4808–4810`; `src/lib/flows/decisions.ts:162` and
     `decisionSchema.ts:9`.
   - Issue-report and review-id lookups (`issueReports/store.ts`,
     `prototypeReview/store.ts`, their call sites in `bindings.ts`, outside the
     fenced ranges).
   - Tests from §3.2.
3. **Deploy prefix** (high-risk slice; three review rounds).
   `src/lib/selfUpdate/service.ts:1782–1810`, `src/lib/selfUpdate/git.ts`
   (an ancestor-prefix helper), `src/app/api/runtime/deployments/route.ts:147`,
   `src/lib/mcp/bindings.ts:3488`, the deploy description at `server.ts:3417`.
   Tests from §3.2 (I8). No runtime-host file changes, so the runtime rehearsal
   is not triggered.
4. **Answer transform, project keys and page tokens.**
   - `src/lib/mcp/server.ts` (`finish` at 2576; the normalization call at 2551).
   - New `src/lib/mcp/shortIdArgs.ts`.
   - `src/lib/projects/nameResolution.ts` (short-key identities, refusal texts).
   - `src/lib/mcp/budgetPage.ts:24`.
   - New `src/lib/mcp/shortIds.answers.test.ts`.
   - Update the default-answer assertions that compare a default answer with a
     full one, in `answerSizes.test.ts` lines 181–188 (`fullList` against
     `detail`, and `latest.revision` against `fullWrite.revision`): outside
     #2930's hunk.
5. **Texts at the source** (§2.8).
   - `pipelines/prompts.ts:86`, `flows/prompts.ts:35–36`.
   - `engine.ts`: 3993–3995, 4189, 4491, 4495, 4798, 4804, 7723, 8329, 8334,
     8340, 10015, 12512, 12811 (4798 and 4804 sit 17 lines above #2964's
     4821 hunk: recheck).
   - `pipelines/git.ts`: 494, 1433, 2059, 2066, 2148.
   - `flows/engine.ts`: 342, 349.
   - `monitor/seatTick.ts`: 219, 758; `monitor/seatTickSources.ts:1592`.
   - `orchestrator/prompt.ts:634` (644 on main after #2966): the role table
     only. The mandate wording is untouched.
   - Their tests: `prompts.test.ts:340`, `flows/engine.test.ts` (136, 291, 295,
     421), `seatTickController.test.ts:661`, `orchestrator/prompt.test.ts:737`
     (742 on main, outside #2966's hunks), and the engine tests asserting these texts.
6. **Rule reports** (§2.7). `monitor/ruleReports.ts`, `bridge/types.ts`,
   `bridge/store.ts` (`normalizeReport`), `bridge/reportLog.ts`, and their
   tests (`ruleReports.test.ts`, `reportLog.test.ts`).
7. **Issue-report approval by reference** (§2.4). `bindings.ts` issue-report
   show and the publish path, the `publish_prototype_review` input
   (`prototypePublishSchema`), `issueReports/approvalForm.ts`, the decision-form
   label renderers (web form, `prototypeReview/telegramPost.ts`,
   `telegram/bot/reviewPolls.ts`), and the tests from §3.5.
8. **UI.** `components/pipelines/VerdictPopover.tsx:189`,
   `components/selfUpdate/selfUpdateCopy.ts:154`, the render test.
9. **Measurement and evidence** (§3.7), then the project checks (§3.8).

## 5. Deferred — not currently justified

| Item | Why not now | Revisit when |
|---|---|---|
| Short forms for UUID record ids (`taskId`, `conversationId`, `launchId`, `operationId`, `deploymentId`) in answers and inputs | They are random record ids. Agents copy them faithfully: 10 of 3,744 task-id passes had no prior appearance in their transcript, and those fail as not-found. Resolving short UUIDs needs a prefix lookup in four stores and a normalization of every id field in about 25 tools, plus test churn across the suite | the not-found rate on copied ids rises, or the operator asks for short task and conversation ids. Operator-facing report text already drops them (§2.7) |
| Short handles for pagination cursors (base64 list cursors, the 1.7 KB `search_transcripts` cursor) | Not hashes; a wrong cursor restarts with `cursorReset` and never reads another record. A short handle needs shared durable storage across stateless HTTP servers, which is #2930's area | after #2930 lands, if cursor bytes show up in answer-size measurements |
| Prefix resolution for managed (container) installs in the runtime host | All 897 `deploymentId` values in the scanned answers name checkout deployments; the runtime host is the critical process. Managed installs keep full SHA or `ref` | a managed install's seat deploys by prefix |
| `create_pipeline.delivery.rejectedHead` | 0 uses in 10 days; its validation sits inside `createPipelineFromRequest`, which #2962 is changing. Until then a caller takes the full SHA from git, since answers print 8 characters | #2962 merges and a caller appears |
| Unifying the UI's existing 7- and 12-character SHAs on 8 | Already short and prefixes of the same commit; costs rendered evidence with no operator gain | a UI change touches those components anyway |
| The gate wrapper path in stage prompts (`…/self-update/<16 hex>/releases/<12 hex>/scripts/gate-slot.sh`) | A filesystem location copied within one turn; a typo fails loudly; the release path is deliberately immutable. Below the 20-character threshold | agents are seen mistyping it |
| Dropping `stageDigests` from answers on completed or closed pipelines | Saves about 15 bytes per stage and adds a conditional answer shape | — |
| Making `expectedRevision` ignore volatile fields | 17 of 283 revision guards (6%) were refused as stale, likely because unrelated fields such as the CPU-queue `stateDetail` moved. That concerns what the guard covers; hash length plays no part | a separate task, if refusals keep costing rounds |
| Agent-authored text (stage summaries, findings, seat reports) quoting full SHAs | Relayed verbatim for fidelity; the `stage_report` and `bridge_report` contracts already ask agents to claim no heads and name no machine ids, and the report renderer warns | — |

## 6. Decisions settled here

1. **8 shown, 7 or more accepted** (§2.1): Delegatus's existing convention and
   git's minimum, with the collision bounds above.
2. **One output transform at `finish`**, in place of edits to about 15
   projections: one choke point that every success, refusal and replay passes,
   with a precedent at the same line, and it covers fields in shared
   projections that the UI must keep full.
3. **Explicit resolution at each guard's own compare**, so staleness is still
   judged atomically against the record.
4. **A consent binding keeps the full value server-side**, and the agent passes
   a reference and copies nothing (§2.4).
5. **Deploy prefixes resolve where refs already resolve** for checkout
   installs; managed installs stay as they are (§2.3, §5).
6. **UUID ids and cursors are deferred** with the evidence in §1.3. This is the
   one choice that changes what the operator sees in tool-call views (task and
   conversation UUIDs remain there). It was settled here because the
   requirement names hashes, the measured fabrication on UUIDs is about
   one in 400 against one in 20 on SHAs, and the operator-facing places where
   UUIDs were read aloud are fixed by §2.7.

No question remains that only the operator can answer.

Notes:

- The pinned specification lists "seat wakes" among the answers to measure; a
  wake is text sent to the seat; it has no MCP answer. It is measured as a
  rendered wake (§3.7).
- The UUIDs in voice reports came from the rule reports; seat-written reports
  already follow the title-and-#PR rule.
- This stage's own prompt named its base commit in 40 characters; after slice
  5 the same line carries 8.
