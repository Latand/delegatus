# Harness ledger results, 2026-09: replaying three recorded prompt changes

This is the first step of `docs/design/rrsi-lessons.md` §3.1, proposal 1: a
harness ledger built offline from the data we already have. The pipeline's
pinned specification asked for four things: the read-only ledger script, the
noise band as its first output, the one-week experiment on three recorded
scaffold changes judged by the rule that doc fixed in advance, and this report.

## Summary

- **Verdict by the doc's rule: neither "value proven" nor "value disproved".**
  In practice that means value not proven. Nothing moved by more than δ in both
  splits, so the proof condition fails. Two intervals exclude zero, and the
  WRONG-PREMISE δ is inside 10 points for every role, so the disproval
  condition fails too. The doc left this case open. The committed rule reports
  it as its own outcome, and I did not pick a side after seeing the numbers.
- **The noise band is wide where it matters most.** Week to week, under an
  unchanged scaffold and model, the no-verdict rate moves by 12.8 points
  (reviewer), 14.9 (builder) and 18.8 (architect). All three are above the
  doc's 10-point cap, so the no-verdict rate cannot decide anything. The
  WRONG-PREMISE rate is steadier (δ 4.1 to 5.8 points), but only 2.3 % of finished
  pipelines (37 of 1,634) carry the marker at all, so any real effect is far
  smaller than δ. Rounds-to-pass has δ of
  0.22 rounds (reviewer) and 0.31 (builder). The architect had no cell with two
  qualifying weeks.
- **The one effect beyond δ.** After the 2026-09-19 builder change, pipelines
  in this repository took **+0.80 more fail-edge rounds to pass** (95 %
  interval +0.39 to +1.26, n 53 → 43, δ 0.31). The architect change shows +1.86
  on n 9 → 7, and its δ is unmeasured. Both results come from this repository
  only. Neither can be compared with the other repositories, because no
  pipeline there both passed and had a fail edge in either arm. Three pipeline
  changes that count more rounds landed over the same days (see Confounders),
  so the rise is not credited to the prompt text.
- **The #1428 search sentence** moved nothing beyond δ on any of the three
  outcomes. The earlier observation that reviewer fail rates fell from 67 % to
  35 % was a reviewer-verdict rate, and the doc ruled that out as an outcome.

