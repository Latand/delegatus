# Learned rules and tool failures: prompt promotion research

Originating requirement, 2026-11-09: the private controller-pinned specification authorizes an audit of retained lessons across projects and time, including orchestrator tool-call failures. The requested outcome is generally applicable prompt guidance, a deployment-aware curator policy, independent review, and a prompt-only draft pull request for personal inspection. This is a sanitized restatement. The original wording and its follow-up remain in the private evidence package.

This document is an internal research handoff. It must stay out of the eventual product pull request. It changes no prompt, validator, runtime, setting or learned rule. Publication, merging, deployment and memory curation have not been performed.

## Conclusions and limits

The existing shared core already covers requirement anchoring, evidence, scope, isolation, privacy and uncertain effects. Preserve that work. Add a small argument-preparation rule, make retry guidance distinguish uncertain execution from a proved refusal, and give the orchestrator a verified parameter worksheet. Add the curator's deployment-and-audience equivalence check to both its scaffold and its scheduled checklist.

The evidence supports several causes of failure. A useful task-guard rule existed but was absent from one seat's recorded memory delivery. Another seat received that rule, supplied both guards, encountered a task revision change around launch, refreshed the task and succeeded. A decision-guard rule was delivered with an incomplete guard list. Numeric lesson bounds are enforced by a refinement that does not expose those bounds in the generated TypeScript tool description. Some retries reused an operation key after changing arguments. These require different remedies.

No worked case establishes the complete chain needed to conclude that an agent received, understood and then ignored a specific rule. Recurrence establishes an investigation lead. It does not establish that conclusion.

The earlier reading queues record completion for 8,173 distinct rule texts and 4,431 supporting reasons in the 8,392-record snapshot. The initial 291-text sample maps to 295 records; the additional queue covers 7,882 texts across 8,097 records. Text-reading completion and a semantic promotion decision are separate claims. Independent review found that most coverage fields in the original map were generic retention defaults. They supply inventory and provenance, without establishing individual prompt coverage. The corrected decision ledger covers all 1,039 active heads and all 522 heads archived for budget alone. It preserves the 262 shared-head decisions and adds 1,299 individual comparisons: 518 other active project heads, 259 project-orchestrator heads and 522 budget archives. Each comparison names the full invariant, a current source clause, the conditions left specific, a decision and a distinct reason. Other dispositions retain recorded history and sampled checks. No deployed equivalence, archive or restoration is authorized.

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

Decision forms have 655 statically identified `publish_prototype_review` invocation sites. A bounded recheck of the deduplicated result index finds 36 question-text size refusals in 33 conversations, 21 option-label-only refusals in 21 conversations, and two responses naming both the question-text and option-label bounds; one also names an invalid question id. These are 59 returned observations, with retries still inside their original episodes. Counting every named field independently gives 38 question-text and 23 option-label observations; two responses name both, so these field totals must not be added. This explains the narrower size-only screening counts. The current contract trims text and enforces 300/120 UTF-16 units (`prototypeReview/input.ts:17-18`); the public tool description at `mcp/server.ts:3953` omits these bounds. No lesson specifically teaching these form bounds was found in the frozen rule snapshot. This supports an absent-advice classification within that store; historical delivery outside it remains unknown. Original call and refusal records were reopened for both field classes.

## Worked failures and successful controls

The original private casebook has 14 case groups and 65 original call/result envelopes. F15 is a separately retained supplementary window after the frozen scan; it does not silently increase the original screening counts. This revision opens two further form episodes from the frozen index as F16/F17, with four submitted calls and their original results; their successful corrections remain controls within those episodes. The evidence preserves original arguments, refusals, adjacent corrections, source pointers, prompt evidence and delivery evidence. The table below exposes only structural facts and generic diagnostics. Dynamic expressions in execution wrappers remain expressions unless their value is independently recoverable; an unevaluated expression is never relabeled as an exact wire value.

