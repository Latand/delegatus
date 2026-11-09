# Learned rules and tool failures: prompt promotion research

Originating requirement, 2026-11-09: the private controller-pinned specification authorizes an audit of retained lessons across projects and time, including orchestrator tool-call failures. The requested outcome is generally applicable prompt guidance, a deployment-aware curator policy, independent review, and a prompt-only draft pull request for personal inspection. This is a sanitized restatement. The original wording and its follow-up remain in the private evidence package.

This document is an internal research handoff. It must stay out of the eventual product pull request. It changes no prompt, validator, runtime, setting or learned rule. Publication, merging, deployment and memory curation have not been performed.

## Conclusions and limits

The existing shared core already covers requirement anchoring, evidence, scope, isolation, privacy and uncertain effects. Preserve that work. Add a small argument-preparation rule, make retry guidance distinguish uncertain execution from a proved refusal, and give the orchestrator a verified parameter worksheet. Add the curator's deployment-and-audience equivalence check to both its scaffold and its scheduled checklist.

The evidence supports several causes of failure. A useful task-guard rule existed but was absent from one seat's recorded memory delivery. Another seat received that rule, supplied both guards, encountered a task revision change around launch, refreshed the task and succeeded. A decision-guard rule was delivered with an incomplete guard list. Numeric lesson bounds are enforced by a refinement that does not expose those bounds in the generated TypeScript tool description. Some retries reused an operation key after changing arguments. These require different remedies.

No worked case establishes the complete chain needed to conclude that an agent received, understood and then ignored a specific rule. Recurrence establishes an investigation lead. It does not establish that conclusion.

All 8,173 distinct rule texts in the 8,392-record learned-rule snapshot have now been read in full. The initial 291-text reading was a sample and was insufficient for the requested coverage. Exact-copy matching maps those 291 texts to 295 records; the additional pass covered the remaining 7,882 texts across 8,097 records. All 4,431 distinct supporting reasons were also read. Historical text changes and changed reasons remain separate in provenance. Complete primary native-memory lesson sections and additional restored/archive lesson blocks have been reviewed and reconciled. The unread substantive-lesson remainder in the identified supported stores is zero. This does not establish complete historical tool-call visibility or authorize any archive.

## Sources, snapshots and safe access

The checkout, local tracking ref and remote main agreed at `0f5995e7e591d0864df4ff601b37d552e615e8f9`. The serving release observation identified `13372c34`; its prompt source differs from this checkout. Source mandate version is 65 and the observed serving seat reports 64. The scope-first change is merged as `cacd095f74a032d422117e69d051be545bc7d123`, dated by the forge at 2026-11-08 11:03:03 UTC. It must remain in the implementation base.

The private snapshot completion times on 2026-11-09 are 09:14:08 UTC for learned rules, 09:15:37 for the expanded orchestrator inventory, 09:17:56 for the transcript manifest, 09:19:42 for import/curation records and 09:20:08 for the native memory index. These are separate observations, rather than one cross-database transaction. Each transcript has a recorded size and modification time; the stream stops at that size. Case records retain exact byte offsets, raw records and SHA-256 digests. The later decision-guard rewrite and its old version are preserved in F15's supplement, without changing the frozen learned-store or screening denominators. Source paths in the contract table are relative to `src/lib/`.

Canonical source entry points: [role defaults](../../src/lib/roles/defaults.ts), [mandate](../../src/lib/orchestrator/prompt.ts), [scheduled curator brief](../../src/lib/memory/curation/brief.ts), [curation validation](../../src/lib/memory/curation/apply.ts), [tool metadata](../../src/lib/mcp/server.ts), [PR publication](../../src/lib/pipelines/stagePullRequest.ts), [merge gate](../../src/lib/forge/autoMerge.ts).

Read current contracts before accessing data:

| Surface | Contract checked | Use and limit |
| --- | --- | --- |
| Earlier answers | `search_transcripts`, `search_memory`, `conversation_messages` | Several project and cross-project phrasings; checked interpreted query units; opened primary conversations and a memory hit. Message search excludes tool bodies and is insufficient for the failure audit. |
| Learned rules | `memory/roleStore.ts`, `roleTypes.ts`, `roleScopes.ts` | `role_memory` contains rule, scope and closing-request records. Rule versions and dispositions survive archiving. Scope aliases require recorded proof. |
| Scheduled curation | `memory/curation/read.ts`, `guard.ts`, `apply.ts`, `store.ts`, `brief.ts` | Reads are pass-scoped and paged. Apply requires the actual scheduled owner. This research did not impersonate that owner or call apply. |
| Actual memory delivery | `memory/deliveryLedger.ts`, `roleLaunch.ts`, `eligibility.ts` | Ordered IDs and content hashes identify delivered rule versions. The ledger retains 10,000 starts and bounded content storage. A current rule listing cannot substitute for it. |
| Conversation authority | `orchestrator/seats.ts`, retained registry conversations and launch receipts | Combined server-attributed orchestrator roles with recorded seat lineage. Kept missing transcripts as gaps. |
| Tool contracts | Serving and current `mcp/server.ts`, `tasks/commands.ts`, `tasks/steps.ts`, contemporary deferred-tool records | Distinguished public metadata, hidden refinements and backend guards. Never replayed a recorded operation. |
| Prompt delivery | `roles/defaults.ts`, `store.ts`, `registry.ts`, `orchestrator/prompt.ts`, `seatCommand.ts`, `handoffDigest.ts` | Checked defaults, overrides, stage/spawn composition, rotation, custom text, versioning and byte admission. |

Direct retained-store reads used SQLite URI `mode=ro` with `query_only=ON`, without importing application stores, initializing collections or running migrations. Sealed backup reads also used `immutable=1`. These observations establish read-only database access; they do not claim filesystem immutability of SQLite's normal shared-memory coordination. Private extraction and analysis outputs are outside the checkout. Historical operations were never executed.

