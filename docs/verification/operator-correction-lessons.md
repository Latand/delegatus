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
under an earlier build still counts in the agenda.

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
non-pipeline roles, duplicate priority across scope reads, and integrate / rewrite /
drop decisions with reversible history. The seat mandate advances to v59;
its new instruction uses 250 bytes of the reserved rotation-history room while
remaining inside the existing structured message limit. Pending seat-intent
replays retain their original bytes.