What the doc says follows from here: observational measurement of prompt text
did not guide us on these three changes. Proposals 2, 3 and 4 need no score and
still stand. Proposal 5, repeated fresh reviews of fixed heads, is the route to
a noise band tight enough to score a prompt change, and so is the role eval
harness (#1918) with its deterministic graders.

## How it was produced

```
sqlite3 -readonly <live state.sqlite> ".backup <scratch>/state.sqlite"
bun scripts/harness-ledger.ts --db <scratch>/state.sqlite --out <scratch>/out
```

- The input was one read-only copy of the state database, taken 2026-09-25,
  plus `git log`. For tokens, the script read each attempt's transcript file
  when it was still on disk. It made no model calls. The script refuses any
  path inside an `agent-log-viewer/state` directory, and it never resolves a
  state directory by itself.
- **Pre-registration.** Commit `a56f28fb7` fixed the decision rule, the three
  version pairs, the outcome definitions, δ's definition and the bootstrap seed
  before the script had run on real data. The research stage that wrote the
  doc had already seen per-version reviewer fail counts. Those are
  reviewer-verdict rates, and none of the outcomes below uses them.
- **One correction after the first run, disclosed here.** The first run read
  "the pipeline passed" as `state === "completed"`. Since mid-September a lane
  is closed after its merge, so a passed lane reads `closed`. The after-arms
  for rounds-to-pass were nearly empty as a result: reviewer 2 pipelines,
  builder 0, architect 0. Commit `9b3b847cc` counts a pipeline as passed when
  it completed or when every final stage's last attempt passed. That fixes how
  "passed" is read and leaves the rule untouched. Both runs are below. The
  first gave "value disproved": with no after-arm, every rounds interval
  straddled zero or was missing. The corrected run gives "neither condition
  holds". Only the rounds-to-pass rows differ between the two runs.

## Definitions

**Rows.** One row per settled stage attempt, meaning its state is passed,
failed or needs_decision. In-flight, skipped and lineage-adopted (historical)
attempts are left out. Each row carries:

- role, and the hash of the rendered scaffold (sha256, first 12 hex);
- engine/model and effort;
- the project split: this repository, or any other;
- the ISO week;
- the verdict, where a settled attempt with none reads `none`;
- findings by severity, and the WRONG-PREMISE and OVER-BUILT marker counts;
- the pipeline's fail-edge rounds, summed over its fail edges with
  `failEdgeRoundsUsed`, the engine's own count;
- tokens: for Claude, input, cache writes, cache reads and output, once per
  message; for Codex, the last cumulative count. Tokens are empty when the
  transcript is gone.

"This repository" means every project key carried by a pipeline whose checkout
is this repository's main checkout, a checkout nested under it, or a sibling
worktree path next to it. That covers the key changing over time.

**Harness version.** One (role, rendered scaffold hash) pair. Rendered
parameters, such as a reviewer's lens, are part of the text, so parameter
variants count as separate versions. Each version's table names the commit
that introduced it: the oldest commit whose diff carries a sentence the version
adds over the closest earlier version of the same role.

**The three changes.** Each pair is the rendered scaffold in force immediately
before and immediately after the change. The two texts differ only by the
named sentences, which was checked by a sentence diff.

| change | before | after | the after text adds |
|---|---|---|---|
| #1428 search sentence (reviewer) | `6203210e5e2f` (2026-08-23 → 09-02) | `f2b931775daf` (09-02 → 09-18) | the prior-conversation search sentence |
| 2026-09-19 builder change | `b36fadf4d3f7` (09-02 → 09-19) | `c64f933672dc` (09-19 → 09-21) | the #1770 process-cleanup rule and the #1843 human-in-the-loop paragraph |
| 2026-09-19 architect change | `bdeecbae2d0b` (09-18 → 09-19) | `6d25f06c4803` (09-19 → 09-23) | the same two rules |

Two commits changed each scaffold on 2026-09-19, a few hours apart, so "the
change of 2026-09-19" means the version in force when the day began against the
version in force when it ended. The intermediate version, which carried only
#1770, belongs to neither arm (builder n 29, architect n 8).

**Outcomes.** None of them is the reviewer's own verdict. Each pipeline is
attributed to the version and model of the changed role's first attempt in it.

- Rounds-to-pass: over pipelines that passed and have a fail edge, the
  fail-edge rounds they used.
- No-verdict rate: the share of the changed role's settled attempts that carry
  no verdict, clustered by pipeline.
- WRONG-PREMISE rate: over finished pipelines (completed or closed), the share
  where any finding from any stage carries the marker.

**Noise band δ.** The ingredients:

- A cell is one role, version, model and project split.
- Inside each cell, take the per-week value of the outcome over every ISO week
  with at least 5 observations.
- δ is the standard deviation of those weekly values around the cell mean,
  pooled over every cell that has two or more such weeks: Σ squared deviations
  divided by Σ (weeks − 1).
- Rates are in percentage points, rounds in rounds.

δ includes the binomial noise of small weeks. That is part of what a weekly
reading would see.

**Effect.** After minus before, computed separately in each project split:

- the effect is averaged over the model strata that ran in both arms, with
  weight nB·nA/(nB+nA);
- a stratum that ran in one arm only is dropped;
- the 95 % interval is a percentile cluster bootstrap: 2,000 draws, pipelines
  resampled within arm and stratum, fixed seed.

**The rule, as the doc states it and as it was coded before any run.**

- *Value disproved*: every effect interval includes zero, or δ exceeds 10
  points. Coded as δ above 10 points (or unmeasured) on every rate outcome of
  every changed role. Disproval is checked first, because the doc's default
  answer is no.
- *Value proven*: some change, on an outcome whose δ is measured (and, for a
  rate, at most 10 points), moves by more than δ in this repository and in the
  others, in the same direction.
- Otherwise neither condition holds, and the report says so.

## Confounders

Stratifying by model and project split narrows these, but it does not remove
them:

- **The round count itself changed over the builder and architect after-arm.**
  - #1785 (2026-09-19, 04:30) routes a needs_decision that carries findings
    along the fail edge, which spends a round. Before it, such a verdict parked
    the lane.
  - #1868 (2026-09-20) counts the handoff past a spent budget as a traversal.
  - #1938 (2026-09-22) lets `continue-review` grant more rounds.

  All three raise rounds-to-pass without any prompt text changing. That makes
  the +0.80 builder effect unattributable. It is also why a proof from this
  repository alone would not have been credible.
- **The other repositories are too thin to replicate anything.** Only 12 of
  their 194 pipelines have a fail edge at all, and 3 of those passed. None of
  the 3 falls in an arm. After stratification the other-repository arms of the
  rate outcomes hold 1 to 8 observations on one side (reviewer no-verdict
  4 → 1, builder 60 → 8), and the architect arms share no model. The doc's
  "same direction in the others" is unreachable for rounds-to-pass as things
  stand.
- **Model and effort mix.** Every arm ran several engines and models. The
  #1428 before-arm is 85 % one Codex model. Effort is recorded but not
  stratified, because stratifying by it would leave most strata with a single
  arm.
- **Task mix and workload per week.** The arms are consecutive calendar
  periods, so the kind of work, the operator's load and the rest of the harness
  (the mandate, memory, tools) all differ between them.
- **The markers are reviewer text.** WRONG-PREMISE is written by a reviewer,
  and the #1428 change edits the reviewer. For that change the WRONG-PREMISE
  outcome is partly the judge's own output.
- **Operator overrides.** A version whose sentences are not found in git is an
  operator override or a rendered parameter. Such versions are counted as their
  own version, never merged into a shipped one.
- **Censoring.** Rounds-to-pass leaves out pipelines that never passed, and the
  no-verdict rate carries those failures instead.

## Generated output (corrected run)

The rest of this report is the script's output, verbatim. It holds aggregate
numbers only: counts, rates, hashes, commit ids and model names.

### Ledger

4185 settled stage attempts in 1637 pipelines (this repository 3874, other repositories 311); verdicts: pass 2345, fail 865, needs_decision 114, none 861. 3272 attempts have token counts from a transcript still on disk.

### Noise band

Pooled week-to-week standard deviation of each rate inside cells of an unchanged harness (role, scaffold version, model, project split). Weeks with fewer than 5 observations are left out; a cell counts when two or more weeks remain. Rates in percentage points.

#### Attempt verdict rates

| role | pass | fail | needs_decision | no verdict | cells | weeks | attempts |
|---|---|---|---|---|---|---|---|
| architect | 14.3 | 21.1 | 7.3 | 18.8 | 3 | 7 | 61 |
| builder | 15.1 | 0.8 | 4.2 | 14.9 | 12 | 41 | 1542 |
| custom | 21.5 | 3.6 | 0.0 | 24.3 | 2 | 4 | 38 |
| reviewer | 12.2 | 15.4 | 1.2 | 12.8 | 11 | 26 | 1326 |

#### The replay's outcomes, per changed role

| role | outcome | δ | cells | weeks | n |
|---|---|---|---|---|---|
| reviewer | rounds-to-pass (rounds) | 0.22 | 3 | 7 | 142 |
| reviewer | no-verdict rate (points) | 12.8 | 11 | 26 | 1326 |
| reviewer | WRONG-PREMISE rate (points) | 4.1 | 11 | 26 | 757 |
| builder | rounds-to-pass (rounds) | 0.31 | 5 | 12 | 183 |
| builder | no-verdict rate (points) | 14.9 | 12 | 41 | 1542 |
| builder | WRONG-PREMISE rate (points) | 4.5 | 10 | 34 | 844 |
| architect | rounds-to-pass (rounds) | unmeasured | 0 | 0 | 0 |
| architect | no-verdict rate (points) | 18.8 | 3 | 7 | 61 |
| architect | WRONG-PREMISE rate (points) | 5.8 | 3 | 6 | 46 |

### The pre-registered replay

Effect = after − before, averaged over the model strata present in both arms, with a 95 % cluster-bootstrap interval (pipelines resampled within arm and stratum). Rates in percentage points, rounds in rounds.

| change | outcome | δ | this repository | other repositories | > δ in both, same sign |
|---|---|---|---|---|---|
| #1428 search sentence (reviewer) | rounds-to-pass (rounds) | 0.22 | +0.07 [-0.21, +0.34] (n 116→22; 3 strata) | – (no shared model stratum) | no |
| #1428 search sentence (reviewer) | no-verdict rate (points) | 12.8 (unusable) | +5.0 [-5.4, +14.8] (n 589→140; 3 strata) | +0.0 [+0.0, +0.0] (n 4→1; 1 strata) | no |
| #1428 search sentence (reviewer) | WRONG-PREMISE rate (points) | 4.1 | -0.4 [-1.3, +1.2] (n 236→103; 3 strata) | +0.0 [+0.0, +0.0] (n 2→1; 1 strata) | no |
| 2026-09-19 builder change | rounds-to-pass (rounds) | 0.31 | +0.80 [+0.39, +1.26] (n 53→43; 2 strata) | – (no shared model stratum) | no |
| 2026-09-19 builder change | no-verdict rate (points) | 14.9 (unusable) | -3.0 [-10.9, +4.5] (n 328→150; 3 strata) | +0.4 [-18.0, +29.1] (n 60→8; 2 strata) | no |
| 2026-09-19 builder change | WRONG-PREMISE rate (points) | 4.5 | -0.4 [-1.1, +0.0] (n 236→78; 3 strata) | +0.0 [+0.0, +0.0] (n 57→8; 2 strata) | no |
| 2026-09-19 architect change | rounds-to-pass (rounds) | unmeasured | +1.86 [+0.55, +3.27] (n 9→7; 2 strata) | – (no shared model stratum) | no |
| 2026-09-19 architect change | no-verdict rate (points) | 18.8 (unusable) | -9.0 [-22.1, +4.3] (n 19→42; 2 strata) | – (no shared model stratum) | no |
| 2026-09-19 architect change | WRONG-PREMISE rate (points) | 5.8 | +0.0 [+0.0, +0.0] (n 12→17; 2 strata) | – (no shared model stratum) | no |

Arm sizes before stratification (observations; strata dropped when a model ran in one arm only):

- #1428 search sentence (reviewer) (`6203210e5e2f` → `f2b931775daf`, adds the #1428 prior-conversation search sentence): rounds-to-pass: this 116→34, other 0→0; no-verdict rate: this 589→255, other 4→47; WRONG-PREMISE rate: this 236→175, other 2→44.
- 2026-09-19 builder change (`b36fadf4d3f7` → `c64f933672dc`, adds the #1770 process-cleanup rule and the #1843 human-in-the-loop paragraph): rounds-to-pass: this 66→46, other 0→0; no-verdict rate: this 396→159, other 85→8; WRONG-PREMISE rate: this 276→83, other 81→8.
- 2026-09-19 architect change (`bdeecbae2d0b` → `6d25f06c4803`, adds the #1770 process-cleanup rule and the #1843 human-in-the-loop paragraph): rounds-to-pass: this 9→8, other 0→0; no-verdict rate: this 19→50, other 0→5; WRONG-PREMISE rate: this 12→25, other 0→4.

**Verdict by the pre-registered rule: value not proven (neither condition holds).**

- some interval excludes zero and some rate δ is within the cap, but no change moves an outcome by more than δ in both splits in the same direction

### Harness versions

82 role × scaffold versions; the 29 with at least 20 settled attempts have a table below, the rest are listed after them. Rates are percent of attempts with a 95 % cluster-bootstrap interval; a missing verdict counts as "no verdict", never as a pass.

#### architect `221d583ac93b`

60 attempts, 2026-07-12 → 2026-08-05; introduced by c9876d0f8 (2026-07-10); 4 added sentence(s) not found in git (a rendered parameter or an operator override).

| stratum | n (pipelines) | pass % | fail % | needs_decision % | no verdict % | WRONG-PREMISE % | OVER-BUILT % | findings P0/P1/P2/P3/unranked per attempt | median tokens (n) |
|---|---|---|---|---|---|---|---|---|---|
| claude/fable · this | 30 (23) | 60 [41, 81] | 0 [0, 0] | 0 [0, 0] | 40 [19, 58] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.97 | – (0) |
| claude/opus · this | 13 (10) | 62 [30, 85] | 0 [0, 0] | 8 [0, 30] | 31 [10, 60] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.08 | – (0) |
| codex/gpt-5.6-sol · this | 11 (10) | 73 [42, 100] | 0 [0, 0] | 9 [0, 30] | 18 [0, 46] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.18 | 5965k (9) |
| claude/fable · other | 5 (5) | 60 [20, 100] | 0 [0, 0] | 20 [0, 60] | 20 [0, 60] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.80 | – (0) |
| claude/fable-5 · this | 1 (1) | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 100 [100, 100] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.00 | – (0) |
| all | 60 (49) | 62 [48, 75] | 0 [0, 0] | 5 [0, 11] | 33 [20, 47] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.60 | 5965k (9) |

#### architect `4b302c80d3d6`

32 attempts, 2026-08-09 → 2026-09-02; introduced by 8b7c3d50e (2026-08-08, #957); 1 added sentence(s) not found in git (a rendered parameter or an operator override).

| stratum | n (pipelines) | pass % | fail % | needs_decision % | no verdict % | WRONG-PREMISE % | OVER-BUILT % | findings P0/P1/P2/P3/unranked per attempt | median tokens (n) |
|---|---|---|---|---|---|---|---|---|---|
| claude/fable · this | 24 (19) | 71 [50, 89] | 0 [0, 0] | 4 [0, 14] | 25 [7, 44] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.21 | 2459k (15) |
| codex/gpt-5.6-sol · this | 7 (7) | 14 [0, 43] | 29 [0, 57] | 43 [14, 71] | 14 [0, 43] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/1.86 | 5244k (7) |
| claude/opus · this | 1 (1) | 0 [0, 0] | 0 [0, 0] | 100 [100, 100] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/4.00 | 17185k (1) |
| all | 32 (27) | 56 [37, 73] | 6 [0, 17] | 16 [3, 30] | 22 [7, 39] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.69 | 3251k (23) |

#### architect `4e3a127ca1b0`

64 attempts, 2026-09-02 → 2026-09-18; introduced by bb72b3319 (2026-09-02, #1428 #1430).

| stratum | n (pipelines) | pass % | fail % | needs_decision % | no verdict % | WRONG-PREMISE % | OVER-BUILT % | findings P0/P1/P2/P3/unranked per attempt | median tokens (n) |
|---|---|---|---|---|---|---|---|---|---|
| claude/fable · this | 24 (18) | 63 [44, 85] | 13 [0, 32] | 4 [0, 15] | 21 [0, 39] | 0 [0, 0] | 0 [0, 0] | 0.00/0.04/0.00/0.00/0.42 | 4658k (22) |
| codex/gpt-6-astra · this | 21 (20) | 62 [43, 81] | 10 [0, 24] | 5 [0, 15] | 24 [9, 41] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.24 | 2992k (18) |
| claude/opus · this | 7 (4) | 57 [25, 100] | 0 [0, 0] | 0 [0, 0] | 43 [0, 75] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.00 | 10117k (7) |
| claude/fable · other | 6 (6) | 50 [17, 83] | 0 [0, 0] | 33 [0, 67] | 17 [0, 50] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/1.17 | 2172k (6) |
| codex/gpt-6-astra · other | 3 (3) | 33 [0, 100] | 0 [0, 0] | 67 [0, 100] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.67 | 3824k (3) |
| claude/opus · other | 3 (3) | 67 [0, 100] | 0 [0, 0] | 33 [0, 100] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/2.67 | 4143k (3) |
| all | 64 (54) | 59 [48, 72] | 8 [1, 17] | 11 [4, 20] | 22 [11, 32] | 0 [0, 0] | 0 [0, 0] | 0.00/0.02/0.00/0.00/0.50 | 3955k (59) |

#### architect `6d25f06c4803`

55 attempts, 2026-09-19 → 2026-09-23; introduced by e8db32b4b (2026-09-19, #1843 #1848).

| stratum | n (pipelines) | pass % | fail % | needs_decision % | no verdict % | WRONG-PREMISE % | OVER-BUILT % | findings P0/P1/P2/P3/unranked per attempt | median tokens (n) |
|---|---|---|---|---|---|---|---|---|---|
| claude/fable · this | 36 (12) | 53 [40, 63] | 42 [30, 55] | 0 [0, 0] | 6 [0, 12] | 0 [0, 0] | 3 [0, 7] | 0.00/0.33/0.92/1.25/0.00 | 3153k (36) |
| codex/gpt-6-astra · this | 8 (8) | 88 [63, 100] | 13 [0, 38] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0.00/0.13/0.00/0.00/0.00 | 2969k (8) |
| claude/opus · this | 6 (6) | 83 [50, 100] | 17 [0, 50] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0.00/0.17/0.67/0.67/0.00 | 12386k (6) |
| codex/gpt-6-astra · other | 3 (3) | 67 [0, 100] | 0 [0, 0] | 33 [0, 100] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0.00/0.33/0.00/0.00/0.00 | 11739k (3) |
| claude/fable · other | 2 (2) | 100 [100, 100] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.00 | 17214k (2) |
| all | 55 (30) | 64 [54, 75] | 31 [20, 41] | 2 [0, 7] | 4 [0, 8] | 0 [0, 0] | 2 [0, 5] | 0.00/0.27/0.67/0.89/0.00 | 3720k (55) |

#### architect `72118dfb6bf3`

28 attempts, 2026-09-24 → 2026-09-25; introduced by 0c2621af8 (2026-09-24).

| stratum | n (pipelines) | pass % | fail % | needs_decision % | no verdict % | WRONG-PREMISE % | OVER-BUILT % | findings P0/P1/P2/P3/unranked per attempt | median tokens (n) |
|---|---|---|---|---|---|---|---|---|---|
| claude/opus · this | 26 (15) | 96 [89, 100] | 0 [0, 0] | 0 [0, 0] | 4 [0, 12] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.00 | 10667k (26) |
| codex/gpt-6-sol · this | 1 (1) | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 100 [100, 100] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.00 | – (0) |
| claude/opus · other | 1 (1) | 100 [100, 100] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.00 | 32119k (1) |
| all | 28 (17) | 93 [82, 100] | 0 [0, 0] | 0 [0, 0] | 7 [0, 17] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.00 | 11024k (27) |

#### builder `38ce96b8338e`

930 attempts, 2026-07-12 → 2026-09-02; introduced by c9876d0f8 (2026-07-10); 3 added sentence(s) not found in git (a rendered parameter or an operator override).

| stratum | n (pipelines) | pass % | fail % | needs_decision % | no verdict % | WRONG-PREMISE % | OVER-BUILT % | findings P0/P1/P2/P3/unranked per attempt | median tokens (n) |
|---|---|---|---|---|---|---|---|---|---|
| codex/gpt-5.6-sol · this | 390 (178) | 80 [74, 86] | 0 [0, 1] | 0 [0, 0] | 19 [14, 26] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.01 | 9153k (334) |
| claude/opus · this | 382 (208) | 82 [78, 86] | 0 [0, 0] | 2 [1, 4] | 15 [11, 20] | 0 [0, 1] | 0 [0, 1] | 0.00/0.00/0.00/0.00/0.07 | 8574k (193) |
| claude/fable · this | 130 (92) | 65 [56, 74] | 0 [0, 0] | 0 [0, 0] | 35 [27, 43] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.32 | 5736k (17) |
| codex/gpt-5.6-luna · this | 13 (6) | 69 [44, 92] | 8 [0, 33] | 8 [0, 21] | 15 [0, 25] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.23 | 4224k (11) |
| claude/opus · other | 8 (5) | 75 [20, 100] | 0 [0, 0] | 0 [0, 0] | 25 [0, 80] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.00 | 16392k (3) |
| codex/gpt-5.6-terra · this | 3 (3) | 33 [0, 100] | 0 [0, 0] | 0 [0, 0] | 67 [0, 100] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.00 | 6671k (3) |
| codex/gpt-5.6-sol · other | 3 (3) | 67 [0, 100] | 0 [0, 0] | 0 [0, 0] | 33 [0, 100] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.00 | 18452k (2) |
| claude/fable-5 · this | 1 (1) | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 100 [100, 100] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.00 | – (0) |
| all | 930 (493) | 78 [75, 82] | 0 [0, 1] | 1 [0, 2] | 20 [17, 24] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.08 | 8733k (563) |

#### builder `9113d9cb926e`

48 attempts, 2026-07-12 → 2026-07-21; introduced by e0f418e3b (2026-07-10).

| stratum | n (pipelines) | pass % | fail % | needs_decision % | no verdict % | WRONG-PREMISE % | OVER-BUILT % | findings P0/P1/P2/P3/unranked per attempt | median tokens (n) |
|---|---|---|---|---|---|---|---|---|---|
| codex/gpt-5.6-sol · this | 19 (15) | 53 [28, 81] | 0 [0, 0] | 0 [0, 0] | 47 [19, 72] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.00 | 9063k (17) |
| claude/fable · this | 15 (12) | 33 [13, 56] | 0 [0, 0] | 0 [0, 0] | 67 [44, 88] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.80 | – (0) |
| claude/opus · this | 11 (10) | 73 [50, 91] | 0 [0, 0] | 0 [0, 0] | 27 [9, 50] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.45 | – (0) |
| claude/opus-4-8 · this | 2 (2) | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 100 [100, 100] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.00 | – (0) |
| claude/fable-5 · this | 1 (1) | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 100 [100, 100] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.00 | – (0) |
| all | 48 (40) | 48 [33, 64] | 0 [0, 0] | 0 [0, 0] | 52 [37, 67] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.35 | 9063k (17) |

#### builder `3836e49900fc`

30 attempts, 2026-07-18 → 2026-08-01; 1 added sentence(s), none found in git (a rendered parameter or an operator override).

| stratum | n (pipelines) | pass % | fail % | needs_decision % | no verdict % | WRONG-PREMISE % | OVER-BUILT % | findings P0/P1/P2/P3/unranked per attempt | median tokens (n) |
|---|---|---|---|---|---|---|---|---|---|
| claude/fable · this | 19 (8) | 21 [8, 42] | 0 [0, 0] | 0 [0, 0] | 79 [57, 93] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.37 | – (0) |
| claude/opus · this | 7 (7) | 86 [57, 100] | 0 [0, 0] | 0 [0, 0] | 14 [0, 43] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.00 | – (0) |
| codex/gpt-5.6-sol · this | 2 (2) | 50 [0, 100] | 0 [0, 0] | 0 [0, 0] | 50 [0, 100] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.00 | 30839k (2) |
| claude/opus-5 · this | 2 (2) | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 100 [100, 100] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.00 | – (0) |
| all | 30 (19) | 37 [21, 59] | 0 [0, 0] | 0 [0, 0] | 63 [40, 78] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.23 | 30839k (2) |

#### builder `e0dbc2273a77`

64 attempts, 2026-07-18 → 2026-08-01; no sentence added over the closest earlier version (parameter variant).

| stratum | n (pipelines) | pass % | fail % | needs_decision % | no verdict % | WRONG-PREMISE % | OVER-BUILT % | findings P0/P1/P2/P3/unranked per attempt | median tokens (n) |
|---|---|---|---|---|---|---|---|---|---|
| codex/gpt-5.6-sol · this | 48 (43) | 71 [57, 84] | 2 [0, 6] | 2 [0, 6] | 25 [13, 38] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.06 | 16763k (41) |
| claude/fable · this | 6 (5) | 67 [33, 100] | 0 [0, 0] | 0 [0, 0] | 33 [0, 67] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.17 | – (0) |
| claude/opus · this | 6 (6) | 100 [100, 100] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.00 | – (0) |
| codex/gpt-5.6-terra · this | 4 (3) | 75 [50, 100] | 0 [0, 0] | 0 [0, 0] | 25 [0, 50] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.00 | 16885k (3) |
| all | 64 (57) | 73 [62, 85] | 2 [0, 6] | 2 [0, 5] | 23 [14, 33] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.06 | 16824k (44) |

#### builder `b36fadf4d3f7`

481 attempts, 2026-09-02 → 2026-09-19; introduced by bb72b3319 (2026-09-02, #1428 #1430).

| stratum | n (pipelines) | pass % | fail % | needs_decision % | no verdict % | WRONG-PREMISE % | OVER-BUILT % | findings P0/P1/P2/P3/unranked per attempt | median tokens (n) |
|---|---|---|---|---|---|---|---|---|---|
| claude/opus · this | 180 (132) | 77 [70, 84] | 1 [0, 2] | 4 [2, 8] | 18 [12, 25] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.01/0.00/0.12 | 17091k (166) |
| codex/gpt-6-astra · this | 142 (99) | 68 [60, 76] | 6 [3, 10] | 10 [5, 15] | 15 [9, 22] | 0 [0, 0] | 0 [0, 0] | 0.00/0.01/0.01/0.00/0.23 | 4074k (129) |
| claude/fable · this | 58 (34) | 66 [53, 77] | 2 [0, 5] | 2 [0, 5] | 31 [19, 43] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.05 | 4136k (56) |
| codex/gpt-6-astra · other | 31 (29) | 65 [48, 80] | 0 [0, 0] | 26 [12, 43] | 10 [0, 19] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.35 | 3169k (28) |
| claude/opus · other | 29 (28) | 72 [57, 86] | 0 [0, 0] | 3 [0, 11] | 24 [10, 40] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.07 | 15585k (26) |
| claude/fable · other | 13 (12) | 85 [64, 100] | 0 [0, 0] | 8 [0, 25] | 8 [0, 20] | 0 [0, 0] | 0 [0, 0] | 0.00/0.15/0.08/0.08/0.00 | 8008k (13) |
| codex/gpt-5.6-luna · other | 7 (7) | 86 [57, 100] | 0 [0, 0] | 14 [0, 43] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.14 | 12204k (7) |
| codex/gpt-5.6-sol · this | 6 (4) | 67 [0, 100] | 0 [0, 0] | 0 [0, 0] | 33 [0, 100] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.00 | 3125k (4) |
| codex/gpt-5.6-luna · this | 6 (6) | 83 [50, 100] | 0 [0, 0] | 17 [0, 50] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.33 | 13307k (6) |
| claude/haiku · this | 4 (2) | 100 [100, 100] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.00 | 104k (4) |
| codex/gpt-5.6-terra · other | 2 (2) | 0 [0, 0] | 0 [0, 0] | 100 [100, 100] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/1.00 | 3035k (2) |
| claude/sonnet · other | 2 (2) | 100 [100, 100] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.00 | 11687k (2) |
| codex/gpt-5.6-sol · other | 1 (1) | 100 [100, 100] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.00 | 198k (1) |
| all | 481 (357) | 72 [68, 76] | 2 [1, 4] | 8 [5, 10] | 18 [14, 22] | 0 [0, 0] | 0 [0, 0] | 0.00/0.01/0.01/0.00/0.16 | 6734k (444) |

#### builder `b01200c45694`

23 attempts, 2026-09-19 → 2026-09-19; introduced by fc60c21a0 (2026-09-19, #1770 #1791); 1 added sentence(s) not found in git (a rendered parameter or an operator override).

| stratum | n (pipelines) | pass % | fail % | needs_decision % | no verdict % | WRONG-PREMISE % | OVER-BUILT % | findings P0/P1/P2/P3/unranked per attempt | median tokens (n) |
|---|---|---|---|---|---|---|---|---|---|
| claude/opus · this | 15 (10) | 87 [71, 100] | 0 [0, 0] | 0 [0, 0] | 13 [0, 29] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.00 | 5049k (14) |
| codex/gpt-6-astra · this | 8 (5) | 88 [67, 100] | 0 [0, 0] | 0 [0, 0] | 13 [0, 33] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.00 | 9699k (7) |
| all | 23 (15) | 87 [74, 100] | 0 [0, 0] | 0 [0, 0] | 13 [0, 25] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.00 | 6323k (21) |

#### builder `c64f933672dc`

167 attempts, 2026-09-19 → 2026-09-21; introduced by e8db32b4b (2026-09-19, #1843 #1848).

| stratum | n (pipelines) | pass % | fail % | needs_decision % | no verdict % | WRONG-PREMISE % | OVER-BUILT % | findings P0/P1/P2/P3/unranked per attempt | median tokens (n) |
|---|---|---|---|---|---|---|---|---|---|
| claude/opus · this | 79 (37) | 92 [85, 99] | 0 [0, 0] | 0 [0, 0] | 8 [2, 15] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.00 | 9254k (76) |
| codex/gpt-6-astra · this | 70 (40) | 74 [63, 85] | 1 [0, 5] | 3 [0, 7] | 21 [11, 32] | 0 [0, 0] | 0 [0, 0] | 0.00/0.04/0.01/0.00/0.00 | 6167k (56) |
| codex/gpt-5.6-terra · this | 9 (6) | 78 [50, 100] | 22 [0, 50] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0.00/0.33/0.11/0.00/0.00 | 5545k (9) |
| codex/gpt-6-astra · other | 7 (7) | 43 [14, 86] | 0 [0, 0] | 43 [14, 86] | 14 [0, 43] | 0 [0, 0] | 0 [0, 0] | 0.00/0.29/0.00/0.00/0.00 | 14377k (6) |
| codex/gpt-5.6-luna · this | 1 (1) | 100 [100, 100] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.00 | 9115k (1) |
| claude/opus · other | 1 (1) | 0 [0, 0] | 0 [0, 0] | 100 [100, 100] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/1.00/1.00/0.00 | 2453k (1) |
| all | 167 (91) | 81 [75, 88] | 2 [0, 4] | 4 [1, 7] | 13 [8, 19] | 0 [0, 0] | 0 [0, 0] | 0.00/0.05/0.02/0.01/0.00 | 7861k (149) |

#### builder `0a81bfb60894`

29 attempts, 2026-09-20 → 2026-09-21; introduced by e0f418e3b (2026-07-10).

| stratum | n (pipelines) | pass % | fail % | needs_decision % | no verdict % | WRONG-PREMISE % | OVER-BUILT % | findings P0/P1/P2/P3/unranked per attempt | median tokens (n) |
|---|---|---|---|---|---|---|---|---|---|
| claude/opus · this | 28 (11) | 86 [75, 100] | 0 [0, 0] | 0 [0, 0] | 14 [0, 26] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.00 | 13066k (26) |
| claude/fable · other | 1 (1) | 100 [100, 100] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.00 | 9969k (1) |
| all | 29 (12) | 86 [76, 100] | 0 [0, 0] | 0 [0, 0] | 14 [0, 24] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.00 | 11618k (27) |

#### builder `769ca32097ed`

33 attempts, 2026-09-21 → 2026-09-23; introduced by f13b31d2b (2026-09-21).

| stratum | n (pipelines) | pass % | fail % | needs_decision % | no verdict % | WRONG-PREMISE % | OVER-BUILT % | findings P0/P1/P2/P3/unranked per attempt | median tokens (n) |
|---|---|---|---|---|---|---|---|---|---|
| claude/opus · this | 26 (26) | 92 [81, 100] | 4 [0, 12] | 0 [0, 0] | 4 [0, 12] | 0 [0, 0] | 0 [0, 0] | 0.00/0.04/0.04/0.00/0.00 | 23385k (26) |
| codex/gpt-6-astra · other | 2 (2) | 50 [0, 100] | 0 [0, 0] | 50 [0, 100] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0.00/0.50/1.00/0.00/0.00 | 15736k (2) |
| codex/gpt-6-luna · this | 2 (1) | 50 [50, 50] | 0 [0, 0] | 50 [50, 50] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.00 | 93157k (2) |
| codex/gpt-5.6-luna · other | 2 (2) | 50 [0, 100] | 0 [0, 0] | 50 [0, 100] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0.00/0.50/0.00/0.00/0.00 | 100675k (2) |
| codex/gpt-6-astra · this | 1 (1) | 100 [100, 100] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.00 | 47745k (1) |
| all | 33 (32) | 85 [73, 97] | 3 [0, 9] | 9 [0, 19] | 3 [0, 9] | 0 [0, 0] | 0 [0, 0] | 0.00/0.09/0.09/0.00/0.00 | 29168k (33) |

#### builder `4a575cdadd3b`

40 attempts, 2026-09-24 → 2026-09-25; introduced by 0c2621af8 (2026-09-24).

| stratum | n (pipelines) | pass % | fail % | needs_decision % | no verdict % | WRONG-PREMISE % | OVER-BUILT % | findings P0/P1/P2/P3/unranked per attempt | median tokens (n) |
|---|---|---|---|---|---|---|---|---|---|
| claude/opus · this | 40 (23) | 98 [92, 100] | 0 [0, 0] | 0 [0, 0] | 3 [0, 8] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.00 | 21640k (40) |
| all | 40 (23) | 98 [93, 100] | 0 [0, 0] | 0 [0, 0] | 3 [0, 8] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.00 | 21640k (40) |

#### builder `3df7cb643a14`

71 attempts, 2026-09-24 → 2026-09-25; no sentence added over the closest earlier version (parameter variant).

| stratum | n (pipelines) | pass % | fail % | needs_decision % | no verdict % | WRONG-PREMISE % | OVER-BUILT % | findings P0/P1/P2/P3/unranked per attempt | median tokens (n) |
|---|---|---|---|---|---|---|---|---|---|
| claude/opus · this | 39 (23) | 92 [84, 100] | 0 [0, 0] | 3 [0, 8] | 5 [0, 13] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.03/0.00/0.00 | 7475k (39) |
| codex/gpt-6-sol · other | 29 (17) | 69 [52, 86] | 10 [0, 21] | 7 [0, 16] | 14 [4, 27] | 0 [0, 0] | 0 [0, 0] | 0.00/0.03/0.03/0.03/0.00 | 25546k (28) |
| claude/opus · other | 2 (1) | 50 [50, 50] | 0 [0, 0] | 0 [0, 0] | 50 [50, 50] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.00 | 1094k (2) |
| codex/gpt-6-sol · this | 1 (1) | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 100 [100, 100] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.00 | – (0) |
| all | 71 (41) | 80 [70, 90] | 4 [0, 9] | 4 [0, 9] | 11 [4, 19] | 0 [0, 0] | 0 [0, 0] | 0.00/0.01/0.03/0.01/0.00 | 12302k (69) |

#### custom `none`

50 attempts, 2026-07-12 → 2026-09-11; provenance not computed.

| stratum | n (pipelines) | pass % | fail % | needs_decision % | no verdict % | WRONG-PREMISE % | OVER-BUILT % | findings P0/P1/P2/P3/unranked per attempt | median tokens (n) |
|---|---|---|---|---|---|---|---|---|---|
| codex/gpt-5.6-sol · this | 22 (12) | 45 [27, 71] | 0 [0, 0] | 0 [0, 0] | 55 [29, 74] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.00 | 8191k (20) |
| claude/fable · this | 19 (9) | 63 [41, 88] | 5 [0, 14] | 0 [0, 0] | 32 [8, 58] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.05 | – (0) |
| claude/opus · this | 8 (8) | 50 [13, 88] | 13 [0, 38] | 0 [0, 0] | 38 [0, 75] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.25 | 9975k (7) |
| claude/sonnet · this | 1 (1) | 100 [100, 100] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.00 | – (0) |
| all | 50 (26) | 54 [40, 69] | 4 [0, 10] | 0 [0, 0] | 42 [26, 57] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.06 | 8234k (27) |

#### prod-auditor `ac3c408e7fa8`

33 attempts, 2026-07-17 → 2026-09-18; introduced by c9876d0f8 (2026-07-10); 4 added sentence(s) not found in git (a rendered parameter or an operator override).

| stratum | n (pipelines) | pass % | fail % | needs_decision % | no verdict % | WRONG-PREMISE % | OVER-BUILT % | findings P0/P1/P2/P3/unranked per attempt | median tokens (n) |
|---|---|---|---|---|---|---|---|---|---|
| codex/gpt-6-astra · other | 8 (7) | 25 [0, 63] | 13 [0, 30] | 38 [9, 75] | 25 [0, 50] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/1.00 | 2437k (7) |
| codex/gpt-5.6-sol · this | 7 (4) | 29 [0, 100] | 0 [0, 0] | 14 [0, 30] | 57 [0, 86] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.57 | 1821k (7) |
| claude/opus · this | 7 (7) | 57 [14, 86] | 0 [0, 0] | 29 [0, 71] | 14 [0, 43] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/1.57 | 5714k (6) |
| codex/gpt-6-astra · this | 5 (5) | 0 [0, 0] | 0 [0, 0] | 60 [20, 100] | 40 [0, 80] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/1.40 | 4518k (5) |
| claude/fable · this | 4 (4) | 50 [0, 100] | 0 [0, 0] | 25 [0, 75] | 25 [0, 75] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.75 | 2283k (3) |
| codex/gpt-5.6-luna · other | 1 (1) | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 100 [100, 100] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.00 | 1908k (1) |
| claude/fable · other | 1 (1) | 0 [0, 0] | 0 [0, 0] | 100 [100, 100] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/4.00 | 1628k (1) |
| all | 33 (29) | 30 [16, 47] | 3 [0, 9] | 33 [18, 50] | 33 [16, 49] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/1.12 | 2575k (30) |

#### reviewer `8d942b3e6524`

294 attempts, 2026-07-18 → 2026-08-08; introduced by c9876d0f8 (2026-07-10), e0f418e3b (2026-07-10); 5 added sentence(s) not found in git (a rendered parameter or an operator override).

| stratum | n (pipelines) | pass % | fail % | needs_decision % | no verdict % | WRONG-PREMISE % | OVER-BUILT % | findings P0/P1/P2/P3/unranked per attempt | median tokens (n) |
|---|---|---|---|---|---|---|---|---|---|
| codex/gpt-5.6-sol · this | 171 (138) | 20 [14, 27] | 5 [2, 9] | 0 [0, 0] | 75 [67, 82] | 0 [0, 0] | 0 [0, 0] | 0.00/0.05/0.02/0.00/0.05 | 4309k (137) |
| claude/fable · this | 62 (49) | 63 [52, 75] | 2 [0, 5] | 0 [0, 0] | 35 [24, 47] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.40 | – (0) |
| claude/opus · this | 58 (36) | 10 [3, 20] | 22 [10, 38] | 3 [0, 10] | 64 [44, 79] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.86 | – (0) |
| codex/gpt-5.6-sol · other | 2 (2) | 0 [0, 0] | 50 [0, 100] | 0 [0, 0] | 50 [0, 100] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.00 | – (0) |
| codex/gpt-5.6 · this | 1 (1) | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 100 [100, 100] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.00 | – (0) |
| all | 294 (224) | 27 [21, 33] | 8 [5, 12] | 1 [0, 2] | 64 [58, 70] | 0 [0, 0] | 0 [0, 0] | 0.00/0.03/0.01/0.00/0.29 | 4309k (137) |

#### reviewer `b23e99964c91`

26 attempts, 2026-07-20 → 2026-07-30; 1 added sentence(s), none found in git (a rendered parameter or an operator override).

| stratum | n (pipelines) | pass % | fail % | needs_decision % | no verdict % | WRONG-PREMISE % | OVER-BUILT % | findings P0/P1/P2/P3/unranked per attempt | median tokens (n) |
|---|---|---|---|---|---|---|---|---|---|
| codex/gpt-5.6-sol · this | 19 (16) | 32 [12, 50] | 0 [0, 0] | 0 [0, 0] | 68 [50, 86] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.00 | 3047k (16) |
| claude/opus · this | 7 (4) | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 100 [100, 100] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.00 | – (0) |
| all | 26 (20) | 23 [8, 39] | 0 [0, 0] | 0 [0, 0] | 77 [60, 92] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.00 | 3047k (16) |

#### reviewer `7784dc2dbdac`

68 attempts, 2026-08-09 → 2026-08-22; introduced by 8b7c3d50e (2026-08-08, #957); 1 added sentence(s) not found in git (a rendered parameter or an operator override).

| stratum | n (pipelines) | pass % | fail % | needs_decision % | no verdict % | WRONG-PREMISE % | OVER-BUILT % | findings P0/P1/P2/P3/unranked per attempt | median tokens (n) |
|---|---|---|---|---|---|---|---|---|---|
| codex/gpt-5.6-sol · this | 56 (31) | 18 [9, 28] | 75 [64, 85] | 2 [0, 6] | 5 [0, 11] | 2 [0, 5] | 20 [8, 33] | 0.00/0.00/0.00/0.00/2.23 | 3244k (54) |
| claude/fable · this | 7 (5) | 86 [40, 100] | 14 [0, 60] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.14 | – (0) |
| claude/opus · this | 5 (4) | 0 [0, 0] | 80 [57, 100] | 0 [0, 0] | 20 [0, 43] | 0 [0, 0] | 40 [0, 75] | 0.00/0.00/0.00/0.00/5.00 | – (0) |
| all | 68 (36) | 24 [14, 36] | 69 [58, 80] | 1 [0, 5] | 6 [1, 11] | 1 [0, 5] | 19 [9, 30] | 0.00/0.00/0.00/0.00/2.22 | 3244k (54) |

#### reviewer `6203210e5e2f`

593 attempts, 2026-08-23 → 2026-09-02; introduced by ad3d071ad (2026-08-22, #1052 #1095); 1 added sentence(s) not found in git (a rendered parameter or an operator override).

| stratum | n (pipelines) | pass % | fail % | needs_decision % | no verdict % | WRONG-PREMISE % | OVER-BUILT % | findings P0/P1/P2/P3/unranked per attempt | median tokens (n) |
|---|---|---|---|---|---|---|---|---|---|
| codex/gpt-5.6-sol · this | 500 (189) | 19 [16, 23] | 70 [66, 75] | 0 [0, 1] | 10 [7, 14] | 12 [8, 16] | 16 [11, 21] | 0.06/0.50/0.17/0.00/0.87 | 4043k (462) |
| claude/fable · this | 50 (26) | 34 [23, 49] | 38 [19, 55] | 0 [0, 0] | 28 [16, 41] | 0 [0, 0] | 4 [0, 10] | 0.00/0.06/0.12/0.16/0.78 | 1477k (41) |
| claude/opus · this | 39 (21) | 23 [11, 42] | 56 [37, 72] | 8 [0, 17] | 13 [3, 23] | 0 [0, 0] | 13 [3, 22] | 0.00/0.00/0.00/0.00/2.28 | 6499k (38) |
| codex/gpt-5.6-sol · other | 4 (2) | 25 [0, 100] | 75 [0, 100] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 75 [0, 100] | 0.00/0.00/0.00/0.00/2.75 | 5390k (4) |
| all | 593 (238) | 21 [17, 24] | 67 [62, 71] | 1 [0, 1] | 12 [9, 15] | 10 [7, 13] | 15 [11, 19] | 0.05/0.42/0.15/0.02/0.97 | 3974k (545) |

#### reviewer `f2b931775daf`

302 attempts, 2026-09-02 → 2026-09-18; introduced by bb72b3319 (2026-09-02, #1428 #1430).

| stratum | n (pipelines) | pass % | fail % | needs_decision % | no verdict % | WRONG-PREMISE % | OVER-BUILT % | findings P0/P1/P2/P3/unranked per attempt | median tokens (n) |
|---|---|---|---|---|---|---|---|---|---|
| codex/gpt-6-astra · this | 113 (70) | 46 [35, 57] | 42 [31, 52] | 0 [0, 0] | 12 [7, 19] | 0 [0, 0] | 0 [0, 0] | 0.00/0.27/0.25/0.00/0.34 | 1272k (100) |
| claude/opus · this | 87 (72) | 46 [35, 58] | 29 [17, 39] | 1 [0, 4] | 24 [16, 33] | 1 [0, 4] | 1 [0, 4] | 0.00/0.08/0.07/0.05/1.09 | 6639k (76) |
| claude/fable · this | 49 (29) | 51 [38, 65] | 24 [14, 36] | 0 [0, 0] | 24 [11, 36] | 0 [0, 0] | 2 [0, 7] | 0.00/0.00/0.02/0.00/0.55 | 2173k (44) |
| codex/gpt-6-astra · other | 25 (24) | 52 [33, 71] | 24 [8, 42] | 0 [0, 0] | 24 [8, 40] | 0 [0, 0] | 0 [0, 0] | 0.00/0.08/0.20/0.04/0.20 | 956k (19) |
| claude/fable · other | 11 (10) | 36 [8, 70] | 55 [27, 82] | 0 [0, 0] | 9 [0, 23] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/1.27 | 1479k (10) |
| claude/opus · other | 10 (9) | 20 [0, 42] | 60 [27, 89] | 0 [0, 0] | 20 [0, 42] | 0 [0, 0] | 0 [0, 0] | 0.00/0.20/0.60/0.90/0.70 | 3759k (9) |
| codex/gpt-5.6-sol · this | 4 (2) | 25 [0, 100] | 50 [0, 67] | 0 [0, 0] | 25 [0, 33] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.50 | 2062k (4) |
| claude/haiku · this | 2 (2) | 100 [100, 100] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.00 | 642k (2) |
| codex/gpt-5.6-sol · other | 1 (1) | 0 [0, 0] | 100 [100, 100] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/3.00 | 5341k (1) |
| all | 302 (219) | 46 [40, 53] | 35 [29, 40] | 0 [0, 1] | 19 [15, 23] | 0 [0, 1] | 1 [0, 2] | 0.00/0.14/0.15/0.05/0.63 | 2046k (265) |

#### reviewer `d49121887aa9`

46 attempts, 2026-09-18 → 2026-09-19; introduced by 14afc273b (2026-09-18, #1741 #1742); 1 added sentence(s) not found in git (a rendered parameter or an operator override).

| stratum | n (pipelines) | pass % | fail % | needs_decision % | no verdict % | WRONG-PREMISE % | OVER-BUILT % | findings P0/P1/P2/P3/unranked per attempt | median tokens (n) |
|---|---|---|---|---|---|---|---|---|---|
| claude/opus · this | 32 (20) | 63 [50, 80] | 25 [11, 36] | 6 [0, 14] | 6 [0, 14] | 0 [0, 0] | 0 [0, 0] | 0.03/0.09/0.22/0.31/0.00 | 4440k (30) |
| claude/opus · other | 12 (11) | 8 [0, 27] | 92 [73, 100] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0.00/0.50/2.08/4.00/0.00 | 11409k (12) |
| claude/haiku · this | 2 (1) | 50 [50, 50] | 50 [50, 50] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.50 | 30k (2) |
| all | 46 (32) | 48 [37, 61] | 43 [31, 56] | 4 [0, 10] | 4 [0, 10] | 0 [0, 0] | 0 [0, 0] | 0.02/0.20/0.70/1.26/0.02 | 5283k (44) |

#### reviewer `515a459bc841`

28 attempts, 2026-09-19 → 2026-09-19; introduced by fc60c21a0 (2026-09-19, #1770 #1791); 1 added sentence(s) not found in git (a rendered parameter or an operator override).

| stratum | n (pipelines) | pass % | fail % | needs_decision % | no verdict % | WRONG-PREMISE % | OVER-BUILT % | findings P0/P1/P2/P3/unranked per attempt | median tokens (n) |
|---|---|---|---|---|---|---|---|---|---|
| claude/opus · this | 15 (11) | 67 [53, 85] | 33 [15, 47] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0.00/0.07/0.33/0.20/0.00 | 1842k (15) |
| codex/gpt-6-astra · this | 13 (10) | 46 [25, 67] | 54 [33, 75] | 0 [0, 0] | 0 [0, 0] | 8 [0, 27] | 0 [0, 0] | 0.00/0.31/0.69/0.00/0.00 | 2419k (13) |
| all | 28 (17) | 57 [47, 70] | 43 [29, 53] | 0 [0, 0] | 0 [0, 0] | 4 [0, 10] | 0 [0, 0] | 0.00/0.18/0.50/0.11/0.00 | 2201k (28) |

#### reviewer `e71f5ea9edd5`

211 attempts, 2026-09-19 → 2026-09-23; introduced by e7d5c92ea (2026-09-19, #1785 #1786), e8db32b4b (2026-09-19, #1843 #1848).

| stratum | n (pipelines) | pass % | fail % | needs_decision % | no verdict % | WRONG-PREMISE % | OVER-BUILT % | findings P0/P1/P2/P3/unranked per attempt | median tokens (n) |
|---|---|---|---|---|---|---|---|---|---|
| codex/gpt-6-astra · this | 107 (79) | 37 [28, 47] | 57 [46, 66] | 0 [0, 0] | 6 [2, 10] | 0 [0, 0] | 0 [0, 0] | 0.00/0.74/0.54/0.02/0.03 | 2116k (103) |
| claude/opus · this | 86 (54) | 38 [31, 48] | 50 [40, 58] | 0 [0, 0] | 12 [6, 18] | 1 [0, 4] | 1 [0, 4] | 0.01/0.22/0.43/0.48/0.26 | 3447k (79) |
| claude/fable · this | 10 (7) | 40 [11, 75] | 30 [11, 50] | 0 [0, 0] | 30 [0, 58] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.60 | 4180k (10) |
| claude/fable · other | 4 (2) | 25 [0, 100] | 25 [0, 33] | 0 [0, 0] | 50 [0, 67] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.50 | 1607k (2) |
| codex/gpt-6-astra · other | 3 (3) | 0 [0, 0] | 33 [0, 100] | 0 [0, 0] | 67 [0, 100] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.67 | 822k (2) |
| codex/gpt-6-sol · other | 1 (1) | 100 [100, 100] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.00 | 3546k (1) |
| all | 211 (145) | 37 [31, 44] | 52 [45, 58] | 0 [0, 0] | 11 [7, 15] | 0 [0, 2] | 0 [0, 1] | 0.00/0.46/0.45/0.20/0.17 | 2655k (197) |

#### reviewer `d1bd50e6e2e0`

25 attempts, 2026-09-23 → 2026-09-24; introduced by 14afc273b (2026-09-18, #1741 #1742).

| stratum | n (pipelines) | pass % | fail % | needs_decision % | no verdict % | WRONG-PREMISE % | OVER-BUILT % | findings P0/P1/P2/P3/unranked per attempt | median tokens (n) |
|---|---|---|---|---|---|---|---|---|---|
| claude/opus · this | 10 (10) | 90 [70, 100] | 10 [0, 30] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.10/0.20/0.00 | 1938k (10) |
| codex/gpt-6-astra · this | 10 (9) | 60 [27, 100] | 10 [0, 33] | 0 [0, 0] | 30 [0, 64] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.20/0.00/0.00 | 1514k (7) |
| codex/gpt-6-sol · other | 4 (2) | 25 [0, 100] | 75 [0, 100] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0.00/0.75/1.50/0.00/0.00 | 54235k (4) |
| codex/gpt-6-astra · other | 1 (1) | 100 [100, 100] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.00 | 259k (1) |
| all | 25 (22) | 68 [45, 91] | 20 [0, 41] | 0 [0, 0] | 12 [0, 30] | 0 [0, 0] | 0 [0, 0] | 0.00/0.12/0.36/0.08/0.00 | 2251k (22) |

#### reviewer `8dc6f7ad0fdb`

91 attempts, 2026-09-24 → 2026-09-25; introduced by e0f418e3b (2026-07-10), 0c2621af8 (2026-09-24).

| stratum | n (pipelines) | pass % | fail % | needs_decision % | no verdict % | WRONG-PREMISE % | OVER-BUILT % | findings P0/P1/P2/P3/unranked per attempt | median tokens (n) |
|---|---|---|---|---|---|---|---|---|---|
| claude/opus · this | 74 (50) | 53 [41, 66] | 45 [31, 57] | 0 [0, 0] | 3 [0, 7] | 0 [0, 0] | 1 [0, 4] | 0.01/0.49/0.59/0.51/0.00 | 3034k (74) |
| codex/gpt-6-sol · other | 9 (4) | 22 [0, 67] | 78 [33, 100] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0.00/0.67/1.00/0.11/0.00 | 25533k (9) |
| claude/opus · other | 8 (8) | 75 [38, 100] | 25 [0, 50] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.88 | 4317k (8) |
| all | 91 (62) | 52 [40, 64] | 46 [34, 58] | 0 [0, 0] | 2 [0, 6] | 0 [0, 0] | 1 [0, 4] | 0.01/0.46/0.58/0.43/0.08 | 3277k (91) |

#### verifier `992da027c662`

70 attempts, 2026-07-18 → 2026-09-18; introduced by c9876d0f8 (2026-07-10); 4 added sentence(s) not found in git (a rendered parameter or an operator override).

| stratum | n (pipelines) | pass % | fail % | needs_decision % | no verdict % | WRONG-PREMISE % | OVER-BUILT % | findings P0/P1/P2/P3/unranked per attempt | median tokens (n) |
|---|---|---|---|---|---|---|---|---|---|
| codex/gpt-6-astra · this | 46 (37) | 48 [33, 65] | 37 [19, 52] | 2 [0, 7] | 13 [4, 24] | 0 [0, 0] | 0 [0, 0] | 0.00/0.15/0.26/0.02/0.26 | 2200k (46) |
| claude/opus · this | 12 (12) | 42 [17, 75] | 8 [0, 25] | 33 [8, 58] | 17 [0, 42] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/3.58 | 7091k (11) |
| claude/fable · this | 6 (6) | 33 [0, 67] | 33 [0, 67] | 17 [0, 50] | 17 [0, 50] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/2.50 | 982k (3) |
| claude/opus · other | 3 (3) | 0 [0, 0] | 67 [0, 100] | 33 [0, 100] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0.00/1.00/4.00/7.00/0.00 | 52125k (3) |
| codex/gpt-6-astra · other | 2 (2) | 0 [0, 0] | 50 [0, 100] | 0 [0, 0] | 50 [0, 100] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/2.00 | 680k (2) |
| claude/fable · other | 1 (1) | 100 [100, 100] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0 [0, 0] | 0.00/0.00/0.00/0.00/0.00 | 872k (1) |
| all | 70 (61) | 43 [31, 56] | 33 [20, 45] | 10 [3, 18] | 14 [7, 23] | 0 [0, 0] | 0 [0, 0] | 0.00/0.14/0.34/0.31/1.06 | 2315k (66) |

Versions under 20 attempts: architect `d9f267006c7f` (3), architect `bdeecbae2d0b` (19), architect `94d0b90f96fd` (8), architect `3cc98e44a297` (2), architect `747461b7665e` (8), builder `6d30a3b97eeb` (2), builder `51cd4bdc01b1` (1), builder `060680a1d542` (2), builder `e0154b42e126` (3), builder `4d769dfe4fc2` (4), builder `5a8a581dc56c` (8), builder `24a8eb747e2e` (3), builder `d3d6547d7846` (15), builder `65a4514bb61a` (7), builder `d0dc2ff555a6` (1), builder `d2bbf91ecd22` (4), cleaner `ccaa5c434b8c` (2), cleaner `98ce5fd378cc` (1), orchestrator `7c1385bd8da4` (3), prod-auditor `0cbc11d12d14` (1), prod-auditor `37e6d9694232` (3), prod-auditor `2bf350c79d63` (13), reviewer `edc3b1f4e95d` (3), reviewer `e61176c2344e` (2), reviewer `3855be3e901b` (5), reviewer `6bf194d4a4b5` (8), reviewer `bd171ce7e938` (6), reviewer `e43a008ae298` (1), reviewer `707fdc8a1ef2` (1), reviewer `a9a8ae6ef84e` (1), reviewer `e5e5ef26ef85` (1), reviewer `e2f8fd59857c` (1), reviewer `47ecc3a9c47a` (1), reviewer `5cc08a2e7b9a` (1), reviewer `866cb3794dbd` (1), reviewer `34fbd62e5376` (1), reviewer `a7c6b2d36be9` (1), reviewer `470a96532554` (1), reviewer `8622d24a62ad` (2), reviewer `db037b024055` (1), reviewer `7ed616d67e42` (1), reviewer `f67fd5c205d3` (1), reviewer `1f20cdbd166f` (1), reviewer `09ecaee82ba9` (1), reviewer `cdbfa8e2ab12` (1), reviewer `b85ed674aae0` (15), reviewer `d5844a50c0ad` (12), verifier `704e922c2609` (1), verifier `ba457dfb50c8` (1), verifier `5984541332da` (1), verifier `b4a7cf94f45e` (1), verifier `815d721e7ca9` (2), verifier `54ab5d83ef4f` (4).


## The first run, before the correction

The run at `a56f28fb7` read "the pipeline passed" as `state === "completed"`. Only the rounds-to-pass rows, the rounds-to-pass arm sizes and the verdict differ from the corrected run above.

| role | outcome | δ | cells | weeks | n |
|---|---|---|---|---|---|
| reviewer | rounds-to-pass (rounds) | 0.23 | 1 | 3 | 60 |
| builder | rounds-to-pass (rounds) | 0.35 | 2 | 5 | 71 |
| architect | rounds-to-pass (rounds) | unmeasured | 0 | 0 | 0 |

| change | outcome | δ | this repository | other repositories | > δ in both, same sign |
|---|---|---|---|---|---|
| #1428 search sentence (reviewer) | rounds-to-pass (rounds) | 0.23 | -0.11 [-0.33, +0.00] (n 9→1; 1 strata) | – (no shared model stratum) | no |
| 2026-09-19 builder change | rounds-to-pass (rounds) | 0.35 | – (no shared model stratum) | – (no shared model stratum) | no |
| 2026-09-19 architect change | rounds-to-pass (rounds) | unmeasured | – (no shared model stratum) | – (no shared model stratum) | no |

**Verdict by the pre-registered rule: value disproved.**

- every one of the 11 effect intervals includes zero
