# RRSI lessons: what Delegatus can take to improve its own harness without overfitting

## Originating requirement

Pipeline pinned specification, 2026-09-24. The operator's own message was not
available to this stage, so this is the spec the seat wrote from it. The local
path is shortened to `$HOME`:

> The operator sent a paper and asks what Delegatus can take from it to get the
> same effect for its own harness: "$HOME/Downloads/Telegram Desktop/2609.24972v1.pdf"
> (arXiv 2609.24972v1, "RRSI: Regularized Recursive Self-Improvement of Agent
> Harnesses", Google Cloud AI Research, 2026-09-21).

The spec asks for four things: the paper in plain words; a mapping to our
harness and our data; ranked proposals, each with where, how to measure without
overfitting, cost and risk, plus a first step that proves or disproves value
within a week; and what not to take. No product code is edited in this lane.
The default answer to "should we build this" is no. A proposal below exists
only where the paper names a failure our harness process has, and where our own
data shows that failure.

Current main when this was written: `f18a95a01` (2026-09-24), 0 commits behind
`origin/main`.

## Source and prior work

- **The paper.** I read all 24 pages from the operator's PDF, with
  `pdftotext -layout` for the text and the PDF page renders for Figures 1, 3 and 4,
  whose labels do not survive text extraction. Every quote and number below
  comes from that read. The PDF is not committed.
- **Prior work.** `search_transcripts` found no earlier discussion of harness
  self-improvement or overfitting for Delegatus. The queries were "harness
  self-improvement", "overfitting", "prompt regression eval", "mandate bloat
  prune rules" and "eval set of past pipelines replay prompt change". It found
  three related pieces of work:
  1. **The role prompt pilot harness (#1918, merged 2026-09-20).** It is on main
     as `evals/roles/` plus `scripts/role-eval.ts`. It has sealed hidden and
     holdout graders, three fixture families with correct, defective and
     seeded-bug controls, and a run ledger. Its `pilot-status.json` records
     `"realCandidateTrials": 0` of 9 required. The README puts the baseline at 32
     visible worker requests with "a ceiling of 50", under a project cap of three
     workers. That is the only built evaluation of our harness, and four days
     after merge it has never run.
  2. **An anti-spam prompt review in another repository on this machine
     (2026-08-31).** An architect stage rejected a prompt change that pasted
     five verbatim evaluation messages into the production prompt as override
     exemplars. The same review showed that single evaluation runs flipped
     verdicts on identical input 11 seconds apart. That is RRSI's
     "benchmark-specific fitting" and "noise chasing" happening in a hand-run
     prompt loop the operator already ran. Rule (1) of the review frame
     (verbatim requirement) caught it. No harness mechanism did.
  3. `docs/design/opus-55-prompting-review.md` (2026-09-24) and
     `docs/audits/orchestrator-context-and-latency.md` (2026-09-22). These are
     the latest hand-made harness changes and the only measurement of harness
     cost (seat context bytes, 2.53 bytes per token).

## 1. The paper in plain words

### What "harness" means there

"The harness is everything around the weights": the system and task prompts,
"the control flow that decides when the agent plans, acts, reflects or stops",
tool interfaces and their descriptions, "the memory and skill files the agent
may consult", and context management (p. 3). The model is frozen, and a task
verifier scores the deliverable. The paper's component vocabulary is `prompt,
control_flow, config, output_plumbing, context_mgmt, client_tool, skill,
memory, subagent` (App. C.2, eq. 12).

### What the recursive loop proposes and selects

Each round, the current harness runs on a fixed **evolve set**. An analyst model
summarizes the trajectories into feedback, and a proposer model drafts
candidate harnesses as source edits. The candidates run on the *same* evolve
set, and the best score becomes the next harness (eq. 2). Proposer, analyst and
critic are all the same frontier model as the frozen policy (p. 7). The paper
calls this reuse "adaptive": later candidates depend on measurements from the
same tasks, so "evolve-set performance may improve without corresponding gains
on unseen tasks" (p. 1).

It names three ways this overfits (p. 2): the search "may encode
benchmark-specific patterns, promote candidates favored by the evaluation
noise, or accumulate complexity that improves evolve-set scores without
improving the underlying agent mechanism".

### What "regularized" adds

RRSI keeps the edit space open, so any component may change. It constrains how
the search moves through that space, on two sides.

Proposal side (§3.2):

- **Annealed edit budget (the L0 analogy).** A cap on "independently
  attributable edits" per candidate. It starts at 3–4 and cosine-anneals to 1
  (eq. 4, Table 5). Early rounds may bundle, and late rounds make single,
  attributable edits.
- **Evidence-aware credit.** Every evaluated edit is recorded with "the
  component it modifies, the hypothesis it tests, the source diff, the
  resulting score and cost changes, and whether the candidate was accepted",
  and the proposer reads that history. "Rejected mechanisms remain negative
  evidence" (p. 5).
- **Structured exploration.** When progress stays inside the noise band for
  `w = 3` rounds, one proposal slot goes to components never yet edited.

Selection side (§3.3):

- **Leakage screening.** Before any evaluation, a critic reads each diff and
  rejects edits that "explicitly encode task names, entity names, task-specific
  values, answers, or other logic specific to the evolve benchmark", and edits
  that "add inert machinery". It screens *before* scoring, so a leaking
  candidate "never receives the inflated evolve-set score" (p. 5).
- **Noise floor.** The unchanged base harness is run repeatedly first, to
  measure a noise band δ. A candidate must score at least `S★ − δ`, where `S★`
  is the best score so far (eq. 5). A gain counts only when it exceeds δ.
- **Cost-aware acceptance (the Ridge analogy).** A gain above δ may cost more
  tokens only in proportion: `ΔC ≤ β0 + β1·ΔS` (eq. 7). Inside the noise band,
  a candidate can win only by lowering cost or adding a new structural
  component (eq. 17).
- **Pruning (the Lasso analogy).** A component with no strictly positive
  measured gain over the last 4–5 rounds is handed to the proposer as a
  deletion target: "a mechanism must continue to earn its place" (p. 6).

### How they measure in- and out-of-distribution

The harness evolves on one suite per domain: Terminal-Bench 2.1 for coding,
Harvey LAB for agentic workspace (120 evolve tasks, 40 "pristine" held-out
tasks) and EngDesign for engineering design (61 tasks, too few to hold any
out). It is then "run unchanged" on benchmarks that differ in task
description, tools and verifier: SWE-bench Verified, JobBench, GDPval,
APEX-Agents and Frontier-Eng. Baseline and candidate always run "in the same
window, with the same tool environment, the same judge and the same number of
trials" (App. A). All hyperparameters are fixed "without consulting held-out
or OOD benchmarks" (Table 5). Two deliberate choices guard the numbers:

- **Judge gaming.** The engineering domain is graded by deterministic
  simulators, which closes the "writing the way a judge rewards" route (p. 8).
- **Crash-to-look-better.** APEX-Agents counts missing rollouts as failures,
  so "a harness that crashes on hard worlds" cannot look better (App. A.6).

### Results

- Evolve-split gains: +6.0 (Terminal-Bench), +4.9 (EngDesign), +1.1 (Harvey
  LAB). Held-out gains: +1.8 on SWE-bench Verified, +2.3 on Harvey LAB
  held-out, +3.5 to +4.7 on the three OOD workspace benchmarks, and +4.3 Medal
  points on Frontier-Eng. "No held-out split regresses anywhere" (Fig. 3).
- The same loop under a second policy family (Gemini 3.5 Flash) gives +14.1 on the evolve split and +2.2
  OOD (Table 3). Moved unchanged to a smaller model that took no part in the
  search, the harness still adds 3.4 points (Table 4).
- Cost: 2.42 M policy tokens per trial, against 3.80 M for unregularized
  evolution and 1.56 M for the base harness. "No evolved harness is as cheap as
  H0", and "evolution does buy part of its gain with test-time compute; the
  budget decides how much" (p. 10).

### What failed

This part matters most for us:

- **Every prior method overfits.** Meta-Harness has the best evolve score (93.0)
  and adds 0.9 OOD. HarnessX lands on the base. AHE and TTHE end *below* the
  harness they started from, TTHE by 1.7 points (Table 1, Fig. 1a).
- **Unregularized evolution scores highest where it is scored** (92.8) and
  leaves OOD within a point of the base (40.3 against 39.7), at 2.4× the
  base's tokens (Table 2). Removing only the acceptance rules raises the evolve
  score and cuts OOD from 43.6 to 41.0. Removing only the proposal rules costs
  0.2 on evolve and 1.7 OOD.
- **RRSI itself trades evolve score for transfer.** It "posts the smallest
  evolve-set gain of any evolved harness" (p. 7).
- **Rejected candidates (Table 6).**
  - A verification reminder with +1.69 points at +26.1% cost fails the cost
    rule, while a similar one with +3.93 passes.
  - "Pins the original task instruction into the completion gate so that the
    policy re-checks the literal specification before submission" lost 2.81
    points despite −13.6% cost, and the floor rejected it. That is close to
    what our own pinned-spec and finish-line rules do. It is a single measured
    candidate on one benchmark, so it tells us only that such a rule is not free.
- **Limitations the paper states itself.** A finite evolve set, several
  hyperparameters, and "broader validation is needed" for other architectures
  and "longer-running self-improvement processes". It reports no variance
  across repeated evolution runs, and I found none in the appendix.

## 2. Mapping to Delegatus

### Components

| RRSI | Delegatus today | Where |
|---|---|---|
| Frozen policy π | Claude, Codex and Copilot models picked per role | `src/lib/roles/defaults.ts:50-150` |
| Prompt | Orchestrator mandate v23 (18,421 B body, 20,489 B delivered with directives and role table, measured with `orchestratorMandateForDelivery`); role scaffolds (reviewer 3,913 B, architect 3,444 B, builder 2,123 B); the stage contract | `src/lib/orchestrator/prompt.ts:78,283`, `src/lib/roles/defaults.ts:16-150`, `src/lib/pipelines/prompts.ts:83-91` |
| Control flow | Pipeline stage graph: run and review-loop stages, pass and fail edges, `maxRounds`, `continue-review` grants | `src/lib/pipelines/failEdgeBudget.ts:20-49`, `src/lib/pipelines/controller.ts` |
| Output plumbing | `stage_report` verdict, findings and summary; server-read provenance | `src/lib/pipelines/types.ts:128,253-283` |
| Context management | Seat rotation, handoff digest, context policy | `src/lib/orchestrator/handoffDigest.ts`, `contextPolicy.ts` |
| Tools | MCP tool schemas and server instructions | `src/lib/mcp/server.ts` |
| Memory and skills | Per-project auto-memory (178 files, `MEMORY.md` index 19,522 B loaded each session); the conveyor and orchestration skills (33,867 B) | `$HOME/.config/agent-log-viewer/accounts/claude/*/projects/*/memory/`, `.claude/skills/*/SKILL.md` |
| Subagent / critic | Reviewer, verifier and architect roles, and the design-critique stage | `src/lib/roles/defaults.ts:64-116` |
| **Verifier r(x,τ)** | Mostly an LLM judge (the reviewer verdict). Deterministic signals are CI, typecheck and the privacy gate. Lagging signals are merged-and-not-reverted and operator corrections | — |
| **Proposer** | The operator plus a seat, from one incident at a time: complaint → issue → lane → review → text edit | e.g. `docs/design/opus-55-prompting-review.md` |
| **Selector** | PR review plus operator approval. **No measured score, no noise floor, no cost rule** | — |
| **Edit history L_t** | Git history plus issue numbers in code comments above each rule (#1428, #1741, #1770, #1843 in `defaults.ts:10-38`). The hypothesis is recorded. **The measured outcome never is** | — |
| **Pruning** | None, apart from one "context diet" (#2030) | — |

The comparison runs in a different direction from the paper. RRSI's problem is
a search that measures too eagerly on one reused set. Ours is a loop that never
measures at all. Every edit's evolve set is **one incident** (n = 1), and it
enters permanent state on a reviewer's reading. Three of RRSI's failure modes
already show in our history:

- **Complexity accumulation.** `prompt.ts` grew from 2,607 B (2026-07-14) to
  42,593 B (2026-09-24) over 23 mandate versions. Git counts +806 and −334
  lines on that file, and +208 and −58 on `defaults.ts`. The only deliberate
  shrink was #2030. `MEMORY.md` lists "No full review after a rebase" twice
  (index lines 136 and 143).
- **Benchmark-specific text in shared components.** The reviewer scaffold that
  every project receives says "Run TypeScript checks with bunx tsc --noEmit
  --incremental false" (`defaults.ts:74`), a Delegatus toolchain command. 188
  of the 1,663 recorded pipelines ran in other repositories. The frontend
  builder guidance requires "English/Ukrainian parity" in every project
  (`src/lib/roles/registry.ts:79`). The mandate opens with "(issues #182,
  #691)" (`prompt.ts:283`).
- **Noise treated as signal.** See the verdict-flip numbers below.

### Data we already have

These counts are from a read-only copy of the live `state.sqlite`, taken
2026-09-24 (`pipelines` plus `pipelines_archive` rows). They cover all
projects, 2026-07-12 → 2026-09-24:

| Asset | Size | What it can serve as |
|---|---|---|
| Pipelines | 1,663 (1,475 in this repository, 188 in other repositories); 1,434 carry a pinned spec | Tasks. The other repositories are the natural **out-of-distribution** split, since their language, tools and review culture differ |
| Stage attempts | 4,143: pass 2,177, fail 824, needs_decision 123, no verdict 1,019 | Outcomes per attempt. "No verdict" means a cut or dead attempt, the RRSI "missing rollout", which must count as a failure |
| Findings | 2,641 (P0 31, P1 512, P2 399, P3 238, unranked 1,461); 72 carry WRONG-PREMISE and 117 OVER-BUILT | A labelled defect corpus. It says what reviewers catch, and which frame rules fire |
| Review rounds | 621 pipelines have a fail edge: 302 never looped, median 1 round, p90 3, max 7; 596 fail-edge traversals | Rounds-to-pass per harness version |
| **Harness version per attempt** | Each attempt stores its rendered `effectiveRole.promptScaffold` (`types.ts:340`). Distinct rendered texts: reviewer 38, builder 22, architect 10. Rendered parameters such as the lens are part of the text, so parameter variants count separately | The edit history RRSI has to build by hand. We already have it for scaffolds. We lack it for the mandate per stage, and for memory |
| Reviewed-head provenance | 343 reviewer verdicts carry the head they judged (`report.provenance.head`) | Repeated judgments of the same bytes, which give a noise estimate |
| Transcripts | 9,253 conversations, 286,015 indexed messages | Operator corrections, and token cost per attempt (the audit's method) |
| Memory | 178 files: 68 `feedback`, 91 `project` | Each feedback entry is one operator correction with its **Why:** line, a labelled failure the harness once had |
| Git | 33 commits on `prompt.ts`, 20 on `defaults.ts`; 6 reverts on main | Edit history. Too few reverts to use as a signal |
| Role eval harness | 3 fixtures with controls, sealed holdouts; 0 real trials | The only deterministic grader we own |

Two findings from this data shape every proposal below.

**(a) Our verdicts are noisy, and we have never measured how noisy.** 14 heads
were judged more than once by a reviewer, and **9 of the 14 got different
verdicts on the same bytes**. Seven of those nine are the same review stage
judging an unchanged head in a later round, where the reviewer also saw the
fixer's reply. That is weak evidence (n = 14, confounded), and it points the
same way as the anti-spam case in Prior work. RRSI's first step, measuring δ on
the unchanged harness, has no counterpart here.

**(b) Observational credit assignment misleads.** The only text change
between two reviewer scaffold versions was the #1428 sentence ("Before
deciding … run a few search_transcripts queries …"). Under the old text,
reviewers failed 396 of 594 attempts (67%). Under the new one they failed 105
of 302 (35%). The model mix changed at the same time, though: the old version
ran 501 attempts on a Codex model the new one barely used. Within one model the
drop is smaller: Opus fell from 22/39 to 25/87, Fable from 19/50 to 12/49. It
still says nothing about whether the sentence helped, because a lower reviewer
fail rate can mean better builds or laxer reviewers. **A reviewer pass rate is
a judge score the harness itself can move.** Any metric we adopt needs a
downstream check the harness cannot write: a deterministic test, a CI result,
a later revert or fix, or an operator correction.

## 3. Ranked proposals

Every proposal edits how harness changes are *accepted and retired*. None adds
an automatic proposer. The ranking is by value per unit of cost, and each later
proposal leans on the first.

### 1. A harness ledger built offline from the data we have (the one-week step)

- **What.** A read-only script, `scripts/harness-ledger.ts`. It takes the path
  of a **copy** of `state.sqlite` and never resolves the live state directory
  (AGENTS.md, "Only a declared owner…"). It also reads `git log`. It writes one
  row per stage attempt:
  - role, the hash of the rendered scaffold, and model and effort;
  - project, split into this repository or other, and ISO week;
  - verdict, with a missing verdict counted as a failure;
  - findings by severity, and the WRONG-PREMISE and OVER-BUILT markers;
  - the pipeline's fail-edge rounds, using the same count as `edgeRoundsUsed`,
    `failEdgeBudget.ts:20`;
  - tokens, where the transcript is still on disk.

  It then writes one table per harness version: rates with bootstrap intervals,
  stratified by model and by project split. RRSI's "component, hypothesis"
  pair comes from the commit that introduced each scaffold text. The commit and
  its issue number are the hypothesis.
- **Where.** A new script under `scripts/`, which is not product code. It reads
  `PipelineStageAttempt` fields at `src/lib/pipelines/types.ts:128`, `:253-283`
  and `:340`.
- **How to measure without overfitting.** The ledger's own first output is the
  **noise band**: week-to-week variance of each rate under one unchanged
  scaffold and model, the equivalent of RRSI's repeated base-harness runs.
  - **Held-out.** Other repositories are the OOD split. Their counts are small,
    so the doc reports n beside every rate.
  - **No gate.** The ledger never accepts or rejects anything by itself, so it
    cannot be fitted to.
- **The one-week experiment, decision rule fixed in advance.** Replay three
  scaffold changes already on record:
  - the #1428 search sentence on the reviewer;
  - the builder change of 2026-09-19;
  - the architect change of 2026-09-19.

  The outcome is **not** the reviewer's own verdict. It is rounds-to-pass of
  the whole pipeline, plus the no-verdict rate, plus the WRONG-PREMISE rate.
  - **Value proven:** at least one change shows a stratified effect larger than
    the measured δ, in the same direction in this repository and in the others.
  - **Value disproved:** every interval straddles zero, or δ exceeds 10 points.
    Then observational measurement of prompt text cannot guide us. Proposals 2,
    3 and 4 still stand, because none of them needs a score. Proposal 5 becomes
    the only route to a score.
- **Cost.** About one builder day. No model calls, and no live-state reads
  beyond one file copy.
- **Risk.** Confounders: task mix, model changes, the operator's workload per
  week. Stratification narrows them and does not remove them. The ledger has to
  be read as a way to find candidates, and nobody should cite it as proof that
  a rule works.

### 2. A leakage screen for agent-facing harness text

- **What.** A deterministic test over every text shipped to agents in *all*
  projects: role scaffolds, the frontend guidance, the stage contract and the
  default mandate body. It fails on:
  - issue numbers (`#\d{3,}`);
  - repository paths (`src/…`);
  - one repository's toolchain commands (`bunx tsc`, `bun test`);
  - human-language requirements.

  An allowlist covers product nouns (`Delegatus`, `stage_report`, the MCP
  tool names). This is RRSI's critic, run before anything reaches a seat,
  implemented as a test because the rule is mechanical.
- **Where.** `src/lib/roles/registry.test.ts` for the scaffolds and
  `roleScaffoldBody`, and `src/lib/orchestrator/prompt.test.ts` beside the
  fingerprint pins (`:99-116`) for the mandate. The first run fails on three
  existing leaks, which the same PR moves:
  - the reviewer's `bunx tsc …` line (`defaults.ts:74`) goes to this
    repository's `AGENTS.md`, which reviewers here already read;
  - "English/Ukrainian parity" (`registry.ts:79`) goes to `AGENTS.md`;
  - "(issues #182, #691)" is removed from `prompt.ts:283`, which is a mandate
    edit and needs the v24 bump.
- **How to measure.** The leak check is binary. For its effect, the ledger
  compares reviewer findings in the other repositories before and after the
  change: sandbox or typecheck notes on non-TypeScript repositories should drop
  to zero. Project-specific text that matters moves to the project's own
  `AGENTS.md` or memory, where it is supposed to live. That is how we avoid
  memorising our own backlog into the shared harness.
- **Cost.** One small PR, including the mandate version bump.
- **Risk.** False positives on legitimate product nouns, which the allowlist
  handles. The comments above each rule keep their issue numbers, since agents
  never see comments.

### 3. A byte budget whose increases must name their gain

- **What.** RRSI's cost rule, reduced to what we can enforce. `prompt.test.ts`
  pins the delivered mandate size (today 20,489 B) and `registry.test.ts` pins
  each role scaffold's size, each as a number in the test. A PR that raises a
  number names, in its body, the ledger row or incident that pays for the bytes.
  The same PR records the bytes against its hypothesis in the ledger.
- **Where.** Beside the existing fingerprint test (`prompt.test.ts:103-116`)
  and next to `MAX_SCAFFOLD_LENGTH` (`src/lib/roles/store.ts:27`). The 12,000 B
  cap stays as the hard ceiling for operator overrides.
- **How to measure.** Delivered bytes per version, and the seat-context
  numbers from the audit's method. The rule stops unexamined growth. It does not
  decide which growth is good, because we cannot measure gain precisely enough
  to use RRSI's `ΔC ≤ β0 + β1·ΔS`.
- **Cost.** Two assertions.
- **Risk.** The fingerprint test showed that a pinned number can become a
  ritual bump. The mitigation is the reviewer reading the named justification,
  which is the same control the fingerprint relies on. If the ledger (1) shows
  no measurable effects, this rule still caps growth, which is its main job.

### 4. A pruning pass, where a deletion is judged like an addition

- **What.** Once a month, one architect lane builds an inventory of every
  agent-facing rule: each scaffold sentence, mandate paragraph and skill rule,
  with the incident its comment cites. It then marks deletion candidates, rules
  whose incident class has not recurred for eight weeks. Recurrence is checked
  with `search_transcripts`, finding markers and the ledger. The lane proposes
  deletions as single edits.

  The operator's memory gets the same pass: duplicate index lines (the
  "No full review after a rebase" pair), and `project` entries whose fact is
  now on main or out of date. 91 of 178 files are `project` type, and the
  `memory-discipline` skill already says to save only what will still be true
  in a month.
- **Where.** No product code. A standing seat mission or a monthly task, with
  the ledger (1) as input.
- **Exempt from pruning.** Rules that guard irreversible damage: process
  cleanup (#1770), state-directory ownership (#1905), the privacy rules, and
  deploy approval. For these, the incident's absence is evidence the rule
  works. RRSI's pruning window assumes every component can be re-measured
  cheaply, and ours cannot.
- **How to measure.** Each deletion ships alone. The ledger compares rates
  before and after on this repository and the others, against δ. A rise beyond
  δ restores the rule.
- **Cost.** One architect lane a month, plus small PRs.
- **Risk.** Removing a rule whose incident is rare but costly. The exemption
  list covers the ones known today.

### 5. Measure the verdict noise band before trusting any score

- **What.** Run the reviewer role k = 3 times, fresh each time, on 10 heads
  that are already merged. Five come from this repository and five from others.
  That is 30 reviewer runs, as visible stages created by the seat. The spread of
  their verdicts is δ for reviewer-judged outcomes.
- **Where.** No code. Pipelines created by the seat, results recorded with the
  ledger.
- **How to measure.** δ is the measurement. If δ is large, reviewer-judged
  comparisons need k ≥ 2 and wide intervals. The existing role eval harness
  (#1918), with sealed holdouts and deterministic graders, then becomes the
  only honest scorer for harness text. In RRSI terms it is a small held-out
  set, and the paper supports running it.
- **Cost.** 30 reviewer runs at the reviewer role's current runtime, run one at
  a time under the project cap.
- **Risk.** Spending worker time with no action to follow. So this runs only if
  the ledger (1) shows effects worth confirming, or if the operator wants a
  score for a specific change.

### 6. One hypothesis per harness edit, tagged for credit

- **What.** A harness PR may bundle edits, as the Opus 5.5 review did with nine
  proposals. Each atomic edit gets a `Harness-Edit: <component>: <hypothesis>`
  trailer, and the ledger splits credit by those trailers. The paper's lesson
  is attribution. We keep the operator's freedom to bundle, and only the
  labels become mandatory.
- **Where.** The `delegatus-conveyor` skill's PR rules, as one line.
- **Cost and risk.** Negligible cost. The risk is ceremony, so it is ranked
  last and should ship only if the ledger proves useful.

## 4. What not to take, and why

- **An automatic proposer and selector loop over our harness.** RRSI runs 20
  rounds of k = 2 trials on 120 tasks per candidate, at 2.42 M policy tokens
  per trial. We have no deterministic verifier for most of our tasks. Our judge
  flips on identical bytes (§2a). The project runs at most three workers. And
  the one evaluation harness we built has run zero trials in four days. An
  automatic loop here would be pure noise chasing. Harness text reaches seats
  through a versioned, operator-approved mandate, and that stays.
- **The reviewer pass rate as the score.** It is a judge output the harness
  controls, the judge-gaming route the paper closed with deterministic grading
  (p. 8). Outcomes must include signals the harness cannot write.
- **The novelty bonus for new structural components (eq. 17, `w_n·ν`).** It
  rewards adding machinery. Our failure is accumulation, and we need pressure
  the other way.
- **RRSI's hyperparameters** (β1 = 44.5, δ = 0.017, window lengths). They were
  calibrated on the paper's benchmarks and trial counts, and our sample sizes
  cannot calibrate their equivalents.
- **Structured exploration of untouched components.** In a manual loop the
  operator already chooses where to look. A directive to spend effort on
  components nobody has complained about would add lanes without an incident.
- **The paper's effect sizes as a forecast.** +1 to +5 points on 40–480-task
  benchmarks is below any noise band we can currently measure.
- **Pinning the literal specification into the completion gate, justified by
  this paper.** The paper saw it lose once (Table 6, R8-B), and our pinned-spec
  rule rests on our own incidents. One candidate on another benchmark is no
  reason to remove it. It is a candidate for the pruning pass (4), where our own
  data would decide.

## Deferred — not currently justified

- **Running the role eval pilot as designed** (32–50 worker requests). Revisit
  if the ledger (1) finds an effect worth confirming. A smaller pilot (one
  fixture, two arms, k = 2) would fit RRSI's held-out role at a quarter of the
  cost.
- **Storing token cost on each stage attempt in the product.** The ledger can
  derive it from transcripts, and that is enough until a rule needs it live.
- **A `harness-leakage` reviewer lens.** Proposal 2's test covers the
  mechanical cases. Add the lens only if leaks turn up that a test cannot
  express.
- **Per-stage mandate versioning.** Seats record their mandate version and
  stage attempts do not. Add it only if the ledger needs mandate credit and
  cannot get it from the seat's version history.
- **Using operator corrections in transcripts as a labelled outcome.** They
  are the best signal we have. They are also free text in two languages, and
  labelling them is its own project. The memory `feedback` entries are the
  curated subset and serve for now.

## Validation against the requirement

The operator asked what Delegatus can take from RRSI to get the same effect,
a harness that improves itself without overfitting. In the paper, the transfer comes
from its regularizers: Table 2 shows that removing them raises the evolve score and lowers OOD. Our harness already has a
proposer (the operator and the seat), and our data shows the three failures
those rules exist to stop:

- growth nobody measured (2.6 KB to 42.6 KB);
- one repository's specifics in shared text (the reviewer's `bunx tsc` line);
- verdicts that flip on unchanged bytes (9 of 14 repeated heads).

The proposals add the paper's regularizers where they are cheap:

- the edit history and noise band (1, 5);
- the leakage critic (2);
- the cost rule (3);
- pruning (4);
- attributable edits (6).

The held-out split is the other repositories' pipelines. The guard against
memorising our own backlog is proposal 2 plus the rule that project-specific
text lives in the project's own `AGENTS.md` and memory. The one-week step is
proposal 1's replay. It needs no model calls, and its decision rule is fixed
above. The proposals deliberately leave out the automatic loop, whose cost and
judge noise we cannot afford today.