| Case | Contemporary contract, arguments and refusal | Correction / outcome | Advice and delivery assessment |
| --- | --- | --- | --- |
| F01, 09 Nov | `leave_lesson`: normalized reason is 185 code points; hard maximum 160. The actual schema error names `lesson.why` and Unicode code points. | Same rule, 131-point reason, new request key. The retained rule records the corrected lesson. One size episode, one corrective attempt. | The serving refinement enforces the bound, while the tool's generated text has no numeric reason limit. No delivered reason-limit lesson was established. Missing exposed advice is supported; ignoring a delivered numeric rule is unproved. |
| F02, 09 Nov | Three task updates supply `expectedRevision` and omit `expectedProject`. Each answers `TASK_INVALID_FIELD` for `expectedProject`. The backend requires the pair whenever either is supplied. The original wrapper confirms revision expressions in all three calls. | All three are resubmitted with the pair and new keys; all three answer success. These are three target operations sharing one preparation error, with three successful controls. | A guard lesson existed. It is absent from this seat's recorded 83-rule delivery, including its hashed versions. Other task-size guidance was delivered. The public schema describes the guards mainly through placement; this also weakens preparation. |
| F03, 09 Nov | One task amendment first receives two stale-revision refusals. After a fresh read it reaches `appendLine must be one line`: the value is a multiline amendment. | Another fresh read, bounded full `details` replacement preserving existing details, new key; accepted. The original launch evidence and review budget remain recorded. One amendment episode with multiple refused attempts. | The one-line contract is explicit in tool/source descriptions. No matching delivered single-line lesson or evidence of prior understanding was established. The causes of the two earlier revision moves were not individually proved. |
| F04, 09 Nov | A task update uses both guards from a pre-launch task observation. Launch membership changes the record; the update returns `TASK_REVISION_MISMATCH`. | Fresh full task read preserves the new assignment; a revised guarded update succeeds. Later guarded progress updates also succeed. | The delivery ledger proves receipt of the task-refresh rule. Both guards were used. The observed sequence supports a legitimate optimistic-concurrency race and successful recovery. It supplies a control for F02. |
| F05, 31 Oct | `skip-stage` carries `expectedRevision`; the tool refuses because that guard belongs to other actions. Retrying changed arguments under the same key returns `idempotency_conflict`. | A new key with the corrected arguments succeeds. One skip operation, two error responses, one success. | The contemporary action description is retained. A precise guard lesson was created after this event; later versions survive. General uncertainty guidance existed, but did not clearly teach the changed-arguments-after-refusal case. No proved deliberate disregard. |
| F06, 02 Nov | `search_transcripts` receives `order:"recent"`; the refusal names the accepted `relevance` and `newest` values. | Later searches use `newest` and succeed, with different queries. These are successful format controls, not proof that the original search was completed. | The pre-call metadata was not recovered for this case. A recorded memory delivery exists, but no specific enum rule or acknowledgement tying it to the erroneous call was established. |
| F07, 05 Nov | A lesson supplies `role:null`; `role` is optional but accepts only named roles when present. The actual schema error names `lesson.role`. | A new call omits `role`, narrows scope to the acting role and succeeds. One episode. | An omitted optional field and a null field are distinct. The retained schema supports the refusal. The correction also improves audience selection; it is not merely string shortening. |
| F08, 02 Nov | A rewrite uses a one-character rule and reason, then a longer reason above its maximum and a rule identifier whose full value has no earlier occurrence in the inspected prefix. Refusals successively expose minimum length, maximum length and rule readability. | After a connection reset, identical arguments and key are retried, which is the safe uncertainty control. A later new lesson is accepted. The original rewrite was never proved successful. | This is one attempted lesson/rewrite chain, not several independent incidents. Stored revisions and the readable rule have different full identifiers. There is no delivery-and-understanding proof for an exact-ID lesson at that time. |
| F09, 07 Nov | `get_task` receives field `id`; schema requires `taskId`. The refusal names the missing field. | The next call uses `taskId`. Its retained output is filtered, so this table records corrected submission rather than inventing an acceptance receipt. | Wrong parameter name is proved; an ignored remembered instruction is not. |
| F10, 22 Oct | `appendLine` is invoked as a tool with an empty object. The engine returns `No such tool available`. It is a field on supported mutation tools. | No same-operation successful correction was established in the selected window. Other successful task writes are controls for the real tool. | This is a wrong tool choice. Discovery and exact tool/field naming are the prompt remedy. |
| F11, 03 Nov | Standalone reviewer launch supplies size but omits required `roleParams.diffSource`; the tool refuses before dispatch. | Subsequent calls provide `diffSource` and producer linkage; later transport outcomes remain uncertain. Corrected arguments alone do not prove a reviewer started. | Required role parameters are available through the role registry and contemporary refusal. A precise reviewer-launch lesson exists later; retrospective presence cannot prove prior delivery. |
| F12, 08 Sep | A deployer spawn omits required `confirm:"deploy"`. Its exact refusal starts `deployer requires confirm: deploy`, but the backend labels it `outcome_unknown` and requests `original-key-lookup`, saying execution remains possible. | The next wrapper defines `args` and submits `{...args,recoveryOnly:true}` under the original key; it again receives unknown. The spread remains an expression, without an independently attested evaluated wire payload. At 10:25:50 UTC the seat submits a blocked contract/terminal-receipt report; its final answer at 10:25:56 retains that gap. No duplicate start or completed deployment is inferred. | This combines a missing required field with a historical backend defect: deterministic validation was reported as uncertain execution and obstructed correction. Following the prescribed recovery path was appropriate. Current `mcp/bindings.ts:1776-1790` checks deployer confirmation before key admission and refuses with status 400. This specific defect is already corrected in source. Earlier learned-rule delivery is unavailable. |
| F13, 15 Oct | Appending to the monitor note would produce 16,188 characters against a 16,000 limit. The refusal states that nothing was stored. | Shorter appended prose under a new key succeeds. One overflow episode, one success. | A 188-unit excess is small proportionally. Silent removal of an instruction would still be unsafe. Historical memory-delivery proof is outside the retained ledger window. |
| F14, 06 Nov | `message_receipt` is queried using a launch operation identity. It answers `OPERATION_UNKNOWN`: no accepted send under that identity. | The seat continues verifying the launched conversation via activity/transcript reads. No accepted-send receipt is established by this query. | The receipt reader is for accepted sends. A later lesson distinguishes launch, stop and send receipts. Its later existence cannot establish delivery here. |
| F15, 09 Nov, supplementary window | `resolve-decision` supplies `expectedRevision` and omits `expectedStageId` and `expectedAttempt`. The exact refusal requires the stage, positive attempt and revision from `get_pipeline`. | A fresh stage read confirms the revision and attempt. A new key with all three guards succeeds and changes the pipeline from `needs_decision` to `running`. Native RPC records retain actual arguments and results; the answer is identical across the two requests. One decision operation, one refusal and one successful correction. | The startup delivery includes a historical rule naming the revision requirement and omitting the other two required guards. The seat rewrites that rule after the refusal. Recorded argument and result times establish incomplete delivered advice; recurrence does not establish ignored memory. Current source explicitly describes the complete triple. Pre-call metadata delivery for this specific tool remains unproved. |
| F16, 31 Oct | A form's first option label is 144 UTF-16 units. The exact returned schema error names `questions[0].options[0].label` and `<=120 characters`. | The next call, about five seconds later, uses a new key and a 91-unit label; the tool returns success. Question and other option wording also change, so this establishes an accepted corrected form without proving semantic equivalence of every edit. | The refusal proves the contemporary enforced bound. No form-bound lesson is present in the frozen store. Current public description omits the bound; complete pre-call metadata and delivered-memory contents for this episode are unproved. Classify absent exposed advice with historical-delivery limits, without an ignored-memory claim. |
| F17, 02 Nov | A form question is 325 UTF-16 units. The exact returned error names `questions[0].text` and `<=300 characters`. | The next call uses a new key and a 275-unit question, preserving the two option-label lengths; success is returned. Later unrelated successful forms are separate controls, with no added incidents attributed to this correction. | The contemporary refusal and corrected success establish the limit. Frozen-store advice is absent; historical numeric metadata and prompt/memory delivery remain unproved for this window. Preparation and exposed description are the supported remedies. |

For F01–F04, launch receipts provide the actual seat prompt and the delivery ledger provides IDs and hashes. The two seat launch prompts contain general retry guidance and no explicit `expectedProject` or Unicode-limit wording. F02's seat received a selector fallback; F04's seat received a narrower selection. The report uses what the ledger actually lists, rather than speculating about the selector's intent. Scope histories and preserved text versions provide lesson chronology. `why` is not injected at startup.

For the older cases, deferred-tool attachments are stronger evidence than current source. Where those attachments or the initial prompt are incomplete, the private map marks the gap. A launch receipt, an available schema and a saved rule are separate evidence types. None alone establishes model understanding. The private native-memory index also contains earlier advice favoring guessed defaults for missing role fields; today's validators require several of those fields. This is a stale/conflicting-advice candidate, with historical delivery unproved.

Attribution remains bounded: F01 has no established delivered numeric advice and incomplete exposed metadata; F02 has an existing rule absent from its recorded startup delivery; F15 has incomplete delivered advice; the native historical defaults are stale/conflicting candidates with delivery unknown; F04 supports a legitimate state race. F12 proves a historical backend misclassification, already corrected in current source. No worked chain proves a delivered, understood rule being ignored. F04 is a successful guard-refresh control. F12 demonstrates adherence to the requested recovery path while its outcome stays unresolved; it supplies no successful launch control. F05's successful corrected call and F15's guarded correction are further controls within their original episodes.

