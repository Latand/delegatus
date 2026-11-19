# Brief fences that stop their own work

Originating requirement, 2026-11-12: measure how often an orchestrator adds a restriction that prevents an agent from completing the requested work, how the restriction is subsequently changed, and what that interruption costs. Cover seats running on Claude and Codex. This paragraph paraphrases the private request. Public source: [issue #3916](https://github.com/Latand/delegatus/issues/3916).

To apply this analysis, first trace each acceptance criterion to an action and its responsible stage. Then identify the authority behind each restriction. Keep restrictions protecting production, data and another owner's work; resolve a contradiction introduced by the seat before launching its worker. The proposals below change brief preparation and stage boundaries. This issue implements no product or prompt changes.

## Result

The retained records confirm the reported problem on both seat engines. In a cohort of **254 pipelines**, a conservative causal reading found **14 fence-caused stage outcomes in 11 pipelines**: two Claude-created pipelines and nine Codex-created pipelines. These comprise eleven decision stops followed by in-lane fence amendments, two failed reviews in one workflow lane, and the connection-reset decision stop, whose production restriction remained in force. A further decision clarified already available read authority; it is reported separately.

The eleven in-lane amendments affected nine Codex-created pipelines. Their recorded waits total **49 h 57 min 59 s of task time**, with a median of **8 min 45 s**. A Claude-created workflow pipeline was replaced after its restriction against test edits made its own required check fail. The records support removing unsupported file, mechanism and phase restrictions. They also show legitimate reasons to stop, including foreign-process inspection and an explicit personal-review hold.

These are observations about this week's work mix and instruction packages. They establish no causal ranking of Claude against Codex. All eleven amended decision attempts used Codex workers, including work commissioned by different seats; author engine and worker engine are separate fields throughout this analysis.

## Method and coverage

### Frozen population

A read-only SQLite query captured the active and archived pipeline collections on 2026-11-12 at **06:41:30 UTC**. The retained store contained 3,269 pipeline records across projects, of which 2,151 belonged to Delegatus. The cohort includes every Delegatus pipeline created from **2026-11-05 00:00 UTC** through that capture, excluding the pipeline producing this analysis. It contains 254 pipelines, 715 stage definitions and 1,002 attempts. Later work and later answers cannot alter the counts in this report.

The database was opened using SQLite URI read-only mode with `query_only` enabled. The audit selected stored JSON records and parsed transcript lines as data. No command, suggested repair, replay, deployment or cleanup from a transcript was executed. No application store module was imported. Scratch calculations and the private source ledger are retained outside the repository; the public document contains neither record identifiers nor private transcript excerpts.

Seat attribution uses the pipeline's recorded source transcript, independently checked for the delivered orchestrator mandate. All 51 distinct source transcripts had that mandate: 13 Claude conversations and 38 Codex conversations. Multiple conversations can be rotations of the same project seat; these counts describe conversations, without claiming independent operators or independent experimental subjects.

| Cohort measure | Claude seat author | Codex seat author | Total |
| --- | ---: | ---: | ---: |
| Pipelines | 132 | 122 | 254 |
| Stage definitions | 409 | 306 | 715 |
| Attempts | 575 | 427 | 1,002 |
| Attempts with a stored report | 512 | 363 | 875 |
| Stored decision verdicts, before exclusions | 10 | 19 | 29 |
| Substantive decision reports after exclusions | 7 | 19 | 26 |
| Pipelines with substantive decision reports | 7 | 16 | 23 |
| Pipelines with the conservative fence-caused outcomes above | 2 (1.5%) | 9 (7.4%) | 11 (4.3%) |

The last row counts each pipeline once, regardless of repeated questions. Its numerator includes failed reviews as well as decision verdicts. The comparison is descriptive: the Codex cohort contains many tightly bounded backend investigations and coordinated storage changes. The Claude cohort includes many shorter UI, documentation and maintenance lanes. Outcomes were still in progress at capture, so this is an observed lower bound for the cohort.

### Briefs, outcomes and attribution

The audit read retained specifications, stage prompts, attempt-bound prompt definitions, effective role scaffolds, reports, errors and decision answers. It also read the source conversations' recorded creation and spawn calls. Initial creation arguments were recoverable for **241 pipelines: 122 Claude-created and 119 Codex-created**. Those launch arguments provide the wording-frequency denominator below. The remaining thirteen pipelines stay in the outcome cohort; their initial creation wording is unavailable through the matched source call. Current stored wording is not silently substituted for initial wording.

The source conversations additionally retained **96 distinct spawn request keys** in the window: 41 from Claude seats and 55 from Codex seats. Repeated calls under the same key were folded. These are requests, including refused launches, from the selected source conversations. They are not a census of all project spawns or a count of successful workers. Three spawn briefs per engine were read closely: a verifier, a cleaner and a deployer. Their restrictions and authority handling inform the source comparison; their outcomes are excluded from the pipeline stop rate.

Earlier-answer searches used several phrasings, project-scoped and then unscoped. Relevant hits were opened through the normalized conversation reader. The existing [role prompt inventory](role-prompts-rewrite.md) and [memory-to-prompt analysis](role-memory-to-prompts.md) identify instruction layers, but provide no current fence-stop denominator. Primary pipeline and transcript records supply that denominator here. Search totals were discarded: the index folds repeated prompts, ignores some query words, and searches message bodies rather than all tool arguments.

Four origins are kept separate:

1. **Operator or project boundary:** an actual access, destructive-action, publication, production or parallel-ownership requirement.
2. **Role or controller boundary:** read-only reviewer access, declared document outputs, branch ownership and controller publication. These are generated independently of the seat's free-text brief.
3. **Seat addition:** a file allowlist, a forbidden dependency, a mandated implementation shape, a verification prohibition or a fresh approval condition in the supplied specification or prompt.
4. **Unproved origin:** a restriction repeated in a brief without evidence of who first introduced it. Repetition alone cannot establish invention by that seat.

A fence-caused outcome needs an identified restriction, an action needed for acceptance, a report explaining why it cannot proceed, and corroborating code, transcript or subsequent answer. A reversal additionally needs a recorded authorization or replacement brief changing that restriction. Missing credentials, technical failures and operator skips do not become fence reversals merely because the same brief contains safety language.

### Avoiding status-only counts

There were **87 attempts whose stored state was `needs_decision`**: 28 also carried that verdict, three retained a passing verdict under a later controller hold, and 56 had no verdict. Those nonmatching states had controller or dispatch causes, including privacy-worker failures, changed snapshots, missing checkouts, delivery interruptions and unavailable runtime configurations. Separately, the 29 stored decision verdicts include one attempt now marked skipped. Two of those verdicts had no worker report and represented interruption; the skipped verdict was an operator skip. Removing those three leaves 26 substantive reports.

Failed attempts were screened as well, using restriction, scope and inability language in their reports and errors. Six additional textual candidates were read with their surrounding attempts. Two failed reviews in the workflow example qualified as fence-caused outcomes; the others concerned real defects, external access or preserved policy. This screen can miss an indirectly described stop, so the causal total remains conservative. Passing attempts were not exhaustively audited for silent abandonment or acceptance weakened without a question.

## Fences by kind and source

The table below measures **explicit wording indicators in the 241 recovered initial launch briefs**, with specification and supplied stage prompts combined once per pipeline. It excludes injected role scaffolds, generated controller instructions and later decision answers. Indicators overlap. These are reproducible phrase-presence counts, not a complete semantic count of every prohibition.

| Indicator and matching rule | Claude, denominator 122 | Codex, denominator 119 | Interpretation |
| --- | ---: | ---: | --- |
| A fence heading: singular or plural followed by a colon/comma, or a fence/overlaps heading | 74 | 42 | Explicit fence or coordination sections; a heading alone proves no ban |
| Explicit live-state read-only formulations, including production-is-read-only and read-only-on-production variants | 11 | 0 | Narrow wording family; compressed prohibitions on live writes are missed |
| Literal no-deploy formulations, including no-production-deploy and no-restart/signal/deploy | 9 | 9 | Compound lists also contain deployment bans and are outside this narrow indicator |
| A negative clause naming recorded checks, native waits, the check-wait tool or custody handoff within 85 characters | 36 | 83 | Repeated verification-mechanism restriction in both cohorts |
| A negative clause naming reset, cleanup, rewrite or rebase within 85 characters, or a direct never/do-not form | 46 | 52 | Includes cleanup restrictions; it does not imply every match forbids amending a commit |
| Explicit all-stage engine wording or a pinned engine/model/runtime phrase | 0 | 10 | Runtime choices are usually supplied as configuration instead |

The live-read-only zero for Codex describes this vocabulary only. Its briefs frequently express the same boundary through compressed lists of forbidden product, board and live changes. It would be incorrect to conclude that Codex seats grant unrestricted production access.

At launch, an explicit model override appeared in **55/122 Claude-authored** and **105/119 Codex-authored** pipelines; an explicit account override in **6/122** and **70/119**; a service-tier override in **24/122** and **69/119**. A launch override can implement an operator choice or registry requirement. Its presence alone establishes neither an unnecessary pin nor a harmful fence. Two retained attempts refused an unavailable pinned service tier; their current stage definitions had already changed to a supported tier. Those are configuration/admission events, outside the 26 worker decision reports.

The substantive stop records provide the semantic classification that phrase counts cannot:

| Primary reason in the 26 decision reports | Claude author | Codex author | Subsequent treatment |
| --- | ---: | ---: | --- |
| Needed source, schema, runtime-contract or CI file excluded | 0 | 9 | Nine narrow scope amendments, including three on one lane |
| Required fixed implementation shape contradicted accepted input domain | 0 | 1 | Mechanism restriction lifted |
| History prohibition prevented a checked publication repair | 0 | 1 | One narrowly approved amend; personal hold preserved |
| Existing read authority unclear or misrouted | 0 | 1 | Authority clarified without a new broad grant |
| Production boundary plus an unproved live failure | 1 | 0 | Fresh read-only case supplied; production boundary retained |
| Reviewer asked to settle merge/seat responsibilities | 2 | 0 | Seat took the external action or separated the later gate |
| Bounded report confused with full outcome acceptance | 0 | 2 | Report accepted with historical/runtime gaps still explicit |
| Explicit personal-review hold | 1 | 1 | Kept until the person's decision |
| Real semantic conflict or shared-hunk sequencing | 1 | 1 | Behavior selected or sequencing still required |
| Full fixture would inspect unrelated live processes | 0 | 1 | Unsafe criterion stopped; limited report accepted |
| Missing credential, unavailable runner, unknown check or changed measurement target | 2 | 2 | Access, evidence or target limitation; no automatic fence removal |
| **Total** | **7** | **19** | |

The first three rows are the eleven in-lane amendments. The production row adds the twelfth decision outcome in the conservative fence-caused total. The two workflow review failures bring that total to fourteen. Existing-authority clarification and the phase-boundary mistakes are useful corrective cases, reported separately to avoid inflating direct fence causation.

## Reversals and their cost

Elapsed cost is measured from the attempt's **completed timestamp to its matching decision answer timestamp**. Report timestamps and final transcript messages can precede settlement; using them would mix different clocks. These waits are task-hours and can overlap across lanes. They do not measure CPU use, token spend or recoverable calendar time.

| Amendment needed | Seat engine | Date of stop, UTC | Wait until answer |
| --- | --- | --- | ---: |
| Remote-refusal classification needed controller consumers beyond two allowed files | Codex | Nov 6 | 7 min 53 s |
| Queue-card continuity needed authorized server readback beyond UI files | Codex | Nov 6 | 4 min 47 s |
| Board-name lookup needed response and workspace-authority paths beyond bindings | Codex | Nov 6 | 1 min 39 s |
| Native-platform acceptance needed the existing CI selection beyond allowed files | Codex | Nov 6 | 9 h 20 min 54 s |
| Generation-race acceptance needed an excluded recovery guard | Codex | Nov 6 | 9 h 0 min |
| Unhealthy-seat acceptance needed a runtime-owned health/admission contract | Codex | Nov 6 | 9 h 2 min 56 s |
| Publication repair needed one amend of an unpublished fixture change | Codex | Nov 7 | 21 h 46 min 33 s |
| SQL equivalence needed removal of a fixed sixteen-pattern limit | Codex | Nov 8 | 8 min 51 s |
| Recipient delivery needed a pipeline-store interface | Codex | Nov 9 | 8 min 43 s |
| Same recipient lane then needed archive write/index coverage | Codex | Nov 9 | 6 min 59 s |
| Same recipient lane then needed interruption-store indexing | Codex | Nov 9 | 8 min 45 s |

Unrounded observations sum to 179,878.969 seconds; median 525.256 seconds, minimum 99.055 seconds and maximum 78,392.851 seconds. Round the aggregate once, rather than summing rounded table cells.

Every row has a worker reporting attempt, a seat answer and a subsequent attempt start. Thus the records establish **eleven question/answer exchanges and eleven follow-on worker attempts**. These are workflow exchanges, not a count of model-internal turns. At least one amendment required a personal decision. The stored actor on an answer is the seat even when it relays a person's approval; it cannot be used to count human interventions. Complete human turns, model cost and resumed-context re-reading cost were not measured.

Long waits include scheduling and legitimate approval time. The evidence does not justify claiming all fifty task-hours could have been saved. It does justify eliminating the need to rediscover the same excluded dependencies and distinguishing a real personal hold from a technical choice the seat can settle.

### Connection resets: confirmed stop, qualified source, no reversal

A Claude seat commissioned a Codex builder to finish a connection-reset investigation. The supplied specification limited live state to reads. The effective builder scaffold separately required a Deployer and explicit approval for deployment. Isolated checks passed: 67 tests and probes passed, four tests were skipped, and an injected post-commit socket cut recovered one saved receipt without a duplicate write. The actual spontaneous reset and the peer responsible remained unproved.

The worker requested scoped production tracing and one controlled acceptance write. Its decision report was recorded at **06:26:38**, and the attempt completed at **06:27:39** on Nov 12. At **06:28:33**, the seat supplied a fresh failure window and directed further read-only investigation. The next attempt started at **06:28:36**. Settlement-to-answer wait: **54.256 seconds**.

The seat later described both restrictions as its own invention. The effective prompt supports a narrower attribution: live-read-only is present in its supplied specification; the deployment condition also exists in the stored role scaffold and current builder defaults. The seat's recollection cannot erase that inherited source. Neither the answer nor the next input lifted the production boundary. This case is a fence-dependent reroute combined with a real evidence gap. Removing every production restriction would not establish the missing causal evidence.

### Workflow timeout: the brief forced a passing test back to red

A Claude-authored brief asked to raise a workflow job limit from fifteen to thirty minutes and explicitly prohibited test changes. The required workflow test asserted the old limit. The builder initially updated both. The first review failed the extra test edit for violating scope. A fix then removed that edit, reporting a passing stage despite the test becoming red. The next review independently established four passing tests on base and three passing plus one failing on head.

This is a direct contradiction between the allowed diff and required checks. The seat replaced the lane with a brief allowing the workflow and its test. The replacement was created on Nov 11 at **13:24:07**, about **4 min 48 s** after the second failed review completed, and before closing the predecessor. The bounded test-update acceptance was subsequently observed in the replacement review. Its later question concerned separate review/seat duties and is already included in the decision classification above.

The extra builder fix and second review are demonstrated work caused by the restriction. The audit does not price their complete runtime as waste. A preparation check tracing the changed value to its direct regression test would have found the contradiction before launch.

### Repeated recipient-delivery amendments

A Codex seat required recipient delivery to avoid unrelated global preparation, while excluding pipeline-store changes. The worker demonstrated that a keyed membership lookup omitted real attempt owners and that the available reader still performed global preparation. The seat permitted a narrow reader/helper extension.

The next substantive attempt proved that cold archived ownership required a write-time index, which the amendment still excluded. A second amendment permitted that existing projection to cover archives. A later attempt found the same missing recipient coverage in interruption evidence, beyond the second amendment's scope. A third amendment permitted the existing interruption index to cover it.

These three answers consumed **24 min 26.598 s** of settled waiting in one lane. A controller snapshot interruption between them was excluded from that total. The new prerequisites were evidenced, and preserving neighboring ownership was appropriate. The avoidable pattern was authorizing one leaf at a time without walking the full acceptance path through active owners, archived owners and interruptions before naming forbidden areas.

### Fixed SQL shape and broad history wording

Another Codex brief required equivalence with the existing writer/reader domain while preserving exactly sixteen retry patterns. An isolated counterexample with a seventeen-digit retry was accepted by the existing reader but missed by both SQL candidates. The seat removed the fixed-pattern clause after **8 min 51 s**, preserving the input domain and lifecycle guards. Restricting the implementation shape served no demonstrated safety boundary.

In a separate lane, broad source-reset/cleanup/rewrite language prevented a one-line repair to an unpublished fixture commit that the publication scanner would continue seeing in history. A person approved one amend, with an original-commit backup and normal hooks. The operation completed; the subsequent personal-review hold remained binding. This is evidence for specifying the protected history and exact permitted repair route. It supplies no authority to rewrite published or foreign work.

## Fences that were justified

The strongest positive control was a fixture-verification lane commissioned by a Codex seat. One full test file called disk-pressure code that inspects unrelated process working directories, file descriptors, command lines, mappings and environments. Redirecting home and application state did not isolate that machine-wide access. The worker ran the safe MCP test file, stopped the unsafe criterion and retained unconfirmed runtime coverage. The seat accepted only the bounded report. This observed stop avoided executing the identified foreign-process read path; no claim is made that executing it would certainly have caused damage.

The personal-review holds in both cohorts were explicit acceptance boundaries. One protected prompt changes awaiting a person's review; another protected the result of the narrowly approved history repair. They were not invitations for the seat to reinterpret a missing response as approval.

A shared-source repair also stopped on actual overlapping ownership changes, rather than treating every nearby filename as forbidden. Another stopped on a semantic merge conflict requiring a behavior choice. These are defensible coordination stops. The remedy is an owner and sequencing decision, with the code preserved.

The missing native runner and missing credential cases carried independent factual blockers. Lifting a prose restriction would supply neither resource. A retained release-repair failure likewise combined an unavailable supported integration handoff with insufficient workflow-permission evidence. Its prohibition against bypassing publication controls was appropriate.

Spawn briefs show the same distinction. The sampled cleaner briefs preserved live and unknown work, required exact preconditions and backed destructive operations with explicit authority. The sampled verifier briefs separated evidence gathering from the seat's later closure. Both sampled deployer briefs carried existing approval and named the release procedure. Their wording demonstrates that a fence can carry an authorized continuation route. These samples establish brief content, without asserting an observed safety benefit or a spawn stop rate.

## Where habitual fences are taught

Source locations below refer to the checkout captured for this analysis. Historical attempt scaffolds were inspected separately; changed source text does not retroactively describe what an earlier worker read.

| Teaching surface | Current location | Observed contribution and limit |
| --- | --- | --- |
| Mandate's brief-writing rule | `src/lib/orchestrator/prompt.ts:649` | Asks the seat to include fences and identifies files/areas other open lanes change. It provides no acceptance-versus-fence check or reason requirement. |
| Mandate's unobserved-fact rule | `src/lib/orchestrator/prompt.ts:641` | Sends a stage to ask when observation fails; it can turn a bounded report gap into a needless decision unless the stage's finish line is clear. |
| Shared precedence and scope rules | `src/lib/roles/defaults.ts:45`, `:49`, `:53` | Treat safety fences as hard limits and protect parallel work. The distinction between an actual owner boundary and a seat's guessed file list is under-specified. |
| Builder safety fence | `src/lib/roles/defaults.ts:304` | Supplies the deployment/approval restriction seen in the reset worker's effective scaffold. The restriction has a role source even when the seat repeats it. |
| Production auditor and deployer | `src/lib/roles/defaults.ts:337`, `:354` | Production reads require named access; mutating release steps need current authority. The deployer already recognizes approval relayed by the spawning seat. |
| Role composition | `src/lib/roles/registry.ts:177`, `src/lib/pipelines/roles.ts:70` | Appends safety fences to the role body. A recurring delivered sentence can originate here rather than in the supplied brief. |
| Controller wrapper | `src/lib/pipelines/prompts.ts:110` | Enforces read-only outputs and assigns publication to the controller. A reviewer cannot close a PR simply because lane acceptance mentions closure. |
| Conveyor playbook | `.claude/skills/delegatus-conveyor/SKILL.md:14`, `:38`, `:47` | Explicitly teaches scope fences and parking/recovery. Its deployment section describes seat authority separately. Other legacy operational advice requires verification against current code before reuse. |
| Orchestration playbook | `.claude/skills/delegatus-orchestration/SKILL.md:43` | Protects dirty recovery and ownership. This is a concrete reason for a destructive-action fence, without supporting an arbitrary ban on dependent source files. |
| Live learned guidance | Local role-memory search and opened records | Current entries contain relevant brief/recovery guidance. Their private text and identifiers are excluded here. Current availability proves neither historical injection nor that a specific seat followed them. |

The repeated check-recording bans deserve a scoped follow-up. Current learned guidance and the controller's recording instructions have conditions; many supplied briefs carried compact blanket prohibitions. The initial briefs show the repetition, but this audit found no basis for assigning all of it to one remembered rule. The two observed unknown-log-path stops demonstrate a concrete custody/path problem. They do not justify forbidding the supported recording path for every later stage.

The public [prompt-layer inventory](role-prompts-rewrite.md) already describes how role bodies, safety fences, mandates, memories and wrappers accumulate. This week's evidence adds the missing behavioral consequence: a restriction written at one layer can conflict with acceptance written at another, and the worker correctly obeys the restriction.

## Proposals

### Require a reason for task-specific restrictions

Before launch, each added restriction of the following kinds should name its source, protected resource, current reason, and continuation owner:

| Restriction | Required reason and continuation |
| --- | --- |
| A file/area ban covering a likely acceptance dependency | Actual shared hunk, active owner or policy boundary; name who supplies the dependency and how the lane proceeds |
| A read-only or no-runtime-change condition attached to live acceptance | Production risk and existing access authority; assign any required write/capture to an authorized later stage, or define a bounded diagnostic deliverable |
| A restart, deployment or fresh-approval condition | Project release policy and current recorded approval; carry an existing approval through its stated scope |
| Stop-and-ask on an engineering fact | State which unavailable fact changes the result, what was tried, and why the seat cannot resolve it within current authority |
| Account, engine, model or service-tier pin | Operator choice, access requirement or measured compatibility constraint; keep it in launch configuration and validate availability |
| A ban on recording, waiting, a particular check or CI action | The current unsafe mechanism, custody condition or missing permission; name the supported alternative and scope the restriction's expiry |
| A fixed implementation shape or history-repair prohibition | The invariant it protects; distinguish published/foreign history from the lane's unpublished work and name any approved repair route |

Existing project policy can be referenced once. The seat need not recopy the project's instruction file into every brief. A reason is evidence to review; it never grants the worker authority to override a controller, operator or project boundary.

### Check acceptance against restrictions before launch

Use a short preparation check in the existing brief-writing step. It can start as an advisory checklist; this analysis supplies no evidence for a new runtime service, schema, approval dialog or mandatory launch gate.

For each acceptance criterion, write the necessary action, the artifact or system it touches, the responsible stage/owner, and the authority that permits it. Compare those actions against supplied restrictions **and** the effective role/controller contract. Flag any required action with no permitted owner or continuation path.

Examples of useful diagnostics:

- A changed workflow value has a required test pinned to the old value, while tests are excluded.
- UI continuity requires authorized queue readback, while all server dependencies are excluded and nobody supplies them.
- Complete recipient authority requires archived and interruption owners, while only the active reader may change.
- SQL equivalence requires the full accepted input domain, while the brief fixes the number of patterns below that domain.
- A reviewer is required to close a superseded PR or rerun CI while it has read-only access.
- Production write acceptance is assigned to a read-only builder with no authorized subsequent stage.

The diagnostic should show the conflicting criterion and restriction, its source and the missing owner/action. The seat then removes its unsupported restriction, assigns a permitted dependency, narrows only the current stage's finish line, or asks about a genuine unresolved boundary. It must preserve the full requested outcome as open when that outcome remains unproved.

A document-only architect stage can correctly leave PR creation to controller publication. A source reviewer can correctly pass its review while required CI still holds the merge. Both pass this preparation check when their later owner and finish line are explicit. A real personal-review hold and an unsafe live-state test also pass: the protected step has a deliberate boundary and a named unresolved prerequisite.

### Exact mandate and scaffold wording changes

These are proposed replacements for public source text, not private-rule quotations. No wording is applied by this issue.

**Mandate, replace the brief-writing bullet under How work runs** (`src/lib/orchestrator/prompt.ts:649`):

> The brief names the outcome, acceptance and each stage's deliverable. For every additional restriction, name its authority, current reason, protected resource and continuation owner. Read actual overlapping hunks before excluding files or areas. Trace acceptance through required dependencies and checks before launch. Resolve a restriction you introduced when it blocks that acceptance within your authority; ask the operator only when their decision is still needed. Keep required work with its existing owner or assign a permitted dependency. Delegatus supplies the reporting contract.

**Mandate, replace the unobserved-fact bullet under Before you decide** (`src/lib/orchestrator/prompt.ts:641`):

> Verify an external premise before relying on it. If it cannot be verified, name the missing observation and decide whether it blocks this stage's deliverable. A bounded evidence report may finish with that gap explicit. Acceptance that depends on the missing fact remains open; route its next observation to an authorized owner. Ask the operator when only their access or decision can provide it.

**Shared working rules, add to the scope rule** (`src/lib/roles/defaults.ts:53`, with its short form updated consistently):

> Scope protects the accepted outcome and actual parallel ownership. A listed file is a starting point for investigation. If an explicit restriction excludes a necessary dependency, show the dependency and return the question to its owning seat. The seat checks the whole required path before revising its restriction. Preserve controller access limits, project policy and other owners' changes.

**Builder, replace its blanket deployment safety sentence** (`src/lib/roles/defaults.ts:304`):

> The builder validates in isolated state. Any required production action belongs to the project's authorized release or operations owner under its release policy and current recorded authority. Name that handoff before treating production acceptance as this stage's finish line.

**Reviewer and verifier, add beside their finish-line rules** (`src/lib/roles/defaults.ts:266` and `:282`):

> Judge the artifact and acceptance assigned to this stage. Keep controller publication, CI admission, merge, deployment and task closure with their declared owners. State their pending status. If your required evidence is unavailable, identify the specific unresolved criterion; do not request new authority merely to perform another owner's step.

**Conveyor, replace the sentence requiring scope fences in every stage prompt** (`.claude/skills/delegatus-conveyor/SKILL.md:14`):

> Stage prompts name their deliverable, permitted work and verification. Add a scope restriction only with its source, protected resource and current reason. Required dependent tests and adapters need a permitted owner. Existing controller publication and project release procedures supply their own boundaries.

The deployer's existing recognition of approval relayed by its spawning seat should remain. Its authorization does not extend to a different project, new production action or wider approval scope. The mandate and shared rules must also preserve Git-only delivery paths, declared output exceptions, finite review budgets, uncertain-operation protection and explicit personal holds.

### Validate the change through behavior

For a future prompt revision, replay the concrete cases above against the effective composed prompt and a fixed set of stored briefs. Judge decisions and permitted action paths: whether the workflow/test contradiction is flagged; whether all recipient dependencies are assigned together; whether the SQL mechanism can change while its invariant stays fixed; whether a reviewer leaves closure to the seat; and whether the reset case keeps live writes unauthorized while continuing permitted reads.

Include controls that retain the foreign-process safety stop, personal-review hold and unknown-operation protection. Judge results blind to the seat engine and count complete outcomes, repeated scope questions and unnecessary operator questions. Tests should exercise those decisions or contracts; exact-phrase assertions over prompts would not establish the intended behavior. This issue makes no claim that the proposed wording has already improved agent behavior.

## Deferred — not currently justified

- A new permissions system, automatic fence removal, or widening worker production access. The observed defects can be addressed in preparation and ownership assignment.
- A mandatory semantic launch blocker or extra model call for every brief. Start with the existing seat's acceptance/dependency check and evaluate its observed decisions.
- Repository-wide removal of safety fences or learned guidance. Current text does not establish historical causation, and several fences protected real boundaries.
- A universal engine comparison or claim that changing models cures the problem. This cohort is observational and confounded by task mix, rotations and worker selection.
- Exact token, financial or recoverable-time savings. The retained record does not measure those counterfactuals.
- A complete standalone-spawn stop rate, a longer historical census and silent scope abandonment in passing stages. The request/response and historical-wording coverage needed for those estimates was not established here.

## Verification and acceptance

The report covers both seat engines, initial supplied briefs and sampled spawn prompts, inherited instruction layers, decision and failed-review stops, eleven timed amendments, a replacement brief, the reported connection-reset case, and justified restrictions. It separates observed facts from causal interpretation and preserves unresolved product acceptance.

Validation consists of read-only source reconciliation, arithmetic over frozen records, transcript checks on the detailed cases, final document privacy scanning and whitespace review. No product tests, build or typecheck are required for this document-only change. Private evidence retains the cohort, source calls, classification ledger, unrounded costs and hashes so another authorized reviewer can reproduce the counts without publishing identities. Publication and the pull request carrying Refs #3916 belong to the pipeline's publishing step.