The earlier role-memory-to-prompts design was read as history, including its deferred toolkit scope, promotion flow, engine-memory work and cap proposals. Its old corpus counts and its suggestion to archive after merge are superseded for this task by current counts and the required deployed-prompt proof. A recent scheduled pass that retrieved 474 active rules and 80 budget archives completed only 26 of 28 scope paginations. That pass is a lead and is not evidence of an all-project complete inventory.

## Coverage accounting

### Learned rules and related stores

| Retained surface | Enumerated | Qualification |
| --- | ---: | --- |
| Rule records | 8,392 | 1,039 active; 955 merged; 6,398 archived. |
| Historical text versions | 4,755 | Included in archived records. Each changed text was read; versions remain linked rather than counted as independent learned-rule lineages or incidents. |
| Non-version rule rows | 3,637 | Retained lineage heads, including merged and archived heads; 3,593 distinct head texts. These are not an independent incident count. |
| Distinct rule texts / rule-reason pairs | 8,173 / 8,251 | All texts and reasons read. There are 219 additional exact-body copies and 141 additional exact-pair copies. Seventy-three texts have differing reasons, producing 151 pairs; those differences were separately opened. |
| Distinct supporting reasons | 4,431 | Full provenance-context review, with every reason mapped back to its records. Reasons are not startup instructions or additional lessons. |
| Scope records | 164 | 150 project-bound and 14 shared scopes. All active index entries reconcile to the 1,039 active rule rows; no orphan active rule was found. |
| Closing requests | 5,437 | Retained provenance/application reports; self-reported application is not a behavioral proof. |
| Curation records | 1,787 | 934 passes, 846 conversation links, eight project records and one machine record. |
| Import records | 1,523 | 761 candidate records, 761 lookups, one import. Candidates contain 793 occurrences; 598 drop and 119 adopt dispositions; 44 candidates have no disposition. |
| Native memory index | 7,873 entries / 1,417 files | Entire index exported. Includes 362 preferences, 299 project facts, 6,877 references, 333 skills and two instruction records. Index dates span 2026-04-10 to 2026-11-07. Complete primary lesson bodies were opened beyond the index's 2,048-byte body cap. |
| Primary native lesson blocks | 1,420 | Complete topic/instruction bodies and complete preference, failure, learning and reusable-knowledge sections; all read. Routing, artifact/status records and installed skill content are accounted separately. |
| Restored and supplementary archive lesson blocks | 1,497 | All read: 101 matched an earlier completed read; 1,396 were opened in the additional pass. These are text blocks, with substantial overlap with primary lessons, rather than independent incidents or additive rule counts. |
| Engine-memory import archive | 1,561 files | All 5,918,541 bytes digest-checked. 1,064 exact primary-file copies; 381 Git metadata files; one auxiliary file; 115 unmatched Markdown occurrences with 104 distinct file contents. Their lesson-bearing content is reconciled to the completed primary/additional reads. |
| Recent sealed state backups | Three | Learned-rule counts 8,383 / 8,386 / 8,392; no rule ID absent from the main snapshot. An older pre-lesson backup contains zero learned rules. |
| Delivery ledger | 10,000 starts | Retained window observed from 2026-10-20 to 2026-11-09. Earlier delivery cannot be inferred from absence here. |

Learned-rule creation spans 2026-10-10 through this snapshot; retained changes reach 2026-11-09. There is no arbitrary recent-day cutoff. Non-active reasons reconcile to 4,755 rewritten, 975 duplicate, 724 task-specific, 522 budget, 163 in-instructions, 54 stale, 53 contradicted, 53 problem, 36 no-reader, 17 in-code and one deleted. Reasons and text versions describe record history; they are not recurrence counts.

Active role records are: orchestrator 312, builder 283, architect 143, production auditor 32, visual critic 22, deployer 22, merger 19, cleaner three and maintainer two. The remaining 201 active records are project or machine rules. There are no active role-specific records for reviewer, verifier, curator or issue reporter. Their deliberate automatic-memory exclusion remains intact.

The union of retained learned scopes, catalog projects and recorded orchestrator projects has 31 project-key buckets below. Only recorded aliases were resolved. Eighteen buckets contain rule records. Legacy path-derived keys with no alias proof remain separate; the private map retains their exact identities. A zero means no corresponding record in this inventory, rather than proof that a project never had memory.

| Bucket | Active | Merged | Archived | Scope rows | Observed orchestrator envelopes |
| --- | ---: | ---: | ---: | ---: | ---: |
| P01 | 0 | 0 | 3 | 3 | 0 |
| P02 | 2 | 0 | 0 | 1 | 0 |
| P03 | 0 | 0 | 0 | 1 | 0 |
| P04 | 0 | 0 | 0 | 1 | 0 |
| P05 | 14 | 2 | 2 | 4 | 0 |
| P06 | 0 | 0 | 1 | 1 | 0 |
| P07 | 3 | 0 | 0 | 1 | 0 |
| P08 | 2 | 0 | 0 | 2 | 0 |
| P09 | 0 | 0 | 0 | 1 | 0 |
| P10 | 8 | 0 | 0 | 3 | 0 |
| P11 | 0 | 0 | 0 | 1 | 0 |
| P12 | 0 | 0 | 0 | 0 | 0 |
| P13 | 0 | 0 | 0 | 1 | 0 |
| P14 | 0 | 0 | 0 | 0 | 0 |
| P15 | 1 | 0 | 0 | 1 | 0 |
| P16 | 0 | 0 | 0 | 0 | 0 |
| P17 | 0 | 0 | 0 | 0 | 0 |
| P18 | 0 | 0 | 0 | 0 | 0 |
| P19 | 0 | 0 | 0 | 1 | 0 |
| P20 | 5 | 0 | 1 | 14 | 276 |
| P21 | 0 | 0 | 0 | 14 | 0 |
| P22 | 175 | 136 | 808 | 14 | 12,996 |
| P23 | 1 | 0 | 0 | 1 | 485 |
| P24 | 135 | 101 | 536 | 14 | 6,170 |
| P25 | 179 | 112 | 586 | 14 | 9,236 |
| P26 | 16 | 4 | 24 | 14 | 776 |
| P27 | 4 | 0 | 0 | 14 | 75 |
| P28 | 1 | 0 | 0 | 1 | 0 |
| P29 | 212 | 423 | 2,969 | 14 | 25,866 |
| P30 | 19 | 3 | 5 | 14 | 606 |
| P31 | 0 | 0 | 0 | 0 | 0 |
| Shared scopes | 262 | 174 | 1,463 | 14 | — |