## What is universal and what remains local

| Candidate | General invariant | Existing coverage | Decision and canonical home |
| --- | --- | --- | --- |
| U01 | Prepare a tool request from its actual contract, target identity, field formats, units and applicable guards. | Shared rules 2 and 6 are broad; role registry and tool descriptions contain only parts of the preparation. | Sharpen shared rule 2, in full and short forms. Put Delegatus-specific examples in the default orchestrator mandate. |
| U02 | Separate a proved refusal from unknown execution; keep the original identity and payload during uncertainty. | Shared rule 15 covers uncertain effects, but leaves changed-payload/new-request behavior implicit. | Replace rule 15 in both forms. Include authoritative receipt type and post-recovery state checks. |
| U03 | Evidence states its scope, source, units and unverified remainder. | Shared rules 6, 12 and 14 and judging blocks already say this. | Retain existing coverage. Concrete query plans, benchmark procedures, browser recipes and environment constraints stay local. |
| U04 | A learned duplicate becomes removable only after equivalent guidance is proved effective for the same deployed audience. | Curator checklist checks current instructions; neither merge nor a returned scaffold proves deployment and audience coverage. | Add the deployed-equivalence policy to the curator scaffold and scheduled checklist. Preserve reversible provenance and supported-tool limits. |
| U05 | Requirement and authorization boundaries persist through handoff and recovery. | Shared rules 1, 8, 11–13; role fences; scope-first mandate. | Preserve. Do not universalize an installation's provider, account, routing, spending, scheduling or release choices. |

The original private map preserves all 8,392 IDs and their source, time, versions, text/reason and read representatives. Its earlier selection and generic retention fields are inventory evidence. The final private decision ledger supersedes those fields for all 1,039 active heads and 522 budget archives: 1,561 records and 1,559 distinct bodies. Two exact-body copies retain separate reasons and provenance; body identity grants no deployed-equivalence or archive authority.

The previous supplement's 259 project-orchestrator entries were classified by editorial family, with five generic reasons and four source references. Calling those individual source comparisons overstated the evidence. The corrected ledger opens their complete texts and gives each a separate source comparison and reason. The earlier family counts (nine contract-preparation, 32 recovery, 46 evidence, 75 authority/scope and 97 narrower procedures/preferences) remain a classification of that set, separate from incident counts and the final per-rule decisions.

The other 518 active heads comprise 226 builder, 145 project-wide, 86 architect, 20 deployer, 18 production-auditor, 16 merger and seven visual-critic rules. They span 13 stored scope-project keys and 14 source-project keys, different dimensions without guessed aliases. The 522 budget archives comprise 458 builder, 61 orchestrator and three machine heads. Budget eviction supplies no judgment that a rule was wrong. These were compared as promotion candidates while retaining their archived state.

The comparisons preserve concrete procedures beyond general prompts: ORM author stamps and default resolution, cross-process receipt custody, late identity changes, native platform behavior, complete locale/render matrices, minimum database versions, billing provenance and dataset blinding. Repetition supports a general principle without proving that the principle replaces those conditions. Project deployer heads also support D01; project production-auditor heads support PA01. The role rollup below includes project heads and budget archives.

For the other 6,831 non-active records, retain stored dispositions and immutable version links. A bounded check opens 19 bodies/reasons across all ten other disposition reasons (two per reason, one for the sole deletion): rewritten UI notices, duplicate publication practices, old deploy admission, instructions-backed access and problem-tagged diagnostics among them. This supplements the completed reading queues without certifying every historical curator decision. An archive reason or version is not a fresh incident or automatic promotion.

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

Replace full rule 2 and short rule 2 with:

> 2. Read project instructions first. Run their or CI's checks; if none, name yours and why. Check unfamiliar tools' operation, target, fields, values, units and guards. Copy IDs; leave headroom; check replies before dependent calls; stop on refusal.

Replace full rule 15 and short rule 15 with:

> 15. Error, timeout or status proves nothing: read affected state before retry. Uncertain: retry with the same key and arguments, or its recovery read. Proved no-effect refusal: refresh, correct with a new key. Never change a key's arguments. Delivery needs destination proof; unresolved stays unknown.

For full rule 13 only, shorten its opening from “Read later answers first; change only named decisions; never re-ask settled questions.” to “Read later answers first; change only named decisions; never re-ask.” Keep the following correction instruction unchanged. The short form already has that opening.

F01's wrapper continued after a refusal; future scripts must inspect each result before dependent dispatch. Already-dispatched independent calls still require reconciliation. “Fields” includes requiredness and permitted omission; formats, units and action guards come from the current contract. Headroom is a recommended drafting margin below the true bound.

| Obligation | Clause and check |
| --- | --- |
| Read project instructions before changing or judging; project/CI checks govern | Rule 2 starts with that prerequisite and reports selected checks and reasons when none are named. Its former parenthetical file examples are removed. |
| Verify operation, target, fields, values, units and guards; copy identifiers | Rule 2, remaining sentences. Preserve authority fields while shortening prose. |
| Inspect before dependent dispatch and stop on refusal | Rule 2, final clause; reconcile independent calls already sent. |
| Error replies, timeouts and statuses establish no effects | Rule 15, first sentence. |
| Read affected state before retrying | Rule 15, first sentence. |
| Explicit same-key retry with unchanged arguments during uncertainty | Rule 15, uncertain clause. A timed-out update_task can replay its identical call/key; no separate recovery endpoint is invented. |
| Operation-owned recovery read when available | The alternative in the uncertain clause; message_receipt and spawn recovery retain their own contracts. |
| Corrected arguments use a new key only after a proved no-effect refusal | Rule 15, refusal clause. A timeout alone supplies no such proof. |
| Never change a used key's arguments | Rule 15, separate prohibition. |
| Delivery requires destination proof; unresolved stays unknown | Closing clauses; accepted or queued status alone is insufficient. |
| Later answers change only named decisions; settled questions are not re-asked | Full rule 13's shorter opening and unchanged correction marker. |

Keep all 16 rule numbers. Full rules shrink by four UTF-16 units, including the rule-13 reduction. Reviewer bodies, fences and caps remain unchanged.

### Correction marker and saved audiences

**Keep OPERATOR_CORRECTION_RULE byte-identical.** It is the includes() marker in `orchestrator/prompt.ts:794-802`, `pipelines/prompts.ts:96`, `roles/registry.ts:133` and `pipelines/roles.ts:77-78`. Appended bounds would cause a second insertion into old text. Put numeric bounds in the proposed leave_lesson description below; keep closing lesson requests unchanged.

