# Operator correction lessons

<!-- BEGIN final integration summary -->
Merged main through `62235181a` with merge commits. The repair restores the
500-byte history case, validates the caller's mandate before adding required
text, and corrects the mandate disclosure and clean-stage refusal expectations.
Across 250 explicit test files, 175 pass and 75 also fail in the isolated main
comparison. There are no new failing cases against main. Typecheck and lint
pass; lint reports ten warnings and zero errors.

The full per-file commands, exit codes, source and log hashes, failing cases,
assertion sites and main comparisons are in
`evidence/operator-correction-lessons.json`. Final publication and commit
receipts are reported with the stage completion.
<!-- END final integration summary -->



## Observation before implementation

Observed against `4da1e129`, before production edits on 2026-10-22.
Transcript searches used correction/lesson, correction/leave_lesson and the
original-language correction terms, project-scoped first and then unscoped.
The earlier **Orchestrator seat conversation, 2026-10-18 03:45Z**, transcript
line 1998, requested memory updates after corrections. Its indexed memory
allowed a one-off task correction to be skipped and covered the seat alone.
The **Orchestrator seat conversation, 2026-10-22**, transcript line 994,
contains the broader originating request: every correction revealing a
misunderstood task leaves a lesson for curator review. The pinned brief dates
it approximately 14:06Z; the transcript records that message at 14:09:03Z.
These are paraphrases; private transcript paths and quotations stay local.

| Generator or consumer | Before the change |
| --- | --- |
| `src/lib/orchestrator/prompt.ts:577` | The default mandate includes the short working rules; delivery upgrades retained mandates. No mandatory correction lesson. |
| `src/lib/roles/defaults.ts:41`, `src/lib/roles/registry.ts:131` | Shared working rules and rendered role scaffolds. Rule 13 says to read later answers, without the correction duty. Stored scaffold overrides and retained pipeline stages can retain earlier wording. |
| `src/lib/mcp/server.ts:3684`, `src/lib/mcp/server.ts:4260` | `leave_lesson` description and schema. Seats can call unasked; stages need a closing request; clean roles are refused. No correction marker. |
| `src/lib/mcp/bindings.ts:2661`, `src/lib/memory/roleStage.ts:137` | Server caller attribution and stage/seat admission. Corrections before a report cannot be recorded by a stage. |
| `src/lib/memory/curation/store.ts:218` | Agent additions, rewrites and merges count as new lessons for the existing scheduled pass. |
| `src/lib/memory/curation/read.ts:52`, `src/lib/memory/curation/brief.ts:21` | Ordinary active-rule order and the existing checklist; no correction priority. Decisions use `curation/apply.ts` operations and scope history. |

Open lanes observed before editing concerned remote checks, publication,
startup, security, voice and a proactive-mode design. Their local branch diffs
had no changes in this implementation's role-memory, mandate or scaffold files.
No sibling checkout was changed.

## Shared contract inventory

`leave_lesson` keeps its existing name and receipt idempotency. The MCP schema
and binding pass the optional correction flag to the stage/seat parser. A
registered role conversation outside a pipeline uses server-derived role and
project attribution. Restricted-role policies admit only this correction
exception; the binding still validates the lesson and caller. Recorded stage
provenance remains valid for an operator correction of a settled result; an
unknown or ambiguous conversation is refused. Correction writes do not
create or consume the closing request or its delivery measurements. Their
source retains the task identity used by the existing curator task counter.

The store writes an optional rule marker; older rows default to ordinary
lessons. Duplicate append, project succession and curator merge preserve it on
the survivor. Views expose it without conversation identities. Split, move,
archive, version and Undo retain it through the existing row copies. Imported
and ordinary lessons remain unmarked. Curation priority is computed from the
existing view and history; no new timer, tool, classifier or poll is added. Stage delivery upgrades retained
scaffolds and the two shipped write fences that predate correction lessons;
current scaffolds carry the instruction once. Capped overrides preserve it.
Budget retention never archives a correction changed since its last curation,
so a correction that repeats a curated rule stays active and leads the agenda
until a curator pass reviews it; an unreviewed correction that left by budget
under an earlier build still counts in the agenda. When a project succession
joins a duplicate (`joinMovedScopes` in `src/lib/memory/roleStore.ts`), an
unreviewed correction on either side marks the survivor changed at the join,
and the rule view reports any active correction changed since its last
curation as awaiting curation (a reviewed correction the budget archives later
stays reviewed), so agenda counting, scope order and budget retention all
read the same pending state.

## Verification procedure