The catalog itself contains 18,289 files in 17 project-key buckets, including an unresolved bucket. The native index contains 138 nonempty project strings, including historical path variants. Its complete per-string accounting is private; these strings were not silently equated with the 31 buckets. Native-body selection included historical argument-tolerance guidance and its conflicts with today's required fields. Neither the native index nor the archive proves what a particular engine actually received.

The supplementary comparison covers 862 physical source occurrences across current native memory, restored desktop memory and unmatched import files. It maps exact paragraphs and formatting-equivalent lines to a read representative, retaining source offsets, digests, historical wording, scope and exceptions. Formatting comparison removes only list prefixes, spacing and task-reference suffixes; it never rewrites the stored source and provides no archive or deployment-equivalence proof. A final check of 18 rollout files whose complete file bytes differed from indexed primary sources found their lesson sections already covered; the sole extra line was an outcome label, which was opened. All 761 import candidates have a digest-matched source in these reviewed originals. No unresolved source-access failure remains in the lesson corpus.

Installed skills, navigation indexes, reference links, task execution narratives and status/artifact facts are inventory categories. They are not counted as learned behavioral rules. The completeness claim covers lesson-bearing content in the identified supported stores, with the existing native parser's section boundaries made explicit; it does not claim that every byte of every historical artifact is a separate lesson. The private queues preserve excluded routing/context blocks for review.

### Orchestrator history and counting units

The role/seat inventory contains 393 conversations and 459 referenced transcript paths: 403 exist and 56 are missing. The available paths were streamed in bounded records, covering 2,843,657,740 bytes and 540,824 JSONL records. Observed tool activity spans 2026-09-08 05:53:43 through 2026-11-09 09:17:49 UTC. Role metadata and retained paths provide the boundary; unregistered older orchestrators are an explicit coverage gap.

Duplicate copies are folded using engine, call identity and argument content, retaining occurrence pointers. Matching a result uses its call identity, including when several calls share one transcript record. The final units are:

| Unit | Count | Meaning |
| --- | ---: | --- |
| Unique submitted tool envelopes | 56,486 | 42,603 direct calls; 13,883 execution wrappers containing tool expressions. |
| Statically identified invocation sites | 88,251 | Includes wrapper expressions. Loops, branches, computed calls and unresolved expressions prevent treating this as an exact runtime-call denominator. |
| Paired envelopes | 55,561 | 925 unique envelopes have no paired retained result. |
| Parsed returned outcomes | 64,349 | Multiple outcomes can belong to one wrapper. Some wrappers print only selected fields. |
| Error-bearing returned outcomes | 5,682 | Validation, authority, transport, unknown execution and other errors together; not 5,682 independent mistakes. |
| Paired envelopes without a normalized outcome | 3,719 | Kept as unknown, including filtered output and failed orchestration scripts. |

Of the error observations, 4,548 can be associated with an observed conversation/tool/request-key tuple: 4,006 distinct tuples and 542 additional responses under those same tuples. The other 1,134 lack an unambiguous key association. A changed key does not prove a new incident. Successful corrections are controls within the original episode.

An exclusive diagnostic grouping yields 754 size-or-required-text-bound observations, 340 guard/revision observations, 116 other field/enum/role-parameter observations, 27 line-format observations, 79 key conflicts, 253 identifier/tool/receipt lookups, 1,087 unknown outcomes and 3,026 other transport/authority/refusal observations. The precedence and regex rules are retained privately. These are screening counts, rather than adjudicated causes or failure rates.

There are 1,237 static `leave_lesson` invocation sites. At 1,208 sites a rule body is a recoverable literal: one is below 20 normalized code points and 227 exceed 300. At 1,206 of those sites the reason is also literal: 199 exceed 160; 89 contain non-ASCII text. These include correction attempts and are compared with today's bounds. Contemporary contracts and actual execution must be checked before assigning an historical defect. The audit also identifies 10,810 `update_task`, 6,212 `pipeline_action`, 1,945 `spawn_agent` and 692 `message_receipt` sites.

## Worked failures and successful controls

The original private casebook has 14 case groups and 65 original call/result envelopes. F15 is a separately retained supplementary window after the frozen scan; it does not silently increase the original screening counts. The evidence preserves original arguments, refusals, adjacent corrections, source pointers, prompt evidence and delivery evidence. The table below exposes only structural facts and generic diagnostics. Dynamic expressions in execution wrappers remain expressions unless their value is independently recoverable; an unevaluated expression is never relabeled as an exact wire value.