Fresh default scaffolds and non-mandated orchestrators receive full rules. New default seats and rotations selecting the current default receive short rules. Retained pipeline scaffolds, stored overrides and bespoke mandates keep their saved rules 2/15; the stable marker supplies no retrofit or duplicate. Existing exact-string upgrades and pending-intent replay stay unchanged. Retrofitting saved audiences would require separately scoped delivery work. Under option A, tool descriptions add guidance when those callers select the tool; option B retains that exposure gap.

A pure isolated probe sends the saved v65 core through the candidate production upgrader: 26,848 bytes before and after, one correction marker, zero growth, identical bytes on a second upgrade. A serialized base reviewer scaffold remains exactly 11,590 UTF-16 units through the candidate renderer, with one marker and zero growth. This establishes marker idempotence only.

### Default mandate and scaffold budgets

Keep the detailed parameter worksheet at tool-selection descriptions below. Add no separate worksheet or lesson-bound paragraph to the mandate. Shared rule 2 directs readers to the actual contract. Option B explicitly retains missing-description exposure.

Use these three prose reductions, preserving scope-first `How work runs`, personality, operator approvals and release gates:

- Opening: “You own this project's board and work as Delegatus orchestrator. Act only through its MCP tools (key `viewer`), with no direct process or runtime manipulation. Working rules govern you and every agent; this mandate adds seat duties.”
- Earlier-answer paragraph: “For non-trivial work or a problem, failure or unknown, run 3-5 varied search_transcripts queries (error, subsystem, symptom, file or tool), project then unscoped. Open hits with conversation_messages at their paths; read surrounding turns first. Cite title and date in plans or specs, or report no relevant result.”
- Its three following bullets become: “- A spec makes an unobserved external fact step 1 and stops to ask if it cannot be observed. Check the operator-visible production result after deploy before closing the task. Send each status with the next available action.”

These keep authority, every search trigger and count, project-first/unscoped queries, primary-record opening, surrounding turns, citations or negative results, external facts as the first spec step, production verification and next-action status.

Measurements use tracked scratch exports of `0f5995e7` with the literal candidate above, PA01/D01/MH01 and the curator policy below. HOME, XDG_CONFIG_HOME, LLV_STATE_DIR and TMPDIR were private. Production renderers and pure composition functions were invoked; no test suite, build, typecheck, launch or model call ran. Exact strings, source digests, runner and results remain private.

| Fixed seat change | Before bytes | After bytes | Delta UTF-8 bytes |
| --- | ---: | ---: | ---: |
| Opening | 342 | 232 | -110 |
| Short rule 2 | 127 | 248 | +121 |
| Short rule 15 | 135 | 301 | +166 |
| Correction marker | 225 | 225 | 0 |
| Earlier-answer paragraph | 581 | 314 | -267 |
| Three bullets | 323 | 224 | -99 |
| Net | — | — | -189 |

Production composition and the literal delta table both measure a net reduction of **189 bytes**. The previous +314-byte candidate is withdrawn: its 101-byte rotation reserve admitted an envelope while failing the required history-reserve invariant.

| Delivery case | Base bytes, with overhead | Candidate bytes | Remaining from 32,000 |
| --- | ---: | ---: | ---: |
| Fresh default spawn | 30,517 | 30,328 | 1,672 |
| Existing-seat default delivery | 30,224 | 30,035 | 1,965 |
| Rotation, immediate readable predecessor | 31,585 | 31,396 | 604 |
| Rotation, older readable predecessor | 31,576 | 31,387 | 613 |
| Rotation, no readable predecessor | 31,329 | 31,140 | 860 |

The rotation fixture uses a synthetic 94-byte project key, 49-byte conversation IDs, all three exact `seatCommand.ts:1700-1712` headers, its `:1477` read call and non-droppable board pointer. Its deliver callback uses production-loaded role definitions; bare defaults reduce this fixture by 23 bytes and are not the recorded rotation case.

The existing `handoffDigest.test.ts:440-473` reserve expression reproduces as 3,750 > 3,670 on base and **3,939 > 3,670** on the candidate. Its historical correction allowance is unchanged. No additional history spending or cap increase is proposed.

With no optional caller notes, maximum retained ASCII history bodies in those fixtures are 393/402/649 bytes on base and 582/591/838 on the candidate (immediate/older/no-readable predecessor). Using that production composition with the `proj-a` key and 49-byte IDs of `seatCommand.test.ts:1964-1979`, the immediate-predecessor history threshold is 481 bytes on base and 670 on the candidate. Thus one byte fits and 900/2,000 drop, matching that file's existing cases. The full seat-command test remains mandatory at implementation; this was a pure composition probe, without launching its stateful workflow. These bounded fixtures guarantee no universal identifier or custom-registry maximum.

| Shipped role | Minimum stage reserve on base, UTF-16 units | Candidate |
| --- | ---: | ---: |
| Architect | 1,397 | 1,401 |
| Builder, including fix/frontend | 674 | 678 |
| Cleaner | 5,469 | 5,473 |
| Curator | 5,059 | 4,240 |
| Deployer | 3,928 | 3,762 |
| Issue reporter | 2,442 | 2,446 |
| Merger | 680 | 684 |
| Orchestrator stage | 5,460 | 5,464 |
| Production auditor | 4,505 | 4,110 |
| Reviewer | 205 | 209 |
| Verifier | 4,306 | 4,310 |
| Visual critic | 2,541 | 2,545 |

These are all 120 non-maintainer default/variant combinations in `pipelines/roles.test.ts:249-262`, including the role-specific additions below. Every result retains rule 16 and more than 200 units. Maintainer is not a pipeline role and is excluded by that test; review its standalone body with the overlapping audit hunk intact. Another 36 text-parameter probes at 40/250/499/2,000 units either retain all rules or return the existing parameter-overflow refusal; four refuse on both base and candidate. These production-function probes do not claim complete test-file success. Keep MAX_SCAFFOLD_LENGTH at 12,000 for old-release compatibility.

### Curator scaffold and scheduled checklist

Add the following policy to the curator scaffold and beside the scheduled checklist's existing instruction-file path. Preserve checklist item 2, its `2. Current. ` insertion anchor and its project-file `in-instructions` route. The swarm insertion remains unchanged.

> For a shipped-prompt duplicate, first establish the effective deployed guidance for the affected audience. Use the serving process's curation scope scaffold, current role_presets overrides, and get_orchestrator full:true for the seat's actual mandate; retain the release and composition evidence. Proposed or merged source alone is insufficient. Compare the complete trigger, audience, action, conditions and exceptions, including custom mandates and overrides. Keep local additions and uncertain or conflicting coverage. When equivalence and supported repository evidence are proved, reversibly archive only redundant active injection, preserving lineage and the deployment evidence. Otherwise retain it and name the missing proof or supported evidence route. Project instruction files keep their existing evidence path.

