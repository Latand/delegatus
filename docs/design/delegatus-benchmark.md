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

The answered operator form confirms all three choices: quality at equal total
resource budget, with time and cost reported separately; a strong single agent
and a fixed team as controls; separate reset and accumulating sequences followed
by new held-out tasks. There is no remaining operator decision for this document.

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
| D9 | `AGENTS.md`, `CONTRIBUTING.md`, `package.json:43-48`, `docs/privacy-publication.md`, `.github/workflows/privacy-publication.yml` | Isolation, permitted checks, explicit-path publication scan and public-output policy |

Ponytail file paths in this table resolve beneath [the pinned repository](https://github.com/DietrichGebert/ponytail/tree/96608e078b2d5ea607c5c3b8b5a54d1c1fba6846/benchmarks/agentic).
Other paths are repo-relative. Source is authoritative over an older design.
Project-scoped and unscoped transcript searches were made for Ponytail, memory
benchmark and replay/corpus, followed by the original architect's final answer
at 2026-10-16 12:58:22 UTC. Its observational writing/delivery results establish
no causal quality gain. No private quotes or reconstructed historical rules
are carried into this protocol.

The existing exporter and its tests remain unchanged. Its fail-first historical
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

Use a staged ablation to keep the pilot bounded. The manifest defines these arms:

| Arm | Runtime pool / workflow | Comparison it supports |
| --- | --- | --- |
| S | Strong model M; one fresh session; may plan, test and self-review within the full cell budget | Managed single-agent control |
| F | M in every slot; fixed planner, implementer, independent reviewer, optional fixer and fresh final reviewer | S versus F: this workflow's same-model orchestration package |
| A | M in every slot; same graph and session ceiling as F; planner chooses specialist briefs from the same frozen library | A versus F: task-adaptive specialization with model strength fixed |
| HF | Fixed heterogeneous assignment: M planner/reviewers, H implementer/fixer | Fixed-team routing control |
| HA | Same pool and graph as HF; M planner chooses M or H for implementer/fixer before launch; reviewers remain M | HA versus HF: adaptive execution-model assignment |
| MR / MA | Identical F workflow and M; reset / accumulated memory respectively | Chronological learning and frozen transfer |
| P | Ordinary product role prompts and defaults, pinned once; same cell budget and five-session ceiling | End-to-end product-workflow bundle versus S repeat 1 |

The M/H pool comes from the read-only role catalogue observation
`roles-1-17275f57`: M = `codex/gpt-6.1-sol`, effort `high`; H =
`claude/claude-sonnet-5-5`, effort `high`. These catalogue labels were observed; provider version
stability remains unverified. The manifest records them as
proposed launch bindings. Verify subscription authentication, permitted model
and effort, account capacity and resolved model/CLI versions before sealing.
No role mapping, account preference or installation setting is changed.
P snapshots the full current mapping and prompts at launch; drift requires
resealing before the first paired block. No silent fallback to another model,
account mode, service tier or remote runtime is allowed.

F and A use the same generic role scaffolds, specialist library and tools;
only selection of specialist instructions varies. HF and HA use those same
prompts, handoff format, reviewers, fix policy and allowed pool. All planning
and routing calls count. Report prompt/scaffold differences as treatment
components; S versus F does not identify an abstract orchestration effect
independent of additional contexts or review. A versus F and HA versus HF
hold the maximum reviewer count fixed. No claim may attribute a P versus S
difference separately to models, role prompts or memory.

All arms receive the same task-visible specification, seeded repo and tool
permissions. Shell, project tests and local services are available equally.
Native subagents, helper CLI launches and nested pipelines are denied. The
controller materializes every allowed stage. Hidden acceptance is never a
worker test tool. Stronger models, longer contexts, more reviewers, changed
tools and extra memory are recorded explicitly; changing one creates a new arm.

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
Freeze package digests before model calls. The manifest's null package digests
forbid launch. Moving upstream content cannot fill them.

Memory has two disjoint sequence/family sets with two learn tasks and two
unseen transfer tasks each. They use separately authored template overlays
on the same upstream pin; family membership is reserved in the manifest.
No orchestration-pilot task is reused in memory evaluation.

| Sequence | Learn 1 / Learn 2 | Held-out near / held-out far |
| --- | --- | --- |
| Q1 | Tenant-scoped derived reads / an unrelated structured-input adapter | New aggregate-read family with an explicitly changed admin constraint / an asset-authorization family in a different subsystem |
| Q2 | Retry-safe service operations / an unrelated timestamp contract across clients | New retry family with an explicitly changed replay constraint / a transactional import family in a different subsystem |

Learn 2 supplies interference from a distinct topic. The near task changes a
constraint so blindly preserving the old rule can fail. The far task tests
transfer across subsystem and vocabulary. Domain experts label near/far before
launch and check that held-out tasks require no previous answer or identifier.
There are only two sequence clusters: their results establish measurement
feasibility. A population learning effect remains unmeasured. Future powered work needs more
independently authored families and repositories.

## 5. Exact pilot and stopping rule

There are **38 intended solver task-cells**, all enumerated in the manifest:

| Phase | Tasks / sequence | Arms | Repeats | Cells |
| --- | --- | --- | --- | --- |
| O | T-export, T-archive | S, F, A | 2 | 12 |
| R | Same two tasks, reset base and sessions | HF, HA | 2 | 8 |
| M | Q1, Q2; learn 1, learn 2, near, far | MR, MA | 1 sequence replicate | 16 |
| P | T-export, T-archive | P | 1 | 2 |

Run O, then R, then M, then P, sequentially. The explicit within-block order
rotates/reverses arms, and memory arm order alternates while task order stays
identical. P reuses the two S repeat-1 results as controls and adds two cells;
those controls are not independent new observations. Comparison denominators
are four cells per arm in O, four per arm in R, four held-out cells per arm in
M (two per sequence), and two per arm in P. M also has four acquisition cells
per arm; they remain in the campaign ledger and learning-cost total but are
excluded from the held-out quality contrast. Do not pool all 38 into a product
win rate or interpret learn-1 versus learn-2 differences as learning gains on
identical tasks. Five-stage team graphs
can use fewer stages only after a review passes. A failed review gets at most
one fix and one fresh re-review. S has one session and the same total budget. A model restart or extra
engine generation consumes another session slot; an exhausted slot budget
ends that cell. Automatic retry/resume must obey the same external bound.
There are at most 174 solver sessions, eight memory-curation sessions and
84 judging sessions (76 cell judgments plus eight calibration judgments):
**266 subscription sessions maximum**. Statistical units remain tasks and
sequence clusters. These
are session ceilings; actual model turns, retries and provider calls are
recorded separately. No unlisted warmup or model-based preflight is allowed.

A cell budget is **128,000 total charged token units**, all roles and memory
injection included, and 1,800 seconds of aggregate active stage time. A learn
cell reserves 8,000 of those units and 180 of those seconds for curation;
its solver receives 120,000 units and 1,620 seconds. Both MR and MA pay that
reservation. Admission has an additional 1,800-second cell queue deadline.
The active budget is summed over stages. These experimental ceilings require
external enforcement, which is a launch gate. They describe no provider context
limit or existing Delegatus token-budget parameter.

Charged units count each input/output token once. For an engine whose input
includes cached input, cached input is not added again; for an engine reporting
cache reads/writes separately, include those categories once. Reasoning tokens
already included in output are not added twice. The next implementation must
verify these mappings against actual subscription usage envelopes; normalized
`conversation_messages` explicitly omits usage. Preserve the original private
envelopes and parser version. A missing usage envelope is unknown, never zero.
Equal token budgets are a resource comparison; heterogeneous tokens can carry
different prices. Financial estimates and cash cost are separate results.

Judge sessions have ceilings of 12,000 units and 300 seconds each. Total pilot
ceilings are 4,864,000 solver/curation units plus 1,008,000 judge units =
5,872,000 units. There is no dollar quote: resolved-model rates and subscriptions'
marginal cash charges have not been verified. Accounting cannot silently count
an included subscription call as zero resource consumption.

Stop before the next cell if containment, usage capture, model identity or
oracle integrity fails. Mark every remaining row `not_run_after_stop`, with
quality zero in the intended-to-run table; do not launch replacement wins.
The controller may later register a new campaign containing reruns, preserving
the original. No open-ended tuning after seeing pilot scores. Model errors,
quota waits, timeouts, incomplete delivery and unresolved infrastructure all
remain in the denominator of 38. A stopped pilot can pass measurement checks
only for its observed surfaces and is reported incomplete.

## 6. Chronological memory and leakage control

Each arm/sequence starts with empty benchmark-owned memory and a separate
filesystem/config/project namespace. Every task, including learn tasks, starts
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
curator sees the completed prefix. Task repositories contain no harness,
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

Primary quality is the following pre-registered score at the shared resource
cap; report complete-acceptance rate beside it. Define behavioral B as a
macro-average of sealed requirement groups: core acceptance 0.35, edges 0.25,
security/privacy 0.25, cross-caller/regression 0.15. Each group averages its
requirements equally, regardless of assertion count. Seal exact requirement
membership and which failures are critical before launch.

Two blind independent judges score residual requirements using full relevant
code/context and trusted check evidence. Each uses 0..3 for completeness,
factual accuracy of the delivered evidence, and justified maintainability,
weighted 0.5/0.3/0.2. Normalize by three to get each judge
contribution to J.
For a disputed case defined below, use the lower rating for J in the primary
score and preserve both for its bounds. Otherwise average the two judges.
Then Q = 100 * (0.8 * B + 0.2 * J). A critical security/privacy/data-loss
failure, no delivery, a solver timeout or a budget overrun sets Q to zero. Also report
raw B, every group, critical failures and every rubric dimension so weights
cannot hide a regression. LOC, gzip size, prompt length and test quantity earn
no quality points. Cost per fully accepted task includes failures' resources;
with no accepted tasks report it undefined and show total resources.

J1 uses M and J2 uses H as clean verifier sessions under the same calibrated
rubric. Independent means new sessions, no solver/reviewer history and no
access to arm, routing, memory, cost or previous judge verdicts. Cross-provider
judging does not remove provider bias; show both ratings. Randomize artifact
labels and presentation order; replace arm markers with inert labels without
changing code semantics, and retain a reversible private mapping. Judge
incomplete diffs with full base context; if context must be chunked, use the
same frozen rule for every arm and record coverage. Uncovered evidence stays
unjudged and cannot receive a full mark.

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
intervention; it cannot change the frozen primary score after results are seen.

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
exclude no sunk learning cost from sequence totals. For a sequence the resource
ceiling is 4 * 128,000 units per arm. Record deterministic preparation CPU,
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

Publish the complete intended matrix with all statuses, per-task paired
results, Q/B/pass/time/resource/cost frontiers, dominated arms and concrete
losses. Plot observed resources against quality; a pilot with one budget is
not an identified response curve. The subsequent evaluation randomizes budgets
at 0.5B, B and 2B, preserves the same tool/pool controls and reports a curve
with interval bands. Synthetic fixtures or replayed transcripts validate the
harness only and never enter a model-performance table.

The O/R sampling unit is the task with repeats paired within task. For memory,
the independent unit is the sequence/family cluster; held-out tasks, turns,
tests and two judges are repeated measures. With two task clusters and two
sequence clusters the pilot reports raw paired differences and ranges only,
no meaningful leaderboard, population CI or significance claim. Report each
task's repeat values and disagreement limits. Checks add no independent samples.

For a powered evaluation, first estimate paired task/cluster variance from an
independent calibration batch. Choose a material effect delta of five Q points,
80% power and familywise 5% error across the four predeclared causal contrasts
(S/F, F/A, HF/HA, MA/MR), using a paired cluster simulation that preserves failure and
within-task correlation. Memory separately targets five held-out Q points per
sequence with clustered paired analysis. Plan at least 30 independent task
clusters and 20 independently authored sequence clusters as a recruitment
floor; increase that count if simulation needs it. These floors do not promise
power. Freeze sample size and analysis before the confirmatory run. Bootstrap
whole paired clusters, report 95% intervals and task-level repeat intervals,
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

For team cells the graph is planner -> implementer -> reviewer. The reviewer
has `next: null`, `onFail: {to: fix, maxRounds: 1, onExhausted: park}`;
fix has `next: reviewer`. This permits one fix/re-review before the next
failure parks. Verify that exact round behavior offline against the pinned
engine before launch; a park cannot silently turn into an extra fix. Read-only
planner/reviewer outputs, if needed, are declared explicitly. Implementer and
fixer own the neutral task checkout only. S uses one terminal builder stage.
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
      "prompt": "BOUND_TASK_VISIBLE_BRIEF", "next": null
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
| G2 memory | Reviewers/verifiers and gates are clean automatically. Builders normally receive live role selection; no per-arm frozen snapshot selector is public. Source switch is installation-wide (D5). Codex retains account developer instructions (D8) | All worker input channels inventoried and sealed; both arms' automatic/native/live recall off, only explicit benchmark pack injected; exact bytes/digests on every start/resume, plus denial of live lesson/curation writes. Never rename an implementer to a clean role merely to evade policy |
| G3 readers/oracles | Automatic-memory exclusion leaves explicit search tools available. A read-only role defaults to full sandbox; access controls settlement and leaves other reads available (D4/D8) | Negative canaries across shell and filesystem, git objects/history, global/project instructions, skills, MCP search/conversation/file/link/export/cache APIs, identifiers and inherited tools. Deny cross-arm data and future/hidden packages server-side or at an external boundary; record every allowed reader/store |
| G4 paid services | Role selection can use configured OpenAI/OpenRouter services. Supported API keys survive ambient filtering (D7) | No paid key or provider client reachable from benchmark runtime, including hidden selector/curation helpers; fixed local whole-pack retrieval for M; no live settings change to obtain this |
| G5 budgets and usage | Public stage schema exposes RAM cap and runtimes. It has no aggregate token, private env or usage-budget parameter. Normalized message reads omit usage | Reliable private usage source and parser; bounded controller interrupt/cleanup through MCP for its owned cells; aggregate cap across retries and controllers. Unknown usage/overrun makes the cell incomplete; no claim of exact equal caps without this proof |
| G6 runtime and visibility | Local and two named Cloud runtimes exist; no arbitrary isolated-container executor is promised by the public contract | Demonstrate the chosen isolation mechanism still creates visible MCP stages with the current seat src/taskIds and no cross-project escape. Cloud publication/fallback cannot be assumed equivalent to the internal local recipe |
| G7 fixture/scoring | Historical exporter separates oracle but launches no models; new neutral fixtures and rubric golds do not yet exist | Correct reference green, unchanged/partial/unsafe references red; locked dependencies, disposable DB, oracle boundary and blind judge payload audit; package/runtime binding digests sealed before launch |

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

Author the ten neutral task packages (two O/R/P tasks and eight M tasks) and
four judge gold artifacts outside solver-visible repositories. Freeze public
briefs and private checks/reference patches separately. Make evaluator packages
readable only by their owner; output directories carry their own ignore rule
when provisioned. No fixture answer, memory rule text or model transcript is
committed. Publish only neutral protocol/manifests and later aggregate,
privacy-checked results. Raw evidence stays private through the authorized
artifact mechanism; do not hand out an unverified private-path link.

Implementation acceptance is concrete:

1. Manifest validation proves the 12/8/16/2 counts, unique rows, exact sequence,
   arm pairing, dependency references, the two identical frozen evaluation
   digests per accumulating sequence and the intended failure denominator.
2. Non-model tests exercise every gate red path, unknown usage, timeout,
   truncated context, duplicate/unknown MCP delivery, model fallback, judge
   calibration rejection and partial/unsafe oracle controls. Replayed/synthetic
   data is marked harness-only. None is counted as a model run.
3. A private launch-binding file records current src/taskIds, approved
   subscription profile references, effective runtime versions and hashes,
   task/oracle/dependency seals, containment/usage evidence and the immutable
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
  multiple curators, more repositories and changing repo evolution. They are
  justified only after the chronological boundaries work. For evolving repos,
  both arms must receive identical evolving commits and the same sequence.
- More repeats and budget levels before measuring saturation and variance.
  Confirmatory recruitment and budget curves follow section 8, with new
  pre-registration and honest total subscription-resource accounting.

## 13. Validation against the originating requirement

The protocol tests same-model orchestration (O), task/model selection (R),
completeness and regressions (sealed behavioral groups plus blind judges), and
learning through chronological acquisition and frozen unseen transfer (M).
P reports a bounded ordinary-workflow bundle separately. All phases can lose.
The neutral manifest fixes exact cells, budgets, sequence and failure treatment.
The source inventory identifies capabilities already present and launch gaps
still owed. The broader requested run is explicitly deferred to the same task's
implementation/verification/launch stages; this document contains no fabricated
model result, price, provider ceiling or claim that isolation already works.