| Case | Contemporary contract, arguments and refusal | Correction / outcome | Advice and delivery assessment |
| --- | --- | --- | --- |
| F01, 09 Nov | `leave_lesson`: normalized reason is 185 code points; hard maximum 160. The actual schema error names `lesson.why` and Unicode code points. | Same rule, 131-point reason, new request key. The retained rule records the corrected lesson. One size episode, one corrective attempt. | The serving refinement enforces the bound, while the tool's generated text has no numeric reason limit. No delivered reason-limit lesson was established. Missing exposed advice is supported; ignoring a delivered numeric rule is unproved. |
| F02, 09 Nov | Three task updates supply `expectedRevision` and omit `expectedProject`. Each answers `TASK_INVALID_FIELD` for `expectedProject`. The backend requires the pair whenever either is supplied. | All three are resubmitted with the pair and new keys; all three answer success. These are three target operations sharing one preparation error, with three successful controls. | A guard lesson existed. It is absent from this seat's recorded 83-rule delivery, including its hashed versions. Other task-size guidance was delivered. The public schema describes the guards mainly through placement; this also weakens preparation. |
| F03, 09 Nov | One task amendment first receives two stale-revision refusals. After a fresh read it reaches `appendLine must be one line`: the value is a multiline amendment. | Another fresh read, bounded full `details` replacement preserving existing details, new key; accepted. The original launch evidence and review budget remain recorded. One amendment episode with multiple refused attempts. | The one-line contract is explicit in tool/source descriptions. No matching delivered single-line lesson or evidence of prior understanding was established. The causes of the two earlier revision moves were not individually proved. |
| F04, 09 Nov | A task update uses both guards from a pre-launch task observation. Launch membership changes the record; the update returns `TASK_REVISION_MISMATCH`. | Fresh full task read preserves the new assignment; a revised guarded update succeeds. Later guarded progress updates also succeed. | The delivery ledger proves receipt of the task-refresh rule. Both guards were used. The observed sequence supports a legitimate optimistic-concurrency race and successful recovery. It supplies a control for F02. |
| F05, 31 Oct | `skip-stage` carries `expectedRevision`; the tool refuses because that guard belongs to other actions. Retrying changed arguments under the same key returns `idempotency_conflict`. | A new key with the corrected arguments succeeds. One skip operation, two error responses, one success. | The contemporary action description is retained. A precise guard lesson was created after this event; later versions survive. General uncertainty guidance existed, but did not clearly teach the changed-arguments-after-refusal case. No proved deliberate disregard. |
| F06, 02 Nov | `search_transcripts` receives `order:"recent"`; the refusal names the accepted `relevance` and `newest` values. | Later searches use `newest` and succeed, with different queries. These are successful format controls, not proof that the original search was completed. | The pre-call metadata was not recovered for this case. A recorded memory delivery exists, but no specific enum rule or acknowledgement tying it to the erroneous call was established. |
| F07, 05 Nov | A lesson supplies `role:null`; `role` is optional but accepts only named roles when present. The actual schema error names `lesson.role`. | A new call omits `role`, narrows scope to the acting role and succeeds. One episode. | An omitted optional field and a null field are distinct. The retained schema supports the refusal. The correction also improves audience selection; it is not merely string shortening. |
| F08, 02 Nov | A rewrite uses a one-character rule and reason, then a longer reason above its maximum and a rule identifier whose full value has no earlier occurrence in the inspected prefix. Refusals successively expose minimum length, maximum length and rule readability. | After a connection reset, identical arguments and key are retried, which is the safe uncertainty control. A later new lesson is accepted. The original rewrite was never proved successful. | This is one attempted lesson/rewrite chain, not several independent incidents. Stored revisions and the readable rule have different full identifiers. There is no delivery-and-understanding proof for an exact-ID lesson at that time. |
| F09, 07 Nov | `get_task` receives field `id`; schema requires `taskId`. The refusal names the missing field. | The next call uses `taskId`. Its retained output is filtered, so this table records corrected submission rather than inventing an acceptance receipt. | Wrong parameter name is proved; an ignored remembered instruction is not. |
| F10, 22 Oct | `appendLine` is invoked as a tool with an empty object. The engine returns `No such tool available`. It is a field on supported mutation tools. | No same-operation successful correction was established in the selected window. Other successful task writes are controls for the real tool. | This is a wrong tool choice. Discovery and exact tool/field naming are the prompt remedy. |
| F11, 03 Nov | Standalone reviewer launch supplies size but omits required `roleParams.diffSource`; the tool refuses before dispatch. | Subsequent calls provide `diffSource` and producer linkage; later transport outcomes remain uncertain. Corrected arguments alone do not prove a reviewer started. | Required role parameters are available through the role registry and contemporary refusal. A precise reviewer-launch lesson exists later; retrospective presence cannot prove prior delivery. |
| F12, 08 Sep | A spawn receives `outcome_unknown`; the response explicitly requires original-key lookup because execution remains possible. | The next observed spawn lookup keeps its key and identical arguments and returns uncertainty again. No duplicate start is inferred. | Successful adherence to receipt instructions is visible. Retained learned-rule delivery begins later, so attribution to a particular lesson is unavailable. This is unresolved execution evidence, not an argument mistake. |
| F13, 15 Oct | Appending to the monitor note would produce 16,188 characters against a 16,000 limit. The refusal states that nothing was stored. | Shorter appended prose under a new key succeeds. One overflow episode, one success. | A 188-unit excess is small proportionally. Silent removal of an instruction would still be unsafe. Historical memory-delivery proof is outside the retained ledger window. |
| F14, 06 Nov | `message_receipt` is queried using a launch operation identity. It answers `OPERATION_UNKNOWN`: no accepted send under that identity. | The seat continues verifying the launched conversation via activity/transcript reads. No accepted-send receipt is established by this query. | The receipt reader is for accepted sends. A later lesson distinguishes launch, stop and send receipts. Its later existence cannot establish delivery here. |
| F15, 09 Nov, supplementary window | `resolve-decision` supplies `expectedRevision` and omits `expectedStageId` and `expectedAttempt`. The exact refusal requires the stage, positive attempt and revision from `get_pipeline`. | A fresh stage read confirms the revision and attempt. A new key with all three guards succeeds and changes the pipeline from `needs_decision` to `running`. Native RPC records retain actual arguments and results; the answer is identical across the two requests. One decision operation, one refusal and one successful correction. | The startup delivery includes a historical rule naming the revision requirement and omitting the other two required guards. The seat rewrites that rule after the refusal. Recorded argument and result times establish incomplete delivered advice; recurrence does not establish ignored memory. Current source explicitly describes the complete triple. Pre-call metadata delivery for this specific tool remains unproved. |