For genuinely shared prompt guidance, use an authorized Delegatus curation pass when the existing evidence validator permits it. Compare the serving scaffold with its matching `src/lib/roles/defaults.ts:<line>` in that checkout; for a seat also compare the effective mandate. Other-project passes must not cite this file as their own repository evidence. This is an addition to ordinary project-file dispositions, with no invented prompt URI or alternate archive reason.

The validator derives the evidence project from `scopeProject(original.scope) ?? original.source.project`, also considering recovery scope (`memory/curation/apply.ts:230-239`). A shared scope itself resolves to null (`memory/roleScopes.ts:22`), so a foreign source project can still block a Delegatus-pass file citation. In this frozen set, 137 of 262 shared heads originate in the Delegatus project; the other 125 have other or historical source keys. No head has source project `*`. A literal `*`, when present, bypasses only that project mismatch check; it never bypasses the existing-file or equivalence requirement. Therefore a Delegatus pass is an available route for eligible shared heads, not blanket permission for every shared rule. Keep unsupported foreign-source and custom-audience cases active and report the residual evidence-reference limitation separately.

This research performs no curation. After later approved deployment, supported passes must verify actual deployed equivalence before an `in-instructions` archive. Operator-kept rules, versions, partial complements and unproved audiences retain their existing protection.

### Role-specific comparison and recommendations

The final decision ledger covers every active head and every budget archive below. Shared and project counts are records at different audiences, not additive independent incidents. All references describe current source; deployed equivalence remains unproved. Narrow project procedures and preferences retain their scope and recorded state.

| Role / scope | Active shared | Active project | Budget archives | Coverage and decision |
| --- | ---: | ---: | ---: | --- |
| Machine | 56 | 0 | 3 | `roles/defaults.ts:47-61` supplies check, evidence, ownership and isolation duties. Keep operating-system, tool-version, account and author-specific detail local. |
| Architect | 57 | 86 | 0 | Scaffold at `:309`, shared paths at `:120`, server rules at `:128`, rendered rules at `:115`. Existing requirements cover the principles; retain specific research, SQL, prototype and measurement methods. No additional role text selected. |
| Builder | 57 | 226 | 458 | Scaffold at `:297`, tests at `:118`, shared paths at `:120`, records at `:126`, rendering at `:115`. Keep detailed race, serializer, platform and UI fixtures; no claim that broad principles replace those conditions. |
| Cleaner | 3 | 0 | 0 | Scaffold/fences at `:319-321` require approved recovery and backups. Keep disk targets, squash-merge classification and nested removal sequence scoped. |
| Deployer | 2 | 20 | 0 | Scaffold at `:348` requires health and procedure, but lacks explicit fresh-process log-window coverage. Propose D01 below; keep fixed file-permission recipes local. |
| Maintainer | 2 | 0 | 0 | Body at `:170-196` covers external waits and board truth. Propose MH01 below for preserving an explicit newer hold; keep `hold:null` readback as tool-specific guidance. Preserve the overlapping maintainer audit hunk. |
| Merger | 3 | 16 | 0 | Scaffold at `:361` already covers reviewed heads, launch actor, project procedure and attribution. Keep predecessor closure, forge author and stage-commit mechanics scoped. |
| Orchestrator | 53 | 259 | 61 | Short rules and mandate at `orchestrator/prompt.ts:592`, shared rules at `roles/defaults.ts:47,60`. U01/U02 cover preparation and recovery. Action guards, graph limits, field persistence and custody conditions remain concrete advice; incomplete historical decision advice is not treated as current truth. |
| Production auditor | 14 | 18 | 0 | Scaffold at `:331` forbids writes, but omits handler effects and remote diagnostic artifacts. Promote PA01 below. Keep SQL, clock, heap and frame-analysis techniques scoped. |
| Visual critic | 15 | 7 | 0 | Body at `:221`, rendering at `:115` and evidence at `:51` cover rendered correctness. Retain font, bidi, harness, viewport and document-specific techniques. |
| Reviewer | 0 | 0 | 0 | Shared preparation/recovery changes only. Keep read-only authority, judging contract and automatic-memory exclusion. |
| Verifier | 0 | 0 | 0 | Shared changes only. Keep claim labels and automatic-memory exclusion. |
| Issue reporter | 0 | 0 | 0 | Shared changes only. Keep preview-only publication boundary and automatic-memory exclusion. |
| Curator | 0 | 0 | 0 | Shared changes plus deployed-equivalence addition. Keep scheduled-pass authority and automatic-memory exclusion. |
| Project-wide | 0 | 145 | 0 | Shared rules cover evidence, authority, privacy and isolation. Retain manuscript terminology, client-topic routing, model choices, application-specific UI rules and operating procedures. |

Proposed PA01, added only to the production-auditor scaffold:

> Before a production read, inspect its handler and command for writes, refreshes or persistence. Use stored state or a static served artifact when a nominal read mutates. Run remote diagnostics inline and retain output locally in the owned evidence root; create no remote helper files, temporary files or redirected output. Verify database reads use read-only mode and report any unintended effect.

Proposed D01, added to the deployer health-verification duty:

> Health evidence includes startup logs of the new version, including worker processes if any, through the health check. Label older versions' shutdown errors separately.

Proposed MH01, added alongside the maintainer's hold handling:

> Clear a recorded wait only after evidence shows its stated prerequisite has been met. A pending pull request supplies no such evidence by itself; retain later authorized blockers and flag conflicting maintenance policy.

These fill concrete role gaps instead of copying the shared additions into every body. They add no production access, release permission, board-write authority or live mutation. They do not enlarge the seat's generated configuration table; role scaffold text is not a table column. Their measured scaffold reserves appear above. Implementation must rerun the named complete composition files on its final literals.

## Length units, headroom and graceful handling

