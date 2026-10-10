# Model analysis after 6 October 2026

This fresh baseline covers 295 pipelines on this installation. GPT-6.1 Sol high passed first review in 57/112 initial-builder lanes (50.9%); the standard-domain subset is 55/109 (50.5%). Opus high passed first review in 8/24 explicitly tagged frontend lanes (33.3%). These observations support a scoped frontend effort change and a builder comparison trial. They do not establish a causal ranking of models.

The September report, `model-landscape-2026-09.md`, is gone. A comparison under the same conditions is impossible. The operator authorized this replacement method. Earlier comparisons below use only the two baselines preserved in the task details; [PR #2174](https://github.com/Latand/delegatus/pull/2174) supplies the earlier role recommendations, without recoverable calculation rules.

## Cohort and reusable method

Enrollment: `2026-10-06T00:00:00Z` through `2026-10-10T22:38:45.784Z`, inclusive. The upper bound is the end of the previous analysis attempt, preserving its requested 295-record cohort. Observation snapshot: `2026-10-10T22:43:41.620383Z`. One later-created pipeline was excluded. The cohort spans four projects: 234, 40, 20 and 1 pipelines. Project identities and raw records remain private.

1. Open the operator-selected `state.sqlite` with SQLite URI `mode=ro` and `PRAGMA query_only=ON`. Use SQLite backup into a private analysis directory; query that copy throughout. Read `state_rows.value_json` for collections `pipelines` and `pipelines_archive`, apply the enrollment bounds to `createdAt`, and deduplicate by pipeline `id` (no duplicates here). Do not import application stores, run migrations, or write live state. For a repeat, publish its enrollment and observation timestamps before calculating outcomes.
2. Flatten every `runs[].attempts[]`, keyed by pipeline, stage and attempt number. Exclude `historical` and `legacyReview` attempts (none here). Group by the attempt’s stored `effectiveRole.roleId/engine/model/effort`; retain absent role as `custom` and absent effort as `unknown`. Keep GPT-6 Sol and GPT-6.1 Sol separate. Read variant parameters from bound `definition.role.params`, falling back to the current stage only when the definition is absent. Seven runtime-switch histories retain the same engine/model/effort, so none creates a mixed attempt here.
3. Attempt pass rate is `verdict.status=pass / all recorded verdicts`; fail and needs_decision remain in the denominator. Count attempts without a verdict separately, including operational failures. Use the settled `verdict`, rather than an earlier report intent or final lifecycle state: 21 reports differ from their lifecycle state after publication, parking or skipping. Builder self-reports measure completion, not independent acceptance.
4. Builder first review uses at most one initial builder stage per pipeline: the earliest started builder whose mode is not `apply-fixes`, then that stage’s earliest successfully delivered attempt (`state=passed`, verdict pass). Follow `activatedBy.stageId/attempt` ancestry to the first verdict-bearing `reviewer`, ordered by start time. Exclude design reviews preceding the build. A missing delivered build or reachable review is unobserved, not a failure. Divide first-review passes by observed first-review verdicts. For frontend, repeat this selection independently among builders explicitly tagged `domain=frontend`, including pipelines whose first builder handled another domain. Do not infer frontend from task text or file names; a visual critic is a separate role.
5. Review rounds count verdict-bearing attempts in one pipeline/stage, ordered by attempt number, through its first pass, including failed and needs_decision rounds. Report completed sequences and unresolved sequences separately. Exclude three sequences that change engine/model/effort from the role-specific rounds table. Builder rounds follow its selected first reviewer stage. A completed-sequence median has survivor bias; it cannot measure effort spent in unresolved lanes.
6. Findings are occurrences, including repetitions across rounds. A fix-and-pass link requires a failed finding-bearing attempt, a directly activated corrective child with verdict pass and `state=passed`, and a later passing originating-stage attempt descended from that child. Count each occurrence once. For corroboration, screen every single-finding failure with a directly activated passing corrective report: its summary must match both `before|до|на баз|на стар|red|червон` and `after|після|green|зелен` (case-insensitive). Read each candidate and count only evidence that the same defect fails before correction and passes after, or measured before/after UI evidence corroborates it. A fix-and-pass link alone proves acceptance, not existence of the original defect. Remaining findings are unadjudicated.
7. Time is `(completedAt-startedAt)` in minutes for verdict-bearing attempts with valid timestamps: wall time includes waits, checks and publication. Token usage comes from the retained linked `agentPath` JSONL, with records bounded to `[startedAt, min(completedAt, snapshot)]`. Codex: sum `token_usage_record.payload.usage` once per `response_id`. Claude: group assistant `message.usage` by message id, keep the maximum of each counter across repeated streaming fragments, then sum once. Input includes cache reads and writes; Codex cached input is already inside input_tokens, while Claude input adds input_tokens, cache_read_input_tokens and cache_creation_input_tokens. Output includes reasoning already counted by the provider. Never add cumulative token_count or reasoning counters again.
8. Report timing and token coverage alongside medians. The 1,315 usable linked transcripts all contain the required usage envelopes; parsing had zero errors. Coverage means a retained transcript was measurable, not that every retired launch or recovery transcript survived. Do not treat these token totals as complete machine expenditure or multiply by current API prices. 526 Claude transcripts carry undated session cost estimates; these cannot be scoped reliably to the attempt window. Attempt-level monetary cost and paid-credit use are therefore unmeasured.
9. Preserve the task’s decision thresholds: frontend high needs at least 15 observed lanes against `5/11` (45.5%); GPT-6 Sol needs at least 30 against Astra medium’s recorded 65% at n=31. Those details specify no threshold for other roles. This report adds a conservative descriptive flag `small` whenever a group has fewer than 30 distinct verdict-bearing pipelines; it authorizes no additional role-switch rule.

At the snapshot, 210 pipelines were completed, 47 closed, 29 running and 9 awaiting a decision. There were 1,496 attempts: 1,326 recorded verdicts (896 pass, 382 fail, 48 needs_decision) and 170 without a verdict. The latter include 66 failed and 35 needs_decision lifecycle attempts, 29 pending, 37 running/spawning and 3 skipped. Their causes must not be assigned to model quality.

## Recorded outcomes and resource use

Each row includes initial work and fix variants. `Lanes` counts distinct pipelines with a verdict; repeated attempts are correlated. `No verdict` includes unfinished and operationally stopped attempts. Time and token medians each use n in parentheses; input is in millions, output in thousands. All rates describe this selected workload.

| Role | Engine / model / effort | Lanes | Pass / reports (%) | No verdict | Median min (n) | Median input M / output k (n) | Sample |
|---|---|---:|---:|---:|---:|---:|---|
| architect | claude / fable / high | 0 | unobserved | 1 | unmeasured | unmeasured | small |
| architect | claude / opus / high | 22 | 25/25 (100.0%) | 2 | 11.9 (24) | 10.50 / 61.6 (24) | small |
| architect | claude / opus / xhigh | 25 | 35/35 (100.0%) | 4 | 26.1 (33) | 24.51 / 144.6 (33) | small |
| architect | codex / gpt-6-astra / high | 1 | 1/1 (100.0%) | 0 | 22.0 (1) | 4.66 / 37.4 (1) | small |
| architect | codex / gpt-6.1-sol / high | 3 | 4/4 (100.0%) | 0 | 8.1 (4) | 2.03 / 15.1 (4) | small |
| architect | codex / gpt-6.1-sol / xhigh | 6 | 6/6 (100.0%) | 0 | 20.8 (6) | 5.47 / 41.5 (6) | small |
| builder | claude / claude-sonnet-5-5 / high | 17 | 31/31 (100.0%) | 6 | 14.5 (30) | 2.18 / 18.0 (30) | small |
| builder | claude / opus / high | 90 | 249/256 (97.3%) | 39 | 37.2 (255) | 7.53 / 42.8 (255) | 30+ lanes |
| builder | codex / gpt-6-luna / high | 19 | 43/45 (95.6%) | 0 | 24.2 (45) | 14.63 / 40.3 (45) | small |
| builder | codex / gpt-6.1-sol / high | 133 | 229/255 (89.8%) | 32 | 32.1 (251) | 12.23 / 41.9 (251) | 30+ lanes |
| builder | codex / gpt-6.1-sol / medium | 2 | 2/4 (50.0%) | 0 | 5.4 (4) | 2.58 / 9.0 (4) | small |
| builder | codex / gpt-6.1-sol / unknown | 1 | 3/3 (100.0%) | 0 | 13.5 (3) | 4.67 / 13.8 (3) | small |
| builder | codex / gpt-6.1-sol / xhigh | 21 | 20/26 (76.9%) | 27 | 36.9 (25) | 12.59 / 59.6 (25) | small |
| custom | codex / gpt-6.1-sol / high | 1 | 1/6 (16.7%) | 0 | 4.2 (6) | 1.42 / 7.3 (6) | small |
| merger | codex / gpt-6.1-sol / high | 19 | 15/28 (53.6%) | 6 | 4.3 (28) | 1.09 / 7.1 (28) | small |
| prod-auditor | claude / opus / high | 1 | 1/3 (33.3%) | 1 | 3.3 (3) | 2.37 / 13.8 (3) | small |
| prod-auditor | codex / gpt-6.1-sol / xhigh | 12 | 13/15 (86.7%) | 3 | 10.3 (15) | 4.53 / 35.2 (15) | small |
| reviewer | claude / opus / high | 46 | 43/95 (45.3%) | 10 | 8.3 (94) | 4.35 / 26.4 (94) | 30+ lanes |
| reviewer | claude / opus / xhigh | 9 | 8/25 (32.0%) | 1 | 18.5 (25) | 12.90 / 66.8 (25) | small |
| reviewer | codex / gpt-6-luna / high | 2 | 2/2 (100.0%) | 0 | 4.5 (2) | 1.61 / 8.6 (2) | small |
| reviewer | codex / gpt-6.1-sol / high | 30 | 27/53 (50.9%) | 2 | 8.6 (53) | 3.07 / 12.3 (53) | 30+ lanes |
| reviewer | codex / gpt-6.1-sol / medium | 3 | 3/4 (75.0%) | 0 | 8.2 (4) | 2.73 / 8.2 (4) | small |
| reviewer | codex / gpt-6.1-sol / xhigh | 134 | 105/331 (31.7%) | 30 | 12.1 (331) | 3.96 / 22.1 (331) | 30+ lanes |
| verifier | codex / gpt-6.1-sol / high | 6 | 5/9 (55.6%) | 0 | 14.5 (9) | 4.49 / 29.4 (9) | small |
| verifier | codex / gpt-6.1-sol / xhigh | 2 | 2/2 (100.0%) | 0 | 19.3 (2) | 6.38 / 35.4 (2) | small |
| visual-critic | claude / opus / high | 32 | 23/62 (37.1%) | 6 | 5.8 (62) | 2.42 / 15.5 (62) | 30+ lanes |

Covered reports consumed 13.110 billion recorded input tokens and 56.121 million output tokens. Input includes 12.834 billion cache-read tokens (97.9% of input) and 99.018 million Claude cache-write tokens. These are repeated provider-request inputs across long agent sessions, not unique prompt content.

## Independent first review and rounds

243 pipelines have an eligible initial builder; 187 have a reachable first review. The following rounds refer to the selected reviewer stage, regardless of which model performs later fixes.

| Initial builder engine / model / effort | First-review pass / observed (%) | Unobserved | Median rounds to pass (completed sequences) | Sample |
|---|---:|---:|---:|---|
| claude / claude-sonnet-5-5 / high | 3/3 (100.0%) | 2 | 1 (3) | small, below 30 |
| claude / opus / high | 18/61 (29.5%) | 11 | 2 (44) | 30+ observed |
| codex / gpt-6.1-sol / high | 57/112 (50.9%) | 14 | 1 (93) | 30+ observed |
| codex / gpt-6.1-sol / xhigh | 3/11 (27.3%) | 29 | 2 (7) | small, below 30 |

The frontend subset uses its own first frontend builder, so it overlaps rather than partitions the table above.

| Frontend engine / model / effort | First-review pass / observed (%) | Unobserved | Recorded 15-lane threshold |
|---|---:|---:|---|
| claude / claude-sonnet-5-5 / high | 2/3 (66.7%) | 4 | small, below 15 |
| claude / opus / high | 8/24 (33.3%) | 9 | met; below descriptive 30 |
| codex / gpt-6.1-sol / high | 2/3 (66.7%) | 0 | small, below 15 |
| codex / gpt-6.1-sol / medium | unobserved | 1 | small, below 15 |

Opus high’s first 15 observed frontend lanes passed 7/15 (46.7%), narrowly above 5/11; its full 24-lane sample passed 8/24 (33.3%). The guardrail changes its signal as the cohort matures. Use the full current sample for the recommendation and retain the first-15 result as a sensitivity check.

| Review role / engine / model / effort | Sequences passed / observed | Median rounds to pass | Maximum rounds to pass | Sample |
|---|---:|---:|---:|---|
| reviewer / claude / opus / high | 38/46 | 1 | 5 | 30+ lanes |
| reviewer / claude / opus / xhigh | 8/11 | 2 | 6 | small, below 30 lanes |
| reviewer / codex / gpt-6-luna / high | 2/2 | 1 | 1 | small, below 30 lanes |
| reviewer / codex / gpt-6.1-sol / high | 27/29 | 1 | 7 | small, 29 homogeneous lanes |
| reviewer / codex / gpt-6.1-sol / medium | 3/3 | 1 | 2 | small, below 30 lanes |
| reviewer / codex / gpt-6.1-sol / xhigh | 100/137 | 1 | 6 | 30+ lanes |
| verifier / codex / gpt-6.1-sol / high | 5/6 | 1 | 1 | small, below 30 lanes |
| verifier / codex / gpt-6.1-sol / xhigh | 2/2 | 1 | 1 | small, below 30 lanes |
| visual-critic / claude / opus / high | 23/32 | 2 | 4 | 30+ lanes |

For example, Sol xhigh review has 37 unresolved homogeneous sequences versus 2 for Sol high. A median of one round among completed sequences hides that difference. Assignment difficulty, domain, reviewer strictness, recovery and recent unfinished lanes confound all effort comparisons.

## Findings later corroborated

948 finding occurrences were reported; 351 have the strict fix-and-pass link defined above. The stored verdicts have no systematic per-finding real/false adjudication. All 86 single-finding follow-ups selected by the corroboration screen were read; 42 were conservatively counted as corroborated. The other 906 remain unadjudicated, including multi-finding reports and follow-ups without explicit proof. Every corroborated count below is smaller than 30; none supports a model ranking or an overall confirmation rate. The analysis reads recorded evidence and does not rerun those historical reproductions.

| Reporting role / engine / model / effort | Findings | Fix-and-pass-linked | Later corroborated lower bound | Role sample |
|---|---:|---:|---|---|
| builder / codex / gpt-6.1-sol / high | 3 | 0 | unadjudicated | 30+ lanes |
| builder / codex / gpt-6.1-sol / medium | 2 | 1 | unadjudicated | small, below 30 lanes |
| custom / codex / gpt-6.1-sol / high | 10 | 9 | unadjudicated | small, below 30 lanes |
| merger / codex / gpt-6.1-sol / high | 11 | 2 | unadjudicated | small, below 30 lanes |
| reviewer / claude / opus / high | 127 | 64 | at least 9 | 30+ lanes |
| reviewer / claude / opus / xhigh | 35 | 15 | unadjudicated | small, below 30 lanes |
| reviewer / codex / gpt-6.1-sol / high | 61 | 42 | at least 5 | 30+ lanes |
| reviewer / codex / gpt-6.1-sol / medium | 3 | 3 | unadjudicated | small, below 30 lanes |
| reviewer / codex / gpt-6.1-sol / xhigh | 566 | 161 | at least 25 | 30+ lanes |
| verifier / codex / gpt-6.1-sol / high | 16 | 0 | unadjudicated | small, below 30 lanes |
| visual-critic / claude / opus / high | 114 | 54 | at least 3 | 30+ lanes |

- Sol xhigh reviewer: a completed provider-cut chain left its confirmation clock attached to a later chain. The corrective follow-up recorded the exact engine reproduction as 4/4 failing before and 4/4 passing after the fix; a later independent review said that original scenario was closed while identifying additional variants. This is a real finding even though the stage had not reached a final pass.
- Opus high reviewer: discarding a delivery cancelled during account migration returned 503 and then prevented retry. The corrective follow-up reproduced the old failure; an independent later review repeated the failing-first baseline controls and confirmed durable discard with retry refused after discard. The isolated HTTP suite passed 64/64.
- Opus high visual critic: a phone re-check result remained clipped, leaving no visible change after the tap. The corrective follow-up recorded changed before/after phone frames and status/excerpt widths; the independent next visual review confirmed the status time visible at 390 px across both languages and themes. This is corroboration reported by those stages; this analysis did not rerender their evidence.

## Recommendations for the role table

| Row | Recommendation from this sample | Limit |
|---|---|---|
| Frontend builder | For the Opus frontend mapping evaluated here, apply the recorded high-to-xhigh guardrail: 24 observed lanes exceed 15, and 33.3% is below 45.5%. Use xhigh for that mapping pending a fresh 15-lane review. | There is no Opus xhigh frontend comparator in this cohort. The current shipped Sonnet high variant has only 3 observed frontend lanes; keep that experiment explicitly below threshold and do not transfer the Opus result to Sonnet. |
| Standard builder | Schedule a 30-observed-lane Astra medium comparison using this method before selecting a replacement default. Keep Sol at high during that comparison; the xhigh sample has only 11 first reviews. | Standard GPT-6.1 Sol high is 50.5% at n=109, below the task’s historical Astra medium 65% at n=31. The exact original GPT-6 Sol cohort is absent, and there are no current Astra medium builder lanes. Applying the old guardrail to GPT-6.1 would favour Astra, but a same-conditions switch claim cannot be made. |
| Reviewer | Keep the current Sol xhigh default for now; compare high on matched backend assignments before changing it. Preserve independent review and fix loops. | High took a median 8.6 min and 12.3k output tokens; xhigh took 12.1 min and 22.1k. Their pass rates (50.9% versus 31.7%) and corroborated findings do not establish which catches more real defects. |
| Prod-auditor | Keep the current configured mapping pending at least 30 comparable audits; collect evidence completeness and access gaps. | Sol xhigh has 15 verdicts across 12 lanes, Opus high 3 across 1; Astra high has zero. The earlier Astra high recommendation cannot be revalidated. |
| Architect, verifier, merger and other roles | Make no model change from this cohort. Retain visual criticism as a separate check. | Every architect, verifier and merger seat is below 30 distinct lanes. Orchestrator, cleaner, deployer, maintainer and issue-reporter have zero stage samples. |

PR #2174 recommended frontend Opus high, prod-auditor Astra high and choosing Sol high versus Astra medium after 30 first reviews. The checkout at `e5cd0ff3d` now ships frontend `claude/claude-sonnet-5-5/high`, and reviewer/prod-auditor `codex/gpt-6.1-sol/xhigh` in `src/lib/roles/paramConfig.ts` and `src/lib/roles/defaults.ts`. The attempt records reflect their launch-time configurations. This report changes no presets or product code.

Validation: independent run traversal reconciled 295 unique pipelines, 1,496 attempts, 1,326 verdicts, 948 findings and 1,315 timing/token-covered reports. The diff was reviewed and the local privacy gate passed against the merge base with committed fingerprints and commit checks. Raw SQLite snapshots, transcript paths, follow-up text and account metadata are excluded from publication.