For F01–F04, launch receipts provide the actual seat prompt and the delivery ledger provides IDs and hashes. The two seat launch prompts contain general retry guidance and no explicit `expectedProject` or Unicode-limit wording. F02's seat received a selector fallback; F04's seat received a narrower selection. The report uses what the ledger actually lists, rather than speculating about the selector's intent. Scope histories and preserved text versions provide lesson chronology. `why` is not injected at startup.

For the older cases, deferred-tool attachments are stronger evidence than current source. Where those attachments or the initial prompt are incomplete, the private map marks the gap. A launch receipt, an available schema and a saved rule are separate evidence types. None alone establishes model understanding. The private native-memory index also contains earlier advice favoring guessed defaults for missing role fields; today's validators require several of those fields. This is a stale/conflicting-advice candidate, with historical delivery unproved.

Attribution remains bounded: F01 has no established delivered numeric advice and incomplete exposed metadata; F02 has an existing rule absent from its recorded startup delivery; F15 has incomplete delivered advice; the native historical defaults are stale/conflicting candidates with delivery unknown; F04 supports a legitimate state race. The inspected validation refusals agree with their server contracts. No worked chain proves a validator/backend defect or a delivered, understood rule being ignored. Backend/composition proposals below address observed contract or visibility limits, with behavioral acceptance still owed. F04 and F12 are successful controls for guard refresh and original-key uncertainty recovery.

## What is universal and what remains local

| Candidate | General invariant | Existing coverage | Decision and canonical home |
| --- | --- | --- | --- |
| U01 | Prepare a tool request from its actual contract, target identity, field formats, units and applicable guards. | Shared rules 2 and 6 are broad; role registry and tool descriptions contain only parts of the preparation. | Sharpen shared rule 2, in full and short forms. Put Delegatus-specific examples in the default orchestrator mandate. |
| U02 | Separate a proved refusal from unknown execution; keep the original identity and payload during uncertainty. | Shared rule 15 covers uncertain effects, but leaves changed-payload/new-request behavior implicit. | Replace rule 15 in both forms. Include authoritative receipt type and post-recovery state checks. |
| U03 | Evidence states its scope, source, units and unverified remainder. | Shared rules 6, 12 and 14 and judging blocks already say this. | Retain existing coverage. Concrete query plans, benchmark procedures, browser recipes and environment constraints stay local. |
| U04 | A learned duplicate becomes removable only after equivalent guidance is proved effective for the same deployed audience. | Curator checklist checks current instructions; neither merge nor a returned scaffold proves deployment and audience coverage. | Add the deployed-equivalence policy to the curator scaffold and scheduled checklist. Preserve reversible provenance and supported-tool limits. |
| U05 | Requirement and authorization boundaries persist through handoff and recovery. | Shared rules 1, 8, 11–13; role fences; scope-first mandate. | Preserve. Do not universalize an installation's provider, account, routing, spending, scheduling or release choices. |

The private rule map covers all 8,392 IDs, their source/time/version lineage, read representative, reason/pair representative, promotion decision, coverage qualification and proposed location. All rows are substantively read. The minimal plan derives prompt invariants from 25 non-version rows, keeps 12 other reviewed heads as concrete advice under already-covered principles, retains 3,600 heads in their existing scope, and preserves 4,755 historical version rows. These are research selection decisions; none certifies per-rule deployed equivalence or permits an archive. Native and additional blocks have a separate source/decision map. The public plan contains neutral new wording and no learned-rule IDs or private rule text.

Keep-list examples include stack-specific date handling, a native runtime workaround, browser binary setup, exact project deployment topology, customer-topic routing, provider selection, typography conventions for a particular manuscript and a project's approval procedure. A generally useful part can inform U01–U05 while these conditions remain local. Repetition across tasks does not remove those conditions.

Risk/disagreement examples:

- Supplying every possible guard is unsafe: `skip-stage` and `retry-stage` do not accept the same guards as a decision or graph edit.
- A rule recommending a new key after a refusal must retain its no-effect proof. Generalizing it to timeouts can duplicate an effect.
- A rule recommending original-key retries must retain identical arguments. Reusing that key after editing the payload causes a conflict.
- A short summary may preserve task status while losing a deadline, exception or provenance. Preserve those facts or use a supported larger field.
- A rule about a dead host may depend on whether a stop or dispatch is proved. Collapse those conditions and the resulting recovery advice can become contradictory.
- A reviewer finding is evidence about a failure, rather than authorization to change another project's instructions or memory.

The completed native/archive pass also finds time-dependent monitor limits, older stage-report shapes, incomplete decision guards, conflicting reset/retry defaults, and changing deployment, audience and provider policies. Keep their dates and conditions. A later complete instruction elsewhere in native memory does not repair the incomplete text actually delivered in F15. No new universal rule is justified by the many local engineering recipes in those sources.

## Concrete prompt edits for implementation

These are proposed texts. Their behavioral effect is unmeasured. Preserve all existing authorization, clean-role, review-budget, custom-prompt and scope-first policies.

### Shared full and short rules

Sharpen full rule 2 after its project-instructions duty:

> Before sending an unfamiliar request, consult the tool's current contract. Check the operation, target reference, required and optional fields, accepted values, text units and applicable concurrency guards. Copy references from an authoritative read. Give prose room below a stated maximum; retain required context and exact safety fields. A recommendation is distinct from an enforced bound.

Use this short addition to short rule 2:

> Check unfamiliar tool arguments against the current contract: target, required fields, values, units and action-specific guards. Preserve exact references and leave room for prose below hard bounds.

Replace full rule 15 with:

> A failed reply can conceal a completed effect. Establish the operation's state through its own authoritative record before another attempt. While execution is uncertain, retain the original key and unchanged payload and use the supported recovery read. A confirmed rejection permits a corrected new request only as its contract allows. Refresh state before constructing that request, and verify the resulting effect at its destination. Preserve uncertainty when the record cannot settle it.

Use this short replacement for rule 15:

> Resolve an uncertain effect through its own receipt using the original key and payload. After a proved rejection, refresh state and make a corrected request as the contract permits. Verify the destination; unresolved execution stays unknown.