| Input / observed evidence | Actual enforcing behavior | Recommendation and field-specific grace decision |
| --- | --- | --- |
| Lesson/rewrite rule; F08 minimum, 152 rule and 62 rewrite-rule size screens | 20–300 code points after trimming and whitespace collapse; both rule and reason need at least 16 letters/digits | Target 240. Keep explicit refusal beyond the hard bounds: trimming a preventive condition can reverse its meaning. Existing declared whitespace normalization is allowed. |
| Lesson/rewrite reason; F01, 93 reason-size screens | 1–160 normalized code points, also at least 16 letters/digits | Target 120. Refuse overage; the author can summarize while preserving the event and provenance. Never silently shorten causal evidence. |
| Task note; 58 error-bearing returned outcomes across 53 envelopes | Collapsed whitespace, then JavaScript `.length` at most 280 | Target about 220 UTF-16 units. Refuse a longer authoritative note because cause/unblock conditions may be lost. A separate display preview may be visibly clipped only if complete source is retained. |
| Task step text | At most 20 steps; identifier pattern 1–40 ASCII units; trimmed text at most 120 UTF-16 units | Target about 90 text units. Refuse excessive authoritative text or IDs; keep step identity and unresolved holds exact. No generic split into additional mutations. |
| Task details and appendLine; F03 | Trimmed whole field at most 20,000 UTF-16 units; appendLine is one line | Check resulting whole content. Refuse an oversized or multiline line-edit request. Use a supported details replacement only with authority, a fresh read and preservation of existing content. |
| Monitor note; F13, 56 size screens | Both raw and trimmed/redacted writer text checked against 16,000 UTF-16 units | Target below the real cap with space for later updates. Refuse overage: this field directs future work and must retain all obligations. |
| Form question; F17 and screening above | Trimmed 1–300 UTF-16 units | Recommend 240. Refuse excess; clipping can hide the choice's condition or approval scope. A bounded summary must remain answerable on its own. |
| Form option label; F16 and screening above | Trimmed 1–120 UTF-16 units | Recommend 90. Refuse excess; options are decision semantics. A display-only preview would need the complete label accessible and unchanged choice identity. |
| Complete bridge report | `bridge/types.ts:64`, `bridge/reportComplete.ts:4`: summary, headings and items joined with newlines, at most 8,192 UTF-8 bytes | Recommend at most 6,000 bytes, respecting existing item limits. Refuse an oversized complete report; use supported whole-item summaries/splitting without losing an owed decision. Distinguish a clipped display from the retained complete report. |
| Structured seat delivery | 32,000 UTF-8 bytes, including role overhead | Measure final composition and non-droppable rotation parts. No grace above the cap; preserve the existing explicit refusal. |
| Hold note, current permissive precedent | `tasks/hold.ts:4,20` collapses whitespace then silently `.slice(0,200)` in UTF-16 | Keep within 200 today. A future marked display clamp is acceptable only with complete authoritative text retained and a warning; otherwise refuse. A hold can carry an essential prerequisite. |
| Hold reference, current unsafe precedent | `tasks/hold.ts:4,15` silently `.slice(0,500)` in UTF-16; only applicable hold kinds retain ref | No margin or silent clipping for a reference. Preserve it exactly or refuse. A marker can signal a non-authoritative preview only when the complete reference remains available; never dispatch from that preview. |

ASCII letters use one code point, one UTF-16 unit and one UTF-8 byte. A Cyrillic letter commonly uses one point, one unit and two bytes. U+1F9ED uses one point, two units and four bytes. A base letter plus a combining accent can occupy two points while appearing as one grapheme. The inspected task and lesson paths do not use one universal definition of “character.” No worked failure here proves that supplementary Unicode caused a rejection; this is a verified contract mismatch in measurement units, with a preventative recommendation.

Field screening counts here count matched returned outcomes in the frozen normalized index, after excluding marked duplicate envelopes. Multiple matched outcomes in a wrapper and repeated attempts remain observations of the same possible episode. The task-note recheck gives 58 outcomes in 53 envelopes. These field screens are additional views of the existing global denominator, not additions to it.

Existing lesson/task-note normalization trims and collapses whitespace. Use it only when that whitespace is semantically insignificant; its presence in a validator does not prove losslessness for quoted code or evidence. Bounded pagination can preserve access to the source while exposing a clipped view with explicit metadata. Keep authoritative text recoverable. Changing arbitrary identifiers, keys, hashes, signatures or quoted evidence through Unicode normalization is unsafe. NFC/NFKC and whitespace folding are not general byte-preserving operations.

The hold reader is an existing permissive precedent, rather than evidence that every field may be clamped. Its `.slice` can also split a surrogate pair: 499 ASCII units followed by an astral character exceeds a 500-unit reference and leaves an unmatched surrogate after slicing. This is a source-demonstrable risk; no historical damaged-reference incident was established here. A prompt can teach limits and readback but cannot make that reader lossless. Residual product acceptance: preserve the full reference or refuse before persistence; display-only clipping must carry a marker and warning while retaining an exact recoverable reference; exercise maximum, maximum-plus-one, astral boundaries and saved/read-back routing. Never quietly repair IDs with Unicode normalization.

The monitor's legacy read path in `monitor/seatTickSettings.ts` slices stored values at its cap. That source observation is separate from the strict writer's explicit refusal and does not establish a historical loss incident in this sample. Prompt guidance cannot repair a previously clipped record. Any product proposal to change legacy loading must preserve recoverable original text and expose loss explicitly, with an over-limit retained-record acceptance case.

Prose between a recommended target and its real maximum should pass normally. A reason of 125 points may exceed the recommended 120 and still satisfy the real 160 bound. A 185-point reason exceeds the real bound and needs editing. Calling 120 the hard limit would misstate the contract.

A runtime margin above a real maximum would be a product change. It must change the documented hard maximum and every producer, validator, store, receipt digest, reader and transport consistently. A small excess in a harmless read limit may be clamped when its contract supports that behavior. Mutating instructions, reasons, identities, revision guards, provenance and safety conditions must not be silently truncated. An explicit refusal remains appropriate when preserving meaning cannot be proved.

Splitting is supported only where the operation actually supports it. Curator split operations can distribute distinct complete rules under the same true audience; a stage's one closing lesson does not thereby gain multiple writes. Task evidence can use retained reports and a concise supported details field. A maintainer still cannot replace a full details field if its authority allows only line edits. A long specification is not converted into one line automatically.

## Deployment-aware deduplication and residual product work

The existing archive operation is reversible: state, reason, note, evidence location and scope history survive; text versions and lineage remain. Restoring excludes operator deletions and version rows. Fully equivalent guidance may be archived later through that mechanism, while partial complements and operator-kept entries stay active.

There are two concrete limits to implementing the whole deduplication request through prompts:

1. A curation scope read returns a scaffold assembled by the serving process. It does not return an immutable deployed-composition receipt for all launches, custom mandates and role overrides. `get_orchestrator full:true` gives stronger evidence for a particular seat, but does not prove delivery to every relevant reader or another installation.
2. `in-instructions` requires an existing evidence file inside the pass's project repository, with the derived rule-project checks described above. A scaffold alone is insufficient. An eligible shared rule can use matching source in a Delegatus pass; a foreign-source or custom-audience case may still be unsupported. The shipped swarm reference remains a distinct exception.

Therefore the prompt-only change can require safe deferral and perform supported dispositions where all evidence exists. It cannot honestly promise automatic prompt deduplication across every project. Never evade either limit with another archive reason or a copied source file.

### Tool-description text: implementation choice for personal review