The initial tests were added with production source unchanged. Remote red
runs failed on the missing seat/scaffold instruction, correction schema and
admission, and correction-first curator agenda. Additional red controls proved
that restricted-role policies and registered non-pipeline roles needed the
same exception. All checks use `gate-remote`, whose owned runner isolates
HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR under its temporary root and
sets LLV_VIEWER_CONTROL_URL to a closed port. The runner exports the checkout;
no test uses the serving installation.

Focused checks cover current and retained mandates, all thirteen roles and
stored scaffold overrides (including capped orchestrator overrides), correction admission and refusal, replay, repeated
corrections without spending the closing answer, clean reviewers, registered
non-pipeline roles, duplicate priority across scope reads, project succession of
a correction duplicate in both orders (agenda lead, budget retention through 32
later lessons, cleared after curation), and integrate / rewrite / drop decisions
with reversible history. The seat mandate advances to v60. Rule 13 keeps the correction duty and
shortens its preceding answer-handling sentence. Compared with v58, the
combined rule uses 129 additional bytes and retains the existing 500-byte
rotation-history case inside the structured message limit. Pending seat-intent
replays retain their original bytes.


## Main integration repair

The initial comparison used main `3e570adf` and the merge commit
`b4a5a38a4`, on Bun 1.4.0 with equivalent isolated state. Main passed 288 of
289 focused tests; the branch passed 287 of 292. Four branch-only failures
reproduced the merge-train report:

- The 500-byte history was dropped because the correction sentence enlarged
  the mandate. Shortening rule 13's preceding sentence recovers 97 bytes while
  retaining every correction instruction. The history assertion stays unchanged.
- Three seat-command assertions expected the caller's text alone in durable
  mandates. New intents deliberately store the correction duty before delivery,
  so these assertions now expect the caller's text followed by that duty.
  Status delivery, activation, single delivery and pending-replay checks remain.

The additional empty-mandate probe found that upgrading before validation
could make a missing mandate nonempty. Validation now checks the raw caller
value before adding mandatory text. Missing, empty and whitespace-only cases
assert the precise refusal and absence of launches, deliveries and seat records.
An initial guard inside the upgrade helper also changed the empty-text cost
used by envelope sizing; its boundary test failed. Moving the check to the
request validator restores identical sizing for empty and nonempty baselines.

One assertion already fails on main: the invalid-model error's expected
catalog omits two supported model IDs. This repair leaves that assertion
unchanged because the correction-lesson feature does not change that text.

Shared paths checked before the repair: shared full and short working rules
feed role defaults; the registry renders spawn scaffolds; pipeline lookup caps
and stores scaffolds; pipeline delivery upgrades retained scaffolds. Seat
creation and adoption validate, upgrade and preflight a mandate before storing
a new intent; rotation measures the same delivery transform; pending retries
render the saved mandate and table. The repair changes the short rule and new
intent validation, preserves the correction sentence, upgrades retained rule 13
by exact match, and keeps pending replay outside that upgrade.

Main also added a byte fingerprint for the curator brief. Correction-first
review and the correction-write exception deliberately change that prose, so
the fingerprint now records the combined brief. The test keeps its consent and
read-only assertions and checks the correction duty with swarm receiving both
off and on.

## Verification isolation correction

An early importer batch reused an explicit state directory between files; the
preload preserves that variable. Its totals and the interrupted comparison are
discarded. The replacement gives every file a fresh source checkout, state
directory, HOME, XDG roots and native agent configuration roots before imports.
Each child starts with detached stdin; results are reconciled against the
manifest and retrieved logs. No discarded result is used to attribute a defect.

Main advanced to `f348d75bd` during verification, adding tests only. It was
merged with `50da20b7a`. The focused baseline inputs and all changed product
modules are byte-identical between the prior main and that revision; the added
test files receive separate checks.

## Mandate disclosure repair

The importer comparison found one further regression: the custom rotation
parser test passes on main, while the branch puts the appended correction duty
inside the handoff. Delivery appends that duty without a heading. The existing
parser recognizes the earlier decisions and prototype paragraphs as mandate
boundaries; it now recognizes the correction paragraph too. `MandateCard` and
`imageGallery` consume this split. The original handoff equality remains, with
additional parser and DOM assertions that the correction duty appears in the
mandate disclosure.

The stage-input byte snapshots and custom-mandate provenance assertions also
fail on main in the same cases. Their assertions remain unchanged.

The role-lane file has another deliberate message change: ordinary review
lessons are still refused, and the refusal now names the correction exception.
Its old `stays clean` expectation stopped the first case before it stored a
rule. The next case explicitly uses that stored rule, causing a second failure.
Only the refusal-message expectation changes; the original seed and relay
redaction assertions run together in the full-file check.

## Final verification