These sharpen two existing principles. Keep their numbering and the correspondence between full and short forms. The full rules reach all ordinary role scaffolds, clean roles included. Mandated seats read the short form; non-mandated orchestrators receive the existing full-rule composition. No automatic-memory exclusion changes.

### Default orchestrator parameter preparation

Add a compact paragraph near `Before you decide`, after the earlier-answer duty. Proposed wording:

> Prepare tool arguments before dispatch: obtain the current target and contract, then check required fields, allowed values, text size and the guard for that action. A validation refusal ends the current preparation batch: inspect every result, refresh the relevant record and correct the next request. Keep a transport or unknown-outcome failure on its original recovery path. Never guess a reference suffix or treat a field name as a tool.

Add the following verified worksheet, using compact prose in the mandate rather than duplicating an entire schema:

> For `update_task`, take `expectedProject` and `expectedRevision` together from the current task when using guards; reread after a launch or assignment. `appendLine` accepts one line. A larger edit needs a supported field and a fresh read preserving its existing content. For `resolve-decision`, obtain `expectedStageId`, positive `expectedAttempt` and `expectedRevision` from a fresh stage read; check other pipeline actions separately. For a standalone role launch, read that role's required parameters. Query the receipt family that owns the operation.

Add the bounds most likely to be absent from generated descriptions:

> Lesson rule: 20–300 normalized Unicode code points; reason: 1–160, with at least 16 letters or digits. Aim for at most 240 and 120 respectively. These are recommended drafting targets; the hard maxima remain 300 and 160. Keep task notes within 280 normalized UTF-16 units and step text within 120 trimmed UTF-16 units; aim lower. Preserve step IDs and unresolved holds.

The worksheet is scoped to Delegatus. It must not enter tool-independent shared rules. Required role parameters and action guard lists remain authoritative at call time; the paragraph grants no new mutation permission.

### Curator scaffold and scheduled checklist

Add this policy to the curator scaffold and replace the scheduled checklist's instruction-coverage sentence with the same condition:

> When a shipped prompt appears to subsume a learned rule, establish the effective deployed text for every affected reader, including overrides and custom mandates. A proposed change or merged source does not establish delivery. Compare the complete trigger, audience, action, conditions and exceptions. Retain local additions and unresolved differences. If equivalence and a supported reversible disposition are both proved, retire only the redundant active injection, recording the deployed evidence and preserved lineage. Keep the canonical prompt. Otherwise retain the rule and report what proof or supported operation is missing. Never invent a reference or another archive reason to bypass that limit.

Keep the scheduled owner's existing authority, partition accounting, operator-kept protection and undo behavior. The general curator role does not obtain an apply capability from this instruction. A research invocation remains read-only.

### All-role impact

| Role | Intended delta |
| --- | --- |
| Orchestrator with mandate | Short shared rules plus the default-only parameter paragraph; future launch/rotation through the existing version mechanism. |
| Orchestrator without mandate | Full shared-rule changes through the existing spawn/stage composition. |
| Builder | Shared preparation/recovery changes; engineering and focused-check duties retained. |
| Architect | Shared changes; no new production or editing authority. |
| Cleaner | Shared changes; backups and approved destructive-step boundaries retained. |
| Production auditor | Shared changes; production read-only fence retained. |
| Deployer | Shared changes; existing approval and release-procedure duties retained. |
| Merger | Shared changes; exact reviewed head and human-review gates retained. |
| Maintainer | Shared changes; narrow task-write authority retained. Reconcile with the open maintainer-prompt hunk before implementation. |
| Reviewer | Shared changes only; remains automatically memory-free and read-only. |
| Verifier | Shared changes only; keeps its claim-label contract and memory exclusion. |
| Issue reporter | Shared changes only; preview-only publication boundary retained. |
| Curator | Shared changes plus deployed equivalence policy; remains automatically memory-free. |
| Visual critic | Shared changes only; no expansion into code review or product mutation. |

## Length units, headroom and graceful handling

| Input | Actual enforcing behavior checked | Honest recommendation |
| --- | --- | --- |
| Lesson/rewrite rule | 20–300 code points after trimming and whitespace collapse; additional recognizability and generality checks | Draft within 240 points, retaining a complete actionable rule. |
| Lesson/rewrite reason | Up to 160 normalized code points; nonempty and recognizability checks | Draft within 120 points. Never remove provenance to pass. |
| Task note | Whitespace collapsed and trimmed, then JavaScript `.length` at most 280 | Target about 220 UTF-16 units; preserve state, cause and unblock condition. |
| Task step | Up to 20 items; ASCII identifier pattern of 1–40; trimmed text at most 120 UTF-16 units | Target about 90 text units. Keep stable identifiers and holds. |
| Task details | Trimmed text at most 20,000 UTF-16 units; resulting line edits use the same cap | Check the resulting whole field, including existing content. |
| Monitor note | Writer checks both raw and trimmed/redacted text against 16,000 UTF-16 units | Use current whole-field length and leave room for later updates. Preserve the complete instruction. |
| Structured seat delivery | 32,000 UTF-8 bytes for the composed envelope, including role overhead | Measure the final composed delivery. Character counts alone are insufficient. |

ASCII letters use one code point, one UTF-16 unit and one UTF-8 byte. A Cyrillic letter commonly uses one point, one unit and two bytes. U+1F9ED uses one point, two units and four bytes. A base letter plus a combining accent can occupy two points while appearing as one grapheme. The inspected task and lesson paths do not use one universal definition of “character.” No worked failure here proves that supplementary Unicode caused a rejection; this is a verified contract mismatch in measurement units, with a preventative recommendation.

Existing lossless handling is useful where the field's contract declares it: lesson whitespace normalization, task-note whitespace normalization, and bounded read pagination with explicit truncation metadata. Changing arbitrary identifiers, keys, hashes, signatures or quoted evidence through Unicode normalization is unsafe. NFC/NFKC and whitespace folding are not general byte-preserving operations.