Descriptions are instructions delivered at tool selection time and reach roles without spending the seat mandate's fixed bytes. They deserve an explicit scope choice. **Recommend A:** include only descriptive string changes in the later prompt-only PR, if the operator accepts that file scope. **B:** keep those strings as proposals and deliver only shared/role/mandate/checklist text. This research changes neither. Schema shape, requiredness, enums, refinements, bounds and validators remain outside either prompt-only option. If the description strings are not approved, report their absence as a residual limitation; do not claim that a seat worksheet reaches every caller.

Minimal proposed text, subject to the actual current contract:

| Description location | Text-only addition or correction |
| --- | --- |
| `mcp/server.ts`, `leave_lesson` description | “Rule: 20–300 normalized Unicode code points; why: 1–160; each needs at least 16 letters or digits. Recommended targets are 240/120; hard maxima remain 300/160. Omit an optional role when unused; null is not an accepted role.” |
| `update_task` guard descriptions at `:4360` | “Supply expectedProject and expectedRevision together whenever either is present, for hide/restoreHold, and for guarded pos/placement updates. Copy both from the current task; refresh after a mismatch or assignment change.” The current placement-only descriptions contradict `tasks/commands.ts:599-605`. |
| `publish_prototype_review` description at `:3953` | “Trimmed question text is 1–300 UTF-16 units; each option label is 1–120. Recommended drafting targets are 240 and 90. Preserve complete decision scope and option identity.” |
| `pipeline_action` preparation/recovery description | “Read the current action contract. resolve-decision needs expectedStageId, positive expectedAttempt and expectedRevision from get_pipeline. retry-stage and override-stage have different guards. Changed arguments use a new key only after proved no-effect refusal. During uncertain execution, retry with the same key and arguments, or use the operation's own recovery read where available.” |
| `bridge_report` complete-report description | “The complete summary, headings and items joined by newlines must fit 8,192 UTF-8 bytes. Display clipping does not permit losing complete report items or an owed decision.” |

For A, edit only tool-description prose and `.describe(...)` string literals, with no change to the schema expression or behavior. Preserve existing instructions and discovery consumers; recheck actual diffs of the five open `mcp/server.ts` PRs #3749, #3731, #3728, #3710 and #3585 before allocating these hunks. If a description requires changed validation to become true, that portion stays a product proposal. For B, the role/prompt improvements remain useful, with the known exposure gaps explicitly retained.

Separate behavior/schema proposals, outside the prompt-only PR under either choice:

| Proposal | Evidence | Minimum acceptance |
| --- | --- | --- |
| Align machine-readable schema metadata and conditional validation, where text alone cannot expose it | F01/F02/F16/F17; generated-description refinements and guard mismatch | If separately authorized, boundary behavior must agree through real protocol and store; preserve explicit conditional requirements and give no guessed identity/authority defaults. Text-only descriptions can precede this work. |
| Supply an effective-prompt artifact or supported archive evidence reference for otherwise unsupported audiences | Foreign-source/custom-audience limits above; deployed/source version divergence | Bind role, audience, release, override/composition digest and effective delivery. Admit only proved matching audiences; stale, partial and custom differences retain the rule; undo preserves lineage. Existing eligible repository-file routes continue working. |
| Improve small-overage handling where lossless | F01 and F13 | An explicit recommended target and true hard maximum; declared normalization; maximum and maximum-plus-one cases across non-ASCII/astral inputs; no partial mutation or altered critical field. Raising a bound needs all writers/readers checked. |
| Correct unsafe hold clipping | Existing `hold.note` / `hold.ref` slicing | Keep exact authoritative references or refuse; never split a surrogate. A display-only marked clamp needs retained full text and a warning. Verify persistence/readback and hold-kind retention. No historical damaged-reference incident is claimed. |
| Clarify recovery classification, retryability and operation-family diagnostics | F05/F14/F15; F12's historical deterministic-refusal-as-unknown defect is already fixed | Unknown never implies non-execution; changed payloads never reuse keys. Missing required confirmation must refuse before key admission. Deterministic invalid arguments or wrong receipt IDs must not suggest an unchanged automatic retry merely through `retryable:true`. Verify original-key recovery, no dispatch on validation, corrected-new-key success and wrong-family diagnostics without denying the real effect. |

No proposal here authorizes implementation, an issue publication, a replay of the original operation or a live experiment.

## Implementation and draft-only publication handoff

### Allowed source scope

Implement from fresh current main on a new same-task lane with its own lineage. Keep this research lane internal. The eventual product diff should contain only prompt strings in:

- `src/lib/roles/defaults.ts`: full/short rules 2 and 15, the full rule-13 opening only, curator policy, PA01 production-auditor condition, D01 log verification and MH01 external-hold preservation. Keep OPERATOR_CORRECTION_RULE unchanged.
- `src/lib/orchestrator/prompt.ts`: the three measured prose reductions and required prompt-version metadata; shared short rules arrive through the existing interpolation. Add no worksheet/bounds paragraph; preserve scope-first/custom-default boundaries.
- `src/lib/memory/curation/brief.ts`: add deployed-prompt policy alongside the existing project-file route; preserve checklist item 2 and the swarm insertion anchor.

Conditional scope A also permits only the descriptive string hunks listed above in `src/lib/mcp/server.ts`, after the operator's scope choice. Scope B keeps that file untouched. No unresolved choice grants permission to edit behavior or delay the already authorized report corrections.

The mandate must advance from v65 to the next unoccupied version. The existing `prompt.test.ts` fingerprint/version registration and staleness-boundary data must advance with it; existing fingerprint entries remain immutable. This is the prompt-delivery metadata the pinned brief asks the implementation to identify. These literal data changes are the only non-prose hunks in scope; keep them explicit in the PR description. Add no phrase tests or runtime logic. Never ship an unversioned mandate edit or disable the fingerprint check.

Do not change schemas, validators, guard logic, selection/scoring, model/account mappings, settings, memory ingestion, archive operations, UI or deployment. Do not bring this report, evidence files, private identifiers or research helper scripts into the product branch. Review all prompt string changes as behavioral instructions, rather than treating a `.ts` suffix as runtime permission.

The initial inventory contained 34 open PRs; this revision's read still contains 35. Among the original three prompt files only the maintainer PR #3762 overlaps: its actual diff adds an operator-request audit paragraph to `MAINTAINER_BODY`. Preserve it and place MH01 without rewriting that hunk. The five server-description overlaps are listed under scope A; their actual hunks must be reviewed before implementation. Remote main remains `0f5995e7`. Native runtime/check investigations remain outside scope. Recheck current main and open diffs before implementation and publication.

### Required verification