Every test run uses the pinned owned gate supervisor and `gate-remote`, with
one heavy call at a time. Each file receives a fresh checkout and HOME, XDG,
state and native configuration roots before imports. The evidence contains
236 direct importers of the 19 changed product modules and 14 related or
incoming-main test files. All selected files have results and retrieved logs.

Main advanced during the checks. Core product and focused-test inputs are
byte-identical across the recorded main cuts. The evidence verifies those
hashes and the unchanged original 18 repaired modules; the disclosure parser
has its own final checks. The new main tests receive fresh checks. The final
integration cut is `62235181a`; source changes are committed in the assigned
worktree.

The privacy benchmark initially varied on the unclosed-double-quote case.
Three complete runs on each revision reproduce the same 21 failing cases in
every run. Its scanner, test, literal dependencies and dependency lock are
byte-identical on both sides. CPU-growth assertions exceed the 32x limit for
8x input, and media fixtures lack `tesseract` on the runner. Their thresholds
and code stay intact. The actual publication check passes on this repair.

The remaining setup failures match on both revisions: eight fixtures expect a
state path selected after module initialization, and one mutates a frozen
registry snapshot. Other retained failures are listed by case, matcher and
assertion site in the evidence. Their underlying causes are outside this
repair. Browser cases retain their existing environment gates; the disclosure
change has React DOM coverage. This repair claims no performance gain.

### Deliberate test text changes

| Files | Reason |
| --- | --- |
| `src/lib/orchestrator/seatCommand.test.ts` | New intents store the caller's text plus the mandatory correction duty. Three expectations now state those bytes; missing and blank mandates have four refusal cases. |
| `src/lib/orchestrator/prompt.test.ts`, `src/lib/orchestrator/handoffDigest.test.ts` | Version, fingerprints and text-size snapshots reflect the correction instruction. Structured delivery bounds and the 500-byte history expectation remain enforced. |
| `src/lib/pipelines/prompts.test.ts`, `src/lib/pipelines/roles.test.ts`, `src/lib/roles/registry.test.ts` | New and retained scaffolds carry the duty once, including overrides near their cap. |
| `src/lib/memory/roleLane.test.ts`, `src/lib/memory/roleSeatRender.test.ts`, `src/lib/mcp/leaveLesson.test.ts` | Refusal and pointer text acknowledge the operator-correction exception while ordinary review lessons remain refused. The role-lane file runs whole, preserving its existing ordered seed scenario. |
| `src/lib/memory/swarm.test.ts` | The brief fingerprint records correction-first review and the correction exception; consent assertions remain. |
| `src/components/feed/mandateMessage.test.ts`, `src/components/feed/MandateCard.dom.test.tsx` | Added assertions place the correction duty in the mandate disclosure and keep the original handoff equality. |
| `src/lib/mcp/leaveLessonOperator.test.ts`, `src/lib/mcp/toolAllowlist.test.ts`, `src/lib/memory/curation/reviewLessons.test.ts` | Added correction admission, refusal, persistence and curator-review coverage. |

### Command and exit ledger

Commands are normalized to omit private wrapper, export and machine paths.
Per-file executable arguments and file selections are recorded in the JSON.
The per-file rows run inside the supervised remote batch. Read-only navigation
commands are omitted. An exit of 1 for a comparison retains the named main
failures; the earlier reused-state runs are explicitly discarded.