The monitor's legacy read path in `monitor/seatTickSettings.ts` slices stored values at its cap. That source observation is separate from the strict writer's explicit refusal and does not establish a historical loss incident in this sample. Prompt guidance cannot repair a previously clipped record. Any product proposal to change legacy loading must preserve recoverable original text and expose loss explicitly, with an over-limit retained-record acceptance case.

Prose between a recommended target and its real maximum should pass normally. A reason of 125 points may exceed the recommended 120 and still satisfy the real 160 bound. A 185-point reason exceeds the real bound and needs editing. Calling 120 the hard limit would misstate the contract.

A runtime margin above a real maximum would be a product change. It must change the documented hard maximum and every producer, validator, store, receipt digest, reader and transport consistently. A small excess in a harmless read limit may be clamped when its contract supports that behavior. Mutating instructions, reasons, identities, revision guards, provenance and safety conditions must not be silently truncated. An explicit refusal remains appropriate when preserving meaning cannot be proved.

Splitting is supported only where the operation actually supports it. Curator split operations can distribute distinct complete rules under the same true audience; a stage's one closing lesson does not thereby gain multiple writes. Task evidence can use retained reports and a concise supported details field. A maintainer still cannot replace a full details field if its authority allows only line edits. A long specification is not converted into one line automatically.

## Deployment-aware deduplication and residual product work

The existing archive operation is reversible: state, reason, note, evidence location and scope history survive; text versions and lineage remain. Restoring excludes operator deletions and version rows. Fully equivalent guidance may be archived later through that mechanism, while partial complements and operator-kept entries stay active.

There are two concrete limits to implementing the whole deduplication request through prompts:

1. A curation scope read returns a scaffold assembled by the serving process. It does not return an immutable deployed-composition receipt for all launches, custom mandates and role overrides. `get_orchestrator full:true` gives stronger evidence for a particular seat, but does not prove delivery to every relevant reader or another installation.
2. `in-instructions` requires an existing evidence file inside the pass's project repository. A scaffold alone is explicitly insufficient. A curator in another project cannot cite this repository's role-default file as if it belonged to that project. The shipped swarm reference is a distinct supported exception, not a general prompt reference.

Therefore the prompt-only change can require safe deferral and perform supported dispositions where all evidence exists. It cannot honestly promise automatic prompt deduplication across every project. Never evade either limit with another archive reason or a copied source file.

Separate product proposals, outside this PR:

| Proposal | Evidence | Minimum acceptance |
| --- | --- | --- |
| Expose enforced text units/bounds and conditional guards in tool descriptions | F01/F02 and the refinement versus generated-description mismatch | Every field explains normalization, units, hard bounds and conditional requirements; accepted and refused boundary behavior agrees through the real protocol and store. No guessed IDs, authority or revision defaults. |
| Supply a read-only effective-prompt artifact and an archive evidence reference | Curation read/apply limitations above; deployed/source version divergence | Artifact binds role, audience, release, composition/override digest and delivery state. Archive validation accepts only the same proved audience; stale, custom and partial coverage retain the rule; undo preserves lineage. |
| Improve small-overage handling where lossless | F01 and F13 | An explicit recommended target and true hard maximum; declared normalization; maximum and maximum-plus-one cases across non-ASCII/astral inputs; no partial mutation or altered critical field. Raising a bound needs all writers/readers checked. |
| Clarify recovery records and operation-family diagnostics | F05/F12/F14 | An unknown result never implies non-execution; a changed payload cannot reuse the key; a wrong receipt family explains the mismatch without implying absence of the real effect. |

No proposal here authorizes implementation, an issue publication, a replay of the original operation or a live experiment.

## Implementation and draft-only publication handoff

### Allowed source scope

Implement from fresh current main on a new same-task lane with its own lineage. Keep this research lane internal. The eventual product diff should contain only prompt strings in:

- `src/lib/roles/defaults.ts`: full/short rule 2 and rule 15, plus the curator scaffold policy.
- `src/lib/orchestrator/prompt.ts`: default parameter-preparation text and required prompt version metadata.
- `src/lib/memory/curation/brief.ts`: scheduled checklist policy and matching explanation of supported evidence.

The mandate must advance from v65 to the next unoccupied version. The existing `prompt.test.ts` fingerprint/version registration and staleness-boundary data must advance with it; existing fingerprint entries remain immutable. This is the prompt-delivery metadata the pinned brief asks the implementation to identify. These literal data changes are the only non-prose hunks in scope; keep them explicit in the PR description. Add no phrase tests or runtime logic. Never ship an unversioned mandate edit or disable the fingerprint check.

Do not change schemas, validators, guard logic, selection/scoring, model/account mappings, settings, memory ingestion, archive operations, UI or deployment. Do not bring this report, evidence files, private identifiers or research helper scripts into the product branch. Review all prompt string changes as behavioral instructions, rather than treating a `.ts` suffix as runtime permission.

The initial inventory contained 34 open PRs; the final read contained 35. Only the maintainer lane's PR #3762 touches these proposed files: its unchanged actual diff adds an operator-request audit paragraph to `MAINTAINER_BODY`. Preserve that paragraph; do not edit its hunk. The remote main still matches the research base. Native runtime/check investigations and publication work touch other source families and remain outside the proposed scope. Recheck current main and the actual open diffs before implementation and before publication.

### Required verification

Use existing isolated explicit-file checks for composition and delivery: `roles/registry.test.ts`, `roles/store.test.ts`, `orchestrator/prompt.test.ts` and `orchestrator/seatCommand.test.ts`. Read their final contents and applicable project guidance before running; do not add wording-presence tests. Run only the files justified by the final touched paths and the explicit implementation brief. The publication hook owns the wider repository checks.