Use existing isolated explicit-file checks for composition and delivery: `roles/registry.test.ts`, `roles/store.test.ts`, **`pipelines/roles.test.ts`**, `orchestrator/prompt.test.ts` and `orchestrator/seatCommand.test.ts`. Read their final contents and applicable project guidance before running; do not add wording-presence tests. Run only the files justified by the final touched paths and the explicit implementation brief. The publication hook owns the wider repository checks.

For a mandate edit, include the existing byte-admission and rotation cases in `orchestrator/handoffDigest.test.ts`. Use the measured fixed-headroom table above, including the 604-byte smallest fixed reserve and measured retained history in the bounded rotation fixtures. The source comparison demonstrates a candidate satisfying the existing reserve expression, without guaranteeing arbitrary custom prompts or registry growth. Measure the actual final composition with the then-current registry and retained large handoffs, plus multibyte inputs that cannot be dropped. Fit without raising the cap, losing required content or hiding failed admission.

Extend this report's clause-preservation table across standalone/stage scaffolds, stored defaults, bespoke mandates, rotation, child delivery and any approved tool-description strings. Trace every producer, copy, default, consumer and delivery transform before editing. The byte probe supplies the exact candidate strings; longer additions require new measurement. Apply the gate's real metric, UTF-8 bytes of decoded composed text plus launch overhead, rather than double-counting transport JSON escaping. If the final composition cannot fit, retain refusal and identify the residual admission/composition work separately.

Review the final composed output for each of the 13 roles, non-mandated orchestrators, fresh default seats, rotations of a shipped old default and a bespoke mandate. Verify current custom/default delivery, safety fences, clean-memory exclusions and exact pending-request replay. An installed old seat remains old until the supported later delivery path; this task must not mutate it. Existing production-path tests establish composition behavior, not that a model will follow the new prose.

The independent reviewer must replay the private evidence reading procedure, sample each proposed invariant against its counterexample and check the public/private boundary. Keep the three fixed review/fix rounds of this research lane unchanged, including the controller's existing terminal behavior. Do not create helpers from a research or review stage. The product lane also requires an independently reviewed final prompt head; an exhausted unreviewed fix is insufficient for this task's personal-review handoff.

### Supported path that never opens a ready PR

The normal stage publisher is unsuitable for creating the first PR here: `stagePullRequest.ts` invokes `gh pr create` without `--draft`. Converting that PR afterward leaves a ready interval. Pipeline `autoStart:false` creates a pipeline draft and says nothing about the eventual forge PR.

A source-supported sequence uses an implementation lane with `publication:"internal"` and `finishesTask` unset throughout build and review. Internal settlement advances locally without invoking stage PR creation. After a clean independent final review, use a separate publication checkpoint in that same lane, with no source edits and a durable task hold stating personal review and no merge/deploy. The checkpoint remains governed by the reviewed head.

The owning seat may explicitly request native branch publication with `pipeline_action publish`, the exact accepted head and its existing owner claim, while no passed-stage publication is awaiting settlement. This explicit path queues a branch operation; it does not need to turn on automatic remote-branch settlement. Verify the publication receipt and remote head. Leave the lane internal. An authorized publication stage can then use the forge's existing `gh pr create --draft` with the exact branch/base and a reviewed body file. Discover an existing PR first, and recover a lost response by reading the branch's PR; do not create a second one. If the linked PR is already ready, stop for reconciliation rather than silently accepting that state.

Read back `isDraft:true`, head, base and body before declaring delivery. `forge/autoMerge.ts:decideMerge` explicitly blocks a draft. Keep the personal-review hold and the instruction against readiness conversion, merge and deploy. Do not change project-wide automatic-merge settings. Do not use `--auto`, mark ready, enqueue a merger or complete the parent task as shipped. Return the draft link for personal inspection and stop there.

This sequence is supported by the inspected internal-settlement, explicit-publication and draft-refusal code; it was not executed or rehearsed against a live forge. Before using it, the implementation/publication owner must confirm those same boundaries on the then-current source and existing isolated seams, including absence of ready-PR creation during the explicit branch operation. If that cannot be established, keep the reviewed result internal and report the precise unsupported publication step. Draft delivery remains owed on the same task.

## Private provenance package and research validation

The controller-retained private package contains the original specification, per-store snapshots, all-project key mapping, all-scope records, native and import/archive accounting, reading queues and duplicate mappings, the original inventory/provenance map, the superseded 521-head supplement and the final 1,561-record decision ledger, transcript manifest, normalized call/result index, static arguments, contemporary schemas, delivered rule versions, the original 15 worked cases and two additional form episodes, original-record digests and analysis scripts. This revision retains 1,299 individually written new comparisons, complete source texts and hashes, exact candidate strings, per-role/variant reserves, base/candidate production-function results, mixed-form original-record digests and 19 disposition spot checks. No evidence artifact or analysis helper belongs in the product PR. The public case and candidate labels are independent of private rule IDs.

Research validation covers report claims and the isolated pure composition measurement: reconcile tables/counting units, open original records in bounded reads, verify source references, inspect the complete report for private data, and run whitespace/link checks plus the repository publication/privacy scanner on this file. No test suite, build, typecheck, paid evaluation or historical operation replay was run. The handed independent review supplied these corrections; the corrected report still needs the controller's next independent review. Source inspection and size admission establish no measured change in model behavior.

## Completed coverage and retained evidence gaps

The original queues record zero unread entries among 8,173 unique texts and 4,431 reasons, with 8,251 rule/reason pairs, versions and exact copies preserved. Native/archive accounting likewise records completed lesson sections. Those ledgers record reading completion; they do not replace substantive per-rule prompt comparisons. The final ledger records source comparisons and distinct reasons for every one of the 1,039 active heads and all 522 budget archives, with no generic retention placeholder in either set. Historical versions and other archive reasons retain their dispositions with the sampled checks above; native/import bodies retain their separately completed reading and provenance. Individual source comparison establishes no deployed equivalence. No bulk deduplication follows from these counts.

Other retained-evidence gaps are the 56 missing transcript paths, unregistered older orchestrators, 925 unpaired envelopes, 3,719 unparsed paired envelopes, dynamic argument values and delivery outside ledger retention. These gaps forbid exhaustive-compliance, ignored-memory and bulk-deduplication claims. Missing history is preserved as missing.

## Deferred — not currently justified

Retain the earlier design's toolkit/multi-role memory scope, automated promotion workflow, curator-cap change and native-memory migration as separate work. Keep usefulness scoring, memory-source switching and trial evaluation, paid evaluation and benchmarking with their existing owners. Their outcome and budgets are unchanged.

Defer runtime grace margins, schema changes, effective-prompt artifacts and new archive reference types to separately authorized product work with the acceptance above. They are proposals only. No audit gap justifies inventing history or weakening a hard gate.