| Run | Command or operation | Exit | Cause and fix or result |
| --- | --- | ---: | --- |
| `merge-main-initial` | `git merge --no-ff <resolved origin/main>` | 0 | Clean merge of the initial current main. |
| `main-focused` | `gate-remote -- bun test <focused seat and mandate files>` | 1 | Main already fails the model-catalog string assertion. |
| `branch-focused-before` | `gate-remote -- bun test <focused seat and mandate files>` | 1 | Four added failures: dropped history and three stored-text expectations. |
| `branch-focused-candidate` | `gate-remote -- bun test <focused seat and mandate files>` | 1 | Intermediate empty-text handling changed cost normalization; moved validation to the request and pinned the new prompt fingerprint. |
| `branch-focused-final` | `gate-remote -- bun test <focused seat and mandate files>` | 1 | Only the catalog assertion also failing on main remains. |
| `merge-main-refresh` | `git merge --no-ff <resolved origin/main>` | 1 | Conflicts in the curator brief and rule store; combined the correction and swarm changes, then committed. |
| `eslint-final` | `bunx eslint <touched TypeScript files>` | 2 | Project ESLint was absent; installed frozen dependencies in the owned environment. |
| `install-dependencies` | `bun install --frozen-lockfile --ignore-scripts` | 0 | Frozen installation completed without lifecycle scripts. |
| `eslint-retry` | `bunx eslint <touched TypeScript files>` | 0 | Passed after installing the project dependencies. |
| `typecheck-merged` | `gate-remote -- bunx tsc --noEmit --incremental false` | 0 | Passed before committing the resolved main merge. |
| `commit-main-refresh` | `git commit --file <reviewed commit message>` | 0 | Normal hooks passed. |
| `fetch-main-final` | `git fetch origin main` | 0 | Refreshed the main reference. |
| `branch-importers` | `gate-slot gate-remote -- discarded importer runner` | 1 | Discarded: an explicit state root leaked between files. |
| `commit-mandate-repair` | `git commit --file <reviewed commit message>` | 0 | Normal hooks passed for the mandate and validation repair. |
| `cancel-invalid-comparison` | `Stop the exact owned comparison and verify its cleanup` | 0 | Stopped the exact owned invalid comparison and verified cleanup. |
| `main-comparison` | `gate-slot gate-remote -- discarded importer runner` | 143 | Cancelled after finding the shared-root flaw; no attribution uses these results. |
| `fresh-main-focused` | `gate-slot gate-remote -- per-file runner (explicit files and commands in runs)` | 1 | Eleven fresh files; only the known catalog assertion fails. |
| `fetch-main-advanced` | `git fetch origin main` | 0 | Refreshed main before integrating its added tests. |
| `merge-main-advanced` | `git merge --no-ff <resolved origin/main>` | 0 | Clean merge of the added main tests. |
| `prepare-main-advanced-export` | `python3 <private baseline export refresh>` | 0 | Refreshed an owned read-only baseline export; no delivery commit was made there. |
| `fresh-head` | `gate-slot gate-remote -- per-file runner (explicit files and commands in runs)` | 1 | 237 files: 162 pass, 75 fail; this exposed the disclosure and refusal-text issues and one deadline. |
| `commit-mandate-disclosure` | `git commit --file <reviewed commit message>` | 0 | Normal hooks passed for the parser and DOM coverage. |
| `merge-main-fixtures` | `git merge --no-ff <resolved origin/main>` | 0 | Clean merge of the main fixture repairs. |
| `commit-role-lane-text` | `git commit --file <reviewed commit message>` | 0 | Normal hooks passed for the deliberate refusal-message change. |
| `fresh-main-red` | `gate-slot gate-remote -- per-file runner (explicit files and commands in runs)` | 1 | 87 full files compared; 75 fail on main. |
| `fresh-main-latest` | `gate-slot gate-remote -- per-file runner (explicit files and commands in runs)` | 0 | Both updated main fixture files pass. |
| `merge-main-landing` | `git merge --no-ff <resolved origin/main>` | 0 | Clean merge of the current main landing changes and design documents. |
| `main-ancestry-before-final` | `git merge-base --is-ancestor origin/main HEAD` | 1 | Main advanced; merged the new cut. |
| `export-ancestry-audit` | `git merge-base --is-ancestor <merged main> <export revision>` | 1 | The queued job retained its earlier export; checked the new landing inputs and typechecked the merged cut separately. |
| `deadline-cleanup-audit` | `python3 <read-only owned-process audit>` | 0 | The exact recorded surviving process reference was already gone. |
| `final-head` | `gate-slot gate-remote -- per-file runner (explicit files and commands in runs)` | 1 | 19 files: 15 pass and four retain failures also seen on main. Both disclosure tests and both functional role-lane cases pass. |
| `typecheck-before-landing` | `gate-remote -- bunx tsc --noEmit --incremental false` | 0 | Passed on the earlier export; the current-main typecheck supersedes it. |
| `eslint-final-verified` | `gate-remote -- bunx eslint <touched TypeScript files>` | 0 | 34 touched TypeScript files: zero errors, ten warnings. Files, configuration and dependencies match the final source. |
| `landing-pair` | `gate-slot gate-remote -- paired revision runner (per-file commands in runs)` | 1 | Landing and copy pass on both revisions; the privacy unit file fails on both. |
| `typecheck-current-main` | `gate-remote -- bunx tsc --noEmit --incremental false` | 0 | Passed on the final merged code. |
| `privacy-before-report` | `bun run privacy:check` | 0 | The actual publication gate passes on the code and existing report. |
| `privacy-repeats` | `gate-slot gate-remote -- paired revision runner (per-file commands in runs)` | 1 | Three complete file runs per revision, alternating order: the same 21 privacy failures in all six. |
| `privacy-report` | `bun run privacy:check` | 0 | Publication check of the completed report and evidence. |

The final documentation commit and its hook result, followed by the committed
publication check, are recorded in the stage completion receipt. No push is
performed by this stage.