For a mandate edit, include the existing byte-admission and rotation cases in `orchestrator/handoffDigest.test.ts`. Source evidence includes real launch prompt bodies of 31,685 and 31,642 UTF-8 bytes, before considering any separately represented launch overhead. That leaves little envelope room. Measure the actual final composition with the live registry shape and retained large handoffs, plus the largest multibyte input that cannot be dropped. New text must fit without changing the cap, truncating required content or hiding a failed admission. Shorten redundant proposed prose if necessary; retain each requirement. No budget win is claimed in this report.

Before editing, make a clause-preservation table for the full and short rules, standalone and stage scaffolds, stored defaults, bespoke mandates, rotation, child delivery and tool-selected paragraphs. For every moved clause, record its destination and all tools whose selection must still deliver it. Compare the current source, serving composition and overlapping prompt diff using the smallest actual envelope headroom. The proposed prose is a semantic specification: adding every paragraph verbatim is not a demonstrated budget-safe patch. Replace redundant wording where necessary, preserve all clauses and ordering needed by consumers, then measure the final composed payload including JSON/UTF-8 overhead. If it still cannot fit, retain the refusal and identify the residual admission/composition product change separately; do not claim a prompt-only size fix.

Review the final composed output for each of the 13 roles, non-mandated orchestrators, fresh default seats, rotations of a shipped old default and a bespoke mandate. Verify current custom/default delivery, safety fences, clean-memory exclusions and exact pending-request replay. An installed old seat remains old until the supported later delivery path; this task must not mutate it. Existing production-path tests establish composition behavior, not that a model will follow the new prose.

The independent reviewer must replay the private evidence reading procedure, sample each proposed invariant against its counterexample and check the public/private boundary. Keep the three fixed review/fix rounds of this research lane unchanged, including the controller's existing terminal behavior. Do not create helpers from a research or review stage. The product lane also requires an independently reviewed final prompt head; an exhausted unreviewed fix is insufficient for this task's personal-review handoff.

### Supported path that never opens a ready PR

The normal stage publisher is unsuitable for creating the first PR here: `stagePullRequest.ts` invokes `gh pr create` without `--draft`. Converting that PR afterward leaves a ready interval. Pipeline `autoStart:false` creates a pipeline draft and says nothing about the eventual forge PR.

A source-supported sequence uses an implementation lane with `publication:"internal"` and `finishesTask` unset throughout build and review. Internal settlement advances locally without invoking stage PR creation. After a clean independent final review, use a separate publication checkpoint in that same lane, with no source edits and a durable task hold stating personal review and no merge/deploy. The checkpoint remains governed by the reviewed head.

The owning seat may explicitly request native branch publication with `pipeline_action publish`, the exact accepted head and its existing owner claim, while no passed-stage publication is awaiting settlement. This explicit path queues a branch operation; it does not need to turn on automatic remote-branch settlement. Verify the publication receipt and remote head. Leave the lane internal. An authorized publication stage can then use the forge's existing `gh pr create --draft` with the exact branch/base and a reviewed body file. Discover an existing PR first, and recover a lost response by reading the branch's PR; do not create a second one. If the linked PR is already ready, stop for reconciliation rather than silently accepting that state.

Read back `isDraft:true`, head, base and body before declaring delivery. `forge/autoMerge.ts:decideMerge` explicitly blocks a draft. Keep the personal-review hold and the instruction against readiness conversion, merge and deploy. Do not change project-wide automatic-merge settings. Do not use `--auto`, mark ready, enqueue a merger or complete the parent task as shipped. Return the draft link for personal inspection and stop there.

This sequence is supported by the inspected internal-settlement, explicit-publication and draft-refusal code; it was not executed or rehearsed against a live forge. Before using it, the implementation/publication owner must confirm those same boundaries on the then-current source and existing isolated seams, including absence of ready-PR creation during the explicit branch operation. If that cannot be established, keep the reviewed result internal and report the precise unsupported publication step. Draft delivery remains owed on the same task.

## Private provenance package and research validation

The controller-retained private package contains the original specification, per-store snapshots, all-project key mapping, all-scope records, native and import/archive accounting, completed read queues and duplicate mappings, the complete rule-provenance map, transcript manifest, normalized call/result index, static argument extraction, contemporary schema evidence, delivered rule versions, 15 worked cases including the separately bounded supplement, raw-record digests and the analysis scripts. Learned text, identities and private source locations appear only there. The public report's case and candidate labels are independent of private rule IDs.

Research validation is limited to the report: reconcile tables and counting units, check source references and public claims, inspect the whole report for private data, run whitespace/link checks and the repository publication/privacy scanner on the declared file. Broad tests, a build, typechecking, paid evaluations and historical operation replay are outside this stage. Independent review is a subsequent controller-owned stage; this document does not represent itself as already independently approved.

## Completed coverage and retained evidence gaps

The learned-rule and reason queues are complete: zero of 8,173 unique rule texts and zero of 4,431 unique reasons remain unread. The 8,251 rule/reason pairs and all record identities remain distinct in provenance; exact rule copies with changed reasons were not discarded. Complete primary-native sections, restored memory and unmatched archive lesson content are reconciled with zero unread substantive blocks. The private progress ledger records completed ranges, file digests, read representatives and exclusions. Inventory counts alone were insufficient; these completion counts follow the bounded substantive reads.

Other retained-evidence gaps are the 56 missing transcript paths, unregistered older orchestrators, 925 unpaired envelopes, 3,719 unparsed paired envelopes, dynamic argument values and delivery outside ledger retention. These gaps forbid exhaustive-compliance, ignored-memory and bulk-deduplication claims. Missing history is preserved as missing.

## Deferred — not currently justified

Retain the earlier design's toolkit/multi-role memory scope, automated promotion workflow, curator-cap change and native-memory migration as separate work. Keep usefulness scoring, memory-source switching and trial evaluation, paid evaluation and benchmarking with their existing owners. Their outcome and budgets are unchanged.

Defer runtime grace margins, schema changes, effective-prompt artifacts and new archive reference types to separately authorized product work with the acceptance above. They are proposals only. No audit gap justifies inventing history or weakening a hard gate.
