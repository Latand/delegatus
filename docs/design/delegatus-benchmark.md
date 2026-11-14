# Delegatus benchmark: protocol and bounded pilot

Originating requirement (2026-11-05), operator request carried by the pinned
benchmark task: study the linked Ponytail benchmark, build and run a fair
Delegatus benchmark, and determine whether it can measure task-agent selection,
completeness and learning between tasks. The verbatim private wording remains
on the task; this public document paraphrases it under that task's privacy fence.
Primary public reference: [Ponytail's report](https://github.com/DietrichGebert/ponytail/blob/96608e078b2d5ea607c5c3b8b5a54d1c1fba6846/benchmarks/results/2026-10-07-agentic.md).

Status: protocol and launch plan, 2026-11-05. **No model cells have run.**
The companion `benchmarks/delegatus/pilot-manifest.json` declares every intended
cell and its ordering. The next benchmark-only implementation will consume it. Fixture packages, runtime bindings and
containment evidence are deliberately unbound; a runner must refuse launch
until they are sealed. This design does not complete the broader benchmark task.
Implementation, an independently checked launch preflight and the real pilot
remain owed on that same task. The controller already schedules independent
verification of this protocol; this author has not substituted a self-review.

The latest direct operator clarification (2026-11-05), reread from the current
task details, makes **cumulative autonomy and quality on always-new tasks** the
primary question. Reviews and fixes are part of the working process. Resource
totals remain guardrails and secondary controlled views. Strong-solver,
fixed-team and routing controls remain with the same review/fix safety floor.
This clarification supersedes the earlier optimization framing. No further
operator decision is needed.

## 1. Evidence and scope

Delegatus source is pinned to `1fb5ca202ce8fa702f4e1b526114fe3e2f15af65`.
Ponytail source inspected on 2026-11-05 is pinned to
`96608e078b2d5ea607c5c3b8b5a54d1c1fba6846`. This pin identifies the inspected source. The historical run
has no verified harness-revision binding.
The report gives its CLI/model labels but does not supply a complete immutable
run-environment manifest. Its reported performance is third-party evidence.

Primary source map (line numbers refer to those pins):

| Ref | Source | Evidence used |
| --- | --- | --- |
| P1 | Ponytail `benchmarks/results/2026-10-07-agentic.md` | Reported design and results; no independent reproduction here |
| P2 | Ponytail `benchmarks/agentic/run.py:69,288-417,464-543` | 300-second timeout, CLI isolation, scoring, enumeration, warmup and aggregation |
| P3 | Ponytail `benchmarks/agentic/tasks.py:34-88,811-860,917-1112,1148-1247,1291-1544` | Seed/check/reference separation; cross-caller/privacy checks; UI regex check; task selection |
| P4 | Ponytail `benchmarks/agentic/complete.py:37-178`, `judge.py:27-198`, `answer.py:55-115`, `compare.py:20-93` | Rubrics, calibration, CLI/API choice, timeout exclusion, source context and comparisons |
| D1 | `docs/design/memory-quality-benchmark.md:681-856,901-989` | Historical replay, deferred live A/B and launcher, input-only scope |
| D2 | `scripts/memory-replay.ts:35-173`, `scripts/memory-replay.test.ts`; merge `338d02269709588cc29aa9033e02649e664d32a5` (#3406) | Private read-only assembly, bundle and oracle split, rejection rules, deterministic 4/3/3 draw |
| D3 | `src/lib/mcp/server.ts:3781-3840,4062-4115,4202-4265,4347-4380` | Supported spawn/pipeline parameters and launch lineage |
| D4 | `src/lib/runtime/agentConfigSandbox.ts:13-35,59-153`; `src/lib/pipelines/stageSandbox.ts` | Child config/state separation; account homes and MCP retained; access and sandbox are different axes |
| D5 | `src/lib/memory/eligibility.ts`; `roleStage.ts:19-38`; `roleLaunch.ts:54-151`; `source.ts:84-94` | Clean roles/gates; current selection; automatic memory switches |
| D6 | `src/lib/memory/deliveryLedger.ts:16-62,76-124,194-260` | Delivery identity, engine-file snapshots, retention and private analysis seam |
| D7 | `src/lib/memory/roleSelect.ts:99-185`; `roleSelectionProvider.ts:85-190`; `src/lib/environmentIsolation.ts:1-36` | Selection can call configured paid providers; ambient key filter retains several supported keys |
| D8 | `src/lib/runtime/codexAppServerHost.ts:1539-1561,1693-1715`; `src/lib/agent/spawnPolicy.ts:83-125,532-543` | Clean automatic memory does not remove account instructions or disconnect Viewer tools |
| D10 | `src/lib/pipelines/stageInput.ts:49-54,110-151`; `prompts.ts:136-148` | Same-project linked task details are appended despite empty overrides; controller prompts and referenced files carry effective input |
| D11 | `src/lib/pipelines/engine.ts:15495-15496,15632-15635`; `store.ts:2432-2446`; `src/lib/scanner/describe.ts:921-944` | Project comes from repoDir; task/project mismatch is refused; repository namespace and source-tree provenance are separate bindings |
| D9 | `AGENTS.md`, `CONTRIBUTING.md`, `package.json:43-48`, `docs/privacy-publication.md`, `.github/workflows/privacy-publication.yml` | Isolation, permitted checks, explicit-path publication scan and public-output policy |

Ponytail file paths in this table resolve beneath [the pinned repository](https://github.com/DietrichGebert/ponytail/tree/96608e078b2d5ea607c5c3b8b5a54d1c1fba6846/benchmarks/agentic).
Other paths are repo-relative. Source is authoritative over an older design.
Project-scoped and unscoped transcript searches were made for Ponytail, memory
benchmark and replay/corpus, followed by the original architect's final answer
at 2026-10-16 12:58:22 UTC. Its observational writing/delivery results establish
no causal quality gain. No private quotes or reconstructed historical rules
are carried into this protocol.

The existing exporter and its tests retain their current behavior. Its fail-first historical
cohort is useful for private harness regression work; it cannot be the only
sample for a general product claim. It exports inputs and verbatim finding
oracles. Executable checks and model launching remain separate work. This stage neither
re-exports live state nor launches the previously proposed 40-run replay.
The earlier spending fence remains intact; this outcome uses subscription
agents, including judges and curators, with no paid-key fallback.

Open project lanes were read through MCP before writing. The two new output
paths have no earlier committed implementation at the pinned base. Existing
memory/curator, runtime/census and document-renderer work is outside this lane.
The current document-link incident is excluded from every pilot task, calibration
artifact and memory example because the designers already know that case.

### Retrospective evidence interface (development/calibration only)

The additional 2026-11-05 requirement authorizes a read-only audit of the
operator's own prompts across every reachable project and all available
history, including antecedents older than one week. Another lane owns that
collection. This protocol reserves private `retrospectiveEvidence` schema v1
in the companion manifest; its payload, coverage seal and costs remain pending.
No collection, agent launch or live-memory change occurs in this fix stage.

The private producer records pseudonymous project/request/family IDs and
primary source locators with immutable digests, exact event timestamps and
original timezone. Distinguish the request, earlier instruction, lesson version,
eligibility at the action, proven delivery, verified action/result and later
applicable opportunities. Reopen primary messages for repeated requests and
explicit frustration; retain dictation uncertainty. Prior reports are leads.
A source must identify operator authorship; an agent relay alone is insufficient.
Record latest valid decisions, conflicting/superseded rules, runtime/product
failures and evidence gaps separately. A stored lesson or acknowledgment proves
neither delivery nor application. Recurrence alone establishes no memory cause.

Freeze the observation end before ingestion; search each reachable project's
entire earlier history with no lower lookback cutoff. For each index request,
record its seven-day antecedent boundary and whether older sources were reached,
absent after complete search, inaccessible or unknown. Coverage records include
project/source ranges, enumeration method, omissions and successful/neutral
controls alongside failures. Inaccessible history is a coverage gap.

Use unique applicable opportunities, deduplicated across copied/relayed messages,
as denominators. Delivery rate is proven delivered / all eligible exposures;
action compliance is proven compliant / all applicable action opportunities;
recurrence is verified repeated failure / all observed applicable follow-up
opportunities after an evidenced correction. Partition eligibility and delivery
as yes/no/unknown; action as compliant/violating/unknown; follow-up as
repeated-failure/compliant/unknown. Report counts for every partition, plus
known-only rates and conservative bounds that place unknowns at both extremes.
Unknown eligibility is reported separately with inclusive sensitivity bounds.
No follow-up opportunity means recurrence rate undefined. End of observation,
lost access or an unfinished action is censored with reason/time, never a
successful outcome. Missing proof remains unknown; true censoring is reported
outside observed opportunity denominators. Stratify follow-ups by prior lesson
recording, eligibility, delivery and verified application, including unknowns.
These are observational descriptions, with no causal learning claim.

Every case, associated task/answer and derived variant is development/calibration
material. A private quarantine registry maps case/family/artifact digests and
derivation links to exclusions; G7 checks all 13 pilot packages and judge golds
against it before sealing. If held-out content overlaps, replace/reseal the
unlaunched package before any solver sees it; an already exposed row remains
contaminated in the ledger and cannot support unseen transfer. The public
consumer receives only scrubbed class-level aggregates. Solvers, curators and
judges cannot read the private matrix or parent audit findings through task
context, history, tools or artifacts. G2/G3 enforce that boundary.

Audit model calls, human minutes, retrieval/curation, CPU and storage are shared
preparation with provenance, reported once with allocation and unknown coverage.
They are additional to the 252 trial-session and 5,264,000-unit ceilings; those
ceilings remain trial-only. Pending audit costs mean the broader outcome's total
is unknown. No audit payload is required for offline harness development;
coverage/quarantine evidence must bind before held-out packages are sealed.

## 2. What Ponytail establishes, and what it misses

The report describes 39 tasks, three skill arms, five repeats and 585 sessions.
Agents cannot use Bash, and automatic memory is disabled. Eighteen tasks have
hidden checks, with reported pass totals of 86/90, 86/90 and 87/90. Most of these
checks leave little room for a quality improvement. The other 21 tasks need a
completeness judge; timed-out undelivered cells are excluded from that judge's
table. These observations support a bounded skill comparison, with limited
coverage of iterative verification, task routing or learning. They provide no
Delegatus performance evidence. [Report](https://github.com/DietrichGebert/ponytail/blob/96608e078b2d5ea607c5c3b8b5a54d1c1fba6846/benchmarks/results/2026-10-07-agentic.md)

Reading the code adds several measurement constraints:

- Retain seeded artifacts, hidden good/bad checks, private workspaces, explicit
  deadlines and offline rescoring. `scope-recipients`, `scope-format` and
  `conv-seam` show how to test purpose, wiring and a second caller (P3).
- The fixture branch in `score_workspace` equates a nonempty added-code count
  with correctness; `score_open` always passes. Those are delivery signals.
  `conv-ui` checks source patterns and does not render the component. A
  deterministic label alone therefore establishes no behavioral coverage.
- `complete.py` sees a diff for fixture tasks; missing context can change a
  judgment. Supply full relevant base and final modules, generated interfaces,
  declared acceptance and independently captured checks to our judges.
- `tasks.py` also contains six extra open candidate tasks, and documents
  screening that candidate pool for clear winners. The report's 39 IDs must
  be enumerated to reproduce it; `--all` at this pin selects 45 tasks. Our
  selection freezes before solver outputs and retains every intended cell.
- `warm_cache` creates extra model sessions outside the cell matrix. Aggregate
  costs omit missing usage, and `compare.py` skips unavailable pairs/metrics.
  Our ledger records warmup and missing data explicitly and keeps failed rows.
- The report's geometric-mean/bootstrap analysis is not implemented by
  `compare.py`, which reports task medians and a sign test. Do not claim its
  report statistics are reproduced by running that script alone.
- `complete.py` can fall back to a direct CLI login; `judge.py`'s entry point
  demands an API key. Neither launcher is permitted for our model cells.

The useful hypothesis is that Delegatus can prevent missed acceptance and
cross-caller defects through bounded planning, specialization, review and
transfer of general lessons. More orchestration can also waste budget, produce
bad handoffs, select an unsuitable model, or preserve a stale rule. Every such
case belongs in the report.

## 3. Estimands and controls

Primary longitudinal endpoints are final accepted new tasks, autonomous accepted
tasks, first-submission functional acceptance, defects escaping the whole
declared-done process, later corrective work and violations on shared preregistered
principle opportunities. Conditional recurrence after an arm's own correction
is descriptive. Show cumulative endpoints by sequence step with human assistance
and all investments.
An improvement can fail to recover its initial investment. Report losses too.

| Arm | Workflow / treatment | Interpretation |
| --- | --- | --- |
| S | Strong M solver with self-planning, independent reviewer, one optional fix and fresh re-review | Strong-solver control with common safety floor |
| F | M planner, implementer, independent reviewer, optional fixer and fresh re-review | Fixed team versus S; added planning/context counted |
| A | Same pool/graph as F; planner selects frozen specialist briefs | Adaptive roles versus F, model fixed |
| HF / HA | Same team/pool M,H; fixed H execution versus planner-selected M/H execution; M reviews | Controlled heterogeneous routing |
| MR / MA | Identical F; reset / accumulating isolated experimental memory; code reset identically each task | Transfer to new tickets, two independent sequences |
| ER / EA | Identical F and empty memory; pragmatic current-scope implementation / explicit up-front reusable-structure investment; own evolving code | Architecture package under identical future business changes |
| P | Pinned product prompts/routing, sterile experimental memory only; common safety floor | End-to-end bundle versus contemporary S; no component attribution |

The read-only catalogue `roles-1-17275f57` proposes M = `codex/gpt-6.1-sol`,
H = `claude/claude-sonnet-5-5`, both effort `high`. Provider version stability,
subscription authentication/capacity and effective CLI/model versions require
launch proof. No settings/accounts change or silent fallback is allowed.
P seals its full mapping and prompts before the paired blocks.

Every main workflow includes independent review, at most one internal fix,
and a fresh independent re-review if fixed. A failed final review parks the
cell. S has four session slots; the others have five including their planner.
Pure no-review solo is absent; it could only be a separately preregistered
diagnostic, never the main product baseline. F/A and HF/HA keep review count,
tools, library and fix policy identical. Process reviewers/fixers are evaluated
components; external measurement judges do not feed back into that process.

Every task starts a fresh session. Within a stream tickets are always new,
with latent overlapping principles across domains and implementations. The
same ticket across treatment/control streams is required pairing, not rehearsal
within one stream. O/R/P are single-ticket control streams, with no learning
claim. Give paired arms identical necessary business facts, tools and acceptance.
Native subagents, helper CLI launches and nested pipelines are denied.

### Human assistance and working-process measurements

Freeze a goal-only business brief and evaluator-owned clarification script.
Record each information event's timestamp, actor pseudonym, request/fact, script
reference, reason, minutes and affected artifact. Categories: initial goal-only
input, business clarification, technical prescription, manual repair. Necessity
is separate: necessary missing business fact, avoidable corrective help,
legitimate new requirement, or unknown. Prompt word/token counts do not measure
autonomy. Answer necessary clarification consistently across paired arms and
report it separately. Do not reward guessing or skipping necessary questions.
A legitimate new requirement starts a versioned future task; acceptance freezes
before it starts and never retroactively turns into an earlier defect.
Unscripted help remains an intervention; attribution unknowns stay visible.

Capture the first submitted artifact before independent process review and the
final declared-done artifact after bounded internal review/fix. Hidden behavioral
checks run on both without worker feedback. `firstFunctionalAccepted` requires
all sealed behavioral requirements passing and a valid timely first artifact;
missing first artifacts are false. Apply the same behavioral/validity predicate
to the final artifact as `finalFunctionalAccepted`, so the first/final comparison
uses identical criteria. Final `fullyAccepted` adds the blind residual judgments
in section 7. Report initial defects caught internally and real
defects escaping the entire final declared-done workflow separately.

Retain reviewer findings with checkpoint, evidence, severity, fix disposition
and independent true/false/unknown adjudication. Precision = true/(true+false);
unknowns require bounds and coverage. Defect recall = unique real checkpoint
defects detected/all unique real checkpoint defects found by sealed oracles
and independent adjudication, including misses. Deduplicate repeated reports
of one defect. An incomplete census means coverage-limited recall with bounds;
no findings cannot establish perfect recall. Red-artifact calibration tests
evaluator sensitivity; synthetic defects earn no performance points.

Record internal fix rounds, unnecessary reviewer-induced edits, final escapes,
later regressions against retained requirements, corrective rework separately
from business changes, shared-opportunity principle violations and descriptive
conditional recurrence. Unknown applicability, missing proof and censored follow-up remain
explicit. Events/checks/findings are repeated measures; the independent unit
is the sequence/family cluster.

Before any arm runs, seal the common task/principle opportunity registry with
opportunity ID, task, principle class, applicability evidence and acceptance
version. Use the same IDs and applicability decisions for both paired arms;
count at most one opportunity per principle per task. Determine applicability
from the sealed task contract, independently of outputs, prior errors, corrections
or memory delivery. Keep acquisition and held-out opportunities separate.

The primary paired principle-violation rate is verified violations / all shared
preregistered applicable opportunities at that sequence prefix. Every assigned
opportunity stays in both arms' denominators. Record compliant, violating or
unknown action evidence for each arm, including when it never needed a prior
correction. Absence of correction proves no compliance. Missing artifacts,
timeouts and censored actions retain their assigned opportunities as unknown,
with reason/time. Report violation counts, denominator, unknown count and bounds
[verified violations / N, (verified violations + unknown outcomes) / N]. Unknown
applicability forms a common, separately reported sensitivity set for both arms;
never select an arm-specific subset. Zero shared opportunities means undefined.

Conditional recurrence additionally requires an earlier evidenced correction in
that arm's stream: verified same-class violations / all observed applicable
follow-ups after that correction. Retain correction and later-action evidence,
stratify by prior correction/delivery/application and preserve unknown-outcome
bounds, unknown-applicability sensitivity and censoring reasons. No correction
means no conditional recurrence opportunity; zero follow-ups means undefined.
Use this selected subset only for descriptive reporting, without causal paired
comparison or confirmatory power claims. Its censored/no-follow-up cases never
count as success and remain in the primary assigned-opportunity accounting.

For a harness-only check with three shared principle opportunities, MR with
prior corrections in all three and two later violations has primary rate 2/3;
MA with a prior correction only in the hard class and one later violation has
primary rate 1/3. Conditional recurrence is MR 2/3 and MA 1/1. An arm with no
prior correction still contributes all three primary outcomes, each requiring
its own evidence. This example contains no model-performance observation.

Later rework is charged to the task where it happens, tied to the original
artifact/defect; exclude legitimate versioned business changes from its defect
count but include their work in cumulative totals. Extra human repair is always
an intervention; no model repair may exceed a cell's registered session cap.

`autonomousAccepted` is final fullyAccepted with zero avoidable corrective human
help, technical prescriptions or manual repairs and no unknown assistance
classification. Necessary business clarification does not make it false.
Report strict goal-only accepted tasks separately. At each prefix show counts
and intended-denominator rates, first/final functional and full acceptance, escapes, assistance by
category/necessity, fix rounds, shared-opportunity violations, descriptive
conditional recurrence and cumulative work/resources.
No weighted quality/cost/autonomy scalar is the primary target.

## 4. Neutral task packages

The two orchestration/routing tasks use the real MIT-licensed
[FastAPI template at cd83fc10ca20393e9ee50e3005e170c6929e047e](https://github.com/fastapi/full-stack-fastapi-template/tree/cd83fc10ca20393e9ee50e3005e170c6929e047e),
the repository Ponytail uses. This pin was cloned and inspected, including
`backend/app/api/routes/items.py`, `backend/app/models.py`,
`backend/tests/conftest.py`, `backend/tests/api/routes/test_items.py`,
`frontend/src/client/sdk.gen.ts` and the package scripts. The route already
has ownership checks, admin behavior and count/list queries. The fixture's
session-wide database cleanup deletes rows: it must run against a disposable
PostgreSQL database, never a shared connection.

| Task | Public task contract to materialize | Behavioral coverage to seal privately |
| --- | --- | --- |
| T-export | Add authenticated JSON/CSV item export with explicit owner-only scope, stable ordering and escaping policy, exposed through the generated typed client and a second non-UI consumer; preserve existing CRUD | Owner boundaries including admin export policy; route precedence; complete export beyond a page; Unicode/escaping; both consumers; ordinary CRUD |
| T-archive | Add reversible item archival with migration, list/count consistency and an atomic owner-scoped batch operation; update API schemas and typed callers; preserve documented admin and existing CRUD behavior | Upgrade/downgrade data preservation; hidden/restored rows and counts; mixed-owner and invalid batch atomicity; repeated requests; typed caller and existing CRUD regressions |

The implementation stage must materialize these task blueprints. Hidden inputs, implementation answers, seeded defects,
reference patches and oracle code belong to the sealed evaluator package.
The implementation author must turn the listed policies into unambiguous
visible acceptance before sealing; hidden cases test those policies and
existing contracts. Every requirement must be visible in the brief or base code. Neither task
requires a new visible product screen. If the final package adds one, its
rendered checks become mandatory before sealing and the budget is rechecked.

Each package includes an immutable base bundle/tree, public brief, public test
command, dependency/image locks, an evaluator-only acceptance matrix, a correct
reference, a partial cross-caller reference and an unsafe reference. A correct
reference must pass; the unchanged base and every defect reference must fail
its intended behavioral group. Check the real project runner, including fixture
and parameterized tests; do not inherit Ponytail's miniature pytest substitute.
Bind all 13 packages to disposable repositories in the benchmark parent's
project namespace. Each repository has its own Git directory under the stage
scratch root, the same normalized origin as the benchmark parent, and a sealed
neutral template/overlay baseRef; the template source URL/revision/digest is
recorded separately from that namespace origin. No live checkout, remote or
task is changed, and no fixture branch is pushed. A normal upstream-template
clone resolves to another project and is refused. Avoid path-recognizer layouts
that could override the chosen namespace. Before any create, resolve canonical
`projectForCwd(repoDir)` and run the real `pipelineTaskLinkError` against every
existing task binding for each of the 13 packages, including its eventual
worktree path. Require exact project equality and no task-link error; retain
wrong-project and missing-task red controls. A null/ambiguous binding closes G6.
The namespace alone establishes no payload isolation or current-seat authority.

Freeze package digests before model calls. The manifest's null package digests
forbid launch. Moving upstream content cannot fill them.

The larger bank reserves 60 new tickets across at least ten latent principle
clusters and six domains: a recruitment target, not an authored corpus today.
Each package records private principle/opportunity labels, business facts,
dependency/change schedule and contamination lineage. Freeze authorship,
selection and labels independently before outputs; include successful/neutral
controls, not only historical failures. Retrospective derivatives are all
restricted to development/calibration.

The pilot has **13 unique ticket packages**: T-export/T-archive, eight memory
tickets and three evolving-code tickets. It validates measurement first.

| Sequence | New tickets in chronological order | Policy |
| --- | --- | --- |
| Q1 | Tenant-derived read; unrelated structured-input adapter; unseen aggregate-read with changed admin constraint; unseen asset authorization in another subsystem | MR/MA identical reset base per ticket; MA freezes after learn 2 |
| Q2 | Retry-safe operation; unrelated client timestamp contract; unseen retry family with changed replay constraint; unseen transactional import | Same reset/identical-code policy; independent principle cluster |
| E1 | Initial owner-scoped workflow; new batch business change; different scheduled import/business change with retained regressions | ER/EA evolve their own final tree; identical future requirements, empty memory |

Interleave Q1/Q2 by matched step, alternating arm order. Learn 2 supplies
interference, near transfer changes a constraint and far transfer changes
subsystem/vocabulary. Independent authors check labels and ticket disjointness.
Both held-out tasks receive the identical frozen MA snapshot; no held-out
feedback or curation is allowed. Future briefs remain hidden until task start.

E1 separates architecture from memory. Both arms start identically and then
carry only their own code forward. EA may invest in justified structure;
ER pursues the current contract pragmatically with the same quality floor.
Do not force poor ER design or score pattern/layer presence. Charge all initial
architecture/planning/review/fix work. Seal identical future business changes
and retained regressions before task 0, reveal each at its scheduled start.
Preserve failed trees and statuses; if a dependent task cannot execute, stop
the matched block and retain all later rows as blocked/not run. Never reset
one arm to rescue it. E1 is one dependent cluster, useful only for measurement.

For each prefix report cumulative accepted changes, escapes, regressions,
corrective rework, human help and resources from the initial investment onward.
A provisional amortization point is the first prefix where EA has no lower
cumulative acceptance, no more critical escapes, and no greater cumulative
human work and resource use than ER. Show each resource axis separately.
Otherwise report not amortized through the observed horizon; no extrapolated
break-even date or universal clean-architecture claim is supported.

## 5. Exact pilot and stopping rule

There are **34 intended solver task-cells**, without repeats:

| Phase | Tasks / sequence | Arms | Cells |
| --- | --- | --- | --- |
| O | T-export, T-archive | S, F, A | 6 |
| R | Same tasks in new matched control streams | HF, HA | 4 |
| M | Q1/Q2, four different tickets each | MR, MA | 16 |
| E | E1 investment and two new business changes | ER, EA | 6 |
| P | T-export, T-archive | P, reusing O-S | 2 new |

Run one compact O/P block per task: **T-export S,P,F,A**, then
**T-archive A,F,P,S**. Both O contrasts reverse order across tasks; P/S remains
adjacent in opposite orders. Follow with R, interleaved M and E in manifest
order. P is not a last temporal phase. The first S/P instrumentation checkpoint
remains after T-export P; its elapsed time counts toward the O drift bounds.

Each P/S pair retains its full-input proof and drift checks: no interleaving
solver, at most 3,600 seconds between first model work, unchanged exposed
bindings, capacity for both budgets before the pair and no quota reset crossing.
For O, preflight all four cell budgets before each block and recheck capacity,
quota windows, runtime and sealed inputs before every start and after completion.
Only the block's listed solver cells may interleave. Maximum first-model-work
separation is 7,200 seconds for S/F, 3,600 for F/A and 10,800 across the whole
four-cell block, including checkpoint and queue delays. These are registered
experimental limits, independent of the summed active/queue resource ceilings.

O permits zero changes in requested model, resolved model/version, CLI/build,
subscription mode/account binding, exposed serving revision, tools or containment
within the block. Compare each binding by matching role; only the preregistered
arm-specific workflow/brief treatment may differ. Sealed task, acceptance and
shared input bindings stay identical. Record preflight and completion evidence
and both first-model-work timestamps for every contrast. Capacity must cover
remaining registered budgets, and no quota reset may cross the block.

Unknown or violated O time/version/capacity bounds stop further admission.
Preserve all intended rows, statuses and incurred costs, with no replacement;
mark affected contrasts causally ineligible and report their observed outcomes
descriptively. A missing provider serving revision leaves server stability
unproved and excludes causal attribution even if visible bindings agree.
P/S unknown/change also stops admission; late/drifted pairs remain invalid in
the intended ledger with all costs and no replacements. Disclose unobservable
provider drift in every report. Counterbalancing alone cannot remove arbitrary
time drift; interpret O causally only within its verified bounds and stated
stability assumptions.

Per-arm denominators are O=2, R=2, M held-out=4 (two per sequence), M
acquisition=4 separately, E=3 in one cluster, P=2 reusing O-S. Do not pool 34
into a product win rate. The old 38-cell/266-session proposal is superseded
following the latest clarification; it was never an operator requirement.

Use the first paired block as a counted instrumentation checkpoint. Continue
only after receipts, first/final captures, assistance classification and reviewer
ledger validate offline. A failure stops with remaining rows not_run_after_stop;
no replacement or unlisted warmup. This checkpoint establishes measurement,
not model performance. It authorizes no launch from this design stage.

Each cell has a common secondary guard of **128,000 charged token units**,
1,800 summed active seconds and 1,800 additional queue seconds. Learn cells
reserve 8,000 units/180 seconds for curation within that cap, leaving
120,000/1,620 for the working process; MR and MA both pay it. These experimental
bounds require G5 and describe no provider context limit. Unknown usage or an
overrun makes a cell incomplete. Resources are not the primary optimization.

S has at most four sessions and the other 32 cells have five: **168 process
sessions**, eight curators, **76 external judge sessions** (68 final judgments
plus eight calibration) = **252 subscription sessions maximum**. First artifacts
receive hidden behavioral checks without additional model judges. Record actual
turns/calls; starts/restarts consume slots. No model-based preflight/warmup.

Count input/cache/output/reasoning tokens exactly once using verified actual
engine envelopes; retain originals and parser. Missing usage is unknown, never
zero. Judges have guards of 12,000 units/300 active seconds and 1,800 queue
seconds each. Trial ceilings: 4,352,000 process/curation + 912,000 judging =
**5,264,000 units**, 84,000 summed active seconds, 61,200 process queue seconds
and 136,800 judge queue seconds. These are ceilings, not predicted duration.
Shared audit/preparation/human costs are additional, pending their own bindings.

Stop on isolation/leakage, unbound runtime/usage, judge calibration failure,
resource exhaustion or cleanup failure. Preserve every intended status, receipt
and cost; attribute infrastructure separately. Partial instrumentation makes
no performance claim. No silent retries or deletion of failed/not-run rows.

## 6. Chronological memory and leakage control

Each arm/sequence starts with empty benchmark-owned memory and a separate
filesystem/config and experimental-memory namespace (canonical task project stays bound). Every task, including learn tasks, starts
fresh agent sessions. Reset the repo to the sealed task base every time; both
arms see identical code versions and task order. Code familiarity from seeing
earlier code is thus shared exposure, while retained memory is the treatment.
The solver's final reviewer and the scoring judges remain clean.

For each sequence:

1. Solve learn 1 in MR and MA, then run one bounded curator per arm on only
   that arm's completed learn-task public brief, final code, public-check
   evidence and in-workflow review. No hidden score or external judge output
   reaches either curator. MA retains its rule snapshot; MR's output is sealed
   for accounting and discarded from later solver input.
2. Solve learn 2 with fresh sessions. MA receives only its prior snapshot;
   MR receives empty memory. Curate under the same conditions and bounds.
3. Freeze MA's post-learn-2 snapshot. Both near and far eval cells receive
   this **identical** snapshot digest, reset code and new sessions. MR gets the
   empty digest on both. Never update memory during held-out evaluation.
4. Score all held-out artifacts only after learning has frozen. Evaluator and
   judge outputs cannot be back-fed into any learn step or later held-out cell.

Snapshots hold at most 8,192 UTF-8 bytes of general behavioral lessons, with
source learn-cell IDs, allowed evidence hashes, creation order and a schema
version. They contain no task answer, code, hidden check, expected output,
future task spec, private transcript or live learned-rule text. Curation
rejects identifier/answer memorization and unsupported generalization; its
rejection and retention costs are charged. The frozen pack, selected/injected
bytes, wrapper, order, digest and effective prompt digest are retained per
session. Any truncation is explicit and identical retrieval policy is fixed
before launch. In this pilot retrieval is the entire bounded pack, with no
model selector. This measures learning through a benchmark-controlled memory
channel; it does not establish the quality of native Delegatus selection.

The controller sees the schedule, the learner sees one task payload, and the
curator sees the completed prefix. This boundary includes automatically appended
linked `task.details`, `inputContext.taskDetails/skillPaths/handoffDigest`,
pipeline task/spec, previous outputs and referenced controller files (D10).
An empty override leaves linked details present. Every start/resume must seal
and audit the fully expanded effective payload against the role's allowlist;
judges receive only neutral task requirements, artifacts, rubric and trusted
check evidence. The parent benchmark/audit details are forbidden to all three. Task repositories contain no harness,
future fixture packages or oracle directory. Deny explicit transcript/memory
search, filesystem traversal, git-object access and link/export reads outside
that cell. An instruction to avoid reading is not containment. Frozen/shuffled
or unrelated matched-length packs are useful later controls for memory length
and mere reminders; the pilot makes no causal claim excluding those mechanisms.

Existing ledger evidence (D6) is useful for the native channel. It records
scope/rule metadata and Claude index/Codex summary versions, with retention
bounded to 10,000 starts and 64 MiB of file versions. It is not an exhaustive
record of arbitrary files, skills, account instructions or MCP reads. Export
needed private evidence promptly, without putting it in the public manifest.
The earlier claim that no delivery ledger exists is obsolete at this source pin.

## 7. Scoring and independent judgment

Final quality uses the following preregistered secondary Q score beside the
primary cumulative autonomy/acceptance and rework endpoints in section 3. Define behavioral B as a
macro-average of sealed requirement groups: core acceptance 0.35, edges 0.25,
security/privacy 0.25, cross-caller/regression 0.15. Each group averages its
requirements equally, regardless of assertion count. Seal exact requirement
membership and which failures are critical before launch.

Two blind independent judges score residual requirements using full relevant
code/context and trusted check evidence. Each uses 0..3 for completeness,
factual accuracy of the delivered evidence, and justified maintainability,
weighted 0.5/0.3/0.2. Normalize by three to get each judge
contribution to J.
For a disputed case defined below, use the lower rating for J in the frozen
Q score and preserve both for its bounds. Otherwise average the two judges.
Then Q = 100 * (0.8 * B + 0.2 * J). A critical security/privacy/data-loss
failure, no delivery, a solver timeout or a budget overrun sets Q to zero. Also report
raw B, every group, critical failures and every rubric dimension so weights
cannot hide a regression. LOC, gzip size, prompt length and test quantity earn
no quality points.

Define `fullyAccepted` independently of Q. It is true exactly when every sealed
behavioral requirement in every group was executed and passed (none missing or
waived), the artifact was delivered with terminal/cleanup receipts, usage is
known and within all resource/deadline/session limits, there is no critical
failure or contamination/protocol invalidity, calibration passed, and both
independent parseable judgments cover every residual requirement. Each judge
must give completeness=3, evidenceAccuracy=3 and justifiedMaintainability>=2;
there must be no unresolved dispute under the rule below. All other cases,
including not-run/infrastructure failures, have `fullyAccepted=false` in the
intended denominator. Later adjudication does not rewrite this frozen boolean.
Thus B=1 with both judges (3,3,2) is accepted when the other conditions hold;
one missing judge is false; completeness 3/2 is false. Q near 99 alone does
not determine acceptance. The manifest records these boundary cases and guards.
Complete-acceptance rate is sum(fullyAccepted) / intended cells for each endpoint
and arm using the denominators below. Cost per fully accepted task includes failures' resources;
with no accepted tasks report it undefined and show total resources.

J1 uses M and J2 uses H as clean verifier sessions under the same calibrated
rubric. Independent means new sessions, no raw solver/reviewer conversation history and no
access to arm, routing, memory, cost or previous judge verdicts. Cross-provider
judging does not remove provider bias; show both ratings. Randomize artifact
labels and presentation order; replace arm markers with inert labels without
changing code semantics, and retain a reversible private mapping. Judge
incomplete diffs with full base context; if context must be chunked, use the
same frozen rule for every arm and record coverage. Uncovered evidence stays
unjudged and cannot receive a full mark.

After each external judge freezes its final residual ratings, a second phase
within that same bounded session audits anonymized first/final artifacts and
neutral finding claims for the process defect census and true/false/unknown
classification. It sees no arm/model/memory labels or raw process conversations.
Do not revise the frozen ratings after seeing finding claims. These extra turns
remain inside the existing 12,000-unit/300-second judge guard, with both payload
phases checked by G7; if they cannot fit, stop/reseal before any model launch.
Use deterministic oracle evidence where available; unresolved disputed labels
remain unknown/bounded. Extra human adjudication is logged separately and cannot
rewrite primary outcomes. No uncounted model adjudication is permitted.

Before campaign scoring, each judge evaluates four sealed gold artifacts:
complete, stub, subtle cross-caller omission, and unsafe/false-verification
submission. Both judges must rank complete above each red case, identify each
seeded critical defect, and never give the red cases full completion/evidence
credit. These eight sessions are in the budget. Behavioral checkers must reject
the defect references and accept the correct reference. Calibration failure
stops judging; it does not trigger repeated judge shopping.

Keep raw judgments, cited evidence, disagreements and any later human
adjudication. No silent manual correction of an awkward score. If ratings
straddle completion or differ by two points in any dimension, report both
and a Q interval using the lower/upper ratings; the lower score is the
pre-registered conservative headline. An unparseable/missing judgment is
`unresolved`; its J contribution has bounds 0..1 and contributes zero to that
headline. Human review is separately logged in minutes and disclosed as an
intervention; it cannot change the frozen acceptance/Q outcome after results are seen.

## 8. Accounting, reporting and later statistical power

Each row records requested/resolved runtime, CLI/build/role/prompt hashes,
repository tree, task/oracle/dependency digests, account pseudonym and plan tier,
MCP request and durable stage identities, original usage envelopes, input/cache/
output/reasoning categories and availability, stage times, queue times, public
checks, final artifact tree, judgment status and failure attribution. Preserve
failed launches and retries, owned-process cleanup and actual final exits.
Record start, admitted, first model work, last output and terminal artifact
capture separately. Report both end-to-end elapsed time and summed active
agent time; parallel capacity never makes agent work disappear.

Include planning, routing, review, fixes, failed starts, restarts, retention,
learning, curation and retrieval. Curators already sit within learn-cell caps.
Report learning expenditure separately and amortized across held-out tasks;
exclude no sunk learning cost from sequence totals. For Q1/Q2 the resource
ceiling is 4 * 128,000 units per arm; E1 is 3 * 128,000 per arm. Record deterministic preparation CPU,
storage and human interventions outside model usage. The deterministic
controller adds no uncounted model calls; any model-based controller decision
must instead occupy the counted planner slot or reseal the manifest.

List-price estimates use a dated primary vendor rate snapshot and the resolved
model, engine-specific token categories and cache treatment. If an alias has
no verified matching rate, report `unavailable`, with coverage percentage and
known-category subtotal explicitly marked partial. Never substitute a similarly
named model's price. Subscription cash outlay, included usage, incremental
charges and allocated shared subscription cost are four different fields.
Paid API fallback is forbidden even when a subscription has no capacity.
Judge and calibration costs appear separately from production cost. Shared
preparation or retention cost is shown once and with an explicit allocation.
The retrospective audit is shared preparation under the versioned interface
in section 1, outside trial caps; never report 252 as the entire outcome's
session ceiling or hide audit/human cost in a trial row.

Publish the complete intended matrix with all statuses, per-task paired
results, Q/B/pass/time/resource/cost frontiers, dominated arms and concrete
losses. Plot observed resources against quality; a pilot with one budget is
not an identified response curve. The subsequent evaluation randomizes budgets
at 0.5B, B and 2B, preserves the same tool/pool controls and reports a curve
with interval bands. Synthetic fixtures or replayed transcripts validate the
harness only and never enter a model-performance table.

The O/R sampling unit is the paired task; this pilot has no repeats. For memory,
the independent unit is the sequence/family cluster; held-out tasks, turns,
tests and two judges are repeated measures. With two control-task clusters, two learning clusters and one evolving-code
cluster the pilot reports raw paired differences and ranges only,
no meaningful leaderboard, population CI or significance claim. Report each
task's observed values and disagreement limits. Checks add no independent samples.

Report clustered paired prefix differences in autonomy, first/final acceptance,
human assistance, shared-opportunity principle violations and rework before
Q/resource views. Conditional recurrence is descriptive only. Power primary
longitudinal endpoints using independent sequences with dependent prefixes and
failures retained; freeze material-effect definitions before recruitment.
Architecture needs its own independent evolving-code clusters and longer future
change horizons. One E1 cluster cannot establish generalized amortization.

For the secondary controlled Q contrasts in a powered evaluation, first estimate paired task/cluster variance from an
independent calibration batch. Choose a material effect delta of five Q points,
80% power and familywise 5% error across the four predeclared causal contrasts
(S/F, F/A, HF/HA, MA/MR), using a paired cluster simulation that preserves failure and
within-task correlation. Memory separately targets five held-out Q points per
sequence with clustered paired analysis. Plan at least 30 independent task
clusters and 20 independently authored sequence clusters as a recruitment
floor; increase that count if simulation needs it. These floors do not promise
power. Freeze sample size and analysis before the confirmatory run. Bootstrap
whole paired clusters, report 95% intervals and task-level intervals,
apply Holm correction across those four contrasts, and retain missing rows with
the conservative score. No effect is declared on pilot variance alone.

## 9. Supported MCP launch recipe

The later launch is owned by the controller.
Use the current designated seat's own transcript `src`, and resolve the full
existing benchmark `taskIds` from the task record immediately before creation.
Do not publish those private bindings. Every trial stage is a visible `run`
stage created by `mcp__viewer__create_pipeline`. Use `publication: internal`,
`finishesTask: false`, a sealed local `repoDir`/`baseRef`, explicit `next`
edges, and stage-local `engine`, `model`, `effort`, `access` and `sandbox`.
Set neither role mapping overrides nor a deployment/publication target.

At this pin no supported request field suppresses linked task details. The
benchmark-only candidate is a disposable installation/state view using the
existing `LLV_STATE_DIR` entry-point mechanism, provisioned before launch from
allowlisted neutral records. Its isolated task store would preserve the same
existing IDs/project while exposing only neutral details; retain source revision
and sanitized-view digests privately. Do not edit or relocate the live task,
change its details, invent a suppression flag, or patch product composition.
This candidate is **unverified**: copying a record establishes no seat authority.
It must independently prove the genuine current-seat src/task lineage and
operator-visible stages via supported MCP, with all G1-G7 satisfied. If existing
entry points cannot provide that boundary, refuse launch and return the exact
unsupported capability. The offline harness can proceed while this remains open.

Inventory task record versions/details, full inputContext, task/spec, resolved
role scaffold, skill paths/contents, handoff, previous output and every controller
artifact. Use the real `composeStageText`/`composeStageInput` path, dereference
all prompt files and include engine-added instructions. Audit again after every
await that can change these sources, immediately before each start/resume.
A parent-details canary must reach the observer in an unfiltered positive
control and be absent from solver/curator/judge effective inputs in the sterile
candidate. Empty overrides, changed task revisions and oversized prompt-file
fallbacks are red controls. Withhold dispatch on unknown or changed inputs.
This effective-input proof is required separately for P's pinned defaults.

For team cells the graph is planner -> implementer -> reviewer. The reviewer
has `next: null`, `onFail: {to: fix, maxRounds: 1, onExhausted: park}`;
fix has `next: reviewer`. This permits one fix/re-review before the next
failure parks. Verify that exact round behavior offline against the pinned
engine before launch; a park cannot silently turn into an extra fix. Read-only
planner/reviewer outputs, if needed, are declared explicitly. Implementer and
fixer own the neutral task checkout only. S uses builder -> reviewer with the same bounded fix/fresh re-review floor;
it has no separate planner.
MCP `agentMemoryMaxBytes` is a RAM/cgroup cap; it is unrelated to token budget
or memory-treatment snapshot size.

Read `get_pipeline` for graph digests and attempt records, `agent_activity`
for owned activity, and an operator snapshot for visible grouping. Join each
stage to its durable conversation/path and the expected current-seat lineage,
project, task IDs, stage ID, attempt and final tree. Pin model/prompt resolution;
record admission fallback/refusal as observed. A board acknowledgement alone
is insufficient evidence that the model executed. Use `stage_report` for stage
settlement; never parse a natural-language success sentence as acceptance.
For retries, reconcile the durable receipt before resending the same logical
MCP request. Do not start generic `spawn_agent` workers as a pipeline bypass.
No child worker, curator or judge may call a CLI launcher or spawn another lane.

A manifest row expands to this existing API shape (bindings are controller
values; the placeholders must be resolved before submission):

```json
{
  "clientRequestId": "campaign-and-cell-specific-stable-key",
  "repoDir": "BOUND_SEALED_TASK_REPOSITORY",
  "baseRef": "BOUND_TASK_COMMIT",
  "src": "CURRENT_SEAT_TRANSCRIPT",
  "taskIds": ["EXISTING_BENCHMARK_TASK_ID"],
  "task": "Benchmark cell with neutral task title",
  "publication": "internal",
  "finishesTask": false,
  "stages": [
    {
      "id": "solve", "kind": "run", "role": {"roleId": "builder"},
      "engine": "codex", "model": "gpt-6.1-sol", "effort": "high",
      "access": "read-write", "sandbox": "restricted",
      "prompt": "BOUND_TASK_VISIBLE_BRIEF", "next": "review"
    },
    {
      "id": "review", "kind": "run", "role": {"roleId": "reviewer"},
      "engine": "codex", "model": "gpt-6.1-sol", "effort": "high",
      "access": "read-only", "sandbox": "restricted",
      "prompt": "BOUND_NEUTRAL_REVIEW_BRIEF", "next": null,
      "onFail": {"to": "fix", "maxRounds": 1, "onExhausted": "park"}
    },
    {
      "id": "fix", "kind": "run", "role": {"roleId": "builder"},
      "engine": "codex", "model": "gpt-6.1-sol", "effort": "high",
      "access": "read-write", "sandbox": "restricted",
      "prompt": "BOUND_INTERNAL_FINDINGS_ONLY", "next": "review"
    }
  ]
}
```

The shape supports orchestration and lineage. It **does not** establish the
isolation or metering required below. Do not add invented `env`, `cleanMemory`,
`memorySnapshot` or `maxTokens` fields: passthrough schema acceptance does not
mean the product applies an undeclared field.

## 10. Concrete isolation gaps and launch gates

| Gate | Confirmed capability / concrete gap at this pin | Required proof before any solver launch |
| --- | --- | --- |
| G1 state and auth | Child config/state is isolated; account homes, credential mode, transcript roots, GH config and Viewer MCP intentionally retain real bindings (D4). No per-cell HOME/profile parameter is exposed by create_pipeline | Benchmark-only execution environment with existing subscription auth, no paid keys, sterile instruction/skill/native-memory roots, and no live state/credential-file reads or writes; prove actual effective roots and auth mode without printing secrets |
| G2 memory | Reviewers/verifiers and gates are clean automatically. Builders normally receive live role selection; no per-arm frozen snapshot selector is public. Source switch is installation-wide (D5). Codex retains account developer instructions (D8) | Linked task.details, full inputContext and expanded controller/engine payload inventoried and sealed on each start/resume (D10); positive parent-details control and sterile negative canaries required; both arms' automatic/native/live recall off, only explicit benchmark pack injected; exact bytes/digests on every start/resume, plus denial of live lesson/curation writes. Never rename an implementer to a clean role merely to evade policy |
| G3 readers/oracles | Automatic-memory exclusion leaves explicit search tools available. A read-only role defaults to full sandbox; access controls settlement and leaves other reads available (D4/D8) | Parent-task/audit canaries absent from every expanded payload and referenced file; negative canaries across shell and filesystem, git objects/history, global/project instructions, skills, MCP search/conversation/file/link/export/cache APIs, identifiers and inherited tools. Deny cross-arm data and future/hidden packages server-side or at an external boundary; record every allowed reader/store |
| G4 paid services | Role selection can use configured OpenAI/OpenRouter services. Supported API keys survive ambient filtering (D7) | No paid key or provider client reachable from benchmark runtime, including hidden selector/curation helpers; fixed local whole-pack retrieval for M; no live settings change to obtain this |
| G5 budgets and usage | Public stage schema exposes RAM cap and runtimes. It has no aggregate token, private env or usage-budget parameter. Normalized message reads omit usage | Reliable private usage source and parser; bounded controller interrupt/cleanup through MCP for its owned cells; aggregate cap across retries and controllers. Unknown usage/overrun makes the cell incomplete; no claim of exact equal caps without this proof |
| G6 runtime and visibility | Local and two named Cloud runtimes exist; no arbitrary isolated-container executor is promised by the public contract | Prove all 13 namespace repoDir/worktree bindings with canonical projectForCwd and real pipelineTaskLinkError before any create; wrong-project and missing-task controls must refuse. Demonstrate isolated neutral task-store composition preserves genuine current-seat src/taskIds and visible MCP stages; no cross-project escape. Cloud publication/fallback cannot be assumed equivalent to the internal local recipe |
| G7 fixture/scoring | Historical exporter separates oracle but launches no models; new neutral fixtures and rubric golds do not yet exist | Correct reference green, unchanged/partial/unsafe references red; locked dependencies, disposable DB, oracle boundary and blind judge payload audit; package/runtime binding digests and retrospective quarantine/coverage seal bound before launch |

A separate scratch installation or external containment may avoid changing
product code, but neither is a verified recipe here. In particular, a second
installation does not automatically preserve the required current-seat task
and lineage binding. The next implementer must demonstrate the complete
boundary with non-model canaries. A prompt telling workers to behave cannot
close G1-G6. Existing subscription availability is also a launch observation,
not an inference from a model catalogue entry.

Prefer a benchmark-only adapter and disposable isolated execution environment
using unmodified product entry points. If the supported launch contract cannot
satisfy these gates, finish the offline harness and return the exact unsupported
boundary to the controller before launching. Product-runtime changes, global
memory switches, new accounts and paid API calls remain outside this outcome's
implementation scope; they require a separately accepted scope change. This
is a dependency for the launch stage. This design needs no new operator answer.

## 11. Minimal next implementation / launch brief

Keep one benchmark task and the existing input work. The owning controller
should materialize a benchmark-only implementation stage, then an independent
verifier, and only then an execution stage. This stage launches none of them.

Implement one small `benchmarks/delegatus/run.ts` driver and its direct
`run.test.ts`, with validation, immutable sealing, deterministic MCP request
expansion, append-only row accounting and offline scoring/reporting. Use native
JSON/files and the existing MCP client; no generic orchestration framework,
new product endpoint or product settings schema. A missing gate must produce
a bounded refusal naming that gate, with zero model launches. Keep source
hashes, schema version and every intended row in the run record.

Author the 13 neutral task packages (two O/R/P tasks, eight M tasks and three E tasks) and
four judge gold artifacts outside solver-visible repositories. Freeze public
briefs and private checks/reference patches separately. Make evaluator packages
readable only by their owner; output directories carry their own ignore rule
when provisioned. No fixture answer, memory rule text or model transcript is
committed. Publish only neutral protocol/manifests and later aggregate,
privacy-checked results. Raw evidence stays private through the authorized
artifact mechanism; do not hand out an unverified private-path link.

Implementation acceptance is concrete:

1. Manifest validation proves the 6/4/16/6/2 counts, unique rows, exact sequence,
   opposite-order compact O blocks, adjacent opposite-order P/S pairs, their
   time/version/capacity guards and causal-ineligibility paths, fullyAccepted boundary cases,
   retrospective schema/quarantine bindings, review/fix floor, first/final and human
   event accounting, shared-opportunity primary violations versus descriptive
   conditional recurrence (including the three-opportunity counterexample),
   E1 code dependencies, arm pairing, dependency references,
   the two identical frozen evaluation
   digests per accumulating sequence and the intended failure denominator.
2. Non-model tests exercise every gate red path, unknown usage, timeout,
   truncated context, duplicate/unknown MCP delivery, model fallback, judge
   calibration rejection and partial/unsafe oracle controls. Replayed/synthetic
   data is marked harness-only. None is counted as a model run.
3. A private launch-binding file records current src/taskIds, approved
   subscription profile references, effective runtime versions and hashes,
   task/oracle/dependency seals, all 13 canonical project/task-link proofs, full
   task.details/inputContext/effective-payload inventories, retrospective evidence
   coverage/quarantine seals, containment/usage evidence and the immutable
   manifest digest. All static null bindings must resolve; runtime-derived learned packs
   are bound after learning and verified before their dependent cell. No model call is
   used to discover whether isolation works. If authentic model-start evidence
   is essential, register that as a counted first pilot cell.
4. Independent verification audits the payload and negative canaries against
   every reader in G1-G7. It either clears launch or returns the exact unmet
   boundary. Do not implement a speculative product control in this lane.
5. The current seat dispatches the manifest's rows in order, with all solver,
   curator and judge stages visible through MCP. Preserve requests, receipts,
   resource/exit/cleanup evidence, memory digests and final trees. Report the
   full matrix even after a stop, then update the same task with the measured
   outcome and what remains owed.

Run only the driver's explicit direct test file through the project's gate
wrapper, using scratch exports and isolated HOME, XDG_CONFIG_HOME, TMPDIR and
LLV_STATE_DIR. No whole runtime suite, typecheck or production build is needed
for this design. Publication uses the project's privacy gate over the declared
files, with committed fingerprints; the controller owns staging/publication.

## 12. Deferred — not currently justified

- A full factorial of routing, roles, budgets, models, memory sources and
  curators. The staged pilot tests the measurement without multiplying spend.
- A product leaderboard or a claim that Delegatus wins; the pilot has too few
  independent clusters and may reveal domination by S.
- Running the old private replay cohort as general performance evidence,
  publishing private transcript replays, and any paid-key replay or judge.
- Changing native role-memory curation, selection, global settings, account
  policy or runtime. Existing lanes own those mechanisms. Native memory and
  benchmark-controlled whole-pack delivery need separate causal estimates.
- Frozen-at-baseline, shuffled and irrelevant matched-length memory controls,
  multiple curators and more repositories remain deferred. The small E1 stream
  already measures evolving code under identical future business requirements;
  its arms keep their own code. A larger architecture campaign requires more
  independent evolving-code clusters.
- More repeats and budget levels before measuring saturation and variance.
  Confirmatory recruitment and budget curves follow section 8, with new
  pre-registration and honest total subscription-resource accounting.

## 13. Validation against the originating requirement

The primary protocol measures cumulative autonomy/quality, human information,
review effectiveness, later work and shared-opportunity principle violations on
new tasks; conditional recurrence remains descriptive. Memory transfer
uses reset/identical code; maintainability uses evolving code with matched future
changes and explicit initial investment. The secondary controls test same-model orchestration (O), task/model selection (R),
completeness and regressions (sealed behavioral groups plus blind judges), and
learning through chronological acquisition and frozen unseen transfer (M).
P reports a bounded ordinary-workflow bundle separately. All phases can lose.
The neutral manifest fixes exact cells, budgets, sequence and failure treatment.
The source inventory identifies capabilities already present and launch gaps
still owed. The broader requested run is explicitly deferred to the same task's
implementation/verification/launch stages; this document contains no fabricated
model result, price, provider ceiling or claim that isolation already works.
