# Operator correction lessons

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
